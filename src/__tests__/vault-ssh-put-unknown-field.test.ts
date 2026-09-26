// PUT /api/vault/ssh-servers/:id answered 200 when the body carried a field it
// does not know, and dropped that field without a word. A caller who wrote
// `hostname` for `host`, or the column names `username` / `description` for
// the API's `user` / `desc`, read "accepted" while the stored value stayed the
// old one. Same class as the kanban PUT before #1023: not an error, not an
// empty answer -- a plausible one.
//
// Pinned here, with the #1023 form (400 naming the fields, nothing written):
//  - an unknown field is refused with 400, the answer names it and the
//    accepted set, and the known fields sent WITH it are not applied either --
//    a half-applied write is the thing being removed;
//  - POSITIVE CONTROL: the known fields still go through, read back from the
//    store, and the 200 body keeps its shape;
//  - a server that does not exist is still a 404.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RouteContext } from '../web/routes/types.js'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vault-ssh-put-unknown-'))
mkdirSync(join(tmpRoot, 'store'), { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot, STORE_DIR: join(tmpRoot, 'store') }
})

const { initDatabase, getVaultSshServer, createVaultSshServer } = await import('../db.js')
const { tryHandleVaultSsh } = await import('../web/routes/vault-ssh.js')

const ID = 'teszt-szerver'

async function put(id: string, body: unknown): Promise<{ status: number; body: any }> {
  const out = { status: 0, raw: '' }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(data?: string) { if (data !== undefined) out.raw += data },
  }
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as http.IncomingMessage
  const path = `/api/vault/ssh-servers/${encodeURIComponent(id)}`
  const ctx: RouteContext = {
    req, res: res as http.ServerResponse, path, method: 'PUT', url: new URL(`http://127.0.0.1:3420${path}`),
  }
  expect(await tryHandleVaultSsh(ctx)).toBe(true)
  return { status: out.status, body: JSON.parse(out.raw || '{}') }
}

describe('PUT /api/vault/ssh-servers/:id refuses a field it does not know', () => {
  beforeEach(() => {
    initDatabase(':memory:')
    createVaultSshServer({ id: ID, name: 'Regi nev', host: 'regi-gep.example', port: 22, username: 'regi', description: null })
  })

  it('400 for an unknown field, naming it and the accepted set', async () => {
    const r = await put(ID, { hostname: 'uj-gep.example' })
    expect(r.status).toBe(400)
    expect(r.body.unknown).toEqual(['hostname'])
    expect(r.body.accepted).toEqual(['name', 'host', 'user', 'port', 'desc', 'sshKeyId'])
    expect(r.body.error).toContain('hostname')
    expect(getVaultSshServer(ID)!.host).toBe('regi-gep.example')
  })

  it('the known fields sent together with an unknown one are not applied either', async () => {
    const r = await put(ID, { host: 'uj-gep.example', port: 2222, description: 'uj leiras' })
    expect(r.status).toBe(400)
    expect(r.body.unknown).toEqual(['description'])
    const s = getVaultSshServer(ID)!
    expect([s.host, s.port, s.description]).toEqual(['regi-gep.example', 22, null])
  })

  it('the column names a caller plausibly sends are unknown to this API, each named', async () => {
    for (const field of ['username', 'description', 'ssh_key_id', 'hostname']) {
      const r = await put(ID, { [field]: 'x' })
      expect(r.status, field).toBe(400)
      expect(r.body.unknown, field).toEqual([field])
    }
    expect(getVaultSshServer(ID)!.username).toBe('regi')
  })

  it('POZITÍV KONTROLL: the known fields go through and read back, the 200 body keeps its shape', async () => {
    const r = await put(ID, { name: 'Uj nev', host: 'uj-gep.example', user: 'deploy', port: 2222, desc: 'uj leiras', sshKeyId: null })
    expect(r.status).toBe(200)
    expect(r.body.server).toMatchObject({ id: ID, name: 'Uj nev', host: 'uj-gep.example', user: 'deploy', port: 2222, desc: 'uj leiras', sshKeyId: null })
    const s = getVaultSshServer(ID)!
    expect([s.name, s.host, s.username, s.port, s.description, s.ssh_key_id])
      .toEqual(['Uj nev', 'uj-gep.example', 'deploy', 2222, 'uj leiras', null])
  })

  it('POZITÍV KONTROLL: the two bodies the dashboard sends still pass', async () => {
    expect((await put(ID, { sshKeyId: null })).status).toBe(200)
    // The edit form: every field, sshKeyId left out when no key is picked.
    const r = await put(ID, { name: 'Urlap', host: 'urlap-gep.example', user: 'root', port: 22, desc: '' })
    expect(r.status).toBe(200)
    expect(getVaultSshServer(ID)!.name).toBe('Urlap')
  })

  it('a server that does not exist is still a 404', async () => {
    const r = await put('nincs-ilyen', { hostname: 'x' })
    expect(r.status).toBe(404)
  })
})
