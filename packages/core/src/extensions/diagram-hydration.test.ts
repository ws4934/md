import { afterEach, describe, expect, it, vi } from 'vitest'
import { hljs, initRenderer } from '../renderer/renderer-impl'
import { MD_DIAGRAM_STATE, MD_DIAGRAM_STATE_ATTR } from '../utils/asyncDiagramState'
import { highlightPendingBlocks } from '../utils/languages'
import { renderMarkdown } from '../utils/markdownHelpers'
import { clearInfographicCache, hydratePendingInfographicDiagrams } from './infographic'
import { clearPlantUmlCache, hydratePendingPlantUmlDiagrams } from './plantuml'

const infographicMock = vi.hoisted(() => {
  let failNext = false
  const renderCalls = vi.fn()
  class MockInfographic {
    private onLoaded?: (payload: { node: SVGSVGElement }) => void
    on(event: string, cb: (payload: { node: SVGSVGElement }) => void) {
      if (event === `loaded`)
        this.onLoaded = cb
    }

    render(code: string) {
      renderCalls(code)
      if (failNext || code.includes(`BROKEN`))
        throw new Error(`infographic parse failed`)
      const svg = document.createElementNS(`http://www.w3.org/2000/svg`, `svg`)
      svg.setAttribute(`data-code`, code)
      this.onLoaded?.({ node: svg })
    }
  }
  return {
    Infographic: MockInfographic,
    setDefaultFont: vi.fn(),
    setFontExtendFactor: vi.fn(),
    exportToSVG: vi.fn(async (node: SVGSVGElement) => node),
    renderCalls,
    setFailNext: (v: boolean) => { failNext = v },
  }
})

vi.mock(`@antv/infographic`, () => ({
  Infographic: infographicMock.Infographic,
  setDefaultFont: infographicMock.setDefaultFont,
  setFontExtendFactor: infographicMock.setFontExtendFactor,
  exportToSVG: infographicMock.exportToSVG,
}))

