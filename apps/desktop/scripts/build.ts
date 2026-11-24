import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, `..`)

export async function buildDesktopBundles(): Promise<void> {
  await Promise.all([
    build({
      entryPoints: [path.join(rootDir, `src/main/index.ts`)],
      outfile: path.join(rootDir, `dist/main/index.js`),
      bundle: true,
      platform: `node`,
      format: `esm`,
      target: `node22`,
      sourcemap: true,
      external: [`electron`, `@agentclientprotocol/sdk`],
    }),
    build({
      entryPoints: [path.join(rootDir, `src/preload/index.ts`)],
      outfile: path.join(rootDir, `dist/preload/index.cjs`),
      bundle: true,
      platform: `node`,
      format: `cjs`,
      target: `node22`,
      sourcemap: true,
      external: [`electron`],
    }),
  ])
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isDirectRun) {
  buildDesktopBundles().catch((error) => {
    console.error(`[md-desktop] build failed:`, error)
    process.exit(1)
  })
}
