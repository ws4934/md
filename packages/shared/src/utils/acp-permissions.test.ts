import { describe, expect, it } from 'vitest'
import { mapAcpModeIdToPermissionLevel, mapPermissionLevelToAcpModeId } from './acp-permissions'

describe(`acp permission mode mapping`, () => {
  it(`does not treat agent "auto" modes as bypass`, () => {
    // Antigravity / Codex `auto` still asks before risky actions; only explicit full-permission modes are bypass.
    expect(mapAcpModeIdToPermissionLevel(`auto`)).toBeNull()
    expect(mapAcpModeIdToPermissionLevel(`bypassPermissions`)).toBe(`bypass`)
    expect(mapAcpModeIdToPermissionLevel(`full-access`)).toBe(`bypass`)
  })

  it(`leaves bypass to client-side auto-approval when the agent has no bypass mode`, () => {
    const agyModes = [`default`, `accept-edits`, `auto`, `plan`].map(id => ({ id, name: id }))
    expect(mapPermissionLevelToAcpModeId(`bypass`, agyModes)).toBeNull()
    expect(mapPermissionLevelToAcpModeId(`auto_edits`, agyModes)).toBe(`accept-edits`)
  })
})
