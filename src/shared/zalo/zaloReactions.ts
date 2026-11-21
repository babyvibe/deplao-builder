/**
 * zaloReactions.ts: Zalo reaction codes (rIcon, e.g. ":>") → displayed emoji: ONE table shared by the renderer and main.
 *
 * The 6 reactions of Zalo's bar, in Zalo's order: 👍 "/-strong", ❤️ "/-heart", 😆 ":>", 😮 ":o", 😭 ":-((", 😡 ":-h". The emoji
 * are the ones that look like Zalo's own images (its "haha" laughs with closed eyes, its "cry" streams tears).
 *
 * Sending and receiving must use the same table: when the picker and the 3 inbound paths (useZaloEvents, EventBroadcaster,
 * HttpClientService) disagreed, Zalo's echo of a reaction just sent did not match the saved one and one tap counted twice.
 */

export const ZALO_REACTION_ICON_TO_EMOJI: Readonly<Record<string, string>> = {
  '/-heart': '❤️', '/-strong': '👍', ':>': '😆', ':o': '😮',
  ':-((': '😭', ':-h': '😡', ':-*': '😘', ":')": '😂',
  '/-shit': '💩', '/-rose': '🌹', '/-break': '💔', '/-weak': '👎',
  ';xx': '😍', ';-/': '😕', ';-)': '😉', '/-fade': '🥱',
  '_()_': '🙏', '/-no': '🙅', '/-ok': '👌', '/-v': '✌️',
  '/-thanks': '🙏', '/-punch': '👊', ':-bye': '👋', ':((': '😭',
  ':))': '😁', '$-)': '🤑',
};

/** Zalo rIcon → emoji (unknown codes kept as is). */
export function zaloReactionIconToEmoji(icon: string): string {
  return ZALO_REACTION_ICON_TO_EMOJI[icon] || icon;
}

/** Meaning of a reaction whatever emoji / Zalo code it was written with (workflows saved 😂 for "Haha", 😢 for "Buồn"…). */
const REACTION_MEANING: Readonly<Record<string, string>> = {
  '👍': 'like', '/-strong': 'like', LIKE: 'like',
  '❤️': 'heart', '❤': 'heart', '/-heart': 'heart', HEART: 'heart',
  '😆': 'haha', '😄': 'haha', '😂': 'haha', ':>': 'haha', HAHA: 'haha',
  '😮': 'wow', ':o': 'wow', WOW: 'wow',
  '😭': 'sad', '😢': 'sad', ':-((': 'sad', CRY: 'sad',
  '😡': 'angry', '😠': 'angry', ':-h': 'angry', ANGRY: 'angry',
};

/** Same reaction for a workflow filter: same text, or the same one of Zalo's 6 reactions written another way. */
export function sameZaloReactionMeaning(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = String(a || '');
  const right = String(b || '');
  if (!left || !right) return false;
  if (left === right) return true;
  const meaning = REACTION_MEANING[left];
  return !!meaning && meaning === REACTION_MEANING[right];
}

/** Flat fields of a Zalo reaction event ({ zaloId, reaction } from the listener) for workflows. Empty `react` = a removal (✕). */
export function zaloReactionEventFields(data: any): {
  zaloId: string; threadId: string; uidFrom: string; fromName: string; msgId: string; react: string; reactIcon: string;
  isGroup?: boolean; isSelf: boolean;
} {
  const reaction = data?.reaction || {};
  const rData = reaction.data || {};
  const rMsg: any[] = rData.content?.rMsg || reaction.content?.rMsg || [];
  const reactIcon = String(rData.content?.rIcon || reaction.content?.rIcon || reaction.rIcon || rData.rIcon || '');
  return {
    zaloId: String(data?.zaloId || ''),
    threadId: String(reaction.threadId || rData.idTo || rData.threadId || ''),
    uidFrom: String(rData.uidFrom || reaction.uidFrom || ''),
    fromName: String(rData.dName || ''),
    msgId: rMsg.length > 0 ? String(rMsg[0].gMsgID || rMsg[0].cMsgID || '') : String(rData.msgId || reaction.msgId || ''),
    react: reactIcon ? zaloReactionIconToEmoji(reactIcon) : '',
    reactIcon,
    isGroup: typeof reaction.isGroup === 'boolean' ? reaction.isGroup : undefined,
    isSelf: !!reaction.isSelf,
  };
}

