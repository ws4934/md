import { describe, expect, it } from 'vitest'
import { decodeHtmlEntities, extractUploadableImageUrls, rewriteHtmlImageSources } from './wechat-html-images'
import { DEFAULT_WECHAT_API_ORIGIN, resolveWeChatApiOrigin } from './wechat-mp'

describe(`wechat-html-images & wechat-mp utils`, () => {
  it(`decodes HTML entities without double-unescaping &amp;-prefixed sequences`, () => {
    expect(decodeHtmlEntities(`https://cdn.example.com/img.png?a=1&amp;b=2`)).toBe(`https://cdn.example.com/img.png?a=1&b=2`)
    expect(decodeHtmlEntities(`&amp;quot;&amp;lt;x&amp;gt;`)).toBe(`&quot;&lt;x&gt;`)

    const html = `<img src="https://cdn.example.com/img.png?sig=&amp;quot;keep&amp;quot;&amp;v=1" alt="test">`
    const urls = extractUploadableImageUrls(html)
    expect(urls).toEqual([`https://cdn.example.com/img.png?sig=&quot;keep&quot;&v=1`])

    const rewritten = rewriteHtmlImageSources(html, new Map([
      [`https://cdn.example.com/img.png?sig=&quot;keep&quot;&v=1`, `https://mmbiz.qpic.cn/mmbiz_png/1/0`],
    ]))
    expect(rewritten).toContain(`src="https://mmbiz.qpic.cn/mmbiz_png/1/0"`)
  })

  it(`validates WeChat proxy origins strictly`, () => {
    expect(resolveWeChatApiOrigin()).toBe(DEFAULT_WECHAT_API_ORIGIN)
    expect(resolveWeChatApiOrigin(`  https://proxy.example.com///  `)).toBe(`https://proxy.example.com`)
    expect(resolveWeChatApiOrigin(`https://proxy.example.com/wechat/`)).toBe(`https://proxy.example.com/wechat`)
    expect(() => resolveWeChatApiOrigin(`ftp://proxy.example.com`)).toThrow(/http:\/\/ or https:\/\//)
    expect(() => resolveWeChatApiOrigin(`https://`)).toThrow(/Invalid proxy origin/)
    expect(() => resolveWeChatApiOrigin(`https://user:pass@proxy.example.com`)).toThrow(/Invalid proxy origin/)
    expect(() => resolveWeChatApiOrigin(`https://proxy.example.com?token=1`)).toThrow(/Invalid proxy origin/)
  })
})
