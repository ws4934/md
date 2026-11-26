import type {
  DesktopIpCharacter,
  DesktopIpCharacterUpdate,
  DesktopIpLibrary,
} from '@md/shared/types'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export interface IpCharacterStoreOptions {
  dir: string
}

const LIBRARY_FILE = `library.json`
const WORKSPACE_IP_DIR = `ip`
const WORKSPACE_SELECTED_FILE = `selected.json`

const MAX_NAME_LENGTH = 40
const MAX_DESCRIPTION_LENGTH = 200
const MAX_PROMPT_LENGTH = 2000
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

const IMAGE_MIME_BY_EXT = new Map<string, string>([
  [`.png`, `image/png`],
  [`.jpg`, `image/jpeg`],
  [`.jpeg`, `image/jpeg`],
  [`.webp`, `image/webp`],
])

function createEmptyLibrary(): DesktopIpLibrary {
  return { defaultId: null, characters: [] }
}

function isSafeImageFileName(value: unknown): value is string {
  return typeof value === `string`
    && value.length > 0
    && path.basename(value) === value
    && !value.includes(`/`)
    && !value.includes(`\\`)
    && value !== `.`
    && value !== `..`
}

function parseLibraryJson(raw: string): DesktopIpLibrary {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== `object` || Array.isArray(parsed))
    return createEmptyLibrary()

  const record = parsed as Record<string, unknown>
  if (!Array.isArray(record.characters))
    return createEmptyLibrary()

  const characters: DesktopIpCharacter[] = []
  const seenIds = new Set<string>()
  for (const item of record.characters) {
    if (!item || typeof item !== `object` || Array.isArray(item))
      continue
    const entry = item as Record<string, unknown>
    if (
      typeof entry.id !== `string` || !entry.id
      || seenIds.has(entry.id)
      || typeof entry.name !== `string`
      || typeof entry.description !== `string`
      || typeof entry.prompt !== `string`
      || (entry.imageFile !== null && !isSafeImageFileName(entry.imageFile))
      || typeof entry.createdAt !== `number`
      || typeof entry.updatedAt !== `number`
    ) {
      continue
    }
    seenIds.add(entry.id)
    characters.push({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      prompt: entry.prompt,
      imageFile: entry.imageFile,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    })
  }

  const defaultId = typeof record.defaultId === `string` && seenIds.has(record.defaultId)
    ? record.defaultId
    : null
  return { defaultId, characters }
}

function validateName(raw: unknown): string {
  if (typeof raw !== `string`)
    throw new TypeError(`Character name must be a string`)
  const trimmed = raw.trim()
  if (trimmed.length < 1 || trimmed.length > MAX_NAME_LENGTH)
    throw new Error(`Character name must be 1–${MAX_NAME_LENGTH} characters`)
  return trimmed
}

function validateDescription(raw: unknown): string {
  if (raw === undefined)
    return ``
  if (typeof raw !== `string`)
    throw new TypeError(`Character description must be a string`)
  const trimmed = raw.trim()
  if (trimmed.length > MAX_DESCRIPTION_LENGTH)
    throw new Error(`Character description must be at most ${MAX_DESCRIPTION_LENGTH} characters`)
  return trimmed
}

function validatePrompt(raw: unknown): string {
  if (typeof raw !== `string`)
    throw new TypeError(`Character prompt must be a string`)
  const trimmed = raw.trim()
  if (trimmed.length < 1 || trimmed.length > MAX_PROMPT_LENGTH)
    throw new Error(`Character prompt must be 1–${MAX_PROMPT_LENGTH} characters`)
  return trimmed
}

