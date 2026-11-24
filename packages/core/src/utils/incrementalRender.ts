import type {
  CiteLinkEntry,
  CollectedHeading,
  IndexedTocHeading,
  RendererAPI,
  TocHeadingEntry,
} from '@md/shared/types'
import type { ReadTimeResults } from '@md/shared/utils/readingTime'
import { postProcessHtml, renderMarkdown, sanitizeHtml } from './markdownHelpers'
import { stripBreakBeforeInlineKatex } from './mathDetection'
import { isMathJaxReady } from './mathjax'
import { fenceRunLength } from './scan'

export interface RenderedBlock {
  /** Stable block key for keyed DOM reconciliation. */
  key: string
  /** Final sanitized HTML for this block (heading ids and cite indices resolved). */
  html: string
}

export interface IncrementalRenderResult {
  /** Direct children of `<section class="container">` in document order. */
  blocks: RenderedBlock[]
  readingTime: ReadTimeResults
  headings: CollectedHeading[]
  usedIncremental: boolean
  fallbackReason?: string
}

export interface SplitBlocksResult {
  blocks: string[]
  fallbackReason?: string
}

interface CachedBlockEntry {
  raw: string
  sanitizedHtml: string
  headings: CollectedHeading[]
  tocHeadings: TocHeadingEntry[]
  citeLinks: CiteLinkEntry[]
  headingMarkerCount: number
  hasToc: boolean
  /** True when rendered before MathJax finished loading; invalidated once MathJax is ready. */
  hasPendingMath: boolean
  bytes: number
}

const MAX_BLOCK_CACHE_ENTRIES = 16384
const MAX_BLOCK_CACHE_BYTES = 48 * 1024 * 1024

class BlockRenderCache {
  private map = new Map<string, CachedBlockEntry>()
  private totalBytes = 0

  get(key: string, raw: string): CachedBlockEntry | undefined {
    const entry = this.map.get(key)
    if (!entry || entry.raw !== raw)
      return undefined
    this.map.delete(key)
    this.map.set(key, entry)
    return entry
  }

  set(key: string, entry: CachedBlockEntry): void {
    const existing = this.map.get(key)
    if (existing) {
      this.totalBytes -= existing.bytes
      this.map.delete(key)
    }
    if (entry.bytes > MAX_BLOCK_CACHE_BYTES)
      return
    this.map.set(key, entry)
    this.totalBytes += entry.bytes
    while (this.map.size > MAX_BLOCK_CACHE_ENTRIES || this.totalBytes > MAX_BLOCK_CACHE_BYTES) {
      const oldest = this.map.entries().next().value as [string, CachedBlockEntry] | undefined
      if (!oldest)
        break
      this.map.delete(oldest[0])
      this.totalBytes -= oldest[1].bytes
    }
  }

  clear(): void {
    this.map.clear()
    this.totalBytes = 0
  }
}

const rendererCaches = new WeakMap<RendererAPI, BlockRenderCache>()

function getRendererCache(renderer: RendererAPI): BlockRenderCache {
  let cache = rendererCaches.get(renderer)
  if (!cache) {
    cache = new BlockRenderCache()
    rendererCaches.set(renderer, cache)
  }
  return cache
}

/** Clear cached rendered blocks for a renderer (or tests). */
export function clearIncrementalRenderCache(renderer: RendererAPI): void {
  rendererCaches.get(renderer)?.clear()
}

/** Dual 32-bit FNV-1a hash (64 bits + length) for fast block keying without slicing. */
export function hashBlockText(str: string): string {
  let h1 = 0x811C9DC5
  let h2 = 0x9E3779B9
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i)
    h1 ^= c
    h1 = Math.imul(h1, 0x01000193)
    h2 ^= c + ((i & 0xFF) << 8)
    h2 = Math.imul(h2, 0x85EBCA6B)
  }
  return `${(h1 >>> 0).toString(36)}_${(h2 >>> 0).toString(36)}_${str.length}`
}

const VOID_HTML_TAGS = new Set([
  `area`,
  `base`,
  `br`,
  `col`,
  `embed`,
  `hr`,
  `img`,
  `input`,
  `link`,
  `meta`,
  `param`,
  `source`,
  `track`,
  `wbr`,
])

