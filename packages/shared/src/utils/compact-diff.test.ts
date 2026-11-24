import { describe, expect, it } from 'vitest'
import { computeCompactDiff, formatShortFilePath, parseUnifiedDiffLines } from './compact-diff'

describe(`computeCompactDiff`, () => {
  it(`computes compact hunks and counts for localized edits in large documents`, () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`)
    const oldText = lines.join(`\n`)
    const nextLines = [...lines]
    nextLines[2500] = `line 2501 edited`
    nextLines.splice(2501, 0, `inserted line`)
    const newText = nextLines.join(`\n`)

    const res = computeCompactDiff({ oldText, newText })
    expect(res.stats).toEqual({ added: 2, removed: 1, hasChanges: true })
    expect(res.unifiedDiff.split(`\n`).length).toBeLessThan(15)
    expect(res.unifiedDiff).toContain(`-line 2501`)
    expect(res.unifiedDiff).toContain(`+line 2501 edited`)
    expect(res.unifiedDiff).toContain(`+inserted line`)

    const parsed = parseUnifiedDiffLines(res.unifiedDiff)
    expect(parsed.stats).toEqual({ added: 2, removed: 1, hasChanges: true })
    expect(parsed.lines.some(l => l.kind === `add` && l.text === `inserted line`)).toBe(true)
  })

  it(`handles full deletes and identical inputs`, () => {
    expect(computeCompactDiff({ oldText: `same`, newText: `same` })).toEqual({
      unifiedDiff: ``,
      stats: { added: 0, removed: 0, hasChanges: false },
    })

    const del = computeCompactDiff({ oldText: `a\nb`, newText: `` })
    expect(del.stats).toEqual({ added: 0, removed: 2, hasChanges: true })
    expect(del.unifiedDiff).toBe(`-a\n-b`)
  })

  it(`caps oversized diffs and marks them truncated`, () => {
    const oldText = ``
    const newText = Array.from({ length: 50 }, (_, i) => `added ${i}`).join(`\n`)
    const res = computeCompactDiff({ oldText, newText, maxLines: 10 })
    expect(res.stats.added).toBe(50)
    expect(res.stats.truncated).toBe(true)
    expect(res.unifiedDiff).toContain(`truncated 40 more lines`)
  })

  it(`formats short file paths stripping UUID workspace segments`, () => {
    expect(formatShortFilePath(`/tmp/acp-workspaces/550e8400-e29b-41d4-a716-446655440000/article.md`)).toBe(`article.md`)
    expect(formatShortFilePath(`/Users/demo/docs/guide.md`)).toBe(`docs/guide.md`)
  })
})
