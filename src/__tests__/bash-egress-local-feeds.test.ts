import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { classify, PREFIX_WORDS } from '../../scripts/hooks/bash-egress-parser.mjs'

// 95800e1d (4), 2026-10-13: the LOCAL layer reads the stdin feeds the upstream parser reads (a heredoc of a non-Python
// interpreter, a here-string, a PowerShell -Command, the lines of a `read`) by itself, not only through the upstream second
// opinion of the hook. These cases pin what the upstream test (bash-egress-parser.test.ts) does not: the boundaries of this
// layer's own readings.
const deny = (cmd: string) => classify(cmd).deny

describe('a here-string word stays an argument where it is one', () => {
  it('xargs fed by a here-string still runs curl on the fed URL: denied (the word is not blanked out of the command)', () => {
    expect(classify('xargs -n1 curl -s <<< "https://example.org/x"')).toMatchObject({ deny: true, hosts: ['example.org'] })
  })
  it('CONTROL: the localhost twin passes', () => {
    expect(deny('xargs -n1 curl -s <<< "http://localhost:3420/api/health"')).toBe(false)
  })
  it('a here-string is the program only when the interpreter has no other: a script with a here-string INPUT is not read as code', () => {
    expect(deny(`python3 /nonexistent/run.py <<< "urlopen https://example.org/x"`)).toBe(false)
    expect(classify(`python3 <<< "import urllib.request; urllib.request.urlopen('https://example.org/x')"`)).toMatchObject({ deny: true, reason: 'heredoc-external', hosts: ['example.org'] })
  })
  it('a Python here-string is read the way a Python heredoc is: a localhost call passes, a mention in text passes', () => {
    expect(deny(`python3 <<< "import urllib.request; urllib.request.urlopen('http://localhost:3420/x')"`)).toBe(false)
    expect(deny(`python3 <<< "print('urlopen https://example.org/x')"`)).toBe(false)
  })
  it('a here-string fed to a non-interpreter, non-read command stays inert', () => {
    expect(deny('wc -c <<< "https://example.org/x"')).toBe(false)
  })
})

describe('a bare $NAME in a code body (K2)', () => {
  it('under a quoted tag the shell does not expand it, and the code does not read the environment with it: passes', () => {
    expect(deny(`U=https://example.org/; python3 - <<'PY'\nimport urllib.request; urllib.request.urlopen('http://localhost:3420/$U')\nPY`)).toBe(false)
  })
  it('the code that DOES expand it from the environment (os.path.expandvars) is still denied', () => {
    expect(classify(`U=https://example.org/x python3 - <<'PY'\nimport os, urllib.request; urllib.request.urlopen(os.path.expandvars('$U'))\nPY`))
      .toMatchObject({ deny: true, hosts: ['example.org'] })
  })
  it('CONTROL: an environment read by name is denied as before', () => {
    expect(classify(`U=https://example.org/x python3 - <<'PY'\nimport os, urllib.request; urllib.request.urlopen(os.environ['U'])\nPY`))
      .toMatchObject({ deny: true, hosts: ['example.org'] })
  })
  it('under a bare tag the shell expands it before the code reads it: denied', () => {
    expect(classify(`U=https://example.org/x; python3 - <<EOF\nimport urllib.request; urllib.request.urlopen('$U')\nEOF`))
      .toMatchObject({ deny: true, hosts: ['example.org'] })
  })
})

describe('the upstream rule on a non-Python stdin program (K1, K4)', () => {
  it('perl, ruby, php and PowerShell heredocs with a network primitive and an external URL are denied by this layer', () => {
    for (const cmd of [
      `perl <<'PL'\nuse LWP::Simple; getprint('https://example.org/x');\nPL`,
      `ruby <<'RB'\nrequire 'net/http'; Net::HTTP.get(URI('https://example.org/x'))\nRB`,
      `php <<'P'\n<?php echo file_get_contents('https://example.org/x');\nP`,
      `pwsh -c - <<'PS'\niwr https://example.org/x\nPS`,
      `pwsh -c - <<< "iwr https://example.org/x"`,
    ]) expect({ cmd, r: classify(cmd) }).toMatchObject({ cmd, r: { deny: true, reason: 'heredoc-external', hosts: ['example.org'] } })
  })
  it('CONTROLS: the same bodies to localhost, and an external URL with no network primitive, pass', () => {
    for (const cmd of [
      `perl <<'PL'\nuse LWP::Simple; getprint('http://localhost:3420/x');\nPL`,
      `ruby <<'RB'\nputs 'https://example.org/x'\nRB`,
      `pwsh -c - <<'PS'\nWrite-Output 'https://example.org/x'\nPS`,
    ]) expect({ cmd, deny: deny(cmd) }).toEqual({ cmd, deny: false })
  })
})

describe('the lines of a read (K5)', () => {
  it('a value bound by read from a quoted-tag heredoc is the text itself (no expansion), and is judged', () => {
    expect(classify(`while read u; do curl -s "$u"; done <<'EOF'\nhttps://example.org/x\nEOF`)).toMatchObject({ deny: true, hosts: ['example.org'] })
    expect(deny(`while read u; do curl -s "$u"; done <<'EOF'\n$HOME\nEOF`)).toBe(false)
  })
})

describe('PREFIX_WORDS (K6)', () => {
  it('is exported and holds the launchers the upstream table names', () => {
    expect(PREFIX_WORDS instanceof Set).toBe(true)
    for (const w of ['timeout', 'stdbuf', 'env', 'sudo', 'do']) expect(PREFIX_WORDS.has(w)).toBe(true)
  })
})
