import { describe, it, expect } from 'vitest'
// @ts-expect-error -- plain .mjs hook script, no types
import { classify } from '../../scripts/hooks/bash-egress-parser.mjs'

// f8e45d25 (2026-10-13): a Python heredoc body can resolve a network primitive by a dynamic attribute lookup and call the
// result, which the destination reading did not see -- the name is a string the code mask blanks, and the call is on the
// getattr result, not on a named callee. These cases drove the real hook on the measured live head (3e40ed2f): the first
// passed there and must now deny; the controls must still pass. The pre-fix base is the negative control (it allowed all
// the DENY cases); run this file against 3e40ed2f to see it red.
const EXT = 'https://pelda-f8e45d25.invalid/x'
const py = (body: string) => `python3 - <<'PY'\n${body}\nPY`

describe('a Python heredoc that resolves a network call by getattr', () => {
  const DENY = [
    // the measured case: getattr resolves urlopen and the result is called with the external URL
    `import urllib.request as r; getattr(r, 'urlopen')('${EXT}')`,
    // the name built from pieces, so a literal search for the word does not find it
    `import urllib.request as r\nf = getattr(r, "url" + "open")\nf('${EXT}')`,
    // the getattr result bound first, then called
    `import urllib.request as r\ng = getattr(r, 'urlopen')\ng('${EXT}')`,
    // a session method resolved the same way (.get is a network call too)
    `import requests\ngetattr(requests, 'get')('${EXT}')`,
  ]
  const ALLOW = [
    // the same dynamic resolution to localhost: not external
    `import urllib.request as r; getattr(r, 'urlopen')('http://localhost:3420/api/health')`,
    // getattr to a non-network attribute, even with an external URL sitting in the body as data
    `import os; getattr(os, 'getpid')(); u = '${EXT}'`,
    // the external URL is only carried as data to a localhost call resolved by getattr
    `import urllib.request as r; getattr(r, 'urlopen')('http://localhost:3420/x', data=b'ref: ${EXT}')`,
    // the tester's precision control (f8e45d25 verdict): a non-network attribute resolved the same way and called with an
    // external URL as plain text, so the RESOLVED name decides, not the call shape
    `import logging\ngetattr(logging, 'info')('${EXT}')`,
  ]
  it('denies the external call however the name is resolved', () => {
    for (const body of DENY) expect({ body, r: classify(py(body)) }).toMatchObject({ body, r: { deny: true, hosts: ['pelda-f8e45d25.invalid'] } })
  })
  it('CONTROLS: localhost, a non-network attribute, and the URL as data to a localhost call, all pass', () => {
    for (const body of ALLOW) expect({ body, deny: classify(py(body)).deny }).toEqual({ body, deny: false })
  })
  it('POSITIVE CONTROL: the static form of the same call was already denied', () => {
    expect(classify(py(`import urllib.request as r; r.urlopen('${EXT}')`))).toMatchObject({ deny: true, hosts: ['pelda-f8e45d25.invalid'] })
  })
})
