/**
 * Mở một hội thoại từ nơi khác (nút "Nhắn tin" của hồ sơ người dùng, nhóm chung...) đúng như bấm trong danh sách hội
 * thoại: đổi tài khoản nếu cần, hiện tên / ảnh đã biết, tải tin trong máy rồi lịch sử từ Telegram / Facebook khi máy
 * chưa có, báo đã đọc. Trước đây các nút này chỉ đặt hội thoại đang mở: người chưa có trong danh sách hiện thành mã số
 * (ảnh "1"), không tải lịch sử, mở từ CRM thì danh sách hiện ra lại mở hội thoại cũ.
 *
 * Danh sách hội thoại (ConversationList) đăng ký cách mở đầy đủ. Đang ở trang khác (CRM...) thì danh sách chưa có:
 * hiện ngay tên / đúng hội thoại, danh sách hiện ra thì mở đầy đủ.
 */
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useChatStore, type ContactItem } from '@/store/chatStore';

export interface OpenConversationRequest {
  accountId: string;
  threadId: string;
  threadType: 0 | 1;
  /** Tên / ảnh đã biết (hồ sơ vừa xem): hội thoại chưa có trong danh sách vẫn hiện đúng tên, ảnh thay vì mã số. */
  info?: { display_name?: string; avatar_url?: string; channel?: string };
}

type ConversationOpener = (request: OpenConversationRequest) => void;

/** Yêu cầu mở lúc danh sách hội thoại chưa hiện được giữ chừng này, chờ danh sách hiện ra. */
const PENDING_TTL_MS = 5_000;
let opener: ConversationOpener | null = null;
let pending: { request: OpenConversationRequest; at: number } | null = null;

/** ConversationList: cách mở đầy đủ (handleSelect). Có yêu cầu đang chờ thì mở luôn. */
export function registerConversationOpener(fn: ConversationOpener): () => void {
  opener = fn;
  const waiting = pending;
  pending = null;
  if (waiting && Date.now() - waiting.at < PENDING_TTL_MS) fn(waiting.request);
  return () => {
    if (opener === fn) opener = null;
  };
}

/** Tên chỉ là mã số (chưa biết tên thật). */
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
  // Danh sách hiện ra khôi phục hội thoại đã nhớ của tài khoản: nhớ hội thoại này thay vì hội thoại cũ
  chat.saveAccountThread(accountId, threadId, threadType);
  const accounts = useAccountStore.getState();
  if (accounts.activeAccountId !== accountId) accounts.setActiveAccount(accountId);
  chat.setActiveThread(threadId, threadType);
}
