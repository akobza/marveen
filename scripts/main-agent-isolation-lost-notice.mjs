#!/usr/bin/env node
// The isolation-lost notice of scripts/channels.sh (its trigger 2: the .channels-config dir is on disk, yet this
// boot resolved to the shared ~/.claude), built by the SAME code as the TS respawn guard's (card 40ac420c).
//
// Why: the TS respawn guard says what it MEASURED about MAIN_AGENT_ISOLATED_CONFIG -- the effective value, the
// layer it came from, the state of store/config-overrides.json -- since card 8a4056ad (#1714): an explicit 0 is a
// deliberate setting, a 1 that still ends on the shared root has an unknown cause, only a setting missing
// everywhere draws the "=1, then restart" advice, and the unmeasured 401 claim is gone. channels.sh still sent the
// old fixed sentence ("valoszinuleg elveszett", "torlodott es nincs .env kulcs", "401-veszely", "=1
// visszaallitasa"), which on 2026-09-21 was false on every point. This helper hands channels.sh the TS guard's own
// facts and text instead of a second copy of the wording: dynamic imports from the compiled dist, like
// main-agent-isolated-config.mjs, so there is one source of truth (settings-store.ts getEffectiveSettingSource
// and getOverridesFileState, main-config-decision.ts isolationLostAdvice).
//
// Output contract, on fd 3 (channels.sh calls it with `3>&1 2>>log 1>&2`, because the imported dist modules log
// through pino on fd 1; run by hand without fd 3 it falls back to stdout), two tab-separated lines:
//   setting\t<the measured facts, for the failures-log WARN line>
//   notice\t<the notice as ONE JSON string, ready to be the "content" value of the guard's POST body>
// When the dist modules cannot be loaded it prints NOTHING and exits 0: the caller then uses its own fallback,
// which is the TS guard's text for an unreadable source.
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeSync, fstatSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(__dirname, '..')

let CONTRACT_FD = 3
try { fstatSync(CONTRACT_FD) } catch { CONTRACT_FD = 1 }
const emit = (line) => writeSync(CONTRACT_FD, line)

let store
let decision
try {
  store = await import(join(projectRoot, 'dist', 'settings-store.js'))
  decision = await import(join(projectRoot, 'dist', 'web', 'main-config-decision.js'))
} catch {
  process.exit(0)
}

// The facts exactly as main-config-decision.ts readIsolationSettingFacts reads them (that function is not
// exported): a failure to read is null, which isolationLostAdvice turns into "the source is unreadable".
let facts = null
try {
  const { value, source } = store.getEffectiveSettingSource('MAIN_AGENT_ISOLATED_CONFIG')
  const file = store.getOverridesFileState()
  facts = { value: String(value).trim(), source, overridesFile: file.state, ...(file.cause === undefined ? {} : { overridesFileCause: file.cause }) }
} catch {
  facts = null
}

const setting = facts
  ? `MAIN_AGENT_ISOLATED_CONFIG=${facts.value} (source: ${facts.source}; store/config-overrides.json: ${facts.overridesFile}${facts.overridesFileCause === undefined ? '' : `, ${facts.overridesFileCause}`})`
  : 'MAIN_AGENT_ISOLATED_CONFIG: source unreadable'
// The setting line is one line by construction; the value comes from .env or the overrides file, so a stray
// newline or tab in it must not break the contract.
emit(`setting\t${setting.replace(/[\r\n\t]/g, ' ')}\n`)
emit(`notice\t${JSON.stringify(decision.isolationLostAdvice(facts))}\n`)
