import type { IOpts } from '@md/shared/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearMathSvgCache } from '../extensions/katex'
import { initRenderer } from '../renderer/renderer-impl'
import {
  assembleRenderedBlocksHtml,
  clearIncrementalRenderCache,
  renderMarkdownIncremental,
  splitMarkdownBlocks,
} from './incrementalRender'
import { postProcessHtml, renderMarkdown } from './markdownHelpers'

function fingerprintForOpts(opts: IOpts): string {
  return JSON.stringify({
    citeStatus: Boolean(opts.citeStatus),
    countStatus: Boolean(opts.countStatus),
    isMacCodeBlock: Boolean(opts.isMacCodeBlock),
    isShowLineNumber: Boolean(opts.isShowLineNumber),
    legend: opts.legend ?? ``,
    themeMode: opts.themeMode ?? `light`,
    footnoteTitle: opts.renderMessages?.footnoteTitle ?? ``,
  })
}

function renderFullReference(raw: string, opts: IOpts) {
  const refRenderer = initRenderer(opts)
  const { html: baseHtml, readingTime } = renderMarkdown(raw, refRenderer)
  const wrapped = postProcessHtml(baseHtml, readingTime, refRenderer)
  let id = 0
  const html = wrapped.replace(/data-heading="true"/g, () => `data-heading="true" id="${id++}"`)
  return {
    html,
    headings: refRenderer.getHeadings(),
    readingTime,
  }
}

function createPrng(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6D2B79F5) >>> 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const RICH_FIXTURE = `---
title: Incremental Parity Fixture
---

# 主标题 Main Title

[TOC]

## 第一节：**加粗**与\`代码\`标题

普通段落包含 **加粗**、*斜体*、~~删除线~~、==高亮==、++下划线++、~波浪线~、x^2^、Emoji :rocket: :+1:、以及 [漢字]{かんじ} 和 [上海]{shang-hai}。

外部链接 [Doocs](https://doocs.org "Doocs Org")、重复链接 [Doocs Again](https://doocs.org)、微信链接 [MP](https://mp.weixin.qq.com/s/demo)、纯文本链接 [https://same.example](https://same.example)。

> [!NOTE] 自定义提示
> 第一行内容
> 第二行内容

:::tip 多段提示容器
第一段内容

第二段内容包含 [链接2](https://example.com/2)
:::

\`\`\`typescript
export function greet(name: string): string {
  // comment with [ref]: https://fake.example and [^1]
  return \`Hello, \${name}!\`
}
\`\`\`

\`\`\`diff-ts
 const a = 1
-const b = 2
+const b = 3
\`\`\`

- 列表项 A

- 松散列表项 B
  - 嵌套项 B1

1. 有序项 1

2. 有序项 2

    indented code line 1

    indented code line 2

| 列A | 列B | 列C |
| --- | :---: | ---: |
| 1 | 2 | 3 |
| 4 | 5 | 6 |

行内公式 $a^2 + b^2 = c^2$ 以及 LaTeX \\(x + y\\)。

$$
E = mc^2
$$

\\[
\\int_0^1 x^2 dx = \\frac{1}{3}
\\]

![图注示例|320x180](https://example.com/pic.png "图片标题")

<![图1](https://example.com/1.png),![图2](https://example.com/2.png)>

<TipBlock type="success" title="组件" content="内置组件测试" />

---

***

___

Setext 标题
---

### 子标题 1.1

## 第二节：重复内容测试

重复段落

重复段落

重复段落
`

