// @vitest-environment jsdom
import type { RenderedBlock } from '@md/core/utils'
import { assembleRenderedBlocksHtml } from '@md/core/utils'
import { describe, expect, it } from 'vitest'
import { patchPreviewDom, resetPreviewDomState } from './patch-preview-dom'

function makeOutputEl(): HTMLElement {
  const el = document.createElement(`section`)
  el.id = `output`
  return el
}

describe(`patchPreviewDom`, () => {
  it(`mounts blocks cleanly inside section.container with exact HTML parity`, () => {
    const output = makeOutputEl()
    const blocks: RenderedBlock[] = [
      { key: `b1`, html: `<h1 class="h1" data-heading="true" id="0">Title</h1>` },
      { key: `b2`, html: `<p class="p">First paragraph</p>` },
      { key: `b3`, html: `<div class="mermaid-diagram"><svg><circle r="5"></circle></svg></div>` },
      { key: `b4`, html: `<p class="p">Last paragraph</p>` },
    ]

    const res = patchPreviewDom(output, blocks)
    expect(res.fullReset).toBe(true)
    expect(res.needsHydration).toBe(false)
    expect(output.innerHTML).toBe(assembleRenderedBlocksHtml(blocks))

    resetPreviewDomState(output)
  })

  it(`preserves untouched DOM and SVG node identity when editing another block`, () => {
    const output = makeOutputEl()
    const initial: RenderedBlock[] = [
      { key: `b1`, html: `<h1 class="h1" data-heading="true" id="0">Title</h1>` },
      { key: `b2`, html: `<div class="mermaid-diagram"><svg id="m1"><rect width="10" height="10"></rect></svg></div>` },
      { key: `b3`, html: `<p class="p">Editable paragraph</p>` },
      { key: `b4`, html: `<div class="plantuml-diagram"><svg id="p1"><line x1="0" y1="0" x2="10" y2="10"></line></svg></div>` },
    ]

    patchPreviewDom(output, initial)
    const containerBefore = output.firstElementChild
    const headingBefore = output.querySelector(`h1`)
    const mermaidDivBefore = output.querySelector(`.mermaid-diagram`)
    const mermaidSvgBefore = output.querySelector(`#m1`)
    const plantumlSvgBefore = output.querySelector(`#p1`)

    // Edit only block b3.
    const edited: RenderedBlock[] = [
      initial[0],
      initial[1],
      { key: `b3-edited`, html: `<p class="p">Edited paragraph!</p>` },
      initial[3],
    ]

    const res = patchPreviewDom(output, edited)
    expect(res.fullReset).toBe(false)
    expect(res.needsHydration).toBe(false)
    expect(res.addedElements).toHaveLength(1)
    expect(output.firstElementChild).toBe(containerBefore)
    expect(output.querySelector(`h1`)).toBe(headingBefore)
    expect(output.querySelector(`.mermaid-diagram`)).toBe(mermaidDivBefore)
    expect(output.querySelector(`#m1`)).toBe(mermaidSvgBefore)
    expect(output.querySelector(`#p1`)).toBe(plantumlSvgBefore)
    expect(output.innerHTML).toBe(assembleRenderedBlocksHtml(edited))
  })

  it(`keeps unchanged blocks and SVGs stationary when heading ids shift across the document`, () => {
    const output = makeOutputEl()
    const before: RenderedBlock[] = [
      { key: `h0`, html: `<h2 class="h2" data-heading="true" id="0">Sec 1</h2>` },
      { key: `svg1`, html: `<div class="mermaid-diagram"><svg id="diag-1"></svg></div>` },
      { key: `h1`, html: `<h2 class="h2" data-heading="true" id="1">Sec 2</h2>` },
      { key: `svg2`, html: `<div class="mermaid-diagram"><svg id="diag-2"></svg></div>` },
      { key: `tail`, html: `<p class="p">Tail</p>` },
    ]

    patchPreviewDom(output, before)
    const diag1Before = output.querySelector(`#diag-1`)
    const diag2Before = output.querySelector(`#diag-2`)
    const tailBefore = output.querySelector(`p.p`)

    // Prepend a brand-new heading so Sec 1 -> id="1" and Sec 2 -> id="2".
    const after: RenderedBlock[] = [
      { key: `hnew`, html: `<h2 class="h2" data-heading="true" id="0">Intro</h2>` },
      { key: `h0`, html: `<h2 class="h2" data-heading="true" id="1">Sec 1</h2>` },
      before[1],
      { key: `h1`, html: `<h2 class="h2" data-heading="true" id="2">Sec 2</h2>` },
      before[3],
      before[4],
    ]

    const res = patchPreviewDom(output, after)
    expect(res.fullReset).toBe(false)
    // Both diagrams and tail keep exact live DOM identity.
    expect(output.querySelector(`#diag-1`)).toBe(diag1Before)
    expect(output.querySelector(`#diag-2`)).toBe(diag2Before)
    expect(output.querySelector(`p.p`)).toBe(tailBefore)
    expect(output.innerHTML).toBe(assembleRenderedBlocksHtml(after))
  })

  it(`handles split, delete, duplicate blocks, fallback transitions, and external DOM mutation safely`, () => {
    const output = makeOutputEl()
    const step1: RenderedBlock[] = [
      { key: `a:1`, html: `<p class="p">Same</p>` },
      { key: `b:1`, html: `<p class="p">Middle</p>` },
      { key: `a:2`, html: `<p class="p">Same</p>` },
    ]
    patchPreviewDom(output, step1)
    expect(output.innerHTML).toBe(assembleRenderedBlocksHtml(step1))

    // Split middle into two blocks, one requiring async language highlight hydration.
    const step2: RenderedBlock[] = [
      step1[0],
      { key: `b1`, html: `<p class="p">Middle A</p>` },
      { key: `b2`, html: `<pre class="hljs"><code data-language-pending="rust">fn main() {}</code></pre>` },
      step1[2],
    ]
    const res2 = patchPreviewDom(output, step2)
    expect(res2.fullReset).toBe(false)
    expect(res2.needsHydration).toBe(true)
    expect(output.innerHTML).toBe(assembleRenderedBlocksHtml(step2))

    // Simulate external DOM tampering (detaching a tracked node) -> must self-heal without throwing.
    output.querySelector(`pre`)?.remove()
    const step3: RenderedBlock[] = [
      step1[0],
      { key: `b1`, html: `<p class="p">Middle A</p>` },
      step1[2],
    ]
    const res3 = patchPreviewDom(output, step3)
    expect(res3.fullReset).toBe(true)
    expect(output.innerHTML).toBe(assembleRenderedBlocksHtml(step3))

    // Transition to fallback full-render block and back to incremental.
    const fullFallback: RenderedBlock[] = [
      { key: `full`, html: `<p class="p">Footnotes doc</p><p class="footnotes">note</p>` },
    ]
    expect(patchPreviewDom(output, fullFallback).fullReset).toBe(true)
    expect(output.innerHTML).toBe(assembleRenderedBlocksHtml(fullFallback))

    expect(patchPreviewDom(output, step1).fullReset).toBe(true)
    expect(output.innerHTML).toBe(assembleRenderedBlocksHtml(step1))

    // Empty clears output cleanly.
    patchPreviewDom(output, [])
    expect(output.innerHTML).toBe(``)
  })
})
