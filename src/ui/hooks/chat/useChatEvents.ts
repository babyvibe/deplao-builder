/**
 * useChatEvents.ts
 * Unified event hook: listens to both Zalo and Facebook events,
 * normalizes them into the same chatStore (unified store).
 *
 * Phase B4: merges Facebook events into chatStore.
 * Zalo events are still handled by useZaloEvents (unchanged).
 * This hook only adds FB events → chatStore so ConversationList shows FB threads.
 */

import { useEffect } from 'react';
import ipc from '../../lib/ipc'
import { messageQueue } from '@/lib/chat/send/MessageQueue';
import DataAccessor from '../../lib/data/DataAccessor';;
import { getMessageCacheKey, useChatStore, type MessageItem } from '@/store/chat/chatStore';
import { stripMessengerFormatting } from '../../../shared/facebook/messengerFormatting';
import { FB_TEMPLATE_MSG_TYPE, fbTemplateText } from '../../../shared/facebook/facebookTemplate';
import { replyStateForIncoming } from '../../../shared/chat/replyState';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { reloadAccountContacts } from '@/lib/chat/conversations/accountContacts';
import { playNotificationSound, showDesktopNotification } from '../../lib/notifications/NotificationService';
import { inAppToastAllowed, useInAppNotifyStore } from '@/store/chat/inAppNotifyStore';
import { isChatPaneVisible } from '@/lib/chat/read/liveReadSync';
import { getFilteredUnreadCount } from '@/lib/notifications/badgeUtils';
import { applyRepeatedFbMessage } from '@/lib/chat/facebook/repeatedFbMessage';
import { ImageIcon, PaletteIcon, PaperclipIcon } from '@/components/common/icons';
import { tr } from '../../../shared/i18n';

/** Employee mode: Facebook events are relays from the Boss (the Facebook session only runs on the Boss). */
function isEmployeeMode(): boolean {
  return useEmployeeStore.getState().mode === 'employee';
}

/**
 * Gets the display name of the account from accountStore.
 * Used in the notification title to show which account the message came in on.
 */
function getAccountDisplayName(zaloId: string): string {
  const accounts = useAccountStore.getState().accounts;
  const acc = accounts.find(a => a.zalo_id === zaloId || a.facebook_id === zaloId);
  return acc?.full_name || acc?.zalo_id || zaloId;
}

/**
 * Generate human-readable preview from FB attachment metadata
 * Keeps the original type (sticker, image, video...) so MessageBubbles
 * decides how to render, based on msg_type.
 */
function fbAttachmentPreview(attachType: string, attObj: any): string {
  if (attachType === 'system') return ''; // System notifications use body text (admin msg), not a preview
  if (attachType === 'template' || attachType === FB_TEMPLATE_MSG_TYPE) return fbTemplateText(attObj?.template) || tr('📎 Tin nhắn mẫu');
  if (attachType === 'image' || attachType === 'photo') return tr('🖼️ Hình ảnh');
  if (attachType === 'video') return '🎬 Video';
  if (attachType === 'audio') return '🎵 Audio';
  if (attachType === 'sticker') return '🎨 Sticker';
  const name = attObj?.name;
  if (name) return `📎 ${name}`;
  if (attachType) return tr('📎 Tệp đính kèm');
  return '';
}

/**
 * Normalize one FB MQTT message into the chatStore MessageItem format
 * Keeps the original attachment type: MessageBubbles decides how to render it.
 * loadMessageFromDB (saveFBMessage) maps sticker→image, but the live event
 * keeps the type so StickerBubble/MediaBubble can handle it properly.
 */
