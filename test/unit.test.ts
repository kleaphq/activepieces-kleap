/* Offline tests: every HTTP call is answered by nock, no network. Covers the routes that are not
 * live yet (database, /domains/checkout) and the control flow (long-poll, 409 publish, dedupe). */
import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import nock from 'nock';
import { ApFile } from '@activepieces/pieces-framework';
import { pollDelay, rateLimitPolicy } from '../src/lib/common/client';
import { dropdownOptions, makeContext, memoryStore, piece, runAction, trigger, validateAuth } from './harness';

const KEY = 'kleap_live_sk_test_0000000000000000';
const API = 'https://kleap.co';
const V1 = '/api/v1';
const auth = { reqheaders: { authorization: `Bearer ${KEY}`, 'user-agent': 'kleap-activepieces' } };
const api = () => nock(API, auth);
const err = (code: string, message: string, details: Record<string, unknown> = {}) => ({
  error: { code, message, details, request_id: 'req_test' },
});

before(() => {
  nock.disableNetConnect();
  pollDelay.ms = 1;
  rateLimitPolicy.unitMs = 1;
});
afterEach(() => {
  const pending = nock.pendingMocks();
  nock.cleanAll();
  assert.deepEqual(pending, [], `unused mocks: ${pending.join(', ')}`);
});
after(() => nock.enableNetConnect());

describe('piece definition', () => {
  it('builds its metadata through the framework', () => {
    const meta = piece.metadata();
    assert.equal(meta.displayName, 'Kleap');
    assert.equal(meta.logoUrl, 'https://kleap.co/icon.png');
    assert.equal(Object.keys(meta.actions).length, 35);
    assert.deepEqual(Object.keys(meta.triggers).sort(), ['new_app', 'new_database_row', 'new_form_submission']);
    for (const t of Object.values(meta.triggers)) assert.equal(t.type, 'POLLING');
  });
});

describe('auth', () => {
  it('validates through GET /account/credits', async () => {
    api().get(`${V1}/account/credits`).reply(200, { credits_balance: 10, is_paid: false });
    assert.deepEqual(await validateAuth(KEY), { valid: true });
  });

  it('shows CODE: message on an invalid key', async () => {
    api().get(`${V1}/account/credits`).reply(401, err('UNAUTHORIZED', 'Invalid API key'));
    const res = await validateAuth(KEY);
    assert.equal(res.valid, false);
    assert.match(res.error, /^UNAUTHORIZED: Invalid API key/);
  });
});

describe('errors', () => {
  it('tells an old key to use the Full preset on INSUFFICIENT_SCOPE', async () => {
    api().get(`${V1}/apps/7/database`).reply(403, err('INSUFFICIENT_SCOPE', 'Missing scope', { required_scope: 'database:read' }));
    await assert.rejects(runAction('get_database_schema', KEY, { app_id: '7' }), (e: Error) => {
      assert.match(e.message, /^INSUFFICIENT_SCOPE: Missing scope/);
      assert.match(e.message, /database:read/);
      assert.match(e.message, /Create a new API key with the Full preset/);
      return true;
    });
  });

  it('points to "add a database" on DATABASE_NOT_PROVISIONED', async () => {
    api().get(`${V1}/apps/7/database`).reply(409, err('DATABASE_NOT_PROVISIONED', 'No database'));
    await assert.rejects(runAction('get_database_schema', KEY, { app_id: '7' }), /add a database/);
  });
});

describe('rate limit', () => {
  it('waits retry_after and retries on 429 RATE_LIMITED, then gives up', async () => {
    const limited = err('RATE_LIMITED', 'Rate limit exceeded.', { retry_after: 2, tier: 'standard' });
    api().get(`${V1}/account/credits`).reply(429, limited);
    api().get(`${V1}/account/credits`).reply(200, { credits_balance: 1, is_paid: false });
    assert.equal((await runAction('get_credits', KEY, {})).credits_balance, 1);
    api().post(`${V1}/apps`).reply(503, err('SERVICE_BUSY', 'Busy', { retry_after: 1 }));
    api().post(`${V1}/apps`).reply(429, err('RATE_LIMITED', 'Too many concurrent creations', { concurrent_active: 2 }));
    api().post(`${V1}/apps`).reply(201, { task_id: 't', app_id: 1 });
    assert.equal((await runAction('create_app', KEY, { prompt: 'x', wait_for_completion: false })).app_id, 1);
    api().get(`${V1}/account/credits`).times(3).reply(429, limited);
    await assert.rejects(runAction('get_credits', KEY, {}), /^Error: RATE_LIMITED|RATE_LIMITED: Rate limit exceeded/);
  });
});

