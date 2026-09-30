import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

// 90a2257b, second part (fejlesztes-vezeto 53192): the scheduler check did not read a
// command after a shell keyword. Measured 2026-09-30 on the branch base (a19fe570) and
// on develop: all seven forms of the first test passed, the bare `crontab -r` was
// denied. SCHEDULER_RX and its read exemption now take the SHELL_KEYWORDS prefix the
// timer check already had. Unit names and paths are made up.
const bash = (command: string): boolean => gateDecision('Bash', { command }).deny
const NL = '\n'
const Q = String.fromCharCode(39)
const SF = 'systemd-run --user --scope --quiet --collect --slice=sf-heavy.slice --unit=sf-heavy-tsc-4242 -p MemoryMax=16G --'
// The real form ends with the GNU time tail (teszter 38794); the tail is part of the allowed form.
const T = '/usr/bin/time -o /tmp/sfh-demo.txt -f %M'

describe('90a2257b (2): a scheduler after a shell keyword is denied', () => {
  it('the seven measured forms', () => {
    expect(bash('if true; then systemd-run --user --on-active=60 /bin/true; fi')).toBe(true)
    expect(bash('if true; then crontab -r; fi')).toBe(true)
    expect(bash('for i in 1; do crontab -r; done')).toBe(true)
    expect(bash('while false; do at now; done')).toBe(true)
    expect(bash('if false; then :; else crontab -r; fi')).toBe(true)
    expect(bash('{ crontab -r; }')).toBe(true)
    expect(bash('! crontab -r')).toBe(true)
  })
  it('elif, until, the condition itself, a nested keyword, launchctl', () => {
    expect(bash('if false; then :; elif true; then crontab -r; fi')).toBe(true)
    expect(bash('until false; do at now + 1 minute; done')).toBe(true)
    expect(bash('if crontab -r; then :; fi')).toBe(true)
    expect(bash('while true; do if true; then crontab -r; fi; done')).toBe(true)
    expect(bash('if true; then launchctl load demo.plist; fi')).toBe(true)
  })
  it('a keyword in front of the wrappers SCHEDULER_RX already reads (sudo, a path, VAR=val)', () => {
    expect(bash('if true; then sudo crontab -r; fi')).toBe(true)
    expect(bash('for i in 1; do /usr/bin/crontab -r; done')).toBe(true)
    expect(bash('if true; then EDITOR=true crontab -e; fi')).toBe(true)
  })
})

describe('90a2257b (2): what stays allowed', () => {
  it('a read after a keyword, as without it', () => {
    expect(bash('if true; then crontab -l; fi')).toBe(false)
    expect(bash('for i in 1; do atq; done')).toBe(false)
    expect(bash('while false; do launchctl list; done')).toBe(false)
  })
  it('ordinary loops and conditions', () => {
    expect(bash('for f in a.txt b.txt; do wc -l "$f"; done')).toBe(false)
    expect(bash('if [ -f x ]; then cat x; else echo none; fi')).toBe(false)
    expect(bash(`while read l; do printf ${Q}%s\\n${Q} "$l"; done < list.txt`)).toBe(false)
  })
  it('prose with then/do and a scheduler: echo, a commit message, a heredoc body', () => {
    expect(bash('echo "if true; then crontab -r; fi"')).toBe(false)
    expect(bash('git commit -m "gate: then crontab -r; do at now"')).toBe(false)
    expect(bash(`cat > /tmp/msg.txt <<${Q}EOF${Q}${NL}then crontab -r${NL}do at now${NL}{ crontab -r; }${NL}EOF`)).toBe(false)
  })
  it('the sf-heavy scope after a keyword stays allowed; a scheduler behind it stays denied', () => {
    expect(bash(`if true; then ${SF} ${T} npx tsc --noEmit; fi`)).toBe(false)
    expect(bash(`for i in 1; do ${SF} ${T} npx tsc --noEmit; done`)).toBe(false)
    expect(bash(`if true; then ${SF} ${T} crontab -r; fi`)).toBe(true)
  })
})
