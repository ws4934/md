import DiffMatchPatch from 'diff-match-patch'

export interface UnifiedDiffLine {
  kind: `context` | `add` | `remove` | `ellipsis`
  text: string
}

export interface UnifiedDiffResult {
  lines: UnifiedDiffLine[]
  added: number
  removed: number
  hasChanges: boolean
}

const CONTEXT_LINES = 2

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, `\n`)
}

function parsePreformattedDiff(unifiedDiff: string): UnifiedDiffResult {
  const rawLines = normalizeNewlines(unifiedDiff).split(`\n`)
  const lines: UnifiedDiffLine[] = []
  let added = 0
  let removed = 0

  for (const line of rawLines) {
    if (line.startsWith(`+++`) || line.startsWith(`---`))
      continue
    if (line.startsWith(`@@`)) {
      lines.push({ kind: `ellipsis`, text: line })
      continue
    }
    if (line.startsWith(`+`)) {
      added++
      lines.push({ kind: `add`, text: line.slice(1) })
    }
    else if (line.startsWith(`-`)) {
      removed++
      lines.push({ kind: `remove`, text: line.slice(1) })
    }
    else {
      lines.push({ kind: `context`, text: line.startsWith(` `) ? line.slice(1) : line })
    }
  }

  return {
    lines,
    added,
    removed,
    hasChanges: added > 0 || removed > 0,
  }
}

/**
 * Builds a compact unified diff with surrounding context lines and `+N -M` counts
 * from ACP `diff` content (`oldText`/`newText`) or a preformatted unified diff string.
 */
export function buildUnifiedDiff(input: {
  oldText?: string
  newText?: string
  unifiedDiff?: string
}): UnifiedDiffResult {
  if (input.oldText === undefined && input.newText === undefined) {
    if (input.unifiedDiff)
      return parsePreformattedDiff(input.unifiedDiff)
    return { lines: [], added: 0, removed: 0, hasChanges: false }
  }

  const oldNorm = normalizeNewlines(input.oldText ?? ``)
  const newNorm = normalizeNewlines(input.newText ?? ``)
  if (oldNorm === newNorm)
    return { lines: [], added: 0, removed: 0, hasChanges: false }

  const dmp = new DiffMatchPatch()
  const oldWithNl = oldNorm && !oldNorm.endsWith(`\n`) ? `${oldNorm}\n` : oldNorm
  const newWithNl = newNorm && !newNorm.endsWith(`\n`) ? `${newNorm}\n` : newNorm

  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(oldWithNl, newWithNl)
  const diffs = dmp.diff_main(chars1, chars2, false)
  dmp.diff_charsToLines_(diffs, lineArray)

  const rawOps: Array<{ kind: `context` | `add` | `remove`, text: string }> = []
  let added = 0
  let removed = 0

  for (const [op, chunk] of diffs) {
    const chunkLines = chunk.split(`\n`)
    if (chunkLines.length > 0 && chunkLines[chunkLines.length - 1] === ``)
      chunkLines.pop()
    const kind = op === 1 ? `add` : op === -1 ? `remove` : `context`
    for (const text of chunkLines) {
      if (kind === `add`)
        added++
      else if (kind === `remove`)
        removed++
      rawOps.push({ kind, text })
    }
  }

  // Collapse unchanged context runs outside CONTEXT_LINES around edits.
  const keep = new Uint8Array(rawOps.length)
  for (let i = 0; i < rawOps.length; i++) {
    if (rawOps[i].kind !== `context`) {
      const start = Math.max(0, i - CONTEXT_LINES)
      const end = Math.min(rawOps.length - 1, i + CONTEXT_LINES)
      for (let j = start; j <= end; j++)
        keep[j] = 1
    }
  }

  const lines: UnifiedDiffLine[] = []
  let skipping = false
  for (let i = 0; i < rawOps.length; i++) {
    if (keep[i]) {
      skipping = false
      lines.push(rawOps[i])
    }
    else if (!skipping) {
      skipping = true
      if (lines.length > 0)
        lines.push({ kind: `ellipsis`, text: `…` })
    }
  }
  if (lines.length > 0 && lines[lines.length - 1].kind === `ellipsis`)
    lines.pop()

  return {
    lines,
    added,
    removed,
    hasChanges: added > 0 || removed > 0,
  }
}

const UUID_SEGMENT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function formatShortFilePath(filePath: string | undefined, fallback = ``): string {
  if (!filePath)
    return fallback
  const normalized = filePath.replace(/\\/g, `/`)
  const parts = normalized.split(`/`).filter(Boolean)
  if (parts.length <= 1)
    return parts[0] ?? fallback
  const parent = parts[parts.length - 2]
  if (UUID_SEGMENT_RE.test(parent))
    return parts[parts.length - 1]
  return parts.slice(-2).join(`/`)
}
