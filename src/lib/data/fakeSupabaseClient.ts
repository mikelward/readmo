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
    private readonly control: { failSelectOnce: Set<string> },
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

  private sorted(rows: Row[]): Row[] {
    if (this.orders.length === 0) return rows;
    return [...rows].sort((a, b) => {
      for (const { col, ascending, nullsFirst } of this.orders) {
        const av = a[col];
        const bv = b[col];
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

export function makeFakeSupabase(tables: FakeTables): {
  client: {
    from: (table: string) => FakeQuery;
    functions: { invoke: (name: string, opts?: { body?: unknown }) => Promise<{ data: unknown; error: unknown }> };
  };
  store: FakeTables;
  invokeCalls: InvokeCall[];
  invokeResult: { current: { data: unknown; error: unknown } };
  /** Make the next `select` on `table` return an error once (transient-failure
   * simulation). */
  failSelectOnce: (table: string) => void;
} {
  const store: FakeTables = {};
  for (const [k, v] of Object.entries(tables)) store[k] = v.map((r) => ({ ...r }));
  const invokeCalls: InvokeCall[] = [];
  const invokeResult = { current: { data: null as unknown, error: null as unknown } };
  const control = { failSelectOnce: new Set<string>() };

  return {
    store,
    invokeCalls,
    invokeResult,
    failSelectOnce: (table: string) => control.failSelectOnce.add(table),
    client: {
      from: (table: string) => new FakeQuery(table, store, control),
      functions: {
        invoke: async (name: string, opts?: { body?: unknown }) => {
          invokeCalls.push({ name, body: opts?.body });
          return invokeResult.current;
        },
      },
    },
  };
}
