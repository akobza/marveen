import { describe, it, expect, afterAll } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
// @ts-expect-error -- plain .mjs hook script, no types
import { pythonBodyPlan, pythonCodeOnly } from '../../scripts/hooks/bash-egress-parser.mjs'

// 95800e1d (3), 2026-10-12: a Python heredoc body can run code the destination reading does not see as code -- a
// string handed to exec / eval / compile, a fullwidth name, an f-string's braces, a file it writes and then runs or
// imports, a command line it starts, a loop value the shell puts into an unquoted heredoc. These cases drive the REAL
// hook process. Measured: of the 35 upstream-test calls still allowed after the second opinion, these readings close
// 26; on the fleet's Bash corpus (543 563 commands) they add no sub-agent deny. The rest is pinned below on purpose.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = join(ROOT, 'scripts', 'hooks', 'bash-egress-parser.mjs')
const dirs: string[] = []
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(d)
  return d
}
function run(command: string) {
  const dir = tmp('egress-pyruns-')
  writeFileSync(join(dir, 'none.json'), '{}')
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: ROOT }),
    encoding: 'utf-8',
    env: { ...process.env, BASH_EGRESS_BLOCK_LOG: join(dir, 'blocks.jsonl'), BASH_EGRESS_VENDOR_HOSTS: join(dir, 'none.json') },
  })
  return { rc: r.status, deny: r.stdout.includes('"permissionDecision":"deny"'), stdout: r.stdout }
}
const PY = (body: string) => `python3 - <<'PY'\n${body}\nPY`
const CALL = "import urllib.request; urllib.request.urlopen('https://example.org/')"

describe('a Python heredoc body that runs code the destination reading does not see', () => {
  const closed: Array<[string, string]> = [
    ['a loop value the shell puts into an unquoted heredoc', `for u in https://example.org/; do python3 - <<EOF\nimport urllib.request; urllib.request.urlopen('$u')\nEOF\ndone`],
    ['a fullwidth exec (Python reads names as NFKC)', PY("\uff45\uff58\uff45\uff43('import urllib.request as u; u.urlopen(\"https://evil.example/x\")')")],
    ['a fullwidth urlopen', PY("import urllib.request\nurllib.request.\uff55\uff52\uff4c\uff4f\uff50\uff45\uff4e('https://evil.example/x')")],
    ['exec of a literal', PY(`exec("${CALL}")`)],
    ['eval of a literal', PY("eval(\"__import__('urllib.request').request.urlopen('https://example.org/')\")")],
    ['compile of a literal', PY(`code = compile("${CALL}", 'x', 'exec')`)],
    ['exec of a name bound to a literal', PY(`src = "${CALL}"\nexec(src)`)],
    ['a call inside f-string braces', PY("import urllib.request\nprint(f\"{urllib.request.urlopen('https://example.org/').read()}\")")],
    ['a written file run by os.system', PY(`open('/tmp/x.py','w').write("${CALL}")\nimport os; os.system('python3 /tmp/x.py')`)],
    ['a written file run by subprocess', PY(`open('/tmp/x.py','w').write("${CALL}")\nimport subprocess; subprocess.run(['python3', '/tmp/x.py'])`)],
    ['a written file run by runpy', PY(`open('/tmp/x.py','w').write("${CALL}")\nimport runpy; runpy.run_path('/tmp/x.py')`)],
    ['a written module, imported', PY(`open('/tmp/x.py','w').write("${CALL}")\nimport x`)],
    ['a written module, imported in a try', PY(`open('/tmp/x.py','w').write("${CALL}")\ntry: import x\nexcept ImportError: pass`)],
    ['a written module through `with open(...) as f`', PY(`with open('/tmp/x.py', 'w') as f:\n    f.write("${CALL}")\nfrom x import y`)],
    ['a subprocess command line that is itself an external call', PY("import subprocess\nsubprocess.run(['curl', '-s', 'https://example.org/'])")],
    ['an os.system command line that is itself an external call', PY("import os\nos.system('curl -s https://example.org/')")],
  ]
  for (const [name, command] of closed) {
    it(`⛔ denies ${name}`, () => {
      const r = run(command)
      expect(r.rc).toBe(0)
      expect(r.deny).toBe(true)
    })
  }
  it('⛔ a string it cannot read to the end is not vouched for: a primitive and an external URL deny', () => {
    expect(run(PY("x = 'urlopen https://example.org/")).deny).toBe(true)
    expect(run(PY('x = ab"urlopen https://example.org/"')).deny).toBe(true)
  })
})

