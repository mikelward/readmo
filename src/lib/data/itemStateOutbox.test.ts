// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ItemStateOutbox,
  type OutboxPersistence,
  type SendResult,
} from './itemStateOutbox';
import type { ItemStateField } from '../types';

type StampedChange = { value: boolean; at: number };
type StampedFields = Partial<Record<ItemStateField, StampedChange>>;

function memPersistence(): OutboxPersistence & { rows: () => unknown } {
  let saved: Array<{ id: string; changed: StampedFields }> = [];
  return {
    load: () => saved.map((e) => ({ ...e })),
    save: (entries) => {
      saved = entries.map((e) => ({ ...e })) as typeof saved;
    },
    rows: () => saved,
  };
}

interface Harness {
  outbox: ItemStateOutbox;
  sent: Array<[string, StampedFields]>;
  rejected: string[][];
  drained: () => number;
  setOnline: (v: boolean) => void;
  setResult: (r: SendResult) => void;
  persistence: ReturnType<typeof memPersistence>;
}

function makeHarness(persistence = memPersistence()): Harness {
  const sent: Array<[string, StampedFields]> = [];
  const rejected: string[][] = [];
  let drained = 0;
  let online = true;
  let result: SendResult = { ok: true };
  const outbox = new ItemStateOutbox(
    async (id, changed) => {
      sent.push([id, changed]);
      return result;
    },
    persistence,
    () => online,
    (ids) => rejected.push(ids),
    () => (drained += 1),
  );
  return {
    outbox,
    sent,
    rejected,
    drained: () => drained,
    persistence,
    setOnline: (v) => (online = v),
    setResult: (r) => (result = r),
  };
}

const tick = () => new Promise((r) => setTimeout(r));

