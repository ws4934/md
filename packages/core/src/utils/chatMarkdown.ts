import type { Tokens } from 'marked'
import hljs from 'highlight.js/lib/core'
import DOMPurify from 'isomorphic-dompurify'
import { Marked } from 'marked'
import { escapeHtml } from './basicHelpers'
import { COMMON_LANGUAGES } from './languages'
import { fenceRunLength } from './scan'

let languagesRegistered = false

function ensureCommonLanguages(): void {
  if (languagesRegistered)
    return
  languagesRegistered = true
  for (const [name, grammar] of Object.entries(COMMON_LANGUAGES)) {
    if (!hljs.getLanguage(name))
      hljs.registerLanguage(name, grammar)
  }
}

const LANGUAGE_ALIASES: Record<string, string> = {
  js: `javascript`,
  jsx: `javascript`,
  mjs: `javascript`,
  cjs: `javascript`,
  ts: `typescript`,
  tsx: `typescript`,
  jsonc: `json`,
  jsonl: `json`,
  sh: `bash`,
  zsh: `bash`,
  yml: `plaintext`,
  yaml: `plaintext`,
  htm: `xml`,
  html: `xml`,
  vue: `xml`,
  svg: `xml`,
  md: `markdown`,
  py: `python`,
  text: `plaintext`,
  txt: `plaintext`,
}

const SAFE_LANG_CLASS_RE = /^[\w+-]+$/
const SAFE_TABLE_ALIGNS = new Set([`left`, `center`, `right`])

function decodeFileUrl(href: string): string {
  let withoutScheme = href.replace(/^file:\/\//i, ``)
  if (/^localhost\//i.test(withoutScheme))
    withoutScheme = withoutScheme.slice(`localhost`.length)
  // Strip optional URI query/line-anchor (e.g. `#L10-L20`) so chip paths and extensions resolve cleanly.
  withoutScheme = withoutScheme.replace(/[?#].*$/, ``)
  let decoded = withoutScheme
  try {
    decoded = decodeURIComponent(withoutScheme)
  }
  catch {
    decoded = withoutScheme
  }
  // RFC 8089 Windows file URIs (`file:///C:/...`) carry a leading slash before the drive letter.
  return decoded.replace(/^\/([a-z]:\/)/i, `$1`)
}

function compactFileLabel(label: string, decodedPath: string): string {
  const unquoted = label.trim().replace(/^`([^`]+)`$/, `$1`).trim()
  if (unquoted && !/^file:\/\//i.test(unquoted) && !unquoted.includes(`/acp-workspaces/`))
    return unquoted
  const parts = decodedPath.replace(/\\/g, `/`).split(`/`).filter(Boolean)
  return parts[parts.length - 1] || unquoted || decodedPath
}

const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i
const FILE_SCHEME_RE = /file:\/\//i
const FILE_LINK_RE = /(\[[^\]\r\n]*\]\()(file:\/\/(?:[^()\r\n]|\([^()\r\n]*\))+)(\))/gi
const FILE_LINK_TRAILING_TITLE_RE = /[ \t]+(?:"[^"\r\n]*"|'[^'\r\n]*')$/

function detectFileChipKind(pathOrLabel: string): `image` | `file` {
  return IMAGE_FILE_EXT_RE.test(pathOrLabel.trim()) ? `image` : `file`
}

function opensFenceOnLine(line: string): { char: string, length: number } | null {
  const fence = fenceRunLength(line, 0, line.length)
  if (!fence)
    return null
  if (fence.char === `\``) {
    let i = 0
    while (i < line.length && line[i] === ` `)
      i++
    if (line.includes(`\``, i + fence.length))
      return null
  }
  return fence
}

function closesFenceOnLine(line: string, fenceChar: string, fenceLength: number): boolean {
  const fence = fenceRunLength(line, 0, line.length)
  if (!fence || fence.char !== fenceChar || fence.length < fenceLength)
    return false
  let i = 0
  while (i < line.length && line[i] === ` `)
    i++
  i += fence.length
  while (i < line.length) {
    const ch = line[i]
    if (ch !== ` ` && ch !== `\t` && ch !== `\r`)
      return false
    i++
  }
  return true
}

function collectInlineCodeRanges(line: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let i = 0
  while (i < line.length) {
    if (line[i] !== `\``) {
      i++
      continue
    }
    let ticks = 0
    while (i + ticks < line.length && line[i + ticks] === `\``)
      ticks++
    const closeIdx = line.indexOf(`\``.repeat(ticks), i + ticks)
    if (closeIdx === -1) {
      i += ticks
      continue
    }
    ranges.push([i, closeIdx + ticks])
    i = closeIdx + ticks
  }
  return ranges
}

function encodeFileLinksOutsideInlineCode(line: string): string {
  const codeRanges = line.includes(`\``) ? collectInlineCodeRanges(line) : []
  return line.replace(
    FILE_LINK_RE,
    (match, open: string, rawInner: string, close: string, offset: number) => {
      // Skip `[...](file://...)` written literally inside an inline code span, while allowing `` [`a.md`](file://...) ``.
      if (codeRanges.some(([start, end]) => offset >= start && offset < end))
        return match
      const titleMatch = FILE_LINK_TRAILING_TITLE_RE.exec(rawInner)
      const rawUrl = titleMatch ? rawInner.slice(0, titleMatch.index) : rawInner
      const titleSuffix = titleMatch ? titleMatch[0] : ``
      const encodedUrl = rawUrl
        .replace(/ /g, `%20`)
        .replace(/\(/g, `%28`)
        .replace(/\)/g, `%29`)
      return `${open}${encodedUrl}${titleSuffix}${close}`
    },
  )
}

/**
 * Percent-encodes unescaped spaces/parentheses inside `[label](file://...)` and `![alt](file://...)`
 * link destinations outside fenced (backtick/tilde, any length, including unclosed streaming fences)
 * and inline code spans. CommonMark rejects unescaped spaces inside `(...)`, which otherwise causes
 * macOS paths like `Application Support` to render as raw text.
 */
function normalizeFileLinkSpaces(markdown: string): string {
  if (!FILE_SCHEME_RE.test(markdown))
    return markdown

  const lines = markdown.split(`\n`)
  let fenceChar = ``
  let fenceLength = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (fenceChar) {
      if (closesFenceOnLine(line, fenceChar, fenceLength)) {
        fenceChar = ``
        fenceLength = 0
      }
      continue
    }
    const opened = opensFenceOnLine(line)
    if (opened) {
      fenceChar = opened.char
      fenceLength = opened.length
      continue
    }
    if (FILE_SCHEME_RE.test(line))
      lines[i] = encodeFileLinksOutsideInlineCode(line)
  }

  return lines.join(`\n`)
}

function isSafeExternalUrl(href: string): boolean {
  try {
    const parsed = new URL(href)
    return (parsed.protocol === `http:` || parsed.protocol === `https:`) && Boolean(parsed.hostname)
  }
  catch {
    return false
  }
}

function isSafeRenderableImageUrl(href: string): boolean {
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif);base64,/i.test(href))
    return true
  try {
    const parsed = new URL(href)
    return parsed.protocol === `http:` || parsed.protocol === `https:`
  }
  catch {
    return false
  }
}

