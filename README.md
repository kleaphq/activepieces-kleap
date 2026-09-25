# Kleap piece for Activepieces

[Kleap](https://kleap.co) is an AI builder for websites, web apps and internal tools. This piece lets an
Activepieces flow create, edit and publish Kleap sites with AI, edit their files, read their leads,
analytics and database, and buy or connect domains.

It covers the whole Kleap MCP surface plus the app database and domain checkout, on the
[Kleap public API v1](https://kleap.co/api/v1/openapi.json).

## Authentication

API key (`PieceAuth.SecretText`). Create it on kleap.co → **Settings → API key** with the **Full** preset.
The connection is validated with `GET /account/credits`.

Keys created before the database and domain-checkout scopes existed get
`INSUFFICIENT_SCOPE`; the piece then tells the user to create a new key with the Full preset.

## Triggers (polling, `pollingHelper`)

| Trigger | Dedupe | Notes |
|---|---|---|
| New Form Submission | `LAST_ITEM` on submission `id` | App dropdown. No history replay on enable. Fields flattened to the top level with `submission_id`, `submitted_at`, `app_id`. |
| New App | `TIMEBASED` on `created_at` | |
| New Database Row | `LAST_ITEM` on the id column | App + table dropdowns (the table list refreshes with the app). Sorted by `created_at` desc by default. |

## Actions

- **Apps and AI**: Create App, Edit App With AI, Get Task, Retry Task, Publish App, Get Publish Status, Get App,
  List Apps, Find App (by URL, domain or slug), Rename App, Wake App, Get Screenshot, Get Chat History, Generate Image
- **Files**: List Files, Read Files, Write File (text or binary `ApFile`, sent base64), Edit File, Delete Files
- **Leads and insights**: List Form Submissions, Get Analytics, Get Search Console, Connect Search Console, Get Credits
- **Domains**: Search Domains, Check Domain, Connect Domain, Buy Domain
- **Database**: Get Database Schema, Find Rows, Insert Rows, Update Rows, Delete Rows, Run SQL
- **Custom API Call** (`createCustomApiCallAction`, base URL `https://kleap.co/api/v1`, bearer injected)

Behaviour worth knowing:

- **Create App / Edit App With AI** start a task of 1 to 5 minutes. With **Wait for Completion** on (the default),
  the step long-polls `GET /tasks/{id}?wait=50` until the task completes or fails. If the timeout passes, the step
  returns the task with `wait_timed_out: true`, and a later **Get Task** step can pick it up. The timeout
  defaults to 9 minutes and is capped at 20. Keep it under your instance's flow timeout: `AP_FLOW_TIMEOUT_SECONDS`
  is 600 s by default. **Publish When Done** (off by default) publishes the site and waits until it is live.
- **Publish App**: if a deploy is already running, the API answers `409 CONFLICT`. The step then follows that
  deploy through its `deploy_key` instead of failing.
- **Buy Domain does not charge anyone.** It calls `POST /domains/checkout` and returns a Stripe `checkout_url`.
  The domain is registered only after someone pays on that link. Send the link to the payer, then follow
  the domain with **Check Domain**.
- **Database**: an app without a database answers `DATABASE_NOT_PROVISIONED`. Add one by asking the AI to
  "add a database" with **Edit App With AI**. Update Rows and Delete Rows refuse an empty `Where`.
- **Errors**: every error is shown as `CODE: message`, followed by the details and the request id. When the API
  answers `429 RATE_LIMITED` (30 requests per minute on the standard tier), the step waits `retry_after` and
  retries, at most twice.
- Every call sends `User-Agent: kleap-activepieces`. Creations and messages carry
  `metadata: {source: "activepieces", flow_id, run_id}`.

## Layout

```
src/index.ts                 createPiece (auth, 35 actions, 3 triggers)
src/lib/auth.ts              PieceAuth.SecretText + validate
src/lib/common/client.ts     HTTP client, error formatting, long-poll helpers, 429 retry
src/lib/common/props.ts      app / table dropdowns, wait and task option props
src/lib/common/task.ts       wait-then-publish tail shared by Create / Edit
src/lib/actions/*.ts         apps, tasks, files, insights, domains, database
src/lib/triggers/index.ts    polling triggers
monorepo/                    package.json / tsconfig / eslint as the activepieces monorepo expects them
scripts/                     bundle (npm), metadata check, export to the monorepo
test/unit.test.ts            offline tests (nock)
test/live.test.ts            tests against https://kleap.co
```

## Development

```bash
npm install
npm run build          # tsc → dist/ (types of @activepieces/pieces-framework 0.32.0 / pieces-common 0.12.5)
npm test               # offline: every action and trigger against nock mocks
npm run metadata       # loads dist/ through the framework and prints piece.metadata()
KLEAP_TEST_KEY_FILE=/path/to/key npm run test:live                      # read-only, no credits
KLEAP_TEST_KEY_FILE=/path/to/key KLEAP_LIVE_BUILD=1 npm run test:live   # + creates ONE app and publishes it
```

The source only imports `@activepieces/pieces-framework` and `@activepieces/pieces-common`, never
`@activepieces/shared`, which the monorepo's lint rules forbid. It compiles and runs both against the latest
npm releases (framework 0.32.0, common 0.12.5) and against the monorepo's current workspace sources
(framework 0.40.0, common 0.14.0).

## Option 1: contribute to the Activepieces monorepo (public piece)

```bash
git clone https://github.com/<you>/activepieces.git && cd activepieces   # your fork
git checkout -b feat/kleap-piece
node /path/to/activepieces-kleap/scripts/export-to-monorepo.mjs .
#   → packages/pieces/community/kleap/{src, package.json, tsconfig*.json, .eslintrc.json}
#   → adds "@activepieces/piece-kleap" to tsconfig.base.json paths
```

Then follow the monorepo's own workflow:

1. Install the monorepo dependencies, then run `npm run dev` with `AP_DEV_PIECES=kleap` in
   `packages/server/api/.env`, and test the piece in the local builder.
2. Lint and build: `npx eslint packages/pieces/community/kleap/src` and
   `npm run build` inside `packages/pieces/community/kleap`.
3. Open a PR against `activepieces/activepieces` `main` titled **feat(kleap): add Kleap piece**. When it is
   merged, the Activepieces CI publishes `@activepieces/piece-kleap` to npm, and the piece appears on
   cloud.activepieces.com.

`logoUrl` is `https://kleap.co/icon.png`, which answers 200 with `image/png`. Maintainers may ask to mirror it
to `https://cdn.activepieces.com/pieces/kleap.png`.

## Option 2: private npm package, installed in a self-hosted instance

The npm package is bundled the way the Activepieces CLI does it. It is a single `src/index.js` built by esbuild
(node20, cjs, minified, `keepNames`), with the framework inlined and no runtime dependencies.

```bash
npm run bundle                 # → dist/npm/{package.json, src/index.js, README.md, LICENSE}
cd dist/npm
npm login                      # an account with access to the @kleap scope
npm publish --access restricted   # private package; use --access public to share it with everyone
```

Install it on your instance:

- **Community edition**: go to **Settings → My Pieces → Install Piece**, choose **npm**, and enter
  `@kleap/piece-kleap` with its version. The instance needs read access to the registry. For a private package,
  set the registry token in the environment of the Activepieces container (`.npmrc`/`NPM_CONFIG_*`).
- **Platform (enterprise)**: go to **Platform Admin → Setup → Pieces → Install Piece**. Either give the npm package
  name, or upload the tarball from `npm pack` in `dist/npm`.

The framework sets the minimum supported Activepieces release. With framework 0.32.0 it is 0.82.0, so use
Activepieces 0.82 or later.

## License

MIT
