import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// cc457550, config surface: `freshSession` in task-config.json is what turns a task's rounds into fresh,
// per-occurrence sessions. The card's way back is "delete the key, no code change", so two properties matter beyond
// the parse itself: only a literal true enables it (a typo or a string must not silently switch a live task over),
// and a dashboard edit of the task (writeScheduledTask, which knows nothing of the key) must not drop it.
//
// os.homedir() reads $HOME on POSIX and SCHEDULED_TASKS_DIR is computed at import time, so HOME is pointed at a
// throwaway directory BEFORE the module is imported (the pattern of scheduled-task-telegram-chatid-config.test.ts).
const tmpHome = mkdtempSync(join(tmpdir(), 'task-fresh-home-'))
const realHome = process.env.HOME
process.env.HOME = tmpHome

let io: typeof import('../web/scheduled-tasks-io.js')

const writeTask = (taskName: string, config: Record<string, unknown>) => {
  const dir = join(io.SCHEDULED_TASKS_DIR, taskName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${taskName}\ndescription: fixture\n---\n\nrun it\n`)
  writeFileSync(join(dir, 'task-config.json'), JSON.stringify(config, null, 2))
  return dir
}

beforeAll(async () => {
  io = await import('../web/scheduled-tasks-io.js')
})

afterAll(() => {
  process.env.HOME = realHome
  rmSync(tmpHome, { recursive: true, force: true })
})

describe('freshSession in task-config.json', () => {
  it('is true on the parsed task when the config says true', () => {
    writeTask('fresh-task', { schedule: '0 8 * * *', freshSession: true })
    expect(io.readScheduledTask('fresh-task')?.freshSession).toBe(true)
  })

  it('is false when absent, false, or anything but the boolean true', () => {
    writeTask('plain-task', { schedule: '0 8 * * *' })
    expect(io.readScheduledTask('plain-task')?.freshSession).toBe(false)
    for (const v of [false, 'true', 1, 'yes', null]) {
      writeTask('odd-task', { schedule: '0 8 * * *', freshSession: v })
      expect(io.readScheduledTask('odd-task')?.freshSession).toBe(false)
    }
  })

  it('survives a dashboard edit of the task, which does not know the key', () => {
    const dir = writeTask('edited-task', { schedule: '0 8 * * *', freshSession: true })
    io.writeScheduledTask('edited-task', { schedule: '0 12 * * *', description: 'edited' })
    const raw = JSON.parse(readFileSync(join(dir, 'task-config.json'), 'utf-8')) as Record<string, unknown>
    expect(raw.freshSession).toBe(true)
    expect(raw.schedule).toBe('0 12 * * *')
    expect(io.readScheduledTask('edited-task')?.freshSession).toBe(true)
  })

  it('the way back is deleting the key: the task is an ordinary one again', () => {
    const dir = writeTask('rollback-task', { schedule: '0 8 * * *', freshSession: true })
    const raw = JSON.parse(readFileSync(join(dir, 'task-config.json'), 'utf-8')) as Record<string, unknown>
    delete raw.freshSession
    writeFileSync(join(dir, 'task-config.json'), JSON.stringify(raw, null, 2))
    expect(io.readScheduledTask('rollback-task')?.freshSession).toBe(false)
  })
})
