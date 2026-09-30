import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { gateDecision } from '../../scripts/self-pace-gate.mjs'

// ffc45c28 (teszter 39223/39224, fejlesztes-vezeto 54307): the PreToolUse hook fails OPEN after
// 10 s, so a gate that is slow on some input is a bypass for whatever that input carries. The
// words in front of a command word were read by overlapping regexes: `time ` x30000 + `true;
// crontab -r` (150 KB) took 10.05 s, and 40 option words of `sudo -u` over 20 s. They are read by
// a loop now (forEachCommandPosition). Every shape below was measured slow before this change
// (kimenet/ffc45c28 redos-meres-3/4); the limit is 1000 ms, and the decision is asserted too.
const bash = (command: string): boolean => gateDecision('Bash', { command }).deny
const NL = '\n'
const Q = String.fromCharCode(39)
const BQ = String.fromCharCode(96)
const SCHED = 'true; crontab -r'
const timed = (command: string): { deny: boolean; ms: number } => {
  const t0 = performance.now()
  const deny = bash(command)
  return { deny, ms: performance.now() - t0 }
}
const within = (command: string, deny: boolean): void => {
  const r = timed(command)
  expect(r.deny).toBe(deny)
  expect(r.ms).toBeLessThan(1000)
}

describe('ffc45c28: a command position is read in linear time', () => {
  it('the tester input, and the same run of other prefix words', () => {
    within('time '.repeat(30000) + SCHED, true)
    within('sudo '.repeat(30000) + SCHED, true)
    within('nice '.repeat(30000) + SCHED, true)
    within('/usr/bin/time '.repeat(10000) + SCHED, true)
    within('then '.repeat(30000) + SCHED, true)
  })
  it('option words that take a value or none (exponential before)', () => {
    within('sudo ' + '-u '.repeat(40) + SCHED, true)
    within('time ' + '-o '.repeat(40) + SCHED, true)
    within('timeout ' + '-s '.repeat(40) + '60 ' + SCHED, true)
    within('xargs ' + '-n '.repeat(20000) + 'crontab -r', true)
    within('env ' + '-u '.repeat(20000) + 'crontab -r', true)
    within('flock ' + '-w '.repeat(20000) + 'f crontab -r', true)
  })
  it('runs of newlines, separators, keywords on their own lines and wrappers with their needed word', () => {
    within(NL.repeat(150000) + SCHED, true)
    within((' \t' + NL).repeat(50000) + SCHED, true)
    within(('then' + NL).repeat(30000) + SCHED, true)
    within(';'.repeat(150000) + 'crontab -r', true)
    within('|'.repeat(150000) + 'crontab -r', true)
    within('&'.repeat(150000) + 'crontab -r', true)
    within('flock f '.repeat(30000) + 'crontab -r', true)
    within('runuser -- '.repeat(30000) + 'crontab -r', true)
  })
  it('a start after every ( and backtick, and a case arm tried at each', () => {
    within('sudo('.repeat(30000) + SCHED, true)
    within('('.repeat(30000) + SCHED, true)
    within('$('.repeat(30000) + 'crontab -r', true)
    within(BQ.repeat(60000) + SCHED, true)
    within('(bash '.repeat(20000) + SCHED, true)
  })
  it('a heredoc body a shell runs', () => {
    within(`bash <<${Q}EOF${Q}${NL}` + ('then' + NL).repeat(30000) + `EOF${NL}crontab -r`, true)
    within('sudo -u a '.repeat(20000) + `bash <<${Q}EOF${Q}${NL}tmux send-keys -t x go Enter${NL}EOF`, true)
  })
})

