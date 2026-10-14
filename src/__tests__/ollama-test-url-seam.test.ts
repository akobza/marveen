// Card 22cedf69: the suite must not reach a live Ollama, and an HTTP error from the embedding backend must not be silent.
//
// (1) The setup file src/__tests__/setup/ollama-test-url-seam.ts points OLLAMA_URL and EMBED_URL at a dead loopback
//     port through the MARVEEN_TEST_OLLAMA_URL seam of src/config.ts. Proven both ways: under the suite both keys are
//     the seam, and the NEGATIVE CONTROL re-imports config with the seam emptied and no .env, where the same keys fall
//     back to http://localhost:11434 -- the live address the seam exists to keep the suite away from.
// (2) generateEmbedding used to parse an HTTP error answer as JSON and return null with no log line. Now the first
//     failure of an outage is a WARN naming the status and the HOST (never the full URL), repeats are debug, and a
//     success re-arms the warning -- the rule an unreachable backend already followed.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OLLAMA_URL, EMBED_URL, PROJECT_ROOT } from '../config.js'
import { generateEmbedding, embedHostOf } from '../db.js'
import { logger } from '../logger.js'

const LIVE_DEFAULT = 'http://localhost:11434'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('(1) the suite runs against the seam, not the live default', () => {
  it('both keys are the seam the setup file set', () => {
    expect(process.env.MARVEEN_TEST_OLLAMA_URL).toBeTruthy()
    expect(OLLAMA_URL).toBe(process.env.MARVEEN_TEST_OLLAMA_URL)
    expect(EMBED_URL).toBe(process.env.MARVEEN_TEST_OLLAMA_URL)
    expect(OLLAMA_URL).not.toBe(LIVE_DEFAULT)
  })

  it('an embedding call goes to the seam address', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ embedding: [1, 2, 3] }) }))
    vi.stubGlobal('fetch', fetchMock)
    await generateEmbedding('teszt')
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe(`${process.env.MARVEEN_TEST_OLLAMA_URL}/api/embeddings`)
  })

  // The runner that measures the fleet's suite (a stand-in Ollama) writes the SAME address into .env and into the
  // seam, so "both keys are the seam" cannot tell a working seam from a missing one under it. These two cases use
  // addresses that differ on purpose: the seam must beat a .env that names another one.
  it('the seam wins over .env for both keys, and without it .env is read as before', async () => {
    const envDir = mkdtempSync(join(tmpdir(), 'ollama-seam-'))
    try {
      writeFileSync(join(envDir, '.env'), 'OLLAMA_URL=http://127.0.0.1:7\nEMBED_URL=http://127.0.0.1:8\n')
      vi.stubEnv('CLAUDECLAW_ENV_DIR', envDir)
      vi.stubEnv('MARVEEN_TEST_OLLAMA_URL', 'http://127.0.0.1:9')
      vi.resetModules()
      const seamed = await import('../config.js')
      expect([seamed.OLLAMA_URL, seamed.EMBED_URL]).toEqual(['http://127.0.0.1:9', 'http://127.0.0.1:9'])
      vi.stubEnv('MARVEEN_TEST_OLLAMA_URL', '')
      vi.resetModules()
      const plain = await import('../config.js')
      expect([plain.OLLAMA_URL, plain.EMBED_URL]).toEqual(['http://127.0.0.1:7', 'http://127.0.0.1:8'])
    } finally {
      vi.resetModules()
      rmSync(envDir, { recursive: true, force: true })
    }
  })

  it('the setup file sets the dead address when none is given, and keeps a given one', async () => {
    const before = process.env.MARVEEN_TEST_OLLAMA_URL
    try {
      delete process.env.MARVEEN_TEST_OLLAMA_URL
      vi.resetModules()
      await import('./setup/ollama-test-url-seam.js')
      expect(process.env.MARVEEN_TEST_OLLAMA_URL).toBe('http://127.0.0.1:9')
      process.env.MARVEEN_TEST_OLLAMA_URL = 'http://127.0.0.1:19999'
      vi.resetModules()
      await import('./setup/ollama-test-url-seam.js')
      expect(process.env.MARVEEN_TEST_OLLAMA_URL).toBe('http://127.0.0.1:19999')
    } finally {
      if (before === undefined) delete process.env.MARVEEN_TEST_OLLAMA_URL
      else process.env.MARVEEN_TEST_OLLAMA_URL = before
      vi.resetModules()
    }
  })

  it('NEGATIVE CONTROL: with the seam emptied and no .env, config falls back to the live default', async () => {
    // A store/config-overrides.json in the checkout would win over the default; a clean worktree has none.
    if (existsSync(join(PROJECT_ROOT, 'store', 'config-overrides.json'))) return
    const envDir = mkdtempSync(join(tmpdir(), 'ollama-seam-'))
    try {
      vi.stubEnv('MARVEEN_TEST_OLLAMA_URL', '')
      vi.stubEnv('CLAUDECLAW_ENV_DIR', envDir)
      vi.resetModules()
      const fresh = await import('../config.js')
      expect(fresh.OLLAMA_URL).toBe(LIVE_DEFAULT)
      expect(fresh.EMBED_URL).toBe(LIVE_DEFAULT)
    } finally {
      vi.resetModules()
      rmSync(envDir, { recursive: true, force: true })
    }
  })
})

describe('(2) an HTTP error from the embedding backend is logged, once loud', () => {
  const answer = (status: number) => vi.fn(async () => (status === 200
    ? { ok: true, status, json: async () => ({ embedding: [0.1, 0.2] }) }
    : { ok: false, status, json: async () => ({ error: 'busy' }) }))

  it('first failure WARN with status and host, repeat at debug, a success re-arms', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const debug = vi.spyOn(logger, 'debug')
    vi.stubGlobal('fetch', answer(200))
    expect(await generateEmbedding('re-arm')).toEqual([0.1, 0.2]) // a success re-arms the warning
    vi.stubGlobal('fetch', answer(503))
    expect(await generateEmbedding('one')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    const [fields, msg] = warn.mock.calls[0] as unknown as [Record<string, unknown>, string]
    expect(fields).toMatchObject({ status: 503, embedHost: embedHostOf(EMBED_URL) })
    expect(String(msg)).toContain('HTTP 503')
    expect(JSON.stringify(fields)).not.toContain('://') // the host only, never the full URL
    expect(await generateEmbedding('two')).toBeNull()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(debug.mock.calls.some(([f]) => (f as Record<string, unknown>)?.status === 503)).toBe(true)
    vi.stubGlobal('fetch', answer(200))
    await generateEmbedding('back')
    vi.stubGlobal('fetch', answer(500))
    await generateEmbedding('again')
    expect(warn).toHaveBeenCalledTimes(2)
  })

  it('embedHostOf keeps the host and port only', () => {
    expect(embedHostOf('http://user:secret@127.0.0.1:9/x?y=1')).toBe('127.0.0.1:9')
    expect(embedHostOf('not a url')).toBe('unparseable')
  })
})