const LINK_REF_DEF_RE = /^[ \t>]{0,6}\[[^\]\r\n]+\]:/
const LIST_ITEM_RE = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const ALERT_OPEN_RE = /^:::[ \t]*\S+/
const ALERT_CLOSE_RE = /^:::[ \t]*$/
const MATH_DOLLAR_FENCE_RE = /^\s{0,3}(\${1,2})[ \t]*$/
const COMPONENT_OPEN_RE = /^<([A-Z]\w*)(?=[\s/>]|$)/
const BLOCK_TOC_LINE_RE = /^(?:[ \t>]|[-*+][ \t]|\d{1,9}[.)][ \t])*\[TOC\][ \t]*$/
const RAW_DANGEROUS_TAG_RE = /<(?:style|script|iframe|textarea|pre)(?=[\s>/]|$)/i
const LOWERCASE_HTML_TAG_RE = /<(\/?)([a-z][a-z0-9-]*)(?:\s[^>]*?)?(\/?)>/gi
const HEADING_MARKER_RE = /data-heading="true"/g
const CITE_TAG_RE = /<sup data-md-cite="(\d+)">\[\d+\]<\/sup>/g

function isBlankLine(line: string): boolean {
  for (let i = 0; i < line.length; i++) {
    const code = line.charCodeAt(i)
    if (code !== 32 && code !== 9 && code !== 13)
      return false
  }
  return true
}

function isClosingCodeFence(line: string, fenceChar: string, fenceLength: number): boolean {
  const fence = fenceRunLength(line, 0, line.length)
  if (!fence || fence.char !== fenceChar || fence.length < fenceLength)
    return false
  let i = 0
  while (i < line.length && line[i] === ` `)
    i++
  i += fence.length
  while (i < line.length) {
    if (line[i] !== ` ` && line[i] !== `\t`)
      return false
    i++
  }
  return true
}

function opensCodeFence(line: string): { char: string, length: number } | null {
  const fence = fenceRunLength(line, 0, line.length)
  if (!fence)
    return null
  // CommonMark: backtick info strings cannot contain backticks.
  if (fence.char === `\``) {
    let i = 0
    while (i < line.length && line[i] === ` `)
      i++
    if (line.includes(`\``, i + fence.length))
      return null
  }
  return fence
}

/**
 * Strip inline code spans from a single line before inspecting raw HTML tags so
 * code examples like `` `<div>` `` do not look like unclosed HTML tags.
 */
function stripInlineCodeSpans(line: string): string {
  if (!line.includes(`\``))
    return line
  let out = ``
  let i = 0
  while (i < line.length) {
    if (line[i] !== `\``) {
      out += line[i++]
      continue
    }
    let ticks = 0
    while (i + ticks < line.length && line[i + ticks] === `\``)
      ticks++
    const closeIdx = line.indexOf(`\``.repeat(ticks), i + ticks)
    if (closeIdx === -1) {
      out += line.slice(i, i + ticks)
      i += ticks
    }
    else {
      i = closeIdx + ticks
    }
  }
  return out
}

/**
 * Compute net open/close depth change for non-void lowercase HTML tags on a line.
 * Returns `null` when an unmatched closing tag drops depth below zero.
 */
function updateHtmlTagDepth(line: string, currentDepth: number): number | null {
  if (!line.includes(`<`))
    return currentDepth
  const cleaned = stripInlineCodeSpans(line)
  if (!cleaned.includes(`<`))
    return currentDepth

  let depth = currentDepth
  LOWERCASE_HTML_TAG_RE.lastIndex = 0
  for (;;) {
    const match = LOWERCASE_HTML_TAG_RE.exec(cleaned)
    if (!match)
      break
    const full = match[0]
    // Skip autolinks like `<https://...>` or `<user@host>`
    if (full.includes(`://`) || full.includes(`@`))
      continue
    const isClose = match[1] === `/`
    const tag = match[2].toLowerCase()
    const isSelfClosing = match[3] === `/`
    if (VOID_HTML_TAGS.has(tag) || isSelfClosing)
      continue
    if (isClose) {
      depth--
      if (depth < 0)
        return null
    }
    else {
      depth++
    }
  }
  return depth
}

/**
 * Check if a line opens a multiline PascalCase custom component (`<Comp ...>`
 * without `/>` or `</Comp>` on the same line, excluding inline `<Emoji>`).
 */
