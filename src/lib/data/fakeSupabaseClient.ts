// A minimal in-memory stand-in for the supabase-js client, just enough to drive
// SupabaseDataSource's read/write surface in tests: the PostgREST query-builder
// chain used by the data source (select/in/not/eq/ilike/order/range/limit/
// maybeSingle, plus update/delete) and functions.invoke. NOT a faithful
// PostgREST emulation — it applies the same filters the data source issues so we
// can assert mapping, ordering, filtering, pagination, and dispatch.

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
    if (this.single) {
      return { data: out[0] ?? null, count, error: null };
    }
    return { data: out, count, error: null };
  }
}

/** Emulate the feed_items / pinned_feed_items RPCs (0006_feed_rpcs.sql) against
 * the seeded tables: drive from subscriptions, LEFT JOIN item_state, order by
 * sort_at (= published_at ?? created_at), exclude Done/Hidden/Pinned from the
 * body, and surface Pinned (oldest-first) for the prepend. */
function runRpc(
  store: FakeTables,
  name: string,
  params: Record<string, unknown>,
): { data: unknown; error: unknown } {
  const items = store.items ?? [];
  const subs = store.subscriptions ?? [];
  const states = store.item_state ?? [];
  const subByFeed = new Map(subs.map((s) => [s.feed_id, s]));
  const stateByItem = new Map(states.map((s) => [s.item_id, s]));

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
  const idCmp = (a: Row, b: Row, dir: 1 | -1) => {
    const av = String(a.id);
    const bv = String(b.id);
    return av < bv ? -dir : av > bv ? dir : 0;
  };

  if (name === 'feed_items') {
    const limit = Math.max(Number(params.p_limit ?? 30), 0);
    const offset = Math.max(Number(params.p_offset ?? 0), 0);
    const filtered = items
      .filter((it) => {
        if (!inScope(it.feed_id)) return false;
        const st = stateByItem.get(it.id as string);
        return !(st && (st.pinned || st.done || st.hidden));
      })
      .sort((a, b) => sortMs(b) - sortMs(a) || idCmp(a, b, -1)); // sort_at desc, id desc
    const total = filtered.length;
    return {
      data: filtered
        .slice(offset, offset + limit)
        .map((it) => ({ item: it, total_count: total })),
      error: null,
    };
  }
  if (name === 'pinned_feed_items') {
    const pinAt = (it: Row) => {
      const st = stateByItem.get(it.id as string);
      return st?.pinned_at ? Date.parse(String(st.pinned_at)) : Infinity; // nulls last
    };
    const pinned = items
      .filter((it) => {
        if (!inScope(it.feed_id)) return false;
        const st = stateByItem.get(it.id as string);
        return Boolean(st && st.pinned);
      })
      .sort((a, b) => pinAt(a) - pinAt(b) || idCmp(a, b, 1)); // pinned_at asc, id asc
    return { data: pinned, error: null };
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
  /** Number of `select` requests issued against `table` (proves `in (…)`
   * chunking — N batches => N requests). */
  selectCount: (table: string) => number;
} {
  const store: FakeTables = {};
  for (const [k, v] of Object.entries(tables)) store[k] = v.map((r) => ({ ...r }));
  const invokeCalls: InvokeCall[] = [];
  const invokeResult = { current: { data: null as unknown, error: null as unknown } };
  const control = {
    failSelectOnce: new Set<string>(),
    ignoreNotIn: false,
    selectCounts: new Map<string, number>(),
  };

  return {
    store,
    invokeCalls,
    invokeResult,
    failSelectOnce: (table: string) => control.failSelectOnce.add(table),
    ignoreNotInFilter: () => {
      control.ignoreNotIn = true;
    },
    selectCount: (table: string) => control.selectCounts.get(table) ?? 0,
    client: {
      from: (table: string) => new FakeQuery(table, store, control),
      rpc: (name: string, params?: Record<string, unknown>) => ({
        then: <R1, R2>(
          onF?: ((v: { data: unknown; error: unknown }) => R1 | PromiseLike<R1>) | null,
          onR?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
        ) => Promise.resolve(runRpc(store, name, params ?? {})).then(onF, onR),
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
