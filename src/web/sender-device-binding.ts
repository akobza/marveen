// Sender -> device-key binding on /api/messages (32156973). The rule, in both directions:
//   1. a BOUND sender is accepted only from one of its own device keys -- not the shared
//      dashboard token (every sub-agent can read it), not a session, not another device key;
//   2. a BOUND key may write only as its own sender(s) -- a key is issued to one client, and
//      that client must not be able to speak as the main agent either.
// Unbound senders and unbound keys are untouched, so the gate is switched on sender by sender
// through SENDER_DEVICE_KEYS (config.ts). Returns the refusal text, or null to let the POST on.
export function senderDeviceKeyDenial(
  sender: string,
  auth: { kind: string; deviceId?: number } | undefined,
  bindings: Map<string, Set<number>>,
): string | null {
  const deviceId = auth?.kind === 'device' ? auth.deviceId : undefined
  const bound = bindings.get(sender)
  if (bound) {
    if (deviceId === undefined || !bound.has(deviceId)) {
      return `from '${sender}' is bound to its own device key and is accepted only from it -- not the shared dashboard token, not another credential`
    }
    return null
  }
  if (deviceId !== undefined) {
    for (const [owner, ids] of bindings) {
      if (ids.has(deviceId)) {
        return `this device key is bound to '${owner}' and may write only as '${owner}', not as '${sender}'`
      }
    }
  }
  return null
}
