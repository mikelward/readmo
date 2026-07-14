import { useCallback, useEffect, useRef } from 'react';
import { useIsRestoring, useQueryClient } from '@tanstack/react-query';
import { useDataSource } from '../lib/data/context';
import { useOnlineStatus } from './useOnlineStatus';
import { useFullTextAllowed } from './useCapabilities';
import { useAutoSummarizePinned } from './useReadingPrefs';
import { summaryQueryKey } from './useSummary';
import { isSummarySettled, summaryStaleTime, type SummaryResult } from '../lib/summary';

/**
 * Self-driving backoff for a pinned-summary warm that comes back UNSETTLED — the
 * server is still generating it (the pin trigger downloads the full article
 * first, then summarizes, which can outlast a single invoke), or a transient
 * Jina/Gemini blip. Retry on an exponential backoff until the summary settles
 * into the cache (so it's there for offline), then stop.
 *
 * The property that matters for "the summary must be pulled as soon as it lands
 * on the server" is a SHORT ceiling, so the gap between the server writing the
 * summary and us pulling it stays small (≤ the ceiling): first retry ~2 s,
 * doubling to a 5 s ceiling, then a steady 5 s poll over a ~90 s window. Each
 * poll is a cheap cache-check once generated (a `getSummary` on a populated
 * `ai_summary` is a server cache hit — no Jina, no Gemini), and the loop STOPS
 * the instant the result settles. What counts as unsettled is the SERVER's call,
 * via the envelope (`isSummarySettled`): an outcome polling can't change —
 * notably the not-configured `unavailable` (GOOGLE_API_KEY unset) — comes back
 * without the `retryable` flag and SETTLES after one attempt, so an unconfigured
 * deployment never polls the Edge Function.
 *
 * After ~90 s a still-unsettled pin gives up polling — long enough to cover the
 * server's background generation, bounded so a genuinely-down service isn't
 * hammered while the user is away. An external trigger (reconnect / foreground /
 * a fresh pin) restarts the chain from attempt 0, so a summary that lands after
 * the deadline is still picked up on the next return.
 */
const SUMMARY_WARM_RETRY_BASE_MS = 2_000;
const SUMMARY_WARM_RETRY_MAX_MS = 5_000;
// ~90 s window at the 5 s ceiling: attempts fire at ~0/2/6/11/16/… s — two ramp
// delays (2 s, 4 s) then a steady 5 s cadence — so attempt n≥2 lands at
// 6 + (n−2)·5 s. 18 retries → last attempt ~86 s, i.e. the loop gives up around
// ~90 s, just polling far more often within the window than a wide ceiling would.
const SUMMARY_WARM_MAX_RETRIES = 18;

