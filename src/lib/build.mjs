// Bundles index.ts (and everything it imports, transitively - never the
// *.test.ts files, since esbuild only follows real imports, not a
// directory glob) into one dist/index.js, then emits per-file
// declarations via tsc -p tsconfig.build.json.
//
// Replaces tsup, which bundled its own copy of rollup-plugin-dts for
// declaration bundling - a copy that doesn't support TypeScript 7's
// restructured compiler API (require('typescript') no longer exposes
// ts.sys/ts.createProgram/etc., only a version stub - the full API moved
// to still-unstable typescript/unstable/* subpaths). esbuild never calls
// into that API at all (it only ever transpiles/strips types textually),
// so it isn't affected by that change either way.
import {build} from 'esbuild'
import {execFileSync} from 'node:child_process'
import {readFile, readdir, rm, writeFile} from 'node:fs/promises'
import path from 'node:path'

await rm('dist', {recursive: true, force: true})

await build({
  entryPoints: ['index.ts'],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'node',
  outfile: 'dist/index.js',
  // this package's own npm dependencies (@noble/curves, @noble/hashes,
  // @scure/base) stay real dependencies for whoever installs
  // @lnurlcash/kit, never inlined into the bundle - same externalization
  // tsup already did by default, reading it off this same package.json
  packages: 'external'
})

execFileSync(
  process.execPath,
  [
    path.join('node_modules', 'typescript', 'bin', 'tsc'),
    '-p',
    'tsconfig.build.json'
  ],
  {stdio: 'inherit'}
)

// Unlike the JS bundle above (a single file, so it has no internal
// relative imports left at all), tsc emits one .d.ts per source module,
// cross-referencing each other with extensionless specifiers ("./errors")
// - valid under "bundler"/classic resolution (this package's own
// tsconfig), but a consumer on strict Node16/NodeNext resolution requires
// an explicit extension on every relative specifier, in a .d.ts exactly
// as much as Node's real ESM loader already requires it for an actual
// .js import (see this repo's own .js-suffixed dependency imports, e.g.
// '@noble/hashes/utils.js'). TypeScript's NodeNext resolution maps a
// '.js' specifier straight back to the sibling .d.ts automatically, so
// appending '.js' (never '.d.ts') here keeps every consumer resolution
// mode working - matching what tsup's single-file bundled .d.ts got "for
// free" by simply never having an internal relative import to resolve.
const RELATIVE_IMPORT = /(from\s+|import\s*\()'(\.[^']+)'/g
for (const entry of await readdir('dist')) {
  if (!entry.endsWith('.d.ts')) continue
  const file = path.join('dist', entry)
  const content = await readFile(file, 'utf8')
  const fixed = content.replace(
    RELATIVE_IMPORT,
    (_match, keyword, specifier) => `${keyword}'${specifier}.js'`
  )
  if (fixed !== content) await writeFile(file, fixed)
}
