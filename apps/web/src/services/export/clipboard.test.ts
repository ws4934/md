// @vitest-environment jsdom
import fs from 'node:fs'
import path from 'node:path'
import { initRenderer } from '@md/core/renderer'
import { applyTheme } from '@md/core/theme'
import { modifyHtmlContent } from '@md/core/utils'
import { defaultStyleConfig } from '@md/shared/configs'
import juice from 'juice'
import { describe, expect, it } from 'vitest'
import { applyWeChatCssVarReplacements, applyWeChatStructureFixes, modifyHtmlStructure, modifyHtmlStructureInPlace, promoteSvgHtmlLabels, resolveColorMix, sanitizeHtmlCssForJuice, solveWeChatImage, stripInvalidCssForJuice } from './clipboard-dom'
import { getStylesToAdd } from './share-styles'

describe(`modifyHtmlStructure`, () => {
  it(`moves nested lists out of their parent li`, () => {
    const input = `<ul><li>Item<ul><li>Nested</li></ul></li></ul>`
    const output = modifyHtmlStructure(input)

    const root = document.createElement(`div`)
    root.innerHTML = output

    const outerUl = root.querySelector(`ul`)
    expect(outerUl).not.toBeNull()
    expect(outerUl?.children).toHaveLength(2)
    expect(outerUl?.children[0].tagName).toBe(`LI`)
    expect(outerUl?.children[0].querySelector(`ul`)).toBeNull()
    expect(outerUl?.children[1].tagName).toBe(`UL`)
    expect(outerUl?.children[1].textContent).toContain(`Nested`)
  })

  it(`moves nested ordered lists the same way`, () => {
    const input = `<ol><li>One<ol><li>Two</li></ol></li></ol>`
    const output = modifyHtmlStructure(input)

    const root = document.createElement(`div`)
    root.innerHTML = output
    const outerOl = root.querySelector(`ol`)
    expect(outerOl?.children[1].tagName).toBe(`OL`)
  })
})

describe(`solveWeChatImage`, () => {
  it(`converts numeric width/height attributes into px styles`, () => {
    const container = document.createElement(`div`)
    container.innerHTML = `<img width="120" height="80" src="https://example.com/a.png">`
    document.body.appendChild(container)

    solveWeChatImage(container)

    const img = container.querySelector(`img`)!
    expect(img.getAttribute(`width`)).toBeNull()
    expect(img.getAttribute(`height`)).toBeNull()
    expect(img.style.width).toBe(`120px`)
    expect(img.style.height).toBe(`80px`)

    container.remove()
  })

  it(`keeps non-numeric dimension values as-is in style`, () => {
    const container = document.createElement(`div`)
    container.innerHTML = `<img width="50%" height="auto" src="https://example.com/a.png">`
    document.body.appendChild(container)

    solveWeChatImage(container)

    const img = container.querySelector(`img`)!
    expect(img.style.width).toBe(`50%`)
    expect(img.style.height).toBe(`auto`)

    container.remove()
  })
})