describe(`diagram hydration, duplicate placeholders, and error caching`, () => {
  afterEach(() => {
    document.body.innerHTML = ``
    clearPlantUmlCache()
    clearInfographicCache()
    infographicMock.renderCalls.mockClear()
    infographicMock.setFailNext(false)
    vi.restoreAllMocks()
  })

  it(`dedupes concurrent PlantUML fetches, hydrates all duplicates, and preserves data-placeholder`, async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fetchSpy = vi.spyOn(globalThis, `fetch`).mockImplementation(async () => {
      await gate
      return new Response(`<svg viewBox="0 0 20 20"><rect width="20" height="20"/></svg>`, { status: 200 })
    })

    const block = `\`\`\`plantuml\n@startuml\nAlice -> Bob\n@enduml\n\`\`\``
    const html = renderMarkdown(`${block}\n\n${block}`, initRenderer({ themeMode: `light` })).html

    const host = document.createElement(`div`)
    host.innerHTML = html
    document.body.append(host)

    const placeholders = host.querySelectorAll(`.plantuml-diagram`)
    expect(placeholders).toHaveLength(2)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    release()

    await vi.waitFor(() => {
      expect(host.querySelectorAll(`.plantuml-diagram svg`)).toHaveLength(2)
    })
    for (const el of placeholders) {
      expect(el.getAttribute(MD_DIAGRAM_STATE_ATTR)).toBe(MD_DIAGRAM_STATE.ready)
      expect(el.getAttribute(`data-placeholder`)).toMatch(/^plantuml-/)
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Late-mounted placeholder (e.g. remounted preview) hydrates synchronously from svgCache.
    const lateEl = document.createElement(`div`)
    lateEl.className = `plantuml-diagram`
    lateEl.setAttribute(`data-placeholder`, placeholders[0].getAttribute(`data-placeholder`)!)
    lateEl.setAttribute(MD_DIAGRAM_STATE_ATTR, MD_DIAGRAM_STATE.loading)
    lateEl.textContent = `Loading...`
    hydratePendingPlantUmlDiagrams(lateEl)
    expect(lateEl.getAttribute(MD_DIAGRAM_STATE_ATTR)).toBe(MD_DIAGRAM_STATE.ready)
    expect(lateEl.querySelector(`svg`)).not.toBeNull()
  })

  it(`caches failed PlantUML fetches briefly so unrelated re-renders do not re-fetch`, async () => {
    const warnSpy = vi.spyOn(console, `warn`).mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, `fetch`).mockResolvedValue(new Response(`fail`, { status: 500 }))

    const md = `\`\`\`plantuml\n@startuml\nBad -> Diagram\n@enduml\n\`\`\``
    const host = document.createElement(`div`)
    host.innerHTML = renderMarkdown(md, initRenderer({ themeMode: `light` })).html
    document.body.append(host)

    await vi.waitFor(() => {
      expect(host.querySelector(`.plantuml-diagram`)?.getAttribute(MD_DIAGRAM_STATE_ATTR)).toBe(MD_DIAGRAM_STATE.error)
    })
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Unrelated re-render within TTL serves cached error state without refetching,
    // while formatting with the active locale's diagramMessages.
    const nextHtml = renderMarkdown(md, initRenderer({
      themeMode: `light`,
      diagramMessages: {
        mermaidLoading: `...`,
        mermaidError: `err`,
        plantumlLoading: `...`,
        plantumlError: `PlantUML 加载失败（切换语言后）`,
        infographicLoading: `...`,
        infographicError: `err`,
      },
    })).html
    expect(nextHtml).toContain(`${MD_DIAGRAM_STATE_ATTR}="${MD_DIAGRAM_STATE.error}"`)
    expect(nextHtml).toContain(`PlantUML 加载失败（切换语言后）`)
    expect(fetchSpy).toHaveBeenCalledTimes(1)

    // Dark themeMode must forward getThemeMode so dark/light URLs and caches do not collide.
    renderMarkdown(md, initRenderer({ themeMode: `dark` }))
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    expect(fetchSpy.mock.calls[1]?.[0]).not.toBe(fetchSpy.mock.calls[0]?.[0])
    warnSpy.mockRestore()
  })

  it(`hydrates Infographic when root itself is .infographic-diagram, updates duplicates, and caches errors`, async () => {
    const errSpy = vi.spyOn(console, `error`).mockImplementation(() => {})

    // 1. Two identical infographic blocks hydrate both placeholders.
    const block = `\`\`\`infographic\ninfographic list-row-simple\n\`\`\``
    const html = renderMarkdown(`${block}\n\n${block}`, initRenderer({ themeMode: `light` })).html
    const host = document.createElement(`div`)
    host.innerHTML = html
    document.body.append(host)

    await vi.waitFor(() => {
      expect(host.querySelectorAll(`.infographic-diagram svg`)).toHaveLength(2)
    })
    const states = Array.from(host.querySelectorAll(`.infographic-diagram`)).map(el => el.getAttribute(MD_DIAGRAM_STATE_ATTR))
    expect(states).toEqual([MD_DIAGRAM_STATE.ready, MD_DIAGRAM_STATE.ready])
    expect(infographicMock.renderCalls).toHaveBeenCalledTimes(1)

    // 2. Passing the .infographic-diagram element directly as root (as patchPreviewDom addedElements does)
    //    must hydrate root itself from svgCache.
    const key = host.querySelector(`.infographic-diagram`)?.getAttribute(`data-infographic-key`)
    expect(key).toBeTruthy()
    const standalone = document.createElement(`div`)
    standalone.className = `infographic-diagram`
    standalone.setAttribute(`data-infographic-key`, key!)
    standalone.setAttribute(MD_DIAGRAM_STATE_ATTR, MD_DIAGRAM_STATE.loading)
    standalone.textContent = `Loading...`
    document.body.append(standalone)

    hydratePendingInfographicDiagrams(standalone, { themeMode: `light` })
    expect(standalone.querySelector(`svg`)).not.toBeNull()
    expect(standalone.getAttribute(MD_DIAGRAM_STATE_ATTR)).toBe(MD_DIAGRAM_STATE.ready)

    // 3. Broken infographic caches error state and does not re-render on subsequent pass.
    infographicMock.renderCalls.mockClear()
    const broken = `\`\`\`infographic\nBROKEN_INFOGRAPHIC\n\`\`\``
    const brokenHost = document.createElement(`div`)
    brokenHost.innerHTML = renderMarkdown(broken, initRenderer({ themeMode: `light` })).html
    document.body.append(brokenHost)

    await vi.waitFor(() => {
      expect(brokenHost.querySelector(`.infographic-diagram`)?.getAttribute(MD_DIAGRAM_STATE_ATTR)).toBe(MD_DIAGRAM_STATE.error)
    })
    expect(infographicMock.renderCalls).toHaveBeenCalledTimes(1)

    const retryHtml = renderMarkdown(broken, initRenderer({ themeMode: `light` })).html
    expect(retryHtml).toContain(`${MD_DIAGRAM_STATE_ATTR}="${MD_DIAGRAM_STATE.error}"`)
    expect(infographicMock.renderCalls).toHaveBeenCalledTimes(1)
    errSpy.mockRestore()
  })

  it(`highlights a code element passed directly as container to highlightPendingBlocks`, () => {
    const code = document.createElement(`code`)
    code.setAttribute(`data-language-pending`, `typescript`)
    code.setAttribute(`data-raw-code`, `const x: number = 1`)
    code.setAttribute(`data-show-line-number`, `false`)
    code.textContent = `const x: number = 1`

    highlightPendingBlocks(hljs, code)
    expect(code.hasAttribute(`data-language-pending`)).toBe(false)
    expect(code.innerHTML).toContain(`hljs`)
  })

  it(`escapes Infographic error details and sanitizes fetched PlantUML SVG markup before DOM injection`, async () => {
    const errSpy = vi.spyOn(console, `error`).mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, `fetch`).mockResolvedValue(
      new Response(`<svg viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><rect width="10" height="10"/></svg>`, { status: 200 }),
    )

    try {
      // PlantUML async DOM injection strips event handlers and <script>
      const pumlHost = document.createElement(`div`)
      pumlHost.innerHTML = renderMarkdown(`\`\`\`plantuml\n@startuml\nA -> B\n@enduml\n\`\`\``, initRenderer({ themeMode: `light` })).html
      document.body.append(pumlHost)

      await vi.waitFor(() => {
        expect(pumlHost.querySelector(`.plantuml-diagram svg`)).not.toBeNull()
      })
      const pumlSvg = pumlHost.querySelector(`.plantuml-diagram svg`)!
      expect(pumlSvg.hasAttribute(`onload`)).toBe(false)
      expect(pumlHost.querySelector(`script`)).toBeNull()
      expect(fetchSpy).toHaveBeenCalledTimes(1)

      // Infographic error path escapes raw HTML payloads even inside protected comments
      infographicMock.renderCalls.mockImplementationOnce(() => {
        throw new Error(`<img src=x onerror=alert(1)>`)
      })
      const infoMd = `\`\`\`infographic\ninfographic xss-case\n\`\`\``
      const infoHost = document.createElement(`div`)
      infoHost.innerHTML = renderMarkdown(infoMd, initRenderer({ themeMode: `light` })).html
      document.body.append(infoHost)

      await vi.waitFor(() => {
        expect(infoHost.querySelector(`.infographic-diagram`)?.getAttribute(MD_DIAGRAM_STATE_ATTR)).toBe(MD_DIAGRAM_STATE.error)
      })
      expect(infoHost.querySelector(`img`)).toBeNull()
      expect(infoHost.textContent).toContain(`<img src=x onerror=alert(1)>`)

      const cachedInfoHtml = renderMarkdown(infoMd, initRenderer({ themeMode: `light` })).html
      expect(cachedInfoHtml).not.toContain(`<img src=x`)
      expect(cachedInfoHtml).toContain(`&lt;img src=x onerror=alert(1)&gt;`)
    }
    finally {
      fetchSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})
