import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { readSkills } from '../src/agents/shared/skills'
import { copyBundledSkills } from './build'

const repoSkillsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../../.agents/skills`)

describe(`copyBundledSkills`, () => {
  let destRoot = ``

  afterEach(async () => {
    if (destRoot)
      await fs.rm(destRoot, { recursive: true, force: true })
  })

  it(`ships the article skills with their reference files`, async () => {
    destRoot = await fs.mkdtemp(path.join(os.tmpdir(), `md-bundled-skills-`))
    const skillsDir = path.join(destRoot, `skills`)
    await copyBundledSkills(repoSkillsDir, skillsDir)

    const skills = await readSkills([skillsDir])
    expect(skills.map(skill => skill.name).sort()).toEqual([`human-writing`, `khazix-writer`, `wechat-minsheng`])

    for (const file of [
      `wechat-minsheng/references/layout.md`,
      `khazix-writer/references/quality-check.md`,
      `human-writing/references/reality.md`,
      `human-writing/scripts/check_prose.py`,
    ])
      await expect(fs.access(path.join(skillsDir, file))).resolves.toBeUndefined()
  })
})
