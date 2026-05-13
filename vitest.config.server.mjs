import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/server/**/*.test.js'],
    pool: 'forks',
    testTimeout: 10000,
    reporters: ['verbose'],
  },
})
