import type { AcpHostEvent } from '@md/shared/types'

export interface AcpEventBatcherOptions {
  batchMs?: number
  onEmit: (event: AcpHostEvent) => void
}

const DEFAULT_BATCH_MS = 16

/**
 * Coalesces rapid `message_chunk` and `thought_chunk` events per session over a
 * ~16ms frame window before IPC broadcast, while flushing buffered chunks
 * immediately ahead of any non-chunk event to preserve exact timeline ordering.
 */
export class AcpEventBatcher {
  private readonly batchMs: number
  private readonly onEmit: (event: AcpHostEvent) => void
  private readonly pending = new Map<string, { type: `message_chunk` | `thought_chunk`, text: string }>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  constructor(options: AcpEventBatcherOptions) {
    this.batchMs = options.batchMs ?? DEFAULT_BATCH_MS
    this.onEmit = options.onEmit
  }

  push(event: AcpHostEvent): void {
    if (event.type === `message_chunk` || event.type === `thought_chunk`) {
      if (!event.text)
        return
      if (this.disposed || this.batchMs <= 0) {
        this.onEmit(event)
        return
      }
      const existing = this.pending.get(event.sessionId)
      if (existing && existing.type === event.type) {
        existing.text += event.text
      }
      else {
        if (existing)
          this.flushSession(event.sessionId)
        this.pending.set(event.sessionId, { type: event.type, text: event.text })
      }
      this.scheduleFlush()
      return
    }

    // Flush any buffered chunks for this session first so ordering is strictly preserved.
    if (`sessionId` in event && typeof event.sessionId === `string`)
      this.flushSession(event.sessionId)

    this.onEmit(event)
  }

  flushSession(sessionId: string): void {
    const entry = this.pending.get(sessionId)
    if (!entry)
      return
    this.pending.delete(sessionId)
    this.onEmit({
      type: entry.type,
      sessionId,
      text: entry.text,
    })
    if (this.pending.size === 0)
      this.clearTimer()
  }

  flushAll(): void {
    this.clearTimer()
    if (this.pending.size === 0)
      return
    const entries = [...this.pending.entries()]
    this.pending.clear()
    for (const [sessionId, entry] of entries) {
      this.onEmit({
        type: entry.type,
        sessionId,
        text: entry.text,
      })
    }
  }

  dispose(): void {
    this.disposed = true
    this.flushAll()
  }

  private scheduleFlush(): void {
    if (this.timer !== null)
      return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flushAll()
    }, this.batchMs)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
  }
}
