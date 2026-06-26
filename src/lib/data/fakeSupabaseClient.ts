// A minimal in-memory stand-in for the supabase-js client, just enough to drive
// SupabaseDataSource's read/write surface in tests: the PostgREST query-builder
// chain used by the data source (select/in/not/eq/ilike/order/range/limit/
// maybeSingle, plus update/delete) and functions.invoke. NOT a faithful
// PostgREST emulation — it applies the same filters the data source issues so we
// can assert mapping, ordering, filtering, pagination, and dispatch.

import { TTL_MS } from '../types';

type Row = Record<string, unknown>;

interface OrderSpec {
  col: string;
  ascending: boolean;
  nullsFirst: boolean;
}

export interface FakeTables {
  [table: string]: Row[];
}

export interface InvokeCall {
  name: string;
  body: unknown;
}

function parseInList(value: string): Set<string> {
  // value looks like "(a,b,c)"
  const inner = value.replace(/^\(/, '').replace(/\)$/, '');
  return new Set(inner.length ? inner.split(',') : []);
}

function likeToContains(pattern: string): string {
  // "%foo%" → "foo"; unescape the \%, \_, \\ the data source adds.
  return pattern
    .replace(/^%/, '')
    .replace(/%$/, '')
    .replace(/\\([\\%_])/g, '$1')
    .toLowerCase();
}

class FakeQuery implements PromiseLike<{ data: unknown; count: number | null; error: unknown }> {
  private rows: Row[];
  private filters: Array<(r: Row) => boolean> = [];
  private orders: OrderSpec[] = [];
  private rangeBounds: [number, number] | null = null;
  private limitN: number | null = null;
  private single = false;
  private wantCount = false;

  // write modes
  private mode: 'select' | 'update' | 'delete' = 'select';
  private patch: Row | null = null;

  constructor(
    private readonly table: string,
    private readonly store: FakeTables,
    private readonly control: {
      failSelectOnce: Set<string>;
      ignoreNotIn: boolean;
      selectCounts: Map<string, number>;
      /** Per-table server-side row cap, modeling PostgREST's max-rows ceiling.
       * Applied after range/limit so a `.range()`-paged read still sees each
       * page truncated to the cap, exactly like the real server. */
      maxRows: Map<string, number>;
    },
  ) {
    this.rows = store[table] ?? [];
  }

  select(_cols?: string, opts?: { count?: string }): this {
    this.mode = 'select';
    if (opts?.count) this.wantCount = true;
    return this;
  }

  update(patch: Row): this {
    this.mode = 'update';
    this.patch = patch;
    return this;
  }

  delete(): this {
    this.mode = 'delete';
    return this;
  }

  in(col: string, vals: unknown[]): this {
    const set = new Set(vals);
    this.filters.push((r) => set.has(r[col]));
    return this;
  }

  not(col: string, op: string, value: string): this {
    // Simulate the server skipping the `not in` filter (e.g. exclusion set over
    // the cap), so the data source's client-side floor can be exercised.
    if (this.control.ignoreNotIn) return this;
    if (op === 'in') {
      const set = parseInList(value);
      this.filters.push((r) => !set.has(String(r[col])));
    }
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push((r) => r[col] === val);
    return this;
  }

  gt(col: string, val: unknown): this {
    // String comparison matches how uuid/text columns order in the real DB for
    // the canonical ids these tests use — consistent with `order(col)` below, so
    // keyset pagination (`.gt(lastId).order(id).limit(n)`) pages correctly.
    this.filters.push((r) => String(r[col]) > String(val));
    return this;
  }

  ilike(col: string, pattern: string): this {
    const needle = likeToContains(pattern);
    this.filters.push((r) => String(r[col] ?? '').toLowerCase().includes(needle));
    return this;
  }

