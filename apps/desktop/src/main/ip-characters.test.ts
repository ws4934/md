import type { DesktopIpLibrary } from '@md/shared/types'
import { Buffer } from 'node:buffer'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AcpHost } from './acp/host'
import { IpCharacterStore } from './ip-characters'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AGENT_SCRIPT = path.resolve(__dirname, `../../scripts/fake-acp-agent.mjs`)

const tempDirs: string[] = []
const openHosts: AcpHost[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

async function writeSelected(workspaceDir: string, content: unknown): Promise<string> {
  const ipDir = path.join(workspaceDir, `ip`)
  await fs.mkdir(ipDir, { recursive: true })
  const selectedPath = path.join(ipDir, `selected.json`)
  const raw = typeof content === `string` ? content : JSON.stringify(content)
  await fs.writeFile(selectedPath, raw, `utf8`)
  return selectedPath
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  }
  catch {
    return false
  }
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (openHosts.length > 0) {
    const h = openHosts.pop()!
    await h.dispose()
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
})

describe(`ipCharacterStore`, () => {
  it(`reads missing or corrupt library.json as empty library`, async () => {
    const dir = await makeTempDir(`md-ip-empty-`)
    const store = new IpCharacterStore({ dir })
    expect(await store.list()).toEqual({ defaultId: null, characters: [] })

    const corruptDir = await makeTempDir(`md-ip-corrupt-`)
    await fs.writeFile(path.join(corruptDir, `library.json`), `{not valid json`, `utf8`)
    const corruptStore = new IpCharacterStore({ dir: corruptDir })
    expect(await corruptStore.list()).toEqual({ defaultId: null, characters: [] })

    const badShapeDir = await makeTempDir(`md-ip-bad-shape-`)
    await fs.writeFile(path.join(badShapeDir, `library.json`), JSON.stringify({ defaultId: `ghost`, characters: `nope` }), `utf8`)
    const badShapeStore = new IpCharacterStore({ dir: badShapeDir })
    expect(await badShapeStore.list()).toEqual({ defaultId: null, characters: [] })
  })

  it(`creates and defaults a character via applyWorkspaceSelection and copies its image`, async () => {
    const dir = await makeTempDir(`md-ip-store-`)
    const ws = await makeTempDir(`md-ip-ws-`)
    const store = new IpCharacterStore({ dir })
    const changes: DesktopIpLibrary[] = []
    store.onChange(lib => changes.push(lib))

    const imageBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])
    await fs.mkdir(path.join(ws, `images`), { recursive: true })
    await fs.writeFile(path.join(ws, `images`, `mascot.png`), imageBytes)
    const selectedPath = await writeSelected(ws, {
      name: `  小橘猫  `,
      description: `  圆滚滚的橘猫记者  `,
      prompt: `  Chubby orange tabby cat wearing a green scarf  `,
      image: `images/mascot.png`,
    })

    expect(await store.applyWorkspaceSelection(ws)).toBe(true)
    expect(await exists(selectedPath)).toBe(false)

    const lib = await store.list()
    expect(lib.characters).toHaveLength(1)
    const [char] = lib.characters
    expect(lib.defaultId).toBe(char.id)
    expect(char.name).toBe(`小橘猫`)
    expect(char.description).toBe(`圆滚滚的橘猫记者`)
    expect(char.prompt).toBe(`Chubby orange tabby cat wearing a green scarf`)
    expect(char.imageFile).toBe(`${char.id}.png`)
    expect(await exists(path.join(dir, `${char.id}.png`))).toBe(true)
    expect(changes).toHaveLength(1)
    expect(changes[0].defaultId).toBe(char.id)

    const dataUrl = await store.readImage(char.id)
    expect(dataUrl).toBe(`data:image/png;base64,${imageBytes.toString(`base64`)}`)
    expect(await store.readImage(`nonexistent`)).toBeNull()

    // Reloading from disk preserves persisted data.
    const reloaded = await new IpCharacterStore({ dir }).list()
    expect(reloaded).toEqual(lib)
  })

  it(`validates update fields, trims values, and rejects invalid patches`, async () => {
    const dir = await makeTempDir(`md-ip-update-`)
    const ws = await makeTempDir(`md-ip-ws-`)
    const store = new IpCharacterStore({ dir })

    await writeSelected(ws, {
      name: `Initial`,
      description: `Desc`,
      prompt: `Prompt one`,
    })
    await store.applyWorkspaceSelection(ws)
    const [{ id }] = (await store.list()).characters

    const updated = await store.update(id, {
      name: `  Renamed  `,
      description: `  Updated desc  `,
      prompt: `  New prompt  `,
    })
    expect(updated.characters[0]).toMatchObject({
      id,
      name: `Renamed`,
      description: `Updated desc`,
      prompt: `New prompt`,
    })

    // Boundary values succeed: name 40, description 0 and 200, prompt 2000.
    const boundary = await store.update(id, {
      name: `a`.repeat(40),
      description: ``,
      prompt: `p`.repeat(2000),
    })
    expect(boundary.characters[0].name).toHaveLength(40)
    expect(boundary.characters[0].description).toBe(``)
    expect(boundary.characters[0].prompt).toHaveLength(2000)

    await expect(store.update(id, { description: `d`.repeat(200) })).resolves.toBeDefined()

    // Out-of-bounds and unknown ID reject.
    await expect(store.update(`missing`, { name: `Valid` })).rejects.toThrow(/Unknown/)
    await expect(store.update(id, { name: `   ` })).rejects.toThrow(/name/i)
    await expect(store.update(id, { name: `a`.repeat(41) })).rejects.toThrow(/name/i)
    await expect(store.update(id, { description: `d`.repeat(201) })).rejects.toThrow(/description/i)
    await expect(store.update(id, { prompt: `   ` })).rejects.toThrow(/prompt/i)
    await expect(store.update(id, { prompt: `p`.repeat(2001) })).rejects.toThrow(/prompt/i)
  })

  it(`switches default via setDefault and {id} selection, rejecting unknown ids`, async () => {
    const dir = await makeTempDir(`md-ip-default-`)
    const ws = await makeTempDir(`md-ip-ws-`)
    const store = new IpCharacterStore({ dir })

    await writeSelected(ws, { name: `First`, prompt: `First prompt` })
    await store.applyWorkspaceSelection(ws)
    await writeSelected(ws, { name: `Second`, prompt: `Second prompt` })
    await store.applyWorkspaceSelection(ws)

    const { characters } = await store.list()
    const [first, second] = characters
    expect((await store.list()).defaultId).toBe(second.id)

    await expect(store.setDefault(`unknown-id`)).rejects.toThrow(/Unknown/)

    // Switch default via { id } workspace selection.
    const selectedPath = await writeSelected(ws, { id: first.id })
    expect(await store.applyWorkspaceSelection(ws)).toBe(true)
    expect(await exists(selectedPath)).toBe(false)
    expect((await store.list()).defaultId).toBe(first.id)

    // Re-selecting the current default returns false and deletes selected.json.
    const selectedAgain = await writeSelected(ws, { id: first.id })
    expect(await store.applyWorkspaceSelection(ws)).toBe(false)
    expect(await exists(selectedAgain)).toBe(false)

    // Unknown id in selected.json warns, returns false, and deletes selected.json.
    const warnSpy = vi.spyOn(console, `warn`).mockImplementation(() => {})
    const badIdPath = await writeSelected(ws, { id: `does-not-exist` })
    expect(await store.applyWorkspaceSelection(ws)).toBe(false)
    expect(await exists(badIdPath)).toBe(false)
    expect(warnSpy).toHaveBeenCalled()

    // setDefault(null) clears defaultId.
    const cleared = await store.setDefault(null)
    expect(cleared.defaultId).toBeNull()
  })

  it(`removes character, clears defaultId when needed, and deletes stored image`, async () => {
    const dir = await makeTempDir(`md-ip-remove-`)
    const ws = await makeTempDir(`md-ip-ws-`)
    const store = new IpCharacterStore({ dir })

    await fs.writeFile(path.join(ws, `a.webp`), Buffer.from([1, 2, 3, 4]))
    await writeSelected(ws, { name: `A`, prompt: `Prompt A`, image: `a.webp` })
    await store.applyWorkspaceSelection(ws)

    await writeSelected(ws, { name: `B`, prompt: `Prompt B` })
    await store.applyWorkspaceSelection(ws)

    const initial = await store.list()
    const [charA, charB] = initial.characters
    expect(await store.readImage(charA.id)).toMatch(/^data:image\/webp;base64,/)
    expect(await store.readImage(charB.id)).toBeNull()

    // Make A default, then remove A -> default becomes null and image file is deleted.
    await store.setDefault(charA.id)
    const afterRemoveA = await store.remove(charA.id)
    expect(afterRemoveA.defaultId).toBeNull()
    expect(afterRemoveA.characters.map(c => c.id)).toEqual([charB.id])
    expect(await exists(path.join(dir, charA.imageFile!))).toBe(false)

    // Removing non-default keeps current default intact.
    await store.setDefault(charB.id)
    await writeSelected(ws, { name: `C`, prompt: `Prompt C` })
    await store.applyWorkspaceSelection(ws)
    const charC = (await store.list()).characters.find(c => c.name === `C`)!
    const afterRemoveB = await store.remove(charB.id)
    expect(afterRemoveB.defaultId).toBe(charC.id)
  })

  it(`rejects traversal, absolute paths, outside symlinks, oversized/invalid images, and always deletes selected.json`, async () => {
    const dir = await makeTempDir(`md-ip-sec-`)
    const parent = await makeTempDir(`md-ip-sec-parent-`)
    const ws = path.join(parent, `ws`)
    await fs.mkdir(ws, { recursive: true })
    const outside = await makeTempDir(`md-ip-sec-outside-`)
    const store = new IpCharacterStore({ dir })
    const warnSpy = vi.spyOn(console, `warn`).mockImplementation(() => {})

    await fs.writeFile(path.join(outside, `x.png`), Buffer.from([1, 2, 3]))
    await fs.writeFile(path.join(parent, `sibling.png`), Buffer.from([4, 5, 6]))
    await fs.symlink(path.join(outside, `x.png`), path.join(ws, `link-out.png`))
    await fs.writeFile(path.join(ws, `notes.txt`), `not an image`)
    await fs.writeFile(path.join(ws, `huge.png`), Buffer.alloc(10 * 1024 * 1024 + 1))

    const cases: Array<unknown> = [
      `{broken json`,
      { name: `Traverse`, prompt: `Valid prompt`, image: `../sibling.png` },
      { name: `SymlinkOut`, prompt: `Valid prompt`, image: `link-out.png` },
      { name: `AbsPath`, prompt: `Valid prompt`, image: path.join(outside, `x.png`) },
      { name: `BadExt`, prompt: `Valid prompt`, image: `notes.txt` },
      { name: `TooBig`, prompt: `Valid prompt`, image: `huge.png` },
      { name: ``, prompt: `Empty name` },
    ]

    for (const payload of cases) {
      const selectedPath = await writeSelected(ws, payload)
      expect(await store.applyWorkspaceSelection(ws)).toBe(false)
      expect(await exists(selectedPath)).toBe(false)
    }

    expect((await store.list()).characters).toHaveLength(0)
    expect(warnSpy).toHaveBeenCalledTimes(cases.length)
  })

  it(`reuses an existing character when name and prompt match instead of duplicating`, async () => {
    const dir = await makeTempDir(`md-ip-dedup-`)
    const ws = await makeTempDir(`md-ip-ws-`)
    const store = new IpCharacterStore({ dir })

    await writeSelected(ws, { name: `阿呆`, description: `原描述`, prompt: `A tiny blue robot` })
    expect(await store.applyWorkspaceSelection(ws)).toBe(true)
    const firstId = (await store.list()).characters[0].id

    await writeSelected(ws, { name: `小红`, prompt: `A red fox` })
    expect(await store.applyWorkspaceSelection(ws)).toBe(true)
    expect((await store.list()).defaultId).not.toBe(firstId)

    // Re-submitting identical name + prompt reuses first character and makes it default.
    await writeSelected(ws, { name: `  阿呆 `, prompt: ` A tiny blue robot  ` })
    expect(await store.applyWorkspaceSelection(ws)).toBe(true)

    const lib = await store.list()
    expect(lib.characters).toHaveLength(2)
    expect(lib.defaultId).toBe(firstId)

    // Re-submitting again while already default returns false and still creates no duplicate.
    await writeSelected(ws, { name: `阿呆`, prompt: `A tiny blue robot` })
    expect(await store.applyWorkspaceSelection(ws)).toBe(false)
    expect((await store.list()).characters).toHaveLength(2)
  })

  it(`writes workspace snapshot with images, removes stale images, and preserves selected.json`, async () => {
    const dir = await makeTempDir(`md-ip-snap-`)
    const ws = await makeTempDir(`md-ip-snap-ws-`)
    const store = new IpCharacterStore({ dir })

    await fs.writeFile(path.join(ws, `cat.jpg`), Buffer.from([255, 216, 255]))
    await writeSelected(ws, { name: `Cat`, description: `橘猫`, prompt: `Orange cat`, image: `cat.jpg` })
    await store.applyWorkspaceSelection(ws)
    await writeSelected(ws, { name: `Dog`, prompt: `Shiba dog` })
    await store.applyWorkspaceSelection(ws)

    const [cat, dog] = (await store.list()).characters

    // Seed a stale image and an agent-written selected.json before snapshotting.
    const ipDir = path.join(ws, `ip`)
    await fs.mkdir(ipDir, { recursive: true })
    await fs.writeFile(path.join(ipDir, `stale-old.png`), Buffer.from([9, 9, 9]))
    const pendingSelected = JSON.stringify({ id: cat.id })
    await fs.writeFile(path.join(ipDir, `selected.json`), pendingSelected, `utf8`)

    await store.writeWorkspaceSnapshot(ws)

    const snapJson = JSON.parse(await fs.readFile(path.join(ipDir, `library.json`), `utf8`))
    expect(snapJson).toEqual({
      defaultId: dog.id,
      characters: [
        { id: cat.id, name: `Cat`, description: `橘猫`, prompt: `Orange cat`, image: `ip/${cat.id}.jpg` },
        { id: dog.id, name: `Dog`, description: ``, prompt: `Shiba dog`, image: null },
      ],
    })
    expect(await exists(path.join(ipDir, `${cat.id}.jpg`))).toBe(true)
    expect(await exists(path.join(ipDir, `stale-old.png`))).toBe(false)
    expect(await fs.readFile(path.join(ipDir, `selected.json`), `utf8`)).toBe(pendingSelected)

    // Removing the character with an image and re-snapshotting removes its image from the workspace.
    await store.remove(cat.id)
    await store.writeWorkspaceSnapshot(ws)
    expect(await exists(path.join(ipDir, `${cat.id}.jpg`))).toBe(false)
    expect(await fs.readFile(path.join(ipDir, `selected.json`), `utf8`)).toBe(pendingSelected)
  })

  it(`defends against symlinked workspace ip/selected.json and preserves pending selected.json image across snapshot refresh`, async () => {
    const dir = await makeTempDir(`md-ip-symlink-guard-`)
    const ws = await makeTempDir(`md-ip-symlink-ws-`)
    const outsidePictures = await makeTempDir(`md-ip-outside-pics-`)
    const store = new IpCharacterStore({ dir })
    vi.spyOn(console, `warn`).mockImplementation(() => {})

    // Seed an outside directory with precious .png/.json files and replace `<ws>/ip` with a symlink to it.
    const preciousPhoto = path.join(outsidePictures, `family.png`)
    const outsideSelected = path.join(outsidePictures, `selected.json`)
    await fs.writeFile(preciousPhoto, Buffer.from([1, 2, 3, 4]))
    await fs.writeFile(outsideSelected, JSON.stringify({ name: `Evil`, prompt: `Steal` }), `utf8`)
    await fs.symlink(outsidePictures, path.join(ws, `ip`))

    // applyWorkspaceSelection must remove the symlink `<ws>/ip` without deleting outside files.
    expect(await store.applyWorkspaceSelection(ws)).toBe(false)
    expect(await exists(preciousPhoto)).toBe(true)
    expect(await exists(outsideSelected)).toBe(true)

    // Re-plant symlink and verify writeWorkspaceSnapshot never deletes outside images or writes library.json outside.
    await fs.symlink(outsidePictures, path.join(ws, `ip`))
    await store.writeWorkspaceSnapshot(ws)
    expect(await exists(preciousPhoto)).toBe(true)
    expect(await exists(path.join(outsidePictures, `library.json`))).toBe(false)
    expect(await exists(path.join(ws, `ip`, `library.json`))).toBe(true)

    // Symlinked selected.json inside real `<ws>/ip` is unlinked without following target.
    await fs.rm(path.join(ws, `ip`, `selected.json`), { force: true })
    await fs.symlink(outsideSelected, path.join(ws, `ip`, `selected.json`))
    expect(await store.applyWorkspaceSelection(ws)).toBe(false)
    expect(await exists(outsideSelected)).toBe(true)

    // Pending `ip/selected.json` referencing `ip/candidate.png` keeps `ip/candidate.png` alive across snapshot refresh.
    await fs.writeFile(path.join(ws, `ip`, `candidate.png`), Buffer.from([137, 80, 78, 71]))
    await writeSelected(ws, {
      name: `New Mascot`,
      prompt: `Cute panda mascot`,
      image: `ip/candidate.png`,
    })
    await store.writeWorkspaceSnapshot(ws)
    expect(await exists(path.join(ws, `ip`, `candidate.png`))).toBe(true)
    expect(await store.applyWorkspaceSelection(ws)).toBe(true)
    expect((await store.list()).characters).toHaveLength(1)

    // IPC argument type validation rejects invalid inputs with TypeError.
    await expect(store.update(123 as never, { name: `x` })).rejects.toThrow(TypeError)
    await expect(store.update(`id`, null as never)).rejects.toThrow(TypeError)
    await expect(store.setDefault(123 as never)).rejects.toThrow(TypeError)
    await expect(store.remove(undefined as never)).rejects.toThrow(TypeError)
    expect(await store.readImage(null as never)).toBeNull()
  })
})

