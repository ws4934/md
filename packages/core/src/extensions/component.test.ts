import { Marked } from 'marked'
import { describe, expect, it } from 'vitest'
import { BUILT_IN_COMPONENTS, getBuiltInRegistry, markedComponent } from './component'

function render(md: string): string {
  const marked = new Marked()
  marked.use(markedComponent(getBuiltInRegistry))
  return (marked.parse(md) as string).trim()
}

// Theme CSS targets these exact classes and nesting; keep in sync with the theme files.
describe(`layout components`, () => {
  it(`are registered as visible built-ins`, () => {
    const names = [`LeadQuote`, `Divider`, `StatCard`, `CompareCard`, `QuoteCard`, `BillCard`, `BarChart`, `Timeline`, `TermCard`, `SourceList`, `EndMark`]
    for (const name of names)
      expect(BUILT_IN_COMPONENTS.find(c => c.name === name && !c.hidden), name).toBeDefined()
  })

  it(`renders LeadQuote around its children`, () => {
    expect(render(`<LeadQuote>一句话</LeadQuote>`)).toBe(
      `<section class="md-lead"><section class="md-lead-mark md-lead-mark-start"></section><p class="md-lead-text">一句话</p><section class="md-lead-mark md-lead-mark-end"></section></section>`,
    )
  })

  it(`renders Divider with a dot by default and a label when given`, () => {
    expect(render(`<Divider />`)).toBe(
      `<section class="md-divider"><span class="md-divider-line"></span><span class="md-divider-dot"></span><span class="md-divider-line"></span></section>`,
    )
    expect(render(`<Divider text="后来" />`)).toBe(
      `<section class="md-divider"><span class="md-divider-line"></span><span class="md-divider-text">后来</span><span class="md-divider-line"></span></section>`,
    )
  })

  it(`renders StatCard with optional unit and note`, () => {
    expect(render(`<StatCard value="12500" unit="元" label="每月开销" note="房贷 6200" />`)).toBe(
      `<section class="md-stat"><p class="md-stat-value"><span class="md-stat-number">12500</span><span class="md-stat-unit">元</span></p><p class="md-stat-label">每月开销</p><p class="md-stat-note">房贷 6200</p></section>`,
    )
    expect(render(`<StatCard value="37" label="年纪" />`)).toBe(
      `<section class="md-stat"><p class="md-stat-value"><span class="md-stat-number">37</span></p><p class="md-stat-label">年纪</p></section>`,
    )
  })

  it(`renders CompareCard with default and custom titles`, () => {
    expect(render(`<CompareCard before="甲" after="乙" />`)).toBe(
      `<section class="md-compare"><section class="md-compare-col md-compare-before"><p class="md-compare-title">以前</p><p class="md-compare-text">甲</p></section><section class="md-compare-col md-compare-after"><p class="md-compare-title">现在</p><p class="md-compare-text">乙</p></section></section>`,
    )
    const custom = render(`<CompareCard beforeTitle="A 方案" before="甲" afterTitle="B 方案" after="乙" />`)
    expect(custom).toContain(`<p class="md-compare-title">A 方案</p>`)
    expect(custom).toContain(`<p class="md-compare-title">B 方案</p>`)
  })

  it(`renders QuoteCard with an optional source`, () => {
    expect(render(`<QuoteCard source="读者">一句话</QuoteCard>`)).toBe(
      `<section class="md-quote"><p class="md-quote-text">一句话</p><p class="md-quote-source">读者</p></section>`,
    )
    expect(render(`<QuoteCard>一句话</QuoteCard>`)).toBe(
      `<section class="md-quote"><p class="md-quote-text">一句话</p></section>`,
    )
  })

  it(`renders SourceList items from JSON with the default title`, () => {
    expect(render(`<SourceList items='["来源一","来源二"]' />`)).toBe(
      `<section class="md-sources"><p class="md-sources-title">参考资料</p><p class="md-sources-item">来源一</p><p class="md-sources-item">来源二</p></section>`,
    )
    expect(render(`<SourceList title="延伸阅读" items='not json' />`)).toBe(
      `<section class="md-sources"><p class="md-sources-title">延伸阅读</p></section>`,
    )
  })

  it(`renders EndMark with END by default`, () => {
    expect(render(`<EndMark />`)).toBe(
      `<section class="md-end"><span class="md-end-line"></span><span class="md-end-text">END</span><span class="md-end-line"></span></section>`,
    )
    expect(render(`<EndMark text="完" />`)).toContain(`<span class="md-end-text">完</span>`)
  })

  it(`escapes prop values and JSON items`, () => {
    const stat = render(`<StatCard value="<b>9</b>" label="a & b" />`)
    expect(stat).toContain(`<span class="md-stat-number">&lt;b&gt;9&lt;/b&gt;</span>`)
    expect(stat).toContain(`<p class="md-stat-label">a &amp; b</p>`)
    expect(render(`<SourceList items='["<img src=x onerror=alert(1)>"]' />`))
      .toContain(`<p class="md-sources-item">&lt;img src=x onerror=alert(1)&gt;</p>`)
    expect(render(`<Divider text="&quot;x&quot;" />`)).toContain(`<span class="md-divider-text">&quot;x&quot;</span>`)
  })

  it(`renders BillCard rows, total and optional note with default labels`, () => {
    expect(render(`<BillCard items='[{"label":"房贷","value":"6200 元"},{"label":"孩子","value":2800}]' total="9000 元" note="按一家三口估算" />`)).toBe(
      `<section class="md-bill"><p class="md-bill-title">一笔账</p><p class="md-bill-row"><span class="md-bill-label">房贷</span><span class="md-bill-value">6200 元</span></p><p class="md-bill-row"><span class="md-bill-label">孩子</span><span class="md-bill-value">2800</span></p><p class="md-bill-total"><span class="md-bill-label">合计</span><span class="md-bill-value">9000 元</span></p><p class="md-bill-note">按一家三口估算</p></section>`,
    )
    expect(render(`<BillCard title="一年" items='[{"label":"学费","value":"8000"}]' totalLabel="总共" total="8000" />`)).toBe(
      `<section class="md-bill"><p class="md-bill-title">一年</p><p class="md-bill-row"><span class="md-bill-label">学费</span><span class="md-bill-value">8000</span></p><p class="md-bill-total"><span class="md-bill-label">总共</span><span class="md-bill-value">8000</span></p></section>`,
    )
  })

  it(`renders BarChart widths relative to the largest value`, () => {
    expect(render(`<BarChart title="房租" items='[{"label":"北京","value":4800},{"label":"广州","value":3000,"display":"三千"},{"label":"某地","value":1},{"label":"无","value":0}]' unit="元" note="示例" />`)).toBe(
      `<section class="md-bars"><p class="md-bars-title">房租</p>`
      + `<section class="md-bar"><p class="md-bar-head"><span class="md-bar-label">北京</span><span class="md-bar-value">4800元</span></p><section class="md-bar-track"><section class="md-bar-fill" style="width: 100%"></section></section></section>`
      + `<section class="md-bar"><p class="md-bar-head"><span class="md-bar-label">广州</span><span class="md-bar-value">三千</span></p><section class="md-bar-track"><section class="md-bar-fill" style="width: 62.5%"></section></section></section>`
      + `<section class="md-bar"><p class="md-bar-head"><span class="md-bar-label">某地</span><span class="md-bar-value">1元</span></p><section class="md-bar-track"><section class="md-bar-fill" style="width: 2%"></section></section></section>`
      + `<section class="md-bar"><p class="md-bar-head"><span class="md-bar-label">无</span><span class="md-bar-value">0元</span></p><section class="md-bar-track"><section class="md-bar-fill" style="width: 0%"></section></section></section>`
      + `<p class="md-bars-note">示例</p></section>`,
    )
    expect(render(`<BarChart items='[{"label":"a","value":3},{"label":"b","value":0}]' />`)).toBe(
      `<section class="md-bars"><section class="md-bar"><p class="md-bar-head"><span class="md-bar-label">a</span><span class="md-bar-value">3</span></p><section class="md-bar-track"><section class="md-bar-fill" style="width: 100%"></section></section></section><section class="md-bar"><p class="md-bar-head"><span class="md-bar-label">b</span><span class="md-bar-value">0</span></p><section class="md-bar-track"><section class="md-bar-fill" style="width: 0%"></section></section></section></section>`,
    )
    expect(render(`<BarChart items='[{"label":"a","value":1},{"label":"b","value":3}]' />`)).toContain(`style="width: 33.3%"`)
    expect(render(`<BarChart items='[{"label":"a","value":0}]' />`)).toContain(`style="width: 0%"`)
  })

  it(`rejects BarChart items that are not non-negative numbers`, () => {
    for (const items of [`not json`, `[]`, `{"label":"a","value":1}`, `[{"label":"a","value":"12"}]`, `[{"label":"a","value":-1}]`, `[{"label":"a"}]`, `[null]`]) {
      const html = render(`<BarChart items='${items}' />`)
      expect(html, items).toMatch(/^<p style="color:#f00;font-size:12px;">\[BarChart: /)
      expect(html, items).not.toContain(`md-bars`)
    }
  })

  it(`renders Timeline items in order`, () => {
    expect(render(`<Timeline items='[{"time":"2016 年","text":"二孩"},{"time":"2021 年","text":"三孩"}]' />`)).toBe(
      `<section class="md-timeline"><section class="md-timeline-item"><span class="md-timeline-dot"></span><p class="md-timeline-time">2016 年</p><p class="md-timeline-text">二孩</p></section><section class="md-timeline-item"><span class="md-timeline-dot"></span><p class="md-timeline-time">2021 年</p><p class="md-timeline-text">三孩</p></section></section>`,
    )
  })

  it(`renders TermCard with an optional source`, () => {
    expect(render(`<TermCard term="收入焦虑" desc="说没就没" source="读者" />`)).toBe(
      `<section class="md-term"><p class="md-term-name">收入焦虑</p><p class="md-term-desc">说没就没</p><p class="md-term-source">读者</p></section>`,
    )
    expect(render(`<TermCard term="收入焦虑" desc="说没就没" />`)).toBe(
      `<section class="md-term"><p class="md-term-name">收入焦虑</p><p class="md-term-desc">说没就没</p></section>`,
    )
  })

  it(`escapes the new components' props and JSON items`, () => {
    const bill = render(`<BillCard title="<i>t</i>" items='[{"label":"<b>a</b>","value":"1 & 2"}]' total="<s>3</s>" />`)
    expect(bill).toContain(`<p class="md-bill-title">&lt;i&gt;t&lt;/i&gt;</p>`)
    expect(bill).toContain(`<span class="md-bill-label">&lt;b&gt;a&lt;/b&gt;</span><span class="md-bill-value">1 &amp; 2</span>`)
    expect(bill).toContain(`<span class="md-bill-value">&lt;s&gt;3&lt;/s&gt;</span>`)
    const bars = render(`<BarChart title="<b>t</b>" items='[{"label":"<img src=x>","value":1,"display":"<i>1</i>"}]' note="a & b" />`)
    expect(bars).toContain(`<p class="md-bars-title">&lt;b&gt;t&lt;/b&gt;</p>`)
    expect(bars).toContain(`<span class="md-bar-label">&lt;img src=x&gt;</span><span class="md-bar-value">&lt;i&gt;1&lt;/i&gt;</span>`)
    expect(bars).toContain(`<p class="md-bars-note">a &amp; b</p>`)
    expect(render(`<BarChart items='[{"label":"a","value":1}]' unit="<b>" />`)).toContain(`<span class="md-bar-value">1&lt;b&gt;</span>`)
    expect(render(`<Timeline items='[{"time":"<b>","text":"<script>x</script>"}]' />`))
      .toContain(`<p class="md-timeline-time">&lt;b&gt;</p><p class="md-timeline-text">&lt;script&gt;x&lt;/script&gt;</p>`)
    const term = render(`<TermCard term="<b>t</b>" desc="a & b" source="&quot;s&quot;" />`)
    expect(term).toContain(`<p class="md-term-name">&lt;b&gt;t&lt;/b&gt;</p><p class="md-term-desc">a &amp; b</p><p class="md-term-source">&quot;s&quot;</p>`)
  })
})
