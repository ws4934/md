import type { DesktopSkill } from '@md/shared/types'
import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { isValidSkillName, MAX_SKILL_FILE_BYTES, parseSkillFrontMatter } from '../agents/shared/skills'

export interface SkillStoreOptions {
  /** Read-only skills shipped with the app (`dist/skills`). */
  bundledDir: string
  /** userData root: user skills live in `skills/`, state in `skills.json`, the merged set in `skills-effective/`. */
  dataDir: string
}

interface SkillState {
  disabled: Set<string>
  /** sha256 of the bundled SKILL.md each user copy was made from. */
  bundledBase: Map<string, string>
}

interface SkillEntry {
  skill: DesktopSkill
  /** Folder of the active copy (user copy when present, otherwise bundled). */
  dir: string
}

const SKILL_FILE = `SKILL.md`

// Bracketed codes let the renderer show localized messages; the rest of the text is the English fallback.
function skillError(code: string, message: string): Error {
  return new Error(`[${code}] ${message}`)
}

function assertSkillName(name: unknown): asserts name is string {
  if (typeof name !== `string` || !isValidSkillName(name))
    throw skillError(`invalidName`, `Skill names must be non-empty, without spaces, slashes or a leading dot`)
}

/** Validates SKILL.md content for the skill folder `name` and returns its description. */
export function validateSkillContent(content: unknown, name: string): string {
  if (typeof content !== `string`)
    throw new TypeError(`SKILL.md content must be a string`)
  if (Buffer.byteLength(content, `utf8`) > MAX_SKILL_FILE_BYTES)
    throw skillError(`tooLarge`, `SKILL.md must be at most ${MAX_SKILL_FILE_BYTES / 1024} KB`)
  const meta = parseSkillFrontMatter(content)
  if (!meta)
    throw skillError(`invalidFrontMatter`, `SKILL.md must start with a --- front matter block with a valid "name" and an optional text "description"`)
  if (meta.name !== name)
    throw skillError(`nameMismatch`, `Front matter name "${meta.name}" must equal the skill folder name "${name}"`)
  return meta.description
}

function newSkillTemplate(name: string): string {
  const yamlName = /^[\w-]+$/.test(name) ? name : JSON.stringify(name)
  return `---\nname: ${yamlName}\ndescription: Describe what this skill does and when the agent should use it.\n---\n\n# ${name}\n\nWrite the instructions the agent should follow here.\n`
}

function hashContent(content: string): string {
  return createHash(`sha256`).update(content).digest(`hex`)
}

async function readSkillFile(dir: string): Promise<string> {
  const filePath = path.join(dir, SKILL_FILE)
  let stat
  try {
    stat = await fs.stat(filePath)
  }
  catch {
    throw new Error(`SKILL.md is missing`)
  }
  if (!stat.isFile())
    throw new Error(`SKILL.md is missing`)
  if (stat.size > MAX_SKILL_FILE_BYTES)
    throw skillError(`tooLarge`, `SKILL.md must be at most ${MAX_SKILL_FILE_BYTES / 1024} KB`)
  return fs.readFile(filePath, `utf8`)
}

async function listSkillFolders(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(root, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory() && isValidSkillName(entry.name)).map(entry => entry.name)
  }
  catch {
    return []
  }
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(tmpPath, content, `utf8`)
    await fs.rename(tmpPath, filePath)
  }
  catch (error) {
    await fs.rm(tmpPath, { force: true }).catch(() => undefined)
    throw error
  }
}

/**
 * Merges read-only bundled skills with the user's copies in `<userData>/skills` and keeps the enabled,
 * valid ones materialized in `effectiveDir`, which agent workspaces copy at session/probe start.
 */