describe(`acpHost IP character integration`, () => {
  it(`writes snapshot on startSession, applies selection on prompt end, refreshes active sessions, and skips probes`, async () => {
    const dataDir = await makeTempDir(`md-ip-host-`)
    const seedWs = await makeTempDir(`md-ip-seed-ws-`)
    const store = new IpCharacterStore({ dir: path.join(dataDir, `ip-characters`) })

    await fs.writeFile(path.join(seedWs, `hero.png`), Buffer.from([1, 2, 3, 4]))
    await writeSelected(seedWs, { name: `Hero`, description: `主角`, prompt: `Friendly mascot`, image: `hero.png` })
    await store.applyWorkspaceSelection(seedWs)
    const [hero] = (await store.list()).characters

    const host = new AcpHost({
      dataDir,
      ipCharacters: store,
      extraBuiltinAgents: [
        {
          id: `fake-ip`,
          name: `Fake IP Agent`,
          command: process.execPath,
          args: [FAKE_AGENT_SCRIPT],
          env: { FAKE_AGENT_DIRECT_WRITE_ONLY: `1` },
          detectBinaries: [process.execPath],
          builtin: true,
          avatar: { letter: `I`, color: `#5B5BD6` },
        },
      ],
    })
    openHosts.push(host)

    // Probe workspaces must not receive IP snapshots.
    const writeSpy = vi.spyOn(store, `writeWorkspaceSnapshot`)
    await host.probeAgent(`fake-ip`)
    expect(writeSpy).not.toHaveBeenCalled()

    // startSession writes snapshot into session workspace.
    const { sessionId } = await host.startSession({
      agentId: `fake-ip`,
      postId: `p1`,
      postTitle: `Title`,
      content: `# Draft`,
    })
    expect(writeSpy).toHaveBeenCalledTimes(1)

    const [workspaceId] = await fs.readdir(path.join(dataDir, `acp-workspaces`))
    const workspaceDir = path.join(dataDir, `acp-workspaces`, workspaceId)
    const initialSnap = JSON.parse(await fs.readFile(path.join(workspaceDir, `ip`, `library.json`), `utf8`))
    expect(initialSnap.defaultId).toBe(hero.id)
    expect(await exists(path.join(workspaceDir, `ip`, `${hero.id}.png`))).toBe(true)

    // Agent writes selected.json during a turn; prompt() applies and deletes it in finally.
    const selectedPath = await writeSelected(workspaceDir, {
      name: `Sidekick`,
      description: `搭档`,
      prompt: `Small blue bird mascot`,
    })
    await host.prompt({
      sessionId,
      text: `Draft article`,
      content: `# Draft`,
      postTitle: `Title`,
    })
    expect(await exists(selectedPath)).toBe(false)
    const afterPrompt = await store.list()
    expect(afterPrompt.characters).toHaveLength(2)
    const sidekick = afterPrompt.characters.find(c => c.name === `Sidekick`)!
    expect(afterPrompt.defaultId).toBe(sidekick.id)

    // refreshIpSnapshots propagates store changes to active session workspaces.
    await store.update(sidekick.id, { name: `Sidekick v2` })
    await host.refreshIpSnapshots()
    const refreshedSnap = JSON.parse(await fs.readFile(path.join(workspaceDir, `ip`, `library.json`), `utf8`))
    expect(refreshedSnap.defaultId).toBe(sidekick.id)
    expect(refreshedSnap.characters.find((c: { id: string }) => c.id === sidekick.id)?.name).toBe(`Sidekick v2`)
  })
})
