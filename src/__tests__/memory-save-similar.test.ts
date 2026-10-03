/**
 * SIMILARMEMORY1003: the save-time similar-memory signal on POST /api/memories.
 *
 * Two memories can contradict each other and never meet: search is
 * query-driven, so the older claim stays findable on its own and nobody
 * corrects it. At save time the new memory's embedding is compared with every
 * stored one, and the response names the close rows, so the saving agent
 * decides whether the new memory supersedes them. Nothing is merged or deleted.
 *
 * The embedding backend is a stubbed fetch. Its vectors are 4-dimensional, but
 * their pairwise cosines are exactly what the default model (nomic-embed-text,
 * 768 dims) gives these four texts, measured 2026-10-03 (the rows are the
 * Cholesky factor of the measured cosine matrix): the decision and its change
 * 0.919, the two unrelated sentences 0.497, every cross pair 0.44-0.54.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'stream'
import { initDatabase, getDb, saveAgentMemory, saveAgentMemoryCheckingSimilar, findSimilarMemories } from '../db.js'
import { tryHandleMemories, formatSimilarMemoryWarning } from '../web/routes/memories.js'
import type { RouteContext } from '../web/routes/types.js'

vi.mock('../config.js', async () => {
  const actual = await vi.importActual<typeof import('../config.js')>('../config.js')
  return {
    ...actual,
    MAIN_AGENT_ID: 'agent-a',
    ALLOWED_CHAT_ID: 'test-chat',
    OLLAMA_URL: '',
    EMBED_URL: 'http://embed.invalid',
    EMBED_DIMS: 0,
    MEMORY_SIMILAR_THRESHOLD: 0.9,
    MEMORY_SIMILAR_WAIT_MS: 1000,
  }
})
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

const DECISION = 'Owner decision: the nightly report goes out at 07:00 local time, one batched message.'
const DECISION_CHANGED = 'Owner decision changed: the nightly report goes out at 08:30 local time, not 07:00.'
const RECEIPT = 'The warehouse receipt form takes only the remainder of a partly received line.'
const GREETING = 'The voice agent greets callers informally and says the call is recorded.'
// The same change with one Cyrillic letter, built from its code point so this
// file carries no homoglyph of its own.
const DECISION_CHANGED_HOMOGLYPH = DECISION_CHANGED.replace('report', `r${String.fromCharCode(0x0435)}port`)

const VECTORS: Record<string, number[]> = {
  [DECISION]: [1, 0, 0, 0],
  [DECISION_CHANGED]: [0.918723, 0.394903, 0, 0],
  [RECEIPT]: [0.538812, -0.032781, 0.841788, 0],
  [GREETING]: [0.518361, -0.095699, 0.255083, 0.810602],
  [DECISION_CHANGED_HOMOGLYPH]: [0.918723, 0.394903, 0, 0],
}

let prompts: string[] = []

function stubEmbedder(opts: { delayMs?: number; down?: boolean } = {}): void {
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    const prompt = (JSON.parse(String(init?.body ?? '{}')) as { prompt: string }).prompt
    prompts.push(prompt)
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs))
    if (opts.down) throw new Error('connect ECONNREFUSED')
    const embedding = VECTORS[prompt]
    if (!embedding) throw new Error(`no test vector for: ${prompt}`)
    return new Response(JSON.stringify({ embedding }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
}

async function save(content: string, agentId = 'agent-a', category = 'warm'): Promise<any> {
  const path = '/api/memories'
  const url = new URL(`http://localhost:3420${path}`)
  let responseBody = ''
  const res = { writeHead: () => {}, setHeader: () => {}, end: (b?: string) => { responseBody = b || '' } }
  const req = Readable.from([Buffer.from(JSON.stringify({ agent_id: agentId, content, category }))]) as any
  const ctx: RouteContext = { req, res: res as any, path, method: 'POST', url }
  await tryHandleMemories(ctx)
  return JSON.parse(responseBody)
}

function storedEmbedding(id: number): number[] | null {
  const row = getDb().prepare('SELECT embedding FROM memories WHERE id = ?').get(id) as { embedding: string | null } | undefined
  return row?.embedding ? (JSON.parse(row.embedding) as number[]) : null
}

async function waitForEmbedding(id: number): Promise<number[] | null> {
  const deadline = Date.now() + 2000
  while (storedEmbedding(id) === null && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10))
  return storedEmbedding(id)
}

beforeEach(() => {
  initDatabase(':memory:')
  prompts = []
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('POST /api/memories: the similar-memory signal', () => {
  it('a contradicting second save names the first memory by its id', async () => {
    stubEmbedder()
    const first = await save(DECISION)
    expect(first.ok).toBe(true)
    expect(first.similar_check).toBe('ok')
    expect(first.similar_memories).toBeUndefined()

    const second = await save(DECISION_CHANGED)
    expect(second.ok).toBe(true)
    expect(second.similar_check).toBe('ok')
    expect(second.similar_memories).toEqual([{ id: first.id, agent_id: 'agent-a', category: 'warm', similarity: 0.919 }])
    expect(second.similar_warning).toContain(`#${first.id} (agent-a, warm, 0.92)`)
    expect(second.similar_warning).toContain('supersede')
  })

  it('blind: two unrelated memories give no signal', async () => {
    stubEmbedder()
    await save(RECEIPT)
    const second = await save(GREETING)
    expect(second.ok).toBe(true)
    expect(second.similar_check).toBe('ok')
    expect(second.similar_memories).toBeUndefined()
    expect(second.similar_warning).toBeUndefined()
  })

  it('an unrelated memory next to the pair stays silent, the pair still meets', async () => {
    stubEmbedder()
    const first = await save(DECISION)
    expect((await save(RECEIPT)).similar_memories).toBeUndefined()
    expect((await save(GREETING)).similar_memories).toBeUndefined()
    const changed = await save(DECISION_CHANGED)
    expect(changed.similar_memories.map((s: { id: number }) => s.id)).toEqual([first.id])
  })

  it("another agent's close memory is named, with its owner", async () => {
    stubEmbedder()
    const theirs = await save(DECISION, 'agent-b', 'shared')
    const mine = await save(DECISION_CHANGED, 'agent-a', 'hot')
    expect(mine.similar_memories).toEqual([{ id: theirs.id, agent_id: 'agent-b', category: 'shared', similarity: 0.919 }])
  })

  it('one embedding call per save, and the stored vector is the one it returned', async () => {
    stubEmbedder()
    const r = await save(DECISION)
    expect(prompts).toEqual([DECISION])
    expect(storedEmbedding(r.id)).toEqual(VECTORS[DECISION])
  })

  it('the embedding backend is down: the save stands and the response says the check did not run', async () => {
    stubEmbedder({ down: true })
    const r = await save(DECISION)
    expect(r.ok).toBe(true)
    expect(r.similar_check).toBe('unavailable')
    expect(r.similar_memories).toBeUndefined()
    const row = getDb().prepare('SELECT content, embedding FROM memories WHERE id = ?').get(r.id) as { content: string; embedding: string | null }
    expect(row.content).toBe(DECISION)
    expect(row.embedding).toBeNull()
  })

  it('a homoglyph warning and a similar-memory warning ride the same response', async () => {
    stubEmbedder()
    const first = await save(DECISION)
    const r = await save(DECISION_CHANGED_HOMOGLYPH)
    expect(r.homoglyph_warning).toMatch(/homoglyph/)
    expect(r.similar_memories.map((s: { id: number }) => s.id)).toEqual([first.id])
  })
})

describe('saveAgentMemoryCheckingSimilar', () => {
  it('a slow backend: the save answers after the wait with "timeout", and the vector still lands', async () => {
    stubEmbedder({ delayMs: 200 })
    const r = await saveAgentMemoryCheckingSimilar('agent-a', DECISION, 'warm', undefined, true, { threshold: 0.9, waitMs: 50 })
    expect(r.check).toBe('timeout')
    expect(r.similar).toEqual([])
    expect(storedEmbedding(r.id)).toBeNull()
    expect(await waitForEmbedding(r.id)).toEqual(VECTORS[DECISION])
    expect(prompts).toEqual([DECISION])
  })

  it('a wait of 0 turns the check off and keeps the plain save, embedding included', async () => {
    stubEmbedder()
    const r = await saveAgentMemoryCheckingSimilar('agent-a', DECISION, 'warm', undefined, true, { threshold: 0.9, waitMs: 0 })
    expect(r.check).toBe('off')
    expect(r.similar).toEqual([])
    expect(await waitForEmbedding(r.id)).toEqual(VECTORS[DECISION])
  })
})

describe('findSimilarMemories', () => {
  function rowWith(embedding: number[], agentId = 'agent-a'): number {
    const { id } = saveAgentMemory(agentId, `row ${embedding.join(',')}`, 'warm')
    getDb().prepare('UPDATE memories SET embedding = ? WHERE id = ?').run(JSON.stringify(embedding), id)
    return id
  }
  const at = (c: number): number[] => [c, Math.sqrt(1 - c * c)]

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('no backend in this block') }))
  })

  it('the threshold is inclusive from above: 0.9005 is named, 0.8995 is not', () => {
    const above = rowWith(at(0.9005))
    rowWith(at(0.8995))
    expect(findSimilarMemories([1, 0], -1, 0.9).map((s) => s.id)).toEqual([above])
  })

  it('best first, at most the limit, never the excluded row', () => {
    const ids = [0.91, 0.99, 0.95, 0.93].map((c) => rowWith(at(c)))
    expect(findSimilarMemories([1, 0], -1, 0.9, 3).map((s) => s.id)).toEqual([ids[1], ids[2], ids[3]])
    expect(findSimilarMemories([1, 0], ids[1], 0.9, 3).map((s) => s.id)).toEqual([ids[2], ids[3], ids[0]])
  })

  it('a row embedded by another model (another vector length) is skipped, not scored', () => {
    rowWith([1, 0, 0])
    const same = rowWith(at(0.95))
    const found = findSimilarMemories([1, 0], -1, 0.9)
    expect(found.map((s) => s.id)).toEqual([same])
    expect(found.every((s) => Number.isFinite(s.similarity))).toBe(true)
  })

  it('a zero vector never reaches the threshold', () => {
    rowWith([0, 0])
    expect(findSimilarMemories([1, 0], -1, 0.9)).toEqual([])
  })
})

describe('formatSimilarMemoryWarning', () => {
  it('names every row with owner, category and similarity, and asks rather than decides', () => {
    const text = formatSimilarMemoryWarning([
      { id: 7, agentId: 'agent-b', category: 'shared', similarity: 0.9312 },
      { id: 3, agentId: 'agent-a', category: 'cold', similarity: 0.904 },
    ])
    expect(text).toContain('#7 (agent-b, shared, 0.93), #3 (agent-a, cold, 0.90)')
    expect(text).toContain('Saved anyway')
    expect(text).toMatch(/supersede .* or do they stand together\?/)
  })
})