function detectMultilineComponentOpen(line: string): string | null {
  const match = COMPONENT_OPEN_RE.exec(line)
  if (!match)
    return null
  const name = match[1]
  if (name === `Emoji`)
    return null
  const closeTag = `</${name}>`
  if (line.includes(closeTag))
    return null
  // Scan quotes to find end of opening tag on this line.
  let inQuote = ``
  for (let i = 1 + name.length; i < line.length; i++) {
    const ch = line[i]
    if (inQuote) {
      if (ch === inQuote)
        inQuote = ``
    }
    else if (ch === `"` || ch === `'`) {
      inQuote = ch
    }
    else if (ch === `/` && line[i + 1] === `>`) {
      return null
    }
    else if (ch === `>`) {
      return line.slice(i + 1).trim() === `` ? name : null
    }
  }
  return null
}

/**
 * Split normalized markdown into fence/math/alert/component/list-aware top-level
 * blocks, preserving trailing blank lines on each block so marked's raw HTML
 * token whitespace matches full-document rendering byte-for-byte.
 *
 * Returns a `fallbackReason` for document-scoped constructs whose semantics
 * cannot be isolated cleanly across chunks (link reference definitions,
 * Markdown footnotes, raw `<style>`/`<script>`/`<pre>` blocks, or unbalanced
 * multi-block raw HTML).
 */
export function splitMarkdownBlocks(markdown: string): SplitBlocksResult {
  const normalized = markdown.includes(`\r`) ? markdown.replace(/\r\n|\r/g, `\n`) : markdown
  if (!normalized)
    return { blocks: [] }

  const lines = normalized.split(`\n`)
  const lineStarts: number[] = []
  let cursor = 0
  for (let i = 0; i < lines.length; i++) {
    lineStarts.push(cursor)
    cursor += lines[i].length + 1
  }

  const blocks: string[] = []
  let chunkStartIdx = 0
  let chunkHasContent = false
  let chunkHasListItem = false
  let fenceChar = ``
  let fenceLength = 0
  let mathFence = ``
  let inLatexBlock = false
  let alertOpen = false
  let componentTag = ``
  let htmlTagDepth = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const blank = isBlankLine(line)

    if (fenceChar) {
      if (isClosingCodeFence(line, fenceChar, fenceLength)) {
        fenceChar = ``
        fenceLength = 0
      }
      continue
    }

    // Run document-scoped fallback checks on every non-fenced line, including
    // lines inside unclosed math/alert/component regions.
    let strippedLine: string | undefined
    const getStrippedLine = () => (strippedLine ??= stripInlineCodeSpans(line))
    if (!blank) {
      if (line.includes(`[^`) && getStrippedLine().includes(`[^`))
        return { blocks: [], fallbackReason: `footnotes` }
      if (LINK_REF_DEF_RE.test(line))
        return { blocks: [], fallbackReason: `link-ref-def` }
      if (line.includes(`<`) && RAW_DANGEROUS_TAG_RE.test(getStrippedLine()))
        return { blocks: [], fallbackReason: `raw-html-block` }
      if (line.includes(`<!--`) && getStrippedLine().includes(`<!--`))
        return { blocks: [], fallbackReason: `raw-html-comment` }
    }

    if (mathFence) {
      const m = MATH_DOLLAR_FENCE_RE.exec(line)
      if (m && m[1] === mathFence)
        mathFence = ``
      continue
    }

    if (inLatexBlock) {
      if (line.includes(`\\]`)) {
        const lastOpen = line.lastIndexOf(`\\[`)
        const lastClose = line.lastIndexOf(`\\]`)
        if (lastClose > lastOpen || !normalized.includes(`\\]`, lineStarts[i] + lastOpen + 2))
          inLatexBlock = false
      }
      continue
    }

    if (componentTag) {
      if (line.trim() === `</${componentTag}>`)
        componentTag = ``
      continue
    }

    if (alertOpen) {
      if (ALERT_CLOSE_RE.test(line))
        alertOpen = false
      continue
    }

    if (blank) {
      if (!chunkHasContent)
        continue

      // If HTML tags remain open across a blank line, fall back to full render
      // because sanitizing individual chunks would auto-close open elements.
      if (htmlTagDepth > 0)
        return { blocks: [], fallbackReason: `multiline-raw-html` }

      // Look ahead to the next non-blank line.
      let nextIdx = i + 1
      while (nextIdx < lines.length && isBlankLine(lines[nextIdx]))
        nextIdx++

      if (nextIdx >= lines.length) {
        // Trailing blank lines attach to the last chunk.
        i = nextIdx - 1
        continue
      }

      const nextLine = lines[nextIdx]
      const nextIndented = nextLine.charCodeAt(0) === 32 || nextLine.charCodeAt(0) === 9
      const nextIsList = chunkHasListItem && LIST_ITEM_RE.test(nextLine)

      if (nextIndented || nextIsList) {
        i = nextIdx - 1
        continue
      }

      // Split right before `nextIdx` so trailing blank lines stay on the preceding chunk.
      blocks.push(normalized.slice(lineStarts[chunkStartIdx], lineStarts[nextIdx]))
      chunkStartIdx = nextIdx
      chunkHasContent = false
      chunkHasListItem = false
      htmlTagDepth = 0
      i = nextIdx - 1
      continue
    }

    // Non-blank line outside any fenced/multiline block.
    chunkHasContent = true

    const openedFence = opensCodeFence(line)
    if (openedFence) {
      fenceChar = openedFence.char
      fenceLength = openedFence.length
      continue
    }

    const mathMatch = MATH_DOLLAR_FENCE_RE.exec(line)
    if (mathMatch) {
      mathFence = mathMatch[1]
      continue
    }

    if (line.includes(`\\[`)) {
      const lastOpen = line.lastIndexOf(`\\[`)
      // Match katex.ts blockLatexKatex: `\[` (even mid-line or after an earlier `\[...\]`)
      // spans across blank lines iff a closing `\]` exists later in the document.
      if (lastOpen > line.lastIndexOf(`\\]`) && normalized.includes(`\\]`, lineStarts[i] + lastOpen + 2)) {
        inLatexBlock = true
        continue
      }
    }

    if (ALERT_OPEN_RE.test(line)) {
      alertOpen = true
      continue
    }

    const openedComp = detectMultilineComponentOpen(line)
    if (openedComp) {
      componentTag = openedComp
      continue
    }

    if (LIST_ITEM_RE.test(line))
      chunkHasListItem = true

    const nextDepth = updateHtmlTagDepth(line, htmlTagDepth)
    if (nextDepth === null)
      return { blocks: [], fallbackReason: `multiline-raw-html` }
    htmlTagDepth = nextDepth
  }

  if (chunkStartIdx < lines.length) {
    const tail = normalized.slice(lineStarts[chunkStartIdx])
    if (tail.length > 0)
      blocks.push(tail)
  }

  return { blocks }
}

