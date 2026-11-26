import { describe, expect, it } from 'vitest'
import { renderChatMarkdown } from './chatMarkdown'

describe(`renderChatMarkdown`, () => {
  it(`renders headings, bold text, lists, and inline code cleanly`, () => {
    const html = renderChatMarkdown([
      `### 成稿概要`,
      `- **标题**: 《示例文章》`,
      `1. **开头**: 使用 \`wechat-minsheng\` 框架`,
    ].join(`\n`))

    expect(html).toContain(`<h3>成稿概要</h3>`)
    expect(html).toContain(`<strong>标题</strong>`)
    expect(html).toContain(`<ul>`)
    expect(html).toContain(`<ol>`)
    expect(html).toContain(`<code>wechat-minsheng</code>`)
  })

  it(`turns file:// links (including unescaped macOS spaces) into compact file chips`, () => {
    const html = renderChatMarkdown(
      `已保存到 [article.md](file:///Users/ws/Library/Application Support/md/acp-workspaces/2110e813/article.md) 和 [late-night-bills.jpg](file:///Users/ws/Library/Application Support/md/images/late-night-bills.jpg)。`,
    )

    expect(html).toContain(`class="agent-file-chip"`)
    expect(html).toContain(`data-chip-kind="file"`)
    expect(html).toContain(`data-chip-kind="image"`)
    expect(html).toContain(`>article.md</span>`)
    expect(html).toContain(`>late-night-bills.jpg</span>`)
    expect(html).not.toContain(`file:///Users/ws/Library/Application Support`)
    expect(html).not.toContain(`href="file://`)
  })

  it(`highlights fenced code blocks with a copy button header`, () => {
    const html = renderChatMarkdown(`\`\`\`ts\nconst answer = 42\n\`\`\``, { copyLabel: `复制` })

    expect(html).toContain(`class="agent-code-block"`)
    expect(html).toContain(`class="agent-code-lang">ts</span>`)
    expect(html).toContain(`data-copy-code="true"`)
    expect(html).toContain(`>复制</button>`)
    expect(html).toContain(`hljs-keyword`)
  })

  it(`neutralizes javascript: links and XSS payloads while keeping safe external links`, () => {
    const html = renderChatMarkdown(
      `[bad](javascript:alert(1)) [docs](https://md.doocs.org) <script>alert(1)</script> <TipBlock title="x" />`,
    )

    expect(html).not.toContain(`javascript:`)
    expect(html).not.toContain(`<script`)
    expect(html).toContain(`href="https://md.doocs.org"`)
    expect(html).toContain(`rel="noopener noreferrer"`)
    expect(html).toContain(`&lt;TipBlock title="x" /&gt;`)
  })
})
