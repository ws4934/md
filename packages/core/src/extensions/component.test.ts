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
    const names = [`LeadQuote`, `Divider`, `StatCard`, `CompareCard`, `QuoteCard`, `SourceList`, `EndMark`]
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
})
