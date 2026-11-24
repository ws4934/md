import type { AnyMessage, Stream } from '@agentclientprotocol/sdk/unstable'

export interface SafeNdJsonStreamOptions {
  onNonJsonLine?: (line: string, error: unknown) => void
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === `object` && value !== null && !Array.isArray(value)
}

function normalizeIncomingMessage(raw: Record<string, unknown>): AnyMessage {
  // Some ACP implementations serialize numeric response IDs as strings;
  // normalize them back so the SDK matches pending numeric request IDs.
  if (
    `id` in raw
    && !(`method` in raw)
    && typeof raw.id === `string`
    && /^\d+$/.test(raw.id)
  ) {
    const numericId = Number(raw.id)
    if (Number.isSafeInteger(numericId))
      return { ...raw, id: numericId } as AnyMessage
  }
  return raw as AnyMessage
}

const MAX_NON_JSON_LINE_CHARS = 16 * 1024 * 1024
const MAX_JSON_LINE_CHARS = 64 * 1024 * 1024

/**
 * Wraps child stdio byte streams as an ACP NDJSON Stream, skipping and logging
 * non-JSON stdout lines (e.g. CLI banners or warnings) instead of crashing.
 */
export function createSafeNdJsonStream(
  output: WritableStream<Uint8Array>,
  input: ReadableStream<Uint8Array>,
  options: SafeNdJsonStreamOptions = {},
): Stream {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()

  const processLine = (
    rawLine: string,
    controller: ReadableStreamDefaultController<AnyMessage>,
  ) => {
    const line = rawLine.trim()
    if (!line)
      return

    try {
      const parsed: unknown = JSON.parse(line)
      if (!isPlainObject(parsed)) {
        options.onNonJsonLine?.(line, new Error(`Expected JSON-RPC object`))
        return
      }
      controller.enqueue(normalizeIncomingMessage(parsed))
    }
    catch (error) {
      options.onNonJsonLine?.(line, error)
    }
  }

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      let buffer = ``
      const reader = input.getReader()
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done)
            break
          if (!value)
            continue

          buffer += decoder.decode(value, { stream: true })

          if (!buffer.includes(`\n`)) {
            // Cap unbounded single-line accumulation (e.g. `\r` progress bars or runaway banners).
            const trimmedStart = buffer.trimStart()
            const looksLikeJson = trimmedStart.startsWith(`{`)
            const limit = looksLikeJson ? MAX_JSON_LINE_CHARS : MAX_NON_JSON_LINE_CHARS
            if (buffer.length > limit) {
              options.onNonJsonLine?.(
                buffer.slice(0, 200),
                new Error(`Dropped stdout line exceeding ${limit} characters without newline`),
              )
              buffer = ``
            }
            continue
          }

          const lines = buffer.split(`\n`)
          buffer = lines.pop() ?? ``

          for (const line of lines)
            processLine(line, controller)
        }

        const trailing = buffer + decoder.decode()
        if (trailing.trim())
          processLine(trailing, controller)
      }
      catch (error) {
        controller.error(error)
        return
      }
      finally {
        reader.releaseLock()
      }
      controller.close()
    },
  })

  // Hold a single writer across the stream's lifetime instead of acquiring/releasing per message.
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  const getWriter = () => {
    if (!writer)
      writer = output.getWriter()
    return writer
  }
  const releaseWriter = () => {
    if (!writer)
      return
    try {
      writer.releaseLock()
    }
    catch {
      // Ignore already-released writer.
    }
    writer = null
  }

  const writable = new WritableStream<AnyMessage>({
    start() {
      getWriter()
    },
    async write(message) {
      await getWriter().write(encoder.encode(`${JSON.stringify(message)}\n`))
    },
    async close() {
      if (!writer)
        return
      try {
        await writer.close()
      }
      finally {
        releaseWriter()
      }
    },
    async abort(reason) {
      if (!writer)
        return
      try {
        await writer.abort(reason)
      }
      finally {
        releaseWriter()
      }
    },
  })

  return { readable, writable }
}
