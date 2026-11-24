import DiffMatchPatch from 'diff-match-patch'

export interface DiffLineItem {
  kind: `context` | `add` | `remove`
  text: string
  mono?: boolean
}

export interface ArticleDiffHunk {
  id: string
  oldStart: number
  oldEnd: number
  newStart: number
  newEnd: number
  lines: DiffLineItem[]
  /** Original lines replaced by this hunk (without trailing newline). */
  removedLines: string[]
  /** Replacement lines introduced by this hunk (without trailing newline). */
  addedLines: string[]
}

const CONTEXT_LINES = 2

function splitLines(text: string): string[] {
  if (!text)
    return []
  return text.replace(/\r\n/g, `\n`).split(`\n`)
}

interface RawLineOp {
  op: -1 | 0 | 1
  text: string
}

function computeLineOps(baseContent: string, proposedContent: string): RawLineOp[] {
  const dmp = new DiffMatchPatch()
  const baseNorm = baseContent.replace(/\r\n/g, `\n`)
  const propNorm = proposedContent.replace(/\r\n/g, `\n`)
  // Ensure line-mode diffing aligns complete lines cleanly.
  const baseWithNl = baseNorm.endsWith(`\n`) || !baseNorm ? baseNorm : `${baseNorm}\n`
  const propWithNl = propNorm.endsWith(`\n`) || !propNorm ? propNorm : `${propNorm}\n`

  const { chars1, chars2, lineArray } = dmp.diff_linesToChars_(baseWithNl, propWithNl)
  const diffs = dmp.diff_main(chars1, chars2, false)
  dmp.diff_charsToLines_(diffs, lineArray)

  const ops: RawLineOp[] = []
  for (const [op, chunk] of diffs) {
    const chunkLines = chunk.split(`\n`)
    // Drop the trailing empty segment caused by the terminating newline.
    if (chunkLines.length > 0 && chunkLines[chunkLines.length - 1] === ``)
      chunkLines.pop()
    for (const line of chunkLines)
      ops.push({ op: op as -1 | 0 | 1, text: line })
  }
  return ops
}

function annotateCodeFenceMono(lines: DiffLineItem[]): DiffLineItem[] {
  let inFence = false
  return lines.map((line) => {
    const trimmed = line.text.trimStart()
    const isFence = trimmed.startsWith(`\`\`\``) || trimmed.startsWith(`~~~`)
    if (isFence) {
      const next = { ...line, mono: true }
      inFence = !inFence
      return next
    }
    return inFence ? { ...line, mono: true } : line
  })
}

/**
 * Splits a base/proposed article pair into discrete reviewable hunks with context lines.
 */
export function computeArticleDiffHunks(baseContent: string, proposedContent: string): ArticleDiffHunk[] {
  if (baseContent.replace(/\r\n/g, `\n`) === proposedContent.replace(/\r\n/g, `\n`))
    return []

  const ops = computeLineOps(baseContent, proposedContent)
  const hunks: ArticleDiffHunk[] = []

  // Walk ops tracking 0-based line indices in base and proposed documents.
  interface IndexedOp extends RawLineOp {
    oldLine: number
    newLine: number
  }
  const indexed: IndexedOp[] = []
  let oldIdx = 0
  let newIdx = 0
  for (const item of ops) {
    indexed.push({ ...item, oldLine: oldIdx, newLine: newIdx })
    if (item.op === 0) {
      oldIdx++
      newIdx++
    }
    else if (item.op === -1) {
      oldIdx++
    }
    else {
      newIdx++
    }
  }

  let i = 0
  let hunkSeq = 0
  while (i < indexed.length) {
    if (indexed[i].op === 0) {
      i++
      continue
    }

    // Group nearby changes separated by at most CONTEXT_LINES equal lines into one hunk.
    const changeStart = i
    let changeEnd = i
    while (changeEnd < indexed.length) {
      if (indexed[changeEnd].op !== 0) {
        changeEnd++
        continue
      }
      let equalRun = 0
      while (changeEnd + equalRun < indexed.length && indexed[changeEnd + equalRun].op === 0)
        equalRun++
      if (changeEnd + equalRun < indexed.length && equalRun <= CONTEXT_LINES) {
        changeEnd += equalRun
        continue
      }
      break
    }

    const sliceStart = Math.max(0, changeStart - CONTEXT_LINES)
    const sliceEnd = Math.min(indexed.length, changeEnd + CONTEXT_LINES)
    const slice = indexed.slice(sliceStart, sliceEnd)

    // Compute exact old/new line span for the changed region (excluding outer context).
    const changedOps = indexed.slice(changeStart, changeEnd)
    const oldStart = changedOps[0].oldLine
    const newStart = changedOps[0].newLine
    let oldCount = 0
    let newCount = 0
    const removedLines: string[] = []
    const addedLines: string[] = []
    for (const op of changedOps) {
      if (op.op === 0) {
        oldCount++
        newCount++
        removedLines.push(op.text)
        addedLines.push(op.text)
      }
      else if (op.op === -1) {
        oldCount++
        removedLines.push(op.text)
      }
      else {
        newCount++
        addedLines.push(op.text)
      }
    }

    const lines = annotateCodeFenceMono(
      slice.map(item => ({
        kind: item.op === 1 ? `add` : item.op === -1 ? `remove` : `context`,
        text: item.text,
      })),
    )

    hunks.push({
      id: `hunk-${++hunkSeq}`,
      oldStart,
      oldEnd: oldStart + oldCount,
      newStart,
      newEnd: newStart + newCount,
      lines,
      removedLines,
      addedLines,
    })

    i = changeEnd
  }

  return hunks
}

/**
 * Applies a single accepted hunk onto `baseContent`, returning the updated document.
 */
export function applyDiffHunk(baseContent: string, hunk: ArticleDiffHunk): string {
  const baseLines = splitLines(baseContent)
  const before = baseLines.slice(0, hunk.oldStart)
  const after = baseLines.slice(hunk.oldEnd)
  return [...before, ...hunk.addedLines, ...after].join(`\n`)
}

/**
 * Reverts a single rejected hunk out of `proposedContent`, returning the updated proposal.
 */
export function rejectDiffHunk(proposedContent: string, hunk: ArticleDiffHunk): string {
  const propLines = splitLines(proposedContent)
  const before = propLines.slice(0, hunk.newStart)
  const after = propLines.slice(hunk.newEnd)
  return [...before, ...hunk.removedLines, ...after].join(`\n`)
}
