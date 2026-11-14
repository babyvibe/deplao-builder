/**
 * Colour and initials per person / conversation (Telegram Desktop style), shared by all channels (Zalo, Facebook, Telegram):
 * the sender's name in a message, the quote block, the letter avatars in the conversation list / chat header / members...
 * the same colour for the same person.
 *
 * Colour: numeric id → `id % 7` on the "bare" id (Telegram: regular group -123 → 123, supergroup / channel -100123 → 123) → 0 red, 1 orange,
 * 2 purple, 3 green, 4 teal, 5 blue, 6 pink: exactly how Telegram colours users who have not picked a colour (checked against
 * Telegram Desktop on real data, 5/5 match). A non-numeric id → hash of the string. Light / dark palette: the
 * `chat-peer-N` class in index.css.
 */

import { tr } from '../../../../shared/i18n';

export const PEER_COLOR_COUNT = 7;

/** Bare id (without the "-" / "-100" of a Telegram group / channel); not a number → ''. */
function barePeerId(peerId: string): string {
  const id = peerId.trim();
  if (/^-100\d+$/.test(id)) return id.slice(4);
  if (/^-\d+$/.test(id)) return id.slice(1);
  return /^\d+$/.test(id) ? id : '';
}

function hashIndex(text: string): number {
  let hash = 0;
  for (const ch of text) hash = (hash * 31 + (ch.codePointAt(0) || 0)) % 1_000_003;
  return hash % PEER_COLOR_COUNT;
}

/**
 * Colour index 0–6 of a person / group. Without a numeric id → hash of `fallbackKey` (e.g. the name) or the id itself; nothing at all → null.
 */
export function peerColorIndex(peerId: string | number | null | undefined, fallbackKey?: string | null): number | null {
  const raw = peerId === null || peerId === undefined ? '' : String(peerId);
  const bare = barePeerId(raw);
  if (bare && !/^0+$/.test(bare)) {
    // Takes the remainder digit by digit: Zalo ids (19 digits) / Telegram channel ids exceed the safe precision of a real number
    let rest = 0;
    for (const digit of bare) rest = (rest * 10 + Number(digit)) % PEER_COLOR_COUNT;
    return rest;
  }
  const key = String(fallbackKey || raw || '').trim();
  return key ? hashIndex(key) : null;
}

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Initials on the avatar, as Telegram Desktop does (EmptyUserpic::InitialsString): the first letter of the first word + the first letter
 * of the last word, skipping emoji / symbols ("🐶👾 BITSDuck Smart👾 BITS🦴" → "BB", "Nguyễn Bích Diệp" → "ND").
 */
export function peerInitials(name: string | null | undefined): string {
  const text = String(name || '').normalize('NFC').trim();
  if (!text) return '';
  const letters: string[] = [];
  const levels: number[] = [];
  let level = 0;
  let letterFound = false;
  for (const ch of text) {
    if (LETTER_OR_NUMBER.test(ch)) {
      if (!letterFound) {
        letterFound = true;
        letters.push(ch);
        levels.push(level);
      }
    } else if (ch === ' ') {
      level = 0;
      letterFound = false;
    } else if (letterFound && ch === '-') {
      // Prefer the word after a space, then the part after a "-" (Anne-Marie → "AM")
      level = 1;
      letterFound = false;
    }
  }
  if (!letters.length) return '';
  let best = 0;
  let bestLevel = 2;
  for (let i = letters.length - 1; i > 0; i--) {
    if (levels[i] < bestLevel) {
      best = i;
      bestLevel = levels[i];
    }
  }
  return (letters[0] + (best > 0 ? letters[best] : '')).toLocaleUpperCase('vi');
}

/**
 * One letter representing the name: the first letter / digit. Before, `charAt(0)` of a name starting with an emoji took half of a
 * surrogate pair → the box showed "�". If there is no letter → the first character (emoji) in full.
 */
export function nameInitial(name: string | null | undefined, fallback = '?'): string {
  const text = String(name || '').normalize('NFC').trim();
  if (!text) return fallback;
  for (const ch of text) {
    if (LETTER_OR_NUMBER.test(ch)) return ch.toLocaleUpperCase('vi');
  }
  return Array.from(text)[0] || fallback;
}

/** Role in a Telegram group (telegram_group_admins): 1 = creator, 2 = administrator. */
export interface TelegramGroupAdmin {
  memberId: string;
  role: number;
  /** Custom title set by the user (e.g. "I.... am.... mod"); empty → the default label. */
  rank: string;
}

/** Telegram: the custom title; if none, "Chủ nhóm" (Group owner) / "Quản trị viên" (Administrator), as in Telegram. */
export function telegramRankLabel(admin: Pick<TelegramGroupAdmin, 'role' | 'rank'> | null | undefined): string {
  if (!admin) return '';
  const rank = String(admin.rank || '').trim();
  if (rank) return rank;
  if (Number(admin.role) === 1) return tr('Chủ nhóm');
  if (Number(admin.role) === 2) return tr('Quản trị viên');
  return '';
}

/**
 * Role label from the `role` of a group member (page_group_member), following each channel's convention (shared/chat/groupMemberRoles):
 * Telegram 1 = creator / 2 = administrator; Zalo 2 = group leader / 1 = deputy leader; Facebook: administrator.
 */
export function groupRankLabel(channel: string | null | undefined, role: number | string | null | undefined): string {
  const value = Number(role || 0);
  if (!value) return '';
  const ch = String(channel || '');
  if (ch.startsWith('telegram')) return telegramRankLabel({ role: value, rank: '' });
  if (ch === 'facebook') return tr('Quản trị viên');
  if (value === 2) return tr('Trưởng nhóm');
  if (value === 1) return tr('Phó nhóm');
  return '';
}
