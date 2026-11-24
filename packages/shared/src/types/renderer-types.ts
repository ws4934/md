import type { ReadTimeResults } from '../utils/readingTime'
import type { IOpts } from './common'
import type { FrontMatterData } from './front-matter'

export interface CollectedHeading {
  level: number
  text: string
}

export interface TocHeadingEntry {
  text: string
  depth: number
}

export interface IndexedTocHeading extends TocHeadingEntry {
  index: number
}

export interface CiteLinkEntry {
  localIndex: number
  title: string
  link: string
}

export interface RenderBlockOptions {
  /** Tag cite superscripts with `data-md-cite="<localIndex>"` for incremental global renumbering. */
  tagCiteIndices?: boolean
  /** Pre-collected document headings used when rendering a `[TOC]` block incrementally. */
  tocHeadings?: IndexedTocHeading[]
}

export interface RenderBlockResult {
  html: string
  headings: CollectedHeading[]
  tocHeadings: TocHeadingEntry[]
  citeLinks: CiteLinkEntry[]
}

export interface RendererAPI {
  /* Lifecycle */
  reset: (newOpts: Partial<IOpts>) => void
  setOptions: (newOpts: Partial<IOpts>) => void
  getOpts: () => IOpts

  /* Markdown */
  parseFrontMatterAndContent: (markdown: string) => {
    yamlData: FrontMatterData
    markdownContent: string
    readingTime: ReadTimeResults
  }
  renderMarkdownToHtml: (markdown: string) => string
  /** Render a single top-level markdown block in isolation, returning collected metadata. */
  renderBlock?: (markdown: string, options?: RenderBlockOptions) => RenderBlockResult
  /** Restore document-level collected headings and cite footnotes after incremental assembly. */
  setCollectedState?: (state: {
    headings: CollectedHeading[]
    footnotes: [number, string, string][]
  }) => void

  /* HTML assembly */
  buildReadingTime: (reading: ReadTimeResults) => string
  buildFootnotes: () => string
  buildAddition: () => string
  createContainer: (html: string) => string

  /** Headings collected during render (document order, incl. footnote title). */
  getHeadings: () => CollectedHeading[]
}