/**
 * Pre-warm the AI summary for pinned articles so it's ready before the reader
 * opens them — no spinner on first open. The summary sibling of
 * {@link useOfflineCacheLock}, which already warms each pinned item's `['item']`
 * + `['fulltext']` reader queries the same way; this adds `['summary']`.
 *
 * This prefetch is best-effort by nature (an in-flight call dies with the
 * page — pin, lock the phone, and it's gone). The GUARANTEE that a pin
 * generates the summary is server-side: the pin's sync write fires the
 * `summary` function from the database (the 0053/0054 pin trigger, which also
 * downloads the full article first), independent of this hook. What this hook
 * adds on top is the on-device React Query cache warm (so the open is
 * instant, not just cheap) and — while the app stays open — a self-driving
 * retry that keeps re-fetching an unsettled pin until the summary
 * lands in the cache (durable for offline), not just when an external trigger
 * happens to re-fire. That last point is the fix for "the summary is there in
 * the background but the client never picks it up": the server may finish
 * generating a few seconds after the pin, and without this loop that freshly-
 * available summary would sit unfetched until a reconnect / foreground return.
 *
 * The summary itself is NOT gated on pinned — `useSummary` shows it for any
 * article an allowlisted user opens. Pinning is just a **prefetch signal**: a
 * pinned item is likely to be read, so we warm it ahead of time. Warms every
 * pinned item, whichever way it became pinned: a pin made on this device, a pin
 * **synced from another device** (hydration), or a pin already present on boot.
 * Both this and the reader's on-open `useSummary` share the `['summary', id]`
 * key and the result caches on `items.ai_summary`, so whichever fires first
 * generates and the rest are plain cache hits — never a second Gemini call.
 *
 * Cross-device warming is cheap precisely because the summary is cached
 * server-side: a warm of an already-generated summary is a **server cache hit**
 * (no Jina, no Gemini — see `summary` Edge Function's `item.ai_summary` short
 * circuit), and a never-summarized pin generates exactly **once**, shared across
 * every device and user.
 *
 * Gated **online + allowlisted + opted-in** (the family-only "Auto generate
 * summaries for pinned articles" setting, on by default — see
 * useAutoSummarizePinned), so an off-list user fires no Edge call and a family
 * user who turned it off warms nothing (the server re-checks regardless). An
 * item is
 * marked warmed only on a **settled** outcome, so a transient `unreachable` or
 * a retryable-flagged result stays unwarmed and retries on reconnect / once the
 * allowlist gate resolves. The store subscriber warms only **newly-pinned** ids (so an
 * unrelated state emit during an outage doesn't re-fetch every unsettled pinned
 * summary); whole-set retries are left to the restore/reconnect/gate effect and
 * a once-per-return foreground (focus / visibility) retry — which also cancels a
 * fetch left frozen by an app suspension so the fresh warm doesn't dedupe into a
 * dead promise.
 * Warming is held off until the persisted React Query cache has **restored**
 * (like `useOfflineCacheLock`): prefetching against the not-yet-hydrated cache
 * would re-fetch every already-cached pinned summary on each boot. Mount once
 * near the app root, next to `useOfflineCacheLock`.
 */