  order(col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }): this {
    this.orders.push({
      col,
      ascending: opts?.ascending ?? true,
      nullsFirst: opts?.nullsFirst ?? false,
    });
    return this;
  }

  range(from: number, to: number): this {
    this.rangeBounds = [from, to];
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  maybeSingle(): this {
    this.single = true;
    return this;
  }

  private filtered(): Row[] {
    return this.rows.filter((r) => this.filters.every((f) => f(r)));
  }

  // Emulates the `sort_at` generated column (coalesce(published_at, created_at)).
  private valueOf(row: Row, col: string): unknown {
    if (col === 'sort_at') return row.published_at ?? row.created_at;
    return row[col];
  }

  private sorted(rows: Row[]): Row[] {
    if (this.orders.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const { col, ascending, nullsFirst } of this.orders) {
        const av = this.valueOf(a, col);
        const bv = this.valueOf(b, col);
        const aNull = av === null || av === undefined;
        const bNull = bv === null || bv === undefined;
        if (aNull || bNull) {
          if (aNull && bNull) continue;
          return (aNull ? -1 : 1) * (nullsFirst ? 1 : -1) * 1;
        }
        let c = 0;
        if (col.endsWith('_at') || col === 'published_at') {
          c = Date.parse(String(av)) - Date.parse(String(bv));
        } else if (typeof av === 'number' && typeof bv === 'number') {
          c = av - bv;
        } else {
          c = String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0;
        }
        if (c !== 0) return ascending ? c : -c;
      }
      return 0;
    });
  }

  then<R1 = { data: unknown; count: number | null; error: unknown }, R2 = never>(
    onfulfilled?: ((v: { data: unknown; count: number | null; error: unknown }) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private run(): { data: unknown; count: number | null; error: unknown } {
    if (this.mode === 'delete') {
      const survivors = this.rows.filter((r) => !this.filters.every((f) => f(r)));
      this.store[this.table] = survivors;
      return { data: null, count: null, error: null };
    }
    if (this.mode === 'update') {
      for (const r of this.filtered()) Object.assign(r, this.patch);
      return { data: null, count: null, error: null };
    }
    // Count select requests per table (lets tests prove `in (…)` chunking).
    this.control.selectCounts.set(
      this.table,
      (this.control.selectCounts.get(this.table) ?? 0) + 1,
    );
    // One-shot injected failure for the next select on this table.
    if (this.control.failSelectOnce.has(this.table)) {
      this.control.failSelectOnce.delete(this.table);
      return {
        data: null,
        count: null,
        error: { message: `injected error for ${this.table}` },
      };
    }
    const matched = this.filtered();
    const count = this.wantCount ? matched.length : null;
    let out = this.sorted(matched);
    if (this.rangeBounds) {
      const [from, to] = this.rangeBounds;
      out = out.slice(from, to + 1);
    } else if (this.limitN !== null) {
      out = out.slice(0, this.limitN);
    }
    // PostgREST caps a response at its configured max-rows ceiling — applied
    // last, so even a `.range()`-paged read gets each page truncated to the cap.
    const cap = this.control.maxRows.get(this.table);
    if (cap !== undefined && out.length > cap) out = out.slice(0, cap);
    if (this.single) {
      return { data: out[0] ?? null, count, error: null };
    }
    return { data: out, count, error: null };
  }
}

/** Emulate the RPCs (0006_feed_rpcs.sql + set_item_state) against the seeded
 * tables: drive from subscriptions, LEFT JOIN item_state, build the combined
 * Pinned-then-body sequence ordered like the SQL, and page it. set_item_state
 * upserts store.item_state so a write-through is visible to later reads. */
function runRpc(
  store: FakeTables,
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }>,
  name: string,
  params: Record<string, unknown>,
): { data: unknown; error: unknown } {
  rpcCalls.push({ name, params });
  const items = store.items ?? [];
  const subs = (store.subscriptions ??= []);
  const states = (store.item_state ??= []);
  const subByFeed = new Map(subs.map((s) => [s.feed_id, s]));
  const stateByItem = new Map(states.map((s) => [s.item_id, s]));

  if (name === 'set_item_state') {
    const itemId = params.p_item_id as string;
    const fields = ['pinned', 'favorite', 'done', 'hidden', 'opened'] as const;
    let row = stateByItem.get(itemId);
    // Optimistic concurrency (0007): apply only if the row is still at the
    // caller's base version (0 = expect no row yet), else a conflict error.
    const base = params.p_base_version;
    if (typeof base === 'number') {
      const cur = (row?.version as number | undefined) ?? 0;
      if (cur !== base) {
        return {
          data: null,
          error: { code: '40001', message: `item_state ${itemId} changed since version ${base} (server at ${cur})` },
        };
      }
    }
    if (!row) {
      row = { item_id: itemId, pinned: false, favorite: false, done: false, hidden: false, opened: false, version: 0 };
      states.push(row);
    }
    for (const f of fields) {
      const v = params[`p_${f}`];
      if (typeof v === 'boolean') {
        row[f] = v;
        row[`${f}_at`] = v ? new Date().toISOString() : null;
      }
    }
    // Mirror the pin exclusivity the DB trigger enforces.
    if (params.p_pinned === true) {
      row.done = false;
      row.hidden = false;
    }
    // Server-assigned monotonic version bump (mirrors the 0003 trigger).
    row.version = ((row.version as number | undefined) ?? 0) + 1;
    return { data: row, error: null };
  }

  if (name === 'reorder_subscriptions') {
    // Atomic reorder (0017): set each named subscription's sort to its position.
    const feedIds = (params.p_feed_ids ?? []) as string[];
    feedIds.forEach((feedId, i) => {
      const s = subByFeed.get(feedId);
      if (s) s.sort = i;
    });
    return { data: null, error: null };
  }

  if (name === 'subscribe_to_feed') {
    // Find-or-create by the public address (the fake matches on site_url), then
    // subscribe; returns the feeds_public row (setof → array).
    const url = String(params.p_url ?? '');
    const folder = (params.p_folder ?? null) as string | null;
    const feedsPublic = (store.feeds_public ??= []);
    let row = feedsPublic.find((r) => r.site_url === url);
    if (!row) {
      let id = 'feed-new';
      for (let n = 2; feedsPublic.some((r) => r.id === id); n++) id = `feed-new-${n}`;
      row = {
        id, site_url: url, title: url, error_count: 0, last_error: null,
        last_fetched_at: null, next_fetch_at: null, fetch_interval_s: 1800, created_at: null,
      };
      feedsPublic.push(row);
    }
    if (!subs.some((s) => s.feed_id === row!.id)) {
      const sort = subs.reduce((m, s) => Math.max(m, Number(s.sort ?? 0)), -1) + 1;
      subs.push({ feed_id: row.id, folder, title_override: null, muted: false, sort });
    }
    return { data: [row], error: null };
  }

  if (name === 'feed_unread_counts') {
    // Per-feed unread count: subscribed-feed items that are not Done, active
    // Hidden, or active Opened (each TTL'd at 30 days). Like this fake's
    // feed_items, it omits the window/floor bound — valid for the small seeds
    // tests use (every item is within the per-feed floor), and consistent with
    // the mock's count for those seeds.
    const wanted = new Set((params.p_feed_ids ?? []) as string[]);
    const activeFlag = (st: Row | undefined, flag: string, at: string) =>
      Boolean(st?.[flag]) &&
      typeof st?.[at] === 'string' &&
      Date.now() - Date.parse(st[at] as string) <= TTL_MS;
    const counts = new Map<string, number>();
    for (const id of wanted) counts.set(id, 0);
    for (const it of items) {
      const fid = it.feed_id as string;
      if (!wanted.has(fid) || !subByFeed.has(fid)) continue;
      const st = stateByItem.get(it.id as string);
      // A pinned item always counts (a pin is a to-do, read or not); other
      // items drop out once Done, active Hidden, or active Opened.
      if (
        activeFlag(st, 'done', 'done_at') ||
        activeFlag(st, 'hidden', 'hidden_at') ||
        (!st?.pinned && activeFlag(st, 'opened', 'opened_at'))
      ) {
        continue;
      }
      counts.set(fid, (counts.get(fid) ?? 0) + 1);
    }
    return {
      data: [...counts].map(([feed_id, n]) => ({ feed_id, n })),
      error: null,
    };
  }

  const scope = params.p_scope as string;
  const folder = (params.p_folder ?? null) as string | null;
  const feedId = (params.p_feed_id ?? null) as string | null;
  const inScope = (feed_id: unknown): boolean => {
    const s = subByFeed.get(feed_id as string);
    if (!s) return false;
    if (scope === 'home') return !s.muted;
    if (scope === 'folder') return !s.muted && (s.folder ?? null) === folder;
    if (scope === 'feed') return feed_id === feedId;
    return false;
  };
  const sortMs = (it: Row) =>
    Date.parse(String(it.published_at ?? it.created_at ?? '')) || 0;
  const pinMs = (it: Row) => {
    const st = stateByItem.get(it.id as string);
    return st?.pinned_at ? Date.parse(String(st.pinned_at)) : Infinity;
  };
  const idDesc = (a: Row, b: Row) => (String(a.id) < String(b.id) ? 1 : String(a.id) > String(b.id) ? -1 : 0);

  if (name === 'feed_items') {
    const limit = Math.max(Number(params.p_limit ?? 30), 0);
    const offset = Math.max(Number(params.p_offset ?? 0), 0);
    // Mirror 0016_feed_items_sort_group.sql: p_sort flips the body order;
    // p_group_by_feed sections by the subscription `sort` with each feed's
    // pinned items at the top of its section (flat keeps a global pinned top).
    const sortAsc = params.p_sort === 'oldest';
    const groupByFeed = Boolean(params.p_group_by_feed);
    // Grouping only: cap each feed's section to its newest this-many rows (0021).
    const perFeedLimit =
      groupByFeed && params.p_per_feed_limit != null
        ? Math.max(Number(params.p_per_feed_limit), 0)
        : null;
    const hiddenActive = (st: Row | undefined) =>
      Boolean(st?.hidden) &&
      typeof st?.hidden_at === 'string' &&
      Date.now() - Date.parse(st.hidden_at) <= TTL_MS; // Hidden expires after the TTL
    const isPinned = (it: Row) => Boolean(stateByItem.get(it.id as string)?.pinned);
    const feedSort = (it: Row) =>
      Number(subByFeed.get(it.feed_id as string)?.sort ?? Number.POSITIVE_INFINITY);
    const combined = items
      .filter((it) => inScope(it.feed_id))
      .filter((it) => {
        // Pinned rows are kept regardless; the body drops Done/active-Hidden.
        if (isPinned(it)) return true;
        const st = stateByItem.get(it.id as string);
        return !(st && (st.done || hiddenActive(st)));
      })
      .sort((a, b) => {
        if (groupByFeed) {
          const fa = feedSort(a);
          const fb = feedSort(b);
          if (fa !== fb) return fa - fb;
          // Tie on the sort ordinal → keep each feed's rows contiguous by id
          // (mirrors 0021's feed_id tiebreak in the final ORDER BY), so a section
          // never splits into interleaved runs.
          if (a.feed_id !== b.feed_id) {
            return String(a.feed_id) < String(b.feed_id) ? -1 : 1;
          }
        }
        const pa = isPinned(a);
        const pb = isPinned(b);
        if (pa !== pb) return pa ? -1 : 1;
        if (pa) return pinMs(a) - pinMs(b) || idDesc(a, b); // oldest pin first
        const d = sortMs(a) - sortMs(b);
        return (sortAsc ? d : -d) || idDesc(a, b);
      });
    // Per-feed window: combined is already sectioned by feed (contiguous), so
    // keep each feed run's first `perFeedLimit` rows. Mirrors 0021's row_number
    // partition-by-feed cap.
    const windowed =
      perFeedLimit != null
        ? (() => {
            const seen = new Map<string, number>();
            const out: Row[] = [];
            for (const it of combined) {
              const fid = it.feed_id as string;
              const n = seen.get(fid) ?? 0;
              if (n >= perFeedLimit) continue;
              seen.set(fid, n + 1);
              out.push(it);
            }
            return out;
          })()
        : combined;
    return {
      data: windowed.slice(offset, offset + limit),
      error: null,
    };
  }
  return { data: null, error: { message: `unknown rpc ${name}` } };
}

