import { describe, expect, it } from 'vitest'
import readingTime from './readingTime'

describe(`readingTime`, () => {
  it(`handles empty and whitespace-only strings`, () => {
    expect(readingTime(``).words).toBe(0)
    expect(readingTime(`   \n\t\r  `).words).toBe(0)
  })

  it(`counts English words accurately`, () => {
    const res = readingTime(`Hello world from doocs markdown editor`)
    expect(res.words).toBe(6)
    expect(res.minutes).toBeCloseTo(6 / 200)
    expect(res.text).toBe(`1 min read`)
  })

  it(`counts CJK characters and skips trailing CJK punctuation`, () => {
    const res = readingTime(`你好，世界！这是一个测试。`)
    expect(res.words).toBe(10)
  })

  it(`counts mixed CJK and English accurately`, () => {
    const res = readingTime(`使用 Markdown 编写微信公众号文章，支持 KaTeX 公式。`)
    // 使用(2) + Markdown(1) + 编写微信公众号文章(9) + 支持(2) + KaTeX(1) + 公式(2) = 17
    expect(res.words).toBe(17)
  })

  it(`respects custom wordBound and wordsPerMinute options`, () => {
    const res = readingTime(`alpha|beta|gamma`, {
      wordBound: ch => ch === `|` || ch === `\n`,
      wordsPerMinute: 3,
    })
    expect(res.words).toBe(3)
    expect(res.minutes).toBe(1)
  })
})