function isBlockCacheable(html: string): boolean {
  return !html.includes(`data-md-diagram-state="loading"`)
    && !html.includes(`data-language-pending="`)
    && !html.includes(`src="about:blank"`)
}

function countHeadingMarkers(html: string): number {
  if (!html.includes(`data-heading="true"`))
    return 0
  let count = 0
  let from = 0
  for (;;) {
    const idx = html.indexOf(`data-heading="true"`, from)
    if (idx === -1)
      return count
    count++
    from = idx + 19
  }
}

function blockContainsToc(block: string): boolean {
  if (!block.includes(`[TOC]`))
    return false
  let fenceChar = ``
  let fenceLength = 0
  for (const line of block.split(`\n`)) {
    if (fenceChar) {
      if (isClosingCodeFence(line, fenceChar, fenceLength)) {
        fenceChar = ``
        fenceLength = 0
      }
      continue
    }
    const opened = opensCodeFence(line)
    if (opened) {
      fenceChar = opened.char
      fenceLength = opened.length
      continue
    }
    if (line.includes(`[TOC]`) && BLOCK_TOC_LINE_RE.test(stripInlineCodeSpans(line)))
      return true
  }
  return false
}

function buildTrailingStylesHtml(renderer: RendererAPI): string {
  return `${renderer.buildAddition()
  }
    <style>
      .hljs.code__pre > .mac-sign {
        display: ${renderer.getOpts().isMacCodeBlock ? `flex` : `none`};
      }
    </style>
  `
        + `
    <style>
      h2 strong {
        color: inherit !important;
      }
    </style>
  `
}

function applyHeadingIdsToString(html: string, startId: number): { html: string, nextId: number } {
  if (!html.includes(`data-heading="true"`))
    return { html, nextId: startId }
  let id = startId
  const out = html.replace(HEADING_MARKER_RE, () => `data-heading="true" id="${id++}"`)
  return { html: out, nextId: id }
}

