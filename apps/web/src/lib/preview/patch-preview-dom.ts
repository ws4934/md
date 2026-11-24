import type { RenderedBlock } from '@md/core/utils'

interface TrackedBlock {
  key: string
  html: string
  /** Live direct child nodes currently owned by this block inside `container`. */
  nodes: ChildNode[]
}

interface PreviewPatchState {
  container: HTMLElement
  blocks: TrackedBlock[]
  template: HTMLTemplateElement
}

export interface PatchPreviewResult {
  /** Top-level HTMLElements newly parsed and inserted into `#output`. */
  addedElements: HTMLElement[]
  /** True when the entire `<section class="container">` was rebuilt from scratch. */
  fullReset: boolean
  /** True if any newly parsed block HTML may need async highlight or infographic hydration. */
  needsHydration: boolean
}

const patchStates = new WeakMap<HTMLElement, PreviewPatchState>()

function blockMayNeedHydration(html: string): boolean {
  return html.includes(`data-language-pending="`) || html.includes(`infographic-diagram`)
}

function parseBlockNodes(
  template: HTMLTemplateElement,
  html: string,
  addedElements: HTMLElement[],
): ChildNode[] {
  if (!html)
    return []
  template.innerHTML = html
  const nodes = Array.from(template.content.childNodes)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]
    if (node.nodeType === Node.ELEMENT_NODE)
      addedElements.push(node as HTMLElement)
  }
  return nodes
}

/**
 * Compute the set of indices in `seq` (ignoring `-1` entries) belonging to a
 * longest strictly increasing subsequence. Nodes in this set are already in
 * correct relative DOM order and need not be moved.
 */
function longestIncreasingSubsequenceSet(seq: number[]): Set<number> {
  const n = seq.length
  const tails: number[] = []
  const prev = new Int32Array(n).fill(-1)

  for (let i = 0; i < n; i++) {
    const val = seq[i]
    if (val < 0)
      continue
    let lo = 0
    let hi = tails.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (seq[tails[mid]] < val)
        lo = mid + 1
      else
        hi = mid
    }
    if (lo > 0)
      prev[i] = tails[lo - 1]
    tails[lo] = i
  }

  const result = new Set<number>()
  let k = tails.length > 0 ? tails[tails.length - 1] : -1
  while (k !== -1) {
    result.add(k)
    k = prev[k]
  }
  return result
}

function rebuildContainer(
  outputEl: HTMLElement,
  nextBlocks: RenderedBlock[],
  template: HTMLTemplateElement,
): PatchPreviewResult {
  const container = document.createElement(`section`)
  container.className = `container`
  const tracked: TrackedBlock[] = []
  const addedElements: HTMLElement[] = []
  let needsHydration = false

  if (nextBlocks.length === 1 && nextBlocks[0].key === `full`) {
    const html = nextBlocks[0].html
    container.innerHTML = html
    const nodes = Array.from(container.childNodes)
    tracked.push({ key: `full`, html, nodes })
    addedElements.push(container)
    needsHydration = blockMayNeedHydration(html)
  }
  else {
    const fragment = document.createDocumentFragment()
    for (let i = 0; i < nextBlocks.length; i++) {
      const block = nextBlocks[i]
      if (!needsHydration && blockMayNeedHydration(block.html))
        needsHydration = true
      const nodes = parseBlockNodes(template, block.html, addedElements)
      for (let j = 0; j < nodes.length; j++)
        fragment.appendChild(nodes[j])
      tracked.push({ key: block.key, html: block.html, nodes })
    }
    container.appendChild(fragment)
  }

  outputEl.replaceChildren(container)
  patchStates.set(outputEl, { container, blocks: tracked, template })
  return { addedElements, fullReset: true, needsHydration }
}

/** Drop tracked DOM state for `outputEl` (call on unmount). */
export function resetPreviewDomState(outputEl: HTMLElement | null | undefined): void {
  if (outputEl)
    patchStates.delete(outputEl)
}

/**
 * Reconcile `#output > section.container` children against `nextBlocks` without
 * introducing wrapper elements or touching unchanged DOM subtrees (preserving
 * rendered Mermaid/MathJax/PlantUML SVGs and download overlays).
 */
