import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isSafeExternalUrl, resolveAppProtocolTarget } from './app-protocol'

const tempDirs: string[] = []

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `md-app-protocol-`))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(d => fs.rm(d, { recursive: true, force: true }).catch(() => undefined)))
})

describe(`app-protocol security boundaries`, () => {
  it(`confines app://md/ asset resolution against malformed %, foreign hosts, .. traversal, and symlinks`, async () => {
    const outer = await makeTempDir()
    const dist = path.join(outer, `renderer`)
    const assets = path.join(dist, `static`)
    const outsideFile = path.join(outer, `secret.txt`)
    await fs.mkdir(assets, { recursive: true })
    await fs.writeFile(path.join(dist, `index.html`), `<html></html>`, `utf8`)
    await fs.writeFile(path.join(assets, `app.js`), `console.log(1)`, `utf8`)
    await fs.writeFile(outsideFile, `SECRET`, `utf8`)
    await fs.symlink(outsideFile, path.join(assets, `leak.js`))

    const realDist = await fs.realpath(dist)
    const realAppJs = await fs.realpath(path.join(assets, `app.js`))

    expect(await resolveAppProtocolTarget(`app://md/`, dist)).toEqual({
      status: 200,
      filePath: path.join(realDist, `index.html`),
    })
    expect(await resolveAppProtocolTarget(`app://md/static/app.js`, dist)).toEqual({
      status: 200,
      filePath: realAppJs,
    })
    // SPA route fallback
    expect(await resolveAppProtocolTarget(`app://md/some/spa/route`, dist)).toEqual({
      status: 200,
      filePath: path.join(realDist, `index.html`),
    })
    // Foreign host rejected
    expect(await resolveAppProtocolTarget(`app://evil/static/app.js`, dist)).toEqual({
      status: 404,
      body: `Not Found`,
    })
    // Malformed percent-encoding returns clean 400 instead of throwing URIError
    expect(await resolveAppProtocolTarget(`app://md/%E0%A4%A`, dist)).toEqual({
      status: 400,
      body: `Bad Request`,
    })
    // Single-encoded `..` is clamped by URL parser at root and never resolves `outer/secret.txt`
    expect(await resolveAppProtocolTarget(`app://md/%2e%2e/secret.txt`, dist)).toEqual({
      status: 200,
      filePath: path.join(realDist, `index.html`),
    })
    // Encoded-slash traversal (`%2e%2e%2f` -> `/../secret.txt` after decodeURIComponent) is rejected with 403
    expect(await resolveAppProtocolTarget(`app://md/%2e%2e%2fsecret.txt`, dist)).toEqual({
      status: 403,
      body: `Forbidden`,
    })
    // Symlink pointing outside renderer root rejected
    expect(await resolveAppProtocolTarget(`app://md/static/leak.js`, dist)).toEqual({
      status: 403,
      body: `Forbidden`,
    })
  })

  it(`validates http/https URLs strictly in isSafeExternalUrl`, () => {
    expect(isSafeExternalUrl(` https://md.doocs.org/docs `)).toBe(`https://md.doocs.org/docs`)
    expect(isSafeExternalUrl(`http://localhost:5173/test`)).toBe(`http://localhost:5173/test`)
    expect(isSafeExternalUrl(`file:///etc/passwd`)).toBeNull()
    expect(isSafeExternalUrl(`javascript:alert(1)`)).toBeNull()
    expect(isSafeExternalUrl(`https://`)).toBeNull()
    expect(isSafeExternalUrl(``)).toBeNull()
    expect(isSafeExternalUrl(null)).toBeNull()
  })
})