/** Assemble `RenderedBlock[]` into the exact `<section class="container">...</section>` HTML string. */
export function assembleRenderedBlocksHtml(blocks: RenderedBlock[], renderer?: RendererAPI): string {
  let inner = ``
  for (let i = 0; i < blocks.length; i++)
    inner += blocks[i].html
  return renderer ? renderer.createContainer(inner) : `<section class="container">${inner}</section>`
}

function renderFullFallback(
  raw: string,
  renderer: RendererAPI,
  fallbackReason: string,
): IncrementalRenderResult {
  const { html: baseHtml, readingTime } = renderMarkdown(raw, renderer)
  const wrapped = postProcessHtml(baseHtml, readingTime, renderer)
  const { html: withIds } = applyHeadingIdsToString(wrapped, 0)
  const headings = renderer.getHeadings()
  // Extract inner content of `<section class="container">...</section>` so the
  // single fallback block mounts inside the same container element.
  const openTag = `<section class="container">`
  const closeTag = `</section>`
  const innerHtml = withIds.startsWith(openTag) && withIds.endsWith(closeTag)
    ? withIds.slice(openTag.length, -closeTag.length)
    : withIds

  return {
    blocks: [{ key: `full`, html: innerHtml }],
    readingTime,
    headings,
    usedIncremental: false,
    fallbackReason,
  }
}

/**
 * Incrementally render Markdown into keyed container-child blocks using a
 * per-renderer LRU cache, falling back seamlessly to full-document rendering
 * for document-scoped constructs (link reference definitions, Markdown
 * footnotes, raw style/script/pre blocks, or multi-block raw HTML).
 */
