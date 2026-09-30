import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision, unwrapSfHeavyScope } from '../../scripts/self-pace-gate.mjs'

// 90a2257b (074645b4, ügyvezető 52651 K2): the memory guard starts every heavy compile
// in a foreground, memory-capped systemd scope. That ONE systemd-run form is allowed,
// exactly as written; every other systemd-run stays denied, and the command behind the
// prefix is judged as if it were run directly. Labels, sizes and paths are made up.
const bash = (command: string): boolean => gateDecision('Bash', { command }).deny
const NL = '\n'
const Q = String.fromCharCode(39)
const P = 'systemd-run --user --scope --quiet --collect --slice=sf-heavy.slice --unit=sf-heavy-tsc-4242 -p MemoryMax=16G --'
const TAIL = '/usr/bin/time -o /tmp/sfh-demo.txt -f %M npx tsc --noEmit'

describe('90a2257b: the one systemd-run form is allowed', () => {
  it('the exact form sf-heavy runs, with its /usr/bin/time tail', () => {
    expect(bash(`${P} ${TAIL}`)).toBe(false)
  })
  it('other labels and sizes of the same form (the label charset sf-heavy writes)', () => {
    expect(bash(P.replace('sf-heavy-tsc-4242', 'sf-heavy-next-77') + ' npx next build')).toBe(false)
    expect(bash(P.replace('sf-heavy-tsc-4242', 'sf-heavy-tsc.js-9_1') + ' npx tsc --noEmit')).toBe(false)
    expect(bash(P.replace('MemoryMax=16G', 'MemoryMax=512M') + ' npx tsc --noEmit')).toBe(false)
  })
  it('after a separator, and inside a command substitution', () => {
    expect(bash(`cd /repo && ${P} npx tsc --noEmit -p tsconfig.json`)).toBe(false)
    expect(bash(`echo start; ${P} npx tsc --noEmit | tail -3`)).toBe(false)
    expect(bash(`X=$(${P} npx tsc --noEmit)`)).toBe(false)
  })
})

describe('90a2257b: every other systemd-run stays denied', () => {
  it('the card: --on-active=60, no --scope, another slice, --timer-property', () => {
    expect(bash(P.replace('--collect', '--collect --on-active=60') + ' /bin/true')).toBe(true)
    expect(bash(P.replace(' --scope', '') + ' /bin/true')).toBe(true)
    expect(bash(P.replace('sf-heavy.slice', 'mas.slice') + ' /bin/true')).toBe(true)
    expect(bash(P.replace('--collect', '--collect --timer-property=AccuracySec=1s') + ' /bin/true')).toBe(true)
  })
  it('every --on-* option, before or after the others', () => {
    for (const on of ['--on-active=60', '--on-calendar=hourly', '--on-boot=10', '--on-startup=5', '--on-unit-active=60', '--on-unit-inactive=60', '--on-clock-change', '--on-timezone-change']) {
      expect(bash(P.replace('--user', `--user ${on}`) + ' /bin/true')).toBe(true)
      expect(bash(P.slice(0, -2) + `${on} -- /bin/true`)).toBe(true)
    }
  })
  it('another property instead of or next to MemoryMax', () => {
    expect(bash(P.replace('-p MemoryMax=16G', '-p RuntimeMaxSec=60') + ' /bin/true')).toBe(true)
    expect(bash(P.replace('-p MemoryMax=16G', '-p MemoryMax=16G -p RuntimeMaxSec=60') + ' /bin/true')).toBe(true)
    expect(bash(P.replace('-p MemoryMax=16G', '--property=MemoryMax=16G') + ' /bin/true')).toBe(true)
    expect(bash(P.replace('MemoryMax=16G', 'MemoryMax=infinity') + ' /bin/true')).toBe(true)
  })
  it('another unit name, another order, no command after --', () => {
    expect(bash(P.replace('--unit=sf-heavy-tsc-4242', '--unit=demo-job') + ' /bin/true')).toBe(true)
    expect(bash(P.replace('--user --scope', '--scope --user') + ' /bin/true')).toBe(true)
    expect(bash(P)).toBe(true)
    expect(bash(`${P} ; echo x`)).toBe(true)
  })
  it('a wrapper or a path in front of the binary, and a quoted option value', () => {
    expect(bash(`sudo ${P} /bin/true`)).toBe(true)
    expect(bash(`env A=1 ${P} /bin/true`)).toBe(true)
    expect(bash(`exec ${P} /bin/true`)).toBe(true)
    expect(bash(`/usr/bin/${P} /bin/true`)).toBe(true)
    expect(bash(P.replace('--slice=sf-heavy.slice', '--slice="sf-heavy.slice"') + ' /bin/true')).toBe(true)
  })
})

describe('90a2257b: the command behind the prefix is judged as if run directly', () => {
  it('a scheduler behind the prefix is denied', () => {
    expect(bash(`${P} crontab -r`)).toBe(true)
    expect(bash(`${P} at now`)).toBe(true)
    expect(bash(`${P} systemd-run --user --on-active=60 /bin/true`)).toBe(true)
    expect(bash(`cd /repo && ${P} crontab -r`)).toBe(true)
  })
  it('a timer armed, or a pane injected, behind the prefix is denied', () => {
    expect(bash(`${P} systemctl --user enable --now demo-guard.timer`)).toBe(true)
    expect(bash(`${P} tmux send-keys -t demo ${Q}go${Q} Enter`)).toBe(true)
  })
  it('a read behind the prefix stays allowed, as it is without the prefix', () => {
    expect(bash(`${P} crontab -l`)).toBe(false)
    expect(bash('crontab -l')).toBe(false)
  })
})

describe('90a2257b: controls', () => {
  it('prose that quotes the form stays allowed, even with a scheduler after it', () => {
    expect(bash(`echo "${P} crontab -r"`)).toBe(false)
    expect(bash(`git commit -m "gate: ${P} crontab -r"`)).toBe(false)
    expect(bash(`cat > /tmp/msg.txt <<${Q}EOF${Q}${NL}${P} crontab -r${NL}EOF`)).toBe(false)
  })
  it('unwrapSfHeavyScope replaces only the exact prefix, and leaves any other command byte for byte', () => {
    expect(unwrapSfHeavyScope(`cd /repo && ${P} ${TAIL}`)).toBe(`cd /repo && ; ${TAIL}`)
    for (const cmd of [
      `${P.replace(' --scope', '')} /bin/true`,
      `sudo ${P} /bin/true`,
      `echo "${P} x"`,
      'systemctl --user status demo-guard.timer',
      `${P}`,
    ]) {
      expect(unwrapSfHeavyScope(cmd)).toBe(cmd)
    }
  })
})