describe(`renderMarkdownIncremental`, () => {
  const originalMathJax = typeof window !== `undefined` ? window.MathJax : undefined

  afterEach(() => {
    if (typeof window !== `undefined`)
      window.MathJax = originalMathJax as typeof window.MathJax
    clearMathSvgCache()
  })

  it(`matches full render byte-for-byte on rich fixture across option combinations`, () => {
    const optionMatrix: IOpts[] = [
      { citeStatus: false, countStatus: false, isMacCodeBlock: false, isShowLineNumber: false, legend: `alt`, themeMode: `light` },
      { citeStatus: true, countStatus: true, isMacCodeBlock: true, isShowLineNumber: true, legend: `alt-title-filename`, themeMode: `dark` },
      { citeStatus: true, countStatus: false, isMacCodeBlock: true, isShowLineNumber: false, legend: `title`, themeMode: `light` },
      { citeStatus: false, countStatus: true, isMacCodeBlock: false, isShowLineNumber: true, legend: `none`, themeMode: `dark` },
    ]

    const renderer = initRenderer({})
    for (const opts of optionMatrix) {
      renderer.reset(opts)
      const inc = renderMarkdownIncremental(RICH_FIXTURE, renderer, fingerprintForOpts(opts))
      const ref = renderFullReference(RICH_FIXTURE, opts)

      expect(inc.usedIncremental).toBe(true)
      expect(assembleRenderedBlocksHtml(inc.blocks)).toBe(ref.html)
      expect(inc.headings).toEqual(ref.headings)
      expect(inc.readingTime).toEqual(ref.readingTime)
    }
  })

  it(`falls back cleanly with byte-for-byte parity for document-scoped constructs`, () => {
    const cases: Array<{ name: string, md: string, expectedReason: string }> = [
      {
        name: `markdown footnotes`,
        md: `Body with note[^1] and second[^2].\n\n[^1]: First note\n[^2]: Second note`,
        expectedReason: `footnotes`,
      },
      {
        name: `link reference definitions`,
        md: `See [the guide][g] for details.\n\n[g]: https://example.com/guide`,
        expectedReason: `link-ref-def`,
      },
      {
        name: `blockquote link reference definition`,
        md: `See [quoted][q].\n\n> [q]: https://example.com/quoted`,
        expectedReason: `link-ref-def`,
      },
      {
        name: `multiline raw HTML spanning blank lines`,
        md: `<div class="box">\n\nInner paragraph\n\n</div>`,
        expectedReason: `multiline-raw-html`,
      },
      {
        name: `raw style tag`,
        md: `<style>.x { color: red; }</style>\n\nParagraph`,
        expectedReason: `raw-html-block`,
      },
      {
        name: `raw HTML comment`,
        md: `<!-- note -->\n\nParagraph after comment`,
        expectedReason: `raw-html-comment`,
      },
    ]

    const opts: IOpts = { citeStatus: true, countStatus: true, isMacCodeBlock: true }
    const renderer = initRenderer(opts)

    for (const testCase of cases) {
      renderer.reset(opts)
      const inc = renderMarkdownIncremental(testCase.md, renderer, fingerprintForOpts(opts))
      const ref = renderFullReference(testCase.md, opts)

      expect(inc.usedIncremental, testCase.name).toBe(false)
      expect(inc.fallbackReason, testCase.name).toBe(testCase.expectedReason)
      expect(assembleRenderedBlocksHtml(inc.blocks), testCase.name).toBe(ref.html)
      expect(inc.headings, testCase.name).toEqual(ref.headings)
    }
  })

  it(`maintains exact byte-for-byte parity across 120 seeded random edits and option flips`, () => {
    const rand = createPrng(20260416)
    const renderer = initRenderer({})
    let opts: IOpts = {
      citeStatus: true,
      countStatus: true,
      isMacCodeBlock: true,
      isShowLineNumber: false,
      legend: `alt`,
      themeMode: `light`,
    }

    let doc = RICH_FIXTURE

    const snippets = [
      `## 动态标题`,
      `### 动态子标题`,
      `新增段落带有 [动态链接](https://example.com/dyn) 和 **强调**。`,
      `重复链接 [Doocs](https://doocs.org) 与新链接 [Other](https://other.example.com/x)。`,
      `\`\`\`js\nconst v = 42\n\`\`\``,
      `- 列表 A\n\n- 列表 B`,
      `> [!WARNING]\n> 警告内容`,
      `[TOC]`,
      `---`,
      `行内公式 $x + y = z$ 和 :tada:`,
      `临时脚注[^tmp]\n\n[^tmp]: 临时内容`,
      `引用 [ref][r1]\n\n[r1]: https://ref.example.com`,
    ]

    for (let step = 0; step < 120; step++) {
      const lines = doc.split(`\n`)
      const op = Math.floor(rand() * 8)

      if (op === 0 && lines.length > 0) {
        // Insert a character inside a random line.
        const idx = Math.floor(rand() * lines.length)
        const line = lines[idx]
        const pos = Math.floor(rand() * (line.length + 1))
        lines[idx] = `${line.slice(0, pos)}X${line.slice(pos)}`
        doc = lines.join(`\n`)
      }
      else if (op === 1 && lines.length > 4) {
        // Delete a random line.
        const idx = Math.floor(rand() * lines.length)
        lines.splice(idx, 1)
        doc = lines.join(`\n`)
      }
      else if (op === 2) {
        // Insert a blank line (split block).
        const idx = Math.floor(rand() * (lines.length + 1))
        lines.splice(idx, 0, ``)
        doc = lines.join(`\n`)
      }
      else if (op === 3) {
        // Insert a structured snippet surrounded by blank lines.
        const idx = Math.floor(rand() * (lines.length + 1))
        const snip = snippets[Math.floor(rand() * snippets.length)]
        lines.splice(idx, 0, ``, `${snip} #${step}`, ``)
        doc = lines.join(`\n`)
      }
      else if (op === 4 && lines.length > 3) {
        // Remove a blank line (merge blocks).
        const blankIdx = lines.findIndex((l, i) => i > 2 && l.trim() === ``)
        if (blankIdx !== -1)
          lines.splice(blankIdx, 1)
        doc = lines.join(`\n`)
      }
      else if (op === 5) {
        // Remove any temporary footnote or link-ref-def to exercise fallback -> incremental recovery.
        doc = lines
          .filter(l => !l.includes(`[^tmp]`) && !l.startsWith(`[r1]:`))
          .join(`\n`)
      }
      else if (op === 6) {
        // Flip renderer options mid-session.
        opts = {
          ...opts,
          citeStatus: rand() > 0.4,
          countStatus: rand() > 0.5,
          isMacCodeBlock: rand() > 0.5,
          isShowLineNumber: rand() > 0.5,
          themeMode: rand() > 0.5 ? `dark` : `light`,
        }
      }
      else {
        // Append or prepend a heading + paragraph.
        const block = `## Added ${step}\n\nParagraph ${step} with [link-${step}](https://example.com/${step})`
        doc = rand() > 0.5 ? `${doc}\n\n${block}` : `${block}\n\n${doc}`
      }

      renderer.reset(opts)
      const inc = renderMarkdownIncremental(doc, renderer, fingerprintForOpts(opts))
      const ref = renderFullReference(doc, opts)

      expect(assembleRenderedBlocksHtml(inc.blocks), `step ${step}`).toBe(ref.html)
      expect(inc.headings, `step ${step} headings`).toEqual(ref.headings)
      expect(inc.readingTime, `step ${step} readingTime`).toEqual(ref.readingTime)
    }
  })

  it(`reuses cached blocks and only re-renders the edited block`, () => {
    const opts: IOpts = { citeStatus: false, countStatus: false }
    const renderer = initRenderer(opts)
    const fp = fingerprintForOpts(opts)
    const blocks = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} with **bold** text.`)
    const doc1 = blocks.join(`\n\n`)

    const spy = vi.spyOn(renderer, `renderBlock`)

    renderer.reset(opts)
    const res1 = renderMarkdownIncremental(doc1, renderer, fp)
    expect(res1.usedIncremental).toBe(true)
    expect(spy).toHaveBeenCalledTimes(40)

    spy.mockClear()

    // Edit only block 20.
    blocks[20] = `Paragraph number 20 EDITED with **bold** text.`
    const doc2 = blocks.join(`\n\n`)
    renderer.reset(opts)
    const res2 = renderMarkdownIncremental(doc2, renderer, fp)
    expect(res2.usedIncremental).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(assembleRenderedBlocksHtml(res2.blocks)).toBe(renderFullReference(doc2, opts).html)

    clearIncrementalRenderCache(renderer)
  })

  it(`does not cache pending async placeholders (katex-pending / data-language-pending)`, () => {
    const opts: IOpts = { citeStatus: false, countStatus: false }
    const renderer = initRenderer(opts)
    const fp = fingerprintForOpts(opts)
    const doc = `Static block\n\nFormula $a + b$ here\n\n\`\`\`unregisteredlang\nfoo()\n\`\`\``

    if (typeof window !== `undefined`)
      window.MathJax = undefined as unknown as typeof window.MathJax

    renderer.reset(opts)
    const pendingRes = renderMarkdownIncremental(doc, renderer, fp)
    const pendingHtml = assembleRenderedBlocksHtml(pendingRes.blocks)
    expect(pendingHtml).toContain(`katex-pending`)
    expect(pendingHtml).toContain(`data-language-pending="unregisteredlang"`)

    // Once MathJax loads, the formula block must NOT be stuck with a stale pending cache entry.
    if (typeof window !== `undefined`) {
      window.MathJax = {
        texReset() {},
        tex2svg(tex: string) {
          const container = document.createElement(`div`)
          const svg = document.createElementNS(`http://www.w3.org/2000/svg`, `svg`)
          svg.appendChild(document.createElementNS(`http://www.w3.org/2000/svg`, `g`))
          svg.textContent = tex
          container.appendChild(svg)
          return container as unknown as ReturnType<MathJaxGlobal[`tex2svg`]>
        },
      }

      const spy = vi.spyOn(renderer, `renderBlock`)
      renderer.reset(opts)
      const settledRes = renderMarkdownIncremental(doc, renderer, fp)
      const settledHtml = assembleRenderedBlocksHtml(settledRes.blocks)

      expect(settledHtml).not.toContain(`katex-pending`)
      expect(settledHtml).toContain(`<svg`)
      // Static block stayed cached; only the two previously pending blocks re-rendered.
      expect(spy).toHaveBeenCalledTimes(2)

      // Next render: formula block is now settled and cached too; only unregistered code block remains uncached.
      spy.mockClear()
      renderer.reset(opts)
      renderMarkdownIncremental(doc, renderer, fp)
      expect(spy).toHaveBeenCalledTimes(1)
    }
  })

  it(`matches full render on tricky edge cases (CRLF, unclosed fences/math/alerts, blockquote headings, multiline components, empty docs)`, () => {
    // Prevent PlantUML inline-svg background fetch from touching the network during unit tests.
    const fetchSpy = vi.spyOn(globalThis, `fetch`).mockImplementation(() => Promise.resolve(new Response(`<svg></svg>`, { status: 200 })))
    const consoleErrSpy = vi.spyOn(console, `error`).mockImplementation(() => {})
    const edgeDocs = [
      ``,
      `   \n\n\t\n`,
      `# Title\r\n\r\nParagraph with [link](https://example.com/a)\r\n\r\n## Sub\r\n\r\nBody`,
      `# Unclosed fence\n\n\`\`\`ts\nconst x = 1\n\nconst y = 2`,
      `# Unclosed math\n\n$$\na + b\n\nc + d`,
      `# Unclosed alert\n\n:::tip Title\nLine 1\n\nLine 2`,
      `[TOC]\n\n# H1\n\n> ## Quoted Heading\n\n## Normal H2\n\n### H3`,
      `<TipBlock type="info" title="Multi">\nFirst line\n\nSecond line\n</TipBlock>\n\nAfter component`,
      `<Emoji id="liulei" alt="流泪" width="20%" align="center" />\n\nInline <Emoji id="liulei" /> text`,
      `Paragraph with <strong>inline</strong> and <br/> tag and <https://autolink.example.com> plus \`<div>unclosed in code\`.\n\nNext paragraph`,
      `\`\`\`mermaid\ngraph LR\n  A --> B\n\`\`\`\n\n\`\`\`plantuml\n@startuml\nAlice -> Bob\n@enduml\n\`\`\`\n\n\`\`\`infographic\ninfographic list-row-simple\n\`\`\``,
    ]

    const opts: IOpts = {
      citeStatus: true,
      countStatus: true,
      isMacCodeBlock: true,
      isShowLineNumber: true,
      legend: `alt-title-filename`,
      themeMode: `light`,
    }
    const renderer = initRenderer(opts)

    try {
      for (let i = 0; i < edgeDocs.length; i++) {
        const md = edgeDocs[i]
        renderer.reset(opts)
        const inc = renderMarkdownIncremental(md, renderer, fingerprintForOpts(opts))
        const ref = renderFullReference(md, opts)

        expect(assembleRenderedBlocksHtml(inc.blocks), `edge doc #${i}`).toBe(ref.html)
        expect(inc.headings, `edge doc #${i} headings`).toEqual(ref.headings)
        expect(inc.readingTime, `edge doc #${i} readingTime`).toEqual(ref.readingTime)
      }
    }
    finally {
      fetchSpy.mockRestore()
      consoleErrSpy.mockRestore()
    }
  })

  it(`splits fenced code, multiline math, alert containers, and loose lists safely`, () => {
    const md = [
      `# Heading`,
      ``,
      `\`\`\`ts`,
      `const a = 1`,
      ``,
      `const b = 2`,
      `\`\`\``,
      ``,
      `- item 1`,
      ``,
      `- item 2`,
      ``,
      `$$`,
      `a + b`,
      ``,
      `c + d`,
      `$$`,
      ``,
      `:::note`,
      `line 1`,
      ``,
      `line 2`,
      `:::`,
      ``,
      `Tail paragraph`,
    ].join(`\n`)

    const split = splitMarkdownBlocks(md)
    expect(split.fallbackReason).toBeUndefined()
    expect(split.blocks).toHaveLength(6)
  })

  it(`runs fallback checks inside unclosed math/alert regions and avoids false inLatexBlock on mid-line or inline-code \\[`, () => {
    const opts: IOpts = { citeStatus: true, countStatus: false }
    const renderer = initRenderer(opts)
    const fp = fingerprintForOpts(opts)

    // 1. Unclosed $$ followed by a link reference definition and reference usage -> fallback + parity.
    const unclosedMathWithRef = [
      `See [docs][docs] first.`,
      ``,
      `$$`,
      `a + b`,
      ``,
      `[docs]: https://example.com/docs`,
    ].join(`\n`)
    renderer.reset(opts)
    const mathRefInc = renderMarkdownIncremental(unclosedMathWithRef, renderer, fp)
    const mathRefFull = renderFullReference(unclosedMathWithRef, opts)
    expect(mathRefInc.usedIncremental).toBe(false)
    expect(mathRefInc.fallbackReason).toBe(`link-ref-def`)
    expect(assembleRenderedBlocksHtml(mathRefInc.blocks)).toBe(mathRefFull.html)

    // 2. ::: alert container with link reference definition inside -> fallback + parity.
    const alertWithRef = [
      `Read [guide][g].`,
      ``,
      `:::note`,
      `[g]: https://example.com/guide`,
      `:::`,
    ].join(`\n`)
    renderer.reset(opts)
    const alertRefInc = renderMarkdownIncremental(alertWithRef, renderer, fp)
    const alertRefFull = renderFullReference(alertWithRef, opts)
    expect(alertRefInc.usedIncremental).toBe(false)
    expect(alertRefInc.fallbackReason).toBe(`link-ref-def`)
    expect(assembleRenderedBlocksHtml(alertRefInc.blocks)).toBe(alertRefFull.html)

    // 3a. Prose with unmatched `\[` or inline code `\[` or `[^0-9]+` stays incremental across all blocks.
    const proseWithLatexChars = [
      `Escaped \\[ in prose stays inline, and regex \`[^0-9]+\` stays incremental.`,
      ``,
      `Inline code \`\\[\` also stays inline.`,
      ``,
      `Paragraph 3.`,
      ``,
      `Paragraph 4.`,
      ``,
      `Paragraph 5.`,
    ].join(`\n`)
    const split = splitMarkdownBlocks(proseWithLatexChars)
    expect(split.fallbackReason).toBeUndefined()
    expect(split.blocks).toHaveLength(5)

    renderer.reset(opts)
    const proseInc = renderMarkdownIncremental(proseWithLatexChars, renderer, fp)
    const proseFull = renderFullReference(proseWithLatexChars, opts)
    expect(proseInc.usedIncremental).toBe(true)
    expect(assembleRenderedBlocksHtml(proseInc.blocks)).toBe(proseFull.html)

    // 3b. Mid-line `\[` or trailing `\[` after `\[...\]` WITH a later `\]` keeps exact parity with marked/MDKatex.
    const pairedLatexAcrossBlankLines = [
      `Prefix \\[ in prose before later close`,
      ``,
      `still inside latex \\]`,
      ``,
      `\\[a = 1\\] \\[`,
      `b = 2`,
      ``,
      `c = 3`,
      `\\]`,
      ``,
      `Trailing paragraph.`,
    ].join(`\n`)
    renderer.reset(opts)
    const pairedInc = renderMarkdownIncremental(pairedLatexAcrossBlankLines, renderer, fp)
    const pairedFull = renderFullReference(pairedLatexAcrossBlankLines, opts)
    expect(pairedInc.usedIncremental).toBe(true)
    expect(assembleRenderedBlocksHtml(pairedInc.blocks)).toBe(pairedFull.html)
  })

  it(`keeps [TOC] inside blockquotes, lists, and alert containers identical to full render`, () => {
    const opts: IOpts = { citeStatus: false, countStatus: false }
    const renderer = initRenderer(opts)
    const fp = fingerprintForOpts(opts)

    const cases = [
      `# Title\n\n> [TOC]\n\n## Alpha\n\n### Beta`,
      `# Title\n\n- [TOC]\n\n## Alpha\n\n## Gamma`,
      `# Title\n\n1. [TOC]\n\n## First\n\n### Nested`,
      `# Title\n\n:::note\n[TOC]\n:::\n\n## Inside Alert`,
    ]

    for (const md of cases) {
      renderer.reset(opts)
      const inc = renderMarkdownIncremental(md, renderer, fp)
      const ref = renderFullReference(md, opts)
      const incHtml = assembleRenderedBlocksHtml(inc.blocks)

      expect(incHtml).toContain(`markdown-toc`)
      expect(incHtml).toBe(ref.html)
      expect(inc.headings).toEqual(ref.headings)
    }
  })

  it(`splits large documents with thousands of unmatched \\[ tokens in linear time`, () => {
    const md = Array.from(
      { length: 15_000 },
      (_, i) => `Paragraph ${i}: regex \\[a-z\\+ without closing bracket`,
    ).join(`\n\n`)
    const t0 = performance.now()
    const res = splitMarkdownBlocks(md)
    const elapsedMs = performance.now() - t0
    expect(res.fallbackReason).toBeUndefined()
    expect(res.blocks).toHaveLength(15_000)
    expect(elapsedMs).toBeLessThan(100)
  })

  it(`keeps multiline component open tags and inner fenced closing tags byte-identical to full render`, () => {
    const customComponents = {
      CodeCard: {
        id: `custom-code-card`,
        name: `CodeCard`,
        description: `Card with children`,
        props: [{ name: `title`, description: `Title` }],
        template: `<section class="code-card"><h4>{{title}}</h4><div>{{children}}</div></section>`,
        example: ``,
      },
      InlineBadge: {
        id: `custom-inline-badge`,
        name: `InlineBadge`,
        description: `Inline badge`,
        inline: true,
        props: [{ name: `label`, description: `Label` }],
        template: `<span>{{label}}</span>`,
        example: ``,
      },
    }
    const opts: IOpts = { citeStatus: false, countStatus: false, components: customComponents }
    const renderer = initRenderer(opts)
    const fp = `${fingerprintForOpts(opts)}:${`x`.repeat(8_000)}`

    const md = [
      `<CodeCard`,
      `  title="Multiline Open Tag"`,
      `>`,
      `First paragraph`,
      ``,
      `\`\`\`html`,
      `</CodeCard>`,
      `\`\`\``,
      ``,
      `Second paragraph`,
      `</CodeCard>`,
      ``,
      `<InlineBadge label="hi" />`,
      ``,
      `Trailing paragraph.`,
    ].join(`\n`)

    const inc = renderMarkdownIncremental(md, renderer, fp)
    const ref = renderFullReference(md, opts)
    expect(inc.usedIncremental).toBe(true)
    expect(assembleRenderedBlocksHtml(inc.blocks)).toBe(ref.html)
  })
})
