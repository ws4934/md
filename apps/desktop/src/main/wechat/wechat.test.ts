import type { WeChatPublishProgressEvent } from '@md/shared/types'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  extractUploadableImageUrls,
  isWeChatHostedImage,
  rewriteHtmlImageSources,
} from '@md/shared/utils/wechat-html-images'
import { describe, expect, it, vi } from 'vitest'
import { extractIpFromWeChatError, mapWeChatError, sanitizeWeChatText } from './errors'
import { WeChatPublisher } from './publisher'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': `application/json` },
  })
}

function binaryResponse(bytes: Uint8Array, contentType = `image/png`, status = 200): Response {
  return new Response(Uint8Array.from(bytes), {
    status,
    headers: { 'content-type': contentType },
  })
}

describe(`weChat HTML image extraction and rewrite`, () => {
  it(`deduplicates URLs, skips mmbiz.qpic.cn, and preserves all other attributes`, () => {
    const html = [
      `<section>`,
      `<img src="https://cdn.example.com/a.png?w=800&amp;q=80" alt="Hero" style="width: 100%; border-radius: 8px;" data-id="1" />`,
      `<img class="already" src="https://mmbiz.qpic.cn/mmbiz_png/existing/0?wx_fmt=png" alt="Existing">`,
      `<img src='https://cdn.example.com/a.png?w=800&amp;q=80' width="400">`,
      `<img data-src="https://ignored.example.com/lazy.png" src="data:image/png;base64,iVBORw0KGgo=" alt="Inline">`,
      `<img src="http://mmbiz.qpic.cn/mmbiz_jpg/also-wx/0">`,
      `</section>`,
    ].join(``)

    expect(isWeChatHostedImage(`https://mmbiz.qpic.cn/mmbiz_png/x/0`)).toBe(true)
    expect(isWeChatHostedImage(`https://cdn.example.com/a.png`)).toBe(false)

    const urls = extractUploadableImageUrls(html)
    expect(urls).toEqual([
      `https://cdn.example.com/a.png?w=800&q=80`,
      `data:image/png;base64,iVBORw0KGgo=`,
    ])

    const rewritten = rewriteHtmlImageSources(html, new Map([
      [`https://cdn.example.com/a.png?w=800&q=80`, `http://mmbiz.qpic.cn/mmbiz_png/newA/0?wx_fmt=png`],
      [`data:image/png;base64,iVBORw0KGgo=`, `http://mmbiz.qpic.cn/mmbiz_png/newInline/0?wx_fmt=png`],
    ]))

    expect(rewritten).toContain(`<img src="http://mmbiz.qpic.cn/mmbiz_png/newA/0?wx_fmt=png" alt="Hero" style="width: 100%; border-radius: 8px;" data-id="1" />`)
    expect(rewritten).toContain(`<img class="already" src="https://mmbiz.qpic.cn/mmbiz_png/existing/0?wx_fmt=png" alt="Existing">`)
    expect(rewritten).toContain(`<img src='http://mmbiz.qpic.cn/mmbiz_png/newA/0?wx_fmt=png' width="400">`)
    expect(rewritten).toContain(`<img data-src="https://ignored.example.com/lazy.png" src="http://mmbiz.qpic.cn/mmbiz_png/newInline/0?wx_fmt=png" alt="Inline">`)
    expect(rewritten).toContain(`<img src="http://mmbiz.qpic.cn/mmbiz_jpg/also-wx/0">`)
  })
})

describe(`weChat errcode mapping`, () => {
  it(`maps 40164 with extracted egress IP and actionable guidance`, () => {
    const raw = `invalid ip 203.0.113.42 ipv6 ::ffff:203.0.113.42, not in whitelist rid: 12345`
    expect(extractIpFromWeChatError(raw)).toBe(`203.0.113.42`)

    const mapped = mapWeChatError(40164, raw)
    expect(mapped.errorCodeKey).toBe(`ip_not_whitelisted`)
    expect(mapped.egressIp).toBe(`203.0.113.42`)
    expect(mapped.message).toContain(`203.0.113.42`)
    expect(mapped.message).toContain(`40164`)
    expect(mapped.message.toLowerCase()).toContain(`whitelist`)
  })

  it(`maps 48001, 40007, 45009, 40013, and unknown errcodes`, () => {
    const e48001 = mapWeChatError(48001, `api unauthorized`)
    expect(e48001.errorCodeKey).toBe(`api_unauthorized`)
    expect(e48001.message).toContain(`48001`)

    const e40007 = mapWeChatError(40007, `invalid media_id`)
    expect(e40007.errorCodeKey).toBe(`invalid_media`)
    expect(e40007.message).toContain(`40007`)

    const e45009 = mapWeChatError(45009, `reach max api daily quota limit`)
    expect(e45009.errorCodeKey).toBe(`quota_exceeded`)
    expect(e45009.message).toContain(`45009`)

    const e40013 = mapWeChatError(40013, `invalid appid`)
    expect(e40013.errorCodeKey).toBe(`invalid_credentials`)

    const unknown = mapWeChatError(99999, `secret leaked super-secret-value`, { secret: `super-secret-value` })
    expect(unknown.errorCodeKey).toBe(`unknown`)
    expect(unknown.message).not.toContain(`super-secret-value`)
    expect(sanitizeWeChatText(`url?access_token=abc123&secret=xyz`, `xyz`)).not.toContain(`abc123`)
  })
})

