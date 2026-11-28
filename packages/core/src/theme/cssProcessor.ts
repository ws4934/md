/**
 * Runtime CSS processing in the browser (no PostCSS).
 * Resolves var() and nested custom properties.
 */

function extractCSSVariables(css: string): Map<string, string> {
  const vars = new Map<string, string>()
  const regex = /--([\w-]+)\s*:\s*([^;}\n]+)/g
  for (const match of css.matchAll(regex)) {
    vars.set(`--${match[1]}`, match[2].trim())
  }
  return vars
}

/** Index of the `)` closing the `(` at `open`, or -1 when unbalanced. */
function findClosingParen(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === `(`) {
      depth++
    }
    else if (text[i] === `)`) {
      depth--
      if (depth === 0)
        return i
    }
  }
  return -1
}

function indexOfTopLevelComma(text: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === `(`)
      depth++
    else if (text[i] === `)`)
      depth--
    else if (text[i] === `,` && depth === 0)
      return i
  }
  return -1
}

/**
 * One pass of var() substitution. Fallbacks are found by paren matching, so
 * they may nest functions to any depth, e.g. color-mix(…, rgba(…)).
 */
function replaceVarsOnce(css: string, vars: Map<string, string>): string {
  let out = ``
  let from = 0
  for (;;) {
    const start = css.indexOf(`var(`, from)
    const end = start === -1 ? -1 : findClosingParen(css, start + 3)
    if (end === -1)
      return out + css.slice(from)

    const inner = css.slice(start + 4, end)
    const comma = indexOfTopLevelComma(inner)
    const varName = (comma === -1 ? inner : inner.slice(0, comma)).trim()
    const fallback = comma === -1 ? `` : inner.slice(comma + 1).trim()
    const val = vars.get(varName)
    out += css.slice(from, start) + (val ?? (fallback || `var(${varName})`))
    from = end + 1
  }
}

/** Replace var(--xxx) with values from the CSS string (fallbacks & nesting supported) */
export function processCSS(css: string): string {
  const vars = extractCSSVariables(css)

  // Do not override from getComputedStyle — stale injected theme would lag one click behind
  let result = css
  let prev = ``
  let iterations = 0
  while (result !== prev && iterations < 10) {
    prev = result
    result = replaceVarsOnce(result, vars)
    iterations++
  }

  const calcRegex = /calc\(([^()]+)\)/g
  prev = ``
  iterations = 0
  while (result !== prev && iterations < 10) {
    prev = result
    result = result.replace(calcRegex, (_, inner: string) => evaluateCalcInner(inner.trim()))
    iterations++
  }

  return result
}

const UNITS = `px|em|rem|vw|vh|vmin|vmax|%|pt|pc|cm|mm|in|ex|ch`
const NUM = `(-?[\\d.]+)`
const UNIT_VAL = `(-?[\\d.]+)(${UNITS})?`

/** Evaluate calc() inner expression (same-unit +/-, scale with unitless operand) */
function evaluateCalcInner(expr: string): string {
  const mul = expr.match(new RegExp(`^${UNIT_VAL}\\s*\\*\\s*${UNIT_VAL}$`))
  if (mul) {
    const [, a, ua, b, ub] = mul
    if (!ua !== !ub) {
      const unit = ua || ub
      const result = round(Number.parseFloat(a) * Number.parseFloat(b))
      return `${result}${unit}`
    }
  }

  const div = expr.match(new RegExp(`^${UNIT_VAL}\\s*/\\s*${NUM}$`))
  if (div) {
    const [, a, unit,, b] = div
    const result = round(Number.parseFloat(a) / Number.parseFloat(b))
    return `${result}${unit ?? ``}`
  }

  const addSub = expr.match(new RegExp(`^${UNIT_VAL}\\s*([+-])\\s*${UNIT_VAL}$`))
  if (addSub) {
    const [, a, ua, op, b, ub] = addSub
    if (ua === ub) {
      const result = round(op === `+` ? Number.parseFloat(a) + Number.parseFloat(b) : Number.parseFloat(a) - Number.parseFloat(b))
      return `${result}${ua ?? ``}`
    }
  }

  return `calc(${expr})`
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000
}
