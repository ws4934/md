import { describe, expect, it } from 'vitest'
import { applyDiffHunk, computeArticleDiffHunks, rejectDiffHunk } from './diff-hunks'

describe(`article diff hunks`, () => {
  it(`returns no hunks for identical documents`, () => {
    expect(computeArticleDiffHunks(`# Title\n\nHello`, `# Title\n\nHello`)).toEqual([])
  })

  it(`splits distant edits into separate hunks and supports per-hunk accept/reject`, () => {
    const base = [
      `# Title`,
      `old intro`,
      `line 3`,
      `line 4`,
      `line 5`,
      `line 6`,
      `line 7`,
      `old outro`,
    ].join(`\n`)

    const proposed = [
      `# Title`,
      `new intro`,
      `line 3`,
      `line 4`,
      `line 5`,
      `line 6`,
      `line 7`,
      `new outro`,
    ].join(`\n`)

    const hunks = computeArticleDiffHunks(base, proposed)
    expect(hunks).toHaveLength(2)

    // Accept only first hunk -> base gets new intro, still keeps old outro.
    const afterAcceptFirst = applyDiffHunk(base, hunks[0])
    expect(afterAcceptFirst).toContain(`new intro`)
    expect(afterAcceptFirst).toContain(`old outro`)

    // Remaining diff between afterAcceptFirst and proposed has 1 hunk (outro).
    const remaining = computeArticleDiffHunks(afterAcceptFirst, proposed)
    expect(remaining).toHaveLength(1)

    // Reject remaining hunk -> proposed reverts back to afterAcceptFirst -> 0 hunks left.
    const afterRejectSecond = rejectDiffHunk(proposed, remaining[0])
    expect(afterRejectSecond).toBe(afterAcceptFirst)
    expect(computeArticleDiffHunks(afterAcceptFirst, afterRejectSecond)).toEqual([])
  })

  it(`marks fenced code lines as monospace`, () => {
    const base = `## Example\nold line`
    const proposed = `## Example\n\`\`\`json\n{ "ok": true }\n\`\`\``
    const hunks = computeArticleDiffHunks(base, proposed)
    expect(hunks).toHaveLength(1)
    const jsonLine = hunks[0].lines.find(l => l.text.includes(`"ok"`))
    expect(jsonLine?.mono).toBe(true)
  })
})
