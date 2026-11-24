import { describe, expect, it } from 'vitest'
import { buildUnifiedDiff, formatShortFilePath } from './unified-diff'

describe(`buildUnifiedDiff`, () => {
  it(`computes line counts and collapses distant unchanged lines`, () => {
    const oldText = [`L1`, `L2`, `L3`, `L4`, `L5`, `L6`, `old`, `L8`, `L9`, `L10`, `L11`].join(`\n`)
    const newText = [`L1`, `L2`, `L3`, `L4`, `L5`, `L6`, `new1`, `new2`, `L8`, `L9`, `L10`, `L11`].join(`\n`)

    const res = buildUnifiedDiff({ oldText, newText })
    expect(res.hasChanges).toBe(true)
    expect(res.added).toBe(2)
    expect(res.removed).toBe(1)
    expect(res.lines.some(l => l.kind === `remove` && l.text === `old`)).toBe(true)
    expect(res.lines.some(l => l.kind === `add` && l.text === `new1`)).toBe(true)
    expect(res.lines.some(l => l.text === `L1`)).toBe(false)
  })

  it(`parses preformatted unified diff strings when oldText/newText are absent`, () => {
    const res = buildUnifiedDiff({
      unifiedDiff: `--- a/article.md\n+++ b/article.md\n@@ -1,2 +1,2 @@\n-old\n+new\n keep`,
    })
    expect(res.added).toBe(1)
    expect(res.removed).toBe(1)
    expect(res.lines.find(l => l.kind === `ellipsis`)?.text).toBe(`@@ -1,2 +1,2 @@`)
  })

  it(`shortens absolute file paths and hides UUID workspace directories`, () => {
    expect(formatShortFilePath(`/tmp/acp-workspaces/abc/article.md`)).toBe(`abc/article.md`)
    expect(formatShortFilePath(`/tmp/acp-workspaces/042a5e49-9c90-484e-98e9-b52e03440cd9/article.md`)).toBe(`article.md`)
    expect(formatShortFilePath(`article.md`)).toBe(`article.md`)
  })
})
