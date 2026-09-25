// Copies the piece into a local clone of activepieces/activepieces as packages/pieces/community/kleap,
// with the monorepo's own package.json / tsconfig / eslint files, and registers its tsconfig path.
//   node scripts/export-to-monorepo.mjs /path/to/activepieces
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const monorepo = process.argv[2];
if (!monorepo || !existsSync(join(monorepo, 'tsconfig.base.json'))) {
  console.error('usage: node scripts/export-to-monorepo.mjs <path to activepieces clone>');
  process.exit(1);
}
const root = new URL('..', import.meta.url).pathname;
const dest = join(monorepo, 'packages/pieces/community/kleap');
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(root, 'src'), join(dest, 'src'), { recursive: true });
for (const f of ['package.json', 'tsconfig.json', 'tsconfig.lib.json', '.eslintrc.json']) {
  cpSync(join(root, 'monorepo', f), join(dest, f));
}
// Keep the piece version in sync with the standalone package.
const standalone = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const mono = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
mono.version = standalone.version;
writeFileSync(join(dest, 'package.json'), JSON.stringify(mono, null, 2) + '\n');

const basePath = join(monorepo, 'tsconfig.base.json');
const base = readFileSync(basePath, 'utf8');
if (!base.includes('"@activepieces/piece-kleap"')) {
  const anchor = '"@activepieces/piece-';
  const entry = `"@activepieces/piece-kleap": [\n        "packages/pieces/community/kleap/src/index.ts"\n      ],\n      `;
  // Insert before the first piece whose name sorts after "kleap" to keep the list alphabetical.
  const re = /"@activepieces\/piece-([a-z0-9-]+)"/g;
  let m;
  let at = -1;
  while ((m = re.exec(base))) {
    if (m[1] > 'kleap') {
      at = m.index;
      break;
    }
  }
  if (at === -1) at = base.indexOf(anchor);
  writeFileSync(basePath, base.slice(0, at) + entry + base.slice(at));
}
console.log(`exported to ${dest}`);
