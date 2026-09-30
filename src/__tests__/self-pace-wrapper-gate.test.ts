import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

// ffc45c28 (fejlesztes-vezeto 53354): the scheduler check did not read `sudo` with options or
// `timeout <duration>` in front of the command word. Measured 2026-09-30 on develop and on the
// branch base: `sudo -n crontab -r`, `sudo -u root crontab -r` and `timeout 60 crontab -r`
// passed, while `sudo crontab -r` was denied. SCHEDULER_RX and its read exemption now take the
// WRAPPER_PREFIX the timer check already had. Unit names and paths are made up.
const bash = (command: string): boolean => gateDecision('Bash', { command }).deny
const NL = '\n'
const Q = String.fromCharCode(39)

describe('ffc45c28: a scheduler behind an option sudo or a timeout is denied', () => {
  it('the three measured forms', () => {
    expect(bash('sudo -n crontab -r')).toBe(true)
    expect(bash('sudo -u root crontab -r')).toBe(true)
    expect(bash('timeout 60 crontab -r')).toBe(true)
  })
  it('other options and schedulers behind them', () => {
    expect(bash('sudo -n -u root crontab -e')).toBe(true)
    expect(bash('sudo --user=root at now')).toBe(true)
    expect(bash('timeout -s KILL 60 crontab -r')).toBe(true)
    expect(bash('timeout 30 systemd-run --user --on-active=60 /bin/true')).toBe(true)
    expect(bash('sudo -n launchctl load demo.plist')).toBe(true)
  })
  it('the timer check reads the same wrapper: a timeout with a valued option in front of systemctl', () => {
    // measured on the branch base: passed there, the plain `timeout 60` was denied
    expect(bash('timeout -s KILL 60 systemctl --user start demo-guard.timer')).toBe(true)
    expect(bash('timeout 60 systemctl --user start demo-guard.timer')).toBe(true)
  })
  it('after a separator, a keyword or a substitution', () => {
    expect(bash('cd /tmp && sudo -n crontab -r')).toBe(true)
    expect(bash('if true; then sudo -n crontab -r; fi')).toBe(true)
    expect(bash('X=$(timeout 60 crontab -r)')).toBe(true)
  })
})

describe('ffc45c28: what stays allowed', () => {
  it('a read behind the wrapper, as without it', () => {
    expect(bash('sudo -n crontab -l')).toBe(false)
    expect(bash('sudo -u root launchctl list')).toBe(false)
    expect(bash('timeout 10 crontab -l')).toBe(false)
  })
  it('ordinary commands behind the same wrappers', () => {
    expect(bash('sudo -n true')).toBe(false)
    expect(bash(`sudo -u postgres psql -c ${Q}select 1${Q}`)).toBe(false)
    expect(bash('timeout 60 npx tsc --noEmit')).toBe(false)
  })
  it('prose that quotes the forms: echo, a commit message, a heredoc body', () => {
    expect(bash('echo "sudo -n crontab -r"')).toBe(false)
    expect(bash('git commit -m "gate: timeout 60 crontab -r"')).toBe(false)
    expect(bash(`cat > /tmp/msg.txt <<${Q}EOF${Q}${NL}sudo -n crontab -r${NL}timeout 60 crontab -r${NL}EOF`)).toBe(false)
  })
})
