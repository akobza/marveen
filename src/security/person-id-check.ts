/**
 * Card 7b964221: the pre-commit run of the secret gate also looks for KNOWN PERSON IDENTIFIERS.
 *
 * Measured case: a real owner chat id, written into a test as the mocked value of a chat-id
 * environment variable, passed this gate with "no channel material". The channel-material
 * detector looks for SHAPES (`message_id NNN:`, a `"chat_id": N` dump, a wrapper tag); a bare
 * number in a test literal has none of them. Which number is a real person is something only the
 * local configuration knows, so the gate cannot decide it from the text alone.
 *
 * Hence no list of our own: the check runs the existing identifier scanner
 * (scripts/person-id-scan.py) on the staged diff. ONE list, ONE loader -- every
 * `.claude/channels/<provider>/access.json` allowFrom and the `store/principals.json` keys, read
 * at run time. No identifier is ever written into the repository, not even as a hash: the hash of
 * a ten-digit number is one lookup away from the number.
 *
 * Three outcomes, and the third one is said out loud:
 *   clean    the scanner loaded the list and found none of it in the staged additions
 *   found    file:line and the identifier MASKED (the scanner prints the last 3 characters only)
 *   not-run  the check gave no answer: not the pre-commit mode (a CI checkout has no list), no
 *            scanner in this tree, no python3, a missing or unreadable configuration, a timeout.
 *            This does not fail the commit, but the gate's PASS line must then not claim it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface PersonIdFinding {
  file: string;
  line: number;
  /** As the scanner prints it: asterisks and the last 3 characters. */
  masked: string;
}

export type PersonIdOutcome =
  | { status: 'clean'; identifiers: number | null; scannedLines: number | null }
  | { status: 'found'; findings: PersonIdFinding[] }
  | { status: 'not-run'; reason: string };

export interface PersonIdCheckOptions {
  /** The gate's mode. Only `--staged` runs the check. */
  mode: string;
  /** Unified diff of what is about to be committed; its added lines are scanned. */
  diff: string;
  /** Path of scripts/person-id-scan.py. */
  scanner: string;
  /** The tree that holds the configuration; omitted, the scanner resolves it itself. */
  root?: string;
  timeoutMs?: number;
  python?: string;
}

/** A commit hook must not hang: past this the check is reported as not run. */
export const PERSON_ID_TIMEOUT_MS = 15_000;

const FOUND_HEADER = /^FOUND \d+ identifier occurrence/m;
const FINDING_LINE = /^ {2}(.+):(\d+) {2}(\S+)$/gm;

export function checkPersonIds(opts: PersonIdCheckOptions): PersonIdOutcome {
  if (opts.mode !== '--staged') {
    return {
      status: 'not-run',
      reason: `mode ${opts.mode}: the identifier list lives only in this machine's configuration, so only the pre-commit run (--staged) checks for it`,
    };
  }
  if (!existsSync(opts.scanner)) {
    return { status: 'not-run', reason: `the identifier scanner is not in this tree (${opts.scanner})` };
  }

  const timeoutMs = opts.timeoutMs ?? PERSON_ID_TIMEOUT_MS;
  const r = spawnSync(opts.python ?? 'python3', [opts.scanner, '--diff', '-', ...(opts.root ? ['--root', opts.root] : [])], {
    input: opts.diff,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') return { status: 'not-run', reason: `the identifier scanner did not finish within ${timeoutMs / 1000} s` };
    if (code === 'ENOENT') return { status: 'not-run', reason: `${opts.python ?? 'python3'} is not available` };
    return { status: 'not-run', reason: `the identifier scanner could not be started: ${r.error.message}` };
  }

  if (r.status === 0) {
    const ids = /=> (\d+) distinct identifiers/.exec(r.stdout);
    const lines = /\((\d+) lines scanned\)/.exec(r.stdout);
    return { status: 'clean', identifiers: ids ? Number(ids[1]) : null, scannedLines: lines ? Number(lines[1]) : null };
  }

  if (r.status === 2) {
    // The scanner's own "unmeasured" exit: configuration missing, unreadable or empty, or its
    // self-check did not fire. Its reason is the first UNMEASURED line (it never names an id).
    const first = r.stderr.split('\n').find((l) => l.startsWith('UNMEASURED:'));
    return { status: 'not-run', reason: first ? first.replace(/^UNMEASURED:\s*/, '') : 'the identifier scanner could not measure' };
  }

  if (r.status === 1 && FOUND_HEADER.test(r.stdout)) {
    const findings = [...r.stdout.matchAll(FINDING_LINE)].map((m) => ({ file: m[1], line: Number(m[2]), masked: m[3] }));
    // The scanner said it found something. An output we could not parse must still block.
    return { status: 'found', findings: findings.length ? findings : [{ file: '(scanner output not parsed)', line: 0, masked: '***' }] };
  }

  // A Python traceback also exits 1, so exit 1 without the FOUND header is a crash, not a finding.
  const last = r.stderr.trim().split('\n').pop()?.slice(0, 200) ?? '';
  return { status: 'not-run', reason: `the identifier scanner failed (exit ${r.status ?? r.signal})${last ? `: ${last}` : ''}` };
}