describe(`stripInvalidCssForJuice`, () => {
  it(`removes mermaid edge styles that are only undefined`, () => {
    const root = document.createElement(`div`)
    root.innerHTML = `<svg><path style="undefined;" d="M0 0"></path><path style="undefined;;;undefined" d="M1 1"></path></svg>`

    stripInvalidCssForJuice(root)

    expect(root.querySelectorAll(`[style]`)).toHaveLength(0)
  })

  it(`keeps valid declarations and drops undefined values`, () => {
    const root = document.createElement(`div`)
    root.innerHTML = `<path style="fill:#fff;stroke:undefined;stroke-width:1.5"></path>`

    stripInvalidCssForJuice(root)

    expect(root.querySelector(`path`)?.getAttribute(`style`)).toBe(`fill:#fff; stroke-width:1.5`)
  })

  it(`strips undefined declarations from embedded stylesheets`, () => {
    const root = document.createElement(`div`)
    root.innerHTML = `<style>#n{fill:#fff;stroke:undefined;color:#333}</style>`

    stripInvalidCssForJuice(root)

    expect(root.querySelector(`style`)?.textContent).toBe(`#n{fill:#fff;color:#333}`)
  })

  it(`lets juice parse mermaid HTML that previously threw Unknown word undefined`, async () => {
    const { default: juice } = await import(`juice`)
    const root = document.createElement(`div`)
    root.innerHTML = `<div><svg><path class="edge" style="undefined;;;undefined" d="M0 0"></path></svg></div>`

    stripInvalidCssForJuice(root)

    expect(() => juice(root.innerHTML, {
      inlinePseudoElements: true,
      preserveImportant: true,
      resolveCSSVariables: false,
    })).not.toThrow()
  })

  it(`quotes unquoted Open Sans so juice does not throw Unknown word Open`, async () => {
    const { default: juice } = await import(`juice`)
    const root = document.createElement(`div`)
    root.innerHTML = `<svg><path style="fill: #1168BD;stroke: #0B4884;color: #FFFFFF;font-family:Open Sans, sans-serif"></path></svg>`

    stripInvalidCssForJuice(root)

    const style = root.querySelector(`path`)?.getAttribute(`style`) ?? ``
    expect(style).toContain(`sans-serif`)
    expect(style).toMatch(/['"]Open Sans['"]/)
    expect(() => juice(sanitizeHtmlCssForJuice(root.innerHTML), {
      inlinePseudoElements: true,
      preserveImportant: true,
      resolveCSSVariables: false,
    })).not.toThrow()
  })

  it(`quotes Open Sans in the HTML string after browsers drop style quotes`, async () => {
    const { default: juice } = await import(`juice`)
    const html = `<svg><path style="fill: #1168BD;stroke: #0B4884;color: #FFFFFF;font-family:Open Sans, sans-serif"></path></svg>`

    const sanitized = sanitizeHtmlCssForJuice(html)
    expect(sanitized).toContain(`sans-serif`)
    expect(sanitized).toMatch(/['"]Open Sans['"]/)
    expect(() => juice(sanitized, {
      inlinePseudoElements: true,
      preserveImportant: true,
      resolveCSSVariables: false,
    })).not.toThrow()
  })

  it(`quotes sequence/C4 text styles that juice reports at column 43`, async () => {
    const { default: juice } = await import(`juice`)
    const html = `<svg><text style="dominant-baseline:central;font-family:Open Sans,sans-serif" font-family="Open Sans, sans-serif">A</text></svg>`

    const sanitized = sanitizeHtmlCssForJuice(html)
    expect(sanitized).toMatch(/['"]Open Sans['"]/)
    expect(() => juice(sanitized, {
      inlinePseudoElements: true,
      preserveImportant: true,
      resolveCSSVariables: false,
    })).not.toThrow()
  })

  it(`keeps editor serif stack so WeChat copy does not fall back to sans-serif`, async () => {
    const { default: juice } = await import(`juice`)
    const serif = `Optima-Regular, Optima, PingFangSC-light, PingFangTC-light, 'PingFang SC', Cambria, Cochin, Georgia, Times, 'Times New Roman', serif`
    const html = `<style>p{font-family:${serif}}</style><p>hello</p>`

    const sanitized = sanitizeHtmlCssForJuice(html)
    expect(sanitized).toMatch(/PingFang SC/)
    expect(sanitized).toMatch(/\bserif\b/)
    expect(sanitized).not.toMatch(/sans-serif/)

    const inlined = juice(sanitized, {
      inlinePseudoElements: true,
      preserveImportant: true,
      resolveCSSVariables: false,
    })
    expect(inlined).toMatch(/PingFang SC/)
    expect(inlined).toMatch(/\bserif\b/)
    expect(inlined).not.toMatch(/sans-serif/)
  })

  it(`quotes editor sans-serif stack without dropping PingFang / YaHei`, () => {
    const sans = `-apple-system-font,BlinkMacSystemFont, Helvetica Neue, PingFang SC, Hiragino Sans GB , Microsoft YaHei UI , Microsoft YaHei ,Arial,sans-serif`
    const html = `<style>p{font-family:${sans}}</style><p>hello</p>`

    const sanitized = sanitizeHtmlCssForJuice(html)
    expect(sanitized).toMatch(/['"]PingFang SC['"]/)
    expect(sanitized).toMatch(/['"]Microsoft YaHei['"]/)
    expect(sanitized).toMatch(/['"]Helvetica Neue['"]/)
    expect(sanitized).toMatch(/sans-serif/)
  })
})

describe(`promoteSvgHtmlLabels`, () => {
  it(`turns mermaid foreignObject labels into WeChat <section> nodes`, () => {
    const root = document.createElement(`div`)
    root.className = `mermaid-diagram`
    root.innerHTML = `
      <svg>
        <g class="label">
          <foreignObject>
            <div style="display: table;">
              <span class="nodeLabel">决策</span>
            </div>
          </foreignObject>
        </g>
        <g class="name">
          <foreignObject>
            <div xmlns="http://www.w3.org/1999/xhtml" style="color:#333">
              <span>用户</span>
            </div>
          </foreignObject>
        </g>
      </svg>
    `

    promoteSvgHtmlLabels(root)

    const sections = root.querySelectorAll(`section`)
    expect(sections).toHaveLength(2)
    expect(sections[0].textContent).toContain(`决策`)
    expect(sections[1].textContent).toContain(`用户`)
    expect(root.querySelector(`foreignObject section`)).not.toBeNull()
  })
})

describe(`juice + sanitize flowchart pipeline`, () => {
  it(`keeps node colors and unfilled edges after juice inlines mermaid CSS`, async () => {
    const { default: juice } = await import(`juice`)
    const { sanitizeSvgsForWeChat } = await import(`./wechat-svg`)

    const root = document.createElement(`div`)
    root.innerHTML = `
      <div class="mermaid-diagram">
        <svg id="mermaid-svg-td" viewBox="0 0 240 160" xmlns="http://www.w3.org/2000/svg">
          <style>
            #mermaid-svg-td .node rect,#mermaid-svg-td .node polygon{fill:#ECECFF;stroke:#9370DB;}
            #mermaid-svg-td .flowchart-link{fill:none;stroke:#333333;stroke-width:1.5px;}
          </style>
          <g class="node">
            <polygon points="40,10 70,40 40,70 10,40"></polygon>
          </g>
          <g class="node">
            <rect x="120" y="20" width="80" height="40"></rect>
          </g>
          <path class="flowchart-link" fill="none" d="M70 40h50"></path>
        </svg>
      </div>
    `

    stripInvalidCssForJuice(root)
    root.innerHTML = juice(root.innerHTML, {
      inlinePseudoElements: true,
      preserveImportant: true,
      resolveCSSVariables: false,
    })
    document.body.appendChild(root)
    sanitizeSvgsForWeChat(root)

    const polygon = root.querySelector(`polygon`)!
    const rect = root.querySelector(`rect`)!
    const path = root.querySelector(`path`)!
    expect(polygon.getAttribute(`fill`)?.toLowerCase()).toMatch(/#ececff|rgb\(236,\s*236,\s*255\)/)
    expect(rect.getAttribute(`fill`)?.toLowerCase()).toMatch(/#ececff|rgb\(236,\s*236,\s*255\)/)
    expect(path.getAttribute(`fill`)).toBe(`none`)
    expect(path.getAttribute(`stroke`)).toBe(`currentColor`)
    expect(root.querySelector(`svg style`)).toBeNull()
    expect(root.querySelector(`svg[class], svg [class]`)).toBeNull()

    root.remove()
  })
})

describe(`applyWeChatStructureFixes`, () => {
  it(`keeps heading labels inside the column and leaves code and table scrolling intact`, () => {
    const root = document.createElement(`div`)
    root.innerHTML = `
      <h2 style="display: table; margin: 2em auto; background: rgb(0, 128, 0);">进阶技巧</h2>
      <section style="max-width: 100%; overflow: auto;">
        <table style="min-width: 100%;">
          <th style="width: 240px; word-break: keep-all;">邮箱</th>
          <td style="word-break: keep-all;">contact@yanglibin.info</td>
        </table>
      </section>
      <pre class="hljs code__pre" style="overflow-x: auto; width: 100%; margin: 10px 8px;">
        <code style="display: -webkit-box; white-space: nowrap;">console.log('Hello')</code>
      </pre>
      <blockquote style="border-left: 4px solid rgb(0, 128, 0); background: rgb(247, 247, 247); padding: 1em;">
        <p style="margin: 0;">引用</p>
        <blockquote style="border-left: 4px solid rgb(0, 128, 0);">嵌套</blockquote>
      </blockquote>
    `

    applyWeChatStructureFixes(root)

    const heading = root.querySelector(`h2`)!
    expect(heading.style.display).toBe(`block`)
    expect(heading.style.width).toBe(`fit-content`)
    expect(heading.style.maxWidth).toBe(`100%`)
    expect(heading.style.marginLeft).toBe(`auto`)
    expect(heading.style.marginRight).toBe(`auto`)

    const table = root.querySelector(`table`)!
    expect(table.getAttribute(`data-ignore-width`)).toBe(``)
    expect(table.parentElement?.getAttribute(`data-ignore-width`)).toBe(``)
    expect(table.style.tableLayout).toBe(``)
    expect(root.querySelector(`th`)!.style.wordBreak).toBe(`keep-all`)
    expect(root.querySelector(`th`)!.style.width).toBe(`240px`)

    const code = root.querySelector(`code`)!
    expect(code.style.whiteSpace).toBe(`nowrap`)
    expect(code.style.display).toBe(`-webkit-box`)
    const pre = root.querySelector(`pre`)!
    expect(pre.getAttribute(`data-ignore-width`)).toBe(``)
    expect(pre.style.overflowX).toBe(`auto`)
    expect(pre.style.width).toBe(`auto`)

    expect(root.querySelector(`blockquote`)).toBeNull()
    const quotes = [...root.querySelectorAll(`section`)].filter(section => section.style.borderLeftWidth === `4px`)
    expect(quotes).toHaveLength(2)
    expect(quotes[0].querySelector(`p`)!.textContent).toBe(`引用`)
    expect(quotes[1].textContent).toBe(`嵌套`)
  })

  it(`lifts line-height 0 off text, and leaves spacers and formulas alone`, () => {
    const root = document.createElement(`div`)
    root.innerHTML = `
      <section style="line-height: 0; font-size: 0;">图表标签</section>
      <p style="font-size: 0; line-height: 0; margin: 0;">&nbsp;</p>
      <span class="katex" style="line-height: 0;">x</span>
    `

    applyWeChatStructureFixes(root)

    const diagram = root.querySelector(`section`)!
    expect(diagram.style.lineHeight).toBe(`normal`)
    expect(diagram.style.fontSize).toBe(``)
    expect(root.querySelector(`p`)!.style.lineHeight).toBe(`0`)
    expect((root.querySelector(`.katex`) as HTMLElement).style.lineHeight).toBe(`0`)
  })
})

describe(`layout components on WeChat copy`, () => {
  it(`keep their decorative elements, sized and coloured by inline styles, with a WeChat placeholder`, async () => {
    const vars = {
      primaryColor: `#0F4C81`,
      fontFamily: defaultStyleConfig.fontFamily,
      fontSize: defaultStyleConfig.fontSize,
      lineHeight: defaultStyleConfig.lineHeight,
      blockSpacing: defaultStyleConfig.blockSpacing,
    }
    // Vitest stubs `?raw` CSS imports with empty strings, so read the theme file directly
    const defaultCss = fs.readFileSync(path.resolve(__dirname, `../../../../../packages/shared/src/configs/theme-css/default.css`), `utf8`)
    await applyTheme({ themeName: `default`, themeCSS: defaultCss, variables: vars })

    const root = document.createElement(`div`)
    root.innerHTML = modifyHtmlContent([`<LeadQuote>导语</LeadQuote>`, `<Divider />`, `<EndMark />`].join(`\n\n`), initRenderer({}))

    // Same steps as processClipboardContent
    stripInvalidCssForJuice(root)
    const html = (await getStylesToAdd()) + root.innerHTML
    const inlined = juice(sanitizeHtmlCssForJuice(html), { inlinePseudoElements: true, preserveImportant: true, resolveCSSVariables: false })
    root.innerHTML = applyWeChatCssVarReplacements(inlined, vars)
    modifyHtmlStructureInPlace(root)
    applyWeChatStructureFixes(root)

    const decor = root.querySelectorAll(`.md-lead-mark, .md-divider-line, .md-divider-dot, .md-end-line`)
    expect(decor).toHaveLength(7)
    for (const el of decor) {
      expect(el.children).toHaveLength(1)
      expect(el.firstElementChild!.localName).toBe(`svg`)
      expect(el.firstElementChild!.getAttribute(`style`)).toContain(`width:0`)
      expect(el.textContent).toBe(``)
      const style = el.getAttribute(`style`) ?? ``
      expect(style).toMatch(/(?:^|;)\s*width:\s*\S/)
      expect(style).toMatch(/(?:^|;)\s*height:\s*\S/)
      expect(style).toMatch(/(?:^|;)\s*background:\s*\S/)
      expect(style).not.toContain(`var(`)
    }
    expect(root.querySelector(`.md-lead-mark`)!.getAttribute(`style`)).toContain(`#0F4C81`)
  })
})

describe(`resolveColorMix`, () => {
  it(`mixes a color with transparent into rgba`, () => {
    expect(resolveColorMix(`<p style="background: color-mix(in srgb, #009874 10%, transparent);">x</p>`))
      .toBe(`<p style="background: rgba(0, 152, 116, 0.1);">x</p>`)
  })

  it(`mixes two opaque colors into hex and defaults missing percentages`, () => {
    expect(resolveColorMix(`<p style="color: color-mix(in srgb, #ffffff 50%, #000000);">x</p>`))
      .toBe(`<p style="color: #808080;">x</p>`)
    expect(resolveColorMix(`<p style="color: color-mix(in srgb, white, black);">x</p>`))
      .toBe(`<p style="color: #808080;">x</p>`)
  })

  it(`resolves nested mixes and mixes inside gradients`, () => {
    expect(resolveColorMix(`<span style="background-image: linear-gradient(transparent 58%, color-mix(in srgb, color-mix(in srgb, #0F4C81 50%, #ffffff) 20%, transparent) 58%);"></span>`))
      .toBe(`<span style="background-image: linear-gradient(transparent 58%, rgba(135, 166, 192, 0.2) 58%);"></span>`)
  })

  it(`accepts rgb() and hsl() arguments`, () => {
    expect(resolveColorMix(`<p style="color: color-mix(in srgb, rgb(255, 0, 0) 50%, hsl(240 100% 50%));">x</p>`))
      .toBe(`<p style="color: #800080;">x</p>`)
  })

  it(`leaves unresolvable mixes and text outside style attributes untouched`, () => {
    const unresolved = `<p style="color: color-mix(in srgb, hsl(var(--background)) 50%, transparent);">x</p>`
    expect(resolveColorMix(unresolved)).toBe(unresolved)
    const code = `<code>color-mix(in srgb, #fff 50%, #000)</code>`
    expect(resolveColorMix(code)).toBe(code)
  })

  it(`removes every color-mix from a real theme export`, async () => {
    const vars = {
      primaryColor: `#009874`,
      fontFamily: defaultStyleConfig.fontFamily,
      fontSize: defaultStyleConfig.fontSize,
      lineHeight: defaultStyleConfig.lineHeight,
      blockSpacing: defaultStyleConfig.blockSpacing,
    }
    const themeDir = path.resolve(__dirname, `../../../../../packages/shared/src/configs/theme-css`)
    const themeCss = [`default.css`, `fresh.css`].map(file => fs.readFileSync(path.join(themeDir, file), `utf8`)).join(`\n`)
    await applyTheme({ themeName: `fresh`, themeCSS: themeCss, variables: vars })

    const root = document.createElement(`div`)
    root.innerHTML = modifyHtmlContent([
      `<LeadQuote>导语</LeadQuote>`,
      `正文里有**加粗**和++下划线++。`,
      `<StatCard value="12500" unit="元" label="每月固定开销" />`,
      `<CompareCard before="以前" after="现在" />`,
    ].join(`\n\n`), initRenderer({}))
    stripInvalidCssForJuice(root)
    const html = (await getStylesToAdd()) + root.innerHTML
    const inlined = juice(sanitizeHtmlCssForJuice(html), { inlinePseudoElements: true, preserveImportant: true, resolveCSSVariables: false })
    const output = applyWeChatCssVarReplacements(inlined, vars)

    expect(output).toContain(`rgba(0, 152, 116,`)
    expect(output).not.toContain(`color-mix(`)
  })
})

describe(`built-in themes on WeChat copy`, () => {
  const themeDir = path.resolve(__dirname, `../../../../../packages/shared/src/configs/theme-css`)
  const themes = fs.readdirSync(themeDir).filter(file => file.endsWith(`.css`) && file !== `base.css`).map(file => file.replace(/\.css$/, ``))
  const sample = [
    `<LeadQuote>导语</LeadQuote>`,
    `> 引用`,
    `正文里有**加粗**、++下划线++、==高亮==和**++重点++**。`,
    `![图注](https://example.com/a.png)`,
    `<Divider />`,
    `<Divider text="后来" />`,
    `<StatCard value="12500" unit="元" label="每月固定开销" note="房贷 6200" />`,
    `<CompareCard before="以前" after="现在" />`,
    `<QuoteCard source="出处">一句话</QuoteCard>`,
    `<SourceList items='["作者《书名》，2024年"]' />`,
    `<EndMark />`,
  ].join(`\n\n`)

  it.each(themes)(`%s leaves no CSS variables or color-mix in the copied HTML`, async (theme) => {
    const vars = {
      primaryColor: `#0F4C81`,
      fontFamily: defaultStyleConfig.fontFamily,
      fontSize: defaultStyleConfig.fontSize,
      lineHeight: defaultStyleConfig.lineHeight,
      blockSpacing: defaultStyleConfig.blockSpacing,
    }
    const files = theme === `default` ? [`default.css`] : [`default.css`, `${theme}.css`]
    const themeCss = files.map(file => fs.readFileSync(path.join(themeDir, file), `utf8`)).join(`\n`)
    await applyTheme({ themeName: theme, themeCSS: themeCss, variables: vars })

    const root = document.createElement(`div`)
    root.innerHTML = modifyHtmlContent(sample, initRenderer({ legend: `alt` }))
    stripInvalidCssForJuice(root)
    const html = (await getStylesToAdd()) + root.innerHTML
    const inlined = juice(sanitizeHtmlCssForJuice(html), { inlinePseudoElements: true, preserveImportant: true, resolveCSSVariables: false })
    const output = applyWeChatCssVarReplacements(inlined, vars)

    expect(output).not.toMatch(/var\(/)
    expect(output).not.toContain(`color-mix(`)
  })
})
