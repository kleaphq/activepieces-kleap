// Produces the npm package the way the Activepieces CLI ("pieces bundle") does: one esbuild'd
// src/index.js with @activepieces/* and third-party code inlined, no runtime dependencies.
//   npm run bundle  →  dist/npm/{package.json, src/index.js, README.md, LICENSE}
//   cd dist/npm && npm publish --access restricted   (private @kleap scope)
import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { builtinModules } from 'node:module';

const root = new URL('..', import.meta.url).pathname;
const out = `${root}dist/npm`;
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/src`, { recursive: true });

await build({
  entryPoints: [`${root}src/index.ts`],
  outfile: `${out}/src/index.js`,
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  minify: true,
  keepNames: true,
  sourcemap: false,
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  logLevel: 'warning',
});

const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8'));
writeFileSync(
  `${out}/package.json`,
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description,
      keywords: pkg.keywords,
      homepage: pkg.homepage,
      license: pkg.license,
      author: pkg.author,
      main: './src/index.js',
      dependencies: {},
      files: ['src/index.js', 'package.json', 'README.md', 'LICENSE'],
    },
    null,
    2,
  ) + '\n',
);
copyFileSync(`${root}README.md`, `${out}/README.md`);
copyFileSync(`${root}LICENSE`, `${out}/LICENSE`);
console.log(`bundled ${out}/src/index.js (${(readFileSync(`${out}/src/index.js`).length / 1024).toFixed(0)} KB)`);