describe('app resolution', () => {
  it('resolves a site URL through /apps/resolve', async () => {
    api().get(`${V1}/apps/resolve`).query({ q: 'https://cafe.kleap.io' }).reply(200, { app_id: 42 });
    api().get(`${V1}/apps/42`).reply(200, { id: 42, name: 'Café' });
    const app = await runAction('get_app', KEY, { app_id: 'https://cafe.kleap.io' });
    assert.equal(app.id, 42);
  });

  it('app dropdown lists apps and searches', async () => {
    api()
      .get(`${V1}/apps`)
      .query({ limit: '100', q: 'caf' })
      .reply(200, { apps: [{ id: 42, name: 'Café' }], pagination: { has_more: false } });
    const res = await dropdownOptions('get_app', 'app_id', KEY, {}, 'caf');
    assert.deepEqual(res.options, [{ label: 'Café (#42)', value: '42' }]);
    const noAuth = await dropdownOptions('get_app', 'app_id', undefined);
    assert.equal(noAuth.disabled, true);
  });
});

describe('create / edit / tasks / publish', () => {
  it('creates, waits through the long-poll, then publishes (following a running deploy on 409)', async () => {
    let createBody: any;
    api()
      .post(`${V1}/apps`, (b) => ((createBody = b), true))
      .reply(201, { task_id: 'task_1', app_id: 42, chat_id: 'c', build_url: 'b', poll_url: 'p' });
    api().get(`${V1}/tasks/task_1`).query({ wait: '50' }).reply(200, { task_id: 'task_1', status: 'running' });
    api()
      .get(`${V1}/tasks/task_1`)
      .query({ wait: '50' })
      .reply(200, {
        task_id: 'task_1',
        status: 'completed',
        app_id: 42,
        result: { preview_url: 'https://kleap.co/app/42', production_url: null, files_changed: ['a'], credits_charged: 5 },
      });
    api().post(`${V1}/apps/42/publish`).reply(409, err('CONFLICT', 'Deploy running', { deploy_key: 'dk_1' }));
    api().get(`${V1}/apps/42/publish`).query({ wait: '45', deploy_key: 'dk_1' }).reply(200, { status: 'running' });
    api()
      .get(`${V1}/apps/42/publish`)
      .query({ wait: '45', deploy_key: 'dk_1' })
      .reply(200, { status: 'published', production_url: 'https://cafe.kleap.io', report: { verdict: 'ok' } });

    const out = await runAction('create_app', KEY, {
      prompt: '  A café site  ',
      visibility: 'personal',
      wait_for_completion: true,
      timeout_minutes: 5,
      publish_when_done: true,
      idempotency_key: 'idem-1',
    });
    assert.deepEqual(createBody, {
      prompt: 'A café site',
      visibility: 'personal',
      idempotency_key: 'idem-1',
      metadata: { source: 'activepieces', flow_id: 'flow_test', run_id: 'run_test' },
    });
    assert.equal(out.status, 'completed');
    assert.equal(out.production_url, 'https://cafe.kleap.io');
    assert.equal(out.publish.status, 'published');
    assert.equal(out.publish.deploy_key, 'dk_1');
  });

  it('returns immediately when "wait" is off', async () => {
    api().post(`${V1}/apps/42/messages`).reply(202, { task_id: 'task_2', message_id: 'm', preview_url: 'pv', poll_url: 'p' });
    const out = await runAction('edit_app_with_ai', KEY, { app_id: '42', message: 'Add a pricing page', wait_for_completion: false });
    assert.deepEqual(out, { app_id: 42, task_id: 'task_2', message_id: 'm', preview_url: 'pv', poll_url: 'p' });
  });

  it('throws CODE: message when the task fails', async () => {
    api().post(`${V1}/apps/42/messages`).reply(202, { task_id: 'task_3' });
    api()
      .get(`${V1}/tasks/task_3`)
      .query(true)
      .reply(200, { task_id: 'task_3', status: 'failed', error: { code: 'GENERATION_FAILED', message: 'Model error' } });
    await assert.rejects(
      runAction('edit_app_with_ai', KEY, { app_id: '42', message: 'x', timeout_minutes: 1 }),
      /GENERATION_FAILED Model error.*Retry Task/,
    );
  });

  it('returns wait_timed_out when the deadline passes', async () => {
    api().get(`${V1}/tasks/task_4`).query({ wait: '0' }).reply(200, { task_id: 'task_4', status: 'running' });
    const out = await runAction('get_task', KEY, { task_id: 'task_4', wait_for_completion: true, timeout_minutes: 0 });
    assert.equal(out.wait_timed_out, true);
  });

  it('get task reads once by default; retry task waits for the new task', async () => {
    api().get(`${V1}/tasks/task_5`).reply(200, { task_id: 'task_5', status: 'running' });
    assert.equal((await runAction('get_task', KEY, { task_id: 'task_5' })).status, 'running');
    api().post(`${V1}/tasks/task_5/retry`).reply(201, { task_id: 'task_6' });
    api().get(`${V1}/tasks/task_6`).query(true).reply(200, { task_id: 'task_6', status: 'completed' });
    const out = await runAction('retry_task', KEY, { task_id: 'task_5', wait_for_completion: true, timeout_minutes: 1 });
    assert.equal(out.status, 'completed');
  });
});

