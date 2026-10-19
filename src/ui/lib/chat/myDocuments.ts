/**
 * myDocuments.ts - Zalo "My Documents" (Cloud của tôi): a conversation that EXISTS on every Zalo account and syncs with
 * Zalo (phone / Zalo PC). Its thread id is the session's `loginInfo.send2me_id` — NOT the account's own uid (that is a
 * separate self chat) — and Zalo's profile for it has the folder avatar `zds_cic_my_documents_*`. Deplao never makes
 * one up: it only pins the real conversation (synced row) at the top like Zalo does; it usually sits beyond the loaded
 * pages (rarely gets new messages), so the list fetches it by id. The merged inbox ("Gộp trang") pins it only once it
 * has messages, so N rows do not crowd the top.
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
} | null | undefined;

const isZaloAccount = (account: MyDocumentsAccount) => !!account && (account.channel || 'zalo') === 'zalo';

/** Zalo's own My Documents avatar (folder + cloud). */
export function hasMyDocumentsAvatar(avatarUrl?: string | null): boolean {
  return !!avatarUrl && MY_DOCUMENTS_AVATAR_RE.test(String(avatarUrl));
}

/** Thread id of the account's My Documents ('' when unknown or not a Zalo account). */
export function myDocumentsThreadId(account: MyDocumentsAccount): string {
  return isZaloAccount(account) && account!.send2me_id ? String(account!.send2me_id) : '';
}

/** The conversation is the account's Zalo My Documents (by send2me_id; Zalo's folder avatar when the id is not known yet). */
export function isMyDocumentsContact(contact: MyDocumentsContact, account: MyDocumentsAccount): boolean {
  if (!contact?.contact_id || !isZaloAccount(account) || contact.contact_type === 'group') return false;
  const threadId = myDocumentsThreadId(account);
  return (!!threadId && String(contact.contact_id) === threadId) || hasMyDocumentsAvatar(contact.avatar_url);
}

/** Same check by thread id (chat header / composer), with the conversation's avatar when at hand. */
export function isMyDocumentsThread(account: MyDocumentsAccount, threadId?: string | null, avatarUrl?: string | null): boolean {
  return isMyDocumentsContact(threadId ? { contact_id: threadId, avatar_url: avatarUrl } : null, account);
}

/** My Documents that has messages → also pinned first in the merged inbox. */
export function isPinnedMyDocuments(contact: MyDocumentsContact, account: MyDocumentsAccount): boolean {
  if (!contact || !isMyDocumentsContact(contact, account)) return false;
  return Number(contact.last_message_time) > 0 || !!String(contact.last_message || '').trim();
}
