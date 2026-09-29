/**
 * Owner rules: one source for the owners' standing rules and decisions.
 *
 * An owner states a rule once ("from now on do X"), and every later session has to know it. Kept by hand in a Markdown
 * memory file, a rule has no owner, no source and no history: nobody can tell who wrote a line, which message it came
 * from, or whether it still holds, and a revoked rule simply disappears. Here each rule is a row in owner_rules (owner,
 * text, source, date, validity, revocation and its source) and every write leaves an event in owner_rule_events, an
 * append-only log (both tables are created in initDatabase). Writes go through the dashboard API only, with a write token
 * of their own; the Markdown file that an instance imports into its CLAUDE.md becomes a VIEW generated from the table and
 * is never edited by hand.
 *
 * "Writes only through the API" cannot be enforced on a SQLite file every agent can open, so it is measured instead: each
 * event carries a hash of the row as the API wrote it, and the view only shows a rule whose current content matches an
 * event. A row written or changed around the API is left out of the view and reported, and so is a hand edit of the view
 * file itself (the file carries the hash of its whole text); the hand-edited file is copied aside before it is replaced.
 *
 * The first load of the table is an import of the hand-written file, line by line and verbatim: a bullet is a rule (its
 * trailing parenthesized group is the source, the date in it the decision date, and what a line lacks stays NULL, "to
 * complete"), a line of text around the bullets is kept as an intro, note or outro row, so the generated view carries
 * every line the file had.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { getDb } from './db.js'
import { detectHomoglyphs, formatHomoglyphWarning } from './homoglyph.js'

/**
 * A row is a rule (a "- " bullet in the view), or a line of text an imported file carried around its rules: before the
 * first bullet (intro), between bullets (note) or after the last one (outro).
 */
export type OwnerRuleKind = 'rule' | 'intro' | 'note' | 'outro'

export interface OwnerRuleRow {
  id: number
  owner_chat_id: string
  owner_label: string | null
  kind: OwnerRuleKind
  rule: string
  source: string | null
  decided_on: string | null
  /** The line as it stood in the imported file: the view shows it as is. Null for a row written through the API. */
  verbatim_line: string | null
  valid_from: string | null
  valid_until: string | null
  revoked_at: number | null
  revoked_source: string | null
  revoked_by: string | null
  created_by: string
  created_at: number
}

export interface OwnerRuleEventRow {
  id: number
  rule_id: number
  event_type: 'create' | 'revoke'
  actor: string
  auth_kind: string | null
  payload_hash: string
  created_at: number
}

export interface OwnerRuleInput {
  owner_chat_id: string
  owner_label: string | null
  kind: OwnerRuleKind
  rule: string
  source: string | null
  decided_on: string | null
  verbatim_line: string | null
  valid_from: string | null
  valid_until: string | null
}

type Result<T> = { ok: true; value: T } | { ok: false; error: string }

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/
const OWNER_RE = /^[A-Za-z0-9_.:-]{1,64}$/
// What names a message or a card: "tg 101", "#107", or an 8-hex card id.
const REFERENCE_RE = /\btg\s*\d+|#\d+|\b[0-9a-f]{8}\b/i

