/* Live tests of the database and domain-checkout actions against https://kleap.co.
 *   KLEAP_TEST_KEY_FILE=… KLEAP_DB_APP_ID=104139 KLEAP_DB_TABLE=n8n_e2e_leads npm run test:live-db
 * Only touches rows it inserts itself (email activepieces-e2e@example.com) and deletes them at the end.
 * KLEAP_CHECKOUT_DOMAIN=… also creates ONE Stripe checkout session (never opened, never paid). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, describe, it } from 'node:test';
import { dropdownOptions, makeContext, memoryStore, runAction, trigger } from './harness';

const KEY = (process.env.KLEAP_API_KEY ?? readFileSync(process.env.KLEAP_TEST_KEY_FILE ?? '', 'utf8')).trim();
const APP = process.env.KLEAP_DB_APP_ID ?? '104139';
const TABLE = process.env.KLEAP_DB_TABLE ?? 'n8n_e2e_leads';
const EMAIL = 'activepieces-e2e@example.com';
const log = (label: string, value: unknown) => console.log(`[live-db] ${label}: ${JSON.stringify(value)}`);

describe('live: database', () => {
  const insertedIds: unknown[] = [];
  const store = memoryStore();
  const triggerCtx = makeContext(KEY, { app_id: APP, table: TABLE, order_by: 'created_at', id_column: 'id' }, store);

  after(async () => {
    // Safety net: remove anything this run inserted, even if an assertion failed midway.
    for (const id of insertedIds) {
      try {
        await runAction('delete_rows', KEY, { app_id: APP, table: TABLE, where: { id, email: EMAIL } });
      } catch {
        /* already deleted */
      }
    }
  });

  it('schema + table dropdown', async () => {
    const schema = await runAction('get_database_schema', KEY, { app_id: APP });
    const table = schema.tables.find((t: any) => t.name === TABLE);
    assert.ok(table, `table ${TABLE} in schema`);
    log('schema', { provisioned: schema.provisioned, tables: schema.tables.length, columns: table.columns.map((c: any) => `${c.name}:${c.type}${c.primary_key ? ':pk' : ''}`), row_count: table.row_count });
    const opts = await dropdownOptions('find_rows', 'table', KEY, { app_id: APP });
    assert.ok(opts.options.some((o: any) => o.value === TABLE));
    log('table dropdown', opts.options.map((o: any) => o.label));
  });

  it('New Database Row trigger: enable → insert → run sees it once', async () => {
    const t = trigger('new_database_row');
    await t.onEnable(triggerCtx);
    log('trigger lastItem after enable', store.data.get('lastItem') ?? null);

    const ins = await runAction('insert_rows', KEY, { app_id: APP, table: TABLE, rows: { email: EMAIL } });
    assert.equal(ins.inserted, 1);
    const row = ins.rows[0];
    insertedIds.push(row.id);
    assert.equal(row.status, 'new', 'column default applied');
    log('insert', { inserted: ins.inserted, row });

    const first = (await t.run(triggerCtx)) as any[];
    const mine = first.filter((r) => String(r.id) === String(row.id));
    assert.equal(mine.length, 1, 'new row emitted once');
    const second = (await t.run(triggerCtx)) as any[];
    assert.equal(second.filter((r) => String(r.id) === String(row.id)).length, 0, 'not emitted again');
    log('trigger runs', { first_run_ids: first.map((r) => r.id), second_run_ids: second.map((r) => r.id) });
    const sample = (await t.test(triggerCtx)) as any[];
    assert.ok(sample.length >= 1 && sample.length <= 5);
  });

  it('find rows (where), update, run SQL, delete', async () => {
    const id = insertedIds[0];
    const found = await runAction('find_rows', KEY, { app_id: APP, table: TABLE, where: { email: EMAIL }, order_by: 'created_at', order: 'desc', limit: 10 });
    assert.ok(found.rows.some((r: any) => String(r.id) === String(id)));
    log('find rows', { count: found.rows.length, has_more: found.has_more, truncated: found.truncated ?? false });

    const upd = await runAction('update_rows', KEY, { app_id: APP, table: TABLE, where: { id, email: EMAIL }, set: { status: 'contacted' } });
    assert.equal(upd.updated, 1);
    assert.equal(upd.rows[0].status, 'contacted');
    log('update', { updated: upd.updated, status: upd.rows[0].status });

    const count = await runAction('run_sql', KEY, { app_id: APP, sql: `SELECT count(*) FROM ${TABLE}` });
    log('run sql count', count);
    assert.equal(count.command, 'SELECT');
    const byParam = await runAction('run_sql', KEY, { app_id: APP, sql: `SELECT id, status FROM ${TABLE} WHERE email = $1`, params: [EMAIL] });
    assert.ok(byParam.rows.some((r: any) => String(r.id) === String(id) && r.status === 'contacted'));
    await assert.rejects(runAction('run_sql', KEY, { app_id: APP, sql: 'EXPLAIN SELECT 1' }), (e: Error) => {
      log('unsupported statement', e.message);
      return /^UNSUPPORTED_STATEMENT: /.test(e.message);
    });
    await assert.rejects(runAction('update_rows', KEY, { app_id: APP, table: TABLE, where: {}, set: { status: 'x' } }), /non-empty/);

    const del = await runAction('delete_rows', KEY, { app_id: APP, table: TABLE, where: { id, email: EMAIL } });
    assert.equal(del.deleted, 1);
    insertedIds.length = 0;
    const gone = await runAction('find_rows', KEY, { app_id: APP, table: TABLE, where: { email: EMAIL } });
    assert.equal(gone.rows.filter((r: any) => String(r.id) === String(id)).length, 0);
    log('delete', { deleted: del.deleted, remaining_mine: gone.rows.length });
  });
});

describe('live: buy domain (one checkout session)', { skip: !process.env.KLEAP_CHECKOUT_DOMAIN }, () => {
  it('returns a Stripe checkout_url and does not charge', async () => {
    const out = await runAction('buy_domain', KEY, { domain: process.env.KLEAP_CHECKOUT_DOMAIN, years: 1 });
    const url = new URL(out.checkout_url);
    log('checkout', { host: url.host, domain: out.domain, years: out.years, price: out.price, currency: out.currency, expires_at: out.expires_at, payment_required: out.payment_required });
    assert.equal(url.host, 'checkout.stripe.com');
    assert.equal(out.payment_required, true);
  });
});
