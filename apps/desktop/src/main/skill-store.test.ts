import type { DesktopSkill } from '@md/shared/types'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpHost, fingerprintBundledSkills } from './acp/host'
import { SkillStore } from './skill-store'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AGENT_SCRIPT = path.resolve(__dirname, `../../scripts/fake-acp-agent.mjs`)

const tempDirs: string[] = []
const openHosts: AcpHost[] = []

afterEach(async () => {
  while (openHosts.length > 0)
    await openHosts.pop()!.dispose()
  while (tempDirs.length > 0)
    await fs.rm(tempDirs.pop()!, { recursive: true, force: true }).catch(() => undefined)
})

function skillMd(name: string, body = `Body`, description = `${name} skill`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

async function writeSkill(root: string, name: string, content = skillMd(name)): Promise<void> {
  await fs.mkdir(path.join(root, name), { recursive: true })
  await fs.writeFile(path.join(root, name, `SKILL.md`), content)
}

async function exists(target: string): Promise<boolean> {
  return fs.access(target).then(() => true, () => false)
}

/** Bundled `alpha` (with a support file) and `gamma`, read-only like `dist/skills`. */
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `md-skills-`))
  tempDirs.push(root)
  const bundledDir = path.join(root, `bundled`)
  const dataDir = path.join(root, `userData`)
  await writeSkill(bundledDir, `alpha`, skillMd(`alpha`, `Bundled alpha v1`))
  await fs.mkdir(path.join(bundledDir, `alpha`, `references`))
  await fs.writeFile(path.join(bundledDir, `alpha`, `references`, `guide.md`), `guide`)
  await writeSkill(bundledDir, `gamma`)
  const store = new SkillStore({ bundledDir, dataDir })
  return { root, bundledDir, dataDir, store }
}

function byName(skills: DesktopSkill[], name: string): DesktopSkill | undefined {
  return skills.find(skill => skill.name === name)
}

