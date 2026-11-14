/**
 * telegramPins.ts: how many Telegram pinned messages Deplao keeps (pure, main process + tests).
 *
 * Telegram pins every channel post automatically in the channel's linked discussion group, so such a group has as many
 * pinned messages as the channel has posts (49,949 in one chat of a real account). Deplao keeps the newest ones only: the
 * pin bar shows the latest pin, the list shows these.
 */

/** Newest pinned messages fetched (one messages.search page) and kept per Telegram chat. */
export const TELEGRAM_PINNED_LIMIT = 100;

/** Upper bound of pins read for one conversation (any channel), so a bloated table cannot flood the chat screen. */
export const PINNED_READ_LIMIT = 200;