describe('files', () => {
  it('writes a binary ApFile as base64', async () => {
    let body: any;
    api().put(`${V1}/apps/42/files`, (b) => ((body = b), true)).reply(200, { written: 1 });
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    await runAction('write_file', KEY, { app_id: '42', path: 'public/logo.png', file: new ApFile('logo.png', png, 'png') });
    assert.deepEqual(body, { files: [{ path: 'public/logo.png', content: png.toString('base64'), encoding: 'base64' }] });
  });

  it('refuses a file above 512 KB before sending it', async () => {
    const big = new ApFile('big.png', Buffer.alloc(512 * 1024 + 1), 'png');
    await assert.rejects(runAction('write_file', KEY, { app_id: '42', path: 'public/big.png', file: big }), /512 KB/);
  });

  it('reads, edits and deletes with the contract bodies', async () => {
    api().get(`${V1}/apps/42/files`).query({ paths: 'a.astro,b.json' }).reply(200, { files: [], missing: ['b.json'] });
    await runAction('read_files', KEY, { app_id: '42', paths: 'a.astro,\n b.json' });
    let edit: any;
    api().patch(`${V1}/apps/42/files`, (b) => ((edit = b), true)).reply(200, {});
    await runAction('edit_file', KEY, { app_id: '42', path: 'a.astro', old_string: 'x', new_string: 'y' });
    assert.deepEqual(edit, { edits: [{ path: 'a.astro', old_string: 'x', new_string: 'y', replace_all: false }] });
    let del: any;
    api().delete(`${V1}/apps/42/files`, (b) => ((del = b), true)).reply(200, { deleted: 2 });
    await runAction('delete_files', KEY, { app_id: '42', paths: 'a.astro, b.json' });
    assert.deepEqual(del, { paths: ['a.astro', 'b.json'] });
  });
});

describe('domains', () => {
  it('normalises the search query and the extensions', async () => {
    let body: any;
    api().post(`${V1}/domains/search`, (b) => ((body = b), true)).reply(200, { results: [] });
    await runAction('search_domains', KEY, { query: ' Café Lumière ', tlds: 'com, .ch' });
    assert.deepEqual(body, { query: 'cafelumiere', tlds: ['.com', '.ch'] });
  });

  it('buy domain returns a checkout_url the user must pay', async () => {
    let body: any;
    api()
      .post(`${V1}/domains/checkout`, (b) => ((body = b), true))
      .reply(201, {
        checkout_url: 'https://checkout.stripe.com/c/pay/cs_test',
        domain: 'cafelumiere.com',
        years: 2,
        price: 14.99,
        currency: 'usd',
        expires_at: '2026-09-26T00:00:00Z',
      });
    const out = await runAction('buy_domain', KEY, { domain: 'https://CafeLumiere.com/', years: 2, app_id: '42' });
    assert.deepEqual(body, { domain: 'cafelumiere.com', years: 2, app_id: 42 });
    assert.equal(out.checkout_url, 'https://checkout.stripe.com/c/pay/cs_test');
    assert.equal(out.payment_required, true);
    assert.match(out.next_step, /pay/);
  });

  it('buy domain surfaces INSUFFICIENT_SCOPE for older keys', async () => {
    api()
      .post(`${V1}/domains/checkout`)
      .reply(403, err('INSUFFICIENT_SCOPE', 'Missing scope', { required_scope: 'domains:checkout' }));
    await assert.rejects(runAction('buy_domain', KEY, { domain: 'a.com' }), /Full preset/);
  });
});

