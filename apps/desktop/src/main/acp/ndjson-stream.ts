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
    && /^(?:0|[1-9]\d*)$/.test(raw.id)
  ) {
    const numericId = Number(raw.id)
    if (Number.isSafeInteger(numericId))
      return { ...raw, id: numericId } as AnyMessage
  }
  return raw as AnyMessage
}

const MAX_NON_JSON_LINE_CHARS = 16 * 1024 * 1024
const MAX_JSON_LINE_CHARS = 64 * 1024 * 1024

function lineCharLimit(text: string): number {
  return text.trimStart().startsWith(`{`) ? MAX_JSON_LINE_CHARS : MAX_NON_JSON_LINE_CHARS
}

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

  let cancelled = false
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null

  const processLine = (
    rawLine: string,
    controller: ReadableStreamDefaultController<AnyMessage>,
  ) => {
    if (cancelled)
      return
    const line = rawLine.trim()
    if (!line)
      return

    const limit = lineCharLimit(line)
    if (line.length > limit) {
      options.onNonJsonLine?.(
        line.slice(0, 200),
        new Error(`Dropped stdout line exceeding ${limit} characters`),
      )
      return
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    }
    catch (error) {
      options.onNonJsonLine?.(line, error)
      return
    }

    if (!isPlainObject(parsed)) {
      options.onNonJsonLine?.(line, new Error(`Expected JSON-RPC object`))
      return
    }

    if (!cancelled)
      controller.enqueue(normalizeIncomingMessage(parsed))
  }

  const readable = new ReadableStream<AnyMessage>({
    async start(controller) {
      let buffer = ``
      let discardingUntilNewline = false
      const reader = input.getReader()
      activeReader = reader
      try {
        while (true) {
          if (cancelled)
            break
          const { value, done } = await reader.read()
          if (done || cancelled)
            break
          if (!value)
            continue

          let chunk = decoder.decode(value, { stream: true })

          if (discardingUntilNewline) {
            const newlineIdx = chunk.indexOf(`\n`)
            if (newlineIdx === -1)
              continue
            chunk = chunk.slice(newlineIdx + 1)
            discardingUntilNewline = false
          }

          buffer += chunk

          if (buffer.includes(`\n`)) {
            const lines = buffer.split(`\n`)
            buffer = lines.pop() ?? ``

            for (const line of lines)
              processLine(line, controller)
          }

          // Cap unbounded single-line accumulation (e.g. `\r` progress bars or runaway banners).
          if (buffer.length > 0) {
            const limit = lineCharLimit(buffer)
            if (buffer.length > limit) {
              options.onNonJsonLine?.(
                buffer.slice(0, 200),
                new Error(`Dropped stdout line exceeding ${limit} characters without newline`),
              )
              buffer = ``
              discardingUntilNewline = true
            }
          }
        }

        if (!cancelled) {
          const trailing = discardingUntilNewline ? `` : buffer + decoder.decode()
          if (trailing.trim())
            processLine(trailing, controller)
        }
      }
      catch (error) {
        if (!cancelled) {
          try {
            controller.error(error)
          }
          catch {
            // Stream was already closed or cancelled concurrently.
          }
        }
        return
      }
      finally {
        if (activeReader === reader)
          activeReader = null
        try {
          reader.releaseLock()
        }
        catch {
          // Ignore already-released reader.
        }
      }
      if (!cancelled) {
        try {
          controller.close()
        }
        catch {
          // Stream was already closed or cancelled concurrently.
        }
      }
    },
    async cancel(reason) {
      cancelled = true
      const reader = activeReader
      activeReader = null
      if (!reader)
        return
      try {
        await reader.cancel(reason)
      }
      catch {
        // Ignore underlying stream cancel errors during teardown.
      }
      finally {
        try {
          reader.releaseLock()
        }
        catch {
          // Ignore already-released reader.
        }
      }
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
