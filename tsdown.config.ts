import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  // Declarations are emitted by tsgo (see the build script), not rolldown-plugin-dts,
  // which cannot drive the TypeScript 7 (native) compiler host used across this repo.
  dts: false,
  format: ['esm', 'cjs'],
  clean: true,
  platform: 'neutral',
  // Node builtins are externals, not bundle inputs. The package already
  // requires Node (postgres-js opens real sockets, and engines.node is
  // >=24.21.0); under the neutral platform rolldown does not assume that, so
  // `node:async_hooks` resolves as "module not found" and warns on every build.
  external: [/^node:/],
})
