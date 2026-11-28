import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { load as loadYaml } from 'js-yaml'

export interface SkillEntry {
  name: string
  description: string
  dir: string
  skillFile: string
}

export interface SkillConfinementOptions {
  rootDir?: string
}

export const MAX_SKILL_FILE_BYTES = 256 * 1024
const MAX_SKILL_SUPPORT_FILES = 200
const MAX_SKILL_SUPPORT_DEPTH = 8
const CASE_INSENSITIVE_FS = process.platform === `darwin` || process.platform === `win32`

const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

/** Skill names double as folder names and slash commands: no whitespace, path separators or leading dot. */
export function isValidSkillName(name: string): boolean {
  return Boolean(name) && !/[\s/\\]/.test(name) && !name.startsWith(`.`)
}

export function parseSkillFrontMatter(raw: string): { name: string, description: string } | null {
  const match = FRONT_MATTER_RE.exec(raw)
  if (!match)
    return null
  const yamlText = match[1] ?? ``
  // js-yaml 5 throws on empty input; treat empty frontmatter as malformed since `name` is required.
  if (!yamlText.trim())
    return null

  let parsed: unknown
  try {
    parsed = loadYaml(yamlText)
  }
  catch {
    return null
  }
  if (!parsed || typeof parsed !== `object` || Array.isArray(parsed))
    return null

  const record = parsed as Record<string, unknown>
  if (typeof record.name !== `string`)
    return null
  const name = record.name.trim()
  if (!isValidSkillName(name))
    return null

  if (record.description !== undefined && record.description !== null && typeof record.description !== `string`)
    return null
  const description = typeof record.description === `string` ? record.description.trim() : ``

  return { name, description }
}

function isWithinDir(root: string, target: string, allowRoot = true): boolean {
  const normRoot = CASE_INSENSITIVE_FS ? root.toLowerCase() : root
  const normTarget = CASE_INSENSITIVE_FS ? target.toLowerCase() : target
  if (allowRoot && normTarget === normRoot)
    return true
  const prefix = normRoot.endsWith(path.sep) ? normRoot : `${normRoot}${path.sep}`
  return normTarget !== normRoot && normTarget.startsWith(prefix)
}

export async function readSkills(dirs: string[], options?: SkillConfinementOptions): Promise<SkillEntry[]> {
  const results: SkillEntry[] = []
  const seen = new Set<string>()

  let canonicalRoot: string | null = null
  if (options?.rootDir) {
    try {
      canonicalRoot = await fs.realpath(options.rootDir)
    }
    catch {
      return []
    }
  }

  for (const dir of dirs) {
    let canonicalDir: string
    let entries
    try {
      canonicalDir = await fs.realpath(dir)
      if (canonicalRoot && !isWithinDir(canonicalRoot, canonicalDir, true))
        continue
      entries = await fs.readdir(canonicalDir, { withFileTypes: true })
    }
    catch {
      continue
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink())
        continue
      const skillDir = path.join(dir, entry.name)
      const skillFile = path.join(skillDir, `SKILL.md`)
      let content: string
      try {
        const [canonicalSkillDir, canonicalSkillFile] = await Promise.all([
          fs.realpath(skillDir),
          fs.realpath(skillFile),
        ])
        if (
          !isWithinDir(canonicalDir, canonicalSkillDir, false)
          || !isWithinDir(canonicalSkillDir, canonicalSkillFile, false)
        ) {
          continue
        }
        const stat = await fs.stat(canonicalSkillFile)
        if (!stat.isFile() || stat.size > MAX_SKILL_FILE_BYTES)
          continue
        content = await fs.readFile(canonicalSkillFile, `utf8`)
      }
      catch {
        continue
      }
      const meta = parseSkillFrontMatter(content)
      if (!meta || seen.has(meta.name))
        continue
      seen.add(meta.name)
      results.push({
        name: meta.name,
        description: meta.description,
        dir: skillDir,
        skillFile,
      })
    }
  }

  return results
}

/** Lists relative POSIX paths of non-SKILL.md files inside a skill directory (bounded & confined). */
export async function listSkillSupportFiles(
  skillDir: string,
  options?: SkillConfinementOptions,
): Promise<string[]> {
  let canonicalRoot: string
  try {
    canonicalRoot = await fs.realpath(skillDir)
    if (options?.rootDir) {
      const canonicalWorkspace = await fs.realpath(options.rootDir)
      if (!isWithinDir(canonicalWorkspace, canonicalRoot, false))
        return []
    }
  }
  catch {
    return []
  }

  const files: string[] = []
  const visitedDirs = new Set<string>([canonicalRoot])

  const walk = async (currentDir: string, relPrefix: string, depth: number): Promise<void> => {
    if (depth > MAX_SKILL_SUPPORT_DEPTH || files.length >= MAX_SKILL_SUPPORT_FILES)
      return
    let entries
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    }
    catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
      if (files.length >= MAX_SKILL_SUPPORT_FILES)
        return
      const fullPath = path.join(currentDir, entry.name)
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (relPath === `SKILL.md`)
        continue

      let realPath: string
      try {
        realPath = await fs.realpath(fullPath)
      }
      catch {
        continue
      }
      if (!isWithinDir(canonicalRoot, realPath, false))
        continue

      let stat
      try {
        stat = await fs.stat(realPath)
      }
      catch {
        continue
      }
      if (stat.isDirectory()) {
        if (visitedDirs.has(realPath))
          continue
        visitedDirs.add(realPath)
        await walk(realPath, relPath, depth + 1)
      }
      else if (stat.isFile()) {
        files.push(relPath)
      }
    }
  }

  await walk(canonicalRoot, ``, 0)
  return files
}
