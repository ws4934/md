import type { AcpDiffStats } from '../types/desktop-acp'

export interface UnifiedDiffLine {
  kind: `context` | `add` | `remove` | `ellipsis`
  text: string
}

export interface CompactDiffResult {
  unifiedDiff: string
  stats: AcpDiffStats
}

const DEFAULT_CONTEXT_LINES = 2
const DEFAULT_MAX_OUTPUT_LINES = 400
const MAX_LCS_CELLS = 400_000

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n|\r/g, `\n`)
}

function splitLines(text: string): string[] {
  if (!text)
    return []
  const lines = text.split(`\n`)
  if (lines.length > 0 && lines[lines.length - 1] === ``)
    lines.pop()
  return lines
}

/**
 * Parses a compact unified diff string (`+`, `-`, ` `, `@@`, `…`) into display lines
 * along with aggregate `+added / -removed` stats.
 */
export function parseUnifiedDiffLines(unifiedDiff: string): {
  lines: UnifiedDiffLine[]
  stats: AcpDiffStats
} {
  if (!unifiedDiff) {
    return {
      lines: [],
      stats: { added: 0, removed: 0, hasChanges: false },
    }
  }

  const rawLines = normalizeNewlines(unifiedDiff).split(`\n`)
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === ``)
    rawLines.pop()

  const lines: UnifiedDiffLine[] = []
  let added = 0
  let removed = 0
  let truncated = false
  let seenHunkOrBody = false

  for (let idx = 0; idx < rawLines.length; idx++) {
    const line = rawLines[idx]
    if (!seenHunkOrBody) {
      if (line.startsWith(`diff --git `) || /^index [0-9a-f]+\.\.[0-9a-f]+/i.test(line))
        continue
      if (/^---[ \t]/.test(line) && /^\+\+\+[ \t]/.test(rawLines[idx + 1] ?? ``)) {
        idx++
        continue
      }
    }
    if (line.startsWith(`\\ No newline at end of file`))
      continue
    if (line.startsWith(`@@`) || line === `…`) {
      seenHunkOrBody = true
      if (line.includes(`truncated`))
        truncated = true
      lines.push({ kind: `ellipsis`, text: line })
      continue
    }
    seenHunkOrBody = true
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
    stats: {
      added,
      removed,
      hasChanges: added > 0 || removed > 0,
      ...(truncated ? { truncated: true } : {}),
    },
  }
}

interface RawDiffOp {
  kind: `context` | `add` | `remove`
  text: string
}

/**
 * Computes line ops on the trimmed changed middle slice.
 * Falls back to a simple remove-all / add-all slice if the changed middle is huge
 * so diff computation stays bounded in both time and memory.
 */
function diffLineSlice(oldSlice: string[], newSlice: string[]): RawDiffOp[] {
  const m = oldSlice.length
  const n = newSlice.length

  if (m === 0)
    return newSlice.map(text => ({ kind: `add`, text }))
  if (n === 0)
    return oldSlice.map(text => ({ kind: `remove`, text }))

  if (m * n > MAX_LCS_CELLS) {
    const ops: RawDiffOp[] = []
    for (const text of oldSlice)
      ops.push({ kind: `remove`, text })
    for (const text of newSlice)
      ops.push({ kind: `add`, text })
    return ops
  }

  // Standard bottom-up DP LCS table over the trimmed middle lines.
  const stride = n + 1
  const dp = new Int32Array((m + 1) * stride)
  for (let i = m - 1; i >= 0; i--) {
    const row = i * stride
    const nextRow = (i + 1) * stride
    const oldLine = oldSlice[i]
    for (let j = n - 1; j >= 0; j--) {
      if (oldLine === newSlice[j]) {
        dp[row + j] = dp[nextRow + j + 1] + 1
      }
      else {
        const down = dp[nextRow + j]
        const right = dp[row + j + 1]
        dp[row + j] = down >= right ? down : right
      }
    }
  }

  const ops: RawDiffOp[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (oldSlice[i] === newSlice[j]) {
      ops.push({ kind: `context`, text: oldSlice[i] })
      i++
      j++
    }
    else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      ops.push({ kind: `remove`, text: oldSlice[i] })
      i++
    }
    else {
      ops.push({ kind: `add`, text: newSlice[j] })
      j++
    }
  }
  while (i < m) {
    ops.push({ kind: `remove`, text: oldSlice[i++] })
  }
  while (j < n) {
    ops.push({ kind: `add`, text: newSlice[j++] })
  }

  return ops
}

/**
 * Computes a compact unified diff (hunks with surrounding context + `+N/-M` counts)
 * without retaining full `oldText` / `newText`. Leading and trailing identical lines
 * are stripped in O(N) before diffing, so localized edits on 30k-line articles run in <1ms.
 */
