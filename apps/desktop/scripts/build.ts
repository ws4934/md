import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, `..`)

const ESM_CJS_SHIM_BANNER = `import { createRequire as __mdCreateRequire } from 'node:module'; const require = __mdCreateRequire(import.meta.url);`

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
      banner: { js: ESM_CJS_SHIM_BANNER },
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
    build({
      entryPoints: [path.join(rootDir, `src/agents/api-agent/index.ts`)],
      outfile: path.join(rootDir, `dist/agents/api-agent.js`),
      bundle: true,
      platform: `node`,
      format: `esm`,
      target: `node22`,
      sourcemap: true,
      banner: { js: ESM_CJS_SHIM_BANNER },
    }),
    build({
      entryPoints: [path.join(rootDir, `src/agents/image-mcp/index.ts`)],
      outfile: path.join(rootDir, `dist/agents/image-mcp.js`),
      bundle: true,
      platform: `node`,
      format: `esm`,
      target: `node22`,
      sourcemap: true,
      banner: { js: ESM_CJS_SHIM_BANNER },
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
