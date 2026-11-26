import type { AgentTimelineItem } from '@/stores/agent'
import { describe, expect, it } from 'vitest'
import {
  cleanDisplayCommand,
  cleanDisplayPath,
  describeToolCall,
  groupTimelineItems,
  summarizeErrorGroup,
  summarizeToolGroup,
} from './timeline-blocks'

describe(`cleanDisplayPath & cleanDisplayCommand`, () => {
  it(`strips workspace temp prefixes, traversal dots, and skill directories`, () => {
    expect(cleanDisplayPath(`../../../../.agents/skills/humanizer-zh/SKILL.md`)).toBe(`humanizer-zh/SKILL.md`)
    expect(cleanDisplayPath(`/Users/ws/Library/Application Support/md/acp-workspaces/2110e813-363c-4d0c-8f99-0b1c1b811abe/article.md`)).toBe(`article.md`)
    expect(cleanDisplayPath(`/Users/ws/Library/Application Support/md/acp-workspaces/2110e813-363c-4d0c-8f99-0b1c1b811abe/images/hero.png`)).toBe(`images/hero.png`)
  })

  it(`shortens quoted workspace paths inside shell commands`, () => {
    expect(
      cleanDisplayCommand(`mkdir -p "/Users/ws/Library/Application Support/md/acp-workspaces/2110e813-363c-4d0c-8f99-0b1c1b811abe/images"`),
    ).toBe(`mkdir -p images`)
    expect(
      cleanDisplayCommand(`ls -la "/Users/ws/Library/Application Support/md/acp-workspaces/2110e813-363c-4d0c-8f99-0b1c1b811abe"`),
    ).toBe(`ls -la .`)
  })
})

describe(`describeToolCall`, () => {
  it(`classifies MCP image generation calls and extracts saved image path`, () => {
    const described = describeToolCall({
      id: `tc-img`,
      title: `Run mcp_md-image_generate_image`,
      toolKind: `other`,
      status: `completed`,
      detail: `Image saved to images/late-night-bills.png. Insert it in article.md.`,
    })
    expect(described.category).toBe(`image`)
    expect(described.workspaceImagePath).toBe(`images/late-night-bills.png`)
    expect(described.target).toBe(`images/late-night-bills.png`)
    expect(described.hasDetails).toBe(true)
  })

  it(`marks failed tool calls as having details even when detail is absent`, () => {
    const described = describeToolCall({
      id: `tc-fail`,
      title: `Run mcp_md-image_generate_image`,
      toolKind: `other`,
      status: `failed`,
      error: `Failed after 3 attempts: Response Timeout by Origin Server`,
    })
    expect(described.category).toBe(`image`)
    expect(described.hasDetails).toBe(true)
  })
})