describe(`weChatPublisher state machine`, () => {
  it(`saves to draft box with token caching, deduplicated concurrent image uploads, and progress reporting`, async () => {
    const events: WeChatPublishProgressEvent[] = []
    const calls: string[] = []
    let draftBody: any = null
    let uploadImgCalls = 0
    let activeUploadImg = 0
    let maxConcurrentUploadImg = 0

    const mockFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === `string` ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)

      if (url === `https://api.weixin.qq.com/cgi-bin/stable_token`) {
        return jsonResponse({ access_token: `tok_123`, expires_in: 7200 })
      }
      if (url.startsWith(`https://cdn.example.com/`)) {
        return binaryResponse(new Uint8Array([1, 2, 3, 4]), `image/png`)
      }
      if (url.startsWith(`https://api.weixin.qq.com/cgi-bin/media/uploadimg`)) {
        uploadImgCalls += 1
        activeUploadImg += 1
        maxConcurrentUploadImg = Math.max(maxConcurrentUploadImg, activeUploadImg)
        const id = uploadImgCalls
        await new Promise(resolve => setTimeout(resolve, 15))
        activeUploadImg -= 1
        return jsonResponse({ url: `http://mmbiz.qpic.cn/mmbiz_png/u_${id}/0?wx_fmt=png` })
      }
      if (url.startsWith(`https://api.weixin.qq.com/cgi-bin/material/add_material`)) {
        return jsonResponse({ media_id: `thumb_media_001`, url: `http://mmbiz.qpic.cn/cover/0` })
      }
      if (url.startsWith(`https://api.weixin.qq.com/cgi-bin/draft/add`)) {
        draftBody = JSON.parse(String(init?.body ?? `{}`))
        return jsonResponse({ media_id: `draft_media_999` })
      }
      throw new Error(`Unexpected fetch URL: ${url}`)
    }) as unknown as typeof fetch

    const publisher = new WeChatPublisher({
      fetchFn: mockFetch,
      concurrency: 2,
      onProgress: ev => events.push(ev),
    })

    const html = [
      `<p>Intro</p>`,
      `<img src="https://cdn.example.com/1.png" alt="one" />`,
      `<img src="https://cdn.example.com/1.png" alt="one-dup" />`,
      `<img src="https://cdn.example.com/2.png" alt="two" />`,
      `<img src="https://cdn.example.com/3.png" alt="three" />`,
      `<img src="https://mmbiz.qpic.cn/mmbiz_png/keep/0" alt="keep" />`,
    ].join(``)

    const result = await publisher.publish({
      publishId: `pub-draft-1`,
      credentials: { appID: `wx_app_1`, appsecret: `very_secret_val` },
      mode: `draft`,
      title: `My Great Article`,
      author: `doocs`,
      digest: `Short summary`,
      contentHtml: html,
      coverSource: `https://cdn.example.com/cover.png`,
      needOpenComment: true,
    })

    expect(result).toEqual({
      ok: true,
      mode: `draft`,
      mediaId: `draft_media_999`,
      uploadedImageCount: 3,
    })

    // Unique external images = 3 (1.png deduped, mmbiz.qpic.cn skipped)
    expect(uploadImgCalls).toBe(3)
    expect(maxConcurrentUploadImg).toBeLessThanOrEqual(2)
    expect(draftBody.articles[0].thumb_media_id).toBe(`thumb_media_001`)
    expect(draftBody.articles[0].need_open_comment).toBe(1)
    expect(draftBody.articles[0].content).not.toContain(`https://cdn.example.com/`)
    expect(draftBody.articles[0].content).toContain(`https://mmbiz.qpic.cn/mmbiz_png/keep/0`)

    // Verify ordered stages and per-image progress
    expect(events.map(e => e.stage)).toEqual([`token`, `images`, `images`, `images`, `images`, `cover`, `draft`, `done`])
    const imageEvents = events.filter(e => e.stage === `images`)
    expect(imageEvents.map(e => `${e.currentImage}/${e.totalImages}`)).toEqual([`0/3`, `1/3`, `2/3`, `3/3`])

    // Second draft call reuses cached stable_token
    await publisher.publish({
      credentials: { appID: `wx_app_1`, appsecret: `very_secret_val` },
      mode: `draft`,
      title: `Second Draft`,
      contentHtml: `<p>No images</p>`,
      coverSource: `data:image/png;base64,iVBORw0KGgo=`,
      needOpenComment: false,
    })
    const tokenCalls = calls.filter(u => u.endsWith(`/cgi-bin/stable_token`))
    expect(tokenCalls).toHaveLength(1)
  })

  it(`refreshes expired token once on 40001 and surfaces 48001/45009 errors`, async () => {
    let tokenCounter = 0
    let draftAttempts = 0

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === `string` ? input : input instanceof URL ? input.toString() : input.url
      if (url === `https://api.weixin.qq.com/cgi-bin/stable_token`) {
        tokenCounter += 1
        return jsonResponse({ access_token: `tok_${tokenCounter}`, expires_in: 7200 })
      }
      if (url.startsWith(`https://api.weixin.qq.com/cgi-bin/material/add_material`))
        return jsonResponse({ media_id: `cover_ok` })
      if (url.startsWith(`https://api.weixin.qq.com/cgi-bin/draft/add`)) {
        draftAttempts += 1
        if (draftAttempts === 1)
          return jsonResponse({ errcode: 40001, errmsg: `invalid credential` })
        return jsonResponse({ media_id: `draft_after_retry` })
      }
      if (url.startsWith(`https://api.weixin.qq.com/cgi-bin/freepublish/submit`))
        return jsonResponse({ errcode: 48001, errmsg: `api unauthorized` })
      throw new Error(`Unexpected URL: ${url}`)
    }) as unknown as typeof fetch

    const publisher = new WeChatPublisher({ fetchFn: mockFetch })

    const result = await publisher.publish({
      credentials: { appID: `wx_retry`, appsecret: `sec_retry` },
      mode: `publish`,
      title: `Token Retry & 48001`,
      contentHtml: `<p>Body</p>`,
      coverSource: `data:image/png;base64,iVBORw0KGgo=`,
      needOpenComment: false,
    })

    expect(tokenCounter).toBe(2)
    expect(draftAttempts).toBe(2)
    expect(result.ok).toBe(false)
    expect(result.errcode).toBe(48001)
    expect(result.errorCodeKey).toBe(`api_unauthorized`)
    expect(result.mediaId).toBe(`draft_after_retry`)
  })

  it(`publishes directly with local cover file, honours proxyOrigin, and handles poll failure`, async () => {
    const events: WeChatPublishProgressEvent[] = []
    let pollCount = 0

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === `string` ? input : input instanceof URL ? input.toString() : input.url
      if (url === `https://proxy.example.com/cgi-bin/stable_token`)
        return jsonResponse({ access_token: `tok_proxy`, expires_in: 7200 })
      if (url.startsWith(`https://proxy.example.com/cgi-bin/material/add_material`))
        return jsonResponse({ media_id: `cover_media_2` })
      if (url.startsWith(`https://proxy.example.com/cgi-bin/draft/add`))
        return jsonResponse({ media_id: `draft_media_2` })
      if (url.startsWith(`https://proxy.example.com/cgi-bin/freepublish/submit`))
        return jsonResponse({ errcode: 0, errmsg: `ok`, publish_id: `pub_task_42` })
      if (url.startsWith(`https://proxy.example.com/cgi-bin/freepublish/get`)) {
        pollCount += 1
        if (pollCount === 1)
          return jsonResponse({ publish_id: `pub_task_42`, publish_status: 1 })
        if (pollCount === 2) {
          return jsonResponse({
            publish_id: `pub_task_42`,
            publish_status: 0,
            article_detail: {
              count: 1,
              item: [{ idx: 1, article_url: `https://mp.weixin.qq.com/s/published_article_123` }],
            },
          })
        }
        return jsonResponse({ publish_id: `pub_task_42`, publish_status: 4 })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }) as unknown as typeof fetch

    const publisher = new WeChatPublisher({
      fetchFn: mockFetch,
      readLocalFile: async () => ({
        buffer: new Uint8Array([0x89, 0x50, 0x4E, 0x47]),
        mimeType: `image/png`,
        filename: `local-cover.png`,
      }),
      sleepFn: async () => {},
      onProgress: ev => events.push(ev),
    })
    publisher.allowLocalImagePath(`/tmp/local-cover.png`)

    const success = await publisher.publish({
      publishId: `pub-direct-1`,
      credentials: {
        appID: `wx_app_proxy`,
        appsecret: `secret_proxy_123`,
        proxyOrigin: `https://proxy.example.com/`,
      },
      mode: `publish`,
      title: `Direct Publish Test`,
      contentHtml: `<p>Hello WeChat</p>`,
      coverSource: `/tmp/local-cover.png`,
      needOpenComment: true,
    })

    expect(success).toEqual({
      ok: true,
      mode: `publish`,
      mediaId: `draft_media_2`,
      publishTaskId: `pub_task_42`,
      articleUrl: `https://mp.weixin.qq.com/s/published_article_123`,
      uploadedImageCount: 0,
    })
    expect(events.map(e => e.stage)).toEqual([`token`, `cover`, `draft`, `publishing`, `polling`, `done`])

    // Next publish fails during WeChat content review (publish_status = 4)
    const failed = await publisher.publish({
      publishId: `pub-direct-2`,
      credentials: {
        appID: `wx_app_proxy`,
        appsecret: `secret_proxy_123`,
        proxyOrigin: `https://proxy.example.com`,
      },
      mode: `publish`,
      title: `Rejected Article`,
      contentHtml: `<p>Hello</p>`,
      coverSource: `/tmp/local-cover.png`,
      needOpenComment: false,
    })
    expect(failed.ok).toBe(false)
    expect(failed.errorCodeKey).toBe(`publish_failed`)
    expect(failed.mediaId).toBe(`draft_media_2`)
  })

  it(`surfaces 40164 IP whitelist error with fallback egress IP and never leaks appsecret`, async () => {
    const events: WeChatPublishProgressEvent[] = []
    const secret = `ultra_sensitive_secret_987`

    const mockFetch = vi.fn(async () => {
      return jsonResponse({
        errcode: 40164,
        errmsg: `not in whitelist secret=${secret}`,
      })
    }) as unknown as typeof fetch

    const publisher = new WeChatPublisher({
      fetchFn: mockFetch,
      resolveEgressIp: async () => `198.51.100.77`,
      onProgress: ev => events.push(ev),
    })

    const result = await publisher.publish({
      credentials: { appID: `wx_app_2`, appsecret: secret },
      mode: `draft`,
      title: `Blocked by IP`,
      contentHtml: `<p>Hi</p>`,
      coverSource: `data:image/png;base64,iVBORw0KGgo=`,
      needOpenComment: false,
    })

    expect(result.ok).toBe(false)
    expect(result.errcode).toBe(40164)
    expect(result.errorCodeKey).toBe(`ip_not_whitelisted`)
    expect(result.egressIp).toBe(`198.51.100.77`)
    expect(result.error).toContain(`198.51.100.77`)
    expect(result.error).not.toContain(secret)
    expect(JSON.stringify(events)).not.toContain(secret)
  })

  it(`reuses cached stable_token across uploadImage and publish`, async () => {
    let tokenCalls = 0
    const endpoints: string[] = []
    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === `string` ? input : input instanceof URL ? input.toString() : input.url
      endpoints.push(url)
      if (url.endsWith(`/cgi-bin/stable_token`)) {
        tokenCalls++
        return jsonResponse({ access_token: `shared_tok`, expires_in: 7200 })
      }
      if (url.includes(`/cgi-bin/media/uploadimg`))
        return jsonResponse({ url: `http://mmbiz.qpic.cn/mmbiz_png/shared/0` })
      if (url.includes(`/cgi-bin/material/add_material`))
        return jsonResponse({ media_id: `cover_1`, url: `http://mmbiz.qpic.cn/mmbiz_png/cover/0` })
      if (url.includes(`/cgi-bin/draft/add`))
        return jsonResponse({ media_id: `draft_1` })
      return jsonResponse({ errcode: 500, errmsg: `unexpected` }, 500)
    }) as unknown as typeof fetch

    const publisher = new WeChatPublisher({ fetchFn: mockFetch })
    const credentials = { appID: `wx_shared`, appsecret: `sec_shared` }

    const uploaded = await publisher.uploadImage({
      credentials,
      dataUrl: `data:image/png;base64,iVBORw0KGgo=`,
      filename: `pic.png`,
      mimeType: `image/png`,
      byteSize: 128,
    })
    expect(uploaded).toEqual({ ok: true, url: `http://mmbiz.qpic.cn/mmbiz_png/shared/0` })

    const published = await publisher.publish({
      credentials,
      mode: `draft`,
      title: `Reuse Token`,
      contentHtml: `<p>Hello</p>`,
      coverSource: `data:image/png;base64,iVBORw0KGgo=`,
      needOpenComment: false,
    })
    expect(published.ok).toBe(true)
    expect(tokenCalls).toBe(1)
    expect(endpoints.some(u => u.includes(`/cgi-bin/media/uploadimg`))).toBe(true)
  })

  it(`normalizes protocol-relative cover URLs to https and rejects unpicked local file paths`, async () => {
    const fetchedUrls: string[] = []
    const readLocalFile = vi.fn(async () => ({
      buffer: new Uint8Array([0x89, 0x50, 0x4E, 0x47]),
      mimeType: `image/png`,
      filename: `secret.png`,
    }))

    const mockFetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === `string` ? input : input instanceof URL ? input.toString() : input.url
      fetchedUrls.push(url)
      if (url.endsWith(`/cgi-bin/stable_token`))
        return jsonResponse({ access_token: `tok_proto`, expires_in: 7200 })
      if (url === `https://cdn.example.com/proto-cover.png`)
        return binaryResponse(new Uint8Array([1, 2, 3]), `image/png`)
      if (url.includes(`/cgi-bin/material/add_material`))
        return jsonResponse({ media_id: `cover_proto` })
      if (url.includes(`/cgi-bin/draft/add`))
        return jsonResponse({ media_id: `draft_proto` })
      throw new Error(`Unexpected URL: ${url}`)
    }) as unknown as typeof fetch

    const publisher = new WeChatPublisher({
      fetchFn: mockFetch,
      readLocalFile,
    })

    const protoResult = await publisher.publish({
      credentials: { appID: `wx_proto`, appsecret: `sec_proto` },
      mode: `draft`,
      title: `Protocol Relative Cover`,
      contentHtml: `<p>Body</p>`,
      coverSource: `//cdn.example.com/proto-cover.png`,
      needOpenComment: false,
    })
    expect(protoResult.ok).toBe(true)
    expect(fetchedUrls).toContain(`https://cdn.example.com/proto-cover.png`)
    expect(readLocalFile).not.toHaveBeenCalled()

    const blockedResult = await publisher.publish({
      credentials: { appID: `wx_proto`, appsecret: `sec_proto` },
      mode: `draft`,
      title: `Arbitrary Local Cover`,
      contentHtml: `<p>Body</p>`,
      coverSource: `/tmp/not-picked-by-user.png`,
      needOpenComment: false,
    })
    expect(blockedResult.ok).toBe(false)
    expect(blockedResult.error).toMatch(/image picker/i)
    expect(readLocalFile).not.toHaveBeenCalled()

    // Symlink swap check: replacing an allowed path with a symlink to another file must be rejected.
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `md-wechat-symlink-`))
    try {
      const pickedFile = path.join(tmpDir, `picked.png`)
      const secretFile = path.join(tmpDir, `secret.png`)
      await fs.writeFile(pickedFile, new Uint8Array([0x89, 0x50, 0x4E, 0x47, 1]))
      await fs.writeFile(secretFile, new Uint8Array([0x89, 0x50, 0x4E, 0x47, 9]))

      const realPublisher = new WeChatPublisher({ fetchFn: mockFetch })
      realPublisher.allowLocalImagePath(pickedFile)

      await fs.unlink(pickedFile)
      await fs.symlink(secretFile, pickedFile)

      const swappedResult = await realPublisher.publish({
        credentials: { appID: `wx_proto`, appsecret: `sec_proto` },
        mode: `draft`,
        title: `Symlink Swapped Cover`,
        contentHtml: `<p>Body</p>`,
        coverSource: pickedFile,
        needOpenComment: false,
      })
      expect(swappedResult.ok).toBe(false)
      expect(swappedResult.error).toMatch(/image picker/i)
    }
    finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  })
})
