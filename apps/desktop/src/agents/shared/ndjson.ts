import { StringDecoder } from 'node:string_decoder'

export interface NdjsonLineReaderOptions {
  maxLineChars?: number
  onLine: (line: string) => void
  onOversizedLine?: (limit: number) => void
  onClose?: () => void
}

const DEFAULT_MAX_LINE_CHARS = 32 * 1024 * 1024

/**
 * Reads `\n`-delimited UTF-8 JSON-RPC lines from a Node stream without splitting
 * on `\r`, U+2028, or U+2029, and caps single-line buffering against runaway input.
 */
export function readNdjsonLines(
  input: NodeJS.ReadableStream,
  options: NdjsonLineReaderOptions,
): { close: () => void } {
  const maxLineChars = options.maxLineChars ?? DEFAULT_MAX_LINE_CHARS
  const decoder = new StringDecoder(`utf8`)
  let buffer = ``
  let discardingOversized = false
  let closed = false

  const emitLine = (raw: string) => {
    const cleaned = raw.endsWith(`\r`) ? raw.slice(0, -1) : raw
    options.onLine(cleaned)
  }

  const onData = (chunk: Uint8Array | string) => {
    if (closed)
      return
    const decoded = typeof chunk === `string` ? chunk : decoder.write(chunk as never)
    if (!decoded)
      return

    let start = 0
    if (discardingOversized) {
      const nl = decoded.indexOf(`\n`)
      if (nl === -1)
        return
      discardingOversized = false
      start = nl + 1
    }

    while (start < decoded.length) {
      const nl = decoded.indexOf(`\n`, start)
      if (nl === -1) {
        buffer += decoded.slice(start)
        if (buffer.length > maxLineChars) {
          buffer = ``
          discardingOversized = true
          options.onOversizedLine?.(maxLineChars)
        }
        return
      }

      const segment = decoded.slice(start, nl)
      start = nl + 1
      if (buffer.length + segment.length > maxLineChars) {
        buffer = ``
        options.onOversizedLine?.(maxLineChars)
        continue
      }
      const fullLine = buffer ? `${buffer}${segment}` : segment
      buffer = ``
      emitLine(fullLine)
    }
  }

  const finish = () => {
    if (closed)
      return
    closed = true
    input.off(`data`, onData)
    input.off(`end`, finish)
    input.off(`close`, finish)
    input.off(`error`, onError)
    const trailing = decoder.end()
    if (!discardingOversized) {
      const finalLine = `${buffer}${trailing}`
      buffer = ``
      if (finalLine.trim())
        emitLine(finalLine)
    }
    else {
      buffer = ``
    }
    options.onClose?.()
  }

  function onError() {
    finish()
  }

  input.on(`data`, onData)
  input.once(`end`, finish)
  input.once(`close`, finish)
  input.on(`error`, onError)

  return {
    close: finish,
  }
}
