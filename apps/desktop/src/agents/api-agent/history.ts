import type { ModelMessage } from 'ai'

export const MAX_HISTORY_MESSAGES = 80
export const MAX_HISTORY_CHARS = 512_000

function estimateMessageChars(message: ModelMessage): number {
  if (typeof message.content === `string`)
    return message.content.length
  try {
    return JSON.stringify(message.content).length
  }
  catch {
    return 0
  }
}

function segmentHasWritingRules(segment: readonly ModelMessage[]): boolean {
  const first = segment[0]
  if (!first || first.role !== `user`)
    return false
  if (typeof first.content === `string`)
    return first.content.includes(`[Writing rules]`)
  try {
    return JSON.stringify(first.content).includes(`[Writing rules]`)
  }
  catch {
    return false
  }
}

/**
 * Bounds multi-turn conversation history at `user`-turn boundaries so tool-call /
 * tool-result pairs are never split or orphaned, while preserving Turn 1's writing
 * rules when possible and always keeping the most recent turn intact.
 */
export function trimMessageHistory(
  messages: readonly ModelMessage[],
  limits: { maxMessages?: number, maxChars?: number } = {},
): ModelMessage[] {
  const maxMessages = limits.maxMessages ?? MAX_HISTORY_MESSAGES
  const maxChars = limits.maxChars ?? MAX_HISTORY_CHARS

  let totalChars = 0
  for (const msg of messages)
    totalChars += estimateMessageChars(msg)

  if (messages.length <= maxMessages && totalChars <= maxChars)
    return [...messages]

  const segments: ModelMessage[][] = []
  for (const msg of messages) {
    if (msg.role === `user` || segments.length === 0)
      segments.push([msg])
    else
      segments[segments.length - 1].push(msg)
  }

  if (segments.length <= 1)
    return [...messages]

  const segmentChars = segments.map(seg => seg.reduce((sum, m) => sum + estimateMessageChars(m), 0))
  let totalMessages = messages.length

  const firstChars = segmentChars[0]
  const firstCount = segments[0].length
  const pinFirst = segmentHasWritingRules(segments[0])
    && firstChars <= Math.floor(maxChars / 4)
    && firstCount <= Math.floor(maxMessages / 4)

  while (segments.length > 1 && (totalMessages > maxMessages || totalChars > maxChars)) {
    const dropIndex = pinFirst && segments.length > 2 ? 1 : 0
    totalMessages -= segments[dropIndex].length
    totalChars -= segmentChars[dropIndex]
    segments.splice(dropIndex, 1)
    segmentChars.splice(dropIndex, 1)
  }

  return segments.flat()
}