/** A real calendar day: Date would roll 2026-02-30 over to March, so the parts are compared back. */
export function isCalendarDate(value: string): boolean {
  const m = DATE_RE.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const dt = new Date(Date.UTC(y, mo - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d
}

function oneLine(value: unknown, field: string, max: number, required: boolean): Result<string | null> {
  if (value === undefined || value === null || value === '') {
    return required ? { ok: false, error: `${field} is required` } : { ok: true, value: null }
  }
  if (typeof value !== 'string') return { ok: false, error: `${field} must be a string` }
  const text = value.trim()
  if (!text) return required ? { ok: false, error: `${field} is required` } : { ok: true, value: null }
  if (text.length > max) return { ok: false, error: `${field} is at most ${max} characters` }
  // The view renders one rule per bullet: a line break would split a rule and break the list.
  if (/[\r\n]/.test(text)) return { ok: false, error: `${field} must be a single line` }
  return { ok: true, value: text }
}

function optionalDate(value: unknown, field: string): Result<string | null> {
  if (value === undefined || value === null || value === '') return { ok: true, value: null }
  if (typeof value !== 'string' || !isCalendarDate(value.trim())) return { ok: false, error: `${field} must be a calendar date YYYY-MM-DD` }
  return { ok: true, value: value.trim() }
}

export function validateOwner(body: Record<string, unknown>): Result<{ owner_chat_id: string; owner_label: string | null }> {
  const owner = typeof body.owner_chat_id === 'string' || typeof body.owner_chat_id === 'number' ? String(body.owner_chat_id).trim() : ''
  if (!OWNER_RE.test(owner)) return { ok: false, error: 'owner_chat_id is required (1-64 characters: letters, digits, _ . : -)' }
  const label = oneLine(body.owner_label, 'owner_label', 100, false)
  if (!label.ok) return label
  return { ok: true, value: { owner_chat_id: owner, owner_label: label.value } }
}

/** A rule written through the API: the source and the decision date are required there. */
export function validateOwnerRuleInput(body: unknown): Result<OwnerRuleInput> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'a JSON object is expected' }
  const b = body as Record<string, unknown>
  const owner = validateOwner(b)
  if (!owner.ok) return owner
  const rule = oneLine(b.rule, 'rule', 4000, true)
  if (!rule.ok) return rule
  const source = oneLine(b.source, 'source', 300, true)
  if (!source.ok) return source
  const decided = typeof b.decided_on === 'string' ? b.decided_on.trim() : ''
  if (!isCalendarDate(decided)) return { ok: false, error: 'decided_on must be a calendar date YYYY-MM-DD' }
  const from = optionalDate(b.valid_from, 'valid_from')
  if (!from.ok) return from
  const until = optionalDate(b.valid_until, 'valid_until')
  if (!until.ok) return until
  if (from.value && until.value && from.value > until.value) return { ok: false, error: 'valid_from is after valid_until' }
  return {
    ok: true,
    value: {
      ...owner.value,
      kind: 'rule',
      rule: rule.value as string,
      source: source.value as string,
      decided_on: decided,
      verbatim_line: null,
      valid_from: from.value,
      valid_until: until.value,
    },
  }
}

/** The framework's homoglyph policy: warn, never block (see src/homoglyph.ts). Null when the text is clean. */
export function ownerRuleHomoglyphWarning(input: { rule: string; source: string | null; owner_label: string | null }): string | null {
  const findings = [input.rule, input.source ?? '', input.owner_label ?? ''].flatMap((text) => detectHomoglyphs(text))
  return findings.length ? formatHomoglyphWarning(findings) : null
}

/**
 * What a rule still lacks ("to complete", pótlandó): a source that names a message or a card, and a decision date. An
 * imported line can come without either; the table keeps it with NULL and this marks it until someone completes it.
 */
export function ownerRuleToComplete(r: Pick<OwnerRuleRow, 'kind' | 'source' | 'decided_on'>): Array<'source' | 'decided_on'> {
  if (r.kind !== 'rule') return []
  const missing: Array<'source' | 'decided_on'> = []
  if (!r.source || !REFERENCE_RE.test(r.source)) missing.push('source')
  if (!r.decided_on) missing.push('decided_on')
  return missing
}

// --- The write token --------------------------------------------------------------------------------------------------

export const OWNER_RULES_TOKEN_HEADER = 'x-owner-rules-token'

export type WriteTokenCheck = { ok: true } | { ok: false; status: 403 | 503; error: string }

/**
 * The gate in front of every rule write (create, revoke, import). The dashboard token every agent holds is not enough:
 * the write needs a token of its own, which only the main agent holds, in the x-owner-rules-token header. Only the
 * token's sha256 is configured; without it (or with anything that is not a sha256 hex digest) every write is refused.
 * The comparison runs on the two digests, in constant time.
 */
export function checkOwnerRulesWriteToken(provided: string | string[] | undefined, configuredSha256: string): WriteTokenCheck {
  const wanted = configuredSha256.trim().toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(wanted)) {
    return { ok: false, status: 503, error: 'owner rule writes are disabled: OWNER_RULES_WRITE_TOKEN_SHA256 is not set to a sha256 hex digest' }
  }
  const token = typeof provided === 'string' ? provided.trim() : ''
  if (!token) return { ok: false, status: 403, error: `an owner rule write needs the owner-rules write token in the ${OWNER_RULES_TOKEN_HEADER} header` }
  const got = createHash('sha256').update(token, 'utf8').digest()
  if (!timingSafeEqual(got, Buffer.from(wanted, 'hex'))) return { ok: false, status: 403, error: 'the owner-rules write token is not valid' }
  return { ok: true }
}

