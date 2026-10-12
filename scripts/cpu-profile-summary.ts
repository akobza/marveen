#!/usr/bin/env -S npx tsx
// Ranks a dashboard CPU profile (card ea6f9b07; written by src/web/cpu-profile-window.ts):
//
//   npx tsx scripts/cpu-profile-summary.ts store/cpu-profiles/cpu-<start>.cpuprofile [top]
//
// Prints the sampled total, the idle, GC and (program) parts, then the top
// functions and files by self time (main thread).
import { readFileSync } from 'node:fs'
import { summarizeCpuProfile, type CpuProfile } from '../src/web/cpu-profile-summary.js'

const [file, topArg] = process.argv.slice(2)
if (!file) {
  console.error('usage: npx tsx scripts/cpu-profile-summary.ts <file.cpuprofile> [top]')
  process.exit(2)
}
const s = summarizeCpuProfile(JSON.parse(readFileSync(file, 'utf-8')) as CpuProfile, topArg ? Number(topArg) : 30)
console.log(`sampled ${s.totalMs} ms: idle ${s.idleMs} ms, GC ${s.gcMs} ms, (program) ${s.programMs} ms`)
console.log('\nself time by function (ms):')
for (const f of s.functions) console.log(`${f.ms.toFixed(1).padStart(10)}  ${f.name}`)
console.log('\nself time by file (ms):')
for (const f of s.files) console.log(`${f.ms.toFixed(1).padStart(10)}  ${f.url}`)
