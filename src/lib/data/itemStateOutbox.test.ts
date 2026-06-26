// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  drained: () => number;
  setOnline: (v: boolean) => void;
  setResult: (r: SendResult) => void;
  persistence: ReturnType<typeof memPersistence>;
}

function makeHarness(persistence = memPersistence()): Harness {
  const sent: Array<[string, ChangedFields]> = [];
  const bases: Array<number | null> = [];
  const rejected: string[][] = [];
  let drained = 0;
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
    () => (drained += 1),
  );
  return {
    outbox,
    sent,
    bases,
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
    h.outbox.enqueue('a', { pinned: true });
    await tick();
    expect(h.sent).toEqual([['a', { pinned: true }]]);
    expect(h.outbox.pendingIds()).toEqual([]);
  });

  it('calls onDrained after a write commits, but not when nothing was delivered', async () => {
    h.outbox.enqueue('a', { done: true });
    await tick();
    expect(h.drained()).toBe(1); // committed → server-derived reads can re-validate

    // A transient-only drain delivers nothing → no onDrained.
    h.setResult({ ok: false });
    h.outbox.enqueue('b', { done: true });
    await tick();
    expect(h.drained()).toBe(1);
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

    it('seeds a write base from a persisted store version (no live hydrate)', async () => {
      // Offline cold boot: no live read to observe versions, so the base comes
      // from the persisted store. An edit must base on it, not send a null base.
      h.outbox.seedConfirmedVersions([['a', 5]]);
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.bases).toEqual([5]);
    });

    it('seeding versions does not authorize base 0 for an unseeded item', async () => {
      // Unlike a full hydrate, a seed can't confirm an item is absent — so a
      // brand-new edit on an unseeded item still sends a null base (no check),
      // never base 0 (which would false-conflict if the row actually exists).
      h.outbox.seedConfirmedVersions([['a', 5]]); // only 'a' known
      h.outbox.enqueue('b', { pinned: true });
      await tick();
      expect(h.bases).toEqual([null]);
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

    it('does not rewind a known server version to an older observed one', async () => {
      h.outbox.observeServerVersions([['a', 6]]); // recorded by a successful send
      h.outbox.observeServerVersions([['a', 5]]); // stale select landing late
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.bases).toEqual([6]); // bases on the newer version, not the stale 5
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

    it('holds an unresolvable-base write while a hydrate is in flight, then sends base 0 once it confirms absence', async () => {
      // The feed/library read no longer blocks on hydration, so a write can be
      // made on a brand-new row before the hydrate lands. Sending it with no base
      // check could clobber a concurrent cross-device change — so hold it while a
      // hydrate is in flight to resolve the base.
      h.outbox.noteHydrationStarted();
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.sent).toEqual([]); // held — no base yet
      expect(h.outbox.pendingIds()).toEqual(['a']);

      h.outbox.observeServerVersions([]); // hydrate confirms 'a' has no server row
      h.outbox.noteHydrationSettled();
      await tick();
      expect(h.sent).toEqual([['a', { pinned: true }]]);
      expect(h.bases).toEqual([0]);
    });

    it('a held write adopts the version a hydrate observes, not base 0', async () => {
      // If the hydrate finds the row DOES exist server-side (another device
      // created it since the persisted snapshot), the held write must base on
      // that version — not 0, which would false-conflict and drop the edit.
      h.outbox.noteHydrationStarted();
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.sent).toEqual([]); // held

      h.outbox.observeServerVersions([['a', 9]]);
      h.outbox.noteHydrationSettled();
      await tick();
      expect(h.bases).toEqual([9]);
      expect(h.sent).toEqual([['a', { pinned: true }]]);
    });

    it('locks a held write to its first resolved base so a retry does not rebase onto a newer cross-device version', async () => {
      // A held write resolves its base from the hydrate (the version the user
      // acted on). If the send fails transiently and a later hydrate sees another
      // device move the row forward, the retry must STILL base on the original
      // version — so it conflicts/reconciles instead of clobbering that change.
      h.outbox.noteHydrationStarted();
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.sent).toEqual([]); // held

      h.setResult({ ok: false }); // the first send will fail transiently
      h.outbox.observeServerVersions([['a', 5]]); // user acted on v5
      h.outbox.noteHydrationSettled();
      await tick();
      expect(h.bases).toEqual([5]); // sent base 5, transient-failed → requeued

      // A later focus hydrate sees another device moved 'a' to v7.
      h.outbox.observeServerVersions([['a', 7]]);
      h.setResult({ ok: true });
      await h.outbox.flush();
      // Retry still bases on 5 (locked), not 7 — no silent clobber.
      expect(h.bases).toEqual([5, 5]);
    });

    it('persists a held write\'s resolved base before sending, so a crash mid-send replays with the right base', async () => {
      // The flush only persists in its `finally` (after send resolves), so a held
      // write's resolved base must be persisted at lock time — otherwise a crash
      // while the RPC is in flight leaves base:null on disk and the next boot
      // re-holds + rebases it onto newer truth.
      let releaseSend: () => void = () => {};
      const gate = new Promise<void>((r) => (releaseSend = r));
      const persistence = memPersistence();
      const sentBases: Array<number | null> = [];
      const outbox = new ItemStateOutbox(
        async (_id, _changed, base) => {
          sentBases.push(base);
          await gate; // hold the send open (models a crash window mid-RPC)
          return { ok: true };
        },
        persistence,
        () => true,
        () => {},
      );

      outbox.noteHydrationStarted();
      outbox.enqueue('a', { pinned: true });
      await tick();
      expect(sentBases).toEqual([]); // held; persisted with no base
      const heldRows = persistence.rows() as Array<{ id: string; base: number | null }>;
      expect(heldRows.find((r) => r.id === 'a')?.base ?? null).toBe(null);

      outbox.observeServerVersions([['a', 5]]); // user acted on v5
      outbox.noteHydrationSettled();
      await tick();
      // Send is now in flight (gated). The resolved base must already be on disk.
      expect(sentBases).toEqual([5]);
      const inFlightRows = persistence.rows() as Array<{ id: string; base: number | null }>;
      expect(inFlightRows.find((r) => r.id === 'a')?.base).toBe(5);

      releaseSend();
      await tick();
    });

    it('marks an item confirmed-since only after a successful (not rejected) send', async () => {
      // The hydrate stale-read guard keys off this: a CONFIRMED write lands in
      // confirmedSince(epochBeforeIt); a rejected one never does.
      const epoch0 = h.outbox.writeEpoch();
      h.outbox.observeServerVersions([['a', 1]]);
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.outbox.confirmedSince(epoch0)).toEqual(new Set(['a']));

      // A rejected write does not advance the confirmed epoch.
      const epoch1 = h.outbox.writeEpoch();
      h.setResult({ ok: false, permanent: true });
      h.outbox.observeServerVersions([['b', 1]]);
      h.outbox.enqueue('b', { pinned: true });
      await tick();
      expect(h.outbox.confirmedSince(epoch1)).toEqual(new Set()); // 'b' not confirmed
    });

    it('does not hold a no-base write forever when the hydrate never settles', async () => {
      // The hold relies on the hydrate settling (noteHydrationSettled). If it
      // never does — a NetworkOnly read whose abort never surfaces — the write
      // must still go out (unchecked) after the bounded fallback, not be stranded.
      vi.useFakeTimers();
      try {
        const sent: Array<[string, ChangedFields]> = [];
        const bases: Array<number | null> = [];
        const outbox = new ItemStateOutbox(
          async (id, changed, base) => {
            sent.push([id, changed]);
            bases.push(base);
            return { ok: true };
          },
          memPersistence(),
          () => true,
          () => {},
        );
        outbox.noteHydrationStarted(); // a hydrate is in flight — and never settles
        outbox.enqueue('a', { pinned: true });
        await vi.advanceTimersByTimeAsync(0);
        expect(sent).toEqual([]); // held: no base, hydrate in flight

        await vi.advanceTimersByTimeAsync(20000); // past HOLD_MAX_MS
        expect(sent).toEqual([['a', { pinned: true }]]);
        expect(bases).toEqual([null]); // unchecked fallback rather than stranded
      } finally {
        vi.useRealTimers();
      }
    });

    it('releases a held write with no check if the hydrate fails (no base to wait on)', async () => {
      // Hydrate failed (offline / backend down): nothing observed and no read in
      // flight anymore, so fall back to the unchecked send rather than stranding
      // the write forever.
      h.outbox.noteHydrationStarted();
      h.outbox.enqueue('a', { pinned: true });
      await tick();
      expect(h.sent).toEqual([]); // held while in flight

      h.outbox.noteHydrationSettled(); // settled without observing anything
      await tick();
      expect(h.sent).toEqual([['a', { pinned: true }]]);
      expect(h.bases).toEqual([null]);
    });
  });

  it('keeps an in-flight write durable when a follow-up is enqueued', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const persistence = memPersistence();
    const outbox = new ItemStateOutbox(
      async (id) => {
        if (id === 'a') await gate; // hold a's send open
        return { ok: true, version: 1 };
      },
      persistence,
      () => true,
      () => {},
    );
    outbox.enqueue('a', { pinned: true }); // taken in-flight (send awaits gate)
    await tick();
    outbox.enqueue('b', { hidden: true }); // persist() fires while 'a' in flight
    // Both must be durable — a crash/reload before a's RPC confirms must replay it.
    const ids = (persistence.rows() as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ids).toEqual(['a', 'b']);
    release();
    await tick();
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
