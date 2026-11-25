// `![alt](ref "title")`; `ref` may be wrapped in <> when it contains spaces. Also matches slider items.
const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*(<[^>\n]*>|[^\s)]+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g
const HAS_SCHEME_RE = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i

function unwrap(ref: string): string {
  return ref.startsWith(`<`) ? ref.slice(1, -1) : ref
}

/** Image paths with no URL scheme, i.e. files the agent saved locally. */
export function findLocalImageRefs(markdown: string): string[] {
  const refs = new Set<string>()
  for (const match of markdown.matchAll(MD_IMAGE_RE)) {
    const ref = unwrap(match[1])
    if (ref && !HAS_SCHEME_RE.test(ref))
      refs.add(ref)
  }
  return [...refs]
}

export function replaceImageRefs(markdown: string, urls: Map<string, string>): string {
  return markdown.replace(MD_IMAGE_RE, (whole, rawRef: string) => {
    const url = urls.get(unwrap(rawRef))
    if (!url)
      return whole
    // Alt text cannot contain `]`, so the first `](` marks where the ref starts.
    const at = whole.indexOf(rawRef, whole.indexOf(`](`))
    return whole.slice(0, at) + url + whole.slice(at + rawRef.length)
  })
}
