import { type AgentMessagePriority, getQueuePlacement, AGENT_MESSAGE_LIMIT_CAP,
  createAgentMessage, getPendingMessages, listAgentMessages,
  getAgentConversation, getAgentConversationThreads,
  getKanbanSeqByIdPrefix,
  markMessageDone, markMessageFailed, getAgentMessage,
  closeOtelSpan,
  getPendingBacklogByAgent,
  COMPLETION_REPORT_PREFIX,
  type AgentMessage,
} from '../../db.js'
import { logger } from '../../logger.js'
import { COORDINATOR_AGENT_ID } from '../../channel-coordinator/ingest.js'
import { sanitizeAgentIdent } from '../../prompt-safety.js'
import { isKnownAgent } from '../agent-config.js'
import { MAIN_AGENT_ID, OWNER_NAME, SYSTEM_SENDER_IDS, parseSystemSenderIds } from '../../config.js'
import { isAgentRunning } from '../agent-process.js'
import { readBody, json, jsonMaybeGzip } from '../http-helpers.js'
import { normalizeKanbanRefs } from '../kanban-ref-normalize.js'
import { stampHeartbeatHeader } from '../heartbeat-header-stamp.js'
import { parseQualifiedId, formatQualifiedId } from '../federation/address.js'
import { getFederationConfig } from '../federation/config.js'
import type { RouteContext } from './types.js'

// Should closing a message produce a reverse "[Eredmény]" notification to its sender?
//
// Exported and tested directly, rather than inlined in the PUT handler: the previous
// tests re-implemented this condition inside the test file, so they passed no matter
// what the route actually did.
//
// Three senders get no notification:
//   1. self-messages -- the sender already knows;
//   2. senders that are not addressable agents. `system` posts the [session-stuck] and
//      [handoff-failure] notices but owns no tmux session, so a reply to it can never be
//      delivered: it fails, the retry window expires, and the resulting [handoff-failure]
//      wakes the main agent -- which, once closed, produced the next one. Measured on the
//      Acrobot install 2026-08-17: 44 of the last 200 rows were `-> system`, all failed.
//      `isKnownAgent` is the right test here because it accepts MAIN_AGENT_ID as well as
//      the sub-agent directories; a plain registry lookup would have suppressed every
//      notification back to the MAIN agent, which is the case this feature exists for.
//   3. contents that are themselves completion reports -- breaks ping-pong chains.
export function shouldNotifyDelegator(fromAgent: string, toAgent: string, content: string): boolean {
  if (fromAgent === toAgent) return false
  if (!isKnownAgent(fromAgent)) return false
  if (content.startsWith(COMPLETION_REPORT_PREFIX)) return false
  return true
}

// Frozen at module load, like the config constant it derives from.
const SYSTEM_SENDERS = parseSystemSenderIds(SYSTEM_SENDER_IDS, sanitizeAgentIdent)

/**
 * How much of a `result` travels inside the completion notification, and what the recipient
 * is told about the rest.
 *
 * WHY THIS IS NOT COSMETIC (measured twice on 2026-08-12): the notification carried the first
 * 500 characters and then said "the full text is in msg N's result field". Both times the cut
 * landed mid-argument -- once on a review condition, once on the numbers that decided whether a
 * filter was safe -- and both times the recipient could only ask for a resend, because the
 * pointer named a FIELD, not a way to read it. A pointer the consumer cannot follow is the same
 * as no pointer: the sender ends up retyping, which is exactly what the notification was for.
 *
 * TWO CHANGES, AND THE SECOND MATTERS MORE. The cap is 2000, because our results routinely
 * carry a measurement plus its interpretation and 500 truncates that mid-sentence. And the
 * marker now names the EXACT command, so following it is one step, not a research task.
 *
 * ES A MUTATO MEGMONDJA, MIRE MUTAT (2026-08-21). A megnevezett id NEM az olvasott uzenete,
 * hanem azé, amelyiknek a `result` mezőjében a teljes szöveg áll. Ezt korábban nem mondtuk ki,
 * és egy ágens a saját üzenet-id-jével kérdezte le: üres választ kapott, abból adatvesztésre
 * következtetett, és majdnem hibajelentést írt róla. Egy mutató, ami helyes, de nem mondja meg,
 * MIRE mutat, ugyanannyi kört visz el, mint egy hiányzó mutató -- csak nem lehet rá fogni.
 *
 * The cap stays FINITE on purpose: the notification is injected into a live session, and an
 * unbounded paste there costs context that the recipient did not choose to spend.
 */
