// Syntax mirrors packages/core/src/extensions/*; keep in sync when an extension's syntax changes.
export const IMAGE_GEN_WRITING_RULE = `- Illustrations: call the \`generate_image\` tool to generate custom illustrations and embed the returned \`images/...\` relative path in Markdown.`

export const ARTICLE_WRITING_RULES = `[Writing rules] The article is rendered by doocs/md into a WeChat Official Account (公众号) post. Follow these rules whenever you write or edit it:
- Write in the language of the user's request unless asked otherwise.
- Standard GitHub-flavored Markdown: headings, lists, tables, blockquotes, fenced code blocks with a language tag.
- At most one \`#\` title at the top; use \`##\` / \`###\` for sections and avoid going deeper than \`####\`.
- Images: use an absolute https:// URL, or save the image (png/jpg/gif/webp, up to 10 MB) under \`images/\` in your working directory and reference it relatively, e.g. \`![description](images/chart.png)\`. The editor uploads such files to the user's image host and swaps in the hosted URL. Never reference files outside your working directory or use file:// URLs.
- Links: write \`[text](https://...)\`. External links are rendered as numbered references at the end of the article, so give them meaningful text.
- No raw HTML/CSS (<div>, <span style>, <script>, <iframe>, ...); the theme styles everything. Only the components listed below may be written as tags.

Extended syntax supported by this editor (use it where it helps the reader, do not overuse):
- Callouts: a blockquote whose first line is \`[!NOTE]\`, \`[!TIP]\`, \`[!IMPORTANT]\`, \`[!WARNING]\` or \`[!CAUTION]\` (optional title after the marker), e.g. \`> [!TIP] Title\`; or a container \`::: tip Title\` ... \`:::\`.
- Diagrams: fenced \`\`\`mermaid or \`\`\`plantuml blocks.
- Math (KaTeX): inline \`$E=mc^2$\`, display blocks wrapped in \`$$\` lines.
- Inline marks: \`==highlight==\`, \`++underline++\`, \`~wavy underline~\`, superscript \`x^2^\`.
- Ruby annotation: \`[汉字]{hàn・zì}\`.
- Horizontal image slider on its own line: \`<![alt1](https://...),![alt2](https://...)>\`.
- Table of contents: \`[TOC]\` on its own line.
- Emoji shortcodes: \`:smile:\`.
- Components (self-closing tags, every attribute value quoted; JSON values in single quotes):
  <TipBlock type="info|success|warning|danger" title="..." content="..." />
  <AuthorBlock name="..." avatar="https://..." bio="..." />
  <QRCodeBlock url="https://..." text="..." />
  <TableBlock headers='["A","B"]' rows='[["1","2"]]' caption="..." />
  <InfoGrid items='[{"label":"...","value":"..."}]' cols="2" />
  <BadgeGroup tags='["...","..."]' />`

export function buildArticleWritingRules(options?: { imageGenEnabled?: boolean }): string {
  if (!options?.imageGenEnabled)
    return ARTICLE_WRITING_RULES
  const anchor = `- Links: write`
  const idx = ARTICLE_WRITING_RULES.indexOf(anchor)
  if (idx === -1)
    return `${ARTICLE_WRITING_RULES}\n${IMAGE_GEN_WRITING_RULE}`
  return `${ARTICLE_WRITING_RULES.slice(0, idx)}${IMAGE_GEN_WRITING_RULE}\n${ARTICLE_WRITING_RULES.slice(idx)}`
}

export const ARTICLE_FORMAT_SKILL_NAME = `md-article-format`

/** One-line pointer injected instead of the full rules once the agent has discovered the skill. */
export const ARTICLE_FORMAT_SKILL_POINTER = `Formatting: load and follow the \`${ARTICLE_FORMAT_SKILL_NAME}\` skill before writing or editing the article.`

/** `SKILL.md` installed into each workspace so agents load the writing rules on demand. */
export function buildArticleFormatSkill(options?: { imageGenEnabled?: boolean }): string {
  return `---
name: ${ARTICLE_FORMAT_SKILL_NAME}
description: Formatting rules for the doocs/md article (article.md in the working directory) - supported Markdown and extended syntax, images, links and components. Read before writing or editing the article.
---

${buildArticleWritingRules(options)}
`
}
