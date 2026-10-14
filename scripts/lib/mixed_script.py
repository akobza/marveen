#!/usr/bin/env python3
"""The mixed-script word rule, in ONE place for every path that blocks on it.

THE RULE: a word that mixes LATIN with a character that can pass for a Latin
letter is a finding (see is_disguise: every Cyrillic letter, the Greek
lookalikes, and the compatibility forms that fold to Latin). A word written
entirely in another script is NOT -- a Russian quote, a Greek symbol and a
Hungarian word are all legitimate text; a Hungarian word with a Cyrillic
small o (U+043E) inside it is not, because it reads correctly and matches
nothing. Latin next to a character that cannot pass for a Latin letter is
notation, not disguise: "10 us" written with GREEK SMALL LETTER MU, "Delta t"
with the Greek capital, "50 kOhm" with OMEGA or the OHM SIGN, a Chinese label
quoted after a literal backslash-n.

WHY IT LIVES HERE (2026-09-24 review of #1541). Two paths block on this rule:
the outgoing-copy hook (#1509) and the inter-agent send gate (scripts/lib/
homoglyph.py, wired into scripts/agent-msg.sh). The second one shipped with a
rule of its own -- "any Cyrillic or Greek letter" -- and it refused two
legitimate texts that the first one passed: a plain Russian sentence and a
standalone Greek symbol. Two gates that disagree about what is legitimate are
worse than one gate: the sender learns that the rule depends on which script
they happened to call. So the rule is imported, not re-implemented, and the
test suite measures the two paths against one corpus.

NO AUTOMATIC REPLACEMENT lives here either, and that is deliberate (see the
header of src/homoglyph.ts): the look-alike maps by SHAPE, but the intended
word often needs a different letter -- Cyrillic ER looks like `p`, while the
word wanted `r`. The fix is written by someone who read the word.
"""
import re
import unicodedata

# Unicode-aware tokenisation: a latin-only \w+ would CUT a contaminated word
# into pieces at the homoglyph and then find each piece single-script, i.e. the
# tokenizer itself would hide exactly what is being looked for.
UWORD = re.compile(r"[^\W\d_]+", re.UNICODE)


# HOMOGLYPHMICRO924 (#1548, measured 2026-09-24). "Script" here is the FIRST
# WORD of the Unicode name, and for a few characters that word is the name of
# the sign, not a script. "40 µs" (MICRO SIGN), "100 m²" and "5 cm³"
# (SUPERSCRIPT TWO/THREE) and "H₂O" (SUBSCRIPT TWO) all blocked as mixed-script
# words, because a super/subscript digit is not \d, so UWORD takes it into the
# word. These are unit and formula notation; none of them disguises a latin
# letter (the MICRO SIGN's only confusable is the Greek mu).
#
# THE LIST IS DELIBERATELY EXPLICIT. "Every non-letter is neutral" would be too
# wide: ROMAN NUMERAL ONE (U+2160) is a non-letter and looks like a latin I,
# while KELVIN SIGN (U+212A) and ANGSTROM SIGN (U+212B) are letters that look
# like latin K and A. Those stay caught.
#
# IT LIVES HERE, NOT IN THE HOOK, for the same reason as the rule itself: #1548
# fixed this on the hook path only, so the inter-agent send gate still blocked
# "40 µs". One source, one answer, on every path.
SCRIPT_NEUTRAL = frozenset(
    ["\u00b5", "\u00b2", "\u00b3", "\u00b9", "\u2070"]
    + [chr(cp) for cp in range(0x2074, 0x207A)]  # superscript 4..9
    + [chr(cp) for cp in range(0x2080, 0x208A)]  # subscript 0..9
)


def char_script(ch: str) -> str:
    """First word of the Unicode name: LATIN, CYRILLIC, GREEK, ...

    NEUTRAL for the unit/formula characters above: they are neither a script
    to mix nor a letter to disguise."""
    if ch in SCRIPT_NEUTRAL:
        return "NEUTRAL"
    try:
        return unicodedata.name(ch).split(" ")[0]
    except ValueError:
        return "UNKNOWN"


# Back-compat alias: the hook used this private name before the extraction.
_char_script = char_script


