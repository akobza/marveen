import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { STORE_DIR } from '../config.js'
import { logger } from '../logger.js'

/**
 * Read-only status rows on the Agents page for agents that are NOT fleet members (card 28c4a739): they run as their
 * own Linux user in their own sandbox, they do not hold the dashboard token and must not. The install lists them in
 * store/external-status-agents.json; each entry names a status file that a job on the host refreshes. The dashboard
 * only READS that file: no control, no message queue, no restart.
 *
 * A missing or broken status file is "not readable", never an error page, and a file whose updated_at is older than
 * the entry's staleAfterSeconds is "stale": an old file must not look like a live state. The config lives in the
 * install's store (not in the code), so an install-specific name or path never lands in the public repository.
 */

export const EXTERNAL_STATUS_CONFIG_FILENAME = 'external-status-agents.json'
export const DEFAULT_STALE_AFTER_SECONDS = 120
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const MAX_LABEL = 80
const MAX_ERRORS = 10
const MAX_ERROR_LEN = 200

export interface ExternalStatusAgentConfig {
  id: string
  label: string
  statusFile: string
  staleAfterSeconds: number
}

export interface ExternalAgentStatus {
  id: string
  label: string
  /** false: the status file is missing, unreadable or not the expected shape. */
  readable: boolean
  state: 'running' | 'stopped' | 'unknown'
  activeState: string | null
  subState: string | null
  activeSince: string | null
  lastActivity: string | null
  lastReport: string | null
  updatedAt: string | null
  ageSeconds: number | null
  /** true when updated_at is missing or older than staleAfterSeconds. */
  stale: boolean
  /** The sources the status job could not read, by name (never a silent null). */
  errors: string[]
}

/** The entries that are well formed; a bad entry is dropped with a warning, it never hides the others. */
export function parseExternalStatusConfig(raw: unknown): ExternalStatusAgentConfig[] {
  const list = raw && typeof raw === 'object' ? (raw as { agents?: unknown }).agents : undefined
  if (!Array.isArray(list)) return []
  const out: ExternalStatusAgentConfig[] = []
  const seen = new Set<string>()
  for (const entry of list) {
    const e = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {}
    const id = typeof e.id === 'string' ? e.id : ''
    const label = typeof e.label === 'string' && e.label.trim() ? e.label.trim().slice(0, MAX_LABEL) : id
    const statusFile = typeof e.statusFile === 'string' ? e.statusFile : ''
    const stale = typeof e.staleAfterSeconds === 'number' && Number.isFinite(e.staleAfterSeconds) && e.staleAfterSeconds > 0
      ? Math.floor(e.staleAfterSeconds)
      : DEFAULT_STALE_AFTER_SECONDS
    if (!ID_RE.test(id) || seen.has(id) || !isAbsolute(statusFile)) {
      logger.warn({ id }, 'external-status-agents: entry dropped (needs a slug id, unique, and an absolute statusFile)')
      continue
    }
    seen.add(id)
    out.push({ id, label, statusFile, staleAfterSeconds: stale })
  }
  return out
}

/** The configured entries; an absent file is no external agent, a broken one is a warning and no external agent. */
export function loadExternalStatusConfig(storeDir: string = STORE_DIR): ExternalStatusAgentConfig[] {
  let text: string
  try {
    text = readFileSync(join(storeDir, EXTERNAL_STATUS_CONFIG_FILENAME), 'utf-8')
  } catch {
    return []
  }
  try {
    return parseExternalStatusConfig(JSON.parse(text))
  } catch {
    logger.warn('external-status-agents: the config file is not valid JSON; no external agent is shown')
    return []
  }
}

function isoOrNull(v: unknown): string | null {
  return typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null
}

function textOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null
}

/** One entry's status from its file. Never throws: every failure is a field of the result. */
export function readExternalAgentStatus(
  cfg: ExternalStatusAgentConfig,
  nowMs: number = Date.now(),
  read: (path: string) => string = (p) => readFileSync(p, 'utf-8'),
): ExternalAgentStatus {
  const base: ExternalAgentStatus = {
    id: cfg.id, label: cfg.label, readable: false, state: 'unknown',
    activeState: null, subState: null, activeSince: null, lastActivity: null, lastReport: null,
    updatedAt: null, ageSeconds: null, stale: true, errors: [],
  }
  let doc: Record<string, unknown>
  try {
    const parsed = JSON.parse(read(cfg.statusFile)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base
    doc = parsed as Record<string, unknown>
  } catch {
    return base
  }
  const activeState = textOrNull(doc.active_state)
  if (activeState === null) return base
  const updatedAt = isoOrNull(doc.updated_at)
  const ageSeconds = updatedAt === null ? null : Math.max(0, Math.round((nowMs - Date.parse(updatedAt)) / 1000))
  const errors = Array.isArray(doc.errors)
    ? doc.errors.filter((x): x is string => typeof x === 'string').slice(0, MAX_ERRORS).map((x) => x.slice(0, MAX_ERROR_LEN))
    : []
  return {
    ...base,
    readable: true,
    state: activeState === 'active' ? 'running' : ['inactive', 'failed', 'deactivating'].includes(activeState) ? 'stopped' : 'unknown',
    activeState,
    subState: textOrNull(doc.sub_state),
    activeSince: isoOrNull(doc.active_since),
    lastActivity: isoOrNull(doc.last_activity),
    lastReport: isoOrNull(doc.last_report),
    updatedAt,
    ageSeconds,
    stale: ageSeconds === null || ageSeconds > cfg.staleAfterSeconds,
    errors,
  }
}

export function externalAgentStatuses(nowMs: number = Date.now()): ExternalAgentStatus[] {
  return loadExternalStatusConfig().map((cfg) => readExternalAgentStatus(cfg, nowMs))
}