export interface ChatMarkdownOptions {
  copyLabel?: string
}

function createChatMarked(copyLabel: string): Marked {
  ensureCommonLanguages()
  const instance = new Marked({
    gfm: true,
    breaks: true,
  })

  instance.use({
    renderer: {
      code({ text, lang }: Tokens.Code): string {
        const rawLang = (lang ?? ``).trim().split(/\s+/)[0]?.toLowerCase() ?? ``
        const resolvedLang = LANGUAGE_ALIASES[rawLang] ?? rawLang
        const highlighted = resolvedLang && hljs.getLanguage(resolvedLang)
          ? hljs.highlight(text, { language: resolvedLang }).value
          : escapeHtml(text)
        const displayLang = escapeHtml(rawLang || `text`)
        const safeCopy = escapeHtml(copyLabel)
        const langClass = resolvedLang && SAFE_LANG_CLASS_RE.test(resolvedLang)
          ? ` language-${escapeHtml(resolvedLang)}`
          : ``

        return [
          `<div class="agent-code-block">`,
          `<div class="agent-code-header">`,
          `<span class="agent-code-lang">${displayLang}</span>`,
          `<button type="button" class="agent-code-copy" data-copy-code="true" aria-label="${safeCopy}">${safeCopy}</button>`,
          `</div>`,
          `<pre class="agent-code-pre"><code class="hljs${langClass}">${highlighted}</code></pre>`,
          `</div>`,
        ].join(``)
      },

      link(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Link): string {
        const href = (token.href ?? ``).trim()
        const innerHtml = this.parser.parseInline(token.tokens)

        if (/^file:\/\//i.test(href)) {
          const decodedPath = decodeFileUrl(href)
          const label = compactFileLabel(token.text ?? ``, decodedPath)
          const chipKind = detectFileChipKind(decodedPath || label)
          return `<span class="agent-file-chip" data-chip-kind="${chipKind}" data-file-path="${escapeHtml(decodedPath)}" title="${escapeHtml(decodedPath)}">${escapeHtml(label)}</span>`
        }

        if (isSafeExternalUrl(href)) {
          const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : ``
          return `<a class="agent-md-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${titleAttr}>${innerHtml}</a>`
        }

        return innerHtml
      },

      image(token: Tokens.Image): string {
        const href = (token.href ?? ``).trim()
        const alt = (token.text ?? ``).trim()
        if (isSafeRenderableImageUrl(href)) {
          const titleAttr = token.title ? ` title="${escapeHtml(token.title)}"` : ``
          return `<img class="agent-md-img" src="${escapeHtml(href)}" alt="${escapeHtml(alt)}" loading="lazy"${titleAttr} />`
        }
        if (/^file:\/\//i.test(href)) {
          const decodedPath = decodeFileUrl(href)
          const label = alt || compactFileLabel(``, decodedPath)
          return `<span class="agent-file-chip" data-chip-kind="image" data-file-path="${escapeHtml(decodedPath)}" title="${escapeHtml(decodedPath)}">${escapeHtml(label)}</span>`
        }
        if (/^(?:data|javascript|vbscript):/i.test(href)) {
          const label = alt || `image`
          return `<span class="agent-file-chip" data-chip-kind="image">${escapeHtml(label)}</span>`
        }
        const label = alt || compactFileLabel(``, href) || `image`
        return `<span class="agent-file-chip" data-chip-kind="image" title="${escapeHtml(href)}">${escapeHtml(label)}</span>`
      },

      table(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Table): string {
        const headerCells = token.header
          .map((cell, idx) => {
            const align = token.align[idx]
            const alignAttr = align && SAFE_TABLE_ALIGNS.has(align) ? ` style="text-align:${align}"` : ``
            return `<th${alignAttr}>${this.parser.parseInline(cell.tokens)}</th>`
          })
          .join(``)
        const bodyRows = token.rows
          .map((row) => {
            const cells = row
              .map((cell, idx) => {
                const align = token.align[idx]
                const alignAttr = align && SAFE_TABLE_ALIGNS.has(align) ? ` style="text-align:${align}"` : ``
                return `<td${alignAttr}>${this.parser.parseInline(cell.tokens)}</td>`
              })
              .join(``)
            return `<tr>${cells}</tr>`
          })
          .join(``)
        return `<div class="agent-md-table-wrap"><table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></div>`
      },

      html({ text }: Tokens.HTML | Tokens.Tag): string {
        // Preserve explicit line breaks while escaping arbitrary HTML/component tags so references like <TipBlock /> stay visible.
        if (/^<br\s*\/?>$/i.test(text.trim()))
          return `<br />`
        return escapeHtml(text)
      },
    },
  })

  return instance
}

