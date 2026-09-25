// Loads the compiled piece through the real framework and prints / validates its metadata,
// the same object Activepieces reads when it installs a piece (no server needed).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const entry = process.argv[2] ?? '../dist/src/index.js';
const mod = require(new URL(entry, import.meta.url).pathname);
const piece = mod.kleap ?? Object.values(mod).find((v) => v && typeof v.metadata === 'function');
const meta = piece.metadata();
const actions = Object.values(meta.actions);
const triggers = Object.values(meta.triggers);
const problems = [];
for (const a of [...actions, ...triggers]) {
  if (!/^[a-z0-9_]+$/.test(a.name)) problems.push(`bad name ${a.name}`);
  if (!a.displayName || !a.description) problems.push(`${a.name}: missing displayName/description`);
  for (const [k, p] of Object.entries(a.props ?? {})) {
    if (!p.type) problems.push(`${a.name}.${k}: no type`);
  }
}
console.log(JSON.stringify({
  displayName: meta.displayName,
  logoUrl: meta.logoUrl,
  auth: meta.auth?.type,
  minimumSupportedRelease: meta.minimumSupportedRelease,
  categories: meta.categories,
  actions: actions.map((a) => a.name),
  triggers: triggers.map((t) => `${t.name} (${t.type})`),
  counts: { actions: actions.length, triggers: triggers.length },
  problems,
}, null, 2));
if (problems.length) process.exit(1);
