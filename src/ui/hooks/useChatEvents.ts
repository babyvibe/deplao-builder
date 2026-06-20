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
import { useChatStore, type MessageItem } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { playNotificationSound, showDesktopNotification } from '../utils/NotificationService';
import { getFilteredUnreadCount } from '@/lib/badgeUtils';

/**
 * Lấy tên hiển thị của account từ accountStore.
 * Dùng trong notification title để biết tin nhắn đến từ account nào.
 */
function getAccountDisplayName(zaloId: string): string {
  const accounts = useAccountStore.getState().accounts;
  const acc = accounts.find(a => a.zalo_id === zaloId || a.facebook_id === zaloId);
  return acc?.full_name || acc?.zalo_id || zaloId;
}

/**
 * Generate human-readable preview from FB attachment metadata
 * Giữ nguyên type gốc (sticker, image, video...) để MessageBubbles
 * tự quyết định render dựa trên msg_type.
 */
function fbAttachmentPreview(attachType: string, attObj: any): string {
  if (attachType === 'system') return ''; // System notifications use body text (admin msg), not a preview
  if (attachType === 'image' || attachType === 'photo') return '🖼️ Hình ảnh';
  if (attachType === 'video') return '🎬 Video';
  if (attachType === 'audio') return '🎵 Audio';
  if (attachType === 'sticker') return '🎨 Sticker';
  const name = attObj?.name;
  if (name) return `📎 ${name}`;
  if (attachType) return '📎 Tệp đính kèm';
  return '';
}

/**
 * Normalize một FB MQTT message → MessageItem format của chatStore
 * Giữ nguyên attachment type gốc — MessageBubbles tự quyết định render.
 * loadMessageFromDB (saveFBMessage) map sticker→image nhưng live event
 * để nguyên type để StickerBubble/MediaBubble xử lý phù hợp.
 */
