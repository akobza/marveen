import { json } from '../http-helpers.js'
import { externalAgentStatuses } from '../external-status-agents.js'
import type { RouteContext } from './types.js'

/**
 * Read-only status of the non-fleet agents the install lists in store/external-status-agents.json (card 28c4a739).
 * GET only: there is no write, control or message route for them, on purpose.
 */
export async function tryHandleExternalAgents(ctx: RouteContext): Promise<boolean> {
  const { res, path, method } = ctx
  if (path === '/api/external-agents' && method === 'GET') {
    json(res, { agents: externalAgentStatuses() })
    return true
  }
  return false
}
