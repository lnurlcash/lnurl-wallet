import {configDefaults, defineConfig} from 'vitest/config'
import solidPlugin from 'vite-plugin-solid'
import {gitVersion} from './scripts/git-version.mjs'

export default defineConfig({
  plugins: [solidPlugin()],
  // matches vite.config.ts's own define - nothing currently under test
  // reads __APP_VERSION__, but keeps it available if that changes
  define: {
    __APP_VERSION__: JSON.stringify(gitVersion('dev'))
  },
  test: {
    // the tested modules are pure crypto/codec helpers - node's own
    // WebCrypto (crypto.subtle) covers everything they need, no jsdom
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // src/lib is a staged standalone package (see its own README) with its
    // own scoped vitest.config.ts and `npm run test:lib` - excluded here so
    // it isn't run twice under two different configs
    exclude: [...configDefaults.exclude, 'src/lib/**']
  }
})
