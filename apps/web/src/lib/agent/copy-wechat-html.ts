import { nextTick } from 'vue'
import { toast } from 'vue-sonner'
import { t } from '@/i18n/translate'
import { delay } from '@/lib/delay'
import { processClipboardContent } from '@/services/export'

export interface CopyWeChatHtmlOptions {
  primaryColor: string
  delayMs?: number
  onStart?: () => void
  onEnd?: () => void
  onRefresh?: () => void
}

/**
 * Copy rendered WeChat-formatted HTML to the clipboard with an empty-HTML guard,
 * toast feedback, and consistent cleanup callbacks.
 */
export async function copyWeChatHtmlToClipboard(options: CopyWeChatHtmlOptions): Promise<boolean> {
  options.onStart?.()
  try {
    await nextTick()
    if (options.delayMs)
      await delay(options.delayMs)

    const processed = await processClipboardContent(options.primaryColor)
    if (!processed.html.trim()) {
      toast.error(t(`agent.publish.errors.emptyContent`))
      options.onRefresh?.()
      return false
    }

    const item = new ClipboardItem({
      'text/html': new Blob([processed.html], { type: `text/html` }),
      'text/plain': new Blob([processed.plainText], { type: `text/plain` }),
    })
    await navigator.clipboard.write([item])
    toast.success(t(`agent.toolbar.copiedToWeChat`))
    options.onRefresh?.()
    return true
  }
  catch (error) {
    toast.error(t(`toast.copyFailed`, { message: error instanceof Error ? error.message : String(error) }))
    options.onRefresh?.()
    return false
  }
  finally {
    options.onEnd?.()
  }
}
