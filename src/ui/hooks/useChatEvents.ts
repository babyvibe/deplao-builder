/**
 * useChatEvents.ts
 * Unified event hook — lắng nghe cả Zalo và Facebook events,
 * normalize về cùng chatStore (unified store).
 *
 * Phase B4: merge Facebook events vào chatStore.
 * Zalo events vẫn được xử lý bởi useZaloEvents (không thay đổi).
 * Hook này chỉ thêm FB events → chatStore để ConversationList hiển thị FB threads.
 */

import { useEffect } from 'react';
import ipc from '../lib/ipc';
import { useChatStore, type MessageItem, type ContactItem } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';

/**
 * Generate human-readable preview from FB attachment metadata
 */
function fbAttachmentPreview(attachType: string, attObj: any): string {
  if (attachType === 'image' || attachType === 'photo') return '🖼️ Hình ảnh';
  if (attachType === 'video') return '🎬 Video';
  if (attachType === 'audio') return '🎵 Audio';
  if (attachType === 'sticker') return '[Sticker]';
  const name = attObj?.name;
  if (name) return `📎 ${name}`;
  if (attachType) return '📎 Tệp đính kèm';
  return '';
}

/**
 * Normalize một FB MQTT message → MessageItem format của chatStore
 */
function normalizeFBMessage(fbAccountId: string, msg: any): MessageItem {
  const threadId = msg.replyToID || msg.threadId || '';
  const hasAttachment = !!(msg.attachments?.id && msg.attachments.id !== 0);
  // Use attachmentType from MQTT if available (set by processDelta in FacebookMQTTListener)
  const attachType: string = msg.attachments?.attachmentType || (hasAttachment ? 'file' : '');
  const msgType = hasAttachment ? (attachType || 'file') : 'text';

  // Generate display content: body text OR attachment preview
  const attachPreview = hasAttachment ? fbAttachmentPreview(attachType, msg.attachments) : '';
  // FB sometimes sends body as "[file: name]" or "[image]" system text — prefer attachment preview
  const bodyIsSystemText = msg.body && /^\[.+\]$/.test(msg.body.trim());
  const content = (!msg.body || bodyIsSystemText) ? attachPreview : msg.body;

  const attachments = msg.allAttachments && msg.allAttachments.length > 1
    ? JSON.stringify(msg.allAttachments.map((a: any) => ({
        type: a.attachmentType || 'image',
        url: a.url || null,
        id: String(a.id),
        ...(a.name ? { name: a.name } : {}),
        ...(a.fileSize != null ? { fileSize: a.fileSize } : {}),
        ...(a.mimeType ? { mimeType: a.mimeType } : {}),
      })))
    : hasAttachment ? JSON.stringify([{
        type: attachType || 'file',
        url: msg.attachments.url || null,
        id: String(msg.attachments.id),
        ...(msg.attachments.name ? { name: msg.attachments.name } : {}),
        ...(msg.attachments.fileSize != null ? { fileSize: msg.attachments.fileSize } : {}),
        ...(msg.attachments.mimeType ? { mimeType: msg.attachments.mimeType } : {}),
      }])
    : undefined;

  return {
    msg_id: msg.messageID || String(Date.now()),
    owner_zalo_id: fbAccountId,
    thread_id: threadId,
    thread_type: msg.type === 'group' ? 1 : 0,
    sender_id: msg.userID || '',
    content,
    msg_type: msgType,
    timestamp: parseInt(msg.timestamp) || Date.now(),
    is_sent: 0,
    status: 'received',
    channel: 'facebook',
    attachments,
  };
}

/**
 * Hook lắng nghe FB events và cập nhật chatStore thống nhất.
 * Gọi hook này ở App level (cùng chỗ với useZaloEvents).
 */