const markedByCopyLabel = new Map<string, Marked>()

function getMarkedInstance(copyLabel: string): Marked {
  let instance = markedByCopyLabel.get(copyLabel)
  if (!instance) {
    if (markedByCopyLabel.size >= 8)
      markedByCopyLabel.clear()
    instance = createChatMarked(copyLabel)
    markedByCopyLabel.set(copyLabel, instance)
  }
  return instance
}

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    `p`,
    `br`,
    `strong`,
    `em`,
    `del`,
    `s`,
    `code`,
    `pre`,
    `blockquote`,
    `ul`,
    `ol`,
    `li`,
    `h1`,
    `h2`,
    `h3`,
    `h4`,
    `h5`,
    `h6`,
    `hr`,
    `a`,
    `img`,
    `table`,
    `thead`,
    `tbody`,
    `tr`,
    `th`,
    `td`,
    `div`,
    `span`,
    `button`,
    `input`,
  ],
  ALLOWED_ATTR: [
    `class`,
    `href`,
    `target`,
    `rel`,
    `title`,
    `src`,
    `alt`,
    `loading`,
    `type`,
    `aria-label`,
    `data-copy-code`,
    `data-file-path`,
    `data-chip-kind`,
    `checked`,
    `disabled`,
    `style`,
  ],
}

/**
 * Renders an agent chat Markdown message into sanitized HTML for sidebar display.
 * Converts `file://` links into compact file chips, highlights fenced code blocks,
 * and strips unsafe markup via DOMPurify.
 */
export function renderChatMarkdown(markdown: string, options: ChatMarkdownOptions = {}): string {
  if (!markdown)
    return ``
  const copyLabel = options.copyLabel ?? `Copy`
  const marked = getMarkedInstance(copyLabel)
  const normalized = normalizeFileLinkSpaces(markdown)
  const rawHtml = marked.parse(normalized, { async: false }) as string
  return DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG)
}