function normalizeFBMessage(fbAccountId: string, msg: any): MessageItem {
  const threadId = msg.replyToID || msg.threadId || '';

  // hasAttachment: kiểm tra id hợp lệ + có url hoặc attachmentType
  const hasAttachment = !!(msg.attachments?.id && msg.attachments.id !== 0 &&
    (msg.attachments.url || msg.attachments.attachmentType));

  // rawType: giữ nguyên type gốc từ MQTT (sticker, image, video, file...)
  // Cho phép backend override msg_type (vd 'system' cho admin notification)
  const rawType = msg.msg_type || (!hasAttachment ? 'text' : (msg.attachments.attachmentType || 'image'));
  // KHÔNG map sticker→image ở đây — để MessageBubbles.isStickerType xử lý
  const msgType = rawType;

  if (rawType === 'sticker') {
    console.log(`[useChatEvents] [STICKER] normalizeFBMessage: fbAccountId=${fbAccountId} msgId=${msg.messageID} threadId=${threadId} rawType=${rawType} msgType=${msgType} url=${(msg.attachments?.url || '').slice(0,100)}`);
  }

  // Generate display content: body text OR attachment preview
  const attachPreview = fbAttachmentPreview(rawType, msg.attachments);
  // FB sometimes sends body as "[file: name]" or "[image]" system text — prefer attachment preview
  const bodyIsSystemText = msg.body && /^\[.+\]$/.test(msg.body.trim());
  const content = (!msg.body || bodyIsSystemText) ? attachPreview : msg.body;

  const serializeAtt = (a: any, defaultType: string) => ({
    type: a.attachmentType || defaultType,
    url: a.url || null,
    id: String(a.id),
    ...(a.name ? { name: a.name } : {}),
    ...(a.fileSize != null ? { fileSize: a.fileSize } : {}),
    ...(a.mimeType ? { mimeType: a.mimeType } : {}),
    ...(a.localPath ? { localPath: a.localPath } : {}),
    // E2EE media download fields — cần preserve để StickerBubble biết sticker có thể download
    ...(a.directPath ? { directPath: a.directPath } : {}),
    ...(a.mediaKey ? { mediaKey: a.mediaKey } : {}),
    ...(a.mediaSha256 ? { mediaSha256: a.mediaSha256 } : {}),
    ...(a.mediaEncSha256 ? { mediaEncSha256: a.mediaEncSha256 } : {}),
  });

  const attachments = msg.allAttachments && msg.allAttachments.length > 1
    ? JSON.stringify(msg.allAttachments.map((a: any) => serializeAtt(a, 'image')))
    : hasAttachment ? JSON.stringify([serializeAtt(msg.attachments, msgType)])
    : undefined;

  // quote_data is provided by backend broadcast (already has original message content)
  // or will be loaded from DB on reload (saveFBMessage now saves quote_data)
  // Only set reply_to_id if quote_data is not already available
  const hasQuoteData = !!msg.quote_data;
  const hasReplyToId = !!msg.replyToMessageId && !msg.quote_data;
  if (hasQuoteData) {
    console.log(`[useChatEvents] normalizeFBMessage: msgId=${msg.messageID} HAS quote_data`);
  } else if (hasReplyToId) {
    console.log(`[useChatEvents] normalizeFBMessage: msgId=${msg.messageID} reply_to_id=${msg.replyToMessageId}`);
  }
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
    ...(hasQuoteData ? { quote_data: msg.quote_data } : {}),
    ...(hasReplyToId ? { reply_to_id: msg.replyToMessageId } : {}),
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

      // Log quote_data from backend for debugging
      if (message.replyToMessageId || message.quote_data) {
        console.log(`[useChatEvents] fb:onMessage reply: msgId=${message.messageID} replyToId=${message.replyToMessageId} quoteData=${message.quote_data ? 'YES' : 'NO'}`);
      }

      const normalized = normalizeFBMessage(fbAccountId, message);
      const isSelf = !!message.isSelf || message.userID === fbAccountId;
      if (isSelf) {
        normalized.is_sent = 1;
        normalized.status = 'sent';
        normalized.sender_id = fbAccountId;
      }
      const store = useChatStore.getState();

      // If self-echo from MQTT, replace the temp message instead of adding duplicate
      // Build last message preview early (used by both temp-replacement and normal paths)
      const lastMsgPreview = normalized.content?.slice(0, 100)
        || (normalized.msg_type === 'image' || normalized.msg_type === 'photo' ? '🖼️ Hình ảnh'
          : normalized.msg_type === 'video' ? '🎬 Video'
          : normalized.msg_type === 'audio' ? '🎵 Audio'
          : normalized.msg_type !== 'text' ? '📎 Tệp đính kèm'
          : '[Tệp đính kèm]');

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
          // Update contact (last message preview + time) for conversation list
          store.updateContact(fbAccountId, {
            contact_id: threadId,
            last_message: lastMsgPreview,
            last_message_time: normalized.timestamp,
            channel: 'facebook',
          });
          return; // Don't add duplicate or increment unread
        }
      }

      // Log to detect echo overwrites
      const afterKey = `${fbAccountId}_${threadId}`;
      const afterExisting = useChatStore.getState().messages[afterKey] || [];
      const afterDup = afterExisting.findIndex((m) => String(m.msg_id) === normalized.msg_id);
      if (normalized.msg_type === 'sticker') {
        console.log(`[useChatEvents] [STICKER] addMessage: msgId=${normalized.msg_id} threadId=${threadId} isSelf=${isSelf} content=${normalized.content} attachments=${(normalized.attachments || '').slice(0,200)}`);
      }
      console.log(`[useChatEvents] fb:onMessage addMessage: msgId=${normalized.msg_id} threadId=${threadId} isSelf=${isSelf} alreadyExists=${afterDup >= 0} localPathInAtts=${normalized.attachments?.includes('localPath')} localPathInPaths=${typeof normalized.local_paths === 'object' ? JSON.stringify(normalized.local_paths) : normalized.local_paths}`);

      // Add message to store first
      store.addMessage(fbAccountId, threadId, normalized);

      // If this message has reply_to_id but no quote_data, try looking up
      // original message from the store (both should now be in the store)
      const replyToMsgId = normalized.reply_to_id;
      if (replyToMsgId && !normalized.quote_data) {
        const storeAfter = useChatStore.getState();
        const msgsAfter = storeAfter.messages[`${fbAccountId}_${threadId}`] || [];
        const origMsg = msgsAfter.find((m: MessageItem) => m.msg_id === replyToMsgId);
        if (origMsg?.content) {
          const idx = msgsAfter.findIndex((m: MessageItem) => m.msg_id === normalized.msg_id);
          if (idx >= 0) {
            const updated = [...msgsAfter];
            updated[idx] = {
              ...updated[idx],
              quote_data: JSON.stringify({ msgId: replyToMsgId, msg: origMsg.content, senderId: '', msgType: origMsg.msg_type || 'text' }),
            };
            storeAfter.setMessages(fbAccountId, threadId, updated);
            console.log(`[useChatEvents] Updated quote_data from store for msgId=${normalized.msg_id}`);
          }
        } else {
          // Fallback: try async DB lookup
          (async () => {
            try {
              const dbRes = await ipc.db?.getMessageById?.({ zaloId: fbAccountId, msgId: replyToMsgId });
              const dbMsg = dbRes?.message;
              if (dbMsg?.content) {
                const st = useChatStore.getState();
                const k = `${fbAccountId}_${threadId}`;
                const mList = st.messages[k] || [];
                const i = mList.findIndex((m: MessageItem) => m.msg_id === normalized.msg_id);
                if (i >= 0) {
                  const upd = [...mList];
                  upd[i] = { ...upd[i], quote_data: JSON.stringify({ msgId: replyToMsgId, msg: dbMsg.content, senderId: '', msgType: dbMsg.msg_type || 'text' }) };
                  st.setMessages(fbAccountId, threadId, upd);
                  console.log(`[useChatEvents] Updated quote_data from DB for msgId=${normalized.msg_id}`);
                }
              }
            } catch {}
          })();
        }
      }

      // Update contact (last message preview + time)
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

        // ─── Sound + Desktop notification cho FB messages ────────────────
        const appState = useAppStore.getState();
        const { isMuted, isInOthers, getNotifSettingsForAccount } = appState;
        const fbNotifSettings = getNotifSettingsForAccount(fbAccountId);
        const notifAllowed = !('Notification' in window) || Notification.permission === 'granted';
        if (!isMuted(fbAccountId, threadId) && !isInOthers(fbAccountId, threadId)) {
          if (fbNotifSettings.soundEnabled && notifAllowed) {
            playNotificationSound(fbNotifSettings.volume);
          }
          if (fbNotifSettings.desktopEnabled && notifAllowed) {
            // Resolve contact name from store
            const contacts = useChatStore.getState().contacts[fbAccountId] || [];
            const ctact = contacts.find(c => c.contact_id === threadId);
            const contactName = ctact?.display_name || message.userID || threadId;
            const contactAvatar = ctact?.avatar_url || undefined;
            const notifTitle = `[${getAccountDisplayName(fbAccountId)}] ${contactName}`;
            showDesktopNotification(
              notifTitle,
              lastMsgPreview,
              contactAvatar,
              { zaloId: fbAccountId, threadId, threadType: 0 }
            );
          }
        }
        ipc.app?.setBadge(getFilteredUnreadCount());
      }
    });
    if (unsubMsg) unsubscribers.push(unsubMsg);

    // ─── fb:onContactUpdate → cập nhật tên/avatar cho 1-1 Facebook ──────────────
    const unsubContact = ipc.on?.('fb:onContactUpdate', (data: {
      fbAccountId: string;
      contactId: string;
      name: string;
      avatarUrl: string;
    }) => {
      if (!data?.fbAccountId || !data?.contactId) return;
      const patch: any = { contact_id: data.contactId, channel: 'facebook' };
      if (data.name) patch.display_name = data.name;
      if (data.avatarUrl) patch.avatar_url = data.avatarUrl;
      useChatStore.getState().updateContact(data.fbAccountId, patch);
    });
    if (unsubContact) unsubscribers.push(unsubContact);

    // ─── fb:onConnectionStatus → accountStore ─────────────────────────────
    const unsubStatus = ipc.on?.('fb:onConnectionStatus', (data: {
      fbAccountId: string;
      status: string;
    }) => {
      if (!data?.fbAccountId) return;
      const { updateAccountStatus, updateListenerActive } = useAccountStore.getState();

      switch (data.status) {
        case 'connected':
          updateAccountStatus(data.fbAccountId, true, true);
          updateListenerActive(data.fbAccountId, true);
          // Reload contacts from DB after FB connects
          ipc.db?.getContacts(data.fbAccountId)
            .then((res: any) => {
              if (res?.contacts) {
                useChatStore.getState().setContacts(data.fbAccountId, res.contacts);
              }
            })
            .catch(() => {});
          break;

        case 'connecting':
          // isOnline=false, isConnected=true → badge hiển thị "Đang kết nối"
          updateAccountStatus(data.fbAccountId, false, true);
          break;

        case 'cookie_expired':
          // MQTT max retries (8 lần) → đánh dấu listener chết
          updateAccountStatus(data.fbAccountId, false, false);
          updateListenerActive(data.fbAccountId, false);
          // Thông báo user
          {
            const accounts = useAccountStore.getState().accounts;
            const acc = accounts.find((a: any) => a.zalo_id === data.fbAccountId || a.facebook_id === data.fbAccountId);
            const name = acc?.full_name || acc?.zalo_id || data.fbAccountId;
            useAppStore.getState().showNotification(
              `⚠️ Tài khoản Facebook "${name}" bị ngắt kết nối (FB phát hiện bot hoặc cookie hết hạn). Vui lòng đăng nhập lại FB để lấy cookie mới.`,
              'error'
            );
          }
          break;

        case 'error':
        case 'disconnected':
          updateAccountStatus(data.fbAccountId, false, false);
          break;
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

    // ─── fb:onEdit → chatStore.updateMessageEdit ──────────────────────────
    const unsubEdit = ipc.on?.('fb:onEdit', (data: {
      fbAccountId: string;
      messageId: string;
      threadId?: string;
      newText: string;
      editCount: number;
      timestampMs: number;
    }) => {
      if (!data?.fbAccountId || !data?.messageId) return;
      useChatStore.getState().updateMessageEdit(
        data.fbAccountId,
        data.threadId || '',
        data.messageId,
        data.newText,
        data.editCount,
        data.timestampMs
      );
    });
    if (unsubEdit) unsubscribers.push(unsubEdit);

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

    // ─── fb:onSeen → chatStore seen status (C8) ────────────────────────────
    const unsubSeen = ipc.on?.('fb:onSeen', (data: {
      fbAccountId: string;
      threadId: string;
      userId: string;
      timestamp: number;
    }) => {
      if (!data?.fbAccountId || !data?.threadId) return;
      useChatStore.getState().setSeen(data.fbAccountId, data.threadId, [data.userId], '0', false);
    });
    if (unsubSeen) unsubscribers.push(unsubSeen);

    // ─── fb:onE2EEStatus → account status update ──────────────────────────
    const unsubE2EEStatus = ipc.on?.('fb:onE2EEStatus', (data: {
      fbAccountId: string;
      status: string;
    }) => {
      if (!data?.fbAccountId) return;
      const isConnected = data.status === 'connected';
      if (isConnected) {
        console.log(`[useChatEvents] E2EE connected for ${data.fbAccountId}`);
      } else if (data.status === 'error') {
        console.warn(`[useChatEvents] E2EE error for ${data.fbAccountId}`);
      }
    });
    if (unsubE2EEStatus) unsubscribers.push(unsubE2EEStatus);

    // ─── fb:onThreadInfoUpdate → update contact display name / emoji (I4) ──
    const unsubThreadInfo = ipc.on?.('fb:onThreadInfoUpdate', (data: {
      fbAccountId: string;
      threadId: string;
      type: 'name' | 'emoji';
      name?: string;
      emoji?: string;
    }) => {
      if (!data?.fbAccountId || !data?.threadId) return;
      const update: any = { contact_id: data.threadId, channel: 'facebook' };
      if (data.type === 'name' && data.name) {
        update.display_name = data.name;
      } else if (data.type === 'emoji' && data.emoji) {
        update.fb_emoji = data.emoji;
      }
      useChatStore.getState().updateContact(data.fbAccountId, update);
    });
    if (unsubThreadInfo) unsubscribers.push(unsubThreadInfo);

    // ─── fb:onGroupEvent → participant changes (I4) ────────────────────────
    const unsubGroupEvent = ipc.on?.('fb:onGroupEvent', (data: {
      fbAccountId: string;
      threadId: string;
      type: string;
      participantId?: string;
      actorFbId?: string;
    }) => {
      if (!data?.fbAccountId || !data?.threadId) return;
      // Refresh contacts list so participant count gets synced
      ipc.fb?.getThreads({ accountId: data.fbAccountId, forceRefresh: false })
        .catch(() => {});
    });
    if (unsubGroupEvent) unsubscribers.push(unsubGroupEvent);

    // ─── event:localPath → cập nhật local_paths cho FB message sau khi download ──
    const unsubLocalPath = ipc.on?.('event:localPath', (data: {
      zaloId: string;
      msgId: string;
      threadId: string;
      localPaths: Record<string, string>;
    }) => {
      if (!data?.zaloId || !data?.msgId || !data?.threadId || !data?.localPaths) return;
      const store = useChatStore.getState();
      const key = `${data.zaloId}_${data.threadId}`;
      const msgs = store.messages[key] || [];
      const found = msgs.find(m => String(m.msg_id) === String(data.msgId));
      console.log(`[useChatEvents] event:localPath zaloId=${data.zaloId} msgId=${data.msgId} threadId=${data.threadId} key=${key} found=${!!found} localPaths=${JSON.stringify(data.localPaths)}`);
      if (found) {
        store.updateMessageLocalPath(data.zaloId, data.threadId, data.msgId, data.localPaths);
      } else {
        console.warn(`[useChatEvents] event:localPath message NOT FOUND in store! key=${key} msgId=${data.msgId}`);
      }
    });
    if (unsubLocalPath) unsubscribers.push(unsubLocalPath);

    return () => {
      unsubscribers.forEach((fn) => fn());
    };
  }, [activeThreadId]);
}

