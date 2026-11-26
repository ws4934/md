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
    expect(html).toContain(`target="_blank"`)
    expect(html).toContain(`rel="noopener noreferrer"`)
    expect(html).toContain(`&lt;TipBlock title="x" /&gt;`)
  })

  it(`preserves file:// literals inside 4-backtick, tilde, unclosed streaming fences, and multi-backtick code spans`, () => {
    const nestedFence = renderChatMarkdown(
      `\`\`\`\`md\n\`\`\`ts\nconst raw = "[x](file:///a b)"\n\`\`\`\n\`\`\`\``,
    )
    expect(nestedFence).toContain(`file:///a b`)
    expect(nestedFence).not.toContain(`file:///a%20b`)

    const tildeAndStreaming = renderChatMarkdown([
      `~~~sh`,
      `echo "[x](file:///c d)"`,
      `~~~`,
      `Inline \`\`[x](file:///e f)\`\` span`,
      `\`\`\`ts`,
      `const unclosed = "[x](file:///g h)"`,
    ].join(`\n`))
    expect(tildeAndStreaming).toContain(`file:///c d`)
    expect(tildeAndStreaming).toContain(`file:///e f`)
    expect(tildeAndStreaming).toContain(`file:///g h`)
    expect(tildeAndStreaming).not.toContain(`%20`)
  })

  it(`handles file:// line anchors, Windows drive URIs, empty-alt images, and unsafe data/svg images safely`, () => {
    const html = renderChatMarkdown([
      `See [\`cover.png\`](file:///Users/ws/Library/Application Support/md/cover (1).png#L10-L20 "Cover")`,
      `Win [note.md](file:///C:/Users/ws/My Docs/note.md)`,
      `Empty alt ![](file:///Users/ws/Library/Application Support/md/pic.png)`,
      `Blocked svg ![](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+)`,
      `Email user@example.com stays plain text`,
    ].join(`\n\n`))

    expect(html).toContain(`data-file-path="/Users/ws/Library/Application Support/md/cover (1).png"`)
    expect(html).toContain(`data-chip-kind="image"`)
    expect(html).toContain(`>cover.png</span>`)
    expect(html).toContain(`data-file-path="C:/Users/ws/My Docs/note.md"`)
    expect(html).toContain(`data-file-path="/Users/ws/Library/Application Support/md/pic.png"`)
    expect(html).toContain(`>pic.png</span>`)
    expect(html).not.toContain(`data:image/svg+xml`)
    expect(html).not.toContain(`onload`)
    expect(html).not.toContain(`href="mailto:`)
  })
})