function isPathInside(root: string, target: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`
  return target.startsWith(prefix)
}

async function resolveWorkspaceImage(
  workspaceDir: string,
  imagePath: unknown,
): Promise<{ sourcePath: string, ext: string }> {
  if (
    typeof imagePath !== `string`
    || !imagePath
    || path.isAbsolute(imagePath)
    || /^[a-z]:/i.test(imagePath)
    || imagePath.split(/[\\/]/).includes(`..`)
  ) {
    throw new Error(`Image path must be relative to the workspace`)
  }

  const relExt = path.extname(imagePath).toLowerCase()
  if (!IMAGE_MIME_BY_EXT.has(relExt))
    throw new Error(`Unsupported IP character image type: ${imagePath}`)

  // realpath both sides so traversal and symlinks pointing outside the workspace are rejected.
  const root = await fs.realpath(workspaceDir)
  const candidate = path.resolve(root, imagePath)
  if (!isPathInside(root, candidate))
    throw new Error(`Image path escapes workspace: ${imagePath}`)

  const target = await fs.realpath(candidate)
  if (!isPathInside(root, target))
    throw new Error(`Image resolves outside workspace: ${imagePath}`)

  const targetExt = path.extname(target).toLowerCase()
  if (!IMAGE_MIME_BY_EXT.has(targetExt))
    throw new Error(`Unsupported IP character image type: ${imagePath}`)

  const stat = await fs.stat(target)
  if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
    throw new Error(`Image must be a file <= ${MAX_IMAGE_BYTES / 1024 / 1024} MB`)

  return { sourcePath: target, ext: targetExt }
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const content = `${JSON.stringify(value, null, 2)}\n`
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

export class IpCharacterStore {
  private readonly dir: string
  private readonly libraryPath: string
  private readonly listeners = new Set<(library: DesktopIpLibrary) => void>()
  private readonly snapshotChains = new Map<string, Promise<void>>()

  private library: DesktopIpLibrary = createEmptyLibrary()
  private loaded = false
  private loadPromise: Promise<void> | null = null
  private mutationChain: Promise<unknown> = Promise.resolve()

  constructor(options: IpCharacterStoreOptions) {
    this.dir = options.dir
    this.libraryPath = path.join(options.dir, LIBRARY_FILE)
  }

  onChange(listener: (library: DesktopIpLibrary) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emitChange(): void {
    const snapshot = structuredClone(this.library)
    for (const listener of this.listeners) {
      try {
        listener(structuredClone(snapshot))
      }
      catch (error) {
        console.warn(`[ip-characters] onChange listener threw:`, error)
      }
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded)
      return
    this.loadPromise ??= (async () => {
      try {
        const raw = await fs.readFile(this.libraryPath, `utf8`)
        this.library = parseLibraryJson(raw)
      }
      catch {
        this.library = createEmptyLibrary()
      }
      finally {
        this.loaded = true
      }
    })()
    await this.loadPromise
  }

  private runMutation<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.mutationChain.catch(() => undefined).then(fn)
    this.mutationChain = next
    return next
  }

  async list(): Promise<DesktopIpLibrary> {
    await this.ensureLoaded()
    return structuredClone(this.library)
  }

  update(id: string, patch: DesktopIpCharacterUpdate): Promise<DesktopIpLibrary> {
    return this.runMutation(async () => {
      await this.ensureLoaded()
      const index = this.library.characters.findIndex(c => c.id === id)
      if (index === -1)
        throw new Error(`Unknown IP character: ${id}`)

      const current = this.library.characters[index]
      const nextChar: DesktopIpCharacter = {
        ...current,
        name: patch.name !== undefined ? validateName(patch.name) : current.name,
        description: patch.description !== undefined ? validateDescription(patch.description) : current.description,
        prompt: patch.prompt !== undefined ? validatePrompt(patch.prompt) : current.prompt,
        updatedAt: Date.now(),
      }
      const nextCharacters = [...this.library.characters]
      nextCharacters[index] = nextChar
      const nextLibrary: DesktopIpLibrary = {
        defaultId: this.library.defaultId,
        characters: nextCharacters,
      }

      await writeJsonAtomic(this.libraryPath, nextLibrary)
      this.library = nextLibrary
      this.emitChange()
      return structuredClone(this.library)
    })
  }

  setDefault(id: string | null): Promise<DesktopIpLibrary> {
    return this.runMutation(async () => {
      await this.ensureLoaded()
      if (id !== null && !this.library.characters.some(c => c.id === id))
        throw new Error(`Unknown IP character: ${id}`)

      if (this.library.defaultId === id)
        return structuredClone(this.library)

      const nextLibrary: DesktopIpLibrary = {
        defaultId: id,
        characters: this.library.characters,
      }
      await writeJsonAtomic(this.libraryPath, nextLibrary)
      this.library = nextLibrary
      this.emitChange()
      return structuredClone(this.library)
    })
  }

  remove(id: string): Promise<DesktopIpLibrary> {
    return this.runMutation(async () => {
      await this.ensureLoaded()
      const target = this.library.characters.find(c => c.id === id)
      if (!target)
        return structuredClone(this.library)

      const nextLibrary: DesktopIpLibrary = {
        defaultId: this.library.defaultId === id ? null : this.library.defaultId,
        characters: this.library.characters.filter(c => c.id !== id),
      }
      await writeJsonAtomic(this.libraryPath, nextLibrary)
      this.library = nextLibrary

      if (target.imageFile)
        await fs.rm(path.join(this.dir, target.imageFile), { force: true }).catch(() => undefined)

      this.emitChange()
      return structuredClone(this.library)
    })
  }

  async readImage(id: string): Promise<string | null> {
    await this.ensureLoaded()
    const character = this.library.characters.find(c => c.id === id)
    if (!character?.imageFile)
      return null
    const mime = IMAGE_MIME_BY_EXT.get(path.extname(character.imageFile).toLowerCase())
    if (!mime)
      return null
    try {
      const raw = await fs.readFile(path.join(this.dir, character.imageFile))
      return `data:${mime};base64,${raw.toString(`base64`)}`
    }
    catch {
      return null
    }
  }

  writeWorkspaceSnapshot(workspaceDir: string): Promise<void> {
    // Serialize per workspace so concurrent refreshes never race on image copy/cleanup.
    const previous = this.snapshotChains.get(workspaceDir) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(() => this.writeWorkspaceSnapshotInner(workspaceDir))
    this.snapshotChains.set(workspaceDir, current)
    void current.finally(() => {
      if (this.snapshotChains.get(workspaceDir) === current)
        this.snapshotChains.delete(workspaceDir)
    })
    return current
  }

  private async writeWorkspaceSnapshotInner(workspaceDir: string): Promise<void> {
    await this.ensureLoaded()
    const snapshot = structuredClone(this.library)
    const ipDir = path.join(workspaceDir, WORKSPACE_IP_DIR)
    await fs.mkdir(ipDir, { recursive: true })

    const activeImages = new Set<string>()
    const characters: Array<{
      id: string
      name: string
      description: string
      prompt: string
      image: string | null
    }> = []

    for (const character of snapshot.characters) {
      let image: string | null = null
      if (character.imageFile) {
        try {
          await fs.copyFile(path.join(this.dir, character.imageFile), path.join(ipDir, character.imageFile))
          activeImages.add(character.imageFile)
          image = `${WORKSPACE_IP_DIR}/${character.imageFile}`
        }
        catch (error) {
          console.warn(`[ip-characters] failed to copy image ${character.imageFile} to workspace:`, error)
        }
      }
      characters.push({
        id: character.id,
        name: character.name,
        description: character.description,
        prompt: character.prompt,
        image,
      })
    }

    await writeJsonAtomic(path.join(ipDir, LIBRARY_FILE), {
      defaultId: snapshot.defaultId,
      characters,
    })

    const entries = await fs.readdir(ipDir, { withFileTypes: true })
    await Promise.all(
      entries.map(async (entry) => {
        if (entry.name === LIBRARY_FILE || entry.name === WORKSPACE_SELECTED_FILE)
          return
        if (!entry.isFile() && !entry.isSymbolicLink())
          return
        if (!IMAGE_MIME_BY_EXT.has(path.extname(entry.name).toLowerCase()))
          return
        if (activeImages.has(entry.name))
          return
        await fs.rm(path.join(ipDir, entry.name), { force: true }).catch(() => undefined)
      }),
    )
  }

  applyWorkspaceSelection(workspaceDir: string): Promise<boolean> {
    return this.runMutation(async () => {
      const selectedPath = path.join(workspaceDir, WORKSPACE_IP_DIR, WORKSPACE_SELECTED_FILE)
      let raw: string
      try {
        raw = await fs.readFile(selectedPath, `utf8`)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === `ENOENT`)
          return false
        console.warn(`[ip-characters] failed to read ${selectedPath}:`, error)
        await fs.rm(selectedPath, { force: true }).catch(() => undefined)
        return false
      }

      try {
        await this.ensureLoaded()
        let parsed: unknown
        try {
          parsed = JSON.parse(raw)
        }
        catch (error) {
          console.warn(`[ip-characters] invalid JSON in ${selectedPath}:`, error)
          return false
        }

        if (!parsed || typeof parsed !== `object` || Array.isArray(parsed)) {
          console.warn(`[ip-characters] invalid selection payload in ${selectedPath}`)
          return false
        }

        const payload = parsed as Record<string, unknown>

        if (`id` in payload && payload.id !== undefined) {
          if (typeof payload.id !== `string` || !this.library.characters.some(c => c.id === payload.id)) {
            console.warn(`[ip-characters] unknown character id in selection:`, payload.id)
            return false
          }
          if (this.library.defaultId === payload.id)
            return false

          const nextLibrary: DesktopIpLibrary = {
            defaultId: payload.id,
            characters: this.library.characters,
          }
          await writeJsonAtomic(this.libraryPath, nextLibrary)
          this.library = nextLibrary
          this.emitChange()
          return true
        }

        let name: string
        let description: string
        let prompt: string
        let resolvedImage: { sourcePath: string, ext: string } | null = null
        try {
          name = validateName(payload.name)
          description = validateDescription(payload.description)
          prompt = validatePrompt(payload.prompt)
          if (payload.image !== undefined && payload.image !== null)
            resolvedImage = await resolveWorkspaceImage(workspaceDir, payload.image)
        }
        catch (error) {
          console.warn(`[ip-characters] invalid selection in ${selectedPath}:`, error)
          return false
        }

        const existing = this.library.characters.find(c => c.name === name && c.prompt === prompt)
        if (existing) {
          if (this.library.defaultId === existing.id)
            return false
          const nextLibrary: DesktopIpLibrary = {
            defaultId: existing.id,
            characters: this.library.characters,
          }
          await writeJsonAtomic(this.libraryPath, nextLibrary)
          this.library = nextLibrary
          this.emitChange()
          return true
        }

        const id = randomUUID()
        let imageFile: string | null = null
        if (resolvedImage) {
          imageFile = `${id}${resolvedImage.ext}`
          await fs.mkdir(this.dir, { recursive: true })
          await fs.copyFile(resolvedImage.sourcePath, path.join(this.dir, imageFile))
        }

        const now = Date.now()
        const character: DesktopIpCharacter = {
          id,
          name,
          description,
          prompt,
          imageFile,
          createdAt: now,
          updatedAt: now,
        }
        const nextLibrary: DesktopIpLibrary = {
          defaultId: id,
          characters: [...this.library.characters, character],
        }

        try {
          await writeJsonAtomic(this.libraryPath, nextLibrary)
        }
        catch (error) {
          if (imageFile)
            await fs.rm(path.join(this.dir, imageFile), { force: true }).catch(() => undefined)
          throw error
        }

        this.library = nextLibrary
        this.emitChange()
        return true
      }
      catch (error) {
        console.warn(`[ip-characters] failed to apply selection from ${selectedPath}:`, error)
        return false
      }
      finally {
        await fs.rm(selectedPath, { force: true }).catch(() => undefined)
      }
    })
  }
}