export function useSummaryPrewarm(): void {
  const ds = useDataSource();
  const queryClient = useQueryClient();
  const online = useOnlineStatus();
  const allowed = useFullTextAllowed();
  // The family-only opt-in (on by default). When off, warm nothing — the reader
  // still generates on-open for whoever opens an article; this only skips the
  // ahead-of-time prefetch.
  const { autoSummarizePinned } = useAutoSummarizePinned();
  // True while PersistQueryClientProvider is rehydrating the cache. Warming must
  // wait: running before hydration completes would see an empty cache and
  // re-fetch every persisted pinned summary on boot (defeating the cache).
  const isRestoring = useIsRestoring();

  // Connectivity / gate / restore read at warm time without re-running the
  // subscribe effect (which would re-attach the store listener) on every change.
  const onlineRef = useRef(online);
  onlineRef.current = online;
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;
  const autoSummarizeRef = useRef(autoSummarizePinned);
  autoSummarizeRef.current = autoSummarizePinned;
  const restoringRef = useRef(isRestoring);
  restoringRef.current = isRestoring;
  const warmed = useRef(new Set<string>()).current;
  // Previous pinned id set, so the store subscriber can warm only NEWLY-pinned
  // ids. `null` until the first sync — the initial pinned set is warmed by the
  // restore/online/allowed effect below, not the subscriber, so boot/hydration
  // emits don't churn the whole set through `warm`.
  const prevPinned = useRef<Set<string> | null>(null);
  // Pending backoff-retry timers keyed by id (see SUMMARY_WARM_* above). One at a
  // time per id; its presence also means "a retry chain is active for this id".
  const retryTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>()).current;

  // Cancel any pending backoff retry for an id (settled, unpinned, or unmounting).
  const cancelRetry = useCallback(
    (id: string) => {
      const t = retryTimers.get(id);
      if (t !== undefined) {
        clearTimeout(t);
        retryTimers.delete(id);
      }
    },
    [retryTimers],
  );

  // Ref indirection so a backoff timer can invoke the latest `runWarm` without
  // making `runWarm` its own dependency (they're mutually recursive: runWarm
  // schedules a timer that calls runWarm).
  const runWarmRef = useRef<(id: string, attempt: number) => void>(() => {});

  // Prefetch one item's summary and, if it comes back UNSETTLED, schedule the
  // next backoff attempt. No-op while restoring, offline, gated off, or already
  // warmed (gates re-checked on every tick, so a chain stops itself the moment
  // the app goes offline / the gate closes). `attempt` is the 0-based retry index
  // — 0 is the first (external-triggered) try. Marks warmed only once the result
  // is SETTLED.
  const runWarm = useCallback(
    (id: string, attempt: number) => {
      if (
        restoringRef.current ||
        warmed.has(id) ||
        !onlineRef.current ||
        !allowedRef.current ||
        !autoSummarizeRef.current
      )
        return;
      void queryClient
        .prefetchQuery({
          queryKey: summaryQueryKey(id),
          // Thread React Query's per-fetch signal through, so cancelling this
          // query (the foreground-resume path below) aborts the actual invoke
          // rather than only resetting query state.
          queryFn: ({ signal }) => ds.getSummary(id, { signal }),
          staleTime: summaryStaleTime,
        })
        .then(() => {
          const data = queryClient.getQueryData<SummaryResult>(summaryQueryKey(id));
          if (data && isSummarySettled(data)) {
            warmed.add(id);
            cancelRetry(id);
            return;
          }
          // Unsettled — keep polling on an exponential backoff (5 s ceiling) so a
          // summary the server finishes generating moments later (or after a
          // transient blip clears) lands in the cache within ~5 s, without waiting
          // for a reconnect / foreground trigger. Outcomes polling can't change
          // never reach here: the server ships them without the `retryable` flag,
          // so they SETTLE above (see isSummarySettled).
          if (attempt >= SUMMARY_WARM_MAX_RETRIES) return; // ~90 s deadline — leave to external triggers
          // Don't schedule further polls while the tab is HIDDEN. Desktop browsers
          // only THROTTLE (not freeze) background timers, so an unsettled chain
          // would keep hitting the Edge Function while the user is away — a service
          // outage would rack up calls. The hidden-edge flush (visibility effect
          // below) is meant to be ONE last pull before the tab freezes; the
          // foreground-return flush restarts the chain from attempt 0. Reading
          // visibilityState live here also halts an in-flight chain the moment the
          // tab hides, not just the hidden-edge pull.
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          if (retryTimers.has(id)) return; // a retry is already queued for this id
          const delay = Math.min(
            SUMMARY_WARM_RETRY_BASE_MS * 2 ** attempt,
            SUMMARY_WARM_RETRY_MAX_MS,
          );
          const handle = setTimeout(() => {
            retryTimers.delete(id);
            // Skip if it settled or was unpinned while the timer waited — no point
            // spending another call on an item the user no longer cares about.
            if (warmed.has(id) || !ds.stateStore.get(id).pinned) return;
            runWarmRef.current(id, attempt + 1);
          }, delay);
          retryTimers.set(id, handle);
        });
    },
    [ds, queryClient, warmed, cancelRetry, retryTimers],
  );
  runWarmRef.current = runWarm;

  // External entry point (a fresh pin, reconnect, foreground return, gate/setting
  // flip). Idempotent: a no-op for already-warmed ids. Cancels any in-flight
  // backoff and restarts the chain from attempt 0 — an external trigger is a
  // fresh boundary that should retry NOW rather than wait out the current backoff
  // (runWarm re-checks all the gates, so a gated/offline caller still no-ops).
  const warm = useCallback(
    (id: string) => {
      if (warmed.has(id)) return;
      cancelRetry(id);
      runWarm(id, 0);
    },
    [warmed, cancelRetry, runWarm],
  );

  // Warm items as they're NEWLY pinned — a pin made here, or a pin synced from
  // another device (hydrate → emit) after the baseline. Only the delta is warmed
  // (not the whole pinned set on every emit), so an unrelated favorite/done/open/
  // sync emit never re-fetches an unsettled pinned summary. The first sync seeds
  // the baseline without warming; forget unpinned ids so a later re-pin
  // re-checks.
  useEffect(() => {
    const store = ds.stateStore;
    const sync = () => {
      const pinned = new Set(
        store
          .entries()
          .filter(([, s]) => s.pinned)
          .map(([id]) => id),
      );
      const prev = prevPinned.current;
      if (prev) for (const id of pinned) if (!prev.has(id)) warm(id);
      for (const id of [...warmed]) if (!pinned.has(id)) warmed.delete(id);
      // Stop the backoff chain for anything no longer pinned — no point retrying
      // a summary for an item the user just unpinned (a later re-pin restarts a
      // fresh chain from attempt 0). The timer's own pinned check would skip it
      // too, but cancelling frees the timer now.
      for (const id of [...retryTimers.keys()]) if (!pinned.has(id)) cancelRetry(id);
      prevPinned.current = pinned;
    };
    sync();
    return store.subscribe(sync);
  }, [ds, warm, warmed, retryTimers, cancelRetry]);

  // Warm the pinned set once it's both safe and useful — after the persisted
  // cache restored (so already-cached summaries are seen, not re-fetched) and
  // while online + allowed + opted-in. Also covers reconnect, the allowlist gate
  // resolving, and the setting being switched on: pins held off in those states
  // fill in here.
  useEffect(() => {
    if (isRestoring || !online || !allowed || !autoSummarizePinned) return;
    for (const [id, s] of ds.stateStore.entries()) if (s.pinned) warm(id);
  }, [isRestoring, online, allowed, autoSummarizePinned, ds, warm]);

  // Flush pending summary warms on EITHER edge of a focus-change boundary — the
  // general "flush pending work when focus changes" principle. The self-driving
  // backoff keeps polling while the app stays open, but its timers freeze while
  // the page is hidden/suspended, so flush on both transitions:
  //   - visibility→VISIBLE (or a window focus on a visible tab): a fresh,
  //     user-salient boundary that restarts each pin's chain from attempt 0
  //     (`warm` cancels any pending backoff and retries now) instead of waiting
  //     out whatever delay was pending when the app went to sleep — and cancels a
  //     fetch left frozen by the suspension (a corpse) so the fresh warm isn't
  //     deduped into a dead promise.
  //   - visibility→HIDDEN: the symmetric half — fire one last pull as we go
  //     background, so a summary that's ready right now is grabbed and persisted
  //     before the tab's timers freeze; without it, that pull would wait for the
  //     next (now-frozen) backoff tick and miss until the next foreground open.
  //     One-shot: runWarm suppresses backoff scheduling while hidden.
  // Bounded, once-per-transition (NOT per-emit — those are left to the backoff to
  // avoid amplifying an outage); `warm` is idempotent, so already-warmed /
  // offline / gated / restoring ids no-op and a settled summary is never
  // re-fetched.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const rewarmPinned = (cancelStuck: boolean) => {
      // A bare `focus` can fire on a still-hidden tab; only warm when actually
      // visible (mirrors useStateSync), so an occluded focus doesn't prefetch.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      for (const [id, s] of ds.stateStore.entries()) {
        if (!s.pinned || warmed.has(id)) continue;
        // Coming back from HIDDEN: a fetch that was in flight when the app was
        // suspended is likely a corpse — mobile browsers freeze the page
        // mid-request, and after resume that fetch may never settle. Re-warming
        // through it is useless: React Query dedupes the new prefetch into the
        // same dead promise. Cancel it first so the warm below issues a genuinely
        // fresh request (which, post-generation, is a fast server cache hit) —
        // this is what makes "pin, lock the phone, come back, open" find the
        // summary already cached instead of joining a dead fetch. Only on the
        // hidden→visible transition — a desktop focus flip must not abort a
        // healthy in-flight generation.
        if (
          cancelStuck &&
          queryClient.getQueryState(summaryQueryKey(id))?.fetchStatus === 'fetching'
        ) {
          void queryClient
            .cancelQueries({ queryKey: summaryQueryKey(id), exact: true })
            .then(() => warm(id));
        } else {
          warm(id);
        }
      }
    };
    const onFocus = () => rewarmPinned(false);
    // Going HIDDEN: one last pull before the freeze. rewarmPinned bails on hidden
    // (its guard is for an occluded focus), so warm directly here — runWarm's
    // hidden check makes it a genuine one-shot with no background rescheduling.
    const flushOnHide = () => {
      for (const [id, s] of ds.stateStore.entries()) {
        if (s.pinned && !warmed.has(id)) warm(id);
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') rewarmPinned(true);
      else flushOnHide();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [ds, warm, warmed, queryClient]);

  // Cancel every pending backoff timer on unmount, so a scheduled retry can't
  // fire against a torn-down tree (and no timer leaks across tests).
  useEffect(() => {
    return () => {
      for (const t of retryTimers.values()) clearTimeout(t);
      retryTimers.clear();
    };
  }, [retryTimers]);
}