export function useChatEvents(): void {
  const activeThreadId = useChatStore((s) => s.activeThreadId);

  useEffect(() => {
    const unsubscribers: Array<() => void> = [];

    // ─── fb:onMessage → chatStore.addMessage ──────────────────────────────
    const unsubMsg = ipc.on?.('fb:onMessage', (data: {
      fbAccountId: string;
      message: any;
    }) => {
      const { fbAccountId, message } = data;
      if (!fbAccountId || !message?.messageID) return;

      const threadId = message.replyToID;
      if (!threadId || threadId === '0') return;

      const normalized = normalizeFBMessage(fbAccountId, message);
      const isSelf = !!message.isSelf || message.userID === fbAccountId;
      if (isSelf) {
        normalized.is_sent = 1;
        normalized.status = 'sent';
        normalized.sender_id = fbAccountId;
      }
      const store = useChatStore.getState();

      // If self-echo from MQTT, replace the temp message instead of adding duplicate
      if (isSelf) {
        const key = `${fbAccountId}_${threadId}`;
        const existing = store.messages[key] || [];
        // Extract filename from content for fuzzy matching (handles "📎 file.docx" vs "[file: file.docx]")
        const extractFilename = (c: string) => {
          const m = c?.match(/(?:📎\s*|[[(]file:\s*)(.+?)(?:\])?$/i);
          return m ? m[1].trim() : c?.trim() || '';
        };
        const normalizedFilename = extractFilename(normalized.content || '');
        const tempIdx = existing.findIndex((m) => {
          if (!m.msg_id?.startsWith('temp_') || m.sender_id !== fbAccountId) return false;
          // Exact content match first
          if (normalized.content && m.content === normalized.content) return true;
          // Fuzzy filename match (📎 file.docx ↔ [file: file.docx])
          if (normalizedFilename && normalizedFilename === extractFilename(m.content || '')) return true;
          // Temp with empty content (e.g. clipboard paste): match by type
          if (!m.content && m.msg_type === normalized.msg_type) return true;
          // Attachment messages with no content: match first pending temp of same type
          if (!normalized.content || normalized.content === '') return m.msg_type === normalized.msg_type;
          return false;
        });
        if (tempIdx >= 0) {
          // Replace temp with real message, preserve localPath from temp attachments
          const tempMsg = existing[tempIdx];
          let mergedAttachments = normalized.attachments;
          try {
            const tempAtts = JSON.parse(tempMsg.attachments || '[]');
            const realAtts = JSON.parse(normalized.attachments || '[]');
            if (tempAtts.length > 0 && realAtts.length > 0 && tempAtts[0].localPath) {
              realAtts[0].localPath = tempAtts[0].localPath;
              mergedAttachments = JSON.stringify(realAtts);
            }
          } catch {}
          const updated = [...existing];
          updated[tempIdx] = { ...tempMsg, ...normalized, attachments: mergedAttachments };
          useChatStore.setState((s) => ({
            messages: { ...s.messages, [key]: updated },
          }));
          return; // Don't add duplicate or increment unread
        }
      }

      // Add message
      store.addMessage(fbAccountId, threadId, normalized);

      // Update contact (last message preview + time)
      const lastMsgPreview = normalized.content?.slice(0, 100)
        || (normalized.msg_type === 'image' || normalized.msg_type === 'photo' ? '🖼️ Hình ảnh'
          : normalized.msg_type === 'video' ? '🎬 Video'
          : normalized.msg_type === 'audio' ? '🎵 Audio'
          : normalized.msg_type !== 'text' ? '📎 Tệp đính kèm'
          : '[Tệp đính kèm]');
      store.updateContact(fbAccountId, {
        contact_id: threadId,
        last_message: lastMsgPreview,
        last_message_time: normalized.timestamp,
        channel: 'facebook',
      });

      // Increment unread if not currently viewing this thread and not self-sent
      const currentActive = useChatStore.getState().activeThreadId;
      if (currentActive !== threadId && !isSelf) {
        store.incrementUnread(fbAccountId, threadId);
      }
    });
    if (unsubMsg) unsubscribers.push(unsubMsg);

    // ─── fb:onConnectionStatus → accountStore ─────────────────────────────
    const unsubStatus = ipc.on?.('fb:onConnectionStatus', (data: {
      fbAccountId: string;
      status: string;
    }) => {
      if (!data?.fbAccountId) return;
      const isConnected = data.status === 'connected';
      const isCookieExpired = data.status === 'cookie_expired';
      useAccountStore.getState().updateAccountStatus(data.fbAccountId, isConnected, isConnected);

      // Notify user when cookie expired / bot detected
      if (isCookieExpired) {
        const accounts = useAccountStore.getState().accounts;
        const acc = accounts.find((a: any) => a.zalo_id === data.fbAccountId || a.facebook_id === data.fbAccountId);
        const name = acc?.full_name || acc?.zalo_id || data.fbAccountId;
        useAppStore.getState().showNotification(
          `⚠️ Tài khoản Facebook "${name}" bị ngắt kết nối (FB phát hiện bot hoặc cookie hết hạn). Vui lòng đăng nhập lại FB để lấy cookie mới.`,
          'error'
        );
      }

      // Reload contacts from DB after FB connects (threads with names were just saved)
      if (isConnected) {
        ipc.db?.getContacts(data.fbAccountId)
          .then((res: any) => {
            if (res?.contacts) {
              useChatStore.getState().setContacts(data.fbAccountId, res.contacts);
            }
          })
          .catch(() => {});
      }
    });
    if (unsubStatus) unsubscribers.push(unsubStatus);

    // ─── fb:onUnsend → chatStore.recallMessage ────────────────────────────
    const unsubUnsend = ipc.on?.('fb:onUnsend', (data: {
      fbAccountId: string;
      messageId: string;
    }) => {
      if (!data?.fbAccountId || !data?.messageId) return;
      useChatStore.getState().recallMessage(data.fbAccountId, data.messageId);
    });
    if (unsubUnsend) unsubscribers.push(unsubUnsend);

    // ─── fb:onReaction → chatStore.updateMessageReaction ──────────────────
    const unsubReaction = ipc.on?.('fb:onReaction', (data: {
      fbAccountId: string;
      messageId: string;
      threadId?: string;
      userId: string;
      emoji: string;
    }) => {
      if (!data?.fbAccountId || !data?.messageId) return;
      // Need threadId to update reaction — search through cached messages if not provided
      if (data.threadId) {
        useChatStore.getState().updateMessageReaction(
          data.fbAccountId, data.threadId, data.messageId, data.userId, data.emoji
        );
      }
    });
    if (unsubReaction) unsubscribers.push(unsubReaction);

    // ─── fb:onTyping → chatStore.setTyping ────────────────────────────────
    const unsubTyping = ipc.on?.('fb:onTyping', (data: {
      fbAccountId: string;
      threadId: string;
      userId: string;
      isTyping: boolean;
    }) => {
      if (!data?.fbAccountId || !data?.threadId || !data?.userId) return;
      if (data.isTyping) {
        useChatStore.getState().setTyping(data.fbAccountId, data.threadId, data.userId);
      } else {
        useChatStore.getState().clearTypingForThread(data.fbAccountId, data.threadId);
      }
    });
    if (unsubTyping) unsubscribers.push(unsubTyping);

    return () => {
      unsubscribers.forEach((fn) => fn());
    };
  }, [activeThreadId]);
}

