// Exact-match tmux targets (TMUXEXACT927, a190dc57).
//
// tmux resolves a `-t` session name that matches no session EXACTLY as a
// PREFIX, when exactly one session starts with it. Agent sessions share
// prefixes (agent-x / agent-x-2), so a call that names a session which is not
// running right now lands on its one prefix sibling: kill-session kills it,
// send-keys types into it, capture-pane reads it, has-session says it is
// running. Measured on one install: restarting an agent killed its one prefix
// sibling eight times between 2026-09-21 and 09-25 -- startAgentProcess
// re-issues kill-session for its own name after the stop, when that session is
// already gone.
//
// `=name:` is the one form that is exact for every subcommand the router uses
// (measured 2026-09-27 on tmux 3.6, one private server per case): the `=` asks
// for an exact session name, and the trailing `:` makes window and pane commands
// look the session up as a session. `=name` alone is not enough: as a pane
// target (send-keys, capture-pane) it fails even when the session exists, and
// window commands (list-panes, kill-window) still fall through to the sibling.
// On a missing session every command now fails instead of hitting the sibling;
// display-message answers rc 0 with empty output.

/**
 * The exact-match form of a tmux target: `name` -> `=name:`, `name:window.pane`
 * -> `=name:window.pane`. Idempotent. Session, window and pane ids ($1, @2, %3)
 * are already unique and pass through unchanged.
 */
export function exactTmuxTarget(target: string): string {
  if (!target) return target
  const first = target[0]
  if (first === '$' || first === '@' || first === '%') return target
  const bare = first === '=' ? target.slice(1) : target
  return bare.includes(':') ? `=${bare}` : `=${bare}:`
}

/**
 * The session name a `-t` / `-s` value addresses: the `=` exact-match prefix and
 * any `:window.pane` suffix stripped. For looking a target up by session name.
 */
export function sessionOfTmuxTarget(target: string): string {
  const bare = target.startsWith('=') ? target.slice(1) : target
  const colon = bare.indexOf(':')
  return colon === -1 ? bare : bare.slice(0, colon)
}