function normalizeFBMessage(fbAccountId: string, msg: any): MessageItem {
  const threadId = msg.replyToID || msg.threadId || '';

  // hasAttachment: check that the id is valid + has a url or attachmentType
  const hasAttachment = !!(msg.attachments?.id && msg.attachments.id !== 0 &&
    (msg.attachments.url || msg.attachments.attachmentType));

  // rawType: keeps the original type from MQTT (sticker, image, video, file...)
  // Let the backend override msg_type (e.g. 'system' for admin notifications)
  const rawType = msg.msg_type || (!hasAttachment ? 'text' : (msg.attachments.attachmentType || 'image'));
  // Do NOT map sticker→image here: MessageBubbles.isStickerType handles it
  // Page template messages (card + buttons) → fb.template, same as the rows main saves in the DB
  const msgType = rawType === 'template' ? FB_TEMPLATE_MSG_TYPE : rawType;

  if (rawType === 'sticker') {
    console.log(`[useChatEvents] [STICKER] normalizeFBMessage: fbAccountId=${fbAccountId} msgId=${msg.messageID} threadId=${threadId} rawType=${rawType} msgType=${msgType} url=${(msg.attachments?.url || '').slice(0,100)}`);
  }

  // Generate display content: body text OR attachment preview
  const attachPreview = fbAttachmentPreview(rawType, msg.attachments);
  // FB sometimes sends body as "[file: name]" or "[image]" system text - prefer attachment preview
  const bodyIsSystemText = msg.body && /^\[.+\]$/.test(msg.body.trim());
  // Without an attachment, "[...]" is the real text (E2EE placeholders: view once, payment, poll…), not a file label
  const content = (!msg.body || (bodyIsSystemText && hasAttachment)) ? attachPreview : msg.body;

  const serializeAtt = (a: any, defaultType: string) => ({
    type: a.attachmentType || defaultType,
    url: a.url || null,
    id: String(a.id),
    ...(a.name ? { name: a.name } : {}),
    ...(a.fileSize != null ? { fileSize: a.fileSize } : {}),
    ...(a.mimeType ? { mimeType: a.mimeType } : {}),
    ...(a.localPath ? { localPath: a.localPath } : {}),
    // E2EE media download fields: must be preserved so StickerBubble knows the sticker can be downloaded
    ...(a.directPath ? { directPath: a.directPath } : {}),
    ...(a.mediaKey ? { mediaKey: a.mediaKey } : {}),
    ...(a.mediaSha256 ? { mediaSha256: a.mediaSha256 } : {}),
    ...(a.mediaEncSha256 ? { mediaEncSha256: a.mediaEncSha256 } : {}),
    ...(a.template ? { ...a.template, type: 'template' } : {}),
  });

  // The main process sends what it stored (sticker ids, mentions, poll…): the live bubble equals the reloaded one
  const attachments = typeof msg.storedAttachments === 'string' && msg.storedAttachments
    ? msg.storedAttachments
    : msg.allAttachments && msg.allAttachments.length > 1
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
    // Call card / poll: the stored content (JSON for the call card) instead of a text preview
    content: typeof msg.storedContent === 'string' ? msg.storedContent : content,
    msg_type: msgType,
    timestamp: parseInt(msg.timestamp) || Date.now(),
    is_sent: 0,
    status: 'received',
    channel: 'facebook',
    attachments,
    ...(hasQuoteData ? { quote_data: msg.quote_data } : {}),
    ...(hasReplyToId ? { reply_to_id: msg.replyToMessageId } : {}),
    // Self-delete timer of an encrypted chat (ms): the clock next to the time, like the stored row
    ...(Number(msg.ttl) > 0 ? { ttl: Number(msg.ttl) } : {}),
  } as MessageItem;
}

/** Whether the app window is in use: main reports it via 'app:windowFocus' (document.hasFocus() is not reliable in Electron). */
let appWindowFocused = typeof document === 'undefined' || document.hasFocus();
let appWindowFocusTracked = false;
function trackAppWindowFocus(): void {
  if (appWindowFocusTracked) return;
  appWindowFocusTracked = true;
  ipc.on?.('app:windowFocus', (focused: boolean) => { appWindowFocused = !!focused; });
}

/**
 * Hook that listens to FB events and updates the unified chatStore.
 * Call this hook at App level (same place as useZaloEvents).
 */
