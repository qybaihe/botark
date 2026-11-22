import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { rendererAlias } from './vite.shared.mts'

export default defineConfig({
  resolve: {
    alias: {
      ...rendererAlias,
      '@main': resolve('src/main')
    }
  },
  test: {
    include: ['tests/e2e/**/*.e2e.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    clearMocks: true
  }
})
