#!/usr/bin/env node
// PreToolUse hard-gate: blocks SELF-PACE for sub-agents.
//
// Governance control (2026-06-26, after the autonom-kor incident: a sub-agent
// scheduled its own wakeups via ScheduleWakeup, fed itself prompts, and acted
// on a SELF-GENERATED "A) zárjuk le" decision -- dispatching real development
// -- while the operator slept. Two independent adversarial audits confirmed the
// root cause is the agent's own self-pace loop, not an external vector).
//
// A sub-agent must be INPUT-DRIVEN: it acts on operator / peer messages, never
// on prompts it scheduled for itself. This gate blocks every self-pace path:
//   - the Claude Code runtime tools ScheduleWakeup / CronCreate / CronList /
//     CronDelete / RemoteTrigger (the autonomous-loop machinery), AND
//   - the Bash escape routes that achieve the same self-injection: writing the
//     Claude scheduled_tasks.json directly, tmux send-keys into a session,
//     POSTing a new schedule to the dashboard, or an OS scheduler (crontab / at /
//     launchctl / systemd-run, and a systemd timer armed with systemctl or
//     written into a unit directory). One exact systemd-run form, the memory
//     guard's foreground scope, is allowed: see SF_HEAVY_SCOPE_RX.
//
// Why a hook and not only a permissions deny-list: permissive profiles launch
// with --dangerously-skip-permissions. A whole-tool-name deny DOES survive that
// (deny is checked before the bypass allow), so the scaffold also adds these
// names to permissions.deny -- but the Bash-command routes can ONLY be caught
// by a PreToolUse hook, which runs regardless of permission mode. Defense in
// depth: deny-list for the tool names, this hook for the Bash routes (+ the
// names again, redundantly fail-closed).
//
// Wired into every sub-agent's .claude/settings.json by
// writeAgentSettingsFromProfile() (agent-scaffold.ts), guarded by
// name !== MAIN_AGENT_ID, re-applied on every spawn (respawn-safe).

import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Claude Code runtime self-pace / scheduling tools. A sub-agent has no
// legitimate need to schedule its own future turns -- it is input-driven.
const SELF_PACE_TOOLS = new Set([
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'RemoteTrigger',
])