describe('ItemStateOutbox', () => {
  let h: Harness;
  beforeEach(() => {
    h = makeHarness();
  });

  it('delivers a queued write when online and clears it', async () => {
    h.outbox.enqueue('a', { pinned: true }, 1000);
    await tick();
    expect(h.sent).toEqual([['a', { pinned: { value: true, at: 1000 } }]]);
    expect(h.outbox.pendingIds()).toEqual([]);
  });

  it('stamps each changed field with the action time as its last-write-wins clock', async () => {
    // A pin is an exclusivity-closed diff: pin + cleared done/hidden, all at the
    // same action time, so the server can resolve them per field by `at`.
    h.outbox.enqueue('a', { pinned: true, done: false, hidden: false }, 1500);
    await tick();
    expect(h.sent).toEqual([
      [
        'a',
        {
          pinned: { value: true, at: 1500 },
          done: { value: false, at: 1500 },
          hidden: { value: false, at: 1500 },
        },
      ],
    ]);
  });

  it('calls onDrained after a write commits, but not when nothing was delivered', async () => {
    h.outbox.enqueue('a', { done: true }, 1000);
    await tick();
    expect(h.drained()).toBe(1); // committed → server-derived reads can re-validate

    // A transient-only drain delivers nothing → no onDrained.
    h.setResult({ ok: false });
    h.outbox.enqueue('b', { done: true }, 2000);
    await tick();
    expect(h.drained()).toBe(1);
  });

  it('coalesces writes made offline and sends one merged write on reconnect', async () => {
    h.setOnline(false);
    h.outbox.enqueue('a', { pinned: true, done: false, hidden: false }, 1000);
    h.outbox.enqueue('a', { pinned: false }, 2000);
    await tick();
    expect(h.sent).toEqual([]); // offline: nothing sent
    expect(h.outbox.pendingIds()).toEqual(['a']);

    h.setOnline(true);
    await h.outbox.flush();
    // The later Unpin wins for `pinned` (newer at); the still-relevant cleared
    // done/hidden ride along. One send carries the merged fields.
    expect(h.sent).toEqual([
      [
        'a',
        {
          pinned: { value: false, at: 2000 },
          done: { value: false, at: 1000 },
          hidden: { value: false, at: 1000 },
        },
      ],
    ]);
    expect(h.outbox.pendingIds()).toEqual([]);
  });

  it('keeps a transiently-failed write queued and retries it', async () => {
    h.setResult({ ok: false }); // transient
    h.outbox.enqueue('a', { done: true }, 1000);
    await tick();
    expect(h.outbox.pendingIds()).toEqual(['a']); // still queued

    h.setResult({ ok: true });
    await h.outbox.flush();
    expect(h.outbox.pendingIds()).toEqual([]);
    expect(h.sent.length).toBeGreaterThanOrEqual(2); // retried
  });

  it('does not busy-loop while a write keeps failing transiently', async () => {
    h.setResult({ ok: false }); // sustained transient failure
    h.outbox.enqueue('a', { done: true }, 1000);
    // Let many macrotasks elapse; a backed-off retry must not fire within them.
    for (let i = 0; i < 5; i++) await tick();
    // One attempt, then it backs off via a timer (not an immediate re-flush).
    expect(h.sent.length).toBe(1);
    expect(h.outbox.pendingIds()).toEqual(['a']);
  });

  it('reports an id as pending (with its boolean diff) while its send is in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const sent: string[] = [];
    const outbox = new ItemStateOutbox(
      async (id) => {
        sent.push(id);
        await gate; // hold the send open
        return { ok: true };
      },
      memPersistence(),
      () => true,
      () => {},
    );
    outbox.enqueue('a', { pinned: true }, 1000);
    await tick();
    // Send started but hasn't resolved — must still count as pending so a racing
    // hydrate preserves the optimistic local row instead of wiping it.
    expect(sent).toEqual(['a']);
    expect(outbox.pendingIds()).toEqual(['a']);
    // pendingChanges exposes the boolean diff (the at is internal to the outbox).
    expect(outbox.pendingChanges().get('a')).toEqual({ pinned: true });

    release();
    await tick();
    expect(outbox.pendingIds()).toEqual([]);
  });

  it('drops a permanently-rejected write and notifies for re-reconcile', async () => {
    h.setResult({ ok: false, permanent: true }); // lost visibility (42501)
    h.outbox.enqueue('a', { pinned: true }, 1000);
    await tick();
    expect(h.outbox.pendingIds()).toEqual([]); // dropped
    expect(h.rejected).toEqual([['a']]);
  });

  it('keeps the newest per-field value across a coalesced burst', async () => {
    h.setOnline(false);
    h.outbox.enqueue('a', { pinned: true }, 1000);
    h.outbox.enqueue('a', { pinned: false }, 2000); // coalesces; newer wins
    h.setOnline(true);
    await h.outbox.flush();
    expect(h.sent).toEqual([['a', { pinned: { value: false, at: 2000 } }]]);
  });

  it('keeps an in-flight write durable when a follow-up is enqueued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const persistence = memPersistence();
    const outbox = new ItemStateOutbox(
      async (id) => {
        if (id === 'a') await gate; // hold a's send open
        return { ok: true };
      },
      persistence,
      () => true,
      () => {},
    );
    outbox.enqueue('a', { pinned: true }, 1000); // taken in-flight (send awaits gate)
    await tick();
    outbox.enqueue('b', { hidden: true }, 2000); // persist() fires while 'a' in flight
    // Both must be durable — a crash/reload before a's RPC confirms must replay it.
    const ids = (persistence.rows() as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ids).toEqual(['a', 'b']);
    release();
    await tick();
  });

  it('persists pending writes (with timestamps) so a new outbox replays them', async () => {
    h.setOnline(false);
    h.outbox.enqueue('a', { hidden: true }, 1000);
    await tick();
    expect(h.persistence.rows()).toEqual([
      { id: 'a', changed: { hidden: { value: true, at: 1000 } } },
    ]);

    // A fresh outbox over the same persistence (e.g. next boot) replays it.
    const h2 = makeHarness(h.persistence);
    expect(h2.outbox.pendingIds()).toEqual(['a']);
    await h2.outbox.flush();
    expect(h2.sent).toEqual([['a', { hidden: { value: true, at: 1000 } }]]);
    expect(h2.persistence.rows()).toEqual([]);
  });
});
