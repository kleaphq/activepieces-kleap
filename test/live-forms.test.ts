/* Live test of the New Form Submission trigger with a real visitor submission.
 *   KLEAP_TEST_KEY_FILE=… KLEAP_FORM_APP_ID=105810 KLEAP_FORM_ORIGIN=https://atelier-nord.kleap.io npm run test:live-forms
 * Submits ONE lead to https://form.kleap.co exactly like the site's contact form does. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { makeContext, memoryStore, runAction, trigger } from './harness';

const KEY = (process.env.KLEAP_API_KEY ?? readFileSync(process.env.KLEAP_TEST_KEY_FILE ?? '', 'utf8')).trim();
const APP = process.env.KLEAP_FORM_APP_ID ?? '105810';
const ORIGIN = process.env.KLEAP_FORM_ORIGIN ?? 'https://atelier-nord.kleap.io';
const log = (label: string, value: unknown) => console.log(`[live-forms] ${label}: ${JSON.stringify(value)}`);

describe('live: New Form Submission', () => {
  it('enable → real visitor submission → emitted once, flattened → nothing on the next run', async () => {
    const t = trigger('new_form_submission');
    const store = memoryStore();
    const ctx = makeContext(KEY, { app_id: APP, flatten: true }, store);
    await t.onEnable(ctx);
    log('lastItem after enable', store.data.get('lastItem') ?? null);

    const email = `activepieces-lead-${Date.now()}@example.com`;
    const form = new FormData();
    form.set('app_id', APP);
    form.set('form_id', 'contact');
    form.set('form_name', 'Prendre contact');
    form.set('name', 'Activepieces E2E');
    form.set('email', email);
    form.set('message', 'Live test of the Kleap piece for Activepieces.');
    const res = await fetch('https://form.kleap.co', { method: 'POST', body: form, headers: { Origin: ORIGIN } });
    const body = (await res.json()) as { success?: boolean };
    log('visitor submission', { status: res.status, body });
    assert.equal(res.status, 200);
    assert.equal(body.success, true);

    const first = (await t.run(ctx)) as any[];
    const mine = first.filter((s) => s.email === email);
    log('first run', { emitted: first.length, mine: mine[0] });
    assert.equal(mine.length, 1, 'emitted once');
    assert.equal(mine[0].app_id, Number(APP));
    assert.equal(mine[0].name, 'Activepieces E2E');
    assert.ok(mine[0].submission_id && mine[0].submitted_at, 'submission_id + submitted_at at top level');
    assert.equal(mine[0].data, undefined, 'fields flattened, no nested data');

    const second = (await t.run(ctx)) as any[];
    log('second run', { emitted: second.length });
    assert.equal(second.filter((s) => s.email === email).length, 0);

    const list = await runAction('list_form_submissions', KEY, { app_id: APP, limit: 5, flatten: true });
    assert.ok(list.submissions.some((s: any) => s.email === email));
    log('list form submissions', { count: list.count, first: Object.keys(list.submissions[0]) });
  });
});