// Bash command patterns that achieve self-pace by another route. These are
// tested per COMMAND SEGMENT (see splitSegments), so a token in one part of a
// compound command never trips a pattern that belongs to another part.
const SELF_PACE_BASH_PATTERNS = [
  // tmux pane injection -- every write-subcommand that can push keys/text/commands
  // into a pane (the actual incident vector), not just send-keys. [\s\S] (not
  // [^\n]) so an intra-segment newline cannot split the match.
  /\btmux\b[\s\S]*\b(send-keys|paste-buffer|run-shell|set-buffer)\b/i,
  // self-backgrounding that relaunches claude (nohup/setsid/disown + claude)
  /\b(nohup|setsid|disown)\b[\s\S]*\bclaude\b/i,
  // the loop slash-skill driven from a shell. `/loop` must be in SLASH-COMMAND
  // position -- a standalone token (segment-start / whitespace / quote before it,
  // whitespace / quote / end after it) -- never a PATH segment. The old
  // `\/loop\b` fired on any `loop`-prefixed path component whenever `.claude` was
  // in the same command (\bclaude\b matches the `.claude` in every memory/skill
  // path), so reading `.../memory/loop-stop-...md` or `~/.claude/skills/loop/...`
  // was denied (measured 2026-07-26, found by pg: Heli denied a harmless memory
  // read). Same bug class as the at/batch and launchctl fixes below: a keyword in
  // a PATH collided with a call pattern; the fix is to match the invocation SHAPE.
  // Every real form stays denied: `claude /loop 5m`, `claude -p "/loop x"`,
  // `claude '/loop'`, bare `claude /loop`.
  /\bclaude\b[\s\S]*(?:^|[\s'"])\/loop(?=[\s'"]|$)/i,
]

// OS-level schedulers + delayed exec (cron / launchd / systemd / at / batch): the
// shell route to the same self-pace the CronCreate tool-deny blocks at the runtime
// layer. Anchored to command position (segment start), but a leading wrapper is
// allowed before the binary -- sudo/env/command/nice, a VAR=val environment, and
// an absolute/relative path -- so `sudo crontab -r`, `/usr/bin/at now`,
// `PATH=/bin crontab -` are all caught. Trailing \b(?!-) so it never fires on
// "netstat" / "crontab-helper.sh"; (?!\s*=) so a bare NAME=value assignment
// (`at=$(...)`) is not mistaken for the `at` binary.
const SCHED_PREFIX = String.raw`(?:(?:[A-Za-z_]\w*=\S*|sudo|env|command|exec|nice|builtin|time)\s+)*(?:\S*/)?`
// The command-boundary anchor includes `(` so a $(...) command substitution
// (`X=$(crontab -)`) is caught, AND a backtick so a legacy `...` substitution
// (`X=`crontab -r``) is caught too -- both run the enclosed command in a shell
// context, so a scheduler binary immediately inside either is a real self-pace.
const SCHED_BOUNDARY = '[;&|(`]'
// `at` and `batch` are also ordinary English words, and splitSegments splits on
// NEWLINES -- so a PROSE line inside a multi-line commit body ("at least 80% of
// entries", "batch size is 50") lands at a segment start and looked exactly like
// the at(1)/batch(1) binaries. Measured 2026-07-25 (found by JogAsz): a heredoc
// commit message was denied for the words "at least"; the identical command
// passed after rewording that one line. The `-m "$(...)"` form is deliberately
// NOT blanked by stripGitCommitMessages (a real substitution could hide there),
// so the body does reach the splitter -- the fix belongs here, not there.
//
// For these two words ONLY, also require something that looks like an actual
// invocation: end of segment (a bare `batch` reads stdin -- still a real vector),
// a flag, an input redirect, or an at(1) TIMESPEC (which at(1) requires anyway,
// so a real submit can never omit it). crontab/launchctl/systemd-run keep the
// plain match: they are not English words, so prose cannot collide with them.
const AT_INVOCATION = String.raw`(?=\s*$|\s+-|\s*<|\s+(?:now|noon|midnight|teatime|today|tomorrow|next\b|\+\s*\d|\d{1,2}:\d{2}|\d{3,4}\b|\d{1,2}\s*(?:am|pm)\b|\d{1,2}[./]\d{1,2}|(?:mon|tue|wed|thu|fri|sat|sun)|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)))`
// `launchctl` needed the SAME narrowing, for a different reason than at/batch, and
// the comment above ("not English words, so prose cannot collide") was measured
// wrong on 2026-07-26 (found by Hacker). It is not an English word -- but the
// fleet's own heartbeats ORDER every agent to report `launchctl list | grep
// com.jarvis.channels` output, so a launchd JOB LABEL appears in prose constantly.
// splitSegments splits on `;`, so a report line "...; launchctl com.jarvis.channels
// PID 555" put `launchctl <label>` at a segment start and it read as a real
// invocation. His status message was denied; the finding is systemic, not his.
//
// The narrowing mirrors AT_INVOCATION: instead of enumerating dangerous
// subcommands (a denylist -- miss one and it is a hole), require the SHAPE of a
// real invocation. Every launchctl self-pace vector (load/bootstrap/submit/
// kickstart/start/enable/...) takes a SUBCOMMAND word first, so demand that the
// next token could be one: a bare lowercase word, no dot and no slash. A job
// label (`com.jarvis.channels`) and a path both fail that and pass through as
// prose. End-of-segment and a flag stay DENIED -- a bare `launchctl` is
// interactive, still a real vector.
const LAUNCHCTL_SUBCOMMAND = String.raw`(?=\s*$|\s+-|\s+[a-z][a-z-]*(?:\s|$))`
// The command word of a segment, and also after a shell keyword that starts a
// command inside a loop, a condition or a group. Measured 2026-09-30 (90a2257b):
// SCHEDULER_RX had no keyword branch, so `if true; then crontab -r; fi`,
// `for i in 1; do crontab -r; done`, `while false; do at now; done`, `{ crontab
// -r; }` and `! crontab -r` all passed, while the timer check below (cc8e80d7)
// already had one: the measured `for f in x.service x.timer; do cp ... "$U/$f";
// done` puts `do cp` at the start.
const SHELL_KEYWORDS = String.raw`(?:(?:do|then|else|elif|if|while|until|!|\{)\s+)*`
// ...and after `sudo` WITH options or `timeout <duration>`, which SCHED_PREFIX does
// not read (it takes a bare `sudo` only). Measured 2026-09-30 (ffc45c28): `sudo -n
// crontab -r`, `sudo -u root crontab -r` and `timeout 60 crontab -r` passed, on
// develop too, while `sudo crontab -r` was denied. The timer check below already
// read these: `sudo -n tee /etc/systemd/system/x.timer` was the one real write the
// plain prefix missed among 3250 measured commands (cc8e80d7). The options that
// take a value are named, so `sudo -n tee` keeps `tee` as the command; the same
// for timeout's `-s <signal>` and `-k <duration>` (`timeout -s KILL 60 crontab -r`
// passed with the earlier `-\S+` branch, which took `KILL` for the duration).
// The other common wrappers are read the same way (fejlesztes-vezeto 53434, measured
// 2026-09-30: a scheduler passed behind each): env with options, nice with an
// adjustment, nohup, command -p (only -p runs the command; -v and -V look it up),
// exec -a, stdbuf, setsid, flock <file>, doas, runuser, and xargs as the head of a
// pipeline segment (`... | xargs crontab -r`).
const WRAPPER_PREFIX = String.raw`(?:(?:sudo(?:\s+(?:-[ugpCDrtUTh]\s*\S+|--(?:user|group|prompt|close-from|chdir|role|type|other-user|command-timeout|host)(?:=|\s+)\S+|-[A-Za-z]+|--[\w-]+))*|timeout(?:\s+(?:-[sk]\s*\S+|--(?:signal|kill-after)(?:=|\s+)\S+|-[A-Za-z]+|--[\w-]+))*\s+\S+|env(?:\s+(?:-[uCS]\s*\S+|--(?:unset|chdir|split-string)(?:=|\s+)\S+|-[A-Za-z]*|--[\w-]+|[A-Za-z_]\w*=\S*))*|nice(?:\s+(?:-n\s*\S+|--adjustment(?:=|\s+)\S+|-\d+))*|nohup|command(?:\s+-p)+|exec(?:\s+(?:-a\s+\S+|-[cl]+))*|stdbuf(?:\s+(?:-[ioe]\s*\S+|--(?:input|output|error)(?:=|\s+)\S+))*|setsid(?:\s+(?:-[A-Za-z]+|--[\w-]+))*|flock(?:\s+(?:-[wEe]\s*\S+|--(?:timeout|conflict-exit-code)(?:=|\s+)\S+|-[A-Za-z]+|--[\w-]+))*\s+\S+|doas(?:\s+(?:-u\s*\S+|-[A-Za-z]+))*|runuser(?:\s+(?:-u\s*\S+|--user(?:=|\s+)\S+|-[A-Za-z]+|--[\w-]+))*(?:\s+--)?|xargs(?:\s+(?:-[IdEeLnPsa]\s*\S+|--[\w-]+(?:=\S+)?|-[A-Za-z0]+))*)\s+)*`
const SCHEDULER_RX = new RegExp(
  String.raw`(^|${SCHED_BOUNDARY}\s*)${SHELL_KEYWORDS}${WRAPPER_PREFIX}${SCHED_PREFIX}(?:(?:crontab|systemd-run)\b(?!-)(?!\s*=)|launchctl\b(?!-)(?!\s*=)${LAUNCHCTL_SUBCOMMAND}|(?:batch|at)\b(?!-)(?!\s*=)${AT_INVOCATION})`,
  'i',
)
// ...but allow a pure READ-listing of one's own schedule (parity with the store /
// schedule-API read exemptions): crontab -l, launchctl list/print, atq.
const SCHEDULER_READ_RX = new RegExp(String.raw`(^|${SCHED_BOUNDARY}\s*)${SHELL_KEYWORDS}${WRAPPER_PREFIX}${SCHED_PREFIX}(crontab\s+-l\b|launchctl\s+(?:list|print|dumpstate|blame|examine)\b|atq\b)`, 'i')

// --- a command handed to a shell as text ------------------------------------------
//
// `bash -c '<script>'`, `sh -c "<script>"`, `su -c '<script>' <user>` and `flock <file>
// -c '<script>'` run their quoted argument, which every check here reads as inert text.
// Measured 2026-09-30 (ffc45c28, fejlesztes-vezeto 53434): `bash -c 'crontab -r'` and
// `sh -c "crontab -r"` passed. The shell word is looked for at a command position in the
// MASKED command, so a heredoc body or quoted prose that only mentions one is not read;
// masking keeps the length, so the quoted argument is then taken from the same place
// in the command itself and judged as a command of its own (gateDecision, depth <= 3).
const SHELL_C_RX = new RegExp(
  String.raw`(?:^|${SCHED_BOUNDARY}|\n)\s*${SHELL_KEYWORDS}${WRAPPER_PREFIX}(?:\S*/)?(?:bash|sh|dash|zsh|ksh|su|runuser|flock)\b[^;&|\n'"]*?\s-[A-Za-z]*c(?=\s)`,
  'g',
)
export function shellCScripts(command) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  const view = maskInertLiterals(src, { strict: false }) ?? src
  const out = []
  for (const m of view.matchAll(SHELL_C_RX)) {
    let at = m.index + m[0].length
    while (at < src.length && /[ \t]/.test(src[at])) at++
    if (src[at] === "'") {
      const end = src.indexOf("'", at + 1)
      if (end > at) out.push(src.slice(at + 1, end))
    } else if (src[at] === '"') {
      let j = at + 1
      while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1
      if (j < src.length) out.push(src.slice(at + 1, j).replace(/\\(["\\$`])/g, '$1'))
    }
  }
  return out
}

// --- the one systemd-run form this gate allows ----------------------------------
//
// Card 90a2257b (074645b4, ügyvezető 52651 K2). The memory guard on the fleet host
// runs every heavy compile (tsc, next build) through scripts/infra-ops/sf-heavy,
// which starts it in a FOREGROUND transient scope with a memory cap:
//   systemd-run --user --scope --quiet --collect --slice=sf-heavy.slice
//     --unit=sf-heavy-<label> -p MemoryMax=<size> -- /usr/bin/time -o <file> -f %M <command>
// A scope runs its command now and ends with it: no timer, no --on-*, no service
// that outlives the call, so it schedules nothing. The operator accepted exactly
// this form and asked for a documented exception here instead of a blind spot.
// So this ONE form -- these options in this order, unquoted, at a command
// position (also after a shell keyword, as SCHEDULER_RX reads one), nothing (no
// sudo, env, path) in front of the binary -- is transparent
// to the gate: the prefix and the time tail are replaced by a command separator,
// and the command after them is judged as if it were run directly, so a scheduler,
// a timer or a pane injection behind the prefix is still denied. Every other systemd-run (an
// --on-* or timer option, no --scope, another slice or unit name, another
// property, another order) is not this form and stays denied by SCHEDULER_RX.
// The label charset is the one sf-heavy writes (tr -c 'A-Za-z0-9_.-' '-').
// The GNU time tail is part of the form (teszter 38794): it goes with the prefix,
// so the gate judges the command behind it exactly as if it ran on its own.
// Before, /usr/bin/time was the command the gate saw, and a scheduler behind it
// went through. The tail is exactly `/usr/bin/time -o <file> -f %M`, the file a
// plain word, a plain $NAME or ${NAME}, or a quoted string of those: never a
// command substitution or a backquote, because whatever sits in the removed tail
// is never judged. Any other tail (none, no -o, another format, an expansion in
// the file name) is not the form, and the whole systemd-run stays denied.
// A variable in the file name is read whole: `$AB` is the variable AB, never the
// variable A and a letter B. Measured 2026-09-30 (fejleszto, after teszter 39223):
// with both readings open, a tail that is not the form (`-f %N`) was retried over
// every way to split the names, exponentially: 26 variables of two letters took 1 s
// in a 214-byte command, 32 of them would pass the hook's 10 s limit, and the hook
// fails open. One reading per character keeps the match linear.
const SF_HEAVY_VAR = String.raw`\$[A-Za-z_][A-Za-z0-9_]*(?![A-Za-z0-9_])|\$\{[A-Za-z_][A-Za-z0-9_]*\}`
const SF_HEAVY_TIME_FILE = String.raw`(?:(?:[A-Za-z0-9_./+:@%-]|${SF_HEAVY_VAR})+|'[^'\n]*'|"(?:[A-Za-z0-9_./+:@% -]|${SF_HEAVY_VAR})*")`
// The keywords in front of the form, on the form's own line. With `\s+` they ran over
// the newlines, and every newline is a start of its own, so a run of 30000 `then`
// lines was read again from each line (7.5 s on 150 KB). A keyword on an earlier
// line adds nothing: the newline after it is the start the form is read from.
const SF_HEAVY_KEYWORDS = SHELL_KEYWORDS.replace(/\\s/g, '[ \\t]')
const SF_HEAVY_SCOPE_RX = new RegExp(
  String.raw`(^|[;&|(\`\n])([ \t]*${SF_HEAVY_KEYWORDS})systemd-run[ \t]+--user[ \t]+--scope[ \t]+--quiet[ \t]+--collect[ \t]+--slice=sf-heavy\.slice[ \t]+--unit=sf-heavy-[A-Za-z0-9_.-]+[ \t]+-p[ \t]+MemoryMax=[1-9][0-9]*[KMGT]?[ \t]+--[ \t]+/usr/bin/time[ \t]+-o[ \t]+${SF_HEAVY_TIME_FILE}[ \t]+-f[ \t]+%M(?=[ \t]+[^\s;&|)\`])`,
  'g',
)
export function unwrapSfHeavyScope(command) {
  return String(command ?? '').replace(SF_HEAVY_SCOPE_RX, (_, boundary, ws) => `${boundary}${ws};`)
}

// --- systemd timers -----------------------------------------------------------
//
// Measured 2026-09-27: an agent installed a systemd USER timer in two steps --
// wrote the unit files into ~/.config/systemd/user, then ran `systemctl --user
// enable --now <name>.timer` -- and the timer's job messaged the agent's own
// queue on a finding, so the agent woke up on turns it had scheduled for itself,
// twice in an hour. SCHEDULER_RX catches `systemd-run` (a transient timer in one
// call), but neither of these steps: `systemctl` is not a scheduler binary, and
// writing a file is not an invocation.
//
// An inventory of one install two days later (43 timer units) showed how agents
// actually create them: 36 through Bash (among them 23 a heredoc redirect into
// the unit file and 9 a cp/install of prepared unit files, the unit directory
// often held in a variable), 1 with the Edit tool, and in 9 the write and the
// enable were separate tool calls. So each step is checked on its own, and
// either one alone is a deny:
//   (a) systemctl with a timer argument and a verb that is not a pure read or a
//       disarm. An ALLOWLIST on purpose: enable, start, restart, reenable, link,
//       edit, add-wants, unmask, and any verb systemd adds later arm a timer;
//   (b) a write whose target is a timer unit in a systemd unit directory: a
//       redirect, tee, cp/mv/install/ln/rsync, dd of=, sed -i, a script's write
//       call (open(..., 'w'), write_text, writeFileSync, shutil.copy, ...), and
//       the native Write/Edit/NotebookEdit tools.
// Reading stays allowed: status, show, cat, list-timers, is-active, is-enabled,
// journalctl, cat/ls/grep/diff on a unit file, copying a unit file OUT of the
// directory. So do stopping and disabling a timer, and running a .service once.
//
// Like SCHEDULER_RX, both shell checks read what the SHELL would run: quoted text
// and heredoc bodies are inert (maskInertLiterals), so a message or a card
// comment that quotes the very command is not a deny. A unit name or a path in
// quotes is still an argument, so those are read from the command with only the
// heredoc bodies blanked. Unlike SCHEDULER_RX, one `"...$(...)..."` does not
// send the WHOLE command to the naive split: measured on 3250 real commands that
// mention systemctl, a unit directory or a timer, that fallback let the prose of
// quoted heredoc bodies (messages, card comments) read as commands, and most of
// those commands carry a `"$(date ...)"` somewhere. Here only that one region
// stays visible (maskInertLiterals `strict: false`).
//
// KNOWN LIMITATIONS, the same class as the other anchored checks: a wrapper that
// neither SCHED_PREFIX nor WRAPPER_PREFIX knows (`bash -c '...'`, `xargs`, `nice
// -n 5 ...`), a command fed to an interpreter as a quoted heredoc (`bash
// <<'EOF'`, `ssh host bash -s <<'EOF'`), a unit name that only a runtime
// expansion yields, an existing timer edited through a script's argv, and a
// script file that does it all (the gate sees `bash install.sh`, not what it runs).
//
// A systemd unit directory: the directory systemd loads unit files from, or one
// of its .wants/.requires/.upholds/.d subdirectories (an enable symlink, a
// drop-in). A file elsewhere under it (a `retired/` folder) is never loaded.
const UNIT_DIR_RX = /(?:^|\/)systemd\/(?:user|system)(?:\.control)?(?:\/[^/]+\.(?:wants|requires|upholds|d))?\/?$/
// A line of script code (python, node) that writes, copies or links a file.
// `open(` is followed lazily to its mode argument: the path expression often has
// parentheses of its own (`open(os.path.expanduser('...'), 'w')`).
const SCRIPT_WRITE_RX = /\bopen\s*\(.*?,\s*['"][wax]b?\+?['"]|\.write_(?:text|bytes)\s*\(|\b(?:writeFileSync|appendFileSync|copyFileSync|symlinkSync|renameSync)\s*\(|\bshutil\.(?:copy\w*|move)\s*\(|\bos\.(?:symlink|rename|replace)\s*\(/
// systemctl verbs that only READ state, or that DISARM a timer.
const SYSTEMCTL_SAFE_VERBS = new Set([
  'status', 'show', 'cat', 'help', 'list-units', 'list-timers', 'list-unit-files', 'list-dependencies',
  'list-jobs', 'list-sockets', 'list-paths', 'list-automounts', 'list-machines', 'is-active', 'is-enabled',
  'is-failed', 'is-system-running', 'get-default', 'show-environment', 'daemon-reload',
  'stop', 'disable', 'mask', 'kill', 'reset-failed', 'clean',
])
// systemctl options that take their value as the NEXT word (`-p Prop show x.timer`),
// so the value is not mistaken for the verb.
const SYSTEMCTL_VALUE_OPTS = new Set([
  '-p', '--property', '-P', '-t', '--type', '--state', '-H', '--host', '-M', '--machine', '-n', '--lines',
  '-o', '--output', '-s', '--signal', '--kill-whom', '--kill-value', '--job-mode', '--root', '--image',
  '--what', '--timestamp', '--preset-mode', '--when', '--drop-in', '--message', '--check-inhibitors',
])
// The command word of a segment, as for SCHEDULER_RX: after a shell keyword
// (SHELL_KEYWORDS) and a wrapper (WRAPPER_PREFIX), both defined above.
const TIMER_CMD_RX = new RegExp(
  String.raw`(^|${SCHED_BOUNDARY}\s*)${SHELL_KEYWORDS}${WRAPPER_PREFIX}${SCHED_PREFIX}(systemctl|tee|cp|mv|install|ln|rsync|dd|sed)\b(?!-)(?!\s*=)`,
  'gi',
)

// A unit argument that names a timer: <x>.timer, a glob, or a brace form
// (x.{service,timer}). A `)` or backtick closing a substitution, or punctuation
// after it, is not part of the name; a bare ".timer" names nothing.
function isTimerName(word) {
  const w = String(word).replace(/[)`'",;:.]+$/, '')
  return /[^\s/`'"]\.timer$/i.test(w) || /\{[^}]*\btimer\b[^}]*\}$/i.test(w)
}

// A name the command does not spell out: nothing but a variable, a substitution
// or a glob (`$f`, `${name}`, `*`). `x.service.bak.$TS` is spelled out enough.
function isUnknownName(base) {
  return /^(?:\$\{?[A-Za-z_]\w*\}?|\$\([^)]*\)|[*?]+)$/.test(base)
}

// A path's directory and last component; a trailing slash names a directory.
function splitPath(p) {
  const s = String(p)
  if (s.endsWith('/')) return [s.slice(0, -1), '']
  const k = s.lastIndexOf('/')
  return k === -1 ? ['', s] : [s.slice(0, k), s.slice(k + 1)]
}

// One shell word from index i: quotes removed, a backslash escape resolved.
function readWord(s, i) {
  let w = ''
  while (i < s.length && !/[\s<>]/.test(s[i])) {
    const c = s[i]
    if (c === "'") {
      const e = s.indexOf("'", i + 1)
      const end = e === -1 ? s.length : e
      w += s.slice(i + 1, end); i = end + 1; continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) { w += s[j + 1]; j += 2 } else { w += s[j]; j++ }
      }
      i = j + 1; continue
    }
    if (c === '\\' && i + 1 < s.length) { w += s[i + 1]; i += 2; continue }
    w += c; i++
  }
  return [w, i]
}

// The argument words of one command segment, and the files its output
// redirections write. Enough to read a unit name or a path; it is not a shell.
function shellWords(text) {
  const s = String(text ?? '')
  const words = []
  const outTargets = []
  let i = 0
  while (i < s.length) {
    if (/\s/.test(s[i])) { i++; continue }
    // a redirection: an fd number glued in front (2>), the operator, its target
    const op = /^(?:\d+|&)?(>>?\|?|<<<|<<-?|<>|<)(&?)/.exec(s.slice(i))
    if (op) {
      i += op[0].length
      while (i < s.length && /\s/.test(s[i])) i++
      const [t, e] = readWord(s, i)
      i = e
      if (op[1].startsWith('>') && !op[2]) outTargets.push(t) // `>&2` copies an fd, writes no file
      continue
    }
    const [w, e] = readWord(s, i)
    if (e === i) { i++; continue }
    words.push(w)
    i = e
  }
  return { words, outTargets }
}

// (a) the verb and the units of a `systemctl` call: arms a timer unless the verb
// is on the read/disarm allowlist.
function systemctlArmsTimer(args) {
  let verb = null
  const units = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a.startsWith('-')) { if (SYSTEMCTL_VALUE_OPTS.has(a)) i++; continue }
    if (verb === null) verb = a.toLowerCase().replace(/[)`'",;:.]+$/, '')
    else units.push(a)
  }
  return verb !== null && !SYSTEMCTL_SAFE_VERBS.has(verb) && units.some(isTimerName)
}

// (b) what a write binary writes: dd of=, tee and sed -i write FILES; cp, mv,
// install, ln and rsync COPY their sources to a destination (-t DIR, or the last
// operand), which can be a file or a directory.
function writeTargets(bin, args) {
  const none = { files: [], copies: [] }
  if (bin === 'dd') return { files: args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)), copies: [] }
  const operands = []
  let dest = null
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-t' || a === '--target-directory') { dest = args[++i] ?? null; continue }
    if (a.startsWith('--target-directory=')) { dest = a.slice(a.indexOf('=') + 1); continue }
    if (a.startsWith('-')) continue
    operands.push(a)
  }
  if (bin === 'tee') return { files: operands, copies: [] }
  if (bin === 'sed') return args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a)) ? { files: operands.slice(1), copies: [] } : none
  if (bin === 'install' && args.includes('-d')) return none // creates directories
  if (dest != null) return { files: [], copies: [{ dest, sources: operands }] }
  if (operands.length >= 2) return { files: [], copies: [{ dest: operands[operands.length - 1], sources: operands.slice(0, -1) }] }
  // `ln -s SRC` with one operand links into the working directory
  if (bin === 'ln' && operands.length === 1) return { files: [], copies: [{ dest: '.', sources: operands }] }
  return none
}

// A file written from a heredoc in the command: `cat > inst.sh <<'EOF' ... EOF`.
const HEREDOC_FILE_RX = /(?:^|[\n;&|])[^\n]*?>\s*(["']?)([^\s"'<>;|&]+)\1[^\n]*?<<-?\s*(['"]?)([A-Za-z_]\w*)\3[^\n]*\n([\s\S]*?)\n[ \t]*\4[ \t]*(?=\n|$)/g

// Does this Bash command arm a systemd timer, or write a timer unit into a unit
// directory? `depth` bounds the installer recursion below.
function armsSystemdTimer(command, naiveSegs, depth = 0) {
  // The segments the shell really has (masked: quotes and heredoc bodies blank),
  // and the same spans with only the heredoc bodies blank: quoted arguments are
  // read from those. The two strings have the same length (maskInertLiterals
  // blanks in place). Only an unterminated quote or heredoc falls back to the
  // naive segments here (see the strict: false note above).
  const masked = maskInertLiterals(command, { strict: false })
  const bodiesBlank = maskInertLiterals(command, { quotes: false, strict: false })
  const pairs = []
  if (masked == null || bodiesBlank == null) {
    for (const s of naiveSegs) pairs.push([s, s])
  } else {
    const sep = /&&|\|\||[;&|]|\r?\n/g
    let last = 0
    let m
    while ((m = sep.exec(masked))) {
      pairs.push([masked.slice(last, m.index), bodiesBlank.slice(last, m.index)])
      last = m.index + m[0].length
    }
    pairs.push([masked.slice(last), bodiesBlank.slice(last)])
  }
  // A name the command leaves to a variable or a glob (`"$U/$f"` in a for loop)
  // writes a timer if the command names one anywhere.
  const mentionsTimer = /\.timer\b|[{,]timer[,}]/i.test(String(command ?? ''))
  const vars = {} // literal NAME=value assignments earlier in the same command
  let cwdInUnitDir = false // after `cd <unit dir>`, a relative path is inside it
  const expand = (w) => String(w).replace(/\$\{?([A-Za-z_]\w*)\}?/g, (full, n) => (Object.hasOwn(vars, n) ? vars[n] : full))
  const isUnitDir = (d) => (d === '' || d === '.' ? cwdInUnitDir : UNIT_DIR_RX.test(d))
  const namesTimer = (base) => isTimerName(base) || (isUnknownName(base) && mentionsTimer)
  // A FILE written into a unit directory: a timer unit, or a drop-in of one
  // (x.timer.d/override.conf changes its schedule). A directory itself is not a
  // file (a redirect onto one fails), so `-> ~/.config/systemd/user/` is nothing.
  const writesTimerFile = (t) => {
    const [dir, base] = splitPath(expand(t))
    return base !== '' && base !== '.' && isUnitDir(dir) && (namesTimer(base) || /\.timer\.d$/i.test(dir))
  }
  // A copy INTO a unit directory writes a timer if a source is one; a copy onto
  // a file path is a file write.
  const copiesTimerIn = ({ dest, sources }) => {
    const p = expand(dest)
    const [dir, base] = splitPath(p)
    // the destination directory: `DIR/`, `.`, or a unit directory without the slash
    const destDir = base === '' ? dir : base === '.' ? '' : UNIT_DIR_RX.test(p) ? p : null
    if (destDir === null) return writesTimerFile(dest)
    return isUnitDir(destDir) && sources.some((s) => namesTimer(splitPath(expand(s))[1]))
  }

  for (const [mseg, bseg] of pairs) {
    const lead = mseg.length - mseg.trimStart().length
    const m = mseg.slice(lead)
    const b = bseg.slice(lead)
    const { words, outTargets } = shellWords(b)
    if (outTargets.some(writesTimerFile)) return true
    // a fresh regex per call: a /g regex keeps lastIndex, and this function recurses
    const cmdRx = new RegExp(TIMER_CMD_RX.source, TIMER_CMD_RX.flags)
    let cm
    while ((cm = cmdRx.exec(m))) {
      const bin = cm[2].toLowerCase()
      // a command that starts a substitution ends where the substitution does
      let rest = b.slice(cm.index + cm[0].length)
      const close = cm[1].includes('`') ? rest.indexOf('`') : cm[1].includes('(') ? rest.indexOf(')') : -1
      if (close !== -1) rest = rest.slice(0, close)
      const { words: args } = shellWords(rest)
      if (bin === 'systemctl') {
        if (systemctlArmsTimer(args.map(expand))) return true
        continue
      }
      const { files, copies } = writeTargets(bin, args)
      if (files.some(writesTimerFile) || copies.some(copiesTimerIn)) return true
    }
    // what this segment leaves for the next ones: its assignments, its cd
    const w = words[0] === 'export' || words[0] === 'local' || words[0] === 'readonly' ? words.slice(1) : words
    for (const a of w) {
      const as = /^([A-Za-z_]\w*)=(.*)$/s.exec(a)
      if (!as) break
      if (!/\$\(|`/.test(as[2])) vars[as[1]] = expand(as[2])
    }
    const cmd0 = (words[0] ?? '').replace(/^[({]+/, '')
    if (cmd0 === 'cd' || cmd0 === 'pushd') cwdInUnitDir = UNIT_DIR_RX.test(expand(words[1] ?? ''))
  }
  // An installer written AND run in the same command (measured: 1 of the 36
  // creations wrote `install-...-timer.sh` from a heredoc, then `bash` ran it): the
  // body is checked as commands when the command runs that very file with a shell.
  if (depth < 2 && masked != null) {
    const hereRx = new RegExp(HEREDOC_FILE_RX.source, HEREDOC_FILE_RX.flags) // fresh: see cmdRx
    let h
    while ((h = hereRx.exec(String(command ?? '')))) {
      const file = h[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      // run at a command position (the `cat > file` line itself is not one), with a
      // shell, `source`/`.`, or as ./file; in `masked` a quoted body is blank, so a
      // message that merely SAYS `bash inst.sh` runs nothing. `bash -n` only parses
      // (measured: in 7 of the 8 commands this rule met among 3250 real ones, the
      // arming script was only syntax-checked), so a short option with `n` is no run.
      const runs = new RegExp(String.raw`(?:^|[;&|(\n])\s*(?:(?:bash|sh|zsh|dash|source|\.)\s+(?:(?:--[\w-]+|-(?![A-Za-z]*n)[A-Za-z]+)\s+)*)?["']?(?:\./)?${file}["']?(?=\s|$|[;&|)])`)
      const body = h[5]
      if (runs.test(masked) && armsSystemdTimer(body, splitSegments(body), depth + 1)) return true
    }
  }
  // A script's own write call (python/node, e.g. in a heredoc body), per line.
  return naiveSegs.some((seg) => SCRIPT_WRITE_RX.test(seg) && /systemd\/(?:user|system)(?:\.control)?\/\S*\.timer\b/i.test(seg))
}

// The native file tools: a timer unit written straight into a unit directory.
function isTimerUnitPath(fp) {
  const [dir, base] = splitPath(fp)
  return dir !== '' && UNIT_DIR_RX.test(dir) && isTimerName(base)
}

// The Claude self-schedule store. Blocked for WRITE on any route (a Bash write,
// or the native Write/Edit/NotebookEdit tool); a read/grep is legit diagnostics.
const SCHEDULE_STORE_RX = /scheduled_tasks\.json/i
// Write-intent shell tokens (redirect / tee / in-place edit / dd / copy-move).
const WRITE_INTENT_RX = /(>>?|\btee\b|\bsed\b[\s\S]*\s-i|\bdd\b|\bcp\b|\bmv\b)/i
// Dashboard schedule API. A WRITE method (POST/PUT/PATCH/DELETE) creates/edits a
// self-paced cron; a GET (list / pending / agents) is legit diagnostics -> allowed.
const SCHEDULE_API_RX = /\/api\/schedules\b/i
const HTTP_WRITE_RX = /(-X\s*(POST|PUT|PATCH|DELETE)|--request\s+(POST|PUT|PATCH|DELETE)|(^|\s)(--data\b|--data-\w+\b|-d\b))/i

// Split a compound command into individual simple commands, so a token in one
// segment cannot trip a check anchored in another (e.g. `cat store && cp a b`).
// Line-continuations (backslash-newline) are collapsed FIRST so a single command
// continued across lines stays ONE segment (this is what keeps the
// tmux\<newline>send-keys vector closed); only real separators split.
//
// KNOWN LIMITATIONS (accepted, defense-in-depth -- the runtime tool-deny is the
// primary guard, this Bash hook is a second layer; a sub-agent is not adversarial
// to its own gate, it just must not casually self-pace):
//   - Not quote-aware: a separator INSIDE quotes (e.g. a commit message
//     `git commit -m "fix; crontab -r"`) splits and could false-deny. Rare
//     enough (the quoted ; must be immediately followed by a blocked binary at a
//     segment start) that a full shell-tokenizer is not warranted here.
//   - A $(...) or backtick substitution that assigns a scheduler result
//     (`X=$(crontab -)`, `X=`crontab -``) is caught by SCHEDULER_RX's boundary
//     anchor, which now includes both `(` and the backtick.
export function splitSegments(command) {
  return String(command ?? '')
    .replace(/\\\r?\n/g, ' ')
    .split(/&&|\|\||[;&|]|\r?\n/)
    // trim so a leading-separator segment (" at now") anchors at ^ correctly
    .map((s) => s.trim())
}

// Split like splitSegments, but ONLY on separators the shell would actually
// treat as separators -- never on one that sits inside a quoted string or a
// heredoc body. Returns null when the quoting cannot be resolved with
// confidence, and every caller must then fall back to the naive splitter.
//
// WHY THIS EXISTS (measured 2026-08-05, five denials in one morning -- three
// mine, two taric's): splitSegments is not quote-aware, so PROSE can manufacture
// a command position that never existed. All five denials had the same cause: a
// grep pattern quoted inside an inter-agent message,
//   Minta: stop.sh <bar> launchctl <bar> com.janna.dashboard
// The `<bar>` split it, the middle piece trimmed down to the bare word
// `launchctl`, and SCHEDULER_RX's end-of-segment branch reads a bare `launchctl`
// as a real (interactive) invocation -- correctly, for a real command line.
// Nothing was scheduled; five messages simply never went out. From outside, a
// hard-gate denial is indistinguishable from an agent that stayed silent.
//
// The route decided it: the SAME text passes as `curl -d '<json>'` (the payload
// is blanked by stripDataPayloads) and is denied when sent from a python
// heredoc, which has no -d argument to blank. Choosing how to send a message
// had quietly become a security decision. stripDataPayloads' own comment names
// this false-positive class as its target -- it is implemented for exactly one
// route, so the gap is unfinished work, not an oversight.
//
// SCOPE, and this is the part that matters: the result feeds ONLY the anchored
// scheduler check. The unanchored patterns (tmux+send-keys, nohup+claude,
// claude+/loop) keep scanning naive segments, quoted regions included, because
// they do NOT depend on a command position that prose can fake -- and because
// measurement showed the naive scan is what catches a real
// `subprocess.run(['tmux','send-keys',...])` hidden in a heredoc body. Handing
// them quote-aware segments would have removed the detection of the very
// incident vector this gate was built for, under the banner of a structural fix.
//
// FAIL-CLOSED in three places, because "could not parse" must mean "scan more",
// never "scan less":
//   - unterminated quote or heredoc -> null (caller uses the naive split)
//   - a double-quoted region containing $(...) or a backtick -> null; the shell
//     runs what is inside, so a `;` in there IS a real separator
//   - a heredoc with an UNQUOTED tag whose body contains $(...) or a backtick
//     -> null, same reason (an unquoted tag expands the body)
// NOTE ON THE SHAPE OF THIS FIX. The first attempt made the SEGMENTER
// quote-aware and left the regexes alone. It failed one corpus case:
//   echo 'grep: foo <bar> crontab <bar> bar'
// stayed denied, because SCHEDULER_RX carries its OWN boundary anchor
// (SCHED_BOUNDARY includes the bar), so it re-finds a command position INSIDE a
// segment. Keeping the quoted text in the segment at all was the mistake. The
// `launchctl` cases passed only by luck -- LAUNCHCTL_SUBCOMMAND's lookahead
// happened to reject the following bar. So the primitive is not "split more
// carefully", it is "the inert text must not be there": mask it out, then let
// the existing splitter and regexes run unchanged on what remains.
//
// `{ quotes: false }` blanks the heredoc bodies only and keeps the quoted text as
// it is (same length): a quoted word can be an ARGUMENT -- a unit name, a path --
// and the systemd-timer check reads its arguments from that.
// `{ strict: false }` does not give up on a region that can command-substitute
// (a double-quoted string or an unquoted-tag heredoc body with $(...) or a
// backtick): it keeps THAT region as it is, visible, and masks the rest. Only an
// unterminated quote or heredoc is still null. The scheduler check keeps the
// strict default; the systemd-timer check uses this.
export function maskInertLiterals(command, { quotes = true, strict = true } = {}) {
  const src = String(command ?? '').replace(/\\\r?\n/g, ' ')
  let cur = ''
  let i = 0

  // Inert regions collapse to spaces: the text is gone, and with it every
  // separator inside it -- which is precisely what prose was faking.
  const blank = (s) => ' '.repeat(s.length)
  const quoted = (s) => (quotes ? blank(s) : s)

  while (i < src.length) {
    const c = src[i]

    // backslash escape outside quotes: consumes the next character
    if (c === '\\' && i + 1 < src.length) { cur += src.slice(i, i + 2); i += 2; continue }

    // heredoc: <<TAG / <<-TAG / <<'TAG' / <<"TAG"
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(src.slice(i))
    if (here) {
      const tag = here[1] ?? here[2] ?? here[3]
      const quotedTag = here[1] != null || here[2] != null
      cur += here[0]
      i += here[0].length
      // the body starts after the rest of THIS line
      const nl = src.indexOf('\n', i)
      if (nl === -1) return null // heredoc announced but no body -> cannot resolve
      cur += src.slice(i, nl + 1)
      i = nl + 1
      // find the terminator line (leading tabs allowed for <<-)
      const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
      const rel = endRx.exec(src.slice(i))
      if (!rel) return null // unterminated heredoc
      const body = src.slice(i, i + rel.index)
      if (!quotedTag && /\$\(|`/.test(body)) { // unquoted tag expands the body
        if (strict) return null
        cur += body + rel[0]
        i += rel.index + rel[0].length
        continue
      }
      cur += blank(body) + rel[0]
      i += rel.index + rel[0].length
      continue
    }

    if (c === "'") { // literal until the next ' -- a backslash is NOT special here
      const end = src.indexOf("'", i + 1)
      if (end === -1) return null
      cur += quoted(src.slice(i, end + 1)); i = end + 1; continue
    }

    if (c === '$' && src[i + 1] === "'") { // ANSI-C: \' does escape
      let j = i + 2
      while (j < src.length && src[j] !== "'") { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      cur += quoted(src.slice(i, j + 1)); i = j + 1; continue
    }

    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') { j += src[j] === '\\' ? 2 : 1 }
      if (j >= src.length) return null
      const inner = src.slice(i + 1, j)
      if (/\$\(|`/.test(inner)) { // may run a command -> not inert
        if (strict) return null
        cur += src.slice(i, j + 1); i = j + 1; continue
      }
      cur += quoted(src.slice(i, j + 1)); i = j + 1; continue
    }

    cur += c; i++
  }
  return cur
}

// Blank out curl/HTTP DATA-PAYLOAD arguments before self-pace matching. A -d /
// --data body is data sent over the wire, NEVER a shell invocation, so a trigger
// token that only appears INSIDE the payload must not false-deny. The classic
// false-positive: an /api/messages inter-agent dispatch (a legit peer message in
// a green, operator-authorised review-loop) whose JSON body happens to mention
// "/api/schedules", "tmux send-keys", "scheduled_tasks.json" or "/loop" -- pure
// text, not an invocation. Only PROVABLY-LITERAL payloads are stripped:
// single-quoted '...', ANSI-C $'...', and double-quoted "..." WITHOUT
// $(...)/backtick. A payload that can run a command substitution (double-quoted
// with $(...) / backticks) is left intact so a real command-substitution payload
// is not blanked. Such a payload is then still denied by SCHEDULER_RX, whose
// boundary anchor recognises both `$(` and the backtick as a command boundary,
// so a scheduler binary inside either substitution form is caught. The data FLAG
// itself is kept, so HTTP-write detection (-d /
// --data) is unchanged; the URL and method args live OUTSIDE the payload, so a
// real WRITE to /api/schedules is still denied.
//
// Quote classes match BASH parsing, not C. Inside a plain '...' a backslash is
// LITERAL and the FIRST following ' always closes the string, so the class is
// '[^']*'. A C-style '(?:[^'\\]|\\.)*' would treat \' as an escaped quote and
// scan PAST bash's real closing quote -- e.g. `curl -d 'x\' ; crontab -r` would
// blank the out-of-band `; crontab -r` and let a real self-pace command slip.
// ANSI-C $'...' DOES process \', so that branch keeps the \\. escape form; "..."
// keeps it too (backslash is special inside bash double quotes).
// Human prose in a command-argument position is DATA, not commands. The heredoc
// fix closed one wrapper; this closes the rest of the family: a PR body, a PR
// comment, a release note. The failure mode is identical -- a sentence like
// "runs at the same time" reads as the `at` scheduler at a segment start, and
// the better the prose, the likelier it contains words like at / cron /
// schedule. Same literal-only rule as the other strippers: a double-quoted
// value with $( or ` may substitute, so it is left alone.
const PROSE_FLAGS = String.raw`--body|--message|--notes|--title|--subject|-b|-m|-t`

export function stripProseArguments(seg) {
  const s = String(seg ?? '')
  // Scoped to the tools these prose flags were written for: gh, git, glab (a PR
  // body, a PR comment, a release note). A short flag means different things to
  // different binaries (`tar -t`, `cut -b`, `sort -t`), so blanking it on an
  // unrelated tool would hide real data from the gate (PR #770 review, Szotasz).
  // Same coarse command-word guard as stripGitCommitMessages just below.
  if (!/\b(?:gh|git|glab)\b/i.test(s)) return s
  return s.replace(
    new RegExp(String.raw`((?:^|\s)(?:${PROSE_FLAGS})(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")`, 'gi'),
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full
      return flag + (dq ? '""' : "''")
    },
  )
}

export function stripDataPayloads(seg) {
  return String(seg ?? '').replace(
    /((?:^|\s)(?:-d|--data(?:-(?:raw|binary|ascii|urlencode))?)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full // may substitute -> keep
      return flag + (dq ? '""' : "''") // literal payload -> blank the content
    },
  )
}

// Blank out git commit/tag/stash -m/--message LITERAL text before self-pace
// matching. A commit message is prose, NEVER a shell invocation, so a trigger
// token that only appears INSIDE the message must not false-deny (2026-07-13,
// DrCode: a long `git commit -m "...batch...; at..."` blocked twice, the short
// one passed -- the message text was split as shell segments). Same principle
// and same literal-only quote handling as stripDataPayloads: single-quoted,
// ANSI-C $'...', and double-quoted WITHOUT $(...)/backtick are blanked; a
// double-quoted message that CAN command-substitute (`git commit -m "$(crontab
// -r)"`) is left intact so SCHEDULER_RX still catches the real substitution.
// Scoped to git commit/tag/stash so a `-m` on an unrelated binary is untouched.
// Heredoc bodies are DATA, not commands. A worker writing a real commit message
// through `git commit -F - <<EOF … EOF` had the turn denied because one prose
// line happened to start with "at " -- which SCHEDULER_RX reads as the `at`
// scheduler at a segment start. A heredoc body is data, so blank it before any
// pattern runs. Handles <<- for tab-indented bodies.
//
// EXCEPT when the body can still run something. A QUOTED marker (<<'EOF' or
// <<"EOF") is literal: the shell performs no expansion inside it, so blanking is
// safe. An UNQUOTED marker (<<EOF) is not -- the shell expands $(...) and
// backticks in that body at exec time, so blanking one would hide a live
// command substitution from SCHEDULER_RX and the gate would stop seeing
// something that really runs:
//
//     git commit -m "$(cat <<EOF
//     fix
//     $(at now)
//     EOF
//     )"
//
// This is the same rule the other strippers already apply: stripDataPayloads,
// stripGitCommitMessages and stripProseArguments all leave a double-quoted
// value alone when it contains `$(` or a backtick. An unquoted heredoc is the
// same category; it was simply missing the guard. Reported on PR #770.
// Whether the command word owning a heredoc redirect EXECUTES the body. The
// shell-literal guard above is not enough: a quoted marker (<<'EOF') is literal
// to the SHELL, so blanking looks safe, but `bash <<'EOF'`, `sh`, `ssh box`,
// `python - <<'EOF'` feed the body to an interpreter that runs it -- blanking
// would hide a live scheduler command from the gate (PR #770 review, Szotasz).
// `git commit -F - <<'EOF'` feeds the body to git as DATA, so that stays safe to
// blank. So: keep the body visible when its redirect owner is an interpreter or
// remote/container executor.
const HEREDOC_INTERPRETER_RX = /^(?:bash|sh|zsh|dash|ksh|ash|python[0-9.]*|node|nodejs|ruby|perl|php|ssh)$/

function heredocOwnerRunsBody(before) {
  // `before` is the command text up to the << redirect; the owner is the first
  // word of the last command segment.
  const seg = before.split(/\n|;|\|\|?|&&?|\(|\{/).pop() ?? ''
  const tokens = seg.trim().split(/\s+/).filter(Boolean)
  // Pass-through prefixes that do not change what runs the body.
  while (tokens.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) ||
    ['sudo', 'env', 'nice', 'time', 'exec', 'command', 'nohup', 'stdbuf'].includes(tokens[0]))) {
    tokens.shift()
  }
  if (!tokens.length) return false
  const word = tokens[0].split('/').pop()
  if (HEREDOC_INTERPRETER_RX.test(word)) return true
  // docker/podman/kubectl exec run the body through a shell in the target.
  if (['docker', 'podman', 'kubectl'].includes(word) && tokens.slice(1).includes('exec')) return true
  return false
}

export function stripHeredocBodies(command) {
  const cmd = String(command ?? '')
  if (!/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/.test(cmd)) return cmd
  return cmd.replace(
    /(<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2)([\s\S]*?)(^\s*\3\s*$)/gm,
    (full, open, quote, _marker, body, close, offset, string) => {
      const literal = quote === "'" || quote === '"'
      if (!literal && (body.includes('$(') || body.includes('`'))) return full
      // A quoted body the shell will not expand is still executed when an
      // interpreter/remote-executor owns the redirect -- keep it visible then.
      if (heredocOwnerRunsBody(string.slice(0, offset))) return full
      return `${open}\n${close}`
    },
  )
}

export function stripGitCommitMessages(command) {
  const cmd = String(command ?? '')
  if (!/\bgit\b[\s\S]*\b(commit|tag|stash)\b/i.test(cmd)) return cmd
  return cmd.replace(
    /((?:^|\s)(?:-m|--message)(?:\s+|=))('[^']*'|\$'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/gi,
    (full, flag, arg) => {
      const dq = arg.startsWith('"')
      if (dq && (arg.includes('$(') || arg.includes('`'))) return full // may substitute -> keep
      return flag + (dq ? '""' : "''") // literal message -> blank the content
    },
  )
}

// Normalise two shell-level obfuscations that bash resolves at EXEC time, so an
// invocation whose SHAPE is a real self-pace cannot dodge the slash-command match
// with quoting the shell undoes anyway. Measured end-to-end through the gate hook
// (upstream review, 2026-07-27): `claude \/loop` and `claude$IFS/loop` BOTH run
// `claude /loop` in bash but slipped the `(?:^|[\s'"])\/loop` match -- the char
// before `/loop` was `\` and `S` (end of `$IFS`), neither in the [\s'"] class.
// The fix is NOT to widen that class (that would let more prose through); it is to
// resolve what the shell resolves before matching: `$IFS`/`${IFS}` word-splits to
// a space, and a backslash escape `\X` collapses to `X`. Side effect: also closes
// `claude /lo\op`. Applied ONLY to the self-pace bash patterns below; the
// scheduler/store/API checks keep the raw segment (upstream measured them clean,
// and this PR is scoped to these two loop regressions). This cannot introduce a
// false positive: collapsing escapes / dropping `$IFS` never synthesises the
// literal `tmux`+send-keys, `nohup`+claude, or `claude`+`/loop` tokens out of
// prose -- it only removes an evasion.
export function normalizeShellEvasion(seg) {
  return String(seg ?? '')
    .replace(/\$\{IFS\}|\$IFS\b/g, ' ') // $IFS / ${IFS} -> the space it expands to
    .replace(/\\(.)/g, '$1') // \X -> X (bash unescape of a backslash-escaped char)
}

// Pure decision: does this tool call set up self-pace / self-injection?
export function gateDecision(toolName, toolInput, depth = 0) {
  const name = String(toolName ?? '')
  if (SELF_PACE_TOOLS.has(name)) return { deny: true }
  // Native file tools writing the self-schedule store would bypass any Bash regex.
  if (name === 'Write' || name === 'Edit' || name === 'NotebookEdit') {
    const fp = String(toolInput?.file_path ?? toolInput?.notebook_path ?? '')
    if (SCHEDULE_STORE_RX.test(fp)) return { deny: true }
    // ...and a timer unit written straight into a systemd unit directory
    if (isTimerUnitPath(fp)) return { deny: true }
  }
  if (name === 'Bash') {
    // Strip -d/--data payloads on the WHOLE command BEFORE splitting. A payload is
    // data, not an invocation; and since splitSegments is NOT quote-aware, a shell
    // separator (; && | &) INSIDE a dispatch body would otherwise orphan a fragment
    // that false-matches. Stripping first blanks the body (incl. any separators in
    // it), so the URL/method args still match but the body text never does. A
    // separator OUTSIDE the payload still splits, so `curl -d '' x ; crontab -r`
    // is still caught.
    // The one allowed systemd-run form (SF_HEAVY_SCOPE_RX) is unwrapped FIRST, so
    // every check below judges the command it runs. First, because the heredoc
    // stripper decides by the command that owns a heredoc whether its body runs:
    // behind the prefix that owner is the command the scope runs, and in
    // `systemd-run <the form> bash <<'EOF'` the body goes to bash. Unwrapped after
    // it, the owner would read as systemd-run and the body would be blanked.
    const unwrapped = unwrapSfHeavyScope(String(toolInput?.command ?? ''))
    const safeCommand = stripProseArguments(stripDataPayloads(stripGitCommitMessages(stripHeredocBodies(unwrapped))))
    // A script handed to a shell as text (SHELL_C_RX) is judged as a command of its own.
    if (depth < 3) {
      for (const script of shellCScripts(safeCommand)) {
        if (gateDecision('Bash', { command: script }, depth + 1).deny) return { deny: true }
      }
    }
    // Per-segment so an unrelated token elsewhere in a compound command cannot
    // turn a legit read (store inspection, schedule-API GET) into a false deny.
    const naiveSegs = splitSegments(safeCommand)
    for (const seg of naiveSegs) {
      // Match the self-pace bash patterns against the shell-normalised segment so a
      // `\/loop` / `$IFS/loop` evasion (which bash resolves to `/loop` at exec) is
      // still caught; the scheduler/store/API checks below use the RAW seg (scoped).
      //
      // These stay on the NAIVE segments ON PURPOSE. They are unanchored, so a
      // quoted region is not a hiding place for them -- and the naive scan is
      // what catches a real `subprocess.run(['tmux','send-keys',...])` inside a
      // heredoc body (measured 2026-08-05). Quote-aware segments here would have
      // dropped the detection of this gate's own founding incident vector.
      if (SELF_PACE_BASH_PATTERNS.some((re) => re.test(normalizeShellEvasion(seg)))) return { deny: true }
      // self-schedule store: block WRITE only (a read/grep is legit diagnostics)
      if (SCHEDULE_STORE_RX.test(seg) && WRITE_INTENT_RX.test(seg)) return { deny: true }
      // dashboard schedule API: block WRITE methods only (GET list/pending is legit)
      if (SCHEDULE_API_RX.test(seg) && HTTP_WRITE_RX.test(seg)) return { deny: true }
    }
    // The scheduler check is the ANCHORED one -- it fires on what sits at a
    // segment START -- so it is the one a fake segment boundary can mislead, and
    // the only one that gets quote-aware segments. Null (unresolvable quoting)
    // falls back to the naive split, i.e. to scanning strictly more.
    const masked = maskInertLiterals(safeCommand)
    for (const seg of (masked == null ? naiveSegs : splitSegments(masked))) {
      // scheduler binaries: deny the exec/submit forms, allow pure read-listing
      if (SCHEDULER_RX.test(seg) && !SCHEDULER_READ_RX.test(seg)) return { deny: true }
    }
    // a systemd timer, armed with systemctl or written into a unit directory. The
    // timer check masks the heredoc bodies itself, and reads one only where the
    // command runs the file the body was written to (an installer written and run
    // in one command), so it gets the command before stripHeredocBodies: a body
    // that stripper blanks is exactly the one the installer rule has to read.
    const timerCommand = stripProseArguments(stripDataPayloads(stripGitCommitMessages(unwrapped)))
    if (armsSystemdTimer(timerCommand, splitSegments(timerCommand))) return { deny: true }
  }
  return { deny: false }
}

const GATE_MSG =
  'Self-pace TILTOTT (governance hard-gate). Sub-agentkent NEM utemezhetsz sajat ' +
  'jovobeli turn-t: se ScheduleWakeup/Cron*/RemoteTrigger, se tmux send-keys, se ' +
  'scheduled_tasks.json iras, se /api/schedules POST, se /loop self-pace, se OS-utemezo ' +
  '(crontab, at, systemd-run, systemd timer: systemctl enable/start ... .timer, vagy .timer ' +
  'unit-fajl irasa a systemd unit-konyvtarba). Input-vezerelt ' +
  'vagy: csak az operator (channel) vagy egy peer (inter-agent) uzenete inditson. Ha varakozol, ' +
  'maradj idle a prompt-on -- a beerkezo uzenet majd ujrainditja a turn-t. SOHA ne valaszolj ' +
  'magadnak es SOHA ne dontsd el az operator helyett egy hozza intezett kerdest.'

function allow() { process.exit(0) }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }))
  process.exit(0)
}

function isInvokedDirectly() {
  try {
    const self = realpathSync(fileURLToPath(import.meta.url))
    const entry = process.argv[1] ? realpathSync(process.argv[1]) : ''
    return self === entry
  } catch {
    return false
  }
}
if (isInvokedDirectly()) {
  let payload
  try {
    payload = JSON.parse(readFileSync(0, 'utf-8'))
  } catch {
    allow() // malformed/empty input must never break the agent's tool calls
  }
  const { deny: shouldDeny } = gateDecision(payload?.tool_name, payload?.tool_input)
  if (shouldDeny) deny(GATE_MSG)
  allow()
}