describe(`skillStore`, () => {
  it(`lists bundled skills as enabled defaults and materializes them with support files`, async () => {
    const { store } = await setup()
    expect(await store.list()).toEqual([
      { name: `alpha`, description: `alpha skill`, source: `bundled`, modified: false, enabled: true, bundledUpdated: false },
      { name: `gamma`, description: `gamma skill`, source: `bundled`, modified: false, enabled: true, bundledUpdated: false },
    ])

    await store.materialize()
    expect((await fs.readdir(store.effectiveDir)).sort()).toEqual([`alpha`, `gamma`])
    expect(await fs.readFile(path.join(store.effectiveDir, `alpha`, `references`, `guide.md`), `utf8`)).toBe(`guide`)
  })

  it(`copies the whole bundled folder on first edit and leaves the bundled copy untouched`, async () => {
    const { bundledDir, dataDir, store } = await setup()
    const changes: DesktopSkill[][] = []
    store.onChange(skills => changes.push(skills))

    // Saving the unchanged bundled text does not create an override.
    await store.save(`alpha`, skillMd(`alpha`, `Bundled alpha v1`))
    expect(await exists(path.join(dataDir, `skills`, `alpha`))).toBe(false)

    const edited = skillMd(`alpha`, `My alpha`, `edited`)
    const skills = await store.save(`alpha`, edited)
    expect(byName(skills, `alpha`)).toMatchObject({ source: `bundled`, modified: true, bundledUpdated: false, description: `edited` })
    expect(changes.at(-1)).toEqual(skills)

    expect(await fs.readFile(path.join(dataDir, `skills`, `alpha`, `references`, `guide.md`), `utf8`)).toBe(`guide`)
    expect(await fs.readFile(path.join(bundledDir, `alpha`, `SKILL.md`), `utf8`)).toBe(skillMd(`alpha`, `Bundled alpha v1`))
    expect(await store.read(`alpha`)).toBe(edited)
    expect(await fs.readFile(path.join(store.effectiveDir, `alpha`, `SKILL.md`), `utf8`)).toBe(edited)
    expect(await fs.readFile(path.join(store.effectiveDir, `alpha`, `references`, `guide.md`), `utf8`)).toBe(`guide`)

    // Later edits only rewrite the user's SKILL.md.
    await store.save(`alpha`, skillMd(`alpha`, `My alpha v2`))
    expect(await fs.readFile(path.join(store.effectiveDir, `alpha`, `SKILL.md`), `utf8`)).toContain(`My alpha v2`)
  })

  it(`flags a newer bundled version and lets the user keep their copy or reset`, async () => {
    const { bundledDir, dataDir, store } = await setup()
    await store.save(`alpha`, skillMd(`alpha`, `Mine`))

    // An app update ships a different bundled SKILL.md.
    await fs.writeFile(path.join(bundledDir, `alpha`, `SKILL.md`), skillMd(`alpha`, `Bundled alpha v2`))
    const updated = new SkillStore({ bundledDir, dataDir })
    expect(byName(await updated.list(), `alpha`)).toMatchObject({ modified: true, bundledUpdated: true })

    expect(byName(await updated.keepModified(`alpha`), `alpha`)).toMatchObject({ modified: true, bundledUpdated: false })
    expect(await updated.read(`alpha`)).toContain(`Mine`)

    const reset = await updated.reset(`alpha`)
    expect(byName(reset, `alpha`)).toMatchObject({ modified: false, bundledUpdated: false })
    expect(await exists(path.join(dataDir, `skills`, `alpha`))).toBe(false)
    expect(await fs.readFile(path.join(updated.effectiveDir, `alpha`, `SKILL.md`), `utf8`)).toContain(`Bundled alpha v2`)
    await expect(updated.reset(`alpha`)).rejects.toThrow(/no changes/)
  })

  it(`persists disabled skills and leaves them out of the effective set`, async () => {
    const { bundledDir, dataDir, store } = await setup()
    expect(byName(await store.setEnabled(`gamma`, false), `gamma`)?.enabled).toBe(false)
    expect(await fs.readdir(store.effectiveDir)).toEqual([`alpha`])

    const reopened = new SkillStore({ bundledDir, dataDir })
    expect(byName(await reopened.list(), `gamma`)?.enabled).toBe(false)
    await reopened.materialize()
    expect(await fs.readdir(reopened.effectiveDir)).toEqual([`alpha`])

    await reopened.setEnabled(`gamma`, true)
    expect((await fs.readdir(reopened.effectiveDir)).sort()).toEqual([`alpha`, `gamma`])
    await expect(reopened.setEnabled(`gamma`, `yes`)).rejects.toThrow(TypeError)
  })

  it(`creates custom skills from a valid template and deletes only custom skills`, async () => {
    const { dataDir, store } = await setup()
    const created = await store.create(`my-notes`)
    expect(byName(created, `my-notes`)).toMatchObject({ source: `custom`, modified: false, enabled: true, bundledUpdated: false })
    expect(byName(created, `my-notes`)?.error).toBeUndefined()
    expect(created.map(skill => skill.name)).toEqual([`alpha`, `gamma`, `my-notes`])
    expect(await store.read(`my-notes`)).toMatch(/^---\nname: my-notes\n/)
    expect(await exists(path.join(store.effectiveDir, `my-notes`, `SKILL.md`))).toBe(true)

    // Names needing YAML quoting still round-trip through the front matter parser.
    expect(byName(await store.create(`#标签`), `#标签`)?.error).toBeUndefined()

    await expect(store.create(`My-Notes`)).rejects.toThrow(/\[exists\]/)
    await expect(store.create(`ALPHA`)).rejects.toThrow(/\[exists\]/)
    await expect(store.remove(`alpha`)).rejects.toThrow(/cannot be deleted/)

    const removed = await store.remove(`my-notes`)
    expect(byName(removed, `my-notes`)).toBeUndefined()
    expect(await exists(path.join(dataDir, `skills`, `my-notes`))).toBe(false)
    expect(await exists(path.join(store.effectiveDir, `my-notes`))).toBe(false)
  })

  it(`rejects invalid names, path traversal and malformed SKILL.md without touching disk`, async () => {
    const { root, dataDir, store } = await setup()
    for (const name of [``, `..`, `.`, `.hidden`, `../escape`, `a/b`, `a\\b`, `two words`, 42])
      await expect(store.create(name)).rejects.toThrow(/\[invalidName\]/)
    await expect(store.read(`../bundled/alpha`)).rejects.toThrow(/\[invalidName\]/)
    await expect(store.save(`missing`, skillMd(`missing`))).rejects.toThrow(/Unknown skill/)
    expect(await exists(path.join(root, `escape`))).toBe(false)

    await expect(store.save(`alpha`, `no front matter`)).rejects.toThrow(/\[invalidFrontMatter\]/)
    await expect(store.save(`alpha`, `---\nname: [broken\n---\n`)).rejects.toThrow(/\[invalidFrontMatter\]/)
    await expect(store.save(`alpha`, `---\nname: alpha\ndescription: 1\n---\n`)).rejects.toThrow(/\[invalidFrontMatter\]/)
    await expect(store.save(`alpha`, skillMd(`beta`))).rejects.toThrow(/\[nameMismatch\]/)
    await expect(store.save(`alpha`, skillMd(`alpha`, `x`.repeat(256 * 1024)))).rejects.toThrow(/\[tooLarge\]/)
    await expect(store.save(`alpha`, 7)).rejects.toThrow(TypeError)
    expect(await exists(path.join(dataDir, `skills`, `alpha`))).toBe(false)
  })

  it(`lists hand-made invalid skills with an error and keeps them out of agent workspaces`, async () => {
    const { dataDir, store } = await setup()
    await writeSkill(path.join(dataDir, `skills`), `broken`, skillMd(`other-name`))
    await fs.mkdir(path.join(dataDir, `skills`, `empty`), { recursive: true })
    await fs.mkdir(path.join(dataDir, `skills`, `.git`), { recursive: true })
    await store.materialize()

    const skills = await store.list()
    expect(skills.map(skill => skill.name)).toEqual([`alpha`, `gamma`, `broken`, `empty`])
    expect(byName(skills, `broken`)?.error).toMatch(/\[nameMismatch\]/)
    expect(byName(skills, `empty`)?.error).toMatch(/missing/)
    expect((await fs.readdir(store.effectiveDir)).sort()).toEqual([`alpha`, `gamma`])

    // Saving valid content repairs it.
    expect(byName(await store.save(`broken`, skillMd(`broken`)), `broken`)?.error).toBeUndefined()
    expect((await fs.readdir(store.effectiveDir)).sort()).toEqual([`alpha`, `broken`, `gamma`])
  })
})

