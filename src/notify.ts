import { CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID } from './config.js'
import { resolveOwnerChatId } from './owner-chat.js'
import { getProvider } from './channel-provider.js'
import { logger } from './logger.js'
import { markIfTestRun } from './test-run-marker.js'

/**
 * Card 3ed09d25: the owner chat an alert goes to, resolved AT SEND TIME with the shared
 * resolver (the provider's configured id first, then the main agent's paired
 * access.json), not the CHANNEL_CHAT_ID frozen at boot. On 2026-09-16 the installer
 * placeholder (0) in the .env sent 470 alerts to nobody during an 18-hour fleet outage,
 * while the owner's chat was in access.json all along. CHANNEL_CHAT_ID is already the
 * provider's own configured key (getChannelChatId: ALLOWED_CHAT_ID for Telegram), the
 * value configuredOwnerChatFor would pick.
 */
export function resolveNotifyChatId(): string | null {
  return resolveOwnerChatId(undefined, CHANNEL_CHAT_ID, CHANNEL_PROVIDER)
}

// Card 3ed09d25: an alert with no resolvable owner chat is not dropped in silence. The
// log line fires every time; the main agent's inbox hears about it once per window,
// through a sink the dashboard registers at start. notify.ts does not reach into the
// database itself: processes that never open it import this module too, and there the
// log line is the signal.
type OwnerChatMissingSink = (text: string) => void
let ownerChatMissingSink: OwnerChatMissingSink | null = null
let lastOwnerChatMissingSignalAt = 0
const OWNER_CHAT_MISSING_SIGNAL_MS = 60 * 60 * 1000

export function setOwnerChatMissingSink(sink: OwnerChatMissingSink | null): void {
  ownerChatMissingSink = sink
  lastOwnerChatMissingSignalAt = 0
}

function signalOwnerChatMissing(text: string): void {
  const now = Date.now()
  if (!ownerChatMissingSink || now - lastOwnerChatMissingSignalAt < OWNER_CHAT_MISSING_SIGNAL_MS) return
  lastOwnerChatMissingSignalAt = now
  const preview = text.length > 200 ? `${text.slice(0, 200)} [... +${text.length - 200} karakter]` : text
  try {
    ownerChatMissingSink(
      '[notify-undelivered] Egy riasztás nem ment ki: a tulajdonosi chat nem oldható fel (a .env-ben nincs ' +
      'érvényes chat-id, és a fő ügynök access.json-jában sincs). Óránként legfeljebb egy ilyen jelzés jön, ' +
      `a többi csak a naplóba kerül. A kihagyott riasztás eleje: ${preview}`,
    )
  } catch (err) {
    logger.warn({ err }, 'owner-chat-missing signal could not be delivered')
  }
}

export async function notifyChannel(text: string): Promise<void> {
  // CHATID0: "not set" is decided by owner-chat.ts (normalizeChatId inside the
  // resolver), never by a truthiness test -- the installer's "0" placeholder is
  // neither empty nor falsy, and a guard that let it through sent every alert to
  // chat 0, where the Bot API's 400 was swallowed by the catches below.
  const chatId = CHANNEL_TOKEN ? resolveNotifyChatId() : null
  if (!CHANNEL_TOKEN || !chatId) {
    logger.warn('Channel ertesites kihagyva: token vagy chat ID hianyzik')
    // No token means no channel on this install: the log line is enough. A token
    // with no owner chat is the 2026-09-16 shape, and that one must reach someone.
    if (CHANNEL_TOKEN) signalOwnerChatMissing(text)
    return
  }

  // Marked here at the funnel, NOT at call sites -- a new caller must not be
  // able to leak an unmarked message from a test run.
  const outbound = markIfTestRun(text)
  const provider = getProvider(CHANNEL_PROVIDER)
  const formatted = provider.formatMessage(outbound)
  const chunks = provider.splitMessage(formatted)

  for (const chunk of chunks) {
    try {
      const parseMode = CHANNEL_PROVIDER === 'telegram' ? 'HTML' : undefined
      await provider.sendMessage(CHANNEL_TOKEN, chatId, chunk, parseMode)
    } catch {
      try {
        await provider.sendMessage(CHANNEL_TOKEN, chatId, outbound.slice(0, 4096))
      } catch { /* last resort, give up */ }
    }
  }
}

// Backward-compatible alias
export const notifyTelegram = notifyChannel

// Security-event notification (break-glass password reset, security:reset).
// Unlike notifyChannel, a missing channel config is an EXPECTED state here
// (fresh installs, channel-less deployments), so it stays fully silent -- the
// recovery path must never depend on, or be noisy about, Telegram being wired.
export async function notifySecurityEvent(text: string): Promise<void> {
  if (!CHANNEL_TOKEN || !resolveNotifyChatId()) return
  try {
    await notifyChannel(text)
  } catch {
    /* never let a notification failure break the recovery action itself */
  }
}