/**
 * Emoji saved earlier for the same Zalo reaction: "haha" was 😄 (and 😆 from old echoes before that), "cry" was 😢. Old rows
 * are read as the current emoji, so nothing in the DB has to be rewritten.
 */
const ZALO_REACTION_ALIASES: Readonly<Record<string, string>> = { '😄': '😆', '😢': '😭' };

export function normalizeZaloReactionEmoji(emoji: string): string {
  return ZALO_REACTION_ALIASES[emoji] || emoji;
}

export interface ZaloReactionEntry { total: number; users: Record<string, number> }

/** Reactions of one message as stored (see chatStore ReactionData). `lastByUser`: each person's latest reaction (Zalo's button shows it). */
export interface ZaloReactionData {
  total?: number;
  lastReact?: string;
  lastByUser?: Record<string, string>;
  emoji: Record<string, ZaloReactionEntry>;
}

function normalizeLastByUser(lastByUser: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!lastByUser || typeof lastByUser !== 'object') return lastByUser;
  const out: Record<string, string> = {};
  for (const [uid, emoji] of Object.entries(lastByUser)) if (emoji) out[uid] = normalizeZaloReactionEmoji(String(emoji));
  return out;
}

/**
 * Merges Zalo reaction records that were split in two into the standard emoji. The same person under both keys = one tap in the app + the echo
 * of that same tap, so take the larger number (do not add); different people → combined. No old key → return `data` unchanged.
 */
export function mergeZaloReactionAliases<T extends ZaloReactionData>(data: T): T {
  const keys = Object.keys(data?.emoji || {});
  const oldLast = [data?.lastReact || '', ...Object.values(data?.lastByUser || {})].some((emoji) => ZALO_REACTION_ALIASES[emoji]);
  if (!keys.some((key) => ZALO_REACTION_ALIASES[key])) {
    if (!oldLast) return data;
    return { ...data, lastReact: normalizeZaloReactionEmoji(data.lastReact || ''), lastByUser: normalizeLastByUser(data.lastByUser) };
  }
  const emoji: Record<string, ZaloReactionEntry> = {};
  for (const key of keys) {
    const entry = data.emoji[key];
    const target = normalizeZaloReactionEmoji(key);
    const users = entry?.users || {};
    const existing = emoji[target];
    if (!existing) {
      emoji[target] = { total: Number(entry?.total) || 0, users: { ...users } };
      continue;
    }
    for (const [uid, count] of Object.entries(users)) {
      existing.users[uid] = Math.max(existing.users[uid] || 0, Number(count) || 0);
    }
    const userSum = Object.values(existing.users).reduce((sum, count) => sum + count, 0);
    existing.total = userSum > 0 ? userSum : Math.max(existing.total, Number(entry?.total) || 0);
  }
  const total = Object.values(emoji).reduce((sum, entry) => sum + entry.total, 0);
  const merged = { ...data, emoji, total };
  if (data.lastReact) merged.lastReact = normalizeZaloReactionEmoji(data.lastReact);
  if (data.lastByUser) merged.lastByUser = normalizeLastByUser(data.lastByUser);
  return merged;
}

/**
 * The reaction on a person's Zalo button: their latest reaction while they still have it, otherwise the one they gave most
 * (rows saved before `lastByUser` existed), null when they have none.
 */
export function zaloLatestReactionOf(data: ZaloReactionData | null | undefined, userId: string | null | undefined): string | null {
  if (!data?.emoji || !userId) return null;
  const counts = Object.entries(data.emoji)
    .map(([emoji, entry]) => [emoji, Number(entry?.users?.[userId]) || 0] as const)
    .filter(([, count]) => count > 0);
  if (!counts.length) return null;
  const last = data.lastByUser?.[userId];
  if (last && counts.some(([emoji]) => emoji === last)) return last;
  return counts.reduce((best, item) => (item[1] > best[1] ? item : best))[0];
}