describe(`skillStore with AcpHost`, () => {
  it(`feeds the effective set to probes and new sessions and invalidates probes on change`, async () => {
    const { dataDir, store } = await setup()
    await store.create(`custom-one`)
    await store.materialize()
    const fingerprintBefore = fingerprintBundledSkills(store.effectiveDir)

    const host = new AcpHost({
      dataDir,
      skillsDir: store.effectiveDir,
      extraBuiltinAgents: [{
        id: `fake-skills`,
        name: `fake-skills`,
        command: process.execPath,
        args: [FAKE_AGENT_SCRIPT],
        env: { FAKE_AGENT_EMIT_COMMANDS: `1` },
        detectBinaries: [process.execPath],
        builtin: true,
        avatar: { letter: `F`, color: `#5B5BD6` },
      }],
    })
    openHosts.push(host)
    // Same wiring as main/index.ts.
    store.onChange(() => host.invalidateAgentProbe())

    const commandNames = async () => (await host.probeAgent(`fake-skills`)).commands.map(c => c.name).sort()
    expect(await commandNames()).toEqual([`alpha`, `custom-one`, `gamma`, `outline`, `polish`])

    await store.setEnabled(`gamma`, false)
    await store.save(`alpha`, skillMd(`alpha`, `Edited for sessions`))
    expect(fingerprintBundledSkills(store.effectiveDir)).not.toBe(fingerprintBefore)
    // Not forced: the cached probe must have been invalidated by the change.
    expect(await commandNames()).toEqual([`alpha`, `custom-one`, `outline`, `polish`])

    await host.startSession({ agentId: `fake-skills`, postId: `p`, postTitle: `T`, content: `` })
    const [workspaceId] = await fs.readdir(path.join(dataDir, `acp-workspaces`))
    const skillsInWorkspace = path.join(dataDir, `acp-workspaces`, workspaceId, `.claude/skills`)
    expect((await fs.readdir(skillsInWorkspace)).sort()).toEqual([`alpha`, `custom-one`])
    expect(await fs.readFile(path.join(skillsInWorkspace, `alpha`, `SKILL.md`), `utf8`)).toContain(`Edited for sessions`)
    expect(await fs.readFile(path.join(skillsInWorkspace, `alpha`, `references`, `guide.md`), `utf8`)).toBe(`guide`)
  }, 20_000)
})
