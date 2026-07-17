// Generic in-memory Supabase fake for Phase 4 unit tests. Supports the exact
// PostgREST query chains used by the entitlement/billing/lifecycle code:
// filter builders (eq/neq/is/not/lt/gt/or), select/maybeSingle/single/limit,
// thenable execution, update/insert/upsert/delete, unique-key violations
// (23505) for idempotency tests, and head counts.

function clone(row) {
  return JSON.parse(JSON.stringify(row));
}

function parseOrExpression(expr) {
  // e.g. "expires_at.is.null,expires_at.gt.2026-01-01T00:00:00.000Z"
  return String(expr).split(',').map((part) => {
    const [col, op, ...rest] = part.split('.');
    return { col, op, value: rest.join('.') };
  });
}

function matchesFilter(row, f) {
  switch (f.kind) {
    case 'eq': return row[f.col] === f.value;
    case 'neq': return row[f.col] !== f.value;
    case 'is': return f.value === null ? row[f.col] == null : row[f.col] === f.value;
    case 'not_is': return f.value === null ? row[f.col] != null : row[f.col] !== f.value;
    case 'lt': return row[f.col] != null && row[f.col] < f.value;
    case 'gt': return row[f.col] != null && row[f.col] > f.value;
    case 'in': return f.values.includes(row[f.col]);
    case 'or':
      return f.conditions.some((c) => {
        if (c.op === 'is' && c.value === 'null') return row[c.col] == null;
        if (c.op === 'gt') return row[c.col] != null && row[c.col] > c.value;
        if (c.op === 'eq') return String(row[c.col]) === c.value;
        throw new Error(`fakeSupabase: unsupported or() op ${c.op}`);
      });
    default:
      throw new Error(`fakeSupabase: unknown filter ${f.kind}`);
  }
}

/**
 * @param {Record<string, { rows?: object[], unique?: string[] }>} tableConfig
 */
export function createFakeSupabase(tableConfig = {}) {
  const tables = new Map();
  for (const [name, cfg] of Object.entries(tableConfig)) {
    tables.set(name, {
      rows: (cfg.rows || []).map(clone),
      unique: cfg.unique || []
    });
  }

  function getTable(name) {
    if (!tables.has(name)) {
      tables.set(name, { rows: [], unique: [] });
    }
    return tables.get(name);
  }

  function makeQuery(tableName, mode, payload = null, options = {}) {
    const state = {
      filters: [],
      selectCols: null,
      count: null,
      head: false,
      order: null,
      limitN: null
    };

    function filteredRows() {
      const table = getTable(tableName);
      return table.rows.filter((row) => state.filters.every((f) => matchesFilter(row, f)));
    }

    function violatesUnique(table, row, ignoreRow = null) {
      for (const key of table.unique) {
        if (row[key] == null) continue;
        const dup = table.rows.find((r) => r !== ignoreRow && r[key] === row[key]);
        if (dup) return key;
      }
      return null;
    }

    function execute() {
      const table = getTable(tableName);
      if (mode === 'select') {
        if (state.head && state.count) {
          return { data: null, error: null, count: filteredRows().length };
        }
        let rows = filteredRows().map(clone);
        if (state.limitN != null) rows = rows.slice(0, state.limitN);
        return { data: rows, error: null };
      }
      if (mode === 'update') {
        const matched = filteredRows();
        for (const row of matched) Object.assign(row, payload);
        return { data: matched.map(clone), error: null };
      }
      if (mode === 'delete') {
        const matched = new Set(filteredRows());
        table.rows = table.rows.filter((r) => !matched.has(r));
        return { data: null, error: null };
      }
      if (mode === 'insert') {
        const rows = Array.isArray(payload) ? payload : [payload];
        const inserted = [];
        for (const row of rows) {
          const violation = violatesUnique(table, row);
          if (violation) {
            return {
              data: null,
              error: { code: '23505', message: `duplicate key value violates unique constraint "${tableName}_${violation}_key"` }
            };
          }
          const copy = clone(row);
          table.rows.push(copy);
          inserted.push(copy);
        }
        return { data: inserted.map(clone), error: null };
      }
      if (mode === 'upsert') {
        const rows = Array.isArray(payload) ? payload : [payload];
        const conflictCols = String(options.onConflict || '').split(',').map((s) => s.trim()).filter(Boolean);
        const upserted = [];
        for (const row of rows) {
          const existing = conflictCols.length
            ? table.rows.find((r) => conflictCols.every((c) => r[c] === row[c]))
            : null;
          if (existing) {
            if (!options.ignoreDuplicates) Object.assign(existing, row);
            upserted.push(clone(existing));
          } else {
            const copy = clone(row);
            table.rows.push(copy);
            upserted.push(clone(copy));
          }
        }
        return { data: upserted, error: null };
      }
      throw new Error(`fakeSupabase: unknown mode ${mode}`);
    }

    const query = {
      select(cols, opts = {}) {
        state.selectCols = cols;
        if (opts.count) state.count = opts.count;
        if (opts.head) state.head = true;
        if (mode !== 'select') {
          // update/insert/upsert ... .select() — return rows on execute
          const inner = execute();
          return {
            maybeSingle: async () => {
              if (inner.error) return inner;
              return { data: inner.data?.[0] ?? null, error: null };
            },
            single: async () => {
              if (inner.error) return inner;
              if (!inner.data?.[0]) return { data: null, error: { message: 'no rows returned' } };
              return { data: inner.data[0], error: null };
            },
            then(resolve) {
              resolve(inner);
            }
          };
        }
        return query;
      },
      eq(col, value) { state.filters.push({ kind: 'eq', col, value }); return query; },
      neq(col, value) { state.filters.push({ kind: 'neq', col, value }); return query; },
      is(col, value) { state.filters.push({ kind: 'is', col, value }); return query; },
      not(col, op, value) {
        if (op !== 'is') throw new Error('fakeSupabase: only not(col, "is", v) supported');
        state.filters.push({ kind: 'not_is', col, value });
        return query;
      },
      lt(col, value) { state.filters.push({ kind: 'lt', col, value }); return query; },
      gt(col, value) { state.filters.push({ kind: 'gt', col, value }); return query; },
      in(col, values) {
        state.filters.push({ kind: 'in', col, values: values || [] });
        if (mode === 'delete' || mode === 'update') return Promise.resolve(execute());
        return query;
      },
      or(expr) { state.filters.push({ kind: 'or', conditions: parseOrExpression(expr) }); return query; },
      order() { return query; },
      limit(n) {
        state.limitN = n;
        const result = execute();
        return Promise.resolve(result);
      },
      range: async () => execute(),
      maybeSingle: async () => {
        const result = execute();
        if (result.error) return result;
        return { data: result.data?.[0] ?? null, error: null };
      },
      single: async () => {
        const result = execute();
        if (result.error) return result;
        if (!result.data?.[0]) return { data: null, error: { message: 'no rows returned' } };
        return { data: result.data[0], error: null };
      },
      then(resolve) {
        resolve(execute());
      }
    };
    return query;
  }

  const client = {
    from(tableName) {
      return {
        select: (cols, opts) => makeQuery(tableName, 'select').select(cols, opts),
        update: (values) => makeQuery(tableName, 'update', values),
        insert: (values) => makeQuery(tableName, 'insert', values),
        upsert: (values, options) => makeQuery(tableName, 'upsert', values, options),
        delete: () => makeQuery(tableName, 'delete')
      };
    },
    _tables: tables,
    rows(tableName) {
      return getTable(tableName).rows;
    }
  };

  return client;
}
