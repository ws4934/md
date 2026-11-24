import type { AcpDiffStats } from '@md/shared/types'
import type { UnifiedDiffLine } from '@md/shared/utils/compact-diff'
import {
  computeCompactDiff,
  formatShortFilePath,
  parseUnifiedDiffLines,
} from '@md/shared/utils/compact-diff'

export type { UnifiedDiffLine }
export { formatShortFilePath }

export interface UnifiedDiffResult {
  lines: UnifiedDiffLine[]
  added: number
  removed: number
  hasChanges: boolean
}

export interface DiffInput {
  oldText?: string
  newText?: string
  unifiedDiff?: string
  diffStats?: AcpDiffStats
}

/**
 * Returns `+added / -removed` stats in O(1) when precomputed by the main process,
 * avoiding diff computation/parsing for collapsed cards.
 */
export function getDiffStats(input: DiffInput): AcpDiffStats {
  if (input.diffStats)
    return input.diffStats
  if (input.unifiedDiff && input.oldText === undefined && input.newText === undefined)
    return parseUnifiedDiffLines(input.unifiedDiff).stats
  if (input.oldText !== undefined || input.newText !== undefined)
    return computeCompactDiff(input).stats
  return { added: 0, removed: 0, hasChanges: false }
}

/**
 * Parses compact unified diff rows lazily (only when a diff card is expanded or visible).
 */
export function getDiffLines(input: DiffInput): UnifiedDiffLine[] {
  if (input.unifiedDiff)
    return parseUnifiedDiffLines(input.unifiedDiff).lines
  if (input.oldText !== undefined || input.newText !== undefined) {
    const compact = computeCompactDiff(input)
    return parseUnifiedDiffLines(compact.unifiedDiff).lines
  }
  return []
}

export function buildUnifiedDiff(input: DiffInput): UnifiedDiffResult {
  const stats = getDiffStats(input)
  const lines = stats.hasChanges ? getDiffLines(input) : []
  return {
    lines,
    added: stats.added,
    removed: stats.removed,
    hasChanges: stats.hasChanges,
  }
}
