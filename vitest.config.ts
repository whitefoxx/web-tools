import { defineConfig } from 'vitest/config';

// Mirror vite.config.ts's build-time flags (src/build-flags.d.ts). Tests run
// the SHIPPED shape, so the dev flags are false; without the define, importing
// a module that reads one would throw ReferenceError instead of taking a branch.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
  },
  define: {
    __WEBCLI_DEV__: 'false',
    __LOCALMD_DEV__: 'false',
  },
});
