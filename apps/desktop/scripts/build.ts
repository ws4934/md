import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const rootDir = path.resolve(__dirname, `..`)

// Repo skills (`.agents/skills/<name>`) shipped to desktop agents; dev-only skills stay out.
const BUNDLED_SKILLS = [`wechat-minsheng`]

const ESM_CJS_SHIM_BANNER = `import { createRequire as __mdCreateRequire } from 'node:module'; const require = __mdCreateRequire(import.meta.url);`

export interface BuildDesktopBundlesOptions {
  sourcemap?: boolean
}

export async function copyBundledSkills(
  skillsSrcRoot: string,
  skillsDestRoot: string,
  skillNames: readonly string[] = BUNDLED_SKILLS,
): Promise<void> {
  await fs.rm(skillsDestRoot, { recursive: true, force: true })
  await Promise.all(skillNames.map(async (name) => {
    const srcDir = path.resolve(skillsSrcRoot, name)
    await fs.access(path.join(srcDir, `SKILL.md`))
    await fs.cp(srcDir, path.join(skillsDestRoot, name), {
      recursive: true,
      dereference: true,
      filter: src => path.basename(src) !== `.DS_Store`,
    })
  }))
}

export async function buildDesktopBundles(options: BuildDesktopBundlesOptions = {}): Promise<void> {
  const sourcemap = options.sourcemap ?? false
  // Clean main/preload/agents/skills (leave dist/renderer intact, as web build:desktop populates it first).
  await Promise.all(
    [`dist/main`, `dist/preload`, `dist/agents`, `dist/skills`].map(sub =>
      fs.rm(path.join(rootDir, sub), { recursive: true, force: true }),
    ),
  )
  await Promise.all([
    copyBundledSkills(
      path.resolve(rootDir, `../../.agents/skills`),
      path.join(rootDir, `dist/skills`),
    ),
    build({
      entryPoints: [path.join(rootDir, `src/main/index.ts`)],
      outfile: path.join(rootDir, `dist/main/index.js`),
      bundle: true,
      platform: `node`,
      format: `esm`,
      target: `node22`,
      sourcemap,
      external: [`electron`],
      banner: { js: ESM_CJS_SHIM_BANNER },
    }),
    build({
      entryPoints: [path.join(rootDir, `src/preload/index.ts`)],
      outfile: path.join(rootDir, `dist/preload/index.cjs`),
      bundle: true,
      platform: `node`,
      format: `cjs`,
      target: `node22`,
      sourcemap,
      external: [`electron`],
    }),
    build({
      entryPoints: [path.join(rootDir, `src/agents/api-agent/index.ts`)],
      outfile: path.join(rootDir, `dist/agents/api-agent.js`),
      bundle: true,
      platform: `node`,
      format: `esm`,
      target: `node22`,
      sourcemap,
      banner: { js: ESM_CJS_SHIM_BANNER },
    }),
    build({
      entryPoints: [path.join(rootDir, `src/agents/image-mcp/index.ts`)],
      outfile: path.join(rootDir, `dist/agents/image-mcp.js`),
      bundle: true,
      platform: `node`,
      format: `esm`,
      target: `node22`,
      sourcemap,
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