export function makeFakeSupabase(tables: FakeTables): {
  client: {
    from: (table: string) => FakeQuery;
    rpc: (name: string, params?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;
    functions: { invoke: (name: string, opts?: { body?: unknown }) => Promise<{ data: unknown; error: unknown }> };
  };
  store: FakeTables;
  invokeCalls: InvokeCall[];
  invokeResult: { current: { data: unknown; error: unknown } };
  /** Make the next `select` on `table` return an error once (transient-failure
   * simulation). */
  failSelectOnce: (table: string) => void;
  /** Make `.not('…','in',…)` a no-op, simulating the server-side exclusion filter
   * being skipped (exclusion set over the cap). */
  ignoreNotInFilter: () => void;
  /** Cap every `select` on `table` to `n` rows, modeling PostgREST's max-rows
   * response ceiling (so a paged read must `.range()` past it to see everything). */
  capRows: (table: string, n: number) => void;
  /** Number of `select` requests issued against `table` (proves `in (…)`
   * chunking — N batches => N requests). */
  selectCount: (table: string) => number;
  /** Every `.rpc(name, params)` call, in order (for asserting write-through). */
  rpcCalls: Array<{ name: string; params: Record<string, unknown> }>;
} {
  const store: FakeTables = {};
  for (const [k, v] of Object.entries(tables)) store[k] = v.map((r) => ({ ...r }));
  const invokeCalls: InvokeCall[] = [];
  const rpcCalls: Array<{ name: string; params: Record<string, unknown> }> = [];
  const invokeResult = { current: { data: null as unknown, error: null as unknown } };
  const control = {
    failSelectOnce: new Set<string>(),
    ignoreNotIn: false,
    selectCounts: new Map<string, number>(),
    maxRows: new Map<string, number>(),
  };

  return {
    store,
    invokeCalls,
    rpcCalls,
    invokeResult,
    failSelectOnce: (table: string) => control.failSelectOnce.add(table),
    ignoreNotInFilter: () => {
      control.ignoreNotIn = true;
    },
    capRows: (table: string, n: number) => control.maxRows.set(table, n),
    selectCount: (table: string) => control.selectCounts.get(table) ?? 0,
    client: {
      from: (table: string) => new FakeQuery(table, store, control),
      rpc: (name: string, params?: Record<string, unknown>) => ({
        then: <R1, R2>(
          onF?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
          onR?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
        ) => Promise.resolve(runRpc(store, rpcCalls, name, params ?? {})).then(onF, onR),
      }),
      functions: {
        invoke: async (name: string, opts?: { body?: unknown }) => {
          invokeCalls.push({ name, body: opts?.body });
          return invokeResult.current;
        },
      },
    },
  };
}
