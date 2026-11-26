// `![alt](ref "title")`; `ref` may be wrapped in <> when it contains spaces. Also matches slider items.
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
const HAS_SCHEME_RE = /^(?:[a-z][a-z\d+.-]*:|\/\/|\\\\|#)/i

function unwrap(ref: string): string {
  return ref.startsWith(`<`) ? ref.slice(1, -1) : ref
}

function matchFencePrefix(line: string): { char: string, count: number, rest: string } | null {
  let i = 0
  while (i < 3 && i < line.length && (line[i] === ` ` || line[i] === `\t`))
    i++
  const ch = line[i]
  if (ch !== `\`` && ch !== `~`)
    return null
  let count = 0
  while (i + count < line.length && line[i + count] === ch)
    count++
  if (count < 3)
    return null
  return { char: ch, count, rest: line.slice(i + count) }
}

function mapOutsideFencedCode(markdown: string, transform: (segment: string) => string): string {
  let out = ``
  let plainStart = 0
  let fenceStart = -1
  let fenceChar = ``
  let fenceLen = 0
  let pos = 0

  while (pos < markdown.length) {
    const nl = markdown.indexOf(`\n`, pos)
    const lineEnd = nl === -1 ? markdown.length : nl + 1
    const bodyEnd = nl === -1
      ? markdown.length
      : (nl > pos && markdown[nl - 1] === `\r` ? nl - 1 : nl)
    const rawLine = markdown.slice(pos, bodyEnd)

    if (fenceStart === -1) {
      const prefix = matchFencePrefix(rawLine)
      if (prefix && (prefix.char !== `\`` || !prefix.rest.includes(`\``))) {
        if (pos > plainStart)
          out += transform(markdown.slice(plainStart, pos))
        fenceStart = pos
        fenceChar = prefix.char
        fenceLen = prefix.count
      }
    }
    else {
      const prefix = matchFencePrefix(rawLine)
      if (prefix && prefix.char === fenceChar && prefix.count >= fenceLen && prefix.rest.trim() === ``) {
        out += markdown.slice(fenceStart, lineEnd)
        fenceStart = -1
        plainStart = lineEnd
      }
    }

    pos = lineEnd
  }

  if (fenceStart !== -1)
    out += markdown.slice(fenceStart)
  else if (plainStart < markdown.length)
    out += transform(markdown.slice(plainStart))

  return out
}

/** Image paths with no URL scheme outside fenced code blocks, i.e. files the agent saved locally. */
export function findLocalImageRefs(markdown: string): string[] {
  const refs = new Set<string>()
  mapOutsideFencedCode(markdown, (segment) => {
    for (const match of segment.matchAll(MD_IMAGE_RE)) {
      const ref = unwrap(match[1])
      if (ref && !HAS_SCHEME_RE.test(ref))
        refs.add(ref)
    }
    return ``
  })
  return [...refs]
}

export function replaceImageRefs(markdown: string, urls: Map<string, string>): string {
  if (urls.size === 0)
    return markdown
  return mapOutsideFencedCode(markdown, segment =>
    segment.replace(MD_IMAGE_RE, (whole, rawRef: string) => {
      const url = urls.get(unwrap(rawRef))
      if (!url)
        return whole
      const formattedUrl = /[\s()]/.test(url) ? `<${url}>` : url
      // Alt text cannot contain `]`, so the first `](` marks where the ref starts.
      const at = whole.indexOf(rawRef, whole.indexOf(`](`))
      return whole.slice(0, at) + formattedUrl + whole.slice(at + rawRef.length)
    }),
  )
}
