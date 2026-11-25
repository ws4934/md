import { describe, expect, it } from 'vitest'
import { findLocalImageRefs, replaceImageRefs } from './workspace-images'

describe(`workspace images`, () => {
  const md = [
    `![chart](images/chart.png "Sales")`,
    `![images/a.png](images/a.png)`,
    `![sp](<images/my chart.png>)`,
    `![web](https://x.com/a.png) ![d](data:image/png;base64,AA) ![e](asset://emoji)`,
    `<![s1](images/s1.png),![s2](https://x.com/s2.png)>`,
  ].join(`\n\n`)

  it(`finds only scheme-less image paths`, () => {
    expect(findLocalImageRefs(md)).toEqual([`images/chart.png`, `images/a.png`, `images/my chart.png`, `images/s1.png`])
  })

  it(`swaps the path but keeps alt text and title`, () => {
    const out = replaceImageRefs(md, new Map([
      [`images/chart.png`, `https://cdn/c.png`],
      [`images/a.png`, `https://cdn/a.png`],
      [`images/my chart.png`, `https://cdn/m.png`],
    ]))
    expect(out).toContain(`![chart](https://cdn/c.png "Sales")`)
    expect(out).toContain(`![images/a.png](https://cdn/a.png)`)
    expect(out).toContain(`![sp](https://cdn/m.png)`)
    expect(out).toContain(`![s1](images/s1.png)`)
  })
})