// --- Rows and events --------------------------------------------------------------------------------------------------

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

type CreateFields = Pick<OwnerRuleRow, 'owner_chat_id' | 'owner_label' | 'kind' | 'rule' | 'source' | 'decided_on' | 'verbatim_line' | 'valid_from' | 'valid_until'>

/** The row as the API created it; an event carrying this hash vouches for the row's content. */
export function ownerRuleCreateHash(r: CreateFields): string {
  return sha256(JSON.stringify([
    'create', r.kind, r.owner_chat_id, r.owner_label ?? null, r.rule, r.source ?? null, r.decided_on ?? null,
    r.verbatim_line ?? null, r.valid_from ?? null, r.valid_until ?? null,
  ]))
}

/** The revocation as the API wrote it. */
export function ownerRuleRevokeHash(r: Pick<OwnerRuleRow, 'id' | 'revoked_at' | 'revoked_source' | 'revoked_by'>): string {
  return sha256(JSON.stringify(['revoke', r.id, r.revoked_at, r.revoked_source, r.revoked_by]))
}

export function getOwnerRule(id: number): OwnerRuleRow | undefined {
  return getDb().prepare('SELECT * FROM owner_rules WHERE id = ?').get(id) as OwnerRuleRow | undefined
}

/** Rules only, unless `includeNotes`: the intro, note and outro lines an import kept are not rules. */
export function listOwnerRules(opts: { owner?: string; includeRevoked?: boolean; includeNotes?: boolean } = {}): OwnerRuleRow[] {
  let sql = 'SELECT * FROM owner_rules WHERE 1=1'
  const params: unknown[] = []
  if (opts.owner) { sql += ' AND owner_chat_id = ?'; params.push(opts.owner) }
  if (!opts.includeRevoked) sql += ' AND revoked_at IS NULL'
  if (!opts.includeNotes) sql += " AND kind = 'rule'"
  sql += ' ORDER BY owner_chat_id, id'
  return getDb().prepare(sql).all(...params) as OwnerRuleRow[]
}

export function listOwnerRuleEvents(ruleId?: number): OwnerRuleEventRow[] {
  return (ruleId === undefined
    ? getDb().prepare('SELECT * FROM owner_rule_events ORDER BY id').all()
    : getDb().prepare('SELECT * FROM owner_rule_events WHERE rule_id = ? ORDER BY id').all(ruleId)) as OwnerRuleEventRow[]
}

