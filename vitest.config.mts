import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    // The real-system tests start servers and call OS tools; on Windows CI, PowerShell alone can take seconds.
    testTimeout: 30_000,
  },
});
