/**
 * Quote-aware CLI arguments tokenizer supporting single quotes, double quotes,
 * and backslash escapes (e.g. `--config "/Users/me/My Config/agent.json"`).
 */
export function parseCliArgs(input: string): string[] {
  const args: string[] = []
  let current = ``
  let quote: `'` | `"` | null = null
  let inToken = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (quote === `'`) {
      if (ch === `'`)
        quote = null
      else
        current += ch
      continue
    }

    if (quote === `"`) {
      if (ch === `"`) {
        quote = null
      }
      else if (ch === `\\` && i + 1 < input.length && /["\\$`]/.test(input[i + 1])) {
        current += input[++i]
      }
      else {
        current += ch
      }
      continue
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        args.push(current)
        current = ``
        inToken = false
      }
      continue
    }

    if (ch === `'` || ch === `"`) {
      quote = ch
      inToken = true
      continue
    }

    if (ch === `\\` && i + 1 < input.length) {
      current += input[++i]
      inToken = true
      continue
    }

    current += ch
    inToken = true
  }

  if (inToken)
    args.push(current)

  return args
}

/**
 * Formats an argument list back into a shell-like string, quoting arguments that
 * contain whitespace or quote characters so round-tripping through `parseCliArgs`
 * preserves exact argument boundaries.
 */
export function formatCliArgs(args: readonly string[]): string {
  return args.map((arg) => {
    if (arg === ``)
      return `""`
    if (!/[\s"'\\]/.test(arg))
      return arg
    return `"${arg.replace(/([\\"$`])/g, `\\$1`)}"`
  }).join(` `)
}
