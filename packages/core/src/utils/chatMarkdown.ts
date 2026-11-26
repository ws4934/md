import type { Tokens } from 'marked'
import hljs from 'highlight.js/lib/core'
import DOMPurify from 'isomorphic-dompurify'
import { Marked } from 'marked'
import { COMMON_LANGUAGES } from './languages'

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
  sh: `bash`,
  zsh: `bash`,
  yml: `plaintext`,
  yaml: `plaintext`,
  html: `xml`,
  vue: `xml`,
  svg: `xml`,
  md: `markdown`,
  py: `python`,
  text: `plaintext`,
  txt: `plaintext`,
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, `&amp;`)
    .replace(/</g, `&lt;`)
    .replace(/>/g, `&gt;`)
    .replace(/"/g, `&quot;`)
    .replace(/'/g, `&#39;`)
}

function decodeFileUrl(href: string): string {
  const withoutScheme = href.replace(/^file:\/\//i, ``)
  try {
    return decodeURIComponent(withoutScheme)
  }
  catch {
    return withoutScheme
  }
}

function compactFileLabel(label: string, decodedPath: string): string {
  const trimmed = label.trim()
  if (trimmed && !/^file:\/\//i.test(trimmed) && !trimmed.includes(`/acp-workspaces/`))
    return trimmed
  const parts = decodedPath.replace(/\\/g, `/`).split(`/`).filter(Boolean)
  return parts[parts.length - 1] || trimmed || decodedPath
}

const IMAGE_FILE_EXT_RE = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i

function detectFileChipKind(pathOrLabel: string): `image` | `file` {
  return IMAGE_FILE_EXT_RE.test(pathOrLabel.trim()) ? `image` : `file`
}

/**
 * Percent-encodes unescaped spaces inside `[label](file://...)` link destinations
 * outside fenced/inline code blocks. CommonMark rejects unescaped spaces inside `(...)`,
 * which otherwise causes macOS paths like `Application Support` to render as raw text.
 */
function normalizeFileLinkSpaces(markdown: string): string {
  const segments = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g)
  for (let i = 0; i < segments.length; i += 2) {
    segments[i] = segments[i].replace(
      /(\[[^\]\r\n]+\]\()(file:\/\/[^)\r\n]+)(\))/gi,
      (_match, open: string, url: string, close: string) => `${open}${url.replace(/ /g, `%20`)}${close}`,
    )
  }
  return segments.join(``)
}

function isSafeExternalUrl(href: string): boolean {
  try {
    const parsed = new URL(href)
    return parsed.protocol === `http:` || parsed.protocol === `https:` || parsed.protocol === `mailto:`
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
        const langClass = resolvedLang ? ` language-${escapeHtml(resolvedLang)}` : ``

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
        const label = alt || compactFileLabel(href, decodeFileUrl(href))
        return `<span class="agent-file-chip" data-chip-kind="image" title="${escapeHtml(href)}">${escapeHtml(label)}</span>`
      },

      table(this: { parser: { parseInline: (tokens: Tokens.Generic[]) => string } }, token: Tokens.Table): string {
        const headerCells = token.header
          .map((cell, idx) => {
            const align = token.align[idx]
            const alignAttr = align ? ` style="text-align:${align}"` : ``
            return `<th${alignAttr}>${this.parser.parseInline(cell.tokens)}</th>`
          })
          .join(``)
        const bodyRows = token.rows
          .map((row) => {
            const cells = row
              .map((cell, idx) => {
                const align = token.align[idx]
                const alignAttr = align ? ` style="text-align:${align}"` : ``
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