describe('the same machinery does not deny an external URL carried as data (the fleet corpus shapes)', () => {
  it('a localhost post through a subprocess curl, an external link only in the posted text', () => {
    const r = run(PY("import json, subprocess\nbody = json.dumps({'content': 'see https://github.com/o/r/pull/1'})\nsubprocess.run(['curl', '-s', '-X', 'POST', 'http://localhost:3420/api/kanban/x/comments', '-d', body])"))
    expect(r.deny).toBe(false)
  })
  it('a hook test harness: command fixtures as data, the program started with a non-literal path', () => {
    const r = run(PY("import json, subprocess\ncases = {'curl': 'curl -s https://example.org/'}\nfor k, c in cases.items():\n    subprocess.run(['node', f'scripts/hooks/{k}.mjs'], input=json.dumps({'command': c}), text=True)"))
    expect(r.deny).toBe(false)
  })
  it('a docker exec next to a localhost request whose header names an external URL', () => {
    const r = run(PY("import urllib.request, subprocess\nurllib.request.urlopen(urllib.request.Request('http://127.0.0.1:18973/x.js', headers={'Referer': 'https://crm.example/portal'}))\nsubprocess.run(['docker', 'exec', 'c1', 'cat', '/tmp/access.log'])"))
    expect(r.deny).toBe(false)
  })
  it('exec of a slice of a file read at run time (not a literal)', () => {
    const r = run(PY("src = open('scripts/x.py').read()\ng = {}\nexec(src[0:100], g)\nprint(g['f']('curl -s https://db.example/api'))"))
    expect(r.deny).toBe(false)
  })
  it('a script started through subprocess gets the verdict it gets when run directly', () => {
    const dir = tmp('egress-pyruns-helper-')
    const quiet = join(dir, 'quiet.py')
    writeFileSync(quiet, "import sys, urllib.request\nurllib.request.urlopen(sys.argv[2])\n")
    const loud = join(dir, 'loud.py')
    writeFileSync(loud, "import urllib.request\nurllib.request.urlopen('https://example.org/')\n")
    expect(run(`python3 ${quiet} --url https://api.example.com/x`).deny).toBe(false)
    expect(run(PY(`import subprocess\nsubprocess.run(['python3', '${quiet}', '--url', 'https://api.example.com/x'])`)).deny).toBe(false)
    expect(run(`python3 ${loud}`).deny).toBe(true)
    expect(run(PY(`import subprocess\nsubprocess.run(['python3', '${loud}'])`)).deny).toBe(true)
  })
})

describe('still open -- pinned on purpose', () => {
  it('the localhost call carrying an external URL as data (the fleet false-deny class) stays allowed', () => {
    expect(run(PY("import urllib.request\nurllib.request.urlopen('http://localhost:3420/api/messages', data=b'PR: https://github.com/o/r/pull/1')")).deny).toBe(false)
  })
  it('a dynamic lookup that is never called stays allowed', () => {
    expect(run(PY("m = __import__('urllib.request'); u = \"https://example.org/\"")).deny).toBe(false)
  })
  it('a written file that is not code, then run, stays allowed', () => {
    expect(run(PY("import os\nopen('/tmp/x.py','w').write(\"urlopen https://example.org/\")\nos.popen('python3 /tmp/x.py')")).deny).toBe(false)
  })
  it('a node body that only mentions a call in text it writes stays allowed', () => {
    expect(run("node <<'JS'\nrequire('fs').writeFileSync('n.md', \"call fetch('https://example.org/') like this\")\nJS").deny).toBe(false)
  })
})

