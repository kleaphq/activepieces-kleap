/* Live tests against https://kleap.co. The API key is read from the file named by
 * KLEAP_TEST_KEY_FILE (or KLEAP_API_KEY) and is never printed.
 *   npm run test:live                       read-only checks (no credits spent)
 *   KLEAP_LIVE_BUILD=1 npm run test:live    + creates ONE app, edits files, publishes, checks the public URL
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { ApFile } from '@activepieces/pieces-framework';
import { dropdownOptions, makeContext, memoryStore, runAction, trigger, validateAuth } from './harness';

const KEY = (process.env.KLEAP_API_KEY ?? readFileSync(process.env.KLEAP_TEST_KEY_FILE ?? '', 'utf8')).trim();
const log = (label: string, value: unknown) => console.log(`[live] ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`);

async function httpStatus(url: string) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
  const body = Buffer.from(await res.arrayBuffer());
  return { status: res.status, type: res.headers.get('content-type'), body };
}

describe('live: read-only', () => {
  let target: any;

  it('auth validate (good key, bad key)', async () => {
    assert.deepEqual(await validateAuth(KEY), { valid: true });
    const bad = await validateAuth('kleap_live_sk_00000000000000000000000000000000');
    assert.equal(bad.valid, false);
    log('bad key error', bad.error);
    assert.match(bad.error, /^[A-Z_]+: /);
  });

  it('get credits', async () => {
    const credits = await runAction('get_credits', KEY, {});
    log('credits', credits);
    assert.equal(typeof credits.credits_balance, 'number');
  });

  it('list apps + app dropdown', async () => {
    const out = await runAction('list_apps', KEY, { limit: 120 });
    assert.ok(out.apps.length > 100, 'paginates past 100');
    target = out.apps.find((a: any) => a.production_url) ?? out.apps[0];
    log('list apps', { count: out.count, total: out.total, target: { id: target.id, production_url: target.production_url } });
    const opts = await dropdownOptions('get_app', 'app_id', KEY, {}, String(target.name).slice(0, 6));
    assert.ok(opts.options.some((o: any) => o.value === String(target.id)));
  });

  it('get app, find app by URL, app locator by URL', async () => {
    const app = await runAction('get_app', KEY, { app_id: String(target.id) });
    assert.equal(app.id, target.id);
    const found = await runAction('find_app', KEY, { query: target.production_url });
    assert.equal(found.app_id, target.id);
    const viaUrl = await runAction('get_app', KEY, { app_id: target.production_url });
    assert.equal(viaUrl.id, target.id);
    log('find app', { query: target.production_url, app_id: found.app_id });
  });

  it('list + read files', async () => {
    const list = await runAction('list_files', KEY, { app_id: String(target.id) });
    const page = list.files.find((f: any) => f.path === 'src/pages/index.astro') ?? list.files[0];
    const read = await runAction('read_files', KEY, { app_id: String(target.id), paths: `${page.path}, does/not/exist.txt` });
    assert.equal(read.files[0].path, page.path);
    assert.deepEqual(read.missing, ['does/not/exist.txt']);
    log('read files', { files: list.files.length, read: page.path, bytes: read.files[0].bytes });
  });

  it('forms, analytics, publish status, chat history, search console', async () => {
    const forms = await runAction('list_form_submissions', KEY, { app_id: String(target.id), limit: 5, flatten: true });
    const analytics = await runAction('get_analytics', KEY, { app_id: String(target.id), period: '30d' });
    const status = await runAction('get_publish_status', KEY, { app_id: String(target.id) });
    const history = await runAction('get_chat_history', KEY, { app_id: String(target.id), limit: 3 });
    assert.ok(Array.isArray(forms.submissions));
    assert.ok(['published', 'running', 'queued', 'not_published'].includes(status.status));
    let searchConsole: unknown;
    try {
      searchConsole = Object.keys(await runAction('get_search_console', KEY, { app_id: String(target.id) }));
    } catch (e) {
      searchConsole = (e as Error).message;
    }
    log('insights', {
      submissions: forms.count,
      analytics_keys: Object.keys(analytics),
      publish_status: status.status,
      report: !!status.report,
      messages: (history.messages ?? []).length,
      search_console: searchConsole,
    });
  });

  it('search + check domains', async () => {
    const res = await runAction('search_domains', KEY, { query: 'Café Lumière Lausanne', tlds: 'ch, com' });
    assert.ok(Array.isArray(res.results) && res.results.length > 0);
    log('domains', res.results.map((d: any) => `${d.domain}:${d.status}:${d.price}`));
    // Check Domain reports on domains registered through Kleap; a free domain is NOT_FOUND.
    await assert.rejects(runAction('check_domain', KEY, { domain: res.results[0].domain }), (e: Error) => {
      log('check domain (unregistered)', e.message);
      return /^NOT_FOUND: /.test(e.message);
    });
  });

  it('triggers on real data: New Form Submission and New App', async () => {
    const forms = trigger('new_form_submission');
    const store = memoryStore();
    const ctx = makeContext(KEY, { app_id: String(target.id), flatten: true }, store);
    const sample = (await forms.test(ctx)) as unknown[];
    await forms.onEnable(ctx);
    const first = (await forms.run(ctx)) as unknown[];
    assert.deepEqual(first, [], 'no backfill after enable');
    const apps = trigger('new_app');
    const actx = makeContext(KEY, {}, memoryStore());
    const appSample = (await apps.test(actx)) as any[];
    await apps.onEnable(actx);
    assert.deepEqual(await apps.run(actx), []);
    assert.ok(appSample.length > 0 && appSample.length <= 5);
    log('triggers', { form_test_items: sample.length, form_last_item: store.data.get('lastItem') ?? null, new_app_test_items: appSample.length });
  });

  it('error path: an app that is not ours', async () => {
    await assert.rejects(runAction('get_app', KEY, { app_id: '1' }), (e: Error) => {
      log('foreign app error', e.message);
      return /^[A-Z_]+: /.test(e.message);
    });
  });
});

describe('live: build ONE app', { skip: process.env.KLEAP_LIVE_BUILD !== '1' }, () => {
  const marker = `activepieces-e2e-${Date.now()}`;
  const state: any = {};

  it('create app, wait for the AI', { timeout: 20 * 60_000 }, async () => {
    const started = Date.now();
    // Other integrations may create their test app on the same key at the same time, and the API allows
    // 2 concurrent creations per user: on 429 (concurrent_active) or 503 SERVICE_BUSY, wait and retry
    // (nothing was created, and the idempotency key guarantees a single app anyway).
    const create = () => runAction('create_app', KEY, {
      prompt:
        'A one-page website for "Atelier Test Activepieces", a small pottery studio in Lausanne: hero, three classes with prices, and a contact form. Keep it simple.',
      visibility: 'personal',
      wait_for_completion: true,
      timeout_minutes: 15,
      publish_when_done: false,
      idempotency_key: marker,
    });
    let out: any;
    for (let attempt = 1; ; attempt++) {
      try {
        out = await create();
        break;
      } catch (e) {
        const busy = /^(RATE_LIMITED|SERVICE_BUSY)|HTTP (429|503)/.test((e as Error).message);
        if (!busy || Date.now() - started > 15 * 60_000) throw e;
        log(`create busy (attempt ${attempt}), retrying in 90 s`, (e as Error).message);
        await new Promise((r) => setTimeout(r, 90_000));
      }
    }
    state.appId = String(out.app_id);
    state.taskId = out.task_id;
    log('create app', {
      app_id: out.app_id,
      task_id: out.task_id,
      status: out.status,
      wait_timed_out: out.wait_timed_out ?? false,
      preview_url: out.preview_url,
      credits_charged: out.result?.credits_charged,
      seconds: Math.round((Date.now() - started) / 1000),
    });
    assert.equal(out.status, 'completed');
  });

  it('get task, rename, wake', async () => {
    const task = await runAction('get_task', KEY, { task_id: state.taskId });
    assert.equal(task.status, 'completed');
    const renamed = await runAction('rename_app', KEY, { app_id: state.appId, name: 'Activepieces e2e (Kleap piece)' });
    log('rename', renamed);
    try {
      log('wake', await runAction('wake_app', KEY, { app_id: state.appId }));
    } catch (e) {
      log('wake (non-blocking)', (e as Error).message);
    }
  });

  it('write text + binary, edit, read back, delete', async () => {
    const w1 = await runAction('write_file', KEY, { app_id: state.appId, path: 'public/activepieces-e2e.txt', content: `${marker} v1\n` });
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    state.png = png;
    const w2 = await runAction('write_file', KEY, { app_id: state.appId, path: 'public/activepieces-e2e.png', file: new ApFile('e2e.png', png, 'png') });
    await runAction('write_file', KEY, { app_id: state.appId, path: 'public/activepieces-delete-me.txt', content: 'delete me' });
    const edit = await runAction('edit_file', KEY, {
      app_id: state.appId,
      path: 'public/activepieces-e2e.txt',
      old_string: `${marker} v1`,
      new_string: `${marker} v2`,
    });
    const del = await runAction('delete_files', KEY, { app_id: state.appId, paths: 'public/activepieces-delete-me.txt' });
    const read = await runAction('read_files', KEY, {
      app_id: state.appId,
      paths: 'public/activepieces-e2e.txt, public/activepieces-delete-me.txt',
    });
    assert.equal(read.files[0].content.trim(), `${marker} v2`);
    assert.deepEqual(read.missing, ['public/activepieces-delete-me.txt']);
    log('files', { write_text: w1, write_binary: w2, edit, delete: del, missing_after_delete: read.missing });
  });

  it('publish, wait until live, verify the public URL', { timeout: 20 * 60_000 }, async () => {
    const started = Date.now();
    const pub = await runAction('publish_app', KEY, { app_id: state.appId, wait_for_live: true, timeout_minutes: 15 });
    log('publish', {
      status: pub.status,
      production_url: pub.production_url,
      deploy_key: pub.deploy_key,
      report_verdict: pub.report?.verdict ?? null,
      seconds: Math.round((Date.now() - started) / 1000),
    });
    assert.equal(pub.status, 'published');
    const base = String(pub.production_url).replace(/\/$/, '');
    const home = await httpStatus(base);
    const txt = await httpStatus(`${base}/activepieces-e2e.txt`);
    const img = await httpStatus(`${base}/activepieces-e2e.png`);
    const gone = await httpStatus(`${base}/activepieces-delete-me.txt`);
    log('public URL', {
      home: `${home.status} ${home.type}`,
      txt: `${txt.status} ${txt.body.toString().trim()}`,
      png: `${img.status} ${img.type} ${img.body.length}B identical=${img.body.equals(state.png)}`,
      deleted_file: gone.status,
    });
    assert.equal(home.status, 200);
    assert.equal(txt.status, 200);
    assert.equal(txt.body.toString().trim(), `${marker} v2`);
    assert.equal(img.status, 200);
    assert.ok(img.body.equals(state.png));
    assert.notEqual(gone.status, 200);

    const status = await runAction('get_publish_status', KEY, { app_id: state.appId });
    assert.equal(status.status, 'published');
    const found = await runAction('find_app', KEY, { query: base });
    assert.equal(String(found.app_id), state.appId);
    const newApps = (await trigger('new_app').test(makeContext(KEY, {}, memoryStore()))) as any[];
    assert.ok(newApps.some((a) => String(a.id) === state.appId), 'New App trigger sees the created app');
  });
});
