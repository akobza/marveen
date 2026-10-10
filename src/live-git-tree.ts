// LIVETREEGIT1010: shape checks for the two install settings that name a
// production git work tree and the unix user that owns it (LIVE_GIT_TREE_PATH,
// LIVE_GIT_TREE_OWNER). Both values are written verbatim into every agent's
// CLAUDE.md, inside a shell command, so they must be plain: an absolute path of
// ordinary path characters and a POSIX user name. Anything else -- a space, a
// newline, a backtick, a `$(` -- could break the command or carry other text
// into every agent's prompt. One place for the rule, used by the Settings
// validation (config-registry.ts) and by the generator (web/agent-scaffold.ts).
const PATH_RE = /^\/[A-Za-z0-9._/-]+$/
const DOTDOT_RE = /(^|\/)\.\.(\/|$)/
const OWNER_RE = /^[a-z_][a-z0-9_-]{0,31}$/

/** Error text for an unusable tree path, null when the value is usable. */
export function liveGitTreePathError(value: string): string | null {
  if (!PATH_RE.test(value) || DOTDOT_RE.test(value)) {
    return 'Abszolút út kell (perjellel kezdődik), csak betű, szám, pont, aláhúzás, kötőjel és perjel lehet benne, ".." szakasz nélkül.'
  }
  return null
}

/** Error text for an unusable owner name, null when the value is usable. */
export function liveGitTreeOwnerError(value: string): string | null {
  if (!OWNER_RE.test(value)) {
    return 'Unix-felhasználónév kell: kisbetűvel vagy aláhúzással kezdődik, utána kisbetű, szám, aláhúzás vagy kötőjel, legfeljebb 32 karakter.'
  }
  return null
}