// test finding (1): the upstream second opinion's exception must look at the heredoc that gave the deny, not
// at the whole command. On the whole command a perl/ruby external heredoc passed whenever the command ALSO held a
// harmless python/node heredoc, or only the TEXT `python3 - <<` (echo, comment). These shapes are the tester's K4/K5/K13.
describe('the upstream exception is per-heredoc, not whole-command', () => {
  const X = 'https://kulso-teszt-95800.invalid/x'
  const PERL = `perl - <<'PL'\nuse LWP::Simple; print get("${X}");\nPL`
  const RUBY = `ruby - <<'RB'\nrequire 'net/http'; Net::HTTP.get(URI("${X}"))\nRB`
  const PY_BENIGN = "python3 - <<'PY'\nprint(1)\nPY"
  const NODE_BENIGN = "node - <<'JS'\nconsole.log(1)\nJS"
  const closed: Array<[string, string]> = [
    ['K4: a harmless python heredoc before a perl external heredoc', PY_BENIGN + '\n' + PERL],
    ['K13: a harmless node heredoc before a ruby external heredoc', NODE_BENIGN + '\n' + RUBY],
    ['K5: the text `python3 - <<` in an echo before a perl external heredoc', 'echo "python3 - <<" > /dev/null; ' + PERL],
  ]
  for (const [name, command] of closed) {
    it(`⛔ denies ${name}`, () => {
      const r = run(command)
      expect(r.rc).toBe(0)
      expect(r.deny).toBe(true)
    })
  }
  it('a lone perl external heredoc is denied (control)', () => {
    expect(run(PERL).deny).toBe(true)
  })
  it('a python heredoc carrying an external URL as data, next to a harmless node heredoc, stays allowed', () => {
    const PY_DATA = `python3 - <<'PY'\nimport urllib.request, json\nurllib.request.urlopen(urllib.request.Request('http://localhost:3420/api/x', data=json.dumps({'u': '${X}'}).encode()))\nPY`
    expect(run(NODE_BENIGN + '\n' + PY_DATA).deny).toBe(false)
  })
  // K6 in the verdict (`# node - <<` comment before a perl external heredoc) is NOT closed here: the upstream parser
  // itself does not flag it (its heredoc scan is thrown by the `<<` in the comment line), so there is no upstream deny
  // for the exception to narrow. It equals today's behaviour (the local layer does not parse perl heredocs either); it
  // is one of the still-open perl shapes, not a regression. Pinned so a later upstream fix is a deliberate flip.
  it('K6: a `# ... <<` comment before a perl external heredoc stays allowed (upstream does not flag it)', () => {
    expect(run('# node - << csak megjegyzes\n' + PERL).deny).toBe(false)
  })
})

describe('pythonCodeOnly and pythonBodyPlan', () => {
  it('blanks an f-string text and keeps its braces as code, length-preserving; an unreadable body is null', () => {
    const src = 'x = f"run exec {a} and {b[\'k\']} {{lit}}"'
    const m = pythonCodeOnly(src)
    expect(m.length).toBe(src.length)
    expect(m).not.toContain('exec')
    expect(m).toContain('{a}')
    expect(m).toContain("{b[' ']}")
    expect(pythonCodeOnly('f"{x"')).toBe(null)
    expect(pythonCodeOnly("x = 'open")).toBe(null)
  })
  it('collects the command lines a body starts and the files it writes', () => {
    const p = pythonBodyPlan("import os, subprocess as sp\nopen('/tmp/a.py', 'w').write('print(1)')\nsp.run(['git', 'log', '-1', 'a b'])\nos.system('ls -la')\nos.execv('/usr/bin/python3', ['python3', '/tmp/a.py'])\nimport importlib.util\ns = importlib.util.spec_from_file_location('h', '/srv/h.py')")
    expect(p.runs).toEqual(["git log -1 'a b'", 'ls -la', '/usr/bin/python3 /tmp/a.py', 'python3 /srv/h.py'])
    expect(p.written).toEqual([['/tmp/a.py', 'print(1)']])
    expect(p.hosts).toEqual([])
  })
  it('a non-literal command line or path is not read', () => {
    const p = pythonBodyPlan("import subprocess\nsubprocess.run(['curl', url])\nsubprocess.run(cmd, shell=True)")
    expect(p.runs).toEqual([])
  })
})
