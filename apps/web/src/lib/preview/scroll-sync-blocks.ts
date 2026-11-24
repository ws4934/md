export interface SourceBlock {
  startLine: number
  endLine: number
}

/** Minimal doc interface so tests can avoid CodeMirror Text */
export interface LineDoc {
  lines: number
  line: (n: number) => { text: string }
  iterLines?: (from?: number, to?: number) => Iterable<string>
}

function isBlankLine(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code !== 32 && code !== 9 && code !== 13 && code !== 10)
      return false
  }
  return true
}

/**
 * Split a source document into logical blocks separated by blank lines.
 * Uses CodeMirror's `iterLines()` when available to avoid O(L log L) `doc.line(i)` walks.
 */
export function parseSourceBlocks(doc: LineDoc): SourceBlock[] {
  const blocks: SourceBlock[] = []
  let blockStart = -1

  if (typeof doc.iterLines === `function`) {
    let i = 0
    for (const lineText of doc.iterLines()) {
      i++
      const isEmpty = isBlankLine(lineText)
      if (!isEmpty && blockStart === -1) {
        blockStart = i
      }
      else if (isEmpty && blockStart !== -1) {
        blocks.push({ startLine: blockStart, endLine: i - 1 })
        blockStart = -1
      }
    }
    if (blockStart !== -1)
      blocks.push({ startLine: blockStart, endLine: i })
    return blocks
  }

  for (let i = 1; i <= doc.lines; i++) {
    const isEmpty = isBlankLine(doc.line(i).text)
    if (!isEmpty && blockStart === -1) {
      blockStart = i
    }
    else if (isEmpty && blockStart !== -1) {
      blocks.push({ startLine: blockStart, endLine: i - 1 })
      blockStart = -1
    }
  }
  if (blockStart !== -1)
    blocks.push({ startLine: blockStart, endLine: doc.lines })

  return blocks
}

export function sourceBlockIndexForLine(
  sourceBlocks: SourceBlock[],
  lineNo: number,
): number {
  const len = sourceBlocks.length
  if (len === 0 || lineNo < sourceBlocks[0].startLine)
    return 0

  let lo = 0
  let hi = len - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (sourceBlocks[mid].startLine <= lineNo)
      lo = mid
    else
      hi = mid - 1
  }
  return lo
}

export function sourceLineForBlockIndex(
  sourceBlocks: SourceBlock[],
  blockIndex: number,
): number {
  if (sourceBlocks.length === 0)
    return 1
  const idx = Math.min(blockIndex, sourceBlocks.length - 1)
  return sourceBlocks[idx].startLine
}

/**
 * Map a source block index onto a preview block index by ratio.
 */
export function mapBlockIndex(
  index: number,
  sourceTotal: number,
  targetTotal: number,
): number {
  if (sourceTotal <= 1 || targetTotal <= 1)
    return Math.round((index / Math.max(sourceTotal - 1, 1)) * Math.max(targetTotal - 1, 1))
  return Math.round((index / (sourceTotal - 1)) * (targetTotal - 1))
}