describe('database', () => {
  const rowsPath = `${V1}/apps/42/database/tables/leads/rows`;

  it('schema + table dropdown', async () => {
    const schema = {
      provisioned: true,
      tables: [{ name: 'leads', row_count: 3, columns: [{ name: 'id', type: 'integer', nullable: false, default: null, primary_key: true }] }],
    };
    api().get(`${V1}/apps/42/database`).reply(200, schema);
    assert.deepEqual(await runAction('get_database_schema', KEY, { app_id: '42' }), schema);
    api().get(`${V1}/apps/42/database`).reply(200, schema);
    const opts = await dropdownOptions('find_rows', 'table', KEY, { app_id: '42' });
    assert.deepEqual(opts.options, [{ label: 'leads (3 rows)', value: 'leads' }]);
    api().get(`${V1}/apps/43/database`).reply(409, err('DATABASE_NOT_PROVISIONED', 'No database'));
    const none = await dropdownOptions('find_rows', 'table', KEY, { app_id: '43' });
    assert.equal(none.disabled, true);
    assert.match(none.placeholder, /add a database/);
  });

  it('find rows sends where as JSON, order and pagination', async () => {
    api()
      .get(rowsPath)
      .query({ limit: '10', offset: '20', order_by: 'created_at', order: 'asc', where: '{"status":"new"}' })
      .reply(200, { table: 'leads', rows: [{ id: 1 }], limit: 10, offset: 20, has_more: false });
    const out = await runAction('find_rows', KEY, {
      app_id: '42',
      table: 'leads',
      where: { status: 'new' },
      order_by: 'created_at',
      order: 'asc',
      limit: 10,
      offset: 20,
    });
    assert.equal(out.rows.length, 1);
  });

  it('insert accepts one object or an array', async () => {
    let body: any;
    api().post(rowsPath, (b) => ((body = b), true)).reply(201, { table: 'leads', inserted: 1, rows: [{ id: 9 }] });
    await runAction('insert_rows', KEY, { app_id: '42', table: 'leads', rows: { name: 'Ada' } });
    assert.deepEqual(body, { rows: [{ name: 'Ada' }] });
    api().post(rowsPath, (b) => ((body = b), true)).reply(201, { table: 'leads', inserted: 2, rows: [] });
    await runAction('insert_rows', KEY, { app_id: '42', table: 'leads', rows: '[{"name":"A"},{"name":"B"}]' });
    assert.equal(body.rows.length, 2);
  });

  it('update and delete refuse an empty where before calling the API', async () => {
    await assert.rejects(runAction('update_rows', KEY, { app_id: '42', table: 'leads', where: {}, set: { a: 1 } }), /non-empty/);
    await assert.rejects(runAction('delete_rows', KEY, { app_id: '42', table: 'leads', where: undefined }), /non-empty/);
    let body: any;
    api().patch(rowsPath, (b) => ((body = b), true)).reply(200, { table: 'leads', updated: 1, rows: [] });
    await runAction('update_rows', KEY, { app_id: '42', table: 'leads', where: { id: 1 }, set: { status: 'done' } });
    assert.deepEqual(body, { where: { id: 1 }, set: { status: 'done' } });
    api().delete(rowsPath, (b) => ((body = b), true)).reply(200, { table: 'leads', deleted: 1 });
    const del = await runAction('delete_rows', KEY, { app_id: '42', table: 'leads', where: '{"id":1}' });
    assert.deepEqual(body, { where: { id: 1 } });
    assert.equal(del.deleted, 1);
  });

  it('run sql passes params and surfaces RLS_REQUIRED', async () => {
    let body: any;
    api()
      .post(`${V1}/apps/42/database/query`, (b) => ((body = b), true))
      .reply(200, { command: 'SELECT', row_count: 1, rows: [{ n: 1 }] });
    await runAction('run_sql', KEY, { app_id: '42', sql: 'select $1::int as n', params: [1] });
    assert.deepEqual(body, { sql: 'select $1::int as n', params: [1] });
    api().post(`${V1}/apps/42/database/query`).reply(422, err('RLS_REQUIRED', 'Enable RLS on public.t'));
    await assert.rejects(runAction('run_sql', KEY, { app_id: '42', sql: 'create table t(id int)' }), /^Error: RLS_REQUIRED|RLS_REQUIRED: Enable RLS/);
  });
});