describe(`groupTimelineItems`, () => {
  it(`merges consecutive non-edit tool calls while keeping edit cards separate`, () => {
    const items: AgentTimelineItem[] = [
      { type: `user`, id: `u1`, text: `写篇文章`, timestamp: 1 },
      { type: `tool_call`, id: `t1`, timestamp: 2, tool: { id: `t1`, title: `File article.md`, toolKind: `read`, status: `completed` } },
      { type: `tool_call`, id: `t2`, timestamp: 3, tool: { id: `t2`, title: `ls -la`, toolKind: `execute`, status: `completed` } },
      { type: `tool_call`, id: `t3`, timestamp: 4, tool: { id: `t3`, title: `Edit article.md`, toolKind: `edit`, status: `completed`, filePath: `article.md` } },
      { type: `tool_call`, id: `t4`, timestamp: 5, tool: { id: `t4`, title: `Run mcp_md-image_generate_image`, toolKind: `other`, status: `failed`, error: `504` } },
      { type: `assistant`, id: `a1`, text: `已完成`, timestamp: 6 },
    ]

    const blocks = groupTimelineItems(items)
    expect(blocks.map(b => b.kind)).toEqual([`user`, `tool_group`, `edit_tool`, `tool_group`, `assistant`])

    const firstGroup = blocks[1]
    expect(firstGroup.kind).toBe(`tool_group`)
    if (firstGroup.kind === `tool_group`) {
      expect(firstGroup.items).toHaveLength(2)
      expect(firstGroup.hasFailed).toBe(false)
      expect(firstGroup.followedByContent).toBe(true)
      const breakdown = summarizeToolGroup(firstGroup.items)
      expect(breakdown.readCount).toBe(1)
      expect(breakdown.executeCount).toBe(1)
    }

    const failedGroup = blocks[3]
    if (failedGroup.kind === `tool_group`) {
      expect(failedGroup.hasFailed).toBe(true)
      expect(failedGroup.failedCount).toBe(1)
    }
  })

  it(`deduplicates consecutive identical image upload failures and extracts WeChat 40164 IP`, () => {
    const summary = summarizeErrorGroup([
      {
        type: `error`,
        id: `e1`,
        timestamp: 1,
        message: `图片 images/late-night-bills.jpg 上传失败：上传失败，未获取到URL: [40164] Current egress IP (183.229.149.191) is not in the WeChat Official Account IP whitelist.`,
      },
      {
        type: `error`,
        id: `e2`,
        timestamp: 2,
        message: `图片 images/evening-grocery-walk.jpg 上传失败：上传失败，未获取到URL: [40164] Current egress IP (183.229.149.191) is not in the WeChat Official Account IP whitelist.`,
      },
    ])

    expect(summary.affectedPaths).toEqual([`images/late-night-bills.jpg`, `images/evening-grocery-walk.jpg`])
    expect(summary.whitelistIp).toBe(`183.229.149.191`)
    expect(summary.sharedMessage).toContain(`40164`)
  })

  it(`omits completed bookkeeping update_steps calls so surrounding upload errors merge cleanly`, () => {
    const blocks = groupTimelineItems([
      { type: `error`, id: `e1`, timestamp: 1, message: `图片 images/a.jpg 上传失败：[40164] IP 1.2.3.4` },
      { type: `tool_call`, id: `t1`, timestamp: 2, tool: { id: `t1`, title: `Run update_steps`, toolKind: `other`, status: `completed`, detail: `OK` } },
      { type: `error`, id: `e2`, timestamp: 3, message: `图片 images/b.jpg 上传失败：[40164] IP 1.2.3.4` },
    ])

    expect(blocks).toHaveLength(1)
    expect(blocks[0].kind).toBe(`error_group`)
    if (blocks[0].kind === `error_group`)
      expect(blocks[0].items).toHaveLength(2)
  })

  it(`parses upload errors for paths containing spaces and avoids misleading whitelistIp on mixed errors`, () => {
    const spaced = summarizeErrorGroup([
      {
        type: `error`,
        id: `e1`,
        timestamp: 1,
        message: `Failed to upload image images/my chart.png: [40164] IP 10.20.30.40 not whitelisted`,
      },
      {
        type: `error`,
        id: `e2`,
        timestamp: 2,
        message: `Failed to upload image images/second chart.png: [40164] IP 10.20.30.40 not whitelisted`,
      },
    ])
    expect(spaced.affectedPaths).toEqual([`images/my chart.png`, `images/second chart.png`])
    expect(spaced.whitelistIp).toBe(`10.20.30.40`)

    const mixed = summarizeErrorGroup([
      { type: `error`, id: `m1`, timestamp: 1, message: `40164 IP 10.20.30.40` },
      { type: `error`, id: `m2`, timestamp: 2, message: `Network timeout` },
    ])
    expect(mixed.sharedMessage).toBeNull()
    expect(mixed.whitelistIp).toBeNull()
  })

  it(`reuses display block references for unchanged earlier items when streaming updates append to tail`, () => {
    const userItem: AgentTimelineItem = { type: `user`, id: `u1`, text: `Write`, timestamp: 1 }
    const readItem: AgentTimelineItem = {
      type: `tool_call`,
      id: `t1`,
      timestamp: 2,
      tool: { id: `t1`, title: `Read article.md`, toolKind: `read`, status: `completed` },
    }
    const editItem: AgentTimelineItem = {
      type: `tool_call`,
      id: `t2`,
      timestamp: 3,
      tool: { id: `t2`, title: `Edit article.md`, toolKind: `edit`, status: `completed` },
    }
    const assistantItem: Extract<AgentTimelineItem, { type: `assistant` }> = {
      type: `assistant`,
      id: `a1`,
      text: `Hello`,
      streaming: true,
      timestamp: 4,
    }

    const firstPass = groupTimelineItems([userItem, readItem, editItem, assistantItem])
    assistantItem.text = `Hello world`
    const secondPass = groupTimelineItems([userItem, readItem, editItem, assistantItem])

    expect(secondPass[0]).toBe(firstPass[0])
    expect(secondPass[1]).toBe(firstPass[1])
    expect(secondPass[2]).toBe(firstPass[2])
    expect(secondPass[3]).not.toBe(firstPass[3])
  })
})
