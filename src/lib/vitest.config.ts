import {fileURLToPath} from 'node:url'
import {dirname} from 'node:path'
import {defineConfig} from 'vitest/config'

// Scoped test suite for this directory alone (see README.md - this is
// staged to become its own package/repo). No plugins, no wallet define -
// unlike the root vitest.config.ts, this only ever needs to see files
// inside src/lib, so it's kept runnable independently of the wallet app
// around it.
//
// `root` must be set explicitly: `vitest run --config <path>` resolves a
// relative `include` glob against process.cwd() (wherever it's invoked
// from), not this file's own directory - without this, running from the
// repo root would pick up every src/**/*.test.ts file, not just this
// directory's.
export default defineConfig({
  root: dirname(fileURLToPath(import.meta.url)),
  test: {
    // pure crypto/codec helpers - node's own WebCrypto covers everything
    // they need, no jsdom (same reasoning as the root config)
    environment: 'node',
    include: ['**/*.test.ts']
  }
})
