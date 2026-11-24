import { describe, expect, it } from 'vitest'
import { getCustomExtraModes, mapAcpModeIdToPermissionLevel, mapPermissionLevelToAcpModeId, resolveNativeModeIdForLevel } from './acp-permissions'

describe(`acp permission mode mapping`, () => {
  it(`does not treat agent "auto" modes as bypass`, () => {
    // Antigravity / Codex `auto` still asks before risky actions; only explicit full-permission modes are bypass.
    expect(mapAcpModeIdToPermissionLevel(`auto`)).toBeNull()
    expect(mapAcpModeIdToPermissionLevel(`bypassPermissions`)).toBe(`bypass`)
    expect(mapAcpModeIdToPermissionLevel(`full-access`)).toBe(`bypass`)
    expect(mapAcpModeIdToPermissionLevel(`agent-full-access`)).toBe(`bypass`)
  })

  it(`leaves bypass to client-side auto-approval when the agent has no bypass mode`, () => {
    const agyModes = [`default`, `accept-edits`, `auto`, `plan`].map(id => ({ id, name: id }))
    expect(mapPermissionLevelToAcpModeId(`bypass`, agyModes)).toBeNull()
    expect(mapPermissionLevelToAcpModeId(`auto_edits`, agyModes)).toBe(`accept-edits`)
    expect(getCustomExtraModes(agyModes).map(m => m.id)).toEqual([`auto`])
  })

  it(`runs bypass on the agent ask mode when it has no native bypass mode`, () => {
    const agyModes = [`default`, `accept-edits`, `auto`, `plan`].map(id => ({ id, name: id }))
    expect(resolveNativeModeIdForLevel(`bypass`, agyModes)).toBe(`default`)
    const claudeModes = [`default`, `acceptEdits`, `plan`, `bypassPermissions`].map(id => ({ id, name: id }))
    expect(resolveNativeModeIdForLevel(`bypass`, claudeModes)).toBe(`bypassPermissions`)
  })

  it(`maps Codex ACP and OpenCode modes cleanly and exits conflicting plan/bypass modes when ask alias is absent`, () => {
    const codexModes = [`read-only`, `agent`, `agent-full-access`].map(id => ({ id, name: id }))
    expect(resolveNativeModeIdForLevel(`bypass`, codexModes)).toBe(`agent-full-access`)
    expect(resolveNativeModeIdForLevel(`plan`, codexModes)).toBe(`read-only`)
    expect(getCustomExtraModes(codexModes).map(m => m.id)).toEqual([`agent`])
    // Leaving native bypass (`agent-full-access`) for `ask` or `auto_edits` must not stay in `agent-full-access`.
    expect(resolveNativeModeIdForLevel(`ask`, codexModes, `agent-full-access`)).toBe(`agent`)
    expect(resolveNativeModeIdForLevel(`auto_edits`, codexModes, `agent-full-access`)).toBe(`agent`)
    expect(resolveNativeModeIdForLevel(`auto_edits`, codexModes, `read-only`)).toBe(`agent`)

    const openCodeModes = [`build`, `plan`].map(id => ({ id, name: id }))
    expect(mapAcpModeIdToPermissionLevel(`build`)).toBe(`ask`)
    expect(resolveNativeModeIdForLevel(`ask`, openCodeModes)).toBe(`build`)
    expect(resolveNativeModeIdForLevel(`auto_edits`, openCodeModes)).toBe(`build`)
    expect(resolveNativeModeIdForLevel(`bypass`, openCodeModes)).toBe(`build`)
  })
})
