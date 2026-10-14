#!/usr/bin/env python3
"""The shared mixed-script rule counts only a character that can pass for a Latin letter (HOMOGLYPHLOOKALIKE1014).

Card fbca08d6, measured 2026-10-14 on a week of real fleet writes: "Latin with ANY other script" stopped a test string
that quoted a Chinese inverter label after a literal backslash-n, and the unit forms written with GREEK SMALL LETTER MU,
GREEK CAPITAL DELTA, GREEK CAPITAL OMEGA and the OHM SIGN. None of those can pass for a Latin letter.

What it ASSERTS, on BOTH paths that import the rule (scripts/lib/mixed_script.py :: mixed_script_words for the
outgoing-copy hook, and scripts/lib/homoglyph.py, the checker scripts/agent-msg.sh runs):
  1. still a finding: every Cyrillic letter next to Latin (a lookalike and one without a Latin twin), the Greek
     lookalikes (omicron, a capital, an accented form read as a Hungarian letter), and the compatibility forms that fold
     to Latin (KELVIN SIGN, ANGSTROM SIGN, ROMAN NUMERAL ONE, fullwidth Latin);
  2. no longer a finding: the unit forms above, and Latin next to CJK;
  3. unchanged: a Russian quote, a standalone Greek symbol, Hungarian accents, the micro sign and a superscript.
Every text is built from code points, so this file carries no lookalike itself.

Run:  python3 scripts/__tests__/mixed-script-lookalike.test.py
Exit 0 = all pass; non-zero = a failure (message on stderr).
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, 'scripts', 'lib'))
from mixed_script import mixed_script_words  # noqa: E402

FAILS = []


def check(name, cond, detail=''):
    print(('PASS  ' if cond else 'FAIL  ') + name + (('  -- ' + detail) if detail and not cond else ''))
    if not cond:
        FAILS.append(name)


def gate_refuses(text):
    rc = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'lib', 'homoglyph.py')],
                        input=text, capture_output=True, text=True).returncode
    if rc not in (0, 3):
        raise SystemExit(f'homoglyph.py exited {rc} on {text!r}: not a verdict')
    return rc == 3


c = chr
FINDING = [
    ('Cyrillic small a (a lookalike) inside a Latin word', f'k{c(0x430)}rtya'),
    ('Cyrillic small be (no Latin twin, measured in corrupted text) inside a Latin word', f'sza{c(0x431)}aly'),
    ('Greek small omicron inside a Latin word', f'h{c(0x3BF)}oks'),
    ('Greek capital alpha at the head of a Latin word', f'{c(0x391)}PI'),
    ('Greek small omicron with tonos, read as a Hungarian o-acute', f'f{c(0x3CC)}kusz'),
    ('KELVIN SIGN inside a Latin word', f'{c(0x212A)}elvin'),
    ('ANGSTROM SIGN inside a Latin word', f'{c(0x212B)}ngstrom'),
    ('ROMAN NUMERAL ONE inside a Latin word', f'verz{c(0x2160)}o'),
    ('fullwidth Latin capital A inside a Latin word', f'{c(0xFF21)}PI'),
]
PASSES = [
    ('a unit written with GREEK SMALL LETTER MU', f'p95 = 10 {c(0x3BC)}s'),
    ('Delta t with the Greek capital', f'{c(0x394)}t = 5 s'),
    ('kilo-ohm written with GREEK CAPITAL OMEGA', f'50 k{c(0x3A9)}'),
    ('kilo-ohm written with the OHM SIGN', f'50 k{c(0x2126)}'),
    ('the measured case: a Chinese label after a literal backslash-n',
     f'2306123456\\n{c(0x578B)}{c(0x53F7)}{c(0xFF1A)}SUN-10K-SG04LP3-EU'),
    ('a Chinese label next to digits', f'{c(0x5E8F)}{c(0x5217)}{c(0x53F7)}{c(0xFF1A)}2306123456'),
    ('a Russian quote', f'Idezet: {c(0x418)}{c(0x434)}{c(0x451)}{c(0x442)} {c(0x434)}{c(0x43E)}{c(0x436)}{c(0x434)}{c(0x44C)}'),
    ('a standalone Greek symbol', f'{c(0x3C0)} r^2'),
    ('Hungarian accents', 'Árvíztűrő tükörfúrógép'),
    ('the micro sign and a superscript', f'40 {c(0xB5)}s, 100 m{c(0xB2)}'),
]

for name, text in FINDING:
    hits = mixed_script_words(text)
    check(f'FINDING (hook rule): {name}', hits != [], ascii(hits))
    check(f'FINDING (agent-msg gate): {name}', gate_refuses(text))
for name, text in PASSES:
    hits = mixed_script_words(text)
    check(f'PASSES (hook rule): {name}', hits == [], ascii(hits))
    check(f'PASSES (agent-msg gate): {name}', not gate_refuses(text))

# A unit sign does not shield a lookalike in the same word, and the report names the lookalike, not the unit sign.
hit = mixed_script_words(f'k{c(0x3A9)}{c(0x430)}rd')
check('a Greek Omega next to a Cyrillic a: the Cyrillic a is reported',
      len(hit) == 1 and hit[0][1] == c(0x430), ascii(hit))

if FAILS:
    sys.stderr.write(f'{len(FAILS)} FAIL: {FAILS}\n')
    sys.exit(1)
print('ALL PASS')
