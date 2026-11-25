import path from 'node:path'

/**
 * Resolves a bundled child script under `dist/agents/` to a real filesystem path.
 * In packaged Electron builds, external CLIs (and `ELECTRON_RUN_AS_NODE`) cannot exec
 * files inside `app.asar`, so `asarUnpack` places them under `app.asar.unpacked`.
 */
export function resolveUnpackedAgentScript(mainDir: string, scriptFileName: string): string {
  const resolved = path.resolve(mainDir, `../agents`, scriptFileName)
  const asarSegment = `${path.sep}app.asar${path.sep}`
  if (resolved.includes(asarSegment))
    return resolved.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
  return resolved
}
