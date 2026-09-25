import { HttpMethod } from '@activepieces/pieces-common';
import { createAction, Property } from '@activepieces/pieces-framework';
import { kleapAuth } from '../auth';
import { JsonObject, kleapRequest, parseJsonInput, requireWhere, resolveAppId } from '../common/client';
import { appDropdown, tableDropdown } from '../common/props';

const tablePath = (appId: string, table: string) =>
  `/apps/${appId}/database/tables/${encodeURIComponent(String(table).trim())}/rows`;

const whereProp = (required: boolean) =>
  Property.Json({
    displayName: 'Where',
    description: required
      ? 'Column equalities that select the rows, e.g. {"id": 42} or {"status": "new"}. Required and non-empty.'
      : 'Optional column equalities, e.g. {"status": "new"}.',
    required,
  });

export const getDatabaseSchema = createAction({
  auth: kleapAuth,
  name: 'get_database_schema',
  displayName: 'Get Database Schema',
  description:
    'Lists the tables of the app\'s Kleap Database with their columns and row counts. Apps without a database answer DATABASE_NOT_PROVISIONED.',
  props: { app_id: appDropdown() },
  async run(context) {
    const appId = await resolveAppId(context.auth, context.propsValue.app_id);
    return kleapRequest(context.auth, HttpMethod.GET, `/apps/${appId}/database`);
  },
});

export const findRows = createAction({
  auth: kleapAuth,
  name: 'find_rows',
  displayName: 'Find Rows',
  description:
    'Reads rows from a table, with optional equality filters, sorting and pagination. At most 5 MB per call: check has_more / truncated and page with Offset.',
  props: {
    app_id: appDropdown(),
    table: tableDropdown(),
    where: whereProp(false),
    order_by: Property.ShortText({ displayName: 'Order By', description: 'Column name, e.g. created_at.', required: false }),
    order: Property.StaticDropdown({
      displayName: 'Order',
      required: false,
      defaultValue: 'desc',
      options: {
        options: [
          { label: 'Descending', value: 'desc' },
          { label: 'Ascending', value: 'asc' },
        ],
      },
    }),
    limit: Property.Number({ displayName: 'Limit', description: 'Up to 500.', required: false, defaultValue: 100 }),
    offset: Property.Number({ displayName: 'Offset', required: false, defaultValue: 0 }),
  },
  async run(context) {
    const p = context.propsValue;
    const appId = await resolveAppId(context.auth, p.app_id);
    const where = parseJsonInput<JsonObject>(p.where, 'Where');
    return kleapRequest(context.auth, HttpMethod.GET, tablePath(appId, p.table), {
      query: {
        limit: Math.min(500, Math.max(1, Number(p.limit ?? 100))),
        offset: Number(p.offset ?? 0) || undefined,
        order_by: p.order_by?.trim() || undefined,
        order: p.order_by?.trim() ? p.order || 'desc' : undefined,
        where: where && Object.keys(where).length ? JSON.stringify(where) : undefined,
      },
    });
  },
});

export const insertRows = createAction({
  auth: kleapAuth,
  name: 'insert_rows',
  displayName: 'Insert Rows',
  description: 'Inserts one row (a JSON object) or several (a JSON array, 500 max). Returns the inserted rows.',
  props: {
    app_id: appDropdown(),
    table: tableDropdown(),
    rows: Property.Json({
      displayName: 'Rows',
      description: 'A JSON object for one row, or an array of objects, e.g. [{"name": "Ada", "email": "ada@example.com"}]',
      required: true,
    }),
  },
  async run(context) {
    const p = context.propsValue;
    const appId = await resolveAppId(context.auth, p.app_id);
    const parsed = parseJsonInput<JsonObject | JsonObject[]>(p.rows, 'Rows');
    const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    if (!rows.length) throw new Error('Give at least one row.');
    if (rows.length > 500) throw new Error(`At most 500 rows per call (got ${rows.length}).`);
    return kleapRequest(context.auth, HttpMethod.POST, tablePath(appId, p.table), { body: { rows } });
  },
});

export const updateRows = createAction({
  auth: kleapAuth,
  name: 'update_rows',
  displayName: 'Update Rows',
  description: 'Updates the rows matching "Where" with the values in "Set". Returns the updated rows.',
  props: {
    app_id: appDropdown(),
    table: tableDropdown(),
    where: whereProp(true),
    set: Property.Json({
      displayName: 'Set',
      description: 'Columns to change, e.g. {"status": "contacted"}',
      required: true,
    }),
  },
  async run(context) {
    const p = context.propsValue;
    const appId = await resolveAppId(context.auth, p.app_id);
    const where = requireWhere(p.where);
    const set = parseJsonInput<JsonObject>(p.set, 'Set');
    if (!set || typeof set !== 'object' || Array.isArray(set) || !Object.keys(set).length) {
      throw new Error('"Set" must be a non-empty JSON object, e.g. {"status": "contacted"}.');
    }
    return kleapRequest(context.auth, HttpMethod.PATCH, tablePath(appId, p.table), { body: { where, set } });
  },
});

export const deleteRows = createAction({
  auth: kleapAuth,
  name: 'delete_rows',
  displayName: 'Delete Rows',
  description: 'Deletes the rows matching "Where" (required, non-empty). Returns how many were deleted.',
  props: {
    app_id: appDropdown(),
    table: tableDropdown(),
    where: whereProp(true),
  },
  async run(context) {
    const p = context.propsValue;
    const appId = await resolveAppId(context.auth, p.app_id);
    const where = requireWhere(p.where);
    return kleapRequest(context.auth, HttpMethod.DELETE, tablePath(appId, p.table), { body: { where } });
  },
});

export const runSql = createAction({
  auth: kleapAuth,
  name: 'run_sql',
  displayName: 'Run SQL',
  description:
    'Runs SQL on the app\'s Postgres database with owner rights (needs the database:write scope, even for a SELECT). Accepts a query, INSERT/UPDATE/DELETE/MERGE or DDL; not EXPLAIN, SHOW, COPY or CALL. Results are capped at 500 rows / 5 MB (truncated: true). Use $1, $2… placeholders with Parameters.',
  props: {
    app_id: appDropdown(),
    sql: Property.LongText({
      displayName: 'SQL',
      description: 'e.g. SELECT * FROM leads WHERE status = $1 ORDER BY created_at DESC LIMIT 20',
      required: true,
    }),
    params: Property.Json({
      displayName: 'Parameters',
      description: 'Optional JSON array of values for $1, $2…, e.g. ["new"]',
      required: false,
    }),
  },
  async run(context) {
    const p = context.propsValue;
    const appId = await resolveAppId(context.auth, p.app_id);
    const sql = (p.sql ?? '').trim();
    if (!sql) throw new Error('The SQL is empty.');
    const params = parseJsonInput<unknown[]>(p.params, 'Parameters');
    if (params !== undefined && !Array.isArray(params)) throw new Error('Parameters must be a JSON array, e.g. ["new", 42].');
    const body: JsonObject = { sql };
    if (params?.length) body['params'] = params;
    return kleapRequest(context.auth, HttpMethod.POST, `/apps/${appId}/database/query`, { body, timeoutMs: 120_000 });
  },
});
