import path from 'node:path'

/**
 * In packaged Electron builds, external CLIs (and `ELECTRON_RUN_AS_NODE`) cannot read
 * files inside `app.asar`, so `asarUnpack` places them under `app.asar.unpacked`.
 */
function toUnpackedPath(resolved: string): string {
  const asarSegment = `${path.sep}app.asar${path.sep}`
  if (resolved.includes(asarSegment))
    return resolved.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
  return resolved
}

/** Resolves a bundled child script under `dist/agents/` to a real filesystem path. */
export function resolveUnpackedAgentScript(mainDir: string, scriptFileName: string): string {
  return toUnpackedPath(path.resolve(mainDir, `../agents`, scriptFileName))
}

/** Resolves the bundled `dist/skills/` directory that is copied into agent workspaces. */
export function resolveUnpackedSkillsDir(mainDir: string): string {
  return toUnpackedPath(path.resolve(mainDir, `../skills`))
}
