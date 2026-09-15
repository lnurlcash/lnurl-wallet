import {defineConfig} from 'tsup'

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  outExtension: () => ({js: '.js'})
})
