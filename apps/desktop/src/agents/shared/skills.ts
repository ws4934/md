import fs from 'node:fs/promises'
import path from 'node:path'
import { load as loadYaml } from 'js-yaml'

export interface SkillEntry {
  name: string
  description: string
  dir: string
  skillFile: string
}

const FRONT_MATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/

function parseSkillFrontMatter(raw: string): { name: string, description: string } | null {
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
  if (!name || /[\s/\\]/.test(name))
    return null

  if (record.description !== undefined && record.description !== null && typeof record.description !== `string`)
    return null
  const description = typeof record.description === `string` ? record.description.trim() : ``

  return { name, description }
}

export async function readSkills(dirs: string[]): Promise<SkillEntry[]> {
  const results: SkillEntry[] = []
  const seen = new Set<string>()

  for (const dir of dirs) {
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
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
        content = await fs.readFile(skillFile, `utf8`)
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

function isWithinDir(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`)
}

/** Lists relative POSIX paths of all non-SKILL.md files inside a skill directory. */
export async function listSkillSupportFiles(skillDir: string): Promise<string[]> {
  let canonicalRoot: string
  try {
    canonicalRoot = await fs.realpath(skillDir)
  }
  catch {
    return []
  }

  const files: string[] = []
  const visitedDirs = new Set<string>([canonicalRoot])

  const walk = async (currentDir: string, relPrefix: string): Promise<void> => {
    let entries
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true })
    }
    catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))

    for (const entry of entries) {
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
      if (!isWithinDir(canonicalRoot, realPath))
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
        await walk(realPath, relPath)
      }
      else if (stat.isFile()) {
        files.push(relPath)
      }
    }
  }

  await walk(canonicalRoot, ``)
  return files
}
