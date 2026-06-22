// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ItemStateOutbox,
  type ChangedFields,
  type OutboxPersistence,
  type SendResult,
} from './itemStateOutbox';

function memPersistence(): OutboxPersistence & { rows: () => unknown } {
  let saved: Array<{ id: string; changed: ChangedFields }> = [];
  return {
    load: () => saved.map((e) => ({ ...e })),
    save: (entries) => {
      saved = entries.map((e) => ({ ...e }));
    },
    rows: () => saved,
  };
}

interface Harness {
  outbox: ItemStateOutbox;
  sent: Array<[string, ChangedFields]>;
  rejected: string[][];
  setOnline: (v: boolean) => void;
  setResult: (r: SendResult) => void;
  persistence: ReturnType<typeof memPersistence>;
}

function makeHarness(persistence = memPersistence()): Harness {
  const sent: Array<[string, ChangedFields]> = [];
  const rejected: string[][] = [];
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
  );
  return {
    outbox,
    sent,
    rejected,
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
    h.outbox.enqueue('a', { pinned: true });
    await tick();
    expect(h.sent).toEqual([['a', { pinned: true }]]);
    expect(h.outbox.pendingIds()).toEqual([]);
  });

  it('coalesces writes made offline and sends one merged write on reconnect', async () => {
    h.setOnline(false);
    h.outbox.enqueue('a', { pinned: true, done: false, hidden: false });
    h.outbox.enqueue('a', { pinned: false });
    await tick();
    expect(h.sent).toEqual([]); // offline: nothing sent
    expect(h.outbox.pendingIds()).toEqual(['a']);

    h.setOnline(true);
    await h.outbox.flush();
    // The later Unpin wins; one send carries the merged final fields.
    expect(h.sent).toEqual([['a', { pinned: false, done: false, hidden: false }]]);
    expect(h.outbox.pendingIds()).toEqual([]);
  });

  it('keeps a transiently-failed write queued and retries it', async () => {
    h.setResult({ ok: false }); // transient
    h.outbox.enqueue('a', { done: true });
    await tick();
    expect(h.outbox.pendingIds()).toEqual(['a']); // still queued

    h.setResult({ ok: true });
    await h.outbox.flush();
    expect(h.outbox.pendingIds()).toEqual([]);
    expect(h.sent.length).toBeGreaterThanOrEqual(2); // retried
  });

  it('does not busy-loop while a write keeps failing transiently', async () => {
    h.setResult({ ok: false }); // sustained transient failure
    h.outbox.enqueue('a', { done: true });
    // Let many macrotasks elapse; a backed-off retry must not fire within them.
    for (let i = 0; i < 5; i++) await tick();
    // One attempt, then it backs off via a timer (not an immediate re-flush).
    expect(h.sent.length).toBe(1);
    expect(h.outbox.pendingIds()).toEqual(['a']);
  });

  it('drops a permanently-rejected write and notifies for re-reconcile', async () => {
    h.setResult({ ok: false, permanent: true });
    h.outbox.enqueue('a', { pinned: true });
    await tick();
    expect(h.outbox.pendingIds()).toEqual([]); // dropped
    expect(h.rejected).toEqual([['a']]);
  });

  it('persists pending writes so a new outbox replays them', async () => {
    h.setOnline(false);
    h.outbox.enqueue('a', { hidden: true });
    await tick();
    expect(h.persistence.rows()).toEqual([{ id: 'a', changed: { hidden: true } }]);

    // A fresh outbox over the same persistence (e.g. next boot) replays it.
    const h2 = makeHarness(h.persistence);
    expect(h2.outbox.pendingIds()).toEqual(['a']);
    await h2.outbox.flush();
    expect(h2.sent).toEqual([['a', { hidden: true }]]);
    expect(h2.persistence.rows()).toEqual([]);
  });
});