/** The rule and its create event in one transaction: a rule without its event cannot be left behind. */
export function createOwnerRule(input: OwnerRuleInput, actor: string, authKind: string | null, now = Math.floor(Date.now() / 1000)): OwnerRuleRow {
  const db = getDb()
  return db.transaction(() => {
    const info = db.prepare(
      `INSERT INTO owner_rules (owner_chat_id, owner_label, kind, rule, source, decided_on, verbatim_line, valid_from, valid_until, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(input.owner_chat_id, input.owner_label, input.kind, input.rule, input.source, input.decided_on, input.verbatim_line, input.valid_from, input.valid_until, actor, now)
    const row = getOwnerRule(Number(info.lastInsertRowid)) as OwnerRuleRow
    db.prepare(
      `INSERT INTO owner_rule_events (rule_id, event_type, actor, auth_kind, payload_hash, created_at) VALUES (?, 'create', ?, ?, ?, ?)`,
    ).run(row.id, actor, authKind, ownerRuleCreateHash(row), now)
    return row
  })()
}

export type RevokeResult = { ok: true; row: OwnerRuleRow } | { ok: false; status: 404 | 409; error: string }

/** A rule is never deleted: the revocation, its source and who wrote it stay in the table, with an event. */
export function revokeOwnerRule(id: number, source: string, actor: string, authKind: string | null, now = Math.floor(Date.now() / 1000)): RevokeResult {
  const db = getDb()
  return db.transaction((): RevokeResult => {
    const before = getOwnerRule(id)
    if (!before) return { ok: false, status: 404, error: 'owner rule not found' }
    if (before.revoked_at !== null) return { ok: false, status: 409, error: 'owner rule is already revoked' }
    const changed = db.prepare(
      'UPDATE owner_rules SET revoked_at = ?, revoked_source = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL',
    ).run(now, source, actor, id).changes
    if (changed === 0) return { ok: false, status: 409, error: 'owner rule is already revoked' }
    const row = getOwnerRule(id) as OwnerRuleRow
    db.prepare(
      `INSERT INTO owner_rule_events (rule_id, event_type, actor, auth_kind, payload_hash, created_at) VALUES (?, 'revoke', ?, ?, ?, ?)`,
    ).run(id, actor, authKind, ownerRuleRevokeHash(row), now)
    return { ok: true, row }
  })()
}

// --- The audit check --------------------------------------------------------------------------------------------------

export type OwnerRuleAnomalyKind = 'unaudited-rule' | 'unaudited-revocation' | 'revocation-undone'

export interface OwnerRuleAnomaly {
  rule_id: number
  kind: OwnerRuleAnomalyKind
  detail: string
}

export interface OwnerRuleAudit {
  /** in-force: the view may show it; revoked: an audited revocation holds; unaudited: no event vouches for the row. */
  state: 'in-force' | 'revoked' | 'unaudited'
  anomaly: OwnerRuleAnomaly | null
}

/**
 * The state of one row as its events vouch for it. The events decide, not the row: a row whose content no create event
 * matches is unaudited; once the API revoked a rule, the rule stays revoked even if its revocation is later cleared or
 * changed around the API (the DB trigger owner_rules_revocation_final refuses that, this catches it if the trigger is
 * gone); a revocation no event vouches for is reported and the rule keeps its last audited state, in force.
 */
export function auditOwnerRule(r: OwnerRuleRow, own: OwnerRuleEventRow[]): OwnerRuleAudit {
  if (!own.some((e) => e.event_type === 'create' && e.payload_hash === ownerRuleCreateHash(r))) {
    return { state: 'unaudited', anomaly: { rule_id: r.id, kind: 'unaudited-rule', detail: 'no create event matches the row: written or changed outside the API' } }
  }
  const revokes = own.filter((e) => e.event_type === 'revoke')
  if (revokes.length) {
    if (r.revoked_at !== null && revokes.some((e) => e.payload_hash === ownerRuleRevokeHash(r))) return { state: 'revoked', anomaly: null }
    return {
      state: 'revoked',
      anomaly: { rule_id: r.id, kind: 'revocation-undone', detail: 'revoked through the API, but the row no longer carries that revocation (undone or changed outside the API): kept out of the view' },
    }
  }
  if (r.revoked_at !== null) {
    return { state: 'in-force', anomaly: { rule_id: r.id, kind: 'unaudited-revocation', detail: 'revoked outside the API: kept in the view as last audited' } }
  }
  return { state: 'in-force', anomaly: null }
}

function eventsByRule(events: OwnerRuleEventRow[]): Map<number, OwnerRuleEventRow[]> {
  const byRule = new Map<number, OwnerRuleEventRow[]>()
  for (const e of events) byRule.set(e.rule_id, [...(byRule.get(e.rule_id) ?? []), e])
  return byRule
}

/** Every row with its audit, for the API's listing. */
export function auditOwnerRules(rows: OwnerRuleRow[], events: OwnerRuleEventRow[]): Array<{ row: OwnerRuleRow; audit: OwnerRuleAudit }> {
  const byRule = eventsByRule(events)
  return rows.map((row) => ({ row, audit: auditOwnerRule(row, byRule.get(row.id) ?? []) }))
}

/**
 * The rows the view shows: audited, in force (see auditOwnerRule) and inside their validity window on `today`
 * (YYYY-MM-DD). Every anomaly is reported, whether or not the row is shown.
 */
export function selectRulesForView(rules: OwnerRuleRow[], events: OwnerRuleEventRow[], today: string): { rules: OwnerRuleRow[]; anomalies: OwnerRuleAnomaly[] } {
  const shown: OwnerRuleRow[] = []
  const anomalies: OwnerRuleAnomaly[] = []
  for (const { row: r, audit } of auditOwnerRules(rules, events)) {
    if (audit.anomaly) anomalies.push(audit.anomaly)
    if (audit.state !== 'in-force') continue
    if (r.valid_from && r.valid_from > today) continue
    if (r.valid_until && r.valid_until < today) continue
    shown.push(r)
  }
  return { rules: shown, anomalies }
}

// --- The view ---------------------------------------------------------------------------------------------------------

/**
 * One line per row. An imported row shows its line as it stood in the file; a rule written through the API is a bullet
 * whose source carries the date unless it already names it.
 */
export function renderOwnerRuleLine(r: Pick<OwnerRuleRow, 'kind' | 'rule' | 'source' | 'decided_on' | 'verbatim_line'>): string {
  if (r.verbatim_line !== null && r.verbatim_line !== undefined) return r.verbatim_line
  if (r.kind !== 'rule') return r.rule
  if (!r.source) return `- ${r.rule}`
  const source = !r.decided_on || r.source.includes(r.decided_on) ? r.source : `${r.source}, ${r.decided_on}`
  return `- ${r.rule} (${source})`
}

const HEADER_PREFIX = '<!-- owner-rules-view:'
const HASH_FIELD_RE = /file-sha256: ([0-9a-f]{64})/
const HASH_PLACEHOLDER = '0'.repeat(64)

/** An owner's rows in reading order: intro lines, then rules and notes as they came, then outro lines. */
function readingOrder(list: OwnerRuleRow[]): OwnerRuleRow[] {
  return [
    ...list.filter((r) => r.kind === 'intro'),
    ...list.filter((r) => r.kind === 'rule' || r.kind === 'note'),
    ...list.filter((r) => r.kind === 'outro'),
  ]
}

export function renderOwnerRulesView(rules: OwnerRuleRow[], opts: { name: string; generatedAt: string }): string {
  const owners = new Map<string, OwnerRuleRow[]>()
  for (const r of rules) owners.set(r.owner_chat_id, [...(owners.get(r.owner_chat_id) ?? []), r])
  const body: string[] = [
    '> GENERÁLT NÉZET: a tulajdonosi állandó szabályok egyetlen forrása a marveen DB owner_rules táblája (írás csak a /api/owner-rules',
    '> végponton, auditálva). Ezt a fájlt kézzel ne szerkeszd: a következő generálás felülírja, és a kézi változtatásról riasztás megy.',
    '',
  ]
  for (const [owner, list] of owners) {
    const label = list.find((r) => r.owner_label)?.owner_label
    body.push(label ? `## ${label} (${owner})` : `## ${owner}`, '')
    // Consecutive rules form one list; a line of text is a paragraph of its own.
    let previousWasRule: boolean | null = null
    for (const r of readingOrder(list)) {
      const isRule = r.kind === 'rule'
      if (previousWasRule !== null && !(previousWasRule && isRule)) body.push('')
      body.push(renderOwnerRuleLine(r))
      previousWasRule = isRule
    }
    body.push('')
  }
  if (owners.size === 0) body.push('_(nincs érvényes szabály)_', '')
  const frontmatter = [
    '---',
    `name: ${opts.name}`,
    'description: "Tulajdonosi állandó szabályok: GENERÁLT NÉZET a marveen DB owner_rules táblájából, kézzel nem szerkeszthető"',
    'metadata:',
    '  type: user',
    '---',
  ].join('\n')
  const header = `${HEADER_PREFIX} generated from the owner_rules table by src/owner-rules.ts at ${opts.generatedAt}; do not edit by hand, the next generation overwrites it and raises an alert. The hash covers the whole file, with this field set to zeros. file-sha256: ${HASH_PLACEHOLDER} -->`
  const draft = `${frontmatter}\n\n${header}\n${body.join('\n')}`
  return draft.replace(`file-sha256: ${HASH_PLACEHOLDER}`, `file-sha256: ${sha256(draft)}`)
}

/**
 * Whether a view file is exactly as the generator wrote it. The hash covers every byte of the file (the frontmatter, the
 * header line itself, the body, the line endings), so any hand edit, anywhere, shows: 'edited'. A file without the
 * generator header is 'unmanaged': a hand-written file, the old file put back, or a view whose header was deleted.
 */
export function checkViewFile(text: string): 'intact' | 'edited' | 'unmanaged' {
  const idx = text.indexOf(HEADER_PREFIX)
  if (idx < 0) return 'unmanaged'
  const nl = text.indexOf('\n', idx)
  const end = nl < 0 ? text.length : nl
  const headerLine = text.slice(idx, end)
  const m = HASH_FIELD_RE.exec(headerLine)
  if (!m) return 'edited'
  const asGenerated = text.slice(0, idx) + headerLine.replace(m[0], `file-sha256: ${HASH_PLACEHOLDER}`) + text.slice(end)
  return sha256(asGenerated) === m[1] ? 'intact' : 'edited'
}

export interface ViewWriteResult {
  written: boolean
  path: string | null
  /** The existing file was changed by hand since the last generation (copied aside, overwritten, alerted). */
  manualEdit: boolean
  /** The existing file had no generator header (copied aside, overwritten, alerted). */
  replacedUnmanaged: boolean
  /** Where the file as found was copied before it was overwritten; null when nothing had to be kept. */
  backupPath: string | null
  /** Rules shown (the intro, note and outro lines not counted). */
  shown: number
  anomalies: OwnerRuleAnomaly[]
  error?: string
}

export function resolveViewPath(configured: string, projectRoot: string): string | null {
  const p = configured.trim()
  if (!p) return null
  return isAbsolute(p) ? p : resolve(projectRoot, p)
}

/** A timestamped copy that never overwrites an earlier one. */
function copyAside(path: string, text: string, dir: string, now: Date): string {
  mkdirSync(dir, { recursive: true })
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  for (let n = 1; ; n++) {
    const target = join(dir, `${basename(path)}.before-${stamp}${n > 1 ? `-${n}` : ''}`)
    try {
      writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' })
      return target
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 100) throw err
    }
  }
}

/**
 * Regenerate the view file. A file changed by hand (or without the generator header) is first copied aside under
 * `backupDir` (default: next to the view), and only then overwritten; if the copy fails, the file is left alone. `alert`
 * is called with a readable message for a hand edit, a failed copy or unaudited rows; the caller decides where it goes
 * (the dashboard sends it to the main agent as a system message).
 */
export function writeOwnerRulesView(opts: {
  path: string | null
  today: string
  now?: Date
  backupDir?: string
  alert?: (message: string) => void
}): ViewWriteResult {
  const all = listOwnerRules({ includeRevoked: true, includeNotes: true })
  const { rules, anomalies } = selectRulesForView(all, listOwnerRuleEvents(), opts.today)
  const result: ViewWriteResult = {
    written: false, path: opts.path, manualEdit: false, replacedUnmanaged: false, backupPath: null,
    shown: rules.filter((r) => r.kind === 'rule').length, anomalies,
  }
  if (!opts.path) return result
  const now = opts.now ?? new Date()
  const problems: string[] = []
  if (existsSync(opts.path)) {
    const current = readFileSync(opts.path, 'utf8')
    const state = checkViewFile(current)
    if (state !== 'intact') {
      try {
        result.backupPath = copyAside(opts.path, current, opts.backupDir ?? dirname(opts.path), now)
      } catch (err) {
        result.error = `the view file ${opts.path} was changed by hand and could not be copied aside (${err instanceof Error ? err.message : String(err)}), so it is NOT overwritten`
        opts.alert?.(`[OWNER-RULES] ${result.error}`)
        return result
      }
      if (state === 'edited') {
        result.manualEdit = true
        problems.push(`the view file ${opts.path} was edited by hand since the last generation; the edit is overwritten now, the file as found is saved at ${result.backupPath} (the source is the owner_rules table, write through /api/owner-rules)`)
      } else {
        result.replacedUnmanaged = true
        problems.push(`the view file ${opts.path} had no generator header (a hand-written file, or an old copy put back); it is overwritten now, the file as found is saved at ${result.backupPath}`)
      }
    }
  }
  const name = basename(opts.path).replace(/\.md$/i, '')
  const text = renderOwnerRulesView(rules, { name, generatedAt: now.toISOString() })
  mkdirSync(dirname(opts.path), { recursive: true })
  const tmp = `${opts.path}.tmp-${process.pid}`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, opts.path)
  result.written = true
  if (anomalies.length) problems.push(`${anomalies.length} owner rule row(s) failed the audit check: ${anomalies.map((a) => `#${a.rule_id} ${a.kind}`).join(', ')}`)
  if (problems.length && opts.alert) opts.alert(`[OWNER-RULES] ${problems.join('; ')}`)
  return result
}

// --- Import of a hand-written rules file ------------------------------------------------------------------------------

export interface ParsedRuleLine {
  /** 1-based line number in the file. */
  line: number
  kind: OwnerRuleKind
  /** The line as it stands (a CRLF file's \r removed): the view shows exactly this. */
  raw: string
  /** A rule: the text before its trailing source group (the whole bullet text when it has none); a text line: its text. */
  rule: string
  source: string | null
  decided_on: string | null
}

// The trailing parenthesized group of a bullet, one level of nested parentheses allowed ("(tg 101, 2026-09-01)"), and
// the full stop that may close the sentence after it.
const TRAILING_GROUP_RE = /^(.*?)\s*\(((?:[^()]|\([^()]*\))*)\)\.?\s*$/
const DATE_IN_TEXT_RE = /\b\d{4}-\d{2}-\d{2}\b/g

/** The file's lines after its frontmatter (a view: after its generator header), empty lines left out. */
function contentLines(markdown: string): Array<{ line: number; text: string }> {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  let start = 0
  const header = lines.findIndex((l) => l.startsWith(HEADER_PREFIX))
  if (header >= 0) start = header + 1
  else if (lines[0] === '---') {
    const end = lines.indexOf('---', 1)
    if (end > 0) start = end + 1
  }
  const out: Array<{ line: number; text: string }> = []
  for (let i = start; i < lines.length; i++) if (lines[i].trim()) out.push({ line: i + 1, text: lines[i] })
  return out
}

/**
 * Split a hand-written rules file into rows, every non-empty line after the frontmatter one row, verbatim. A "- " bullet
 * is a rule: its trailing parenthesized group (a closing full stop after it allowed) is the source, and the first
 * calendar date in that group the decision date; a bullet without such a group, or a group without a date, is kept with
 * NULL there ("to complete", see ownerRuleToComplete). Any other line is text: intro before the first bullet, note
 * between bullets, outro after the last.
 */
export function parseOwnerRulesMarkdown(markdown: string): ParsedRuleLine[] {
  const lines = contentLines(markdown)
  const bullets = lines.filter((l) => l.text.startsWith('- '))
  const first = bullets.length ? bullets[0].line : Infinity
  const last = bullets.length ? bullets[bullets.length - 1].line : -Infinity
  return lines.map(({ line, text: raw }): ParsedRuleLine => {
    if (!raw.startsWith('- ')) {
      const kind: OwnerRuleKind = line < first ? 'intro' : line > last ? 'outro' : 'note'
      return { line, kind, raw, rule: raw.trim(), source: null, decided_on: null }
    }
    const text = raw.slice(2).trim()
    const m = TRAILING_GROUP_RE.exec(text)
    if (!m) return { line, kind: 'rule', raw, rule: text, source: null, decided_on: null }
    const group = m[2].trim()
    const date = (group.match(DATE_IN_TEXT_RE) ?? []).find(isCalendarDate) ?? null
    return { line, kind: 'rule', raw, rule: m[1].trim(), source: group || null, decided_on: date }
  })
}

/** A parsed line as the row the import writes; an error when the line cannot be a row. */
export function importLineInput(p: ParsedRuleLine, owner: { owner_chat_id: string; owner_label: string | null }): Result<OwnerRuleInput> {
  if (p.kind === 'rule' && !p.rule) return { ok: false, error: 'empty rule text' }
  if (p.rule.length > 4000) return { ok: false, error: 'the line is longer than 4000 characters' }
  if (p.source && p.source.length > 300) return { ok: false, error: 'the source group is longer than 300 characters' }
  return {
    ok: true,
    value: { ...owner, kind: p.kind, rule: p.rule, source: p.source, decided_on: p.decided_on, verbatim_line: p.raw, valid_from: null, valid_until: null },
  }
}

/** Whether the text is a generated view (it carries the generator header): the line number of the header, or null. */
export function generatedViewHeaderLine(markdown: string): number | null {
  const i = markdown.replace(/\r\n/g, '\n').split('\n').findIndex((l) => l.startsWith(HEADER_PREFIX))
  return i < 0 ? null : i + 1
}

/** The bullets of a file (or of a view) in order. */
export function bulletLines(markdown: string): string[] {
  return contentLines(markdown).map((l) => l.text).filter((l) => l.startsWith('- '))
}

/**
 * The round trip of an import: does the view rendered from the imported rows carry the file? Its bullets must be the
 * file's bullets in the same order, and every non-empty line of the file after the frontmatter must stand in the view.
 */
export function importRoundTrip(markdown: string, view: string): { bullets: number; bullets_in_order: boolean; missing_lines: number[] } {
  const fileBullets = bulletLines(markdown)
  const viewBullets = bulletLines(view)
  const viewLines = new Set(contentLines(view).map((l) => l.text))
  return {
    bullets: fileBullets.length,
    bullets_in_order: fileBullets.length === viewBullets.length && fileBullets.every((l, i) => l === viewBullets[i]),
    missing_lines: contentLines(markdown).filter((l) => !viewLines.has(l.text)).map((l) => l.line),
  }
}
