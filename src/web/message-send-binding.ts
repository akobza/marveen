// Who a 'message-send' device key may be bound to (MSGSENDKEY1012). One place
// for the mint route (routes/auth.ts) to ask, with the same normalisation the
// message route uses: an id must be EXACTLY what it sanitises to, so a near-miss
// that would only sanitise to a real id is never stored as a binding.

import { sanitizeAgentIdent } from '../prompt-safety.js'
import { isKnownAgent } from './agent-config.js'
import { SYSTEM_SENDER_IDS, parseSystemSenderIds } from '../config.js'
import { COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID } from '../channel-coordinator/ingest.js'

const SYSTEM_SENDERS = parseSystemSenderIds(SYSTEM_SENDER_IDS, sanitizeAgentIdent)

// The channel-framing ids. The voice id is accepted on ANY device-key lane by
// POST /api/messages (it is how the out-of-process relay writes), so a narrow
// key bound to it would carry channel-inbound framing; the coordinator id is
// in-process only. Neither may be bound, as sender or as recipient. (The
// system-directive sender is refused by the message route on every lane, and is
// neither a known agent nor, by default, a SYSTEM_SENDER_IDS entry.)
const CHANNEL_FRAMING_IDS: ReadonlySet<string> = new Set([COORDINATOR_AGENT_ID, VOICE_CHANNEL_AGENT_ID])

function exact(id: string): boolean {
  return !!id && sanitizeAgentIdent(id) === id && !CHANNEL_FRAMING_IDS.has(id)
}

/** A recipient a message-send key may be bound to: exactly a registered local fleet agent id (the main agent included). */
export function isBindableRecipient(id: string): boolean {
  return exact(id) && isKnownAgent(id)
}

/** A sender a message-send key may be bound to: exactly a registered fleet agent id or a SYSTEM_SENDER_IDS entry. */
export function isBindableSender(id: string): boolean {
  return exact(id) && (isKnownAgent(id) || SYSTEM_SENDERS.has(id))
}
