/**
 * Tra người gửi trong hội thoại đang mở: danh bạ / thành viên nhóm theo id (Map O(1)), quyền quản trị nhóm của mình,
 * tên người được trích dẫn, tên + ảnh lưu kèm tin đánh dấu, nguồn cho lịch hẹn / ghi chú từ tin.
 */
import React from 'react';
import type { ErpSourceMessage } from '@/lib/chat/erp/messageToErp';
import { extractMsgText } from '@/lib/chat/messages/messageParser';

const EMPTY_MEMBERS: any[] = [];

export function useSenderDirectory(deps: {
  contactList: any[];
  threadGroupInfo: any;
  activeAccountId: string | null;
  activeThreadId: string | null;
  activeContact: any;
  allAccounts: any[];
  findMsgById: (id: unknown) => any;
}) {
  const { contactList, threadGroupInfo, activeAccountId, activeThreadId, activeContact, allAccounts, findMsgById } = deps;
  // OPTIMIZATION: Contact lookup O(1) với Map
  const contactMap = React.useMemo(() => {
    const map = new Map<string, any>();
    contactList.forEach(c => map.set(c.contact_id, c));
    return map;
  }, [contactList]);
  const getContact = (senderId: string) => contactMap.get(senderId);

  // Cache group members for current thread
  const groupMembers: any[] = threadGroupInfo?.members || EMPTY_MEMBERS;

  // OPTIMIZATION: Group member lookup O(1) với Map
  const groupMemberMap = React.useMemo(() => {
    const map = new Map<string, any>();
    groupMembers.forEach(m => map.set(String(m.userId), m));
    return map;
  }, [groupMembers]);
  const getGroupMember = (senderId: string) => groupMemberMap.get(String(senderId));

  /** Tin → nguồn cho lịch / ghi chú Quản lý công việc (tên người gửi như đang hiện trong khung chat). */
  const erpSourceOf = (m: any): ErpSourceMessage => {
    const mine = m.is_sent === 1 || m.is_sent === true || String(m.sender_id) === String(activeAccountId);
    let sender = 'Bạn';
    if (!mine) {
      const contact = getContact(m.sender_id);
      const member = getGroupMember(m.sender_id);
      const isGroupThread = activeContact?.contact_type === 'group';
      sender = contact?.alias || member?.displayName || contact?.display_name
        || (!isGroupThread ? (activeContact?.alias || activeContact?.display_name) : '') || 'Thành viên';
    }
    return { text: extractMsgText(m), sender, timestamp: Number(m.timestamp) || Date.now() };
  };

  // Check if current user is group owner or deputy - can recall any member's message
  const isGroupAdmin = React.useMemo(() => {
    if (!activeAccountId || !activeThreadId) return false;
    const cache = threadGroupInfo;
    if (!cache) return false;
    const me = cache.members?.find((m: any) => m.userId === activeAccountId);
    if (me && me.role >= 1) return true; // role 1=owner, 2=deputy
    if (cache.creatorId === activeAccountId) return true;
    if (cache.adminIds?.includes(activeAccountId)) return true;
    return false;
  }, [threadGroupInfo, activeAccountId, activeThreadId]);

  // Tên người gửi tin được trích dẫn. Zalo gửi sẵn `fromD`; quote Telegram cũ / tin tự gửi trả lời và Facebook thì không
  // → tra theo senderId (hoặc người gửi tin gốc trong trang): liên hệ → thành viên nhóm; tin của mình → tên tài khoản.
  const resolveQuoteAuthor = (q: any): string => {
    const stored = String(q?.fromD || '').trim();
    if (stored) return stored;
    const orig = q?.msgId ? findMsgById(String(q.msgId)) : undefined;
    const senderId = String(q?.senderId || q?.uidFrom || orig?.sender_id || '');
    if ((senderId && senderId === activeAccountId) || (!senderId && orig?.is_sent)) {
      return String(allAccounts.find((a) => a.zalo_id === activeAccountId)?.full_name || '');
    }
    if (!senderId) return '';
    const contact = getContact(senderId) as any;
    const contactName = String(contact?.alias || contact?.display_name || '');
    const name = (contactName && contactName !== senderId ? contactName : '') || String(getGroupMember(senderId)?.displayName || '');
    return name !== senderId ? name : '';
  };

  /** Tên + ảnh người gửi như hàng tin nhắn đang hiển thị (lưu kèm đánh dấu). */
  const resolveStarSender = (m: any): { name: string; avatar: string } => {
    // Tin của chính tài khoản → tên + ảnh của tài khoản, kể cả khi thiếu is_sent (sender = tài khoản / Facebook id).
    // Không lấy contact "chính mình": Zalo có 1 dòng contact cho chính tài khoản, ảnh có thể là URL cũ đã hỏng.
    const account = allAccounts.find(a => a.zalo_id === activeAccountId);
    const senderId = String(m?.sender_id || '');
    if (Number(m?.is_sent) === 1 || (!!senderId && (senderId === activeAccountId || senderId === String(account?.facebook_id || '')))) {
      return { name: account?.full_name || account?.display_name || 'Bạn', avatar: account?.avatar_url || '' };
    }
    const contact = getContact(m?.sender_id);
    const member = getGroupMember(m?.sender_id);
    const contactName = contact?.alias || contact?.display_name || '';
    const name = (contactName && contactName !== m?.sender_id ? contactName : '') || member?.displayName || contactName || String(m?.sender_id || '');
    return { name, avatar: contact?.avatar_url || member?.avatar || '' };
  };

  return { contactMap, getContact, groupMembers, groupMemberMap, getGroupMember, erpSourceOf, isGroupAdmin, resolveQuoteAuthor, resolveStarSender };
}

export type SenderDirectory = ReturnType<typeof useSenderDirectory>;
