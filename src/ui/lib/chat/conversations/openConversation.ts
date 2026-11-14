/**
 * Opens a conversation from somewhere else (the "Nhắn tin" (Message) button on a user profile, a shared group...) exactly like clicking in the conversation
 * list: switches account if needed, shows the known name / photo, loads the messages on this machine, then the history from Telegram / Facebook when the machine
 * has none, marks as read. Previously these buttons only set the open conversation: someone not yet in the list showed as a number ID (photo "1"),
 * the history was not loaded, and opening from the CRM made the list that appeared reopen the old conversation.
 *
 * The conversation list (ConversationList) registers the full way to open. When on another page (CRM...) the list is not there yet:
 * the right conversation and name show right away, and once the list appears it opens fully.
 */
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useChatStore, type ContactItem } from '@/store/chat/chatStore';

export interface OpenConversationRequest {
  accountId: string;
  threadId: string;
  threadType: 0 | 1;
  /** Name / photo already known (the profile just viewed): a conversation not yet in the list still shows the right name and photo instead of the number ID. */
  info?: { display_name?: string; avatar_url?: string; channel?: string };
}

type ConversationOpener = (request: OpenConversationRequest) => void;

/** An open request made while the conversation list is not shown is kept for this long, waiting for the list to appear. */
const PENDING_TTL_MS = 5_000;
let opener: ConversationOpener | null = null;
let pending: { request: OpenConversationRequest; at: number } | null = null;

/** ConversationList: the full way to open (handleSelect). A pending request opens right away. */
export function registerConversationOpener(fn: ConversationOpener): () => void {
  opener = fn;
  const waiting = pending;
  pending = null;
  if (waiting && Date.now() - waiting.at < PENDING_TTL_MS) fn(waiting.request);
  return () => {
    if (opener === fn) opener = null;
  };
}

/** The name is only a number ID (the real name is not known yet). */
function hasRealName(contact: ContactItem | undefined): boolean {
  const name = String(contact?.display_name || '');
  return !!contact?.alias || (!!name && name !== contact?.contact_id && !/^\d{8,15}$/.test(name));
}

export function openConversation(request: OpenConversationRequest): void {
  const { accountId, threadId, threadType } = request;
  if (!accountId || !threadId) return;
  const channel = request.info?.channel
    || useAccountStore.getState().accounts.find((account) => account.zalo_id === accountId)?.channel;
  const full: OpenConversationRequest = { ...request, info: { ...request.info, ...(channel ? { channel } : {}) } };

  const app = useAppStore.getState();
  app.setView('chat');
  app.setMobileShowChat(true);
  if (opener) {
    opener(full);
    return;
  }

  pending = { request: full, at: Date.now() };
  const chat = useChatStore.getState();
  const known = (chat.contacts[accountId] || []).find((contact) => contact.contact_id === threadId);
  chat.updateContact(accountId, {
    contact_id: threadId,
    ...(full.info?.display_name && !hasRealName(known) ? { display_name: full.info.display_name } : {}),
    ...(full.info?.avatar_url && !known?.avatar_url ? { avatar_url: full.info.avatar_url } : {}),
    ...(channel ? { channel: channel as ContactItem['channel'] } : {}),
    ...(known ? {} : { contact_type: threadType === 1 ? 'group' : 'user', last_message_time: Date.now() }),
  });
  // The list that appears restores the account's remembered conversation: remember this conversation instead of the old one
  chat.saveAccountThread(accountId, threadId, threadType);
  const accounts = useAccountStore.getState();
  if (accounts.activeAccountId !== accountId) accounts.setActiveAccount(accountId);
  chat.setActiveThread(threadId, threadType);
}
