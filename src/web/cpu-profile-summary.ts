// Ranks a CPU profile written by src/web/cpu-profile-window.ts (card ea6f9b07).
// Pure (no logger, no I/O), so scripts/cpu-profile-summary.ts can use it as is.

type ProfileNode = { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }
export type CpuProfile = { nodes: ProfileNode[]; startTime: number; endTime: number; samples: number[]; timeDeltas: number[] }
export type CpuProfileSummary = {
  totalMs: number
  idleMs: number
  gcMs: number
  programMs: number
  functions: Array<{ name: string; ms: number }>
  files: Array<{ url: string; ms: number }>
}

const SPECIAL = new Set(['(root)', '(idle)', '(program)', '(garbage collector)'])

// Self time per function and per file. A sample lasts until the next one (the
// last until endTime), the way DevTools counts it.
export function summarizeCpuProfile(p: CpuProfile, top = 30): CpuProfileSummary {
  const node = new Map(p.nodes.map((n) => [n.id, n]))
  const self = new Map<number, number>()
  let t = p.startTime
  const stamps = p.timeDeltas.map((d) => (t += d))
  for (let i = 0; i < p.samples.length; i++) {
    const next = i + 1 < stamps.length ? stamps[i + 1] : p.endTime
    self.set(p.samples[i], (self.get(p.samples[i]) ?? 0) + Math.max(0, next - stamps[i]))
  }
  const fn = new Map<string, number>()
  const file = new Map<string, number>()
  let idle = 0, gc = 0, program = 0, total = 0
  for (const [id, us] of self) {
    const cf = node.get(id)?.callFrame
    if (!cf) continue
    total += us
    if (cf.functionName === '(idle)') idle += us
    else if (cf.functionName === '(garbage collector)') gc += us
    else if (cf.functionName === '(program)') program += us
    if (SPECIAL.has(cf.functionName)) continue
    const where = cf.url || '(native)'
    const key = `${cf.functionName || '(anonymous)'} ${where}:${cf.lineNumber + 1}`
    fn.set(key, (fn.get(key) ?? 0) + us)
    file.set(where, (file.get(where) ?? 0) + us)
  }
  const ms = (us: number) => Math.round(us / 100) / 10
  const rank = (m: Map<string, number>) => [...m].sort((a, b) => b[1] - a[1]).slice(0, top)
  return {
    totalMs: ms(total),
    idleMs: ms(idle),
    gcMs: ms(gc),
    programMs: ms(program),
    functions: rank(fn).map(([name, us]) => ({ name, ms: ms(us) })),
    files: rank(file).map(([url, us]) => ({ url, ms: ms(us) })),
  }
}
