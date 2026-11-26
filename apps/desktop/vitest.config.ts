import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@md/shared': fileURLToPath(new URL(`../../packages/shared/src`, import.meta.url)),
    },
  },
  test: {
    environment: `node`,
    include: [`src/**/*.test.ts`, `scripts/**/*.test.ts`],
  },
})