describe('ffc45c28: the timer check (cc8e80d7) in linear time', () => {
  const unit = '~/.config/systemd/user'
  it('nested substitutions whose arguments each ran to the end of the segment: denied by the reading budget', () => {
    within('$(systemctl status '.repeat(20000) + 'demo.timer', true)
    within('$(systemctl enable '.repeat(20000) + ') demo.timer', true)
    within(BQ + 'systemctl status '.repeat(20000) + 'demo.timer', false)
  })
  it('many redirects, installers, open( calls and unit paths', () => {
    within(`> ${unit}/x `.repeat(20000), false)
    within(`cat > i.sh <<${Q}EOF${Q}${NL}x${NL}EOF${NL}`.repeat(5000) + 'bash i.sh', false)
    within(`cat > i.sh <<${Q}EOF${Q}${NL}`.repeat(5000) + 'bash i.sh demo.timer', false)
    within('demo.timer ' + 'open('.repeat(60000), false)
    within('open(p, ' + Q + 'w' + Q + ') demo.timer ' + 'systemd/user/'.repeat(20000) + 'x', false)
    within('tee ' + 'a '.repeat(20000) + `${unit}/demo.timer`, true)
    within('cp ' + 'demo.timer '.repeat(20000) + `${unit}/`, true)
  })
  it('a real command with several substitutions is far from the budget', () => {
    expect(bash('systemctl --user status $(systemctl --user list-timers --all | head -3) $(systemctl --user show -p Id demo-guard.timer)')).toBe(false)
  })
  it('the installer rule: every redirect on the line counts, and a file run by source, . or ./', () => {
    const body = `<<${Q}EOF${Q}${NL}systemctl --user enable --now demo-guard.timer${NL}EOF${NL}`
    // before, only the first redirect of the line was read: here /dev/null, which is never run
    expect(bash(`cat 2>/dev/null > i.sh ${body}bash i.sh`)).toBe(true)
    expect(bash(`cat > i.sh ${body}source i.sh`)).toBe(true)
    expect(bash(`cat > i.sh ${body}. ./i.sh`)).toBe(true)
    expect(bash(`cat > i.sh ${body}chmod +x i.sh && ./i.sh`)).toBe(true)
    expect(bash(`cat > i.sh ${body}sh -e i.sh`)).toBe(true)
    // CONTROLS: parsed only, or never written (an opener inside another body is its text)
    expect(bash(`cat > i.sh ${body}bash -n i.sh`)).toBe(false)
    expect(bash(`cat > a.sh <<${Q}EOF${Q}${NL}cat > b.sh <<${Q}X${Q}${NL}systemctl --user enable --now demo-guard.timer${NL}X${NL}EOF${NL}bash b.sh`)).toBe(false)
  })
})

describe('ffc45c28: what the loop reads that the regexes did not', () => {
  it('a wrapper by its path, and -- at the end of its options', () => {
    expect(bash('/usr/bin/env crontab -r')).toBe(true)
    expect(bash('/usr/bin/sudo -n crontab -r')).toBe(true)
    expect(bash('nice -- crontab -r')).toBe(true)
    expect(bash('sudo -- crontab -r')).toBe(true)
    expect(bash('timeout -- 60 crontab -r')).toBe(true)
  })
  it('prefix words in any order: an assignment in front of a wrapper with options', () => {
    expect(bash('A=1 sudo -u root crontab -r')).toBe(true)
    expect(bash('LC_ALL=C timeout 60 crontab -r')).toBe(true)
  })
  it('a script handed to a shell behind an assignment or a bare command', () => {
    expect(bash(`A=1 bash -c ${Q}crontab -r${Q}`)).toBe(true)
    expect(bash(`command bash -c ${Q}crontab -r${Q}`)).toBe(true)
  })
  it('a heredoc body fed to a shell behind a wrapper or a keyword (blanked on develop 3f336c2c)', () => {
    const body = `<<${Q}EOF${Q}${NL}tmux send-keys -t demo go Enter${NL}EOF`
    expect(bash(`timeout 60 bash ${body}`)).toBe(true)
    expect(bash(`sudo -u root bash ${body}`)).toBe(true)
    expect(bash(`setsid bash ${body}`)).toBe(true)
    expect(bash(`nice -n 5 bash ${body}`)).toBe(true)
    expect(bash(`for f in a; do bash ${body}${NL}done`)).toBe(true)
    expect(bash(`bash - "$(cat /tmp/demo-arg)" ${body}`)).toBe(true)
  })
})

describe('ffc45c28: controls', () => {
  it('a read of one own schedule behind the same wrappers stays allowed', () => {
    expect(bash('sudo -u root crontab -l')).toBe(false)
    expect(bash('timeout 60 crontab -l')).toBe(false)
    expect(bash('/usr/bin/env launchctl list')).toBe(false)
  })
  it('a heredoc body written to a file, and one a wrapped python runs, is not read as shell lines', () => {
    const body = `<<${Q}EOF${Q}${NL}tmux send-keys -t demo go Enter${NL}EOF`
    expect(bash(`sudo -u root tee /tmp/demo.txt ${body}`)).toBe(false)
    expect(bash(`timeout 60 cat > /tmp/demo.txt ${body}`)).toBe(false)
    // measured on the corpus (5 of 26653): prose in a python string, with a "$(...)" that makes
    // the quoting unresolvable, read as a shell line starting with `at`
    const py = `timeout 60 python3 - "$(cat /tmp/demo-arg)" <<${Q}PY${Q}${NL}txt = """${NL} at; this line is prose${NL}"""${NL}print(txt)${NL}PY`
    expect(bash(py)).toBe(false)
  })
  it('command -v only looks a scheduler up, and a word that only contains one is not it', () => {
    expect(bash('command -v crontab')).toBe(false)
    expect(bash('sudo -u root crontab-helper.sh')).toBe(false)
    expect(bash('timeout 60 netstat -an')).toBe(false)
  })
})
