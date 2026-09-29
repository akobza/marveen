import { join } from 'node:path'
import { APP_TZ, MAIN_AGENT_ID, OWNER_RULES_VIEW_PATH, PROJECT_ROOT, STORE_DIR, ownerRulesWriteTokenSha256 } from '../../config.js'
import { createAgentMessage, getDb } from '../../db.js'
import { logger } from '../../logger.js'
import {
  OWNER_RULES_TOKEN_HEADER,
  auditOwnerRules,
  checkOwnerRulesWriteToken,
  createOwnerRule,
  generatedViewHeaderLine,
  importLineInput,
  importRoundTrip,
  listOwnerRuleEvents,
  listOwnerRules,
  ownerRuleHomoglyphWarning,
  ownerRuleToComplete,
  parseOwnerRulesMarkdown,
  renderOwnerRulesView,
  resolveViewPath,
  revokeOwnerRule,
  validateOwner,
  validateOwnerRuleInput,
  writeOwnerRulesView,
  type OwnerRuleInput,
  type OwnerRuleRow,
  type ViewWriteResult,
} from '../../owner-rules.js'
import { json, readBody } from '../http-helpers.js'
import type { RouteContext } from './types.js'

// Owner rules (src/owner-rules.ts): the only write path to owner_rules. A rule write (create, revoke, import) needs the
// owner-rules write token on top of the dashboard token, and it writes as the actor that token is bound to, the main
// agent. Every write leaves an event and regenerates the view file the main agent's CLAUDE.md imports. Reading and
// regenerating the view stay on the dashboard token: neither changes a rule.

const WRITE_AUTH_KIND = 'owner-rules-token'
// A view file changed by hand is copied here before it is overwritten; the copy's path goes into the alert.
const VIEW_BACKUP_DIR = join(STORE_DIR, 'owner-rules-view-backups')

