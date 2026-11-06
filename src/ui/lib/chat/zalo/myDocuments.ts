/**
 * myDocuments.ts - Zalo "My Documents" (Cloud của tôi): a conversation that EXISTS on every Zalo account and syncs with
 * Zalo (phone / Zalo PC). Its thread id is the session's `loginInfo.send2me_id` — NOT the account's own uid (that is a
 * separate self chat) — and Zalo's profile for it has the folder avatar `zds_cic_my_documents_*`. Deplao never makes
 * one up: it only pins the real conversation (synced row) at the top like Zalo does; it usually sits beyond the loaded
 * pages (rarely gets new messages), so the list fetches it by id.
 *
 * Telegram's "Saved Messages" (the chat with yourself, id = the account's own user id) is shown the same way: named
 * My Documents with the cloud icon (its row carries your own name and photo) and pinned at the top.
 *
 * Merged inbox ("Gộp trang") without an account filter: ONE "My Documents" row at the top; opening it lists the accounts
 * (like a forum's topics) and picking one opens that account's My Documents. Filtered to one account: its own row.
 */

export const MY_DOCUMENTS_NAME = 'My Documents';

const MY_DOCUMENTS_AVATAR_RE = /zds_cic_my_documents/i;

type MyDocumentsAccount = { zalo_id?: string | null; channel?: string | null; send2me_id?: string | null } | null | undefined;
type MyDocumentsContact = {
  contact_id?: string | null;
  contact_type?: string | null;
  avatar_url?: string | null;
  last_message_time?: number | null;
  last_message?: string | null;
  unread_count?: number | null;
} | null | undefined;

const isZaloAccount = (account: MyDocumentsAccount) => !!account && (account.channel || 'zalo') === 'zalo';

/** Telegram user account: its My Documents is Telegram's Saved Messages. */
export const isSavedMessagesAccount = (account: MyDocumentsAccount) => !!account?.zalo_id && account.channel === 'telegram_user';

/** Zalo's own My Documents avatar (folder + cloud). */
export function hasMyDocumentsAvatar(avatarUrl?: string | null): boolean {
  return !!avatarUrl && MY_DOCUMENTS_AVATAR_RE.test(String(avatarUrl));
}

/** Thread id of the account's My Documents ('' when unknown or the channel has none). */
export function myDocumentsThreadId(account: MyDocumentsAccount): string {
  if (isSavedMessagesAccount(account)) return String(account!.zalo_id);
  return isZaloAccount(account) && account!.send2me_id ? String(account!.send2me_id) : '';
}

/**
 * The conversation is the account's My Documents: Zalo by send2me_id (Zalo's folder avatar when the id is not known
 * yet), Telegram = the chat with yourself.
 */
export function isMyDocumentsContact(contact: MyDocumentsContact, account: MyDocumentsAccount): boolean {
  if (!contact?.contact_id || contact.contact_type === 'group') return false;
  if (isSavedMessagesAccount(account)) return String(contact.contact_id) === String(account!.zalo_id);
  if (!isZaloAccount(account)) return false;
  const threadId = myDocumentsThreadId(account);
  return (!!threadId && String(contact.contact_id) === threadId) || hasMyDocumentsAvatar(contact.avatar_url);
}

/** Same check by thread id (chat header / composer), with the conversation's avatar when at hand. */
export function isMyDocumentsThread(account: MyDocumentsAccount, threadId?: string | null, avatarUrl?: string | null): boolean {
  return isMyDocumentsContact(threadId ? { contact_id: threadId, avatar_url: avatarUrl } : null, account);
}

/** Title of a My Documents row / header: Telegram's row has your own name, so it always reads My Documents. */
export function myDocumentsTitle(
  contact: { alias?: string | null; display_name?: string | null } | null | undefined,
  account: MyDocumentsAccount,
): string {
  if (isSavedMessagesAccount(account)) return MY_DOCUMENTS_NAME;
  return contact?.alias || contact?.display_name || MY_DOCUMENTS_NAME;
}

/** Cloud icon instead of the row's picture: always on Telegram (your own photo), on Zalo only without its folder picture. */
export function showsMyDocumentsIcon(account: MyDocumentsAccount, avatarUrl?: string | null, avatarFailed = false): boolean {
  return isSavedMessagesAccount(account) || !avatarUrl || avatarFailed;
}

/** Merged inbox "My Documents" row: the newest conversation across the accounts (null = no messages yet) + total unread. */
export function myDocumentsGroupSummary<C extends NonNullable<MyDocumentsContact>>(
  contacts: Array<C | null | undefined>,
): { latest: C | null; unread: number } {
  let latest: C | null = null;
  let unread = 0;
  for (const contact of contacts) {
    if (!contact) continue;
    unread += Math.max(0, Number(contact.unread_count) || 0);
    const time = Number(contact.last_message_time) || 0;
    if (time > 0 && time > (Number(latest?.last_message_time) || 0)) latest = contact;
  }
  return { latest, unread };
}