describe('triggers', () => {
  it('New Form Submission: no backfill on enable, then only new ids, flattened', async () => {
    const t = trigger('new_form_submission');
    const store = memoryStore();
    const ctx = makeContext(KEY, { app_id: '42', flatten: true }, store);
    const s = (id: number, at: string) => ({ id, submitted_at: at, data: { email: `u${id}@x.co` } });

    api().get(`${V1}/apps/42/forms`).query({ limit: '100' }).reply(200, { submissions: [s(2, '2026-09-25T02:00:00Z'), s(1, '2026-09-25T01:00:00Z')] });
    await t.onEnable(ctx);
    assert.equal(store.data.get('lastItem'), 2);

    api().get(`${V1}/apps/42/forms`).query({ limit: '100' }).reply(200, { submissions: [s(4, 'b'), s(3, 'a'), s(2, 'x'), s(1, 'y')] });
    const fresh = (await t.run(ctx)) as any[];
    assert.deepEqual(fresh.map((f) => f.submission_id), [4, 3]);
    assert.deepEqual(fresh[0], { email: 'u4@x.co', submission_id: 4, submitted_at: 'b', app_id: 42 });

    api().get(`${V1}/apps/42/forms`).query({ limit: '100' }).reply(200, { submissions: [s(4, 'b'), s(3, 'a')] });
    assert.deepEqual(await t.run(ctx), []);

    api().get(`${V1}/apps/42/forms`).query({ limit: '100' }).reply(200, { submissions: [1, 2, 3, 4, 5, 6, 7].map((i) => s(i, 'z')) });
    assert.equal(((await t.test(ctx)) as any[]).length, 5);
  });

  it('New App: time-based on created_at', async () => {
    const t = trigger('new_app');
    const store = memoryStore();
    const ctx = makeContext(KEY, {}, store);
    await t.onEnable(ctx);
    const enabledAt = store.data.get('lastPoll') as number;
    const iso = (ms: number) => new Date(ms).toISOString();
    api()
      .get(`${V1}/apps`)
      .query({ limit: '100' })
      .reply(200, { apps: [{ id: 2, created_at: iso(enabledAt + 1000) }, { id: 1, created_at: iso(enabledAt - 60_000) }] });
    const fresh = (await t.run(ctx)) as any[];
    assert.deepEqual(fresh.map((a) => a.id), [2]);
    api()
      .get(`${V1}/apps`)
      .query({ limit: '100' })
      .reply(200, { apps: [{ id: 2, created_at: iso(enabledAt + 1000) }] });
    assert.deepEqual(await t.run(ctx), []);
  });

  it('New Database Row: sorts by created_at desc and dedupes on id', async () => {
    const t = trigger('new_database_row');
    const store = memoryStore();
    const ctx = makeContext(KEY, { app_id: '42', table: 'leads', order_by: 'created_at', id_column: 'id' }, store);
    const q = { order_by: 'created_at', order: 'desc', limit: '100' };
    api().get(`${V1}/apps/42/database/tables/leads/rows`).query(q).reply(200, { rows: [{ id: 10 }, { id: 9 }] });
    await t.onEnable(ctx);
    api().get(`${V1}/apps/42/database/tables/leads/rows`).query(q).reply(200, { rows: [{ id: 12 }, { id: 11 }, { id: 10 }] });
    assert.deepEqual(((await t.run(ctx)) as any[]).map((r) => r.id), [12, 11]);
    api().get(`${V1}/apps/42/database/tables/leads/rows`).query(q).reply(200, { rows: [{ uuid: 'x' }] });
    await assert.rejects(t.run(ctx), /ID Column/);
  });
});

describe('custom API call', () => {
  it('injects the bearer key on a relative path', async () => {
    api().get(`${V1}/account/credits`).reply(200, { credits_balance: 3 });
    const out = await runAction('custom_api_call', KEY, {
      url: { url: '/account/credits' },
      method: 'GET',
      headers: {},
      queryParams: {},
      body_type: 'none',
      body: {},
      failsafe: false,
    });
    assert.equal((out as any).body.credits_balance, 3);
  });
});
