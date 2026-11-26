import { describe, expect, it } from 'vitest'
import { formatCliArgs, parseCliArgs } from './cli-args'

describe(`cli-args`, () => {
  it(`preserves quoted paths and escaped spaces`, () => {
    expect(parseCliArgs(`--config "/Users/me/My Config/agent.json" --flag 'hello world'`)).toEqual([
      `--config`,
      `/Users/me/My Config/agent.json`,
      `--flag`,
      `hello world`,
    ])
    expect(parseCliArgs(`--path /tmp/my\\ dir/file.txt`)).toEqual([
      `--path`,
      `/tmp/my dir/file.txt`,
    ])
    expect(parseCliArgs(`   `)).toEqual([])
  })

  it(`round-trips args with spaces and quotes`, () => {
    const original = [`-y`, `--config`, `/Users/me/My Config/agent.json`, `--label`, `say "hi"`]
    expect(parseCliArgs(formatCliArgs(original))).toEqual(original)
  })

  it(`preserves unquoted Windows backslash paths and round-trips them cleanly`, () => {
    expect(parseCliArgs(`--config C:\\Users\\me\\agent.json --dir "C:\\Users\\me\\My Config\\bin"`)).toEqual([
      `--config`,
      `C:\\Users\\me\\agent.json`,
      `--dir`,
      `C:\\Users\\me\\My Config\\bin`,
    ])
    const winArgs = [`--config`, `C:\\Users\\me\\agent.json`, `--empty`, ``]
    expect(parseCliArgs(formatCliArgs(winArgs))).toEqual(winArgs)
  })
})
