import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Card 3ed09d25: notify.ts resolves the owner chat AT SEND TIME with the shared
// resolver (the provider's configured id, then the main agent's paired
// access.json), not from the CHANNEL_CHAT_ID frozen at boot. On 2026-09-16 the
// installer placeholder (0) in the .env sent 470 alerts to nobody during an
// 18-hour fleet outage, while the owner's chat sat in access.json. And an alert
// that still has nowhere to go is not dropped in silence.
const { cfg, mockSend, mockWarn, stateRoot } = vi.hoisted(() => ({
  cfg: { provider: 'telegram', token: 'bot-token', chatId: '0' },
  mockSend: vi.fn(async (..._a: unknown[]) => {}),
  mockWarn: vi.fn(),
  stateRoot: { dir: '' },
}))

vi.mock('../config.js', () => ({
  get CHANNEL_PROVIDER() { return cfg.provider },
  get CHANNEL_TOKEN() { return cfg.token },
  get CHANNEL_CHAT_ID() { return cfg.chatId },
  get ALLOWED_CHAT_ID() { return cfg.chatId },
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: '/tmp/notify-owner-chat-runtime',
}))
vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    formatMessage: (t: string) => t,
    splitMessage: (t: string) => [t],
    sendMessage: mockSend,
  }),
  channelStateDir: (provider: string) => join(stateRoot.dir, provider),
}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: mockWarn, debug: vi.fn(), error: vi.fn() },
}))
vi.mock('../test-run-marker.js', () => ({ markIfTestRun: (t: string) => t }))

import { notifyChannel, notifySecurityEvent, setOwnerChatMissingSink, resolveNotifyChatId } from '../notify.js'

const sink = vi.fn()
function pair(provider: string, access: unknown): void {
  mkdirSync(join(stateRoot.dir, provider), { recursive: true })
  writeFileSync(join(stateRoot.dir, provider, 'access.json'), JSON.stringify(access))
}

beforeEach(() => {
  stateRoot.dir = mkdtempSync(join(tmpdir(), 'notify-owner-'))
  mockSend.mockClear(); mockWarn.mockClear(); sink.mockClear()
  cfg.provider = 'telegram'; cfg.token = 'bot-token'; cfg.chatId = '0'
  setOwnerChatMissingSink(sink)
})
afterEach(() => {
  vi.useRealTimers()
  setOwnerChatMissingSink(null)
  rmSync(stateRoot.dir, { recursive: true, force: true })
})

describe('notifyChannel resolves the owner chat at send time (3ed09d25)', () => {
  it('(n1) ⛔ with the .env placeholder 0, the alert goes to the owner paired in access.json', async () => {
    pair('telegram', { allowFrom: ['5040302010'] })
    await notifyChannel('alert')
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSend).toHaveBeenCalledWith('bot-token', '5040302010', 'alert', 'HTML')
    expect(sink).not.toHaveBeenCalled()
  })

  it('(n2) with nothing to resolve: no send, the log line, and ONE [notify-undelivered] notice to the inbox', async () => {
    await notifyChannel('riasztas: a flotta all')
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('Channel ertesites kihagyva'))
    expect(sink).toHaveBeenCalledTimes(1)
    expect(String(sink.mock.calls[0][0])).toContain('[notify-undelivered]')
    expect(String(sink.mock.calls[0][0])).toContain('riasztas: a flotta all')
  })

  it('(n3) the inbox notice comes once an hour; the log line every time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.UTC(2026, 8, 25, 10, 0, 0))
    await notifyChannel('elso')
    vi.setSystemTime(Date.UTC(2026, 8, 25, 10, 30, 0))
    await notifyChannel('masodik')
    expect(sink).toHaveBeenCalledTimes(1)
    expect(mockWarn).toHaveBeenCalledTimes(2)
    vi.setSystemTime(Date.UTC(2026, 8, 25, 11, 0, 1))
    await notifyChannel('harmadik')
    expect(sink).toHaveBeenCalledTimes(2)
  })

  it('(n4) POSITIVE CONTROL: a real configured id wins over access.json, as with today\'s .env', async () => {
    cfg.chatId = '7000000001'
    pair('telegram', { allowFrom: ['1111111111'] })
    await notifyChannel('alert')
    expect(mockSend).toHaveBeenCalledWith('bot-token', '7000000001', 'alert', 'HTML')
    expect(resolveNotifyChatId()).toBe('7000000001')
  })

  it('(n5) no token means no channel on this install: nothing is sent and the inbox is not bothered', async () => {
    cfg.token = ''
    pair('telegram', { allowFrom: ['5040302010'] })
    await notifyChannel('alert')
    expect(mockSend).not.toHaveBeenCalled()
    expect(sink).not.toHaveBeenCalled()
  })

  it('(n6) security events follow the same resolution and stay silent when there is none', async () => {
    pair('telegram', { allowFrom: ['5040302010'] })
    await notifySecurityEvent('break-glass')
    expect(mockSend).toHaveBeenCalledWith('bot-token', '5040302010', 'break-glass', 'HTML')
    rmSync(join(stateRoot.dir, 'telegram'), { recursive: true, force: true })
    mockSend.mockClear()
    await notifySecurityEvent('break-glass')
    expect(mockSend).not.toHaveBeenCalled()
    expect(sink).not.toHaveBeenCalled()
  })

  it('(n7) a Slack install resolves from its own access.json, not the Telegram one', async () => {
    cfg.provider = 'slack'; cfg.chatId = ''
    pair('telegram', { allowFrom: ['5040302010'] })
    pair('slack', { allowFrom: [], channels: { C0SLACKOWNER: {} } })
    await notifyChannel('alert')
    expect(mockSend).toHaveBeenCalledWith('bot-token', 'C0SLACKOWNER', 'alert', undefined)
  })
})