export const RESULT_NOTIFY_MAX = 2000

export function resultSummary(id: number, result: string | undefined | null): string {
  if (!result) return '(nincs eredmény)'
  if (result.length <= RESULT_NOTIFY_MAX) return result
  const maradt = result.length - RESULT_NOTIFY_MAX
  return (
    result.slice(0, RESULT_NOTIFY_MAX) +
    `\n... [levágva, még ${maradt} karakter. A teljes szöveg a(z) ${id}. üzenet result mezőjében áll` +
    ` -- ez NEM ennek az üzenetnek az id-je. Kérd le: bash scripts/agent-msg-get.sh ${id}]`
  )
}

export async function tryHandleMessages(ctx: RouteContext): Promise<boolean> {
  const { req, res, path, method, url } = ctx

  if (path === '/api/messages' && method === 'POST') {
    const body = await readBody(req)
    const { from, to, content, origin_note, priority } = JSON.parse(body.toString()) as
      { from: string; to: string; content: string; origin_note?: string; priority?: string }
    if (!from?.trim() || !to?.trim() || !content?.trim()) {
      json(res, { error: 'from, to, and content are required' }, 400)
      return true
    }
    // Card ad771121. An ABSENT priority means 'normal' -- today's behaviour,
    // unchanged, and stated rather than implied: with a new field it is the
    // unset value that quietly picks a side. An UNKNOWN value is refused
    // loudly instead of being coerced to normal, because a caller who writes
    // priority:"urgent" and gets silent normal delivery is worse off than one
    // who gets an error: they believe they escalated.
    const msgPriority: AgentMessagePriority = priority === undefined || priority === null || priority === ''
      ? 'normal'
      : (priority as AgentMessagePriority)
    if (msgPriority !== 'normal' && msgPriority !== 'high') {
      json(res, {
        error: `unknown priority "${String(priority)}": allowed values are "normal" (default) and "high"`,
        allowed: ['normal', 'high'],
        hint: 'an absent priority field means "normal"',
      }, 400)
      return true
    }
    // Security: the channel-coordinator id grants channel-inbound delivery
    // (verbatim <channel> + reply-expected framing) in the message-router. The
    // ONLY legitimate writer of that id is the in-process coordinator, which
    // inserts directly into the DB -- it never POSTs here. The dashboard token
    // is readable by every sub-agent, so without this guard any sub-agent could
    // forge a reply-expected message addressed at the main agent. Reject it.
    //
    // CRITICAL: normalize with the EXACT function the router matches on
    // (sanitizeAgentIdent), NOT from.trim(). The router does
    // CHANNEL_COORDINATOR_AGENTS.has(sanitizeAgentIdent(from)), and
    // sanitizeAgentIdent STRIPS [^a-zA-Z0-9_-] rather than trimming. A bypass
    // like from="@telegram-coordinator" / "telegram-coordinator." survives
    // .trim() (!= the constant) yet sanitizes to "telegram-coordinator" in the
    // router -> channel-inbound with an attacker-controlled body. Matching the
    // router's normalization here closes that asymmetry.
    if (sanitizeAgentIdent(from) === COORDINATOR_AGENT_ID) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST forging channel-coordinator id')
      json(res, { error: 'from is reserved for the in-process channel coordinator' }, 403)
      return true
    }
    // Federation spoof guard: a slash-qualified from ("teodor/teodor") is the
    // provenance mark of a REMOTE sender and may only ever be written by the
    // token-authenticated /api/federation/inbox. Accepting it here would let
    // any dashboard-token holder (i.e. every local sub-agent) impersonate a
    // federation peer toward another local agent.
    if (from.includes('/')) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST with qualified from (federation impersonation guard)')
      json(res, { error: 'from must be a local agent id without "/" -- federated senders are only accepted via /api/federation/inbox' }, 403)
      return true
    }
    // From-authentication: accept messages only from registered fleet agents.
    // The shared Bearer token is readable by any sub-agent, so without this
    // check any process with the token could inject messages as an arbitrary
    // sender ("from": "zack" from an external attacker who obtained the token).
    // Server-side validation: the `from` claim must match a known agent on the
    // filesystem (agents/<id>/ directory, or MAIN_AGENT_ID). This is not
    // impersonation-proof between fleet agents (they share the same token) but
    // it closes the "unknown sender" injection path without per-agent secrets.
    //
    // The human OWNER is a legitimate sender too: the dashboard "Messages" page
    // composes with from=OWNER_NAME (resolveOwnerName -> the owner assignee), so
    // without this exemption the operator's own dashboard messages 403 with
    // "unknown agent". The owner is not a fleet agent (no agents/<id>/ dir), so
    // isKnownAgent alone rejects it. Match on the router's normalization to stay
    // symmetric with the other guards above.
    //
    // Neighbouring SYSTEMS are legitimate senders too, on the same reasoning as
    // the owner: they are token-authenticated and only notify an agent, but they
    // have no agents/<id>/ directory. Opt-in via SYSTEM_SENDER_IDS in .env
    // (empty by default). Without this, such a system silently loses its push
    // channel the moment this guard ships -- observed here: an external case
    // manager pushed 4182 messages, then every call 403'd for nine days while
    // its fail-soft caller logged nothing.
    const isOwnerSender = sanitizeAgentIdent(from) === sanitizeAgentIdent(OWNER_NAME)
    const isSystemSender = SYSTEM_SENDERS.has(sanitizeAgentIdent(from))
    if (!isOwnerSender && !isSystemSender && !isKnownAgent(sanitizeAgentIdent(from))) {
      logger.warn({ from: from.trim(), to: to.trim() }, 'Rejected /api/messages POST from unregistered agent')
      json(res, { error: `unknown agent '${from.trim()}' -- from must be a registered fleet agent id` }, 403)
      return true
    }
    // Qualified to ("peer/agent"): validate at creation time so the sender
    // gets an actionable error NOW instead of a silent 1h abandon. Local
    // (slash-free) recipients are untouched.
    let storedTo = to.trim()
    if (storedTo.includes('/')) {
      const target = parseQualifiedId(storedTo)
      if (!target) {
        json(res, { error: 'Invalid federated address in to (expected "<system>/<agent>")' }, 400)
        return true
      }
      const cfg = getFederationConfig()
      if (!cfg.enabled) {
        json(res, { error: 'Federation is disabled on this system' }, 400)
        return true
      }
      // System ids are case-insensitive (stored lowercase in the config).
      // Normalize the STORED prefix too: the per-peer purge SQL and the
      // bridge's peer lookup key on it, and thread grouping in the UI should
      // not split 'Teodor/x' from 'teodor/x'. The agent segment is the
      // PEER's namespace -- leave its case alone.
      const targetSystem = target.system.toLowerCase()
      if (targetSystem === cfg.systemId) {
        json(res, { error: `'${target.system}' is this system -- address the agent locally as '${target.agent}'` }, 400)
        return true
      }
      if (!cfg.peers.some((p) => p.id === targetSystem)) {
        json(res, { error: `Unknown federation peer '${target.system}'` }, 400)
        return true
      }
      storedTo = formatQualifiedId(targetSystem, target.agent)
    } else if (storedTo.includes(':')) {
      // A colon-form 'to' ("federation:teodor:teodor", copied from an
      // <untrusted source> attribute) is NOT a valid address: it has no '/',
      // so it would be treated as a LOCAL recipient, never match a session,
      // and silently sit pending until the 1h abandon window. Reject it now
      // with the correct form. Safe: sanitizeAgentIdent strips ':', so no
      // legitimate local agent id can contain one, and the channel
      // coordinator inserts directly into the DB, bypassing this endpoint.
      json(res, { error: 'Invalid recipient: use "<system>/<agent>" (slash) for a federated address, not the "federation:x:y" source form' }, 400)
      return true
    }
    // Code-side enforcement of the kanban-ref convention: rewrite any
    // `#<hex8>` token that maps to a real kanban_cards row into its
    // human-facing `#<seq>` form before persistence, so the dashboard and
    // every downstream consumer sees the canonical reference even when a
    // sub-agent forgets the CLAUDE.md rule (#75 Cuzcoo dispatch).
    // HBORACSUSZAS908: the digest header clock is machine-stamped at
    // persistence -- an agent-typed hour drifts forward as its session fills
    // (measured 0,0,0,0,0,+1h,+3h on 2026-09-08) and the digest is the surface
    // the whole fleet reads time from. Same code-side-enforcement pattern as
    // normalizeKanbanRefs below.
    const normalizedContent = normalizeKanbanRefs(stampHeartbeatHeader(content.trim()), getKanbanSeqByIdPrefix)
    // Card 06f062e4: optional attributability tag, self-declared like `from`
    // itself -- capped short so it stays a label, not a second content field.
    const trimmedOriginNote = origin_note?.trim().slice(0, 120) || null
    const msg = createAgentMessage(from.trim(), storedTo, normalizedContent, trimmedOriginNote, null, msgPriority)
    // The sender used to get a warning TEXT about a deep queue and nothing to
    // act on. These two numbers are what make "do I still need a manual nudge?"
    // a decision instead of a guess (card ad771121, point 2).
    //
    // DECISION on point 3 of the card (automatic tmux nudge for 'high'): NO,
    // not in this change, and the reason is measured rather than cautious.
    // The queue in the recorded incident was NOT stuck -- it was draining; the
    // delay came from long agent turns. An automatic nudge would interrupt a
    // running turn on every high-priority send, which is a real cost paid on
    // every message to buy back time only on the rare one that would otherwise
    // wait. A second, priority-triggered nudge path would also run beside the
    // existing inbox-nudge-watcher, with its own failure modes.
    // What the gap actually was: the sender could not tell whether a nudge was
    // needed. queuePosition/queueDepth answer that, and they also make the
    // follow-up measurable -- REVISIT this decision if, with priority in place,
    // high-priority messages are still measured waiting past a set threshold.
    const placement = getQueuePlacement(msg.id)
    logger.info({ id: msg.id, from: msg.from_agent, to: msg.to_agent, originNote: msg.origin_note }, 'Agent message created')
    // A LOCAL recipient that is not running never receives this: the router
    // retries for a while and then abandons it, and the failure notice goes to
    // the MAIN agent, not to the sender. The caller therefore sees a plain 200
    // and believes it delegated. Federated addresses already get an actionable
    // error at creation time (see above) -- give the local path the same
    // courtesy, as a non-breaking warning field rather than a status change, so
    // existing callers keep working.
    // The MAIN agent is exempt (MSGWARN908): its session is
    // `${MAIN_AGENT_ID}-channels`, so isAgentRunning() -- which probes
    // `agent-<name>` -- always says stopped, and the router never abandons a
    // main-agent message anyway (pull model: the main agent drains its own
    // inbox each turn). The warning below was therefore always false for it,
    // and on 2026-09-08 the false "not running" state reached the owner as a
    // system-down report. The worst reaction it invites -- starting a second
    // main instance -- is exactly what the pull model must never see.
    if (!storedTo.includes('/')
        && sanitizeAgentIdent(storedTo) !== sanitizeAgentIdent(MAIN_AGENT_ID)
        && !isAgentRunning(sanitizeAgentIdent(storedTo))) {
      logger.warn({ id: msg.id, to: msg.to_agent }, 'Agent message queued for a STOPPED agent -- likely to be abandoned')
      json(res, {
        ...msg,
        queuePosition: placement?.position ?? null,
        queueDepth: placement?.depth ?? null,
        targetRunning: false,
        warning: `'${msg.to_agent}' nem fut -- indítsd el (POST /api/agents/${msg.to_agent}/start), várd meg amíg feláll, és küldd újra. Egy leállított ügynöknek küldött üzenet nem várakozik, hanem elveszik.`,
      })
      return true
    }
    json(res, { ...msg, queuePosition: placement?.position ?? null, queueDepth: placement?.depth ?? null })
    return true
  }

  // Sidebar threads: one row per conversation peer (system agents excluded),
  // each with its count + most-recent message, recency computed per-peer.
  if (path === '/api/messages/threads' && method === 'GET') {
    json(res, getAgentConversationThreads())
    return true
  }

  // Backlog per agent: count + how long the oldest has been waiting. Cheap
  // enough to curl on a schedule; the point is that a growing queue behind a
  // busy agent becomes visible BEFORE someone mistakes it for lost messages.
  if (path === '/api/messages/backlog' && method === 'GET') {
    json(res, getPendingBacklogByAgent())
    return true
  }

  if (path === '/api/messages' && method === 'GET') {
    // An UNKNOWN filter param used to fall through to the global list: a typo,
    // or the plausible-but-wrong `agent_id`, silently returned the fleet's last
    // N messages instead of one agent's mailbox. Not an error, not an empty
    // list -- MORE than asked for, which is the expensive direction to be wrong
    // in: a caller acting in good faith on that answer reads other agents'
    // traffic as its own. Fail loudly instead.
    const KNOWN_PARAMS = new Set(['agent', 'status', 'limit', 'before'])
    const unknown = [...url.searchParams.keys()].filter((k) => !KNOWN_PARAMS.has(k))
    if (unknown.length) {
      json(res, {
        error: 'unknown query parameter',
        unknown,
        known: [...KNOWN_PARAMS],
        hint: 'the mailbox filter is "agent"; "agent_id" and "to" are not read',
      }, 400)
      return true
    }
    const agent = url.searchParams.get('agent') || ''
    const status = url.searchParams.get('status') || ''
    // A limit ABOVE the cap used to be clamped in silence: the caller asked for
    // 2000, got 200, and nothing in the response said so (MSGLISTCUT907). The
    // route already fails loudly for an unknown parameter because answering
    // with MORE than was asked is expensive; answering with LESS and staying
    // quiet is the same bug pointing the other way, and it reads as "there is
    // no more history" -- always the reassuring direction. Same for a limit
    // that is not a number at all, which used to reach SQLite as NaN and come
    // back as an empty list.
    const limitRaw = url.searchParams.get('limit')
    const limitNum = limitRaw === null ? 50 : parseInt(limitRaw, 10)
    if (!Number.isFinite(limitNum) || limitNum < 1 || limitNum > AGENT_MESSAGE_LIMIT_CAP) {
      json(res, {
        error: `invalid limit: must be an integer between 1 and ${AGENT_MESSAGE_LIMIT_CAP}`,
        max: AGENT_MESSAGE_LIMIT_CAP,
        got: limitRaw,
        hint: `page with "before=<oldest id you already have>" to read further back; a page shorter than the limit means you reached the end`,
      }, 400)
      return true
    }
    const limit = limitNum
    const beforeRaw = url.searchParams.get('before')
    const before = beforeRaw !== null ? parseInt(beforeRaw, 10) : undefined

    let messages: AgentMessage[]
    if (status === 'pending' && agent) {
      messages = getPendingMessages(agent)
    } else if (status === 'pending') {
      messages = getPendingMessages()
    } else if (agent) {
      // SQL-filtered to THIS agent's last N (+ before-cursor pagination), not
      // global-last-N-then-JS-filter which starved rarely-active threads.
      messages = getAgentConversation(agent, limit, Number.isFinite(before as number) ? before : undefined)
    } else {
      messages = listAgentMessages(limit, Number.isFinite(before as number) ? before : undefined)
    }

    jsonMaybeGzip(req, res, messages)
    return true
  }

  const msgUpdateMatch = path.match(/^\/api\/messages\/(\d+)$/)
  // EGY uzenet a TELJES tartalmaval -- ezt nevezi meg a levagott ertesites markere.
  // A lista-vegpont csak agens szerint kerdezheto, tehat egy `msg N` hivatkozast eddig
  // nem lehetett egy lepesben kovetni.
  if (msgUpdateMatch && method === 'GET') {
    const one = getAgentMessage(parseInt(msgUpdateMatch[1], 10))
    if (!one) { json(res, { error: 'Message not found' }, 404); return true }
    json(res, one)
    return true
  }
  if (msgUpdateMatch && method === 'PUT') {
    const id = parseInt(msgUpdateMatch[1], 10)
    const body = await readBody(req)
    const { status: newStatus, result, notify } = JSON.parse(body.toString()) as
      { status: string; result?: string; notify?: boolean }

    // `notify` lets the CLOSER decide whether the reverse [Eredmény] message is
    // worth an agent turn at the other end. The two cases share this one code
    // path and cannot be told apart from here:
    //   - closing a DELEGATED task   -> the delegator is waiting, the ack IS the result;
    //   - closing an INCOMING report -> the sender already knows it sent it, and the ack
    //     (typically the 52-char "(nincs eredmény)" form) only lengthens the very queue
    //     whose delay made the report late. Measured on a live install: several such acks
    //     sat queued behind an agent whose delivery was already lagging, so closing the
    //     reports made the queue that the reports arrive in longer still.
    // Absent (or null) keeps today's behavior, so no existing caller changes.
    // Rejected BEFORE the status write, not coerced: a truthy `"false"` string would send
    // exactly the notification the caller asked to skip, and a half-applied close (status
    // written, unwanted ack sent) is worse than an actionable error the caller can retry
    // -- the same reason the GET list handler rejects unknown query params.
    if (notify !== undefined && notify !== null && typeof notify !== 'boolean') {
      json(res, {
        error: 'notify must be a boolean',
        hint: 'omit it for the default (notify the sender), or send JSON true/false -- not a string',
      }, 400)
      return true
    }

    let ok = false
    if (newStatus === 'done') ok = markMessageDone(id, result)
    else if (newStatus === 'failed') ok = markMessageFailed(id, result)

    if (ok) {
      const done = getAgentMessage(id)
      // Close the OTel span now that the message has a terminal status.
      if (done?.trace_id && done?.span_id) {
        closeOtelSpan(done.trace_id, done.span_id, Date.now(), newStatus === 'done' ? 'ok' : 'error')
      }
      // Notify the delegator: create a reverse message from executor → delegator so
      // they learn the result without polling. See shouldNotifyDelegator for which
      // senders are skipped and why.
      // `notify: false` suppresses it; `notify: true` is only the default spelled out --
      // it does NOT override shouldNotifyDelegator, whose guards stop undeliverable and
      // ping-pong acks, not merely expensive ones.
      if (done && notify !== false && shouldNotifyDelegator(done.from_agent, done.to_agent, done.content)) {
        // A vagas NE legyen nema, ES legyen KOVETHETO: lasd resultSummary().
        const summary = resultSummary(id, result)
        createAgentMessage(
          done.to_agent,
          done.from_agent,
          `${COMPLETION_REPORT_PREFIX} msg_id:${id} status:${newStatus}\n\n${summary}`,
        )
      }
      json(res, { ok: true }); return true
    }
    json(res, { error: 'Message not found or invalid status' }, 404)
    return true
  }

  return false
}
