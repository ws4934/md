export interface ReadingTimeOptions {
  wordBound?: (char: string) => boolean
  wordsPerMinute?: number
}

export interface ReadTimeResults {
  text: string
  time: number
  words: number
  minutes: number
}

export type IOptions = ReadingTimeOptions
export type IReadTimeResults = ReadTimeResults

function isCJKCode(code: number): boolean {
  return (
    (code >= 0x4E00 && code <= 0x9FFF)
    || (code >= 0x3040 && code <= 0x309F)
    || (code >= 0xAC00 && code <= 0xD7A3)
    || (code >= 0x20000 && code <= 0x2EBE0)
  )
}

function isAnsiWordBoundCode(code: number): boolean {
  return code === 32 || code === 10 || code === 13 || code === 9
}

function isPunctuationCode(code: number): boolean {
  return (
    (code >= 0x21 && code <= 0x2F)
    || (code >= 0x3A && code <= 0x40)
    || (code >= 0x5B && code <= 0x60)
    || (code >= 0x7B && code <= 0x7E)
    || (code >= 0x3000 && code <= 0x303F)
    || (code >= 0xFF00 && code <= 0xFFEF)
  )
}

export default function readingTime(text: string, options: ReadingTimeOptions = {}): ReadTimeResults {
  let words = 0
  const len = text.length
  let start = 0
  let end = len - 1

  const wordsPerMinute = options.wordsPerMinute || 200
  const customWordBound = options.wordBound

  if (!customWordBound) {
    while (start <= end && isAnsiWordBoundCode(text.charCodeAt(start)))
      start++
    while (end >= start && isAnsiWordBoundCode(text.charCodeAt(end)))
      end--

    for (let index = start; index <= end; index++) {
      const code = text.charCodeAt(index)
      const cjk = isCJKCode(code)
      // Treat the synthetic sentinel at `len` as `\n` (word bound) without copying `text`.
      const nextCode = index + 1 < len ? text.charCodeAt(index + 1) : 10

      if (
        cjk
        || (!isAnsiWordBoundCode(code)
          && (isAnsiWordBoundCode(nextCode) || isCJKCode(nextCode)))
      ) {
        words++
      }

      if (cjk) {
        while (index <= end) {
          const ahead = index + 1 < len ? text.charCodeAt(index + 1) : 10
          if (!isPunctuationCode(ahead) && !isAnsiWordBoundCode(ahead))
            break
          index++
        }
      }
    }
  }
  else {
    while (start <= end && customWordBound(text[start]))
      start++
    while (end >= start && customWordBound(text[end]))
      end--

    for (let index = start; index <= end; index++) {
      const ch = text[index]
      const code = text.charCodeAt(index)
      const cjk = isCJKCode(code)
      const nextCh = index + 1 < len ? text[index + 1] : `\n`
      const nextCode = index + 1 < len ? text.charCodeAt(index + 1) : 10

      if (
        cjk
        || (!customWordBound(ch) && (customWordBound(nextCh) || isCJKCode(nextCode)))
      ) {
        words++
      }

      if (cjk) {
        while (index <= end) {
          const aheadCh = index + 1 < len ? text[index + 1] : `\n`
          const aheadCode = index + 1 < len ? text.charCodeAt(index + 1) : 10
          if (!isPunctuationCode(aheadCode) && !customWordBound(aheadCh))
            break
          index++
        }
      }
    }
  }

  const minutes = words / wordsPerMinute
  const time = Math.round(minutes * 60 * 1000)
  const displayed = Math.ceil(Number(minutes.toFixed(2)))

  return {
    text: `${displayed} min read`,
    minutes,
    time,
    words,
  }
}
