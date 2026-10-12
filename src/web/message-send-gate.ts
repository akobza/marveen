// The server-side fence around a 'message-send' device key (MSGSENDKEY1012).
//
// Decided BEFORE any route handler runs, like the operator gate: a
// 'message-send' scoped key may reach POST /api/messages and nothing else.
// Deny-by-default on purpose: a route added later is closed to this key without
// anyone remembering to close it. The recipient it was minted for is checked in
// the route itself (routes/messages.ts), where the body is read. Every other
// credential (token, session, federation, a 'full' or 'operator' key) is
// untouched by this gate.

export interface MessageSendGateAuth {
  kind: string
  scope?: string
}

/** null = let it through; otherwise the reason for a 403. */
export function messageSendGateDecision(auth: MessageSendGateAuth, path: string, method: string): string | null {
  if (auth.kind !== 'device' || auth.scope !== 'message-send') return null
  if (path === '/api/messages' && method === 'POST') return null
  return 'message-send credential: only POST /api/messages'
}
