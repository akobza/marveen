// 1a7b1b66 (2026-10-24): the suite must not reach a live Ollama. The seam is
// src/__tests__/setup/no-live-ollama.ts (a setupFile); this file holds it in place. The refusals are told apart by
// their cause code: a request refused by the seam carries MARVEEN_TEST_NO_LIVE_OLLAMA, one refused by the network
// does not, and one that a live daemon answered does not reject at all -- so with the seam removed, these tests
// are red whether or not an Ollama listens on the host.
import { describe, it, expect } from 'vitest'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'

const CODE = 'MARVEEN_TEST_NO_LIVE_OLLAMA'

async function refusal(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) {
  try {
    const r = await fetch(input, init)
    return { reached: true, status: r.status, code: undefined as string | undefined }
  } catch (e) {
    const cause = (e as { cause?: { code?: string } }).cause
    return { reached: false, status: 0, code: cause?.code, name: (e as Error).name, message: (e as Error).message }
  }
}

describe('no live Ollama in the test suite (1a7b1b66)', () => {
  it('refuses the embedding call the default config would make, on every loopback spelling', async () => {
    for (const url of [
      'http://localhost:11434/api/embeddings',
      'http://127.0.0.1:11434/api/embeddings',
      'http://[::1]:11434/api/embeddings',
    ]) {
      const r = await refusal(url, { method: 'POST', body: JSON.stringify({ model: 'x', prompt: 'y' }) })
      expect(r.reached, url).toBe(false)
      expect(r.code, url).toBe(CODE)
      expect((r as { name?: string }).name, url).toBe('TypeError')
      expect((r as { message?: string }).message, url).toBe('fetch failed')
    }
  })

  it('refuses any path and any host on the Ollama port, given as a string, a URL or a Request', async () => {
    for (const input of [
      'http://localhost:11434/api/tags',
      new URL('http://ollama.lan:11434/api/generate'),
      new Request('http://127.0.0.1:11434/api/chat', { method: 'POST', body: '{}' }),
    ]) {
      const r = await refusal(input)
      expect(r.reached, String(input instanceof Request ? input.url : input)).toBe(false)
      expect(r.code, String(input instanceof Request ? input.url : input)).toBe(CODE)
    }
  })

  it('CONTROL: any other address still goes to the real fetch', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const { port } = server.address() as AddressInfo
      const r = await fetch(`http://127.0.0.1:${port}/api/embeddings`, { method: 'POST', body: '{}' })
      expect(r.status).toBe(200)
      expect(await r.text()).toBe('ok')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('the seam is registered as a setupFile, so it runs in every worker before any test module', () => {
    const config = readFileSync(join(__dirname, '..', '..', 'vitest.config.ts'), 'utf8')
    const files = config.match(/setupFiles:\s*\[([^\]]*)\]/)?.[1] ?? ''
    expect(files).toContain("'./src/__tests__/setup/no-live-ollama.ts'")
  })
})
