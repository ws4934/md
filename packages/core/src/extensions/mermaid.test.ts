import { afterEach, describe, expect, it, vi } from 'vitest'
import { initRenderer } from '../renderer/renderer-impl'
import { MD_DIAGRAM_STATE, MD_DIAGRAM_STATE_ATTR } from '../utils/asyncDiagramState'
import { renderMarkdown } from '../utils/markdownHelpers'
import { clearMermaidCache } from './mermaid'

const mermaid = vi.hoisted(() => {
  let release: (() => void) | undefined
  let gate = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    initialize: vi.fn(),
    render: vi.fn(async (id: string, code: string) => {
      await gate
      if (code.includes(`BROKEN`))
        throw new Error(`syntax error`)
      return { svg: `<svg id="${id}" viewBox="0 0 10 10"></svg>` }
    }),
    release: () => release!(),
    resetGate: () => {
      gate = new Promise<void>((resolve) => {
        release = resolve
      })
    },
  }
})

vi.mock(`mermaid`, () => ({
  default: { initialize: mermaid.initialize, render: mermaid.render },
}))

function render(md: string): string {
  return renderMarkdown(md, initRenderer({ themeMode: `light` })).html
}

describe(`mermaid extension`, () => {
  afterEach(() => {
    document.body.innerHTML = ``
    clearMermaidCache()
    mermaid.render.mockClear()
    mermaid.resetGate()
  })

  it(`shares a pending render so re-renders cannot clash on the element id`, async () => {
    const markdown = `\`\`\`mermaid\ngraph TD\n  A --> B\n\`\`\``
    const host = document.createElement(`div`)
    document.body.append(host)

    host.innerHTML = render(markdown)
    host.innerHTML = render(markdown)
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalled())
    mermaid.release()

    await vi.waitFor(() => expect(host.querySelector(`.mermaid-diagram svg`)).not.toBeNull())
    expect(mermaid.render).toHaveBeenCalledTimes(1)
    expect(render(markdown)).toContain(`viewBox="0 0 10 10"`)
  })

  it(`hydrates all duplicate identical mermaid blocks with a single render call`, async () => {
    const block = `\`\`\`mermaid\ngraph LR\n  X --> Y\n\`\`\``
    const markdown = `${block}\n\n${block}`
    const host = document.createElement(`div`)
    document.body.append(host)

    host.innerHTML = render(markdown)
    expect(host.querySelectorAll(`.mermaid-diagram`)).toHaveLength(2)

    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
    mermaid.release()

    await vi.waitFor(() => {
      const svgs = host.querySelectorAll(`.mermaid-diagram svg`)
      expect(svgs).toHaveLength(2)
    })
    const states = Array.from(host.querySelectorAll(`.mermaid-diagram`)).map(el => el.getAttribute(MD_DIAGRAM_STATE_ATTR))
    expect(states).toEqual([MD_DIAGRAM_STATE.ready, MD_DIAGRAM_STATE.ready])
    expect(mermaid.render).toHaveBeenCalledTimes(1)
  })

  it(`caches deterministic mermaid errors so unrelated re-renders do not re-run mermaid.render`, async () => {
    const errSpy = vi.spyOn(console, `error`).mockImplementation(() => {})
    try {
      const broken = `\`\`\`mermaid\nBROKEN_SYNTAX\n\`\`\``
      const host = document.createElement(`div`)
      document.body.append(host)

      host.innerHTML = render(broken)
      await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))
      mermaid.release()

      await vi.waitFor(() => {
        expect(host.querySelector(`.mermaid-diagram`)?.getAttribute(MD_DIAGRAM_STATE_ATTR)).toBe(MD_DIAGRAM_STATE.error)
      })

      // Subsequent re-render must serve cached error state without calling mermaid.render again.
      const secondHtml = render(broken)
      expect(secondHtml).toContain(`${MD_DIAGRAM_STATE_ATTR}="${MD_DIAGRAM_STATE.error}"`)
      expect(secondHtml).toContain(`syntax error`)
      expect(mermaid.render).toHaveBeenCalledTimes(1)
    }
    finally {
      errSpy.mockRestore()
    }
  })
})