export function patchPreviewDom(
  outputEl: HTMLElement,
  nextBlocks: RenderedBlock[],
): PatchPreviewResult {
  if (nextBlocks.length === 0) {
    outputEl.replaceChildren()
    patchStates.delete(outputEl)
    return { addedElements: [], fullReset: true, needsHydration: false }
  }

  const state = patchStates.get(outputEl)
  const template = state?.template ?? document.createElement(`template`)

  // Full rebuild on first mount, external DOM wipe, or fallback full-render payload.
  if (
    !state
    || state.container.parentNode !== outputEl
    || (nextBlocks.length === 1 && nextBlocks[0].key === `full`)
    || (state.blocks.length === 1 && state.blocks[0].key === `full`)
  ) {
    return rebuildContainer(outputEl, nextBlocks, template)
  }

  const { container, blocks: prevBlocks } = state

  // 1. Common prefix match (O(k) string checks, zero DOM calls).
  let head = 0
  while (
    head < prevBlocks.length
    && head < nextBlocks.length
    && prevBlocks[head].html === nextBlocks[head].html
  ) {
    prevBlocks[head].key = nextBlocks[head].key
    head++
  }

  // 2. Common suffix match (O(n-k) string checks, zero DOM calls).
  let prevTail = prevBlocks.length - 1
  let nextTail = nextBlocks.length - 1
  while (
    prevTail >= head
    && nextTail >= head
    && prevBlocks[prevTail].html === nextBlocks[nextTail].html
  ) {
    prevBlocks[prevTail].key = nextBlocks[nextTail].key
    prevTail--
    nextTail--
  }

  // 3. Fast no-op exit when every block is unchanged.
  if (head > prevTail && head > nextTail)
    return { addedElements: [], fullReset: false, needsHydration: false }

  // 4. Locate anchor node right after the changed middle slice and verify connectivity.
  let tailAnchor: ChildNode | null = null
  for (let i = prevTail + 1; i < prevBlocks.length; i++) {
    const nodes = prevBlocks[i].nodes
    if (nodes.length > 0) {
      if (nodes[0].parentNode !== container)
        return rebuildContainer(outputEl, nextBlocks, template)
      tailAnchor = nodes[0]
      break
    }
  }

  // Verify connectivity of old middle nodes before mutating.
  for (let i = head; i <= prevTail; i++) {
    const nodes = prevBlocks[i].nodes
    for (let j = 0; j < nodes.length; j++) {
      if (nodes[j].parentNode !== container)
        return rebuildContainer(outputEl, nextBlocks, template)
    }
  }

  const prevMiddleCount = prevTail - head + 1
  const nextMiddleCount = nextTail - head + 1

  // 5. Match surviving identical blocks in the middle slice so scattered edits
  //    (e.g. inserting a heading at top that renumbers later heading ids) reuse
  //    every unchanged paragraph/code/SVG in place via LIS without moving them.
  const pool = new Map<string, number[]>()
  for (let i = head; i <= prevTail; i++) {
    const html = prevBlocks[i].html
    let list = pool.get(html)
    if (!list) {
      list = []
      pool.set(html, list)
    }
    list.push(i)
  }

  const matchedPrevIdx = Array.from<number>({ length: nextMiddleCount }).fill(-1)
  const reusedPrev = new Set<number>()
  for (let j = 0; j < nextMiddleCount; j++) {
    const html = nextBlocks[head + j].html
    const list = pool.get(html)
    if (list && list.length > 0) {
      const prevIdx = list.shift()!
      matchedPrevIdx[j] = prevIdx
      reusedPrev.add(prevIdx)
    }
  }

  // Remove old middle blocks that are no longer reused.
  for (let i = 0; i < prevMiddleCount; i++) {
    const prevIdx = head + i
    if (reusedPrev.has(prevIdx))
      continue
    const nodes = prevBlocks[prevIdx].nodes
    for (let k = 0; k < nodes.length; k++)
      nodes[k].remove()
  }

  // Reconcile new middle blocks back-to-front so LIS members stay stationary.
  const stationary = longestIncreasingSubsequenceSet(matchedPrevIdx)
  const newMiddle: TrackedBlock[] = Array.from({ length: nextMiddleCount })
  const addedElements: HTMLElement[] = []
  let needsHydration = false
  let curAnchor: ChildNode | null = tailAnchor

  for (let j = nextMiddleCount - 1; j >= 0; j--) {
    const nextBlock = nextBlocks[head + j]
    const prevIdx = matchedPrevIdx[j]

    if (prevIdx !== -1) {
      const oldNodes = prevBlocks[prevIdx].nodes
      if (!stationary.has(j) && oldNodes.length > 0) {
        const frag = document.createDocumentFragment()
        for (let k = 0; k < oldNodes.length; k++)
          frag.appendChild(oldNodes[k])
        container.insertBefore(frag, curAnchor)
      }
      newMiddle[j] = { key: nextBlock.key, html: nextBlock.html, nodes: oldNodes }
      if (oldNodes.length > 0)
        curAnchor = oldNodes[0]
    }
    else {
      if (!needsHydration && blockMayNeedHydration(nextBlock.html))
        needsHydration = true
      const nodes = parseBlockNodes(template, nextBlock.html, addedElements)
      if (nodes.length > 0) {
        const frag = document.createDocumentFragment()
        for (let k = 0; k < nodes.length; k++)
          frag.appendChild(nodes[k])
        container.insertBefore(frag, curAnchor)
        curAnchor = nodes[0]
      }
      newMiddle[j] = { key: nextBlock.key, html: nextBlock.html, nodes }
    }
  }

  state.blocks = [
    ...prevBlocks.slice(0, head),
    ...newMiddle,
    ...prevBlocks.slice(prevTail + 1),
  ]

  return { addedElements, fullReset: false, needsHydration }
}