export function renderMarkdownIncremental(
  raw: string,
  renderer: RendererAPI,
  optionsFingerprint: string,
): IncrementalRenderResult {
  if (!renderer.renderBlock || !renderer.setCollectedState)
    return renderFullFallback(raw, renderer, `unsupported-renderer`)

  const { markdownContent, readingTime } = renderer.parseFrontMatterAndContent(raw)
  const split = splitMarkdownBlocks(markdownContent)
  if (split.fallbackReason)
    return renderFullFallback(raw, renderer, split.fallbackReason)

  const opts = renderer.getOpts()
  const citeStatus = Boolean(opts.citeStatus)
  const cache = getRendererCache(renderer)

  const rawBlocks = split.blocks
  const rawHashes: string[] = []
  const entries: CachedBlockEntry[] = []
  let hasAnyToc = false

  const mathReady = isMathJaxReady()

  // Pass 1: resolve each block from cache or render & sanitize on miss.
  for (let i = 0; i < rawBlocks.length; i++) {
    const chunk = rawBlocks[i]
    if (citeStatus && chunk.includes(`data-md-cite`))
      return renderFullFallback(raw, renderer, `literal-cite-attr`)

    const rawHash = hashBlockText(chunk)
    rawHashes.push(rawHash)
    const cacheKey = `${optionsFingerprint}\u0000${rawHash}`
    let entry = cache.get(cacheKey, chunk)
    if (entry?.hasPendingMath && mathReady)
      entry = undefined

    if (!entry) {
      const hasToc = blockContainsToc(chunk)
      const rendered = renderer.renderBlock(chunk, { tagCiteIndices: citeStatus })
      const cleaned = stripBreakBeforeInlineKatex(rendered.html)
      const sanitizedHtml = sanitizeHtml(cleaned)
      const hasPendingMath = sanitizedHtml.includes(`katex-pending`)
      entry = {
        raw: chunk,
        sanitizedHtml,
        headings: rendered.headings,
        tocHeadings: rendered.tocHeadings,
        citeLinks: rendered.citeLinks,
        headingMarkerCount: countHeadingMarkers(sanitizedHtml),
        hasToc,
        hasPendingMath,
        bytes: (chunk.length + sanitizedHtml.length) * 2,
      }
      if (!hasToc && isBlockCacheable(sanitizedHtml))
        cache.set(cacheKey, entry)
    }

    if (entry.hasToc)
      hasAnyToc = true
    entries.push(entry)
  }

  // Pass 2: if any `[TOC]` block exists, re-render only `[TOC]` blocks with document headings.
  if (hasAnyToc) {
    const allTocHeadings: IndexedTocHeading[] = []
    for (let i = 0; i < entries.length; i++) {
      const ths = entries[i].tocHeadings
      for (let j = 0; j < ths.length; j++) {
        allTocHeadings.push({
          text: ths[j].text,
          depth: ths[j].depth,
          index: allTocHeadings.length,
        })
      }
    }

    for (let i = 0; i < entries.length; i++) {
      if (!entries[i].hasToc)
        continue
      const chunk = rawBlocks[i]
      const rendered = renderer.renderBlock(chunk, {
        tagCiteIndices: citeStatus,
        tocHeadings: allTocHeadings,
      })
      const cleaned = stripBreakBeforeInlineKatex(rendered.html)
      const sanitizedHtml = sanitizeHtml(cleaned)
      entries[i] = {
        raw: chunk,
        sanitizedHtml,
        headings: rendered.headings,
        tocHeadings: rendered.tocHeadings,
        citeLinks: rendered.citeLinks,
        headingMarkerCount: countHeadingMarkers(sanitizedHtml),
        hasToc: true,
        hasPendingMath: sanitizedHtml.includes(`katex-pending`),
        bytes: (chunk.length + sanitizedHtml.length) * 2,
      }
    }
  }

  // Pass 3: build document-wide cite footnote table (only iterates link-bearing blocks).
  const globalFootnotes: [number, string, string][] = []
  const linkToGlobalIdx = new Map<string, number>()
  if (citeStatus) {
    for (let i = 0; i < entries.length; i++) {
      const citeLinks = entries[i].citeLinks
      if (citeLinks.length === 0)
        continue
      for (let j = 0; j < citeLinks.length; j++) {
        const { title, link } = citeLinks[j]
        if (!linkToGlobalIdx.has(link)) {
          const idx = globalFootnotes.length + 1
          linkToGlobalIdx.set(link, idx)
          globalFootnotes.push([idx, title, link])
        }
      }
    }
  }

  // Pass 4: assemble keyed blocks with sequential heading ids and resolved cite numbers.
  const blocks: RenderedBlock[] = []
  const allHeadings: CollectedHeading[] = []
  let headingId = 0

  const readingTimeHtml = renderer.buildReadingTime(readingTime)
  if (readingTimeHtml) {
    const resolved = applyHeadingIdsToString(readingTimeHtml, headingId)
    headingId = resolved.nextId
    blocks.push({ key: `slot:reading-time`, html: resolved.html })
  }

  const seenHashCount = new Map<string, number>()
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    const rawHash = rawHashes[i]
    const occ = (seenHashCount.get(rawHash) ?? 0) + 1
    seenHashCount.set(rawHash, occ)

    let html = entry.sanitizedHtml
    if (citeStatus && entry.citeLinks.length > 0) {
      const localToGlobal: number[] = []
      for (let j = 0; j < entry.citeLinks.length; j++) {
        const c = entry.citeLinks[j]
        localToGlobal[c.localIndex] = linkToGlobalIdx.get(c.link) ?? c.localIndex
      }
      html = html.replace(CITE_TAG_RE, (_, n) => `<sup>[${localToGlobal[Number(n)]}]</sup>`)
    }

    if (entry.headingMarkerCount > 0) {
      const resolved = applyHeadingIdsToString(html, headingId)
      html = resolved.html
      headingId = resolved.nextId
    }

    if (entry.headings.length > 0) {
      for (let j = 0; j < entry.headings.length; j++)
        allHeadings.push(entry.headings[j])
    }

    blocks.push({ key: `body:${rawHash}:${occ}`, html })
  }

  // Restore document-level state on renderer before building footnotes (which also
  // pushes the footnote `h4` heading into `renderer.getHeadings()`).
  renderer.setCollectedState({
    headings: allHeadings,
    footnotes: globalFootnotes,
  })

  const footnotesHtml = renderer.buildFootnotes()
  if (footnotesHtml) {
    const resolved = applyHeadingIdsToString(footnotesHtml, headingId)
    headingId = resolved.nextId
    blocks.push({ key: `slot:footnotes`, html: resolved.html })
  }

  blocks.push({ key: `slot:styles`, html: buildTrailingStylesHtml(renderer) })

  return {
    blocks,
    readingTime,
    headings: renderer.getHeadings(),
    usedIncremental: true,
  }
}