# HOMOGLYPHLOOKALIKE1014 (card fbca08d6, decision of 2026-10-14). "Latin with ANY
# other script" stopped legitimate technical text once the rule guarded kanban
# writes. Replayed on a week of real fleet writes (29 154 stored kanban texts):
# the one finding was a test string quoting a Chinese inverter label after a
# literal backslash-n ("n" + two CJK ideographs), and the unit forms written
# with GREEK SMALL LETTER MU (U+03BC), GREEK CAPITAL DELTA (U+0394), GREEK
# CAPITAL OMEGA (U+03A9) and the OHM SIGN (U+2126) all stopped. None of those can pass for a Latin
# letter. What can, and so stays a finding next to Latin:
#   - EVERY Cyrillic letter, not only the lookalikes: the corruption measured in
#     our Hungarian text includes Cyrillic letters with no Latin twin (the
#     measured set is TRIGGER_CHARS in src/homoglyph.ts: U+0431, U+0438, U+043B,
#     U+043F next to U+0430, U+043E);
#   - the Greek letters in GREEK_LOOKALIKE (an explicit list, like
#     SCRIPT_NEUTRAL above: a capital that IS a Latin capital in shape, and the
#     lowercase omicron, rho, nu, iota, kappa, alpha, gamma, upsilon, chi, lunate
#     sigma and yot with their accented forms, which read as Hungarian ó, í, ú,
#     ü). Mu, Delta, Omega, lambda, pi, sigma, omega, beta, eta, tau are notation;
#   - a compatibility form that NFKC folds to Latin letters: KELVIN SIGN,
#     ANGSTROM SIGN, the Roman numerals, fullwidth and mathematical Latin.
# Other scripts (CJK, Armenian, Arabic, ...) next to Latin pass. A Greek or
# other-script lookalike not on the list passes too: the list is the limit of
# this rule, and a new lookalike is added here, with a case in the tests.
GREEK_LOOKALIKE = frozenset(chr(cp) for cp in (
    # capitals shaped like Latin capitals (A B E Z H I K M N O P T Y X, C, J, M, Y)
    0x0391, 0x0392, 0x0395, 0x0396, 0x0397, 0x0399, 0x039A, 0x039C, 0x039D, 0x039F,
    0x03A1, 0x03A4, 0x03A5, 0x03A7, 0x03F9, 0x037F, 0x03FA, 0x03D2,
    # the same capitals with tonos or dialytika (read as accented Latin capitals)
    0x0386, 0x0388, 0x0389, 0x038A, 0x038C, 0x038E, 0x03AA, 0x03AB,
    # lowercase: alpha a, gamma y, iota i, kappa k, nu v, omicron o, rho p,
    # upsilon u, chi x, lunate sigma c, yot j
    0x03B1, 0x03B3, 0x03B9, 0x03BA, 0x03BD, 0x03BF, 0x03C1, 0x03C5, 0x03C7, 0x03F2, 0x03F3,
    # their accented forms (read as á, í, i-diaeresis, ó, ú, ü, ű)
    0x03AC, 0x03AF, 0x03CA, 0x0390, 0x03CC, 0x03CD, 0x03CB, 0x03B0,
))


def is_disguise(ch: str) -> bool:
    """True for a character that can pass for a Latin letter inside a Latin
    word: a Cyrillic letter, a GREEK_LOOKALIKE, or a compatibility form whose
    NFKC folding is Latin letters (KELVIN SIGN -> K, ROMAN NUMERAL ONE -> I)."""
    script = char_script(ch)
    if script in ("LATIN", "NEUTRAL"):
        return False
    if script == "CYRILLIC" or ch in GREEK_LOOKALIKE:
        return True
    folded = unicodedata.normalize("NFKC", ch)
    return folded != ch and folded.isalpha() and all(char_script(c) == "LATIN" for c in folded)


def mixed_script_words(text: str):
    """Return [(word, bad_char, "NAME (U+XXXX)"), ...] for words mixing LATIN
    with a character that can pass for a Latin letter (is_disguise). Pure
    non-Latin words (foreign quotes) and Latin next to notation pass."""
    out = []
    for word in UWORD.findall(text):
        scripts = {char_script(ch) for ch in word} - {"NEUTRAL"}
        if "LATIN" in scripts and len(scripts) > 1:
            bad = next((ch for ch in word if is_disguise(ch)), None)
            if bad is None:
                continue
            try:
                bad_name = unicodedata.name(bad)
            except ValueError:
                bad_name = "UNKNOWN"
            out.append((word, bad, f"{bad_name} (U+{ord(bad):04X})"))
    return out
