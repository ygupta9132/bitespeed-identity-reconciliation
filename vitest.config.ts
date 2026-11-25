import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The integration suite talks to a real Postgres and shares one schema, so the
    // files run one at a time rather than in parallel workers.
    fileParallelism: false,
    include: ['tests/**/*.spec.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000
  }
})