export class SkillStore {
  readonly effectiveDir: string
  private readonly bundledDir: string
  private readonly userDir: string
  private readonly statePath: string
  private readonly listeners = new Set<(skills: DesktopSkill[]) => void>()
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: SkillStoreOptions) {
    this.bundledDir = options.bundledDir
    this.userDir = path.join(options.dataDir, `skills`)
    this.statePath = path.join(options.dataDir, `skills.json`)
    this.effectiveDir = path.join(options.dataDir, `skills-effective`)
  }

  onChange(listener: (skills: DesktopSkill[]) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  list(): Promise<DesktopSkill[]> {
    return this.serialize(async () => (await this.scan(await this.readState())).map(entry => entry.skill))
  }

  /** Rebuilds `effectiveDir`; call once at startup since app updates can change the bundled set. */
  materialize(): Promise<void> {
    return this.serialize(async () => {
      await this.rebuild(await this.scan(await this.readState()))
    })
  }

  read(name: unknown): Promise<string> {
    return this.serialize(async () => {
      const { dir } = findEntry(await this.scan(await this.readState()), name)
      return readSkillFile(dir)
    })
  }

  save(name: unknown, content: unknown): Promise<DesktopSkill[]> {
    return this.mutate(async (state, entries) => {
      const { skill } = findEntry(entries, name)
      validateSkillContent(content, skill.name)
      const text = content as string
      const userSkillDir = path.join(this.userDir, skill.name)
      if (skill.source === `bundled` && !skill.modified) {
        const bundledSkillDir = path.join(this.bundledDir, skill.name)
        const bundledContent = await fs.readFile(path.join(bundledSkillDir, SKILL_FILE), `utf8`)
        if (text === bundledContent)
          return
        // First edit copies the whole folder so support files keep working next to the edited SKILL.md.
        await fs.mkdir(this.userDir, { recursive: true })
        try {
          await fs.cp(bundledSkillDir, userSkillDir, { recursive: true, force: false, errorOnExist: true })
          await writeFileAtomic(path.join(userSkillDir, SKILL_FILE), text)
        }
        catch (error) {
          await fs.rm(userSkillDir, { recursive: true, force: true }).catch(() => undefined)
          throw error
        }
        state.bundledBase.set(skill.name, hashContent(bundledContent))
        await this.writeState(state)
        return
      }
      await writeFileAtomic(path.join(userSkillDir, SKILL_FILE), text)
    })
  }

  create(name: unknown): Promise<DesktopSkill[]> {
    return this.mutate(async (state, entries) => {
      assertSkillName(name)
      const lower = name.toLowerCase()
      // Case-insensitive so names never collide on macOS / Windows file systems.
      if (entries.some(entry => entry.skill.name.toLowerCase() === lower))
        throw skillError(`exists`, `A skill named "${name}" already exists`)
      const content = newSkillTemplate(name)
      validateSkillContent(content, name)
      const dir = path.join(this.userDir, name)
      await fs.mkdir(this.userDir, { recursive: true })
      try {
        await fs.mkdir(dir)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === `EEXIST`)
          throw skillError(`exists`, `A skill named "${name}" already exists`)
        throw error
      }
      await writeFileAtomic(path.join(dir, SKILL_FILE), content)
      state.disabled.delete(name)
      state.bundledBase.delete(name)
      await this.writeState(state)
    })
  }

  remove(name: unknown): Promise<DesktopSkill[]> {
    return this.mutate(async (state, entries) => {
      const { skill } = findEntry(entries, name)
      if (skill.source !== `custom`)
        throw new Error(`Bundled skills cannot be deleted; disable or reset them instead`)
      await fs.rm(path.join(this.userDir, skill.name), { recursive: true, force: true })
      state.disabled.delete(skill.name)
      state.bundledBase.delete(skill.name)
      await this.writeState(state)
    })
  }

  reset(name: unknown): Promise<DesktopSkill[]> {
    return this.mutate(async (state, entries) => {
      const { skill } = findEntry(entries, name)
      if (!skill.modified)
        throw new Error(`Skill "${skill.name}" has no changes to reset`)
      await fs.rm(path.join(this.userDir, skill.name), { recursive: true, force: true })
      state.bundledBase.delete(skill.name)
      await this.writeState(state)
    })
  }

  keepModified(name: unknown): Promise<DesktopSkill[]> {
    return this.mutate(async (state, entries) => {
      const { skill } = findEntry(entries, name)
      if (!skill.modified)
        throw new Error(`Skill "${skill.name}" has no changes to keep`)
      const bundledContent = await fs.readFile(path.join(this.bundledDir, skill.name, SKILL_FILE), `utf8`)
      state.bundledBase.set(skill.name, hashContent(bundledContent))
      await this.writeState(state)
    })
  }

  setEnabled(name: unknown, enabled: unknown): Promise<DesktopSkill[]> {
    return this.mutate(async (state, entries) => {
      if (typeof enabled !== `boolean`)
        throw new TypeError(`enabled must be a boolean`)
      const { skill } = findEntry(entries, name)
      if (enabled)
        state.disabled.delete(skill.name)
      else
        state.disabled.add(skill.name)
      await this.writeState(state)
    })
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.catch(() => undefined).then(fn)
    this.chain = next
    return next
  }

  private mutate(fn: (state: SkillState, entries: SkillEntry[]) => Promise<void>): Promise<DesktopSkill[]> {
    return this.serialize(async () => {
      const state = await this.readState()
      await fn(state, await this.scan(state))
      const entries = await this.scan(state)
      await this.rebuild(entries)
      const skills = entries.map(entry => entry.skill)
      for (const listener of this.listeners) {
        try {
          listener(structuredClone(skills))
        }
        catch (error) {
          console.warn(`[skills] onChange listener threw:`, error)
        }
      }
      return skills
    })
  }

  private async scan(state: SkillState): Promise<SkillEntry[]> {
    const [bundled, user] = await Promise.all([listSkillFolders(this.bundledDir), listSkillFolders(this.userDir)])
    const names = [...new Set([...bundled, ...user])]
    const entries = await Promise.all(names.map(async (name): Promise<SkillEntry> => {
      const isBundled = bundled.includes(name)
      const hasUserCopy = user.includes(name)
      const dir = path.join(hasUserCopy ? this.userDir : this.bundledDir, name)
      let description = ``
      let error: string | undefined
      try {
        description = validateSkillContent(await readSkillFile(dir), name)
      }
      catch (err) {
        error = err instanceof Error ? err.message : String(err)
      }
      let bundledUpdated = false
      const base = state.bundledBase.get(name)
      if (isBundled && hasUserCopy && base) {
        const current = await fs.readFile(path.join(this.bundledDir, name, SKILL_FILE), `utf8`).catch(() => null)
        bundledUpdated = current !== null && hashContent(current) !== base
      }
      return {
        dir,
        skill: {
          name,
          description,
          source: isBundled ? `bundled` : `custom`,
          modified: isBundled && hasUserCopy,
          enabled: !state.disabled.has(name),
          bundledUpdated,
          ...(error ? { error } : {}),
        },
      }
    }))
    return entries.sort((a, b) => a.skill.source === b.skill.source
      ? a.skill.name.localeCompare(b.skill.name)
      : (a.skill.source === `bundled` ? -1 : 1))
  }

  private async rebuild(entries: SkillEntry[]): Promise<void> {
    const tmpDir = `${this.effectiveDir}.tmp`
    const oldDir = `${this.effectiveDir}.old`
    await Promise.all([tmpDir, oldDir].map(dir => fs.rm(dir, { recursive: true, force: true })))
    await fs.mkdir(tmpDir, { recursive: true })
    for (const { skill, dir } of entries) {
      if (skill.enabled && !skill.error)
        await fs.cp(dir, path.join(tmpDir, skill.name), { recursive: true })
    }
    // ponytail: two renames leave a sub-millisecond gap where a session start finds no skills; a versioned dir would close it.
    try {
      await fs.rename(this.effectiveDir, oldDir)
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== `ENOENT`)
        throw error
    }
    await fs.rename(tmpDir, this.effectiveDir)
    await fs.rm(oldDir, { recursive: true, force: true }).catch(() => undefined)
  }

  private async readState(): Promise<SkillState> {
    const state: SkillState = { disabled: new Set(), bundledBase: new Map() }
    try {
      const parsed = JSON.parse(await fs.readFile(this.statePath, `utf8`)) as Record<string, unknown>
      if (Array.isArray(parsed?.disabled)) {
        for (const name of parsed.disabled) {
          if (typeof name === `string`)
            state.disabled.add(name)
        }
      }
      if (parsed?.bundledBase && typeof parsed.bundledBase === `object` && !Array.isArray(parsed.bundledBase)) {
        for (const [name, hash] of Object.entries(parsed.bundledBase)) {
          if (typeof hash === `string`)
            state.bundledBase.set(name, hash)
        }
      }
    }
    catch {
      // Missing or corrupt state means every skill is enabled.
    }
    return state
  }

  private writeState(state: SkillState): Promise<void> {
    const payload = {
      disabled: [...state.disabled].sort(),
      bundledBase: Object.fromEntries(state.bundledBase),
    }
    return writeFileAtomic(this.statePath, `${JSON.stringify(payload, null, 2)}\n`)
  }
}

function findEntry(entries: SkillEntry[], name: unknown): SkillEntry {
  assertSkillName(name)
  const entry = entries.find(item => item.skill.name === name)
  if (!entry)
    throw new Error(`Unknown skill: ${name}`)
  return entry
}