function todayInAppTz(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

function regenerateView(): ViewWriteResult | { error: string } {
  try {
    return writeOwnerRulesView({
      path: resolveViewPath(OWNER_RULES_VIEW_PATH, PROJECT_ROOT),
      today: todayInAppTz(),
      backupDir: VIEW_BACKUP_DIR,
      alert: (message) => {
        logger.warn({ message }, 'owner rules alert')
        createAgentMessage('system', MAIN_AGENT_ID, message)
      },
    })
  } catch (err) {
    // The rule is already committed; a failed file write must not turn the API write into an error, but it is reported.
    logger.error({ err }, 'owner rules view could not be written')
    return { error: err instanceof Error ? err.message : String(err) }
  }
}

async function readJson(ctx: RouteContext): Promise<Record<string, unknown> | null> {
  const raw = (await readBody(ctx.req)).toString('utf8')
  return raw.trim() ? JSON.parse(raw) : {}
}

/** The write token, checked before the body is even read. Replies and returns false when refused. */
function writeTokenOrRefuse(ctx: RouteContext): boolean {
  const gate = checkOwnerRulesWriteToken(ctx.req.headers[OWNER_RULES_TOKEN_HEADER], ownerRulesWriteTokenSha256())
  if (gate.ok) return true
  json(ctx.res, { error: gate.error }, gate.status)
  return false
}

/** The actor is the token's, not the body's: a body naming anyone else is refused. Replies and returns null then. */
function actorOrRefuse(ctx: RouteContext, body: Record<string, unknown> | null): string | null {
  const claimed = typeof body?.actor === 'string' ? body.actor.trim() : body?.actor
  if (claimed === undefined || claimed === null || claimed === '' || claimed === MAIN_AGENT_ID) return MAIN_AGENT_ID
  json(ctx.res, { error: `the owner-rules write token writes as ${MAIN_AGENT_ID}; the body names another actor` }, 403)
  return null
}

function withAudit(rows: OwnerRuleRow[]) {
  return auditOwnerRules(rows, listOwnerRuleEvents()).map(({ row, audit }) => ({
    ...row,
    audited: audit.anomaly === null,
    audit_problem: audit.anomaly?.kind ?? null,
    to_complete: ownerRuleToComplete(row),
  }))
}

export async function tryHandleOwnerRules(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx
  if (path !== '/api/owner-rules' && !path.startsWith('/api/owner-rules/')) return false

  if (path === '/api/owner-rules') {
    if (method === 'GET') {
      const owner = url.searchParams.get('owner') || undefined
      const includeRevoked = url.searchParams.get('include_revoked') === '1'
      const includeNotes = url.searchParams.get('include_notes') === '1'
      json(res, { rules: withAudit(listOwnerRules({ owner, includeRevoked, includeNotes })) })
      return true
    }
    if (method === 'POST') {
      if (!writeTokenOrRefuse(ctx)) return true
      const body = await readJson(ctx)
      const actor = actorOrRefuse(ctx, body)
      if (!actor) return true
      const input = validateOwnerRuleInput(body)
      if (!input.ok) { json(res, { error: input.error }, 400); return true }
      const row = createOwnerRule(input.value, actor, WRITE_AUTH_KIND)
      const warning = ownerRuleHomoglyphWarning(input.value)
      json(res, { ok: true, id: row.id, ...(warning ? { homoglyph_warning: warning } : {}), view: regenerateView() })
      return true
    }
    json(res, { error: 'Method not allowed' }, 405)
    return true
  }

  const revokeMatch = path.match(/^\/api\/owner-rules\/(\d+)\/revoke$/)
  if (revokeMatch) {
    if (method !== 'POST') { json(res, { error: 'Method not allowed' }, 405); return true }
    if (!writeTokenOrRefuse(ctx)) return true
    const body = await readJson(ctx)
    const actor = actorOrRefuse(ctx, body)
    if (!actor) return true
    const source = typeof body?.source === 'string' ? body.source.trim() : ''
    if (!source || source.length > 300 || /[\r\n]/.test(source)) {
      json(res, { error: 'source is required: where the revocation comes from (a message or card id, one line)' }, 400)
      return true
    }
    const result = revokeOwnerRule(Number(revokeMatch[1]), source, actor, WRITE_AUTH_KIND)
    if (!result.ok) { json(res, { error: result.error }, result.status); return true }
    json(res, { ok: true, id: result.row.id, view: regenerateView() })
    return true
  }

  if (path === '/api/owner-rules/view') {
    if (method !== 'POST') { json(res, { error: 'Method not allowed' }, 405); return true }
    json(res, { ok: true, view: regenerateView() })
    return true
  }

  if (path === '/api/owner-rules/import') {
    if (method !== 'POST') { json(res, { error: 'Method not allowed' }, 405); return true }
    if (!writeTokenOrRefuse(ctx)) return true
    const body = await readJson(ctx)
    const actor = actorOrRefuse(ctx, body)
    if (!actor) return true
    const markdown = typeof body?.markdown === 'string' ? body.markdown : ''
    if (!markdown.trim()) { json(res, { error: 'markdown is required: the hand-written rules file' }, 400); return true }
    const owner = validateOwner(body ?? {})
    if (!owner.ok) { json(res, { error: owner.error }, 400); return true }
    const dryRun = body?.dry_run !== false

    const parsed = parseOwnerRulesMarkdown(markdown)
    const ruleCount = parsed.filter((p) => p.kind === 'rule').length
    const problems: Array<{ line: number | null; problem: string }> = []
    const headerLine = generatedViewHeaderLine(markdown)
    if (headerLine !== null) problems.push({ line: headerLine, problem: 'the file is a generated owner-rules view (it carries the generator header): import the hand-written original' })
    if (ruleCount === 0) problems.push({ line: null, problem: 'no rule lines: the file has no "- " bullet' })
    const inputs: OwnerRuleInput[] = []
    const rejected: Array<{ line: number; problem: string }> = []
    for (const p of parsed) {
      const r = importLineInput(p, owner.value)
      if (r.ok) inputs.push(r.value)
      else rejected.push({ line: p.line, problem: r.error })
    }
    problems.push(...rejected)
    // The round trip, before any write: the view these rows would render against the file. A rejected line is missing
    // from it by definition, so the round trip only adds a problem of its own when every line was accepted.
    const wouldRender = inputs.map((r, i) => ({ ...r, id: i + 1, revoked_at: null, revoked_source: null, revoked_by: null, created_by: actor, created_at: 0 }))
    const roundTrip = importRoundTrip(markdown, renderOwnerRulesView(wouldRender, { name: 'import-check', generatedAt: 'dry-run' }))
    if (rejected.length === 0) {
      if (!roundTrip.bullets_in_order) problems.push({ line: null, problem: "the generated view would not list the file's bullets in the same order" })
      for (const line of roundTrip.missing_lines) problems.push({ line, problem: 'the generated view would not carry this line' })
    }
    const toComplete = parsed
      .filter((p) => p.kind === 'rule')
      .map((p) => ({ line: p.line, missing: ownerRuleToComplete(p) }))
      .filter((t) => t.missing.length > 0)
    const report = { rules: ruleCount, non_bullet_lines: parsed.length - ruleCount, problems, to_complete: toComplete, round_trip: roundTrip }
    if (dryRun) { json(res, { ok: problems.length === 0, dry_run: true, ...report }); return true }
    if (problems.length) {
      const more = problems.length > 1 ? ` (and ${problems.length - 1} more problem(s), listed)` : ''
      json(res, { error: `import refused, nothing was written: ${problems[0].problem}${more}`, ...report }, 400)
      return true
    }
    if (listOwnerRules({ owner: owner.value.owner_chat_id, includeRevoked: true, includeNotes: true }).length > 0 && body?.force !== true) {
      json(res, { error: 'this owner already has rules: an import would duplicate them (pass force: true to import anyway)' }, 409)
      return true
    }
    // One transaction: an import is all or nothing, a failure half-way leaves no partial rule set behind.
    const ids = getDb().transaction(() => inputs.map((r) => createOwnerRule(r, actor, WRITE_AUTH_KIND).id))()
    json(res, { ok: true, dry_run: false, imported: ruleCount, imported_text_lines: inputs.length - ruleCount, ids, ...report, view: regenerateView() })
    return true
  }

  json(res, { error: 'Not found' }, 404)
  return true
}
