// Card 28c4a739: the Agents page shows the non-fleet agents of store/external-status-agents.json with their STATUS
// ONLY. String contract on the frontend files (the house idiom of federation-ui-contract.test.ts): the fetch cannot
// blank the page, the cards stay out of the fleet's activity poll, they carry no control, nothing from the status
// file reaches an attribute or a class name, and every label exists in both languages.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const APP = readFileSync(join(__dirname, '../../web/app.js'), 'utf-8')
const HU = readFileSync(join(__dirname, '../../web/lang/hu.js'), 'utf-8')
const EN = readFileSync(join(__dirname, '../../web/lang/en.js'), 'utf-8')
const CSS = readFileSync(join(__dirname, '../../web/style.css'), 'utf-8')

function fnBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`)
  expect(start, `${name} is missing`).toBeGreaterThan(-1)
  const end = src.indexOf('\n}\n', start)
  return src.slice(start, end + 2)
}

describe('external status agents on the Agents page', () => {
  it('the fetch is failure-proof (an older backend 404s, a transient error must not blank the page)', () => {
    expect(APP).toContain("fetch('/api/external-agents').then((r) => (r.ok ? r.json() : null)).catch(() => null)")
    expect(APP).toMatch(/externalStatusAgents = extStatus && Array\.isArray\(extStatus\.agents\) \? extStatus\.agents : \[\]/)
  })

  it('the cards render after the federated ones, in their own store, out of the fleet activity poll', () => {
    expect(APP).toMatch(/renderFederatedAgentCards\(agentsGrid, addBtn\)\n\s+renderExternalStatusCards\(agentsGrid, addBtn\)/)
    expect(APP).toContain('let externalStatusAgents = []')
    expect(APP).toContain(".agent-card:not(.add-card):not(.federated-agent-card):not(.external-status-card)")
  })

  it('⛔ status only: no button, no click handler, no message thread in the renderer', () => {
    const body = fnBody(APP, 'renderExternalStatusCards')
    expect(body).not.toMatch(/<button/)
    expect(body).not.toMatch(/addEventListener/)
    expect(body).not.toMatch(/openFederatedThread|chatSelectedAgent/)
  })

  it('⛔ nothing from the status file reaches an attribute or a class name; text goes through escapeHtml', () => {
    const body = fnBody(APP, 'renderExternalStatusCards')
    // every interpolation inside an attribute value is one of the two fixed-set locals
    const inAttr = [...body.matchAll(/="[^"]*\$\{([^}]+)\}[^"]*"/g)].map((m) => m[1].trim())
    expect(inAttr).toEqual(['dot'])
    expect(body).toMatch(/const dot = state === 'running' && !ea\.stale \? 'connected' : 'disconnected'/)
    expect(body).toContain('${escapeHtml(label)}')
    expect(body).toContain("escapeHtml(t('external.errors', { list: ea.errors.join('; ') }))")
  })

  it('every label exists in both languages, and the badge has its style', () => {
    for (const key of ['external.badge', 'external.since', 'external.last_activity', 'external.stale', 'external.errors',
      'external.unreadable', 'external.state.running', 'external.state.stopped', 'external.state.unknown', 'external.state.unreadable']) {
      expect(HU, `hu: ${key}`).toContain(`'${key}':`)
      expect(EN, `en: ${key}`).toContain(`'${key}':`)
    }
    expect(CSS).toContain('.external-status-badge {')
  })
})
