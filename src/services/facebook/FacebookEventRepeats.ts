/**
 * MQTT and the LightSpeed bridge both report each event of an ordinary Facebook message (message, reaction, unsend), a few tens of ms apart.
 * New messages are de-duplicated by the DB (saveFBMessage). Reactions and unsends have no row of their own, so they are de-duplicated here: same key, same
 * value repeated within REPEAT_WINDOW_MS is a repeat, not written again and not replayed (workflows and API events only run
 * once). A value that differs from the previous state (a reaction changed / removed) still goes through.
 */

export const REPEAT_WINDOW_MS = 30_000;
const MAX_ENTRIES = 2000;

export function createRepeatFilter(windowMs: number = REPEAT_WINDOW_MS) {
  const last = new Map<string, { value: string; at: number }>();
  return {
    /** true = a new event (keep processing), false = a repeat of the event just reported. */
    accept(key: string, value: string, now: number = Date.now()): boolean {
      const prev = last.get(key);
      if (prev && prev.value === value && now - prev.at < windowMs) return false;
      last.set(key, { value, at: now });
      if (last.size > MAX_ENTRIES) {
        for (const [k, v] of last) if (now - v.at >= windowMs) last.delete(k);
      }
      return true;
    },
  };
}

export type RepeatFilter = ReturnType<typeof createRepeatFilter>;

/** Reaction: key = message + person (the "@…" / ":…" part of the JID is dropped), value = the reaction with U+FE0F removed ("❤" = "❤️"), empty = removed. */
export function reactionRepeat(messageId: string, userId: string, emoji: string): { key: string; value: string } {
  return {
    key: `reaction|${messageId}|${String(userId || '').replace(/[@:].*$/, '')}`,
    value: String(emoji || '').replace(/\uFE0F/g, ''),
  };
}

/** Unsend: once per message. */
export function unsendRepeat(messageId: string): { key: string; value: string } {
  return { key: `unsend|${messageId}`, value: 'unsent' };
}