export function useChatEvents(): void {
  const activeThreadId = useChatStore((s) => s.activeThreadId);

  useEffect(() => {
    const unsubscribers: Array<() => void> = [];
    trackAppWindowFocus();

    // ─── fb:onMessage → chatStore.addMessage ──────────────────────────────
    const unsubMsg = ipc.on?.('fb:onMessage', (data: {
      fbAccountId: string;
      message: any;
      contactName?: string;
      contactAvatar?: string;
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
      // FacebookService has already compared the MQTT actor with the
      // account identity. Rechecking `userID` here can wrongly classify an
      // incoming message as sent when the frontend account id is stale.
      const isSelf = message.isSelf === true;
      if (isSelf) {
        normalized.is_sent = 1;
        normalized.status = 'sent';
        normalized.sender_id = message.userID || fbAccountId;
      }
      const store = useChatStore.getState();

      // The second copy of the same message (MQTT and the bridge both receive it) just repaired an empty row / a "File đính kèm không hiển thị" (attachment not shown) card
      // (main only re-emits when the DB is actually edited, an exact duplicate is not emitted): patch the message + preview, do not add to unread,
      // do not notify again.
      if (message.repeat === true) {
        applyRepeatedFbMessage(fbAccountId, threadId, normalized);
        return;
      }

      // If self-echo from MQTT, replace the temp message instead of adding duplicate
      // Build last message preview early (used by both temp-replacement and normal paths)
      // Messenger formatting marks (*bold*, _italic_…) are not shown in the list / notifications (the bubble shows the formatting)
      const lastMsgPreview = (typeof message.preview === 'string' && message.preview ? stripMessengerFormatting(message.preview).slice(0, 100) : '')
        || stripMessengerFormatting(normalized.content).slice(0, 100)
        || (normalized.msg_type === 'image' || normalized.msg_type === 'photo' ? tr('🖼️ Hình ảnh')
          : normalized.msg_type === 'video' ? '🎬 Video'
          : normalized.msg_type === 'audio' ? '🎵 Audio'
          : normalized.msg_type !== 'text' ? tr('📎 Tệp đính kèm')
          : tr('[Tệp đính kèm]'));

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
          updated[tempIdx] = { ...tempMsg, ...normalized, attachments: mergedAttachments, send_status: 'received' as const };
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

      // If it is a self-image → report to MessageQueue to count the batch
      if (isSelf && (normalized.msg_type === 'image' || normalized.msg_type === 'photo')) {
        messageQueue.onImageMessageReceived(fbAccountId, threadId, String(normalized.msg_id || ''));
      }

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
              const dbRes = await DataAccessor.getMessageById?.({ zaloId: fbAccountId, msgId: replyToMsgId });
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

      // Replied / not replied based on the latest real message (shared/chat/replyState): a message I sent from another machine = replied, a message from the other person
      // (even while the conversation is open) = not replied. Previously it only changed when the unread count went up
      const fbReplyState = replyStateForIncoming(
        { msgType: normalized.msg_type, timestamp: normalized.timestamp, isSelf },
        (useChatStore.getState().contacts[fbAccountId] || []).find(c => c.contact_id === threadId)?.last_message_time,
      );
      // A conversation the list has not loaded (new message request, older row): take its DB row (name, picture, type,
      // "Khác") instead of the bare row updateContact would make
      const knewThread = (useChatStore.getState().contacts[fbAccountId] || []).some(c => c.contact_id === threadId);
      if (!knewThread) {
        DataAccessor.getConversationsByIds(fbAccountId, [threadId]).then((res) => {
          const row = res?.success ? res.items?.[0] : null;
          if (!row) return;
          const current = (useChatStore.getState().contacts[fbAccountId] || []).find(c => c.contact_id === threadId);
          useChatStore.getState().updateContact(fbAccountId, {
            ...row,
            contact_id: threadId,
            // Keep the live message preview when it is newer than the stored row
            ...(current && Number(current.last_message_time || 0) > Number(row.last_message_time || 0)
              ? { last_message: current.last_message, last_message_time: current.last_message_time } : {}),
          });
          if (Number(row.is_in_others) === 1 || Number(row.is_muted) === 1) useAppStore.getState().loadFlags(fbAccountId).catch(() => {});
        }).catch(() => {});
      }

      // Update contact (last message preview + time)
      store.updateContact(fbAccountId, {
        contact_id: threadId,
        // A brand-new row was always made a 'user' conversation (a new group then opened / replied as a 1-1 chat)
        ...(data.message?.threadKind === 'group' || data.message?.threadKind === 'user' ? { contact_type: data.message.threadKind } : {}),
        ...(data.contactName ? { display_name: data.contactName } : {}),
        ...(data.contactAvatar ? { avatar_url: data.contactAvatar } : {}),
        last_message: lastMsgPreview,
        last_message_time: normalized.timestamp,
        channel: 'facebook',
        ...(fbReplyState !== undefined ? { is_replied: fbReplyState } : {}),
      });

      // The name / picture of a new conversation is looked up by the main process in the background (FacebookProfileResolver,
      // retried with backoff) and arrives as db:contactProfileUpdated; the one-shot lookup that used to run here never retried
      // and treated "name = id" as a name.

      // Increment unread if not currently viewing this thread and not self-sent
      const currentActive = useChatStore.getState().activeThreadId;
      if (!isSelf) {
        if (currentActive !== threadId) store.incrementUnread(fbAccountId, threadId);

        // ─── Sound + in-app notification + OS popup for FB messages (one single place) ──────────
        // The conversation shown on screen in the window in use → no notification (already seen). A background window still notifies, even
        // when it is the open conversation (previously App.tsx notified this part separately → each FB message rang twice, with 2 popups).
        const windowFocused = appWindowFocused;
        const onScreen = currentActive === threadId
          && useAccountStore.getState().activeAccountId === fbAccountId
          && isChatPaneVisible();
        const appState = useAppStore.getState();
        const { isMuted, isInOthers, isZaloHidden, getNotifSettingsForAccount } = appState;
        if ((!onScreen || !windowFocused)
          && !isMuted(fbAccountId, threadId) && !isInOthers(fbAccountId, threadId) && !isZaloHidden(fbAccountId, threadId)) {
          const fbNotifSettings = getNotifSettingsForAccount(fbAccountId);
          const notifAllowed = !('Notification' in window) || Notification.permission === 'granted';
          if (fbNotifSettings.soundEnabled && notifAllowed) {
            playNotificationSound(fbNotifSettings.volume);
          }
          // Resolve contact name from store
          const contacts = useChatStore.getState().contacts[fbAccountId] || [];
          const ctact = contacts.find(c => c.contact_id === threadId);
          const contactName = ctact?.alias || ctact?.display_name || data.contactName || message.userID || threadId;
          const isGroupThread = ctact?.contact_type === 'group' || message.type === 'group' || message.isGroup === true;
          const showToast = !onScreen && inAppToastAllowed({
            accountId: fbAccountId, msgType: normalized.msg_type, timestamp: normalized.timestamp, onScreen: false,
          });
          if (showToast) {
            useInAppNotifyStore.getState().push({
              accountId: fbAccountId,
              threadId,
              threadType: isGroupThread ? 1 : 0,
              msgId: String(normalized.msg_id || ''),
              conversation: contactName,
              sender: isGroupThread ? String(message.senderName || '') : '',
              text: lastMsgPreview,
            });
          }
          // The app is in use and the in-app tab is already shown → do not turn on another OS popup for the same message
          if (fbNotifSettings.desktopEnabled && notifAllowed && !(showToast && windowFocused)) {
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
        if (currentActive !== threadId) ipc.app?.setBadge(getFilteredUnreadCount());
      }
    });
    if (unsubMsg) unsubscribers.push(unsubMsg);

    // ─── fb:onThreadsSynced → conversations saved by the bridge inbox / history sync: reload the list ─────
    // (the list loaded at "connected", before the sync; new conversations used to appear only at the next reload)
    const syncReloadTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const unsubThreadsSynced = ipc.on?.('fb:onThreadsSynced', (data: { fbAccountId?: string }) => {
      const fbAccountId = String(data?.fbAccountId || '');
      if (!fbAccountId) return;
      const pending = syncReloadTimers.get(fbAccountId);
      if (pending) clearTimeout(pending);
      syncReloadTimers.set(fbAccountId, setTimeout(() => {
        syncReloadTimers.delete(fbAccountId);
        reloadAccountContacts(fbAccountId).catch(() => {});
        // Mute / "Khác" (message requests) come from Messenger too
        useAppStore.getState().loadFlags(fbAccountId).catch(() => {});
      }, 1500));
    });
    if (unsubThreadsSynced) unsubscribers.push(unsubThreadsSynced);

    // ─── fb:onMessagePatch → a stored message changed (poll votes, media links fetched again) ─────
    const unsubPatch = ipc.on?.('fb:onMessagePatch', (data: {
      fbAccountId?: string; threadId?: string; messageId?: string; attachments?: string; content?: string; msgType?: string;
    }) => {
      const fbAccountId = String(data?.fbAccountId || '');
      const threadId = String(data?.threadId || '');
      const messageId = String(data?.messageId || '');
      if (!fbAccountId || !threadId || !messageId) return;
      useChatStore.getState().patchMessage(fbAccountId, threadId, messageId, {
        ...(typeof data.attachments === 'string' ? { attachments: data.attachments } : {}),
        ...(typeof data.content === 'string' ? { content: data.content } : {}),
        // An admin line that turned out to be a poll (the poll copy came second) becomes the poll card
        ...(typeof data.msgType === 'string' && data.msgType ? { msg_type: data.msgType } : {}),
      });
    });
    if (unsubPatch) unsubscribers.push(unsubPatch);
    unsubscribers.push(() => { for (const timer of syncReloadTimers.values()) clearTimeout(timer); syncReloadTimers.clear(); });

    // ─── fb:onContactUpdate → update name/avatar for 1-1 Facebook ──────────────
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
          // Reload contacts after FB connects. Boss: DB; employee (relay event): BOSS REST (ipc.db.getContacts on the employee machine
          // is only a stub, a read error keeps the list)
          reloadAccountContacts(data.fbAccountId).catch(() => {});
          break;

        case 'connecting':
          // isOnline=false, isConnected=true → badge shows "Đang kết nối" (Connecting)
          updateAccountStatus(data.fbAccountId, false, true);
          break;

        case 'cookie_expired':
          // MQTT max retries (8 times) → mark the listener as dead
          updateAccountStatus(data.fbAccountId, false, false);
          updateListenerActive(data.fbAccountId, false);
          // User notification
          {
            const accounts = useAccountStore.getState().accounts;
            const acc = accounts.find((a: any) => a.zalo_id === data.fbAccountId || a.facebook_id === data.fbAccountId);
            const name = acc?.full_name || acc?.zalo_id || data.fbAccountId;
            useAppStore.getState().showNotification(
              tr('⚠️ Tài khoản Facebook "{{name}}" đã hết phiên đăng nhập (FB phát hiện bất thường hoặc cookie hết hạn). Vào Dashboard → "Đăng nhập lại" để đăng nhập lại.', { name }),
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
      threadId?: string;
    }) => {
      if (!data?.fbAccountId || !data?.messageId) return;
      const threadId = String(data.threadId || '');
      useChatStore.getState().recallMessage(data.fbAccountId, data.messageId, threadId || undefined);
      // The newest message of the conversation was unsent: the list preview stops showing its text (main updated the DB)
      if (threadId) {
        const store = useChatStore.getState();
        const msgs = store.messages[getMessageCacheKey(data.fbAccountId, threadId)] || [];
        const last = msgs[msgs.length - 1];
        if (last && String(last.msg_id) === String(data.messageId)) {
          store.updateContact(data.fbAccountId, { contact_id: threadId, last_message: tr('↩ Tin nhắn đã thu hồi') });
        }
      }
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
      // Need threadId to update reaction - search through cached messages if not provided
      if (data.threadId) {
        // Messenger: each person has one reaction / message (as in DB, persistReactionToDB) → 'set'; accumulating them as one reaction shows "2"
        // when the reaction is reported again
        useChatStore.getState().updateMessageReaction(
          data.fbAccountId, data.threadId, data.messageId, data.userId, data.emoji, 'set'
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
      type: 'name' | 'emoji' | 'cannotReply' | 'disappearing';
      name?: string;
      emoji?: string;
      cannotReply?: string;
      ttl?: number;
    }) => {
      if (!data?.fbAccountId || !data?.threadId) return;
      const update: any = { contact_id: data.threadId, channel: 'facebook' };
      if (data.type === 'name' && data.name) {
        update.display_name = data.name;
      } else if (data.type === 'emoji' && data.emoji) {
        update.fb_emoji = data.emoji;
      } else if (data.type === 'cannotReply') {
        update.fb_cannot_reply = String(data.cannotReply || '');
      } else if (data.type === 'disappearing') {
        update.fb_disappearing_ttl = Math.max(0, Number(data.ttl) || 0);
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
      // Employee: no session / local Facebook DB on the employee machine: getThreads on an employee machine only retries the connection, which is useless
      if (isEmployeeMode()) return;
      // Refresh contacts list so participant count gets synced
      ipc.fb?.getThreads({ accountId: data.fbAccountId, forceRefresh: false })
        .catch(() => {});
    });
    if (unsubGroupEvent) unsubscribers.push(unsubGroupEvent);

    // ─── event:localPath → update local_paths for the message after download ──
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
      if (found) {
        store.updateMessageLocalPath(data.zaloId, data.threadId, data.msgId, data.localPaths);
      } else {
        // Message might not be in store yet (race condition with event:message).
        // Retry after delay to allow the message to be added.
        setTimeout(() => {
          const retryStore = useChatStore.getState();
          const retryMsgs = retryStore.messages[key] || [];
          const retryFound = retryMsgs.find(m => String(m.msg_id) === String(data.msgId));
          if (retryFound) {
            retryStore.updateMessageLocalPath(data.zaloId, data.threadId, data.msgId, data.localPaths);
          }
        }, 500);
      }
    });
    if (unsubLocalPath) unsubscribers.push(unsubLocalPath);

    return () => {
      unsubscribers.forEach((fn) => fn());
    };
  }, [activeThreadId]);
}