export function computeCompactDiff(input: {
  oldText?: string
  newText?: string
  unifiedDiff?: string
  contextLines?: number
  maxLines?: number
}): CompactDiffResult {
  const contextLines = input.contextLines ?? DEFAULT_CONTEXT_LINES
  const maxLines = input.maxLines ?? DEFAULT_MAX_OUTPUT_LINES

  if (input.oldText === undefined && input.newText === undefined) {
    if (!input.unifiedDiff) {
      return {
        unifiedDiff: ``,
        stats: { added: 0, removed: 0, hasChanges: false },
      }
    }
    const parsed = parseUnifiedDiffLines(input.unifiedDiff)
    const truncated = parsed.lines.length > maxLines
    const keptLines = truncated ? parsed.lines.slice(0, maxLines) : parsed.lines
    const rendered = keptLines.map((line) => {
      if (line.kind === `add`)
        return `+${line.text}`
      if (line.kind === `remove`)
        return `-${line.text}`
      if (line.kind === `ellipsis`)
        return line.text
      return ` ${line.text}`
    })
    if (truncated)
      rendered.push(`@@ … truncated ${parsed.lines.length - maxLines} more lines @@`)
    return {
      unifiedDiff: rendered.join(`\n`),
      stats: {
        ...parsed.stats,
        ...(truncated ? { truncated: true } : {}),
      },
    }
  }

  const oldNorm = normalizeNewlines(input.oldText ?? ``)
  const newNorm = normalizeNewlines(input.newText ?? ``)
  if (oldNorm === newNorm) {
    return {
      unifiedDiff: ``,
      stats: { added: 0, removed: 0, hasChanges: false },
    }
  }

  const oldLines = splitLines(oldNorm)
  const newLines = splitLines(newNorm)

  let prefix = 0
  const minLen = Math.min(oldLines.length, newLines.length)
  while (prefix < minLen && oldLines[prefix] === newLines[prefix])
    prefix++

  let suffix = 0
  while (
    suffix < minLen - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
  ) {
    suffix++
  }

  const oldMid = oldLines.slice(prefix, oldLines.length - suffix)
  const newMid = newLines.slice(prefix, newLines.length - suffix)
  const midOps = diffLineSlice(oldMid, newMid)

  let added = 0
  let removed = 0
  for (const op of midOps) {
    if (op.kind === `add`)
      added++
    else if (op.kind === `remove`)
      removed++
  }

  if (added === 0 && removed === 0) {
    return {
      unifiedDiff: ``,
      stats: { added: 0, removed: 0, hasChanges: false },
    }
  }

  // Assemble the minimal window (at most `contextLines` of prefix/suffix + middle ops).
  const leadStart = Math.max(0, prefix - contextLines)
  const trailEnd = Math.min(suffix, contextLines)
  const windowedOps: RawDiffOp[] = []

  for (let i = leadStart; i < prefix; i++)
    windowedOps.push({ kind: `context`, text: oldLines[i] })
  for (const op of midOps)
    windowedOps.push(op)
  for (let i = 0; i < trailEnd; i++)
    windowedOps.push({ kind: `context`, text: oldLines[oldLines.length - suffix + i] })

  // Collapse unchanged context runs inside the middle slice outside `contextLines`.
  const keep = new Uint8Array(windowedOps.length)
  for (let i = 0; i < windowedOps.length; i++) {
    if (windowedOps[i].kind !== `context`) {
      const start = Math.max(0, i - contextLines)
      const end = Math.min(windowedOps.length - 1, i + contextLines)
      for (let j = start; j <= end; j++)
        keep[j] = 1
    }
  }

  const outLines: string[] = []
  let skipping = false
  let truncated = false
  let omittedLines = 0

  for (let i = 0; i < windowedOps.length; i++) {
    if (keep[i]) {
      skipping = false
      const op = windowedOps[i]
      if (outLines.length >= maxLines) {
        truncated = true
        omittedLines++
        continue
      }
      const prefixChar = op.kind === `add` ? `+` : op.kind === `remove` ? `-` : ` `
      outLines.push(`${prefixChar}${op.text}`)
    }
    else if (!skipping) {
      skipping = true
      if (outLines.length > 0 && outLines.length < maxLines)
        outLines.push(`…`)
    }
  }

  if (outLines.length > 0 && outLines[outLines.length - 1] === `…`)
    outLines.pop()

  if (truncated)
    outLines.push(`@@ … truncated ${omittedLines} more lines @@`)

  return {
    unifiedDiff: outLines.join(`\n`),
    stats: {
      added,
      removed,
      hasChanges: true,
      ...(truncated ? { truncated: true } : {}),
    },
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
