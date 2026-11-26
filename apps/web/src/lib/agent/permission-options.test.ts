// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { ensureLocaleMessages, setupI18n } from '@/i18n'
import { useAcpPermissionOptions } from './permission-options'

describe(`useAcpPermissionOptions`, () => {
  it(`tracks locale changes internally without caller wrappers`, async () => {
    const i18n = await setupI18n(`zh-CN`)
    await ensureLocaleMessages(i18n, `en-US`)

    let captured!: ReturnType<typeof useAcpPermissionOptions>
    const Harness = defineComponent({
      setup() {
        captured = useAcpPermissionOptions()
        return () => h(`div`)
      },
    })

    const host = document.createElement(`div`)
    const app = createApp(Harness)
    app.use(i18n)
    app.mount(host)

    const zhAsk = captured.value[0].shortLabel
    expect(zhAsk).toBeTruthy()

    if (typeof i18n.global.locale === `object`)
      i18n.global.locale.value = `en-US`

    const enAsk = captured.value[0].shortLabel
    expect(enAsk).not.toBe(zhAsk)
    expect(enAsk).toBe(`Ask`)

    app.unmount()
  })
})
