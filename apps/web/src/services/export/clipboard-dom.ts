/**
 * Pure clipboard HTML transforms used by WeChat copy flow.
 * Kept free of Pinia/store imports so unit tests can run without app bootstrap.
 */

const GENERIC_FONT_FAMILIES = /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|ui-serif|ui-monospace|ui-rounded|inherit|initial|unset|revert|revert-layer)$/i

/** Mermaid may emit `style="undefined;"` on edges; juice's CSS parser then throws. */
function isUndefinedCssValue(value: string): boolean {
  const normalized = value.replace(/\s*!important$/i, ``).trim()
  return !normalized || /^undefined$/i.test(normalized) || /\bundefined\b/i.test(normalized)
}

function mapFontFamilyName(family: string): string {
  const unquoted = family.replace(/["']/g, ``).trim()
  if (!unquoted)
    return family
  if (/^var\(/i.test(family))
    return family
  if (GENERIC_FONT_FAMILIES.test(unquoted))
    return unquoted
  // Quote multi-word / CJK names so juice/PostCSS can parse them.
  // Do not rewrite them to generic families: a mid-stack `sans-serif`
  // would make later serif fonts unreachable (WeChat copy of the serif preset).
  if (/\s/.test(unquoted) || unquoted.split(``).some(ch => ch.charCodeAt(0) > 127))
    return `'${unquoted}'`
  return unquoted
}

function quoteFontFamilyList(value: string): string {
  return value
    .split(/,(?=(?:[^'"]|'[^']*'|"[^"]*")*$)/)
    .map(part => mapFontFamilyName(part.trim()))
    .filter(Boolean)
    .join(`, `)
}

/** C4 / sequence / gantt default to unquoted `Open Sans`, which juice/PostCSS rejects. */
function quoteUnquotedFontFamilies(css: string): string {
  return css
    .replace(/font-family\s*:\s*([^;}{]+)/gi, (_, value: string) => `font-family: ${quoteFontFamilyList(value)}`)
    .replace(/(?<!['"])\bOpen Sans\b(?!['"])/gi, `sans-serif`)
}

function decodeStyleAttr(value: string): string {
  return value
    .replace(/&quot;/g, `"`)
    .replace(/&#34;/g, `"`)
    .replace(/&apos;|&#39;/g, `'`)
    .replace(/&amp;/g, `&`)
}

function encodeStyleAttr(value: string, quote: string): string {
  let next = value.replace(/&/g, `&amp;`)
  if (quote === `"`)
    next = next.replace(/"/g, `&quot;`)
  else
    next = next.replace(/'/g, `&#39;`)
  return next
}

function sanitizeCssDeclarations(css: string): string {
  const cleaned = css
    .split(`;`)
    .map(part => part.trim())
    .filter((part) => {
      if (!part || /^undefined$/i.test(part))
        return false
      const colon = part.indexOf(`:`)
      if (colon === -1)
        return false
      return !isUndefinedCssValue(part.slice(colon + 1))
    })
    .join(`; `)
  return quoteUnquotedFontFamilies(cleaned)
}

function sanitizeEmbeddedStylesheet(css: string): string {
  return quoteUnquotedFontFamilies(
    css.replace(/([a-z_-]+)\s*:\s*undefined\b\s*;?/gi, ``),
  )
}

/**
 * Drop / rewrite CSS that juice cannot parse.
 * Mermaid emits `style="undefined;"` on edges and unquoted `Open Sans` on C4 / sequence / gantt.
 * Must run before juice inlines styles for WeChat copy.
 */
export function stripInvalidCssForJuice(root: ParentNode) {
  root.querySelectorAll(`[style]`).forEach((el) => {
    const raw = el.getAttribute(`style`)
    if (raw == null)
      return
    const next = sanitizeCssDeclarations(raw)
    if (next)
      el.setAttribute(`style`, next)
    else
      el.removeAttribute(`style`)
  })

  root.querySelectorAll(`style`).forEach((el) => {
    const raw = el.textContent
    if (!raw)
      return
    if (/\bundefined\b/i.test(raw) || /font-family\s*:/i.test(raw) || /\bOpen Sans\b/i.test(raw))
      el.textContent = sanitizeEmbeddedStylesheet(raw)
  })
}

/**
 * Quote / drop juice-invalid CSS in the HTML string juice actually parses.
 * Needed because browsers re-serialize `style="font-family: 'Open Sans'"` as
 * unquoted `Open Sans`, which PostCSS then rejects (`Unknown word Open`).
 */
export function sanitizeHtmlCssForJuice(html: string): string {
  const withStyleAttrs = html.replace(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi, (_full, quote: string, value: string) => {
    const sanitized = sanitizeCssDeclarations(decodeStyleAttr(value))
    return ` style=${quote}${encodeStyleAttr(sanitized, quote)}${quote}`
  })

  const withSheets = withStyleAttrs.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_full, open: string, css: string, close: string) => {
    return `${open}${sanitizeEmbeddedStylesheet(css)}${close}`
  })

  // Mermaid also sets SVG presentation attributes: font-family="Open Sans, sans-serif"
  const withFontAttrs = withSheets.replace(/\sfont-family\s*=\s*(["'])([\s\S]*?)\1/gi, (_full, quote: string, value: string) => {
    return ` font-family=${quote}${encodeStyleAttr(quoteFontFamilyList(decodeStyleAttr(value)), quote)}${quote}`
  })

  return withFontAttrs.replace(/(?<!['"])\bOpen Sans\b(?!['"])/gi, `sans-serif`)
}

export function stripFontFamilyForJuiceFallback(html: string): string {
  return html
    .replace(/font-family\s*:[^;}{]+;?/gi, ``)
    .replace(/\sfont-family\s*=\s*(["'])[\s\S]*?\1/gi, ``)
    .replace(/(?<!['"])\bOpen Sans\b(?!['"])/gi, `sans-serif`)
}

export function solveWeChatImage(container?: HTMLElement) {
  const clipboardDiv = container ?? document.getElementById(`output`)
  if (!clipboardDiv)
    return
  const images = clipboardDiv.getElementsByTagName(`img`)

  Array.from(images).forEach((image) => {
    const width = image.getAttribute(`width`)
    const height = image.getAttribute(`height`)

    if (width) {
      image.removeAttribute(`width`)
      image.style.width = /^\d+$/.test(width) ? `${width}px` : width
    }

    if (height) {
      image.removeAttribute(`height`)
      image.style.height = /^\d+$/.test(height) ? `${height}px` : height
    }
  })
}

export interface WeChatCssVarValues {
  primaryColor: string
  fontFamily: string
  fontSize: string
  lineHeight: string
  blockSpacing: string
}

type Rgba = [number, number, number, number]

const NAMED_COLORS = new Map<string, Rgba>([
  [`transparent`, [0, 0, 0, 0]],
  [`white`, [255, 255, 255, 1]],
  [`black`, [0, 0, 0, 1]],
])

function parseCssNumber(raw: string, percentScale: number): number {
  const value = Number.parseFloat(raw)
  if (!/^-?[\d.]+%?$/.test(raw) || Number.isNaN(value))
    return Number.NaN
  return raw.endsWith(`%`) ? value / 100 * percentScale : value
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return [f(0) * 255, f(8) * 255, f(4) * 255]
}

/** Parses the concrete colors themes feed into color-mix(); returns null for anything else. */
function parseCssColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase()
  const named = NAMED_COLORS.get(s)
  if (named)
    return named

  const hex = /^#([\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/.exec(s)
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map(c => c + c).join(``) : hex[1]
    const byte = (i: number) => Number.parseInt(h.slice(i, i + 2), 16)
    return [byte(0), byte(2), byte(4), h.length === 8 ? byte(6) / 255 : 1]
  }

  const fn = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(s)
  if (!fn)
    return null
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean)
  if (parts.length !== 3 && parts.length !== 4)
    return null
  const alpha = parts[3] === undefined ? 1 : parseCssNumber(parts[3], 1)
  let rgb: [number, number, number]
  if (fn[1].startsWith(`rgb`)) {
    rgb = [0, 1, 2].map(i => parseCssNumber(parts[i], 255)) as [number, number, number]
  }
  else {
    const hue = Number.parseFloat(parts[0].replace(/deg$/, ``))
    rgb = hslToRgb(((hue % 360) + 360) % 360, parseCssNumber(parts[1], 1), parseCssNumber(parts[2], 1))
  }
  const color: Rgba = [rgb[0], rgb[1], rgb[2], alpha]
  return color.some(Number.isNaN) ? null : color
}

/** One color-mix() argument: a color with an optional percentage on either side. */
function parseMixArg(arg: string): { color: Rgba, pct: number | undefined } | null {
  const trimmed = arg.trim()
  const after = /^(.*\S)\s+([\d.]+)%$/.exec(trimmed)
  const before = /^([\d.]+)%\s+(\S.*)$/.exec(trimmed)
  const colorText = after ? after[1] : before ? before[2] : trimmed
  const pctText = after ? after[2] : before ? before[1] : undefined
  const color = parseCssColor(colorText)
  const pct = pctText === undefined ? undefined : Number.parseFloat(pctText)
  if (!color || (pct !== undefined && Number.isNaN(pct)))
    return null
  return { color, pct }
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === `(`) {
      depth++
    }
    else if (text[i] === `)`) {
      depth--
    }
    else if (text[i] === `,` && depth === 0) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

function formatRgba([r, g, b, a]: Rgba): string {
  const channels = [r, g, b].map(v => Math.round(Math.min(255, Math.max(0, v))))
  if (a >= 1)
    return `#${channels.map(v => v.toString(16).padStart(2, `0`)).join(``)}`
  return `rgba(${channels.join(`, `)}, ${Number(Math.max(0, a).toFixed(3))})`
}

/** CSS Color 5 color-mix() in sRGB with premultiplied alpha; null when the arguments are not concrete colors. */
function mixSrgb(args: string): string | null {
  const parts = splitTopLevelCommas(args)
  if (parts.length !== 2)
    return null
  const first = parseMixArg(parts[0])
  const second = parseMixArg(parts[1])
  if (!first || !second)
    return null
  const p1 = first.pct ?? (second.pct === undefined ? 50 : 100 - second.pct)
  const p2 = second.pct ?? 100 - p1
  const sum = p1 + p2
  if (sum <= 0)
    return null
  const [w1, w2] = [p1 / sum, p2 / sum]
  const alpha = first.color[3] * w1 + second.color[3] * w2
  const multiplier = Math.min(sum, 100) / 100
  if (alpha === 0)
    return formatRgba([0, 0, 0, 0])
  const channel = (i: number) => (first.color[i] * first.color[3] * w1 + second.color[i] * second.color[3] * w2) / alpha
  return formatRgba([channel(0), channel(1), channel(2), alpha * multiplier])
}

// Innermost color-mix() only: its arguments may hold rgb()/hsl() but no further color-mix().
const INNERMOST_COLOR_MIX = /color-mix\(\s*in\s+srgb\s*,((?:(?!color-mix\()[^()]|\([^()]*\))*)\)/gi

/**
 * WeChat passes inline color-mix() through untouched, and older WebViews and
 * its dark-mode color rewriting drop it, so the tints themes build with it
 * would vanish. Resolve it to plain hex/rgba inside style attributes only.
 */
export function resolveColorMix(html: string): string {
  return html.replace(/style="([^"]*)"/g, (attr, style: string) => {
    if (!/color-mix\(/i.test(style))
      return attr
    let resolved = style
    for (let previous = ``; previous !== resolved;) {
      previous = resolved
      resolved = resolved.replace(INNERMOST_COLOR_MIX, (match, args: string) => mixSrgb(args) ?? match)
    }
    return `style="${resolved}"`
  })
}

/**
 * Pure string replacements applied right after juice CSS inlining.
 * Safe to run inside a Web Worker (no DOM APIs).
 */
export function applyWeChatCssVarReplacements(html: string, vars: WeChatCssVarValues): string {
  return resolveColorMix(html
    .replace(/([^-])top:(.*?)em/g, `$1transform: translateY($2em)`)
    .replace(/hsl\(var\(--foreground\)\)/g, `#3f3f3f`)
    .replace(/var\(--blockquote-background\)/g, `#f7f7f7`)
    .replace(/var\(--md-primary-color\)/g, vars.primaryColor)
    .replace(/var\(--md-font-family\)/g, vars.fontFamily)
    .replace(/var\(--md-font-size\)/g, vars.fontSize)
    .replace(/var\(--md-line-height\)/g, vars.lineHeight)
    .replace(/var\(--md-block-spacing\)/g, vars.blockSpacing)
    .replace(/--md-primary-color:.+?;/g, ``)
    .replace(/--md-font-family:.+?;/g, ``)
    .replace(/--md-font-size:.+?;/g, ``)
    .replace(/--md-line-height:.+?;/g, ``)
    .replace(/--md-block-spacing:.+?;/g, ``)
    .replace(/--md-link-color:.+?;/g, ``)
    .replace(/--md-blockquote-background:.+?;/g, ``)
    .replace(
      /<span class="nodeLabel"([^>]*)><p[^>]*>(.*?)<\/p><\/span>/g,
      `<span class="nodeLabel"$1>$2</span>`,
    )
    .replace(
      /<span class="edgeLabel"([^>]*)><p[^>]*>(.*?)<\/p><\/span>/g,
      `<span class="edgeLabel"$1>$2</span>`,
    ))
}

export function modifyHtmlStructureInPlace(root: ParentNode): void {
  root.querySelectorAll(`li > ul, li > ol`).forEach((originalItem) => {
    originalItem.parentElement?.insertAdjacentElement(`afterend`, originalItem)
  })
}

export function modifyHtmlStructure(htmlString: string): string {
  const tempDiv = document.createElement(`div`)
  tempDiv.innerHTML = htmlString
  modifyHtmlStructureInPlace(tempDiv)
  return tempDiv.innerHTML
}

const ZERO_CSS_LENGTH = /^0(?:px)?$/i

function hasVisibleText(el: HTMLElement): boolean {
  return (el.textContent ?? ``).replace(/[\s\u200B]/g, ``).length > 0
}

function canScrollHorizontally(el: HTMLElement): boolean {
  const overflowX = el.style.overflowX || el.style.overflow
  return overflowX === `auto` || overflowX === `scroll`
}

/**
 * WeChat paints its own gray left border on every `<blockquote>`.
 * The theme already draws a quote bar, so the tag shows up as a second strip.
 * A `<section>` keeps the inlined theme styles and skips that platform chrome.
 */
function replaceBlockquotesWithSections(root: HTMLElement) {
  root.querySelectorAll(`blockquote`).forEach((quote) => {
    const section = document.createElement(`section`)
    for (const attr of [...quote.attributes])
      section.setAttribute(attr.name, attr.value)
    section.append(...quote.childNodes)
    quote.replaceWith(section)
  })
}

/**
 * WeChat's structure checker measures the pasted article at several phone widths.
 * Shrink-to-fit headings overflow those widths. Code blocks and tables are meant
 * to scroll sideways; `data-ignore-width` is the checker's exemption for that,
 * and `overflow-x: auto` keeps the separate `<pre>` rule from firing.
 * `line-height: 0` on any node that still has text is reported as overlapping lines,
 * including diagram wrappers whose SVG labels count as text. Whitespace-only spacers
 * stay as they are, and KaTeX keeps its own smash line-height.
 */
export function applyWeChatStructureFixes(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(`h1, h2`).forEach((heading) => {
    const display = heading.style.display
    if (display !== `table` && display !== `inline-table`)
      return
    heading.style.display = `block`
    heading.style.width = `fit-content`
    heading.style.maxWidth = `100%`
    heading.style.boxSizing = `border-box`
    heading.style.marginLeft = `auto`
    heading.style.marginRight = `auto`
    heading.style.whiteSpace = `normal`
    heading.style.wordBreak = `break-word`
  })

  root.querySelectorAll<HTMLElement>(`table`).forEach((table) => {
    table.setAttribute(`data-ignore-width`, ``)
    const wrapper = table.parentElement
    if (wrapper?.tagName === `SECTION`)
      wrapper.setAttribute(`data-ignore-width`, ``)
  })

  root.querySelectorAll<HTMLElement>(`pre, .code-scroll`).forEach((el) => {
    el.setAttribute(`data-ignore-width`, ``)
    // Theme code blocks already have an 8px side margin. width:100% is the
    // margin box's parent width, so the border box sticks out by that margin.
    if (el.tagName === `PRE` && el.style.width.trim() === `100%`)
      el.style.width = `auto`
    if (!canScrollHorizontally(el))
      el.style.overflowX = `auto`
  })

  replaceBlockquotesWithSections(root)

  root.querySelectorAll<HTMLElement>(`[style*="line-height"]`).forEach((el) => {
    if (!ZERO_CSS_LENGTH.test(el.style.lineHeight.trim()))
      return
    if (!hasVisibleText(el))
      return
    if (el.closest(`.katex, .katex-block, .katex-inline, mjx-container`))
      return
    el.style.lineHeight = `normal`
    if (ZERO_CSS_LENGTH.test(el.style.fontSize.trim()))
      el.style.fontSize = ``
  })

  keepEmptyDecorations(root)
}

const EMPTY_DECORATION_KEEPER = `<svg viewBox="0 0 1 1" style="float:left;line-height:0;width:0;vertical-align:top;"></svg>`

/**
 * WeChat's editor drops empty <section>/<span> on paste, which erases sized
 * decorations such as layout-component rules and corner marks. A zero-width
 * <svg> placeholder (the convention WeChat layout tools use) keeps them.
 */
function keepEmptyDecorations(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(`section, span`).forEach((el) => {
    if (el.childNodes.length > 0 || (!el.style.width && !el.style.height))
      return
    if (el.closest(`svg, .katex, mjx-container`))
      return
    el.insertAdjacentHTML(`beforeend`, EMPTY_DECORATION_KEEPER)
  })
}

export function createEmptyNode(): HTMLElement {
  const node = document.createElement(`p`)
  node.style.fontSize = `0`
  node.style.lineHeight = `0`
  node.style.margin = `0`
  node.innerHTML = `&nbsp;`
  return node
}

/**
 * Mermaid labels live in <foreignObject><div xmlns ...> (flowchart nodeLabel,
 * ER .name / .attribute-*, class, C4, …). WeChat drops that HTML unless the
 * inner node is a <section>.
 */
export function promoteSvgHtmlLabels(root: ParentNode) {
  if (!root.querySelector(`.mermaid-diagram foreignObject`))
    return

  root.querySelectorAll(`foreignObject`).forEach((foreign) => {
    if (!foreign.closest(`.mermaid-diagram`))
      return

    const inner = foreign.querySelector(`:scope > div, :scope > span, :scope > section`)
    if (!inner || inner.localName === `section`)
      return

    const section = document.createElement(`section`)
    section.setAttribute(`xmlns`, inner.getAttribute(`xmlns`) || `http://www.w3.org/1999/xhtml`)
    const style = inner.getAttribute(`style`) || ``
    if (style)
      section.setAttribute(`style`, style)
    section.innerHTML = inner.innerHTML
    foreign.replaceChildren(section)
  })
}
