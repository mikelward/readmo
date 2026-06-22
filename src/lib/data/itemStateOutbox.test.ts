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
  bases: Array<number | null>;
  rejected: string[][];
  setOnline: (v: boolean) => void;
  setResult: (r: SendResult) => void;
  persistence: ReturnType<typeof memPersistence>;
}

function makeHarness(persistence = memPersistence()): Harness {
  const sent: Array<[string, ChangedFields]> = [];
  const bases: Array<number | null> = [];
  const rejected: string[][] = [];
  let online = true;
  let result: SendResult = { ok: true };
  const outbox = new ItemStateOutbox(
    async (id, changed, base) => {
      sent.push([id, changed]);
      bases.push(base);
      return result;
    },
    persistence,
    () => online,
    (ids) => rejected.push(ids),
  );
  return {
    outbox,
    sent,
    bases,
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

  it('reports an id as pending while its send is in flight', async () => {
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
    outbox.enqueue('a', { pinned: true });
    await tick();
    // Send started but hasn't resolved — must still count as pending so a racing
    // hydrate preserves the optimistic local row instead of wiping it.
    expect(sent).toEqual(['a']);
    expect(outbox.pendingIds()).toEqual(['a']);
    expect(outbox.pendingChanges().get('a')).toEqual({ pinned: true });

    release();
    await tick();
    expect(outbox.pendingIds()).toEqual([]);
  });

  it('drops a permanently-rejected write and notifies for re-reconcile', async () => {
    h.setResult({ ok: false, permanent: true });
    h.outbox.enqueue('a', { pinned: true });
    await tick();
    expect(h.outbox.pendingIds()).toEqual([]); // dropped
    expect(h.rejected).toEqual([['a']]);
  });

  describe('optimistic concurrency (base version)', () => {
    it('sends a null base (no check) for an edit made before the first hydrate', async () => {
      // Cold boot: version unknown, and we can't tell new from existing yet.
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.bases).toEqual([null]);
    });

    it('bases a brand-new item on 0 once a hydrate confirms it has no row', async () => {
      h.outbox.observeServerVersions([]); // hydrate ran; 'a' has no server row
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.bases).toEqual([0]);
    });

    it('bases a write on the observed server version', async () => {
      h.outbox.observeServerVersions([['a', 5]]);
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.bases).toEqual([5]);
    });

    it('advances the base to the returned version for the next edit', async () => {
      h.outbox.observeServerVersions([['a', 5]]);
      h.setResult({ ok: true, version: 6 });
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      // A later, separate edit is based on the version the first write returned.
      h.setResult({ ok: true, version: 7 });
      h.outbox.enqueue('a', { pinned: false });
      await tick();
      expect(h.bases).toEqual([5, 6]);
    });

    it('keeps the original base across a coalesced burst', async () => {
      h.outbox.observeServerVersions([['a', 5]]);
      h.setOnline(false);
      h.outbox.enqueue('a', { pinned: true });
      h.outbox.enqueue('a', { pinned: false }); // coalesces; base unchanged
      h.setOnline(true);
      await h.outbox.flush();
      expect(h.bases).toEqual([5]);
      expect(h.sent).toEqual([['a', { pinned: false }]]);
    });

    it('drops the item (and notifies) on a version conflict', async () => {
      h.outbox.observeServerVersions([['a', 5]]);
      h.setResult({ ok: false, permanent: true }); // conflict
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.bases).toEqual([5]);
      expect(h.outbox.pendingIds()).toEqual([]); // rolled back
      expect(h.rejected).toEqual([['a']]);
    });
  });

  it('persists pending writes so a new outbox replays them', async () => {
    h.outbox.observeServerVersions([]); // hydrate ran; 'a' is new → base 0
    h.setOnline(false);
    h.outbox.enqueue('a', { hidden: true });
    await tick();
    expect(h.persistence.rows()).toEqual([
      { id: 'a', changed: { hidden: true }, base: 0 },
    ]);

    // A fresh outbox over the same persistence (e.g. next boot) replays it.
    const h2 = makeHarness(h.persistence);
    expect(h2.outbox.pendingIds()).toEqual(['a']);
    await h2.outbox.flush();
    expect(h2.sent).toEqual([['a', { hidden: true }]]);
    expect(h2.persistence.rows()).toEqual([]);
  });
});
