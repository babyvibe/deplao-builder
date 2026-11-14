import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {useChatStore, type MessageItem} from '@/store/chat/chatStore';
import { forgetReplyDraft, getReplyDraft, replyDraftKey, saveReplyDraft } from '@/lib/chat/composer/replyDrafts';
import { liveReadSync } from '@/lib/chat/read/liveReadSync';
import { fetchDroppedImages, isImageFile, readDropPayload, type DropPayload } from '@/lib/chat/media/dropFiles';
import Logger from '../../../../utils/Logger';
import { useShallow } from 'zustand/react/shallow';
import {useAccountStore} from '@/store/accounts/accountStore';
import {useAppStore} from '@/store/app/appStore';
import {useEmployeeStore} from '@/store/employee/employeeStore';
import ipc, { buildZaloAuth } from '@/lib/ipc'
import { openTelegramMiniApp } from '@/lib/chat/telegram/telegramMiniApp';
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import { useMentionMembers } from '@/hooks/chat/useMentionMembers';
import { useAiReplySuggestions } from '@/hooks/chat/useAiReplySuggestions';
import { aiSuggestKindOf } from '@/lib/chat/composer/aiReplySuggestions';
import {
  EMPTY_THREAD_LOCAL_LABELS, nextThreadLocalLabels, sortActiveLocalLabels, threadLabelsKey, toLabelIdSet,
  type ThreadLocalLabelsState,
} from '@/lib/chat/chatLoadFailures';
import { relayEventAccount, THREAD_LABELS_CHANGED_EVENT, threadLabelsEventTouches } from '@/lib/chat/realtime/relayUiEvents';
import { messageQueue, generateTempId, extractMsgIdFromResponse } from '@/lib/chat/send/MessageQueue';
import { Spinner } from '@/components/common/PageLoading';
import AccountAssignmentPopup from './AccountAssignmentPopup';
import AiSuggestionMenu from './AiSuggestionMenu';
import {SendCardModal} from '../groups/GroupModals';
import {CreatePollDialog} from '../polls/CreatePollDialog';
import {NoteViewModal} from '../groups/NoteViewModal';
import BankCardModal from './BankCardModal';
import ZaloCatalogPicker from '../zalo/catalog/ZaloCatalogPicker';
import LibraryPickerModal from './LibraryPickerModal';
import {
  fetchQuickMessages,
  invalidateZaloQuickMessageCache,
  QuickMessage,
  QuickMessageDropdown,
  QuickMessageManagerPanel,
} from './QuickMessageManager';
import ReminderPanel from '../reminders/ReminderPanel';
import { matchesShortcut } from '../../common/inputs/LabelEmojiPicker';
import { getCapability } from '../../../../configs/channels/channelConfig';
import { isNonZalo, isTelegramBot, isTelegramUser, isTelegram, isFacebook, isZalo, CHANNEL, isTelegramForumGeneral, resolveChannel } from '@/lib/channels/channelHelper';
import { isTelegramQuotePlaceholder, telegramQuoteMedia } from '@/lib/chat/messages/messageParser';
import { getTelegramMembershipNotice } from '@/lib/telegram/telegramMembership';
import * as channelIpc from '../../../lib/channels/channelIpc';
import { getAdapter } from '@/lib/channels/adapters/registry';
import { extractVideoThumbViaCanvas } from '@/lib/chat/media/videoUtils';
import { EMOJI_CATEGORIES, QUICK_EMOJIS } from '@/lib/chat/messages/emojiUtils';
import PluginComposerButtons from '@/components/plugins/contributions/PluginComposerButtons';
import { TelegramMediaPicker, lastTelegramPickerTab } from '../telegram/stickers/TelegramMediaPicker';
import { sendTelegramStickerItem, type TelegramStickerItem } from '@/lib/chat/telegram/telegramStickerStore';
import { AlertIcon, AwardIcon, BellIcon, BookmarkIcon, BotIcon, ChartIcon, ChatIcon, CheckIcon, ClipboardListIcon, ClockIcon, CreditCardIcon, DollarIcon, EditIcon, FileTextIcon, FolderIcon, GiftIcon, GlobeIcon, KeyIcon, LightbulbIcon, LightningIcon, LinkIcon, PackageIcon, PinIcon, PluginIcon, RefreshIcon, SearchIcon, SettingsIcon, ShoppingCartIcon, SmartphoneIcon, SmileIcon, SparklesIcon, StarIcon, StoreIcon, TagIcon, TargetIcon, TrashIcon, TrendingUpIcon, TruckIcon, UserIcon } from '@/components/common/icons';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import { ComposerTargetContext } from './composerTarget';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** Quote (quote payload) → id of the replied message, sent into the Telegram forum topic / comment thread. */
function quotedMessageId(payload?: string | null): string | undefined {
  if (!payload) return undefined;
  try {
    const quote = JSON.parse(payload);
    const id = String(quote?.msgId ?? quote?.msg_id ?? '');
    return /^\d+$/.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

interface LocalLabel {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  emoji?: string;
  sort_order?: number;
  shortcut?: string;
}

/** Contact card suggestion state, used when a phone number starting with 0xx is detected in the input */
interface ContactCardSuggestion {
  userId: string;
  displayName: string;
  avatarUrl: string;
  phone: string;
}

// extractVideoThumbViaCanvas: imported from @/lib/chat/media/videoUtils
// EMOJI_CATEGORIES, QUICK_EMOJIS: imported from @/lib/chat/messages/emojiUtils

export default function MessageInput() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [joiningTelegramGroup, setJoiningTelegramGroup] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [showSendCard, setShowSendCard] = useState(false);
  const [showBankCard, setShowBankCard] = useState(false);
  const [showCatalog, setShowCatalog] = useState(false);
  const [showCreatePoll, setShowCreatePoll] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showCreateNote, setShowCreateNote] = useState(false);
  const [showFormatBar, setShowFormatBar] = useState(false);
  // Library picker
  const [showLibraryPicker, setShowLibraryPicker] = useState(false);
  const [libraryPickerType, setLibraryPickerType] = useState<'image' | 'video' | 'file' | 'all'>('all');
  // Format ranges: each entry = { start, len, st }, following the zca-js Style[] format
  const [fmtRanges, setFmtRanges] = useState<Array<{ start: number; len: number; st: string }>>([]);
  // Active formats at the cursor (to highlight the toolbar buttons)
  const [activeFmts, setActiveFmts] = useState<Set<string>>(new Set());
  // Quick message states
  const [quickMessages, setQuickMessages] = useState<QuickMessage[]>([]);
  const [showQuickDropdown, setShowQuickDropdown] = useState(false);
  const [quickFilter, setQuickFilter] = useState('');
  const [quickSelectedIdx, setQuickSelectedIdx] = useState(0);
  const [quickTriggerPos, setQuickTriggerPos] = useState(-1);
  const [showQuickManager, setShowQuickManager] = useState(false);
  const [showReminderPopup, setShowReminderPopup] = useState(false);
  // Bot commands menu state
  const [showBotMenu, setShowBotMenu] = useState(false);
  const [botCommands, setBotCommands] = useState<Array<{ command: string; description: string }>>([]);
  const [botCommandsLoading, setBotCommandsLoading] = useState(false);
  const [botCmdSelectedIdx, setBotCmdSelectedIdx] = useState(0);
  const botMenuRef = useRef<HTMLDivElement>(null);
  // Voice recording states
  const [isRecording, setIsRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordingCancelledRef = useRef(false);
  // @ mention states
  const [mentionSearch, setMentionSearch] = useState('');
  const [showMentionDropdown, setShowMentionDropdown] = useState(false);
  const [mentionTriggerPos, setMentionTriggerPos] = useState(-1);
  const [mentionSelectedIdx, setMentionSelectedIdx] = useState(0);
  const [mentions, setMentions] = useState<Array<{ uid: string; pos: number; len: number; text: string }>>([]);
  // Clipboard images state: {id, dataUrl, blob}[]
  const [clipboardImages, setClipboardImages] = useState<Array<{ id: string; dataUrl: string; blob: Blob }>>([]);
  // Drag-and-drop state
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  // Local labels (the account's list + the labels attached to the conversation). A failed read (employee mode: BOSS connection lost)
  // keep the current labels of the same account / conversation instead of going empty, and show a compact "Thử lại" (Retry) on the label row.
  const [localLabelState, setLocalLabelState] = useState<ThreadLocalLabelsState<LocalLabel>>(EMPTY_THREAD_LOCAL_LABELS);
  const localLabels = localLabelState.labels;
  const threadLocalLabelIds = localLabelState.threadLabelIds;
  const localLabelsFailed = localLabelState.failed;
  const localLabelOwnerRef = useRef('');
  const [togglingLocalLabelId, setTogglingLocalLabelId] = useState<number | null>(null);
  // Pinned shortcut: id of shortcut whose icon edit picker is open
  const [pinnedEditIconId, setPinnedEditIconId] = useState<string | null>(null);
  // Pinned shortcut: id of shortcut whose right-click context menu is open
  const [pinnedCtxMenu, setPinnedCtxMenu] = useState<string | null>(null);
  // AI suggestions dropdown menu
  const [showAiMenu, setShowAiMenu] = useState(false);
  const [showAiAssignmentPopup, setShowAiAssignmentPopup] = useState(false);
  // Inline sticker suggestions (above input area)
  const [inlineStickerSuggestions, setInlineStickerSuggestions] = useState<any[]>([]);
  const inlineStickerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inlineStickerLastKwRef = useRef<string>('');
  // Keyboard shortcuts popup
  const [showShortcuts, setShowShortcuts] = useState(false);
  const shortcutsBtnRef = useRef<HTMLButtonElement>(null);

  // ─── Contact card suggestion (phone number 0xx detection) ────────────────────────────
  const [contactCardSuggestion, setContactCardSuggestion] = useState<ContactCardSuggestion | null>(null);
  const [contactCardLoading, setContactCardLoading] = useState(false);
  const contactCardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastDetectedPhoneRef = useRef<string>('');

  const textareaRef = useRef<HTMLDivElement>(null);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const stickerToolbarRef = useRef<HTMLDivElement>(null);
  const moreMenuBtnRef = useRef<HTMLButtonElement>(null);
  const aiMenuRef = useRef<HTMLDivElement>(null);
  // Track IME composition state (Vietnamese, Chinese, etc.) to avoid
  // clearing input before compositionend on macOS
  const isComposingRef = useRef(false);
  // Flag to prevent compositionEnd/input from re-inserting text after send
  const justSentRef = useRef(false);
  // Track the previous plain text to compute the delta shift for fmtRanges
  const prevTextRef = useRef<string>('');
  // Track previous thread to save draft on switch
  const prevThreadRef = useRef<{ accountId: string; threadId: string } | null>(null);
  // Debounce timer for auto-saving draft while typing (~1s)
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Selector: the composer (a large component) does not re-render for messages / typing / seen events of other conversations
  const { activeThreadId: storeThreadId, activeThreadType: storeThreadType, activeTopicId: storeTopicId, addMessage, removeMessage, replyTo, setReplyTo, editingMsg, setEditingMsg, markReplied, setDraft, clearDraft } = useChatStore(useShallow(s => ({
    activeThreadId: s.activeThreadId, activeThreadType: s.activeThreadType, activeTopicId: s.activeTopicId,
    addMessage: s.addMessage, removeMessage: s.removeMessage, replyTo: s.replyTo,
    setReplyTo: s.setReplyTo, editingMsg: s.editingMsg, setEditingMsg: s.setEditingMsg, markReplied: s.markReplied,
    setDraft: s.setDraft, clearDraft: s.clearDraft,
  })));
  const { activeAccountId: storeAccountId, getActiveAccount, accounts: allAccounts } = useAccountStore(useShallow(s => ({
    activeAccountId: s.activeAccountId, getActiveAccount: s.getActiveAccount, accounts: s.accounts,
  })));
  // Composer of the Telegram channel post comments: sends to the discussion group, topic = the root message (composerTarget.ts).
  // If absent → the open conversation / topic, as before.
  const composerTarget = React.useContext(ComposerTargetContext);
  const commentMode = composerTarget?.kind === 'telegramComments';
  const activeAccountId = composerTarget ? composerTarget.accountId : storeAccountId;
  const activeThreadId = composerTarget ? composerTarget.threadId : storeThreadId;
  const activeThreadType = composerTarget ? composerTarget.threadType : storeThreadType;
  const activeTopicId = composerTarget ? composerTarget.topicId : storeTopicId;
  const { showNotification, setGroupInfo, mergedInboxMode, toggleIntegrationQuickPanel, pinnedIntegrationShortcuts, unpinIntegrationShortcut, editPinnedShortcutIcon, openIntegrationPanelTo, isAiSuggestDisabled, aiSuggestKinds, aiSuggestCount } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification, setGroupInfo: s.setGroupInfo, mergedInboxMode: s.mergedInboxMode,
    toggleIntegrationQuickPanel: s.toggleIntegrationQuickPanel, pinnedIntegrationShortcuts: s.pinnedIntegrationShortcuts,
    unpinIntegrationShortcut: s.unpinIntegrationShortcut, editPinnedShortcutIcon: s.editPinnedShortcutIcon,
    openIntegrationPanelTo: s.openIntegrationPanelTo,
    isAiSuggestDisabled: s.isAiSuggestDisabled, aiSuggestKinds: s.aiSuggestKinds, aiSuggestCount: s.aiSuggestCount,
    // Not used directly: turning suggestions on / off (all, per conversation / account) → re-render so isAiSuggestDisabled is recomputed
    aiSuggestionsEnabled: s.aiSuggestionsEnabled, aiSuggestDisabledThreads: s.aiSuggestDisabledThreads,
    aiSuggestDisabledAccounts: s.aiSuggestDisabledAccounts,
  })));
  // Info of the open group (members for @mention): does not re-render when another group updates
  const threadGroupInfo = useAppStore(s => (
    activeAccountId && activeThreadId ? s.groupInfoCache?.[activeAccountId]?.[activeThreadId] : undefined
  ));

  // Channel capability for active thread
  const storeContact = useChatStore(s => (s.contacts[activeAccountId || ''] || []).find(c => c.contact_id === activeThreadId));
  // Comments section: a discussion group not joined yet is not in the conversation list → the contact is given by the comments section
  const targetContact = storeContact ?? (composerTarget?.contact as unknown as typeof storeContact);
  // The real channel (resolveChannel): Telegram / Facebook accounts send through the account's own channel, including old rows that say 'zalo' or a conversation
  // not in the store yet (pinned conversation / My Documents loaded by id afterwards): never send through Zalo
  const accountChannel = allAccounts.find((a) => a.zalo_id === activeAccountId)?.channel;
  const activeContact = React.useMemo(() => {
    if (!isNonZalo(accountChannel)) return targetContact;
    const channel = resolveChannel(targetContact, { channel: accountChannel });
    if (targetContact) return targetContact.channel === channel ? targetContact : { ...targetContact, channel };
    return activeThreadId ? ({ contact_id: activeThreadId, channel } as NonNullable<typeof storeContact>) : undefined;
  }, [targetContact, accountChannel, activeThreadId]);
  // Draft: the comments section keeps its own draft (not mixed with the draft of the discussion group itself)
  const draftThreadId = commentMode && activeThreadId ? `${activeThreadId}#comments:${activeTopicId}` : activeThreadId;
  const draftTargetRef = useRef({ accountId: activeAccountId, threadId: draftThreadId });
  draftTargetRef.current = { accountId: activeAccountId, threadId: draftThreadId };
  const channelCap = getCapability((activeContact?.channel || CHANNEL.ZALO) as any);
  // Only the "đã đóng" (closed) flag of the open topic: the topic list changes with every new message (forumTopicsLive), so the input is not re-rendered
  const activeTopicClosed = useChatStore(s => !!(activeAccountId && activeThreadId && activeTopicId
    && (s.forumTopics[`${activeAccountId}_${activeThreadId}`] || []).find((topic: any) =>
      String(topic.rootMessageId || topic.id) === String(activeTopicId))?.isClosed));

  // Employee mode: check permission to show/hide media features
  const empMode = useEmployeeStore(s => s.mode);
  const hasChatPermission = useEmployeeStore(s => s.mode !== 'employee' || !!s.permissions['chat']);
  // Product catalog (ZL-04): Zalo Business accounts only
  const canSendProducts = channelCap.supportsProductCatalog && hasChatPermission
    && !!allAccounts.find((a) => a.zalo_id === activeAccountId)?.is_business;

  // state
  const [showLocalLabels, setShowLocalLabels] = useState(true);
  const [localLabelExpanded, setLocalLabelExpanded] = useState(false);
  const [localLabelCanExpand, setLocalLabelCanExpand] = useState(false);
  const labelRowRef = useRef<HTMLDivElement>(null);

  // measure the height to know whether it overflows
  useLayoutEffect(() => {
    const saved = localStorage.getItem('show_local_labels');
    if (saved !== null) setShowLocalLabels(saved === '1');

    const el = labelRowRef.current;
    if (!el) return;

    // Assume 1 row ~ 28px (depends on the design); can be measured exactly from the first label
    const rowHeight = 28;
    const maxCollapsed = rowHeight * 2;

    // If scrollHeight > maxCollapsed => can expand
    setLocalLabelCanExpand(el.scrollHeight > maxCollapsed);
  }, [localLabels, threadLocalLabelIds]);

  // toggle handler
  const toggleLocalLabels = () => {
    setShowLocalLabels(prev => {
      const next = !prev;
      localStorage.setItem('show_local_labels', next ? '1' : '0');
      return next;
    });
  };

  // Open conversation: a late response from the previous conversation must not overwrite this conversation's labels
  localLabelOwnerRef.current = activeAccountId && activeThreadId ? threadLabelsKey(activeAccountId, activeThreadId) : '';

  const loadLocalLabelsForThread = useCallback(async () => {
    // Comments section: no Local labels (labels belong to the conversation)
    if (!activeAccountId || !activeThreadId || commentMode) {
      setLocalLabelState(EMPTY_THREAD_LOCAL_LABELS);
      return;
    }
    const accountId = activeAccountId;
    const threadId = activeThreadId;
    const [labelsRes, threadRes] = await Promise.all([
      DataAccessor.getLocalLabels({ zaloId: accountId }).catch(() => null),
      DataAccessor.getThreadLocalLabels({ zaloId: accountId, threadId }).catch(() => null),
    ]);
    if (localLabelOwnerRef.current !== threadLabelsKey(accountId, threadId)) return;
    const labelsOk = !!labelsRes && !isReadFailure(labelsRes);
    const threadOk = !!threadRes && !isReadFailure(threadRes);
    if (!labelsOk || !threadOk) {
      console.warn('[MessageInput] Không tải được Nhãn Local:', readFailureMessage(labelsOk ? threadRes : labelsRes) || 'lỗi không rõ');
    }
    // Error → keep the list of the same account / the labels already attached to the same conversation (a different conversation: "unknown", do not borrow)
    setLocalLabelState(prev => nextThreadLocalLabels(
      prev, accountId, threadId,
      labelsOk ? sortActiveLocalLabels<LocalLabel>(labelsRes?.labels) : null,
      threadOk ? toLabelIdSet(threadRes?.labels) : null,
    ));
  }, [activeAccountId, activeThreadId, commentMode]);

  // Employee mode: BOSS connection recovers → reload the Local labels of the open conversation
  useEmployeeResync(loadLocalLabelsForThread);

  // Local labels changed somewhere else (ChatHeader, CRM, Boss / another employee via relay) → reload the labels of the open conversation.
  // Previously the composer only loaded when the conversation changed, so labels someone else just added did not show.
  useEffect(() => {
    const handleLabels = (e: Event) => {
      const owner = relayEventAccount((e as CustomEvent).detail);
      if (!owner || owner === activeAccountId) void loadLocalLabelsForThread();
    };
    const handleThreadLabels = (e: Event) => {
      if (threadLabelsEventTouches((e as CustomEvent).detail, activeAccountId, activeThreadId)) void loadLocalLabelsForThread();
    };
    window.addEventListener('local-labels-changed', handleLabels);
    window.addEventListener(THREAD_LABELS_CHANGED_EVENT, handleThreadLabels);
    return () => {
      window.removeEventListener('local-labels-changed', handleLabels);
      window.removeEventListener(THREAD_LABELS_CHANGED_EVENT, handleThreadLabels);
    };
  }, [activeAccountId, activeThreadId, loadLocalLabelsForThread]);

  // ─── AI: listen for insert-to-chat events from AIQuickPanel ──────────────
  useEffect(() => {
    const handler = (e: Event) => {
      const text = (e as CustomEvent).detail?.text;
      if (text && textareaRef.current) {
        textareaRef.current.innerText = text;
        setText(text);
      }
    };
    window.addEventListener('ai:insertToChat', handler);
    return () => window.removeEventListener('ai:insertToChat', handler);
  }, []);

  // ─── AI reply suggestions (hooks/chat/useAiReplySuggestions) ─────────────────
  // The bar only shows when suggestions exist from the account's "Gợi ý" (Suggest) assistant; while calling AI → a small spinner on the AI button in the toolbar
  // (previously the "Đang gợi ý…" (Suggesting…) bar appeared and vanished / changed height with every new message → the chat frame jumped).
  // Set in the AI button menu: conversation types that get suggestions (personal / group; Telegram also adds topics / channels / bots), number of suggestions, assistant.
  const aiSuggestKind = aiSuggestKindOf(activeContact, activeThreadType, activeTopicId);
  const aiSuggestOn = !commentMode && !!activeAccountId && !!activeThreadId
    && !isAiSuggestDisabled(activeAccountId, activeThreadId) && aiSuggestKinds[aiSuggestKind];
  const aiSuggest = useAiReplySuggestions({
    accountId: activeAccountId, threadId: activeThreadId, topicId: activeTopicId, enabled: aiSuggestOn, count: aiSuggestCount,
  });

  // ─── Outgoing typing event (debounced) ────────────────────────────────────
  // Following the standard of the big platforms (WhatsApp/Telegram):
  //   - Send a typing notification when typing starts (only once per 4 seconds)
  //   - Stop automatically after 6 seconds without typing
  const lastTypingSentRef = useRef<number>(0);
  const typingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendTypingEvent = useCallback(() => {
    // Comments section: "đang gõ" (typing) of the group shows on the main line of the discussion group → do not send
    if (!activeAccountId || !activeThreadId || commentMode) return;
    const now = Date.now();
    // Throttle: send at most once per 4 seconds
    if (now - lastTypingSentRef.current < 4000) return;
    lastTypingSentRef.current = now;

    const account = getActiveAccount();
    if (!account) return;
    const channel = activeContact?.channel || CHANNEL.ZALO;
    if (isNonZalo(channel)) {
      channelIpc.sendTyping(channel as any, {
        accountId: activeAccountId,
        threadId: activeThreadId,
        isTyping: true,
        isGroup: activeThreadType === 1,
      }).catch(() => {});
    } else {
      const auth = buildZaloAuth(account);
      (ipc.zalo as any)?.sendTyping?.({ auth, threadId: activeThreadId, type: activeThreadType })?.catch?.(() => {});
    }

    // Reset stop timer
    if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = setTimeout(() => {
      lastTypingSentRef.current = 0; // Reset so that the next typing sends again right away
    }, 6000);
  }, [activeAccountId, activeThreadId, activeThreadType, activeContact?.channel, getActiveAccount, commentMode]);

  // @ mentions (like Telegram): the list is read straight from the DB by page, with saved @usernames, scroll to load more; Telegram gets
  // recent members / searches by the typed text on Telegram when needed, then SAVES to the DB (hooks/chat/useMentionMembers). Previously: cache
  // groups of up to 50 people, plus every @ keystroke asked each person's @username through the API without saving. Telegram channels (broadcast) have none.
  const isGroupThread = activeThreadType === 1;
  const mentionEnabled = isGroupThread
    && !(isTelegramUser(activeContact?.channel) && activeContact?.telegram_peer_type === 'channel');
  const mentionList = useMentionMembers({
    open: showMentionDropdown && mentionEnabled,
    accountId: activeAccountId,
    groupId: activeThreadId,
    channel: activeContact?.channel,
    peerType: activeContact?.telegram_peer_type,
    memberCount: Number(activeContact?.telegram_members_count) || 0,
    query: mentionSearch,
    cachedMembers: isGroupThread ? threadGroupInfo?.members : undefined,
  });

  const filteredMentions = showMentionDropdown && mentionEnabled
    ? [
        // @all option cho groups (Zalo: uid='-1', Telegram: uid='all')
        ...((!mentionSearch || 'all'.includes(mentionSearch.toLowerCase()) || '@all'.includes(mentionSearch.toLowerCase()))
          ? [{ userId: isZalo(activeContact?.channel) ? '-1' : 'all', displayName: '@all', avatar: '', username: '' }]
          : []),
        ...mentionList.members,
      ]
    : [];

  // ↑ / ↓ in the @ list: keep the selected row in view (below the sticky header row)
  useEffect(() => {
    if (!showMentionDropdown) return;
    const item = mentionListRef.current?.querySelector<HTMLElement>(`[data-mention-idx="${mentionSelectedIdx}"]`);
    item?.scrollIntoView({ block: 'nearest' });
  }, [mentionSelectedIdx, showMentionDropdown]);

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

  // The quote is PER conversation / forum topic: leaving a conversation stores it, coming back restores it (none → drop the quote
  // ). Previously the quote was one shared variable: switching to conversation B still kept the quote of A's message, and going back to A had lost it.
  const replyKey = replyDraftKey(activeAccountId, activeThreadId, activeTopicId);
  useLayoutEffect(() => {
    if (!replyKey) return undefined;
    const restored = getReplyDraft(replyKey);
    if (useChatStore.getState().replyTo !== restored) setReplyTo(restored);
    return () => saveReplyDraft(replyKey, useChatStore.getState().replyTo);
  }, [replyKey]);

  /**
   * After the reply is sent: drop the quote of the EXACT conversation that was sent to. The user may have switched to another conversation while waiting
   * to send: setReplyTo(null) would then wrongly delete the quote of the new conversation, while the sent quote shows again when coming back.
   */
  const finishReply = useCallback((sent: MessageItem | null | undefined) => {
    if (!sent) return;
    forgetReplyDraft(sent);
    if (useChatStore.getState().replyTo === sent) useChatStore.getState().setReplyTo(null);
  }, []);

  // Pre-fill text when entering edit mode
  useEffect(() => {
    if (editingMsg) {
      const el = textareaRef.current;
      if (el) {
        el.innerText = editingMsg.content || '';
        setText(editingMsg.content || '');
        el.focus();
        // Move cursor to end of text
        requestAnimationFrame(() => {
          const range = document.createRange();
          const sel = window.getSelection();
          if (el.childNodes.length > 0) {
            range.selectNodeContents(el);
            range.collapse(false); // collapse to end
          } else {
            range.setStart(el, 0);
            range.collapse(true);
          }
          sel?.removeAllRanges();
          sel?.addRange(range);
        });
      }
    }
  }, [editingMsg?.msg_id]);

  // Close emoji picker when clicking outside
  useEffect(() => {
    if (!showEmojiPicker) return;
    const handler = (e: MouseEvent) => {
      if (emojiPickerRef.current && !emojiPickerRef.current.contains(e.target as Node)) {
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showEmojiPicker]);

  // Reset mention state when thread changes + save/restore drafts + focus textarea
  useEffect(() => {
    // ── Save draft for the PREVIOUS thread ──────────────────────────
    const prev = prevThreadRef.current;
    // Editing a message in the conversation just left: cancel the edit. Previously the "Đang sửa" (Editing) box followed the user into another conversation, and pressing send would edit
    // the message of the old conversation. The text being edited is not saved as a draft (the draft that existed before the edit is kept).
    const editingPrev = useChatStore.getState().editingMsg;
    if (editingPrev) setEditingMsg(null);
    if (prev?.accountId && prev?.threadId && !editingPrev) {
      const el = textareaRef.current;
      const currentText = el ? el.innerText.replace(/\u200B/g, '').trim() : '';
      if (currentText) {
        setDraft(prev.accountId, prev.threadId, currentText);
      } else {
        clearDraft(prev.accountId, prev.threadId);
      }
    }

    // ── Update ref to current thread ────────────────────────────────
    prevThreadRef.current = (activeAccountId && activeThreadId && draftThreadId)
      ? { accountId: activeAccountId, threadId: draftThreadId }
      : null;

    // ── Reset states ────────────────────────────────────────────────
    setShowMentionDropdown(false);
    setMentionSearch('');
    setMentionTriggerPos(-1);
    setMentions([]);
    setFmtRanges([]);
    setActiveFmts(new Set());
    setClipboardImages([]);
    setContactCardSuggestion(null);
    setContactCardLoading(false);
    lastDetectedPhoneRef.current = '';
    prevTextRef.current = '';
    lastTypingSentRef.current = 0;
    if (typingStopTimerRef.current) { clearTimeout(typingStopTimerRef.current); typingStopTimerRef.current = null; }
    if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null; }

    // ── Restore draft for the NEW thread (or clear) ─────────────────
    const draftKey = activeAccountId && activeThreadId ? `${activeAccountId}_${draftThreadId}` : '';
    const savedDraft = draftKey ? (useChatStore.getState().drafts[draftKey] || '') : '';
    const el = textareaRef.current;
    if (el) {
      el.innerText = savedDraft;
    }
    setText(savedDraft);

    // Focus the editor after changing thread + move the cursor to the end
    setTimeout(() => {
      const editor = textareaRef.current;
      if (editor) {
        editor.focus();
        if (editor.childNodes.length > 0) {
          const range = document.createRange();
          const sel = window.getSelection();
          range.selectNodeContents(editor);
          range.collapse(false);
          sel?.removeAllRanges();
          sel?.addRange(range);
        }
      }
    }, 50);
  }, [activeThreadId, activeAccountId, draftThreadId]);

  // Quick messages of the open account (by the account's zalo / local mode). A read error keeps the current list.
  const reloadQuickMessages = useCallback((): Promise<void> => {
    if (!activeAccountId) return Promise.resolve();
    const account = getActiveAccount();
    if (!account) return Promise.resolve();
    const channelCap = getCapability((account.channel || CHANNEL.ZALO) as any);
    const auth = buildZaloAuth(account);
    const mode = channelCap.quickMessageSyncMode === 'local' ? 'local' : ((localStorage.getItem(`qm_mode_${activeAccountId}`) as 'zalo' | 'local') || CHANNEL.ZALO);
    return fetchQuickMessages(auth, activeAccountId, mode).then(setQuickMessages).catch(() => {});
  }, [activeAccountId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Preload quick messages when account changes
  useEffect(() => {
    if (!activeAccountId) return;
    void reloadQuickMessages();
    // Re-fetch when quick messages change (remote sync or another tab), ignoring changes of other accounts
    // (active / reorder carry no account → still reload)
    const handleQMChange = (e: Event) => {
      const owner = relayEventAccount((e as CustomEvent).detail);
      if (owner && owner !== activeAccountId) return;
      void reloadQuickMessages();
    };
    window.addEventListener('ui:quickMessagesChanged', handleQMChange);
    return () => window.removeEventListener('ui:quickMessagesChanged', handleQMChange);
  }, [activeAccountId, reloadQuickMessages]);

  // Employee mode: BOSS connection recovers → reload quick messages (changes made while disconnected produce no event)
  useEmployeeResync(reloadQuickMessages);

  useEffect(() => {
    loadLocalLabelsForThread().catch(() => {});
  }, [loadLocalLabelsForThread]);

  // ── Paste: catch images from the clipboard ──────────────────────────────────
  useEffect(() => {
    const handlePaste = (e: ClipboardEvent) => {
      if (!activeThreadId) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      const imageItems = Array.from(items).filter(item => item.type.startsWith('image/'));
      if (imageItems.length === 0) return;
      e.preventDefault();
      imageItems.forEach(item => {
        const blob = item.getAsFile();
        if (!blob) return;
        const id = `clip_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string;
          setClipboardImages(prev => [...prev, { id, dataUrl, blob }]);
        };
        reader.readAsDataURL(blob);
      });
    };
    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [activeThreadId]);

  // ── Paste text: strip formatting (background colour, text colour, font...) on paste ──
  const handleEditorPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // If there is an image, let the handler above process it
    const items = e.clipboardData?.items;
    if (items) {
      const hasImage = Array.from(items).some(item => item.type.startsWith('image/'));
      if (hasImage) return;
    }
    // Block the default paste (HTML formatting stays as it is)
    e.preventDefault();
    const plainText = e.clipboardData.getData('text/plain');
    if (!plainText) return;
    // Insert plain text at the cursor position
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    sel.deleteFromDocument();
    const textNode = document.createTextNode(plainText);
    const range = sel.getRangeAt(0);
    range.insertNode(textNode);
    // Move the cursor to the end of the pasted text
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    sel.removeAllRanges();
    sel.addRange(range);
    // Trigger an input event to update the state
    textareaRef.current?.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // ── Inline sticker suggestions: when user types >2 chars + 1s pause ──
  // Only for Zalo (plain text, no reply quote, no clipboard images)
  useEffect(() => {
    if (inlineStickerTimerRef.current) clearTimeout(inlineStickerTimerRef.current);
    const kw = text.trim().toLowerCase();

    // Only for Zalo channel — Telegram/Facebook don't have keyword sticker search
    if (!isZalo(activeContact?.channel)) {
      setInlineStickerSuggestions([]);
      return;
    }

    // Clear suggestions when text is short or empty
    if (!kw || kw.length < 3) {
      setInlineStickerSuggestions([]);
      inlineStickerLastKwRef.current = '';
      return;
    }

    // Don't suggest if user has reply quote or clipboard images (only plain text)
    if (replyTo || clipboardImages.length > 0) {
      setInlineStickerSuggestions([]);
      return;
    }

    // Don't re-search same keyword
    if (kw === inlineStickerLastKwRef.current) return;

    // Skip if starts with "/" (quick message trigger) or "@" (mention)
    if (kw.startsWith('/') || kw.startsWith('@')) return;

    inlineStickerTimerRef.current = setTimeout(async () => {
      inlineStickerLastKwRef.current = kw;
      try {
        // Step 1: Check keyword_stickers cache in DB
        const cacheRes = await DataAccessor.getKeywordStickers(kw);
        if (cacheRes?.success && cacheRes.stickerIds !== null && cacheRes.stickerIds !== undefined) {
          // Cache hit (including empty array = previously searched with no results)
          if (cacheRes.stickerIds.length === 0) {
            setInlineStickerSuggestions([]);
            return;
          }
          // DataAccessor: employee mode reads the stickers cached on Boss (IPC returns an empty stub → always ask the API again)
          const detailRes = await DataAccessor.getStickers({ stickerIds: cacheRes.stickerIds.slice(0, 20) });
          if (detailRes?.success && detailRes.stickers?.length) {
            setInlineStickerSuggestions(detailRes.stickers);
            return;
          }
        }

        // Step 2: Cache miss → call Zalo API
        const account = getActiveAccount();
        if (!account) { setInlineStickerSuggestions([]); return; }
        const auth = buildZaloAuth(account);

        const idsRes = await ipc.zalo?.getStickers({ auth, keyword: kw });
        const ids: number[] = idsRes?.response || [];

        // Always cache keyword → stickerIds (even empty = no results, so next time skip API)
        DataAccessor.saveKeywordStickers?.({ keyword: kw, stickerIds: ids }).catch(() => {});

        if (!ids.length) { setInlineStickerSuggestions([]); return; }

        // Step 3: Get sticker details
        const detailRes = await ipc.zalo?.getStickersDetail({ auth, stickerIds: ids.slice(0, 20) });
        const stickers: any[] = detailRes?.response || [];
        setInlineStickerSuggestions(stickers);

        // Save ALL stickers to DB cache (for sticker store)
        if (stickers.length) {
          DataAccessor.saveStickers({ stickers }).catch(() => {});
        }
      } catch {
        setInlineStickerSuggestions([]);
      }
    }, 1000); // 1 second debounce

    return () => { if (inlineStickerTimerRef.current) clearTimeout(inlineStickerTimerRef.current); };
  }, [text, activeAccountId, replyTo, clipboardImages.length]);

  // Clear inline sticker suggestions when thread changes
  useEffect(() => {
    setInlineStickerSuggestions([]);
    inlineStickerLastKwRef.current = '';
  }, [activeThreadId]);

  // ─── Phone number detection → contact card suggestion ──────────────────
  // Pattern: 0 + 10 digits (Vietnamese phone number)
  const PHONE_REGEX = /0\d{9}/g;

  // Clear suggestion when thread changes
  useEffect(() => {
    setContactCardSuggestion(null);
    setContactCardLoading(false);
    lastDetectedPhoneRef.current = '';
  }, [activeThreadId]);

  // Debounced lookup when text contains phone number
  useEffect(() => {
    // Skip for channels that don't support business cards
    const contactChannel = (activeContact?.channel || CHANNEL.ZALO) as any;
    if (!getCapability(contactChannel).supportsBusinessCard) return;

    if (contactCardTimerRef.current) clearTimeout(contactCardTimerRef.current);

    const phones = text.match(PHONE_REGEX);
    const phone = phones?.[0] || '';

    if (!phone || phone === lastDetectedPhoneRef.current) {
      // If phone was removed from text (or changed), clear suggestion
      if (!phone && lastDetectedPhoneRef.current) {
        setContactCardSuggestion(null);
        setContactCardLoading(false);
        lastDetectedPhoneRef.current = '';
      }
      return;
    }

    // New phone detected - debounce 800ms before lookup
    lastDetectedPhoneRef.current = phone;
    setContactCardLoading(true);

    contactCardTimerRef.current = setTimeout(async () => {
      try {
        // Step 1: Search local DB contacts
        if (activeAccountId) {
          // DataAccessor: employee mode looks up Boss's contacts (IPC returns a stub → always uses up a Zalo findUser call)
          const dbRes = await DataAccessor.searchContactByPhone({ zaloId: activeAccountId, phone });
          if (dbRes?.success && dbRes?.contact) {
            const c = dbRes.contact;
            setContactCardSuggestion({
              userId: c.contact_id || '',
              displayName: c.display_name || '',
              avatarUrl: c.avatar_url || '',
              phone: c.phone || phone,
            });
            setContactCardLoading(false);
            return;
          }
        }

        // Step 2: Not found in DB → try Zalo findUser API
        const account = getActiveAccount();
        if (!account) { setContactCardLoading(false); return; }
        const auth = buildZaloAuth(account);

        const findRes = await ipc.zalo?.findUser({ auth, zaloId: activeAccountId, phone });
        const foundUser = findRes?.response || findRes?.data;
        if (foundUser?.userId || foundUser?.uid || foundUser?.id) {
          const uid = foundUser.userId || foundUser.uid || foundUser.id;
          // Try getUserInfo for detailed info (avatar, name)
          let displayName = foundUser.displayName || foundUser.name || foundUser.zaloName || uid;
          let avatarUrl = foundUser.avatar || foundUser.avatarUrl || foundUser.avatar_url || '';

          try {
            const infoRes = await ipc.zalo?.getUserInfo({ auth, zaloId: activeAccountId, userId: uid });
            // The API returns the data in changed_profiles[userId], not directly in the response
            const profile = infoRes?.response?.changed_profiles?.[uid] || infoRes?.response;
            if (profile) {
              displayName = profile.displayName || profile.name || profile.zaloName || displayName;
              avatarUrl = profile.avatar || profile.avatarUrl || profile.avatar_url || avatarUrl;
            }
          } catch { /* best-effort */ }

          setContactCardSuggestion({
            userId: uid,
            displayName,
            avatarUrl: avatarUrl || '',
            phone,
          });
        } else {
          // Not found - clear suggestion
          setContactCardSuggestion(null);
        }
      } catch {
        setContactCardSuggestion(null);
      } finally {
        setContactCardLoading(false);
      }
    }, 800);

    return () => {
      if (contactCardTimerRef.current) clearTimeout(contactCardTimerRef.current);
    };
  }, [text, activeAccountId, activeContact?.channel]);

  const getAuth = () => {
    const account = getActiveAccount();
    if (!account) return null;
    // FB accounts may not have Zalo credentials - return a placeholder so send flow continues
    if (isNonZalo(account.channel)) {
      return { cookies: '', imei: '', userAgent: '' };
    }
    // accountId: the employee machine has no cookie → Boss knows which account to send from (it does not take the first assigned account)
    return buildZaloAuth(account);
  };

  // ── Receive files dropped from ChatWindow (drag and drop on the message area) ──
  useEffect(() => {
    const handleDragDropFiles = async (e: Event) => {
      const detail = (e as CustomEvent<Partial<DropPayload>>).detail;
      if (!activeThreadId || !activeAccountId) return;
      let files: File[] = detail?.files || [];
      const imageUrls: string[] = detail?.imageUrls || [];
      // Dragging an image from a web page / app only gives a link (no file) → download the image as a file
      if (files.length === 0 && imageUrls.length > 0) files = await fetchDroppedImages(imageUrls);
      Logger.info(`[Kéo thả] ${files.length} file (${files.map(f => f.type || f.name.split('.').pop() || '?').join(', ') || '—'}), `
        + `${imageUrls.length} link ảnh; dữ liệu kéo: ${(detail?.types || []).join(', ') || '—'}`);
      if (files.length === 0) {
        showNotification(imageUrls.length > 0
          ? tr('Không tải được ảnh vừa kéo vào — hãy lưu ảnh về máy rồi kéo file vào khung chat')
          : tr('Không đọc được file vừa kéo vào'), 'error');
        return;
      }

      const auth = getAuth();
      if (!auth) return;

      // Classify files (images: by MIME, or by extension when Windows leaves the MIME empty: .jfif / .webp…)
      const imageFiles = files.filter(f => isImageFile(f));
      const videoFiles = files.filter(f => !isImageFile(f) && f.type.startsWith('video/'));
      const otherFiles = files.filter(f => !isImageFile(f) && !f.type.startsWith('video/'));

      // ── Images: add to clipboardImages ──
      for (const file of imageFiles) {
        const id = `drop_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        const reader = new FileReader();
        reader.onload = (ev) => {
          const dataUrl = ev.target?.result as string;
          setClipboardImages(prev => [...prev, { id, dataUrl, blob: file }]);
        };
        reader.readAsDataURL(file);
      }

      // ── Video: send directly ──
      for (const file of videoFiles) {
        const tempPath = await saveDroppedFileAsTemp(file);
        if (!tempPath) continue;
        const quotePayload = buildQuotePayload(replyTo);
        const vidTempId = generateTempId();
        addMessage(activeAccountId!, activeThreadId, {
          msg_id: vidTempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
          thread_type: activeThreadType, sender_id: activeAccountId!, content: '🎬 Video',
          msg_type: 'video', timestamp: Date.now(), is_sent: 1, status: 'sending',
          send_status: 'pending', temp_id: vidTempId, media_type: 'video',
          ...(activeTopicId ? { topic_id: activeTopicId } : {}),
        });
        messageQueue.enqueue({
          tempId: vidTempId, zaloId: activeAccountId!, threadId: activeThreadId,
          threadType: activeThreadType, channel: (activeContact?.channel || CHANNEL.ZALO) as any,
          sendFn: async () => {
            try {
              const metaRes = await ipc.file?.getVideoMeta?.({ filePath: tempPath });
              let thumbPath: string = metaRes?.thumbPath || '';
              const duration: number = metaRes?.duration || 0;
              const width: number = metaRes?.width || 0;
              const height: number = metaRes?.height || 0;
              if (!thumbPath) {
                const seekSec = duration > 2 ? 1 : 0;
                const dataUrl = await extractVideoThumbViaCanvas(tempPath, seekSec);
                if (dataUrl && dataUrl.length > 100) {
                  const saveRes = await ipc.file?.saveTempBlob?.({ base64: dataUrl, ext: 'jpg' });
                  if (saveRes?.success && saveRes?.filePath) thumbPath = saveRes.filePath;
                }
              }
              const ch = activeContact?.channel || CHANNEL.ZALO;
              if (isNonZalo(ch)) {
                const r = await channelIpc.sendVideo(ch as any, { accountId: activeAccountId!, threadId: activeThreadId, threadType: activeThreadType, topicRootMessageId: activeTopicId || undefined, filePath: tempPath, body: '', quote: quotePayload || undefined });
                if (!r.success) return { success: false, error: r.error || tr('Gửi video Facebook thất bại') };
                return { success: true, msgId: (r as any)?.messageId };
              } else {
                let thumbUrl = '';
                if (thumbPath) {
                  const uploadRes = await ipc.zalo?.uploadVideoThumb?.({ auth, thumbPath, threadId: activeThreadId, type: activeThreadType });
                  const resp = uploadRes?.response;
                  thumbUrl = resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.thumbUrl || resp?.fileUrl || resp?.href || '';
                }
                const uploadVideoRes = await ipc.zalo?.uploadVideoFile?.({ auth, videoPath: tempPath, threadId: activeThreadId, type: activeThreadType });
                const videoUrl: string = uploadVideoRes?.response?.fileUrl || '';
                if (!videoUrl) return { success: false, error: tr('Upload video thất bại') };
                const sendRes = await ipc.zalo?.sendVideo({ auth, options: { videoUrl, thumbnailUrl: thumbUrl || videoUrl, duration: duration ? duration * 1000 : undefined, width: width || undefined, height: height || undefined }, threadId: activeThreadId, type: activeThreadType, ...(quotePayload ? { quote: quotePayload } : {}) });
                return { success: true, ...extractMsgIdFromResponse(sendRes, 'zalo') };
              }
            } catch (err: any) { return { success: false, error: err?.message || String(err) }; }
          },
          onSuccess: () => { if (quotePayload) finishReply(replyTo); },
        });
      }

      // ── Other files: send directly ──
      for (const file of otherFiles) {
        if (file.size === 0) continue;
        const tempPath = await saveDroppedFileAsTemp(file);
        if (!tempPath) continue;
        const quotePayload = buildQuotePayload(replyTo);
        const ch = activeContact?.channel || CHANNEL.ZALO;
        const fileTempId = generateTempId();
        addMessage(activeAccountId!, activeThreadId, {
          msg_id: fileTempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
          thread_type: activeThreadType, sender_id: activeAccountId!, content: `📎 ${file.name}`,
          msg_type: 'file', timestamp: Date.now(), is_sent: 1, status: 'sending',
          send_status: 'pending', temp_id: fileTempId, media_type: 'file', channel: ch as any,
          ...(activeTopicId ? { topic_id: activeTopicId } : {}),
          attachments: JSON.stringify([{ type: 'file', localPath: tempPath, name: file.name }]),
        });
        messageQueue.enqueue({
          tempId: fileTempId, zaloId: activeAccountId!, threadId: activeThreadId,
          threadType: activeThreadType, channel: ch as any,
          sendFn: async () => {
            try {
              if (isNonZalo(ch)) {
                const fileRes = await channelIpc.sendAttachment(ch as any, {
                  accountId: activeAccountId!, threadId: activeThreadId, topicRootMessageId: activeTopicId || undefined, filePath: tempPath, threadType: activeThreadType,
                  // Forum topic / comment thread: reply to exactly the message being quoted
                  ...(activeTopicId && quotePayload ? { quote: quotePayload } : {}),
                });
                if (!fileRes?.success) return { success: false, error: fileRes?.error || tr('Gửi file thất bại') };
                return { success: true, msgId: (fileRes as any)?.messageId };
              } else {
                const res = await ipc.zalo?.sendFile({ auth, threadId: activeThreadId, type: activeThreadType, filePath: tempPath, ...(quotePayload ? { quote: quotePayload } : {}) });
                return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
              }
            } catch (err: any) { return { success: false, error: err?.message || String(err) }; }
          },
          onSuccess: () => { if (quotePayload) finishReply(replyTo); },
        });
      }
    };

    window.addEventListener('chat:dragDropFiles', handleDragDropFiles);
    return () => window.removeEventListener('chat:dragDropFiles', handleDragDropFiles);
  }, [activeThreadId, activeAccountId, activeThreadType, activeTopicId, replyTo, getAuth, activeContact]);

  // Plugin (deplao.ui.insertComposerText / composer button): insert text at the end of the composer.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const value = String((e as CustomEvent).detail?.text || '');
      const el = textareaRef.current;
      if (!value || !el) return;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const node = document.createTextNode(value);
      range.insertNode(node);
      range.setStartAfter(node);
      range.setEndAfter(node);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    window.addEventListener('composer:insertText', onInsert);
    return () => window.removeEventListener('composer:insertText', onInsert);
  }, []);

  const localLabelThreadKey = localLabelState.threadKey;
  /** Add / remove a Local label on the open conversation. true = changed (the shortcut only reports "success" in that case). */
  const handleToggleLocalLabel = useCallback(async (label: LocalLabel): Promise<boolean> => {
    if (!activeAccountId || !activeThreadId || togglingLocalLabelId !== null) return false;
    // The labels attached to this conversation are not known yet (loading / failed read): do not add / remove based on a guess
    if (localLabelThreadKey !== threadLabelsKey(activeAccountId, activeThreadId)) {
      if (localLabelsFailed) showNotification(tr('Chưa tải được Nhãn Local của hội thoại — đang thử lại'), 'error');
      void loadLocalLabelsForThread();
      return false;
    }
    const exists = threadLocalLabelIds.has(label.id);
    setTogglingLocalLabelId(label.id);
    try {
      const res: any = exists
        ? await DataAccessor.removeLocalLabelFromThread({ zaloId: activeAccountId, labelId: label.id, threadId: activeThreadId })
        : await DataAccessor.assignLocalLabelToThread({ zaloId: activeAccountId, labelId: label.id, threadId: activeThreadId });
      // Employee: Boss rejects it / the connection is lost and returns success:false (no throw) → report it as an error
      if (res?.success === false) throw new Error(res.error || 'write failed');
      await loadLocalLabelsForThread();
      // Dispatch event so ConversationList & CRM reload local labels
      window.dispatchEvent(new CustomEvent('local-labels-changed', { detail: { zaloId: activeAccountId } }));
      return true;
    } catch {
      showNotification(tr('Không thể cập nhật Nhãn Local'), 'error');
      return false;
    } finally {
      setTogglingLocalLabelId(null);
    }
  }, [activeAccountId, activeThreadId, activeThreadType, loadLocalLabelsForThread, showNotification, threadLocalLabelIds, togglingLocalLabelId, localLabelThreadKey, localLabelsFailed]);

  // ─── Pin/unpin conversation locally (Ctrl+P) ──────────────────────────────────
  const handlePinConversation = useCallback(async () => {
    if (!activeAccountId || !activeThreadId) return;
    try {
      const res = await DataAccessor.getLocalPinnedConversations({ zaloId: activeAccountId });
      // A read error ≠ "chưa ghim" (not pinned yet): do not pin / unpin based on a guess
      if (isReadFailure(res)) {
        showNotification(tr('Không tải được trạng thái ghim — thử lại sau'), 'error');
        return;
      }
      const pinnedThreadIds: string[] = res?.threadIds || [];
      const isPinned = pinnedThreadIds.includes(activeThreadId);
      const pinRes: any = await DataAccessor.setLocalPinnedConversation({ zaloId: activeAccountId, threadId: activeThreadId, isPinned: !isPinned });
      if (pinRes?.success === false) {
        showNotification(tr('Không thể ghim hội thoại: {{v1}}', { v1: pinRes.error || tr('lỗi không xác định') }), 'error');
        return;
      }
      showNotification(isPinned ? tr('Đã bỏ ghim hội thoại') : tr('Đã ghim hội thoại'), 'success');
      // Notify ConversationList to refresh pinned state
      window.dispatchEvent(new CustomEvent('local-pin-changed', { detail: { zaloId: activeAccountId } }));
    } catch {
      showNotification(tr('Không thể ghim hội thoại'), 'error');
    }
  }, [activeAccountId, activeThreadId, showNotification]);

  // ─── Keyboard shortcuts for chat page ─────────────────────────────────────────
  useEffect(() => {
    // Comments section: conversation shortcuts (Tab to switch conversation, pin, labels, notes…) do not apply to the discussion group
    if (!activeAccountId || !activeThreadId || commentMode) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      const hasMod = e.ctrlKey || e.altKey || e.metaKey;

      // ── Tab: navigate to next/prev conversation (full handleSelect-like) ──
      if (e.key === 'Tab' && !hasMod) {
        e.preventDefault();
        e.stopPropagation();
        const store = useChatStore.getState();
        const conList = store.contacts[activeAccountId || ''] || [];
        if (conList.length === 0) return;
        const activeTId = store.activeThreadId;
        const sorted = [...conList].sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
        const currentIdx = activeTId ? sorted.findIndex(c => c.contact_id === activeTId) : -1;
        let nextIdx: number;
        if (currentIdx === -1) {
          nextIdx = 0;
        } else {
          nextIdx = e.shiftKey ? currentIdx - 1 : currentIdx + 1;
          if (nextIdx < 0) nextIdx = sorted.length - 1;
          if (nextIdx >= sorted.length) nextIdx = 0;
        }
        if (nextIdx === currentIdx) return;
        const next = sorted[nextIdx];
        const zaloId = activeAccountId!;
        const contactId = next.contact_id;
        const threadType = next.contact_type === 'group' ? 1 : 0;

        // Set active thread + clear unread (like ConversationList.handleSelect)
        store.setActiveThread(contactId, threadType);
        store.clearUnread(zaloId, contactId);
        DataAccessor.markAsRead({ zaloId, contactId }).catch(() => {});
        // Deliberately switching to a conversation → report it as read to the platform, as when clicking in the list (previously only on this machine)
        void liveReadSync.syncOpenedThread({ accountId: zaloId, threadId: contactId, threadType });

        // Load latest 50 messages from DB so ChatWindow is not blank
        DataAccessor.getMessages({ zaloId, threadId: contactId, limit: 50, offset: 0 }).then((res: any) => {
          if (res?.messages?.length > 0) {
            const msgs = [...res.messages].reverse();
            useChatStore.getState().setMessages(zaloId, contactId, msgs);
          }
        }).catch(() => {});
        return;
      }

      // ── For non-modified keys when in input, skip (let label shortcuts handle) ──
      if (isInInput && !e.ctrlKey && !e.metaKey) return;

      // ── Ctrl+ / Cmd+ shortcuts only ──
      if (!e.ctrlKey && !e.metaKey) return;

      // Ctrl + letter, without Shift / Alt: Ctrl+Shift+N is "Nhắn tin nhanh" (Quick message) (App); previously it also opened the Ctrl+N note
      if (!e.shiftKey && !e.altKey) switch (e.key.toLowerCase()) {
        case 'p': // Pin conversation locally
          e.preventDefault();
          e.stopPropagation();
          handlePinConversation();
          return;
        case 'k': // Focus conversation search (sidebar)
          e.preventDefault();
          e.stopPropagation();
          window.dispatchEvent(new CustomEvent('focus:conversationSearch'));
          return;
        case 'f': // Toggle message search in header
          e.preventDefault();
          e.stopPropagation();
          useAppStore.getState().toggleSearch();
          return;
        case 'n': // Create internal note
          e.preventDefault();
          e.stopPropagation();
          setShowCreateNote(true);
          return;
        case 's': // Toggle AI Quick Panel
          e.preventDefault();
          e.stopPropagation();
          useAppStore.getState().toggleAIQuickPanel();
          return;
        case 'i': // Toggle conversation info panel
          e.preventDefault();
          e.stopPropagation();
          useAppStore.getState().toggleConversationInfo();
          return;
        case 't': // Toggle local labels row
          e.preventDefault();
          e.stopPropagation();
          toggleLocalLabels();
          return;
      }

      // ── Label shortcuts (toggle local labels by assigned shortcut) ──
      for (const label of localLabels) {
        if (label.shortcut && matchesShortcut(e, label.shortcut)) {
          e.preventDefault();
          e.stopPropagation();
          const exists = threadLocalLabelIds.has(label.id);
          const action = exists ? tr('Gỡ') : tr('Gắn');
          handleToggleLocalLabel(label).then((toggled) => {
            if (toggled) showNotification(tr('{{action}} nhãn "{{v1}} {{name}}" thành công', { action, v1: label.emoji || '', name: label.name }), 'success');
          });
          return;
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeAccountId, activeThreadId, commentMode, handlePinConversation, showNotification, localLabels, threadLocalLabelIds, handleToggleLocalLabel]);

  /** Returns true if the string is a plain URL (no spaces, starts with http/https) */
  const isUrlOnly = (s: string): boolean => {
    const t = s.trim();
    if (!t || t.includes(' ') || t.includes('\n')) return false;
    return /^https?:\/\/.+\..+/.test(t);
  };

  /** Parse a message of the form: <url> + (optional text). Only accepted when the URL comes first, to avoid catching ordinary sentences by mistake. */
  const parseLinkWithCaption = (s: string): { url: string; caption: string } | null => {
    const t = s.trim();
    if (!t) return null;
    const m = t.match(/^(https?:\/\/\S+)(?:\s+|\n+)?([\s\S]*)$/i);
    if (!m) return null;
    const url = m[1].trim();
    const caption = (m[2] || '').trim();
    return { url, caption };
  };

  const buildQuotePayload = (msg: any): string | null => {
    if (!msg) return null;
    try {
      let content = msg.content || '';

      // Parse content into an object if it is a JSON string (files / links / images are stored as JSON strings in the DB)
      if (content && typeof content === 'string' && content.trim().startsWith('{')) {
        try {
          content = JSON.parse(content);
        } catch {
          // Keep as string if parse fails
        }
      }

      // KEEP content as an object if it was parsed - zca-js needs an object to:
      //   • prepareQMSGAttach() builds qmsgAttach correctly for groups (file/link/image)
      //   • qmsg: typeof content == "string" ? content : prepareQMSG(content)
      // Do NOT normalize chat.recommended → share.link: getClientMessageType() has no case
      // for share.link → returns 1 (webchat) instead of 38 → Zalo misreads the quote type.
      const msgType = msg.msg_type || 'webchat';

      const payload = {
        content,                              // object or string, JSON.stringify keeps the right type
        msgType,
        propertyExt: msg.property_ext ?? undefined,
        uidFrom: msg.sender_id || '',
        msgId: String(msg.msg_id || ''),
        cliMsgId: String(msg.cli_msg_id || msg.msg_id || ''),
        ts: String(msg.timestamp || Date.now()),   // TMessage.ts is a timestamp string in ms
        ttl: 0,
      };

      return JSON.stringify(payload);
    } catch (e) {
      console.error('[buildQuotePayload] Error:', e);
      return null;
    }
  };

  // ── Rich-text helpers ────────────────────────────────────────────────────────

  /**
   * Get the plain text from the contenteditable div (keeps newlines from <br> and block elements)
   */
  const getPlainText = (el: HTMLElement): string => {
    let result = '';
    const walk = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        result += node.textContent || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as HTMLElement).tagName.toLowerCase();
        if (tag === 'br') { result += '\n'; return; }
        node.childNodes.forEach(walk);
        if (tag === 'div' || tag === 'p') {
          // add a newline after a block if there is none yet
          if (result && !result.endsWith('\n')) result += '\n';
        }
      }
    };
    el.childNodes.forEach(walk);
    // remove the trailing newline at the end (contenteditable often adds a final <br>)
    return result.replace(/\n$/, '');
  };

  /**
   * Get the cursor (caret) position in the equivalent plain text
   */
  const getCaretOffset = (el: HTMLElement): { start: number; end: number } => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { start: 0, end: 0 };
    const range = sel.getRangeAt(0);
    const preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    const start = preRange.toString().length;
    const end = start + range.toString().length;
    return { start, end };
  };

  /**
   * Rebuild the display HTML for the contenteditable from the plain text + fmtRanges.
   * Each character is placed in a span with the matching classes.
   * Simple approach: split the text into segments by the ranges.
   */
  const buildRichHtml = useCallback((plainText: string, ranges: Array<{ start: number; len: number; st: string }>): string => {
    if (!plainText) return '';
    const n = plainText.length;
    // Collect the styles at each character position
    const charStyles: Set<string>[] = Array.from({ length: n }, () => new Set<string>());
    for (const r of ranges) {
      const end = Math.min(r.start + r.len, n);
      for (let i = r.start; i < end; i++) {
        charStyles[i].add(r.st);
      }
    }

    // Merge characters with the same styles into segments
    const segments: Array<{ text: string; styles: Set<string> }> = [];
    let i = 0;
    while (i < n) {
      const cur = charStyles[i];
      let j = i + 1;
      while (j < n && setsEqual(charStyles[j], cur)) j++;
      segments.push({ text: plainText.slice(i, j), styles: cur });
      i = j;
    }

    return segments.map(seg => {
      const escaped = seg.text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
      if (seg.styles.size === 0) return escaped;
      const styleMap: Record<string, string> = {
        b: 'font-weight:bold',
        i: 'font-style:italic',
        u: 'text-decoration:underline',
        s: 'text-decoration:line-through',
        c_db342e: 'color:#db342e',
        c_f27806: 'color:#f27806',
        c_f7b503: 'color:#f7b503',
        c_15a85f: 'color:#15a85f',
        f_13: 'font-size:13px',
        f_18: 'font-size:18px',
      };
      // Merge u and s
      const decorations: string[] = [];
      const cssStyles: string[] = [];
      for (const st of seg.styles) {
        if (st === 'u') decorations.push('underline');
        else if (st === 's') decorations.push('line-through');
        else if (styleMap[st]) cssStyles.push(styleMap[st]);
      }
      if (decorations.length) cssStyles.push(`text-decoration:${decorations.join(' ')}`);
      return `<span style="${cssStyles.join(';')}">${escaped}</span>`;
    }).join('');
  }, []);

  function setsEqual(a: Set<string>, b: Set<string>): boolean {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
  }

  /**
   * Put the caret in the contenteditable at a plain-text offset
   */
  const setCaretOffset = (el: HTMLElement, start: number, end: number) => {
    const createRangeAt = (offset: number): [Node, number] => {
      let remaining = offset;
      const walk = (node: Node): [Node, number] | null => {
        if (node.nodeType === Node.TEXT_NODE) {
          const len = node.textContent?.length || 0;
          if (remaining <= len) return [node, remaining];
          remaining -= len;
          return null;
        }
        if ((node as HTMLElement).tagName?.toLowerCase() === 'br') {
          if (remaining === 0) return [node.parentNode!, Array.from(node.parentNode!.childNodes).indexOf(node as ChildNode)];
          remaining -= 1;
          return null;
        }
        for (const child of Array.from(node.childNodes)) {
          const r = walk(child);
          if (r) return r;
        }
        return null;
      };
      return walk(el) || [el, el.childNodes.length];
    };
    const sel = window.getSelection();
    if (!sel) return;
    const range = document.createRange();
    const [sNode, sOff] = createRangeAt(start);
    const [eNode, eOff] = createRangeAt(end);
    try {
      range.setStart(sNode, sOff);
      range.setEnd(eNode, eOff);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {}
  };

  /**
   * Apply formatting to the selected text.
   * With no selection, toggle the active state (applied when typing next: not supported yet).
   * With a selection: toggle the range in fmtRanges.
   */
  const applyFormat = (style: string) => {
    const el = textareaRef.current;
    if (!el) return;

    // Get the raw text (containing \u200B) to compute the \u200B offsets before / inside the selection
    const rawText = getPlainText(el);
    const { start: rawStart, end: rawEnd } = getCaretOffset(el);
    // Subtract the number of \u200B before the selection and inside it to get a "clean" position
    const zwspBefore = (rawText.slice(0, rawStart).match(/\u200B/g) || []).length;
    const zwspInSel  = (rawText.slice(rawStart, rawEnd).match(/\u200B/g) || []).length;
    const start  = rawStart - zwspBefore;
    const selLen = (rawEnd - rawStart) - zwspInSel;

    if (selLen === 0) {
      // Toggle the active state (shows a hint to the user)
      setActiveFmts(prev => {
        const next = new Set(prev);
        if (next.has(style)) next.delete(style); else next.add(style);
        return next;
      });
      el.focus();
      return;
    }

    // Check whether this range already exists (to toggle it off)
    const existingIdx = fmtRanges.findIndex(r => r.start === start && r.len === selLen && r.st === style);
    let newRanges: Array<{ start: number; len: number; st: string }>;
    if (existingIdx >= 0) {
      newRanges = fmtRanges.filter((_, i) => i !== existingIdx);
    } else {
      newRanges = [...fmtRanges, { start, len: selLen, st: style }];
    }
    setFmtRanges(newRanges);
    updateActiveFmtsAtPos(start + selLen, newRanges);

    // Rebuild the HTML from the text with \u200B REMOVED, to avoid piling up many \u200B
    const plain = rawText.replace(/\u200B/g, '');
    // Set innerHTML, then add an empty text node at the end so the cursor does not inherit the span style
    el.innerHTML = buildRichHtml(plain, newRanges);
    // Add a plain text node at the end (an anchor so typing next does not inherit the style)
    const anchor = document.createTextNode('\u200B');
    el.appendChild(anchor);

    // Put the cursor right AFTER the selection (in a plain text node, not inside a span)
    requestAnimationFrame(() => {
      const sel2 = window.getSelection();
      if (!sel2) return;
      // Find the last text node that is not inside a span (the anchor just created)
      const r2 = document.createRange();
      // the anchor is the last node of el
      r2.setStart(anchor, 0);
      r2.collapse(true);
      sel2.removeAllRanges();
      sel2.addRange(r2);
      el.focus();
    });
  };

  /** Update activeFmts based on the ranges that contain position pos */
  const updateActiveFmtsAtPos = (pos: number, ranges: Array<{ start: number; len: number; st: string }>) => {
    const active = new Set<string>();
    for (const r of ranges) {
      if (pos >= r.start && pos <= r.start + r.len) active.add(r.st);
    }
    setActiveFmts(active);
  };

  /**
   * Build the styles[] array from fmtRanges to send with the message.
   */
  const buildStyles = (): Array<{ start: number; len: number; st: string }> | undefined => {
    if (fmtRanges.length === 0) return undefined;
    return fmtRanges.length > 0 ? [...fmtRanges] : undefined;
  };

  const handleSelectQuickMessage = (item: QuickMessage, triggerPos?: number) => {
    const el = textareaRef.current;
    const pos = triggerPos ?? quickTriggerPos;
    if (!el || pos < 0) return;

    setShowQuickDropdown(false);
    setQuickFilter('');
    setQuickTriggerPos(-1);
    setQuickSelectedIdx(0);

    // ── If local media files are attached → preview all then send in background ──
    if (item._localMedia && item._localMedia.length > 0 && activeThreadId && activeAccountId) {
      // Remove the /keyword from text
      const cursorPos = getCaretOffset(el).start;
      const curText = getPlainText(el);
      const beforeSlash = curText.slice(0, pos);
      const afterCursor = curText.slice(cursorPos);
      const remaining = (beforeSlash + afterCursor).trim();
      setText(remaining);
      if (el) { el.textContent = remaining; }

      const auth = getAuth();
      if (!auth) return;

      const localMedia = item._localMedia;
      const msgTitle = item.message.title.trim();
      const threadId = activeThreadId;
      const threadType = activeThreadType;
      const accountId = activeAccountId;
      const now = Date.now();

      // ── Step 1: Create ALL temp messages upfront (preview immediately) ────
      // temp images (one batch msg)
      const imagePaths = localMedia.filter(f => f.type === 'image').map(f => f.path);
      const videoPaths = localMedia.filter(f => f.type === 'video').map(f => f.path);

      // temp id map: path/key → tempId (so we can remove each after send)
      const tempImgId = imagePaths.length > 0 ? `temp_img_${now}` : null;
      const tempVideoIds: Record<string, string> = {};
      const tempTextId = msgTitle ? `temp_txt_${now + 1}` : null;

      // Add temp image message
      if (imagePaths.length > 0 && tempImgId) {
        const localPathsImg: Record<string, string> = {};
        imagePaths.forEach((p, i) => { localPathsImg[`img_${i}`] = p; });
        addMessage(accountId, threadId, {
          msg_id: tempImgId,
          owner_zalo_id: accountId, thread_id: threadId, thread_type: threadType,
          sender_id: accountId,
          // show first image as preview content
          content: JSON.stringify({ href: `local-media:///${imagePaths[0].replace(/\\/g, '/')}`, width: 0, height: 0, totalCount: imagePaths.length }),
          msg_type: 'chat.photo',
          timestamp: now,
          is_sent: 1,
          status: 'sending',
          local_paths: JSON.stringify(localPathsImg),
          ...(activeTopicId ? { topic_id: activeTopicId } : {}),
        });
      }

      // Add temp video messages (one per video)
      videoPaths.forEach((vp, vi) => {
        const tid = `temp_vid_${now + 2 + vi}`;
        tempVideoIds[vp] = tid;
        addMessage(accountId, threadId, {
          msg_id: tid,
          owner_zalo_id: accountId, thread_id: threadId, thread_type: threadType,
          sender_id: accountId,
          content: JSON.stringify({ href: `local-media:///${vp.replace(/\\/g, '/')}` }),
          msg_type: 'chat.video.msg',
          timestamp: now + 2 + vi,
          is_sent: 1,
          status: 'sending',
          local_paths: JSON.stringify({ main: vp }),
          ...(activeTopicId ? { topic_id: activeTopicId } : {}),
        });
      });

      // Add temp text message
      if (msgTitle && tempTextId) {
        addMessage(accountId, threadId, {
          msg_id: tempTextId,
          owner_zalo_id: accountId, thread_id: threadId, thread_type: threadType,
          sender_id: accountId,
          content: msgTitle,
          msg_type: 'text',
          timestamp: now + 2 + videoPaths.length,
          is_sent: 1,
          status: 'sending',
          ...(activeTopicId ? { topic_id: activeTopicId } : {}),
        });
      }

      // ── Step 2: Send sequentially in background (no UI block) ────────────
      // Note: multiple quick messages on DIFFERENT threads run in parallel naturally
      // since each call is independent. Within THIS thread they run sequentially below.
      (async () => {
        try {
          // Send images batch
          if (imagePaths.length > 0 && tempImgId) {
            try {
              const ch = activeContact?.channel || CHANNEL.ZALO;
              if (isNonZalo(ch)) {
                // FB: send multiple images via channelIpc
                for (const imgPath of imagePaths) {
                  await channelIpc.sendAttachment(ch, {
                    accountId,
                    threadId,
                    threadType: threadType as any,
                    topicRootMessageId: activeTopicId || undefined,
                    filePath: imgPath,
                    body: '',
                  });
                }
              } else {
                await ipc.zalo?.sendImages({ auth, threadId, type: threadType, filePaths: imagePaths });
              }
              removeMessage(accountId, threadId, tempImgId);
              markReplied(accountId, threadId);
            } catch (e: any) {
              showNotification(tr('Gửi ảnh thất bại: {{message}}', { message: e.message }), 'error');
              removeMessage(accountId, threadId, tempImgId);
            }
          }

          // Send videos one by one
          for (const videoPath of videoPaths) {
            const tempVidId = tempVideoIds[videoPath];
            try {
              const metaRes = await ipc.file?.getVideoMeta?.({ filePath: videoPath });
              let thumbPath: string = metaRes?.thumbPath || '';
              const duration: number = metaRes?.duration || 0;
              const width: number = metaRes?.width || 0;
              const height: number = metaRes?.height || 0;

              if (!thumbPath) {
                const seekSec = duration > 2 ? 1 : 0;
                const dataUrl = await extractVideoThumbViaCanvas(videoPath, seekSec);
                if (dataUrl && dataUrl.length > 100) {
                  const saveRes = await ipc.file?.saveTempBlob?.({ base64: dataUrl, ext: 'jpg' });
                  if (saveRes?.success && saveRes?.filePath) thumbPath = saveRes.filePath;
                }
              }

              const ch = activeContact?.channel || CHANNEL.ZALO;
              if (isNonZalo(ch)) {
                await channelIpc.sendVideo(ch, {
                  accountId,
                  threadId,
                  threadType,
                  topicRootMessageId: activeTopicId || undefined,
                  filePath: videoPath,
                  body: '',
                });
              } else {
                let thumbUrl = '';
                if (thumbPath) {
                  const uploadRes = await ipc.zalo?.uploadVideoThumb?.({ auth, thumbPath, threadId, type: threadType });
                  const resp = uploadRes?.response;
                  thumbUrl = resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.thumbUrl || resp?.fileUrl || resp?.href || '';
                }
                const uploadVideoRes = await ipc.zalo?.uploadVideoFile?.({ auth, videoPath, threadId, type: threadType });
                const videoUrl: string = uploadVideoRes?.response?.fileUrl || '';
                if (!videoUrl) throw new Error(tr('Upload video thất bại'));
                await ipc.zalo?.sendVideo({
                  auth,
                  options: {
                    videoUrl,
                    thumbnailUrl: thumbUrl || videoUrl,
                    duration: duration ? duration * 1000 : undefined,
                    width: width || undefined,
                    height: height || undefined,
                  },
                  threadId,
                  type: threadType,
                });
              }
              removeMessage(accountId, threadId, tempVidId);
              markReplied(accountId, threadId);
            } catch (e: any) {
              showNotification(tr('Gửi video thất bại: {{message}}', { message: e.message }), 'error');
              removeMessage(accountId, threadId, tempVidId);
            }
          }

          // Send text
          if (msgTitle && tempTextId) {
            try {
              const ch = activeContact?.channel || CHANNEL.ZALO;
              if (isTelegramUser(ch) && activeTopicId && !isTelegramForumGeneral(activeTopicId)) {
                const result = await (getAdapter('telegram_user') as any).sendTopicMessage({
                  accountId,
                  threadId,
                  topicId: activeTopicId,
                  text: msgTitle,
                });
                if (!result?.success) throw new Error(result?.error || tr('Gửi tin nhắn Telegram thất bại'));
              } else if (isNonZalo(ch)) {
                const sendResult = await channelIpc.sendMessage(ch, {
                  accountId,
                  threadId,
                  threadType: threadType as any,
                  body: msgTitle,
                });
                if (!sendResult?.success) throw new Error(sendResult?.error || tr('Gửi tin nhắn thất bại'));
              } else {
                await ipc.zalo?.sendMessage({ auth, threadId, type: threadType, message: msgTitle });
              }
              removeMessage(accountId, threadId, tempTextId);
              markReplied(accountId, threadId);
            } catch (e: any) {
              showNotification(tr('Gửi tin nhắn thất bại: {{message}}', { message: e.message }), 'error');
              removeMessage(accountId, threadId, tempTextId);
            }
          }
        } catch (err: any) {
          showNotification(tr('Gửi tin nhắn nhanh thất bại: {{message}}', { message: err.message }), 'error');
        } finally {
          textareaRef.current?.focus();
        }
      })();
      return;
    }

    // ── No local media: just insert title text into editor ─────────────────
    const cursorPos = getCaretOffset(el).start;
    const curText = getPlainText(el);
    const beforeSlash = curText.slice(0, pos);
    const afterCursor = curText.slice(cursorPos);
    const newText = beforeSlash + item.message.title + afterCursor;
    const newCursorPos = pos + item.message.title.length;
    setText(newText);
    el.textContent = newText;
    setTimeout(() => {
      el.focus();
      setCaretOffset(el, newCursorPos, newCursorPos);
    }, 0);
  };

  /** Called when the user clicks an item in QuickMessageManagerPanel.
   *  Clears the editor → calls handleSelectQuickMessage with triggerPos=0 (from the start). */
  const handleSelectFromPanel = (item: QuickMessage) => {
    setShowQuickManager(false);
    const el = textareaRef.current;
    if (el) {
      el.innerHTML = '';
      prevTextRef.current = '';
    }
    setText('');
    setFmtRanges([]);
    setActiveFmts(new Set());
    // triggerPos=0: treat entire (now-empty) editor as the trigger region
    handleSelectQuickMessage(item, 0);
  };

  const handleSelectMention = (member: { userId: string; displayName: string; avatar: string; username?: string }) => {
    const el = textareaRef.current;
    if (!el || mentionTriggerPos < 0) return;
    const curText = getPlainText(el);
    // Clicking an item moves browser selection into the dropdown before
    // onClick runs. Use the trigger + typed query captured while editing,
    // never the now-invalid DOM caret.
    const mentionEnd = mentionTriggerPos + 1 + mentionSearch.length;
    // mentionTriggerPos is the position of the typed '@' → skip it when splicing
    const beforeAt = curText.slice(0, mentionTriggerPos);
    const afterCursor = curText.slice(mentionEnd);
    // Telegram: use @username if there is one, otherwise use displayName
    // Zalo: use displayName
    const isTelegram = isTelegramUser(activeContact?.channel) || isTelegramBot(activeContact?.channel);
    const mentionLabel = member.displayName.startsWith('@')
      ? member.displayName
      : (isTelegram && member.username)
        ? `@${member.username}`
        : `@${member.displayName}`;
    const mentionText = `${mentionLabel} `;
    const newText = beforeAt + mentionText + afterCursor;
    // pos = position of '@' in the new text, len = length of the mention label (not counting the trailing space)
    const newMention = { uid: member.userId, pos: mentionTriggerPos, len: mentionLabel.length, text: mentionLabel };
    setText(newText);
    setMentions(prev => [...prev, newMention]);
    prevTextRef.current = newText;
    setShowMentionDropdown(false);
    setMentionSearch('');
    setMentionTriggerPos(-1);
    setMentionSelectedIdx(0);
    const newCursorPos = mentionTriggerPos + mentionText.length;
    el.textContent = newText;
    setTimeout(() => {
      el.focus();
      setCaretOffset(el, newCursorPos, newCursorPos);
    }, 0);
  };

  const handleSend = async () => {
    const el = textareaRef.current;
    const msgText = el ? getPlainText(el).replace(/\u200B/g, '').trim() : '';
    const hasText = !!msgText;
    const hasImages = clipboardImages.length > 0;
    if (!hasText && !hasImages) return;
    if (!activeThreadId || !activeAccountId || sending) return;
    const auth = getAuth();
    if (!auth) return;

    // ── Edit mode: call editMessage instead of sendMessage ────────────────
    if (editingMsg && hasText && !hasImages) {
      try {
        setSending(true);
        // Strip tg_ prefix for Telegram topic messages
        const rawMsgId = editingMsg.msg_id?.replace(/^tg_/, '') || editingMsg.msg_id;
        console.log(`[MessageInput] Edit msg: channel=${activeContact?.channel} msgId=${rawMsgId} chatId=${activeThreadId}`);
        if (isTelegramBot(activeContact?.channel)) {
          await ipc.telegram?.editMessage({ accountId: activeAccountId, chatId: activeThreadId, messageId: rawMsgId, text: msgText });
        } else if (isTelegramUser(activeContact?.channel)) {
          const res = await (ipc as any).telegramUser?.editMessage({ accountId: activeAccountId, chatId: activeThreadId, messageId: rawMsgId, text: msgText });
          console.log(`[MessageInput] Telegram editMessage result:`, JSON.stringify(res));
          if (res && !res.success) {
            showNotification(tr('Sửa tin nhắn thất bại: {{v1}}', { v1: (res.error || 'Unknown error') }), 'error');
            return;
          }
        } else if (isFacebook(activeContact?.channel)) {
          await ipc.fb?.editMessage({ accountId: activeAccountId, messageId: rawMsgId, text: msgText });
        }
        // Update local message content
        useChatStore.getState().updateMessageEdit(activeAccountId, activeThreadId, rawMsgId, msgText, (editingMsg.is_edited || 0) + 1, Date.now());
        showNotification(tr('Đã sửa tin nhắn'), 'success');
      } catch (e: any) {
        showNotification(tr('Sửa tin nhắn thất bại: {{v1}}', { v1: (e?.message || e) }), 'error');
      } finally {
        setSending(false);
        setEditingMsg(null);
        if (el) { el.innerHTML = ''; }
        setText('');
      }
      return;
    }

    const quotePayload = buildQuotePayload(replyTo);

    // Clear textarea immediately for instant visual feedback.
    // justSentRef prevents handleEditorInput from processing the resulting input event.
    justSentRef.current = true;
    if (el) { el.innerHTML = ''; }
    // Defer React state resets to next microtask (safety net for IME compositionend on macOS)
    const doClear = () => {
      setText('');
      prevTextRef.current = '';
      setMentions([]);
      setFmtRanges([]);
      setActiveFmts(new Set());
      // Reset flag after a short delay so any trailing input events are ignored
      setTimeout(() => { justSentRef.current = false; }, 50);
    };
    setTimeout(doClear, 0);
    const imagesToSend = [...clipboardImages];
    setClipboardImages([]);
    setSending(true);
    // ── Cancel pending debounced draft save to prevent re-saving stale draft ──
    if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null; }
    // Clear the draft when the message is sent
    if (activeAccountId && activeThreadId) clearDraft(activeAccountId, draftThreadId || activeThreadId);

    try {
      // ── Send clipboard images first ──────────────────────────────────
      if (imagesToSend.length > 0) {
        // Save each blob to a temp file, then send as a batch
        const tempPaths: string[] = [];
        for (const img of imagesToSend) {
          const ext = img.blob.type.split('/')[1] || 'png';
          const res = await ipc.file?.saveTempBlob({ base64: img.dataUrl, ext });
          if (res?.success && res.filePath) tempPaths.push(res.filePath);
        }
        if (tempPaths.length > 0) {
          const ch = activeContact?.channel || CHANNEL.ZALO;
          const imgBatchTempId = generateTempId();
          addMessage(activeAccountId, activeThreadId, {
            msg_id: imgBatchTempId, owner_zalo_id: activeAccountId, thread_id: activeThreadId,
            thread_type: activeThreadType, sender_id: activeAccountId, content: '',
            msg_type: 'image', timestamp: Date.now(), is_sent: 1, status: 'sending',
            send_status: 'sending', temp_id: imgBatchTempId, media_type: 'image', channel: ch as any,
            ...(activeTopicId ? { topic_id: activeTopicId } : {}),
            attachments: JSON.stringify(tempPaths.map(fp => ({ type: 'image', localPath: fp }))),
            local_paths: JSON.stringify(tempPaths.reduce((acc, fp, i) => ({ ...acc, [`img${i}`]: fp }), {})),
          });
          let batchReplyToMsgId: string | undefined;
          if (quotePayload) {
            try { const q = JSON.parse(quotePayload); batchReplyToMsgId = q.msgId; } catch {}
          }
          messageQueue.enqueue({
            tempId: imgBatchTempId, zaloId: activeAccountId, threadId: activeThreadId,
            threadType: activeThreadType, channel: ch as any,
            sendFn: async () => {
              try {
                if (isTelegram(ch)) {
                  let messageId: string | undefined;
                  for (const filePath of tempPaths) {
                    const result = await channelIpc.sendAttachment(ch, {
                      accountId: activeAccountId!, threadId: activeThreadId, threadType: activeThreadType,
                      topicRootMessageId: activeTopicId || undefined, filePath, fileType: 'image',
                      // Forum topic / comment thread: reply to exactly the message being quoted
                      ...(activeTopicId && quotePayload ? { quote: quotePayload } : {}),
                    });
                    if (!result?.success) return { success: false, error: result?.error || tr('Gửi ảnh Telegram thất bại') };
                    messageId = result.messageId;
                  }
                  return { success: true, msgId: messageId };
                } else if (isNonZalo(ch)) {
                  const batchRes = await ipc.fb?.sendAttachments({
                    accountId: activeAccountId!, threadId: activeThreadId, filePaths: tempPaths,
                    typeChat: activeThreadType === 0 ? 'user' : null,
                    ...(batchReplyToMsgId ? { replyToMessageId: batchReplyToMsgId } : {}),
                  });
                  if (!batchRes?.success) return { success: false, error: batchRes?.error || tr('Gửi ảnh Facebook thất bại') };
                  return { success: true, msgId: (batchRes as any)?.messageId };
                } else {
                  const res = await ipc.zalo?.sendImages({
                    auth, threadId: activeThreadId, type: activeThreadType, filePaths: tempPaths,
                    ...(!hasText && quotePayload ? { quote: quotePayload } : {}),
                  });
                  return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
                }
              } catch (err: any) { return { success: false, error: err?.message || String(err) }; }
            },
            onSuccess: () => {
              messageQueue.registerImageBatch(
                imgBatchTempId, activeAccountId, activeThreadId, tempPaths.length,
                () => { removeMessage(activeAccountId, activeThreadId, imgBatchTempId); },
              );
            },
          });
        }
      }

      // ── Send the contact card if there is a phone number suggestion ──────────────────────
      const cardToSend = contactCardSuggestion;
      if (cardToSend) {
        try {
          await ipc.zalo?.sendCard({
            auth,
            options: { userId: cardToSend.userId, phoneNumber: cardToSend.phone },
            threadId: activeThreadId,
            type: activeThreadType,
            ...(quotePayload ? { quote: quotePayload } : {}),
          });
        } catch (err: any) {
          showNotification(tr('Gửi danh thiếp thất bại: {{message}}', { message: err.message }), 'error');
        }
        // Clear suggestion after sending card
        setContactCardSuggestion(null);
        setContactCardLoading(false);
        lastDetectedPhoneRef.current = '';
        if (quotePayload) finishReply(replyTo);
      }

      // Clear suggestion also when sending with the phone text
      if (contactCardSuggestion && hasText) {
        setContactCardSuggestion(null);
        setContactCardLoading(false);
        lastDetectedPhoneRef.current = '';
      }

      // If there is only a contact card (no text, no image) → done
      if (!hasText && !cardToSend) {
        if (quotePayload) finishReply(replyTo);
        setSending(false);
        textareaRef.current?.focus();
        return;
      }
      // If only had card (no text, no images) → done
      if (!hasText && !hasImages) {
        setSending(false);
        textareaRef.current?.focus();
        return;
      }

      // ── Use sendLink only for a plain URL, so it is not split into 2 messages (text + link) ──
      const linkPayload = parseLinkWithCaption(msgText);
      if (linkPayload && !linkPayload.caption && isUrlOnly(msgText)) {
        const ch = activeContact?.channel || CHANNEL.ZALO;
        const linkTempId = generateTempId();
        addMessage(activeAccountId, activeThreadId, {
          msg_id: linkTempId, owner_zalo_id: activeAccountId, thread_id: activeThreadId,
          thread_type: activeThreadType, sender_id: activeAccountId, content: msgText,
          msg_type: 'text', timestamp: Date.now(), is_sent: 1, status: 'sending',
          send_status: 'pending', temp_id: linkTempId, media_type: 'link',
          ...(activeTopicId ? { topic_id: activeTopicId } : {}),
        });
        messageQueue.enqueue({
          tempId: linkTempId,
          zaloId: activeAccountId,
          threadId: activeThreadId,
          threadType: activeThreadType,
          channel: ch as any,
          sendFn: async () => {
            try {
              if (isTelegramUser(ch) && activeTopicId && !isTelegramForumGeneral(activeTopicId)) {
                const r = await ((await import('@/lib/channels/adapters/registry')).getAdapter('telegram_user') as any)
                  .sendTopicMessage({ accountId: activeAccountId, threadId: activeThreadId, topicId: activeTopicId, text: msgText, replyToMsgId: quotedMessageId(quotePayload) });
                if (!r?.success) return { success: false, error: r?.error || tr('Gửi link Telegram thất bại') };
                return { success: true, msgId: r?.messageId };
              } else if (isNonZalo(ch)) {
                const r = await channelIpc.sendMessage(ch, { accountId: activeAccountId, threadId: activeThreadId, body: msgText, threadType: activeThreadType, quote: quotePayload });
                if (!r?.success) return { success: false, error: r?.error || tr('Gửi tin nhắn Facebook thất bại') };
                return { success: true, msgId: (r as any)?.messageId };
              } else {
                const res = await ipc.zalo?.sendLink({
                  auth, url: linkPayload.url, threadId: activeThreadId, type: activeThreadType,
                  ...(quotePayload ? { quote: quotePayload } : {}),
                });
                return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
              }
            } catch (err: any) {
              return { success: false, error: err?.message || String(err) };
            }
          },
        });
        if (quotePayload) finishReply(replyTo);
        setSending(false); textareaRef.current?.focus(); return;
      }

      // ── Send a normal text message ─────────────────────────────
      const activeChannel = activeContact?.channel || CHANNEL.ZALO;

      if (isNonZalo(activeContact?.channel)) {
        // Non-Zalo: route through channelIpc facade → enqueue
        const fbTempId = generateTempId();
        setReplyTo(null);
        addMessage(activeAccountId, activeThreadId, {
          msg_id: fbTempId, owner_zalo_id: activeAccountId, thread_id: activeThreadId,
          thread_type: activeThreadType, sender_id: activeAccountId, content: msgText,
          msg_type: 'text', timestamp: Date.now(), is_sent: 1, status: 'sending', channel: activeChannel as any,
          send_status: 'pending', temp_id: fbTempId, media_type: 'text',
          ...(activeTopicId ? { topic_id: activeTopicId } : {}),
          ...(quotePayload ? { quote_data: quotePayload } : {}),
          // The comments section draws the quote from reply_to_id → the comment being sent also shows up right away
          ...(commentMode && quotedMessageId(quotePayload) ? { reply_to_id: quotedMessageId(quotePayload) } : {}),
        });
        messageQueue.enqueue({
          tempId: fbTempId,
          zaloId: activeAccountId,
          threadId: activeThreadId,
          threadType: activeThreadType,
          channel: activeChannel as any,
          sendFn: async () => {
            try {
              const res = isTelegramUser(activeChannel) && activeTopicId && !isTelegramForumGeneral(activeTopicId)
                ? await ((await import('@/lib/channels/adapters/registry')).getAdapter('telegram_user') as any)
                  .sendTopicMessage({
                    accountId: activeAccountId, threadId: activeThreadId, topicId: activeTopicId, text: msgText,
                    replyToMsgId: quotedMessageId(quotePayload),
                    ...(mentions.length > 0 ? { mentions } : {}),
                  })
                : await channelIpc.sendMessage(activeChannel, {
                  accountId: activeAccountId,
                  threadId: activeThreadId,
                  body: msgText,
                  threadType: activeThreadType,
                  quote: quotePayload,
                  ...(isTelegram(activeChannel) && mentions.length > 0 ? { mentions } : {}),
                });
              if (!res?.success) {
                return { success: false, uncertain: !!res?.uncertain, msgId: res?.messageId, error: res?.error || tr('Gửi tin nhắn Facebook thất bại') };
              }
              return { success: true, msgId: res?.messageId };
            } catch (err: any) {
              return { success: false, error: err?.message || String(err) };
            }
          },
          onSuccess: () => {
            if (activeAccountId) markReplied(activeAccountId, activeThreadId);
          },
        });
      } else {
      // Zalo path (unchanged)
      const rawStyles = buildStyles();

      // Normalize the style ranges: clamp start/len to [0, msgText.length]
      // This handles the case where \u200B is selected too (Ctrl+A / Shift+End)
      // which makes len exceed the real length of msgText → the Zalo API rejects the request.
      const styles = rawStyles
        ?.map(s => {
          const clampedStart = Math.min(s.start, msgText.length);
          const clampedLen   = Math.min(s.len, msgText.length - clampedStart);
          return clampedLen > 0 ? { ...s, start: clampedStart, len: clampedLen } : null;
        })
        .filter((s): s is { start: number; len: number; st: string } => s !== null);
      const finalStyles = styles && styles.length > 0 ? styles : undefined;

      // Styled messages arrive from Zalo as webchat/RTF → match that format in temp msg
      // so (a) the preview renders with bold/italic and (b) the self-echo dedup succeeds.
      const isStyled = !!(finalStyles && finalStyles.length > 0);
      const tempContent = isStyled
        ? JSON.stringify({ action: 'rtf', title: msgText, params: { styles: finalStyles } })
        : msgText;
      const tempMsgType = isStyled ? 'webchat' : 'text';
      const tempId = generateTempId();
      setReplyTo(null);
      addMessage(activeAccountId, activeThreadId, {
        msg_id: tempId, owner_zalo_id: activeAccountId, thread_id: activeThreadId,
        thread_type: activeThreadType, sender_id: activeAccountId, content: tempContent,
        msg_type: tempMsgType, timestamp: Date.now(), is_sent: 1, status: 'sending',
        send_status: 'pending', temp_id: tempId, media_type: 'text',
      });
      // Enqueue into MessageQueue: does not block, the input is ready for the next message
      messageQueue.enqueue({
        tempId,
        zaloId: activeAccountId,
        threadId: activeThreadId,
        threadType: activeThreadType,
        channel: 'zalo',
        sendFn: async () => {
          try {
            const res = await ipc.zalo?.sendMessage({
              auth, threadId: activeThreadId, type: activeThreadType, message: msgText,
              ...(quotePayload ? { quote: quotePayload } : {}),
              ...(mentions.length > 0 ? { mentions } : {}),
              ...(finalStyles ? { styles: finalStyles } : {}),
            });
            return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
          } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
          }
        },
        onSuccess: () => {
          if (activeAccountId) markReplied(activeAccountId, activeThreadId);
        },
      });
      } // end else (Zalo path)
    } catch (err: any) {
      showNotification(tr('Gửi thất bại: {{message}}', { message: err.message }), 'error');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleSendLike = async () => {
    const auth = getAuth();
    if (!auth || !activeThreadId || !activeAccountId) return;
    const ch = activeContact?.channel || CHANNEL.ZALO;
    const likeTempId = generateTempId();
    addMessage(activeAccountId, activeThreadId, {
      msg_id: likeTempId, owner_zalo_id: activeAccountId, thread_id: activeThreadId,
      thread_type: activeThreadType, sender_id: activeAccountId, content: '👍',
      msg_type: 'text', timestamp: Date.now(), is_sent: 1, status: 'sending',
      send_status: 'pending', temp_id: likeTempId, media_type: 'text',
      ...(activeTopicId ? { topic_id: activeTopicId } : {}),
    });
    messageQueue.enqueue({
      tempId: likeTempId,
      zaloId: activeAccountId,
      threadId: activeThreadId,
      threadType: activeThreadType,
      channel: ch as any,
      sendFn: async () => {
        try {
          if (isTelegramUser(ch) && activeTopicId && !isTelegramForumGeneral(activeTopicId)) {
            const result = await (getAdapter('telegram_user') as any).sendTopicMessage({
              accountId: activeAccountId,
              threadId: activeThreadId,
              topicId: activeTopicId,
              text: '👍',
            });
            if (!result?.success) return { success: false, error: result?.error || tr('Gửi thất bại') };
            return { success: true, msgId: result.messageId };
          } else if (isNonZalo(ch)) {
            const res = await channelIpc.sendMessage(ch, { accountId: activeAccountId, threadId: activeThreadId, body: '👍', threadType: activeThreadType });
            if (!res?.success) return { success: false, uncertain: !!res?.uncertain, msgId: res?.messageId, error: res?.error || tr('Gửi thất bại') };
            return { success: true, msgId: res?.messageId };
          } else {
            const res = await ipc.zalo?.sendMessage({ auth, threadId: activeThreadId, type: activeThreadType, message: '👍' });
            return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
          }
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },
    });
  };

  const handleSendImage = async () => {
    const auth = getAuth();
    if (!auth || !activeThreadId) return;
    const result = await ipc.file?.openDialog({
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
      multiSelect: true,
    });
    if (result?.canceled || !result?.filePaths?.length) return;
    const quotePayload = buildQuotePayload(replyTo);
    const ch = activeContact?.channel || CHANNEL.ZALO;
    const filePaths = result.filePaths;

    // ── Create 1 temp batch preview (shown right away while uploading) ──
    const batchTempId = generateTempId();
    addMessage(activeAccountId!, activeThreadId, {
      msg_id: batchTempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
      thread_type: activeThreadType, sender_id: activeAccountId!, content: '',
      msg_type: 'image', timestamp: Date.now(), is_sent: 1, status: 'sending',
      send_status: 'sending', temp_id: batchTempId, media_type: 'image', channel: ch as any,
      ...(activeTopicId ? { topic_id: activeTopicId } : {}),
      attachments: JSON.stringify(filePaths.map(fp => ({ type: 'image', localPath: fp }))),
      local_paths: JSON.stringify(filePaths.reduce((acc, fp, i) => ({ ...acc, [`img${i}`]: fp }), {})),
    });

    // ── Send the batch; onSuccess deletes the temp, webhooks will add the real messages ──
    messageQueue.enqueue({
      tempId: batchTempId,
      zaloId: activeAccountId!,
      threadId: activeThreadId,
      threadType: activeThreadType,
      channel: ch as any,
      sendFn: async () => {
        try {
          if (isTelegram(ch)) {
            let messageId: string | undefined;
            for (const filePath of filePaths) {
              const result = await channelIpc.sendAttachment(ch, {
                accountId: activeAccountId!, threadId: activeThreadId, threadType: activeThreadType,
                topicRootMessageId: activeTopicId || undefined, filePath, fileType: 'image',
                ...(activeTopicId && quotePayload ? { quote: quotePayload } : {}),
              });
              if (!result?.success) return { success: false, error: result?.error || tr('Gửi ảnh Telegram thất bại') };
              messageId = result.messageId;
            }
            return { success: true, msgId: messageId };
          } else if (isNonZalo(ch)) {
            const batchRes = await ipc.fb?.sendAttachments({
              accountId: activeAccountId!, threadId: activeThreadId,
              filePaths, typeChat: activeThreadType === 0 ? 'user' : null,
            });
            if (!batchRes?.success) return { success: false, error: batchRes?.error || tr('Gửi ảnh Facebook thất bại') };
            return { success: true, msgId: (batchRes as any)?.messageId };
          } else {
            const res = await ipc.zalo?.sendImages({
              auth, threadId: activeThreadId, type: activeThreadType, filePaths,
              ...(quotePayload ? { quote: quotePayload } : {}),
            });
            return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
          }
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },
      onSuccess: () => {
        // API succeeded → KEEP the temp preview, register the batch to count the webhook
        if (quotePayload) finishReply(replyTo);
        messageQueue.registerImageBatch(
          batchTempId, activeAccountId!, activeThreadId, filePaths.length,
          () => { removeMessage(activeAccountId!, activeThreadId, batchTempId); },
        );
      },
    });
  };

  const handleSendFile = async () => {
    const auth = getAuth();
    if (!auth || !activeThreadId) return;
    const result = await ipc.file?.openDialog({ filters: [{ name: 'All Files', extensions: ['*'] }] });
    if (result?.canceled || !result?.filePaths?.length) return;
    const filePath = result.filePaths[0];
    const quotePayload = buildQuotePayload(replyTo);
    const ch = activeContact?.channel || CHANNEL.ZALO;
    const fileName = filePath.split(/[\\/]/).pop() || 'file';
    const tempId = generateTempId();
    addMessage(activeAccountId!, activeThreadId, {
      msg_id: tempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
      thread_type: activeThreadType, sender_id: activeAccountId!, content: `📎 ${fileName}`,
      msg_type: 'file', timestamp: Date.now(), is_sent: 1, status: 'sending',
      send_status: 'pending', temp_id: tempId, media_type: 'file', channel: ch as any,
      ...(activeTopicId ? { topic_id: activeTopicId } : {}),
      attachments: JSON.stringify([{ type: 'file', localPath: filePath, name: fileName }]),
    });
    messageQueue.enqueue({
      tempId,
      zaloId: activeAccountId!,
      threadId: activeThreadId,
      threadType: activeThreadType,
      channel: ch as any,
      sendFn: async () => {
        try {
          if (isNonZalo(ch)) {
            const fileRes = await channelIpc.sendAttachment(ch, {
              accountId: activeAccountId!, threadId: activeThreadId, topicRootMessageId: activeTopicId || undefined, filePath, threadType: activeThreadType,
              ...(activeTopicId && quotePayload ? { quote: quotePayload } : {}),
            });
            if (!fileRes?.success) return { success: false, error: fileRes?.error || tr('Gửi file Facebook thất bại') };
            return { success: true, msgId: (fileRes as any)?.messageId };
          } else {
            const res = await ipc.zalo?.sendFile({
              auth, threadId: activeThreadId, type: activeThreadType, filePath,
              ...(quotePayload ? { quote: quotePayload } : {}),
            });
            return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
          }
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },
      onSuccess: () => {
        if (quotePayload) finishReply(replyTo);
      },
    });
  };

  const handleSendVideo = async () => {
    const auth = getAuth();
    if (!auth || !activeThreadId) return;
    const result = await ipc.file?.openDialog({
      filters: [{ name: 'Video', extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'm4v', '3gp'] }],
      multiSelect: false,
    });
    if (result?.canceled || !result?.filePaths?.length) return;
    const videoPath = result.filePaths[0];
    const quotePayload = buildQuotePayload(replyTo);
    const ch = activeContact?.channel || CHANNEL.ZALO;
    const tempId = generateTempId();
    addMessage(activeAccountId!, activeThreadId, {
      msg_id: tempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
      thread_type: activeThreadType, sender_id: activeAccountId!, content: '🎬 Video',
      msg_type: 'video', timestamp: Date.now(), is_sent: 1, status: 'sending',
      send_status: 'pending', temp_id: tempId, media_type: 'video', channel: ch as any,
      ...(activeTopicId ? { topic_id: activeTopicId } : {}),
      attachments: JSON.stringify([{ type: 'video', localPath: videoPath }]),
    });
    messageQueue.enqueue({
      tempId,
      zaloId: activeAccountId!,
      threadId: activeThreadId,
      threadType: activeThreadType,
      channel: ch as any,
      sendFn: async () => {
        try {
          // Get the metadata and thumbnail
          const metaRes = await ipc.file?.getVideoMeta?.({ filePath: videoPath });
          let thumbPath: string = metaRes?.thumbPath || '';
          const duration: number = metaRes?.duration || 0;
          const width: number = metaRes?.width || 0;
          const height: number = metaRes?.height || 0;
          if (!thumbPath) {
            const seekSec = duration > 2 ? 1 : 0;
            const dataUrl = await extractVideoThumbViaCanvas(videoPath, seekSec);
            if (dataUrl && dataUrl.length > 100) {
              const saveRes = await ipc.file?.saveTempBlob?.({ base64: dataUrl, ext: 'jpg' });
              if (saveRes?.success && saveRes?.filePath) thumbPath = saveRes.filePath;
            }
          }
          if (isNonZalo(ch)) {
            const r = await channelIpc.sendVideo(ch, {
              accountId: activeAccountId!, threadId: activeThreadId, threadType: activeThreadType,
              topicRootMessageId: activeTopicId || undefined,
              filePath: videoPath, body: '', quote: quotePayload || undefined,
            });
            if (!r.success) return { success: false, error: r.error || tr('Gửi video Facebook thất bại') };
            return { success: true, msgId: (r as any)?.messageId };
          } else {
            let thumbUrl = '';
            if (thumbPath) {
              const uploadRes = await ipc.zalo?.uploadVideoThumb?.({ auth, thumbPath, threadId: activeThreadId, type: activeThreadType });
              const resp = uploadRes?.response;
              thumbUrl = resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.thumbUrl || resp?.fileUrl || resp?.href || '';
            }
            const uploadVideoRes = await ipc.zalo?.uploadVideoFile?.({ auth, videoPath, threadId: activeThreadId, type: activeThreadType });
            const videoUrl: string = uploadVideoRes?.response?.fileUrl || '';
            if (!videoUrl) return { success: false, error: tr('Upload video thất bại') };
            const sendRes = await ipc.zalo?.sendVideo({
              auth, options: { videoUrl, thumbnailUrl: thumbUrl || videoUrl, duration: duration ? duration * 1000 : undefined, width: width || undefined, height: height || undefined },
              threadId: activeThreadId, type: activeThreadType,
              ...(quotePayload ? { quote: quotePayload } : {}),
            });
            return { success: true, ...extractMsgIdFromResponse(sendRes, 'zalo') };
          }
        } catch (err: any) {
          return { success: false, error: err?.message || String(err) };
        }
      },
      onSuccess: () => { if (quotePayload) finishReply(replyTo); },
    });
  };

  // ── Voice recording ──────────────────────────────────────────────────
  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setIsRecording(false);
    setRecordingDuration(0);
  }, []);

  const cancelRecording = useCallback(() => {
    // ⚡ Set the flag BEFORE stopping: onstop checks this flag to skip sending
    recordingCancelledRef.current = true;
    recordingChunksRef.current = [];
    // Stop the mic tracks right away so ondataavailable adds no new data
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try { mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop()); } catch {}
      mediaRecorderRef.current.stop();
    }
    if (recordingTimerRef.current) {
      clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
    setIsRecording(false);
    setRecordingDuration(0);
  }, []);

  const handleVoiceToggle = useCallback(async () => {
    if (isRecording) {
      // Recording → stop (this triggers onstop → send)
      recordingCancelledRef.current = false; // Make sure it is not cancelled
      stopRecording();
      return;
    }

    const auth = getAuth();
    if (!auth || !activeThreadId) return;

    // Start recording
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';

      const recorder = new MediaRecorder(stream, { mimeType });
      recordingChunksRef.current = [];
      recordingCancelledRef.current = false; // Reset the flag for the new recording

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && !recordingCancelledRef.current) {
          recordingChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        // Stop all microphone tracks
        stream.getTracks().forEach(t => t.stop());

        // ⚡ If already cancelled → do not send
        if (recordingCancelledRef.current) {
          recordingChunksRef.current = [];
          return;
        }

        const chunks = recordingChunksRef.current;
        if (chunks.length === 0) return;

        const blob = new Blob(chunks, { type: mimeType });
        recordingChunksRef.current = [];

        if (blob.size < 1000) {
          showNotification(tr('Đoạn ghi âm quá ngắn'), 'error');
          return;
        }

        setSending(true);
        try {
          // Convert blob → base64 → save to a temp file
          const reader = new FileReader();
          const base64 = await new Promise<string>((resolve, reject) => {
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          const ext = mimeType.includes('webm') ? 'webm' : 'ogg';
          const saveRes = await ipc.file?.saveTempBlob?.({ base64, ext });
          if (!saveRes?.success || !saveRes?.filePath) {
            showNotification(tr('Lưu file ghi âm tạm thất bại'), 'error');
            return;
          }

          const quotePayload = buildQuotePayload(replyTo);
          const voiceTempId = generateTempId();
          const voiceChannel = activeContact?.channel || CHANNEL.ZALO;
          // Telegram: a real voice message (OGG/Opus + duration). Previously Telegram recordings went through the Zalo path, so they always failed
          const telegramVoice = isTelegramUser(voiceChannel);
          addMessage(activeAccountId!, activeThreadId, {
            msg_id: voiceTempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
            thread_type: activeThreadType, sender_id: activeAccountId!, content: '🎤 Ghi âm',
            msg_type: 'voice', timestamp: Date.now(), is_sent: 1, status: 'sending',
            send_status: 'pending', temp_id: voiceTempId, media_type: 'voice',
            ...(telegramVoice ? { channel: voiceChannel as any } : {}),
            ...(activeTopicId ? { topic_id: activeTopicId } : {}),
          });
          messageQueue.enqueue({
            tempId: voiceTempId, zaloId: activeAccountId!, threadId: activeThreadId,
            threadType: activeThreadType, channel: telegramVoice ? voiceChannel as any : 'zalo',
            sendFn: async () => {
              try {
                if (telegramVoice) {
                  const r = await channelIpc.sendAttachment(voiceChannel as any, {
                    accountId: activeAccountId!, threadId: activeThreadId, threadType: activeThreadType,
                    topicRootMessageId: activeTopicId || undefined, filePath: saveRes.filePath, fileType: 'voice',
                    ...(quotePayload ? { quote: quotePayload } : {}),
                  });
                  if (!r?.success) return { success: false, error: r?.error || tr('Gửi ghi âm Telegram thất bại') };
                  return { success: true, msgId: (r as any)?.messageId };
                }
                const uploadRes = await ipc.zalo?.uploadVoiceFile?.({ auth, voicePath: saveRes.filePath, threadId: activeThreadId, type: activeThreadType });
                const voiceUrl: string = uploadRes?.response?.fileUrl || uploadRes?.response?.normalUrl || uploadRes?.response?.hdUrl || uploadRes?.response?.url || uploadRes?.response?.href || '';
                if (!voiceUrl) return { success: false, error: tr('Upload file ghi âm thất bại') };
                const sendRes = await ipc.zalo?.sendVoice({ auth, options: { voiceUrl }, threadId: activeThreadId, type: activeThreadType, ...(quotePayload ? { quote: quotePayload } : {}) });
                return { success: true, ...extractMsgIdFromResponse(sendRes, 'zalo') };
              } catch (err: any) { return { success: false, error: err?.message || String(err) }; }
            },
            onSuccess: () => { if (quotePayload) finishReply(replyTo); },
          });
        } catch (err: any) {
          showNotification(tr('Gửi ghi âm thất bại: {{message}}', { message: err.message }), 'error');
        } finally {
          setSending(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250); // collect data every 250ms
      setIsRecording(true);
      setRecordingDuration(0);

      // Timer counting seconds
      const startTime = Date.now();
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 500);

    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        showNotification(tr('Vui lòng cho phép truy cập microphone'), 'error');
      } else {
        showNotification(tr('Không thể bắt đầu ghi âm: {{message}}', { message: err.message }), 'error');
      }
    }
  }, [isRecording, activeThreadId, activeThreadType, getAuth, stopRecording, replyTo]);

  // Clean up the recording on unmount or when the thread changes
  useEffect(() => {
    return () => {
      recordingCancelledRef.current = true;
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try { mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop()); } catch {}
        mediaRecorderRef.current.stop();
      }
      if (recordingTimerRef.current) clearInterval(recordingTimerRef.current);
    };
  }, [activeThreadId]);

  useEffect(() => {
    if (!showAiMenu) return;

    const handlePointerDownOutside = (e: MouseEvent) => {
      if (aiMenuRef.current && !aiMenuRef.current.contains(e.target as Node)) {
        setShowAiMenu(false);
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAiMenu(false);
    };

    document.addEventListener('mousedown', handlePointerDownOutside, true);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDownOutside, true);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [showAiMenu]);

  // Close bot menu when clicking outside
  useEffect(() => {
    if (!showBotMenu) return;
    const handler = (e: MouseEvent) => {
      if (botMenuRef.current && !botMenuRef.current.contains(e.target as Node)) {
        setShowBotMenu(false);
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [showBotMenu]);

  // Scroll selected bot command into view
  useEffect(() => {
    if (!showBotMenu || !botMenuRef.current) return;
    const items = botMenuRef.current.querySelectorAll('[data-bot-cmd]');
    items[botCmdSelectedIdx]?.scrollIntoView({ block: 'nearest' });
  }, [botCmdSelectedIdx, showBotMenu]);

  const handleSendSticker = () => {
    setShowEmojiPicker(false);
    setShowAiMenu(false);
    setShowStickerPicker((v) => !v);
  };

  /** Telegram sticker / GIF from the emoji panel: sent right away (replies to whatever message is being replied to), the text being composed is kept as it is. */
  const handleSendTelegramSticker = (item: TelegramStickerItem) => {
    setShowEmojiPicker(false);
    setShowStickerPicker(false);
    if (!activeAccountId || !activeThreadId) return;
    void sendTelegramStickerItem(item, {
      accountId: activeAccountId, chatId: activeThreadId, topicId: activeTopicId,
      // Comments section: the open conversation is the channel, the message being replied to belongs to this box
      ...(commentMode ? { replyTo } : {}),
    });
    textareaRef.current?.focus();
  };

  // Emoji grid: the regular emoji panel, or the Emoji tab of the Emoji · Sticker · GIF panel (Telegram)
  const renderEmojiGrid = () => (
    <div className="space-y-3">
      {Object.entries(EMOJI_CATEGORIES).map(([category, emojis]) => (
        <div key={category}>
          <p className="text-[11px] text-muted-foreground font-medium mb-1.5 px-1">{category}</p>
          <div className="grid grid-cols-8 gap-0.5">
            {emojis.map((emoji, idx) => (
              <button
                key={`${category}-${emoji}-${idx}`}
                onMouseDown={(e) => { e.preventDefault(); insertEmoji(emoji); }}
                className="text-xl hover:bg-muted rounded-lg p-1 transition-colors aspect-square flex items-center justify-center hover:scale-110"
                title={emoji}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );

  const handleToggleBotMenu = async () => {
    if (showBotMenu) { setShowBotMenu(false); return; }
    setShowBotMenu(true);
    setBotCmdSelectedIdx(0);
    if (botCommands.length > 0) return;
    if (!activeAccountId || !activeThreadId) return;
    setBotCommandsLoading(true);
    try {
      const res = await (ipc as any).telegramUser?.getBotCommands({ accountId: activeAccountId, botId: activeThreadId });
      if (res?.success && res.commands) setBotCommands(res.commands);
    } catch {}
    setBotCommandsLoading(false);
  };

  const handleSelectBotCommand = (command: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const cmdText = `/${command} `;
    setText(cmdText);
    el.textContent = cmdText;
    setShowBotMenu(false);
    el.focus();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);
  };

  const handleSendStickerItem = async (sticker: any) => {
    const auth = getAuth();
    if (!auth || !activeThreadId || sending) return;
    setShowStickerPicker(false);
    setSending(true);
    try {
      await ipc.zalo?.sendSticker({ auth, stickerId: sticker.id, threadId: activeThreadId, type: activeThreadType });
      // Save to recent + DB cache
      await DataAccessor.addRecentSticker(sticker.id);
      await DataAccessor.saveStickers({ stickers: [sticker] });
      // Clear the text input + draft after sending a sticker
      setText('');
      setFmtRanges([]);
      setActiveFmts(new Set());
      prevTextRef.current = '';
      if (textareaRef.current) textareaRef.current.innerHTML = '';
      if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null; }
      if (activeAccountId && activeThreadId) clearDraft(activeAccountId, draftThreadId || activeThreadId);
    } catch (err: any) {
      showNotification(tr('Gửi sticker thất bại: {{message}}', { message: err.message }), 'error');
    } finally {
      setSending(false);
    }
  };

  /** Send sticker from inline suggestion bar and clear text + suggestions */
  const handleInlineStickerSend = async (sticker: any) => {
    const auth = getAuth();
    if (!auth || !activeThreadId || sending) return;
    setInlineStickerSuggestions([]);
    inlineStickerLastKwRef.current = '';
    setSending(true);
    try {
      await ipc.zalo?.sendSticker({ auth, stickerId: sticker.id, threadId: activeThreadId, type: activeThreadType });
      await DataAccessor.addRecentSticker(sticker.id);
      await DataAccessor.saveStickers({ stickers: [sticker] });
      // Clear the text input after sending sticker
      setText('');
      setFmtRanges([]);
      setActiveFmts(new Set());
      prevTextRef.current = '';
      if (textareaRef.current) textareaRef.current.innerHTML = '';
      if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null; }
      if (activeAccountId && activeThreadId) clearDraft(activeAccountId, draftThreadId || activeThreadId);
    } catch (err: any) {
      showNotification(tr('Gửi sticker thất bại: {{message}}', { message: err.message }), 'error');
    } finally {
      setSending(false);
    }
  };

  const insertEmoji = (emoji: string) => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    // Insert at the current caret position
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      range.deleteContents();
      const textNode = document.createTextNode(emoji);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      el.textContent = (el.textContent || '') + emoji;
    }
    // Trigger an input event to sync the state
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  /**
   * Handler for the contenteditable input event.
   * ALWAYS rebuilds the HTML from fmtRanges after every keystroke to stop the browser from inheriting the span style.
   * Automatically shifts fmtRanges when characters are inserted / deleted before a formatted range.
   */
  const handleEditorInput = (e: React.FormEvent<HTMLDivElement>) => {
    // Skip input events triggered by IME compositionEnd after send
    if (justSentRef.current) return;
    const el = e.currentTarget;
    const rawText = getPlainText(el);
    const newText = rawText.replace(/\u200B/g, '');
    const { start: cursorPos } = getCaretOffset(el);
    const rawBeforeCursor = rawText.slice(0, cursorPos);
    const zwspCount = (rawBeforeCursor.match(/\u200B/g) || []).length;
    const realCursor = Math.max(0, cursorPos - zwspCount);

    const prevText = prevTextRef.current;
    prevTextRef.current = newText;
    setText(newText);

    // Keep native mention entity offsets in sync with edits. If a user edits
    // inside a selected mention, discard that entity rather than sending a
    // stale Telegram/Zalo tag against unrelated text.
    if (mentions.length > 0) {
      let prefixLength = 0;
      const commonLength = Math.min(prevText.length, newText.length);
      while (prefixLength < commonLength && prevText[prefixLength] === newText[prefixLength]) prefixLength++;
      let suffixLength = 0;
      while (
        suffixLength < prevText.length - prefixLength
        && suffixLength < newText.length - prefixLength
        && prevText[prevText.length - 1 - suffixLength] === newText[newText.length - 1 - suffixLength]
      ) suffixLength++;
      const oldEditEnd = prevText.length - suffixLength;
      const offsetDelta = newText.length - prevText.length;
      const adjustedMentions = mentions
        .map((mention) => {
          const mentionEnd = mention.pos + mention.len;
          if (oldEditEnd <= mention.pos) return { ...mention, pos: mention.pos + offsetDelta };
          if (prefixLength >= mentionEnd) return mention;
          return null;
        })
        .filter((mention): mention is { uid: string; pos: number; len: number; text: string } =>
          !!mention && newText.slice(mention.pos, mention.pos + mention.len) === mention.text
        );
      if (JSON.stringify(adjustedMentions) !== JSON.stringify(mentions)) {
        setMentions(adjustedMentions);
      }
    }

    // ── Debounced draft save (~1s) ────────────────────────────────────
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      // Editing a message: the text in the box is the edited content, not a draft
      if (useChatStore.getState().editingMsg) return;
      // Where the composer is writing (the open conversation, or the comments section): the value at the time the scheduled run starts
      const { accountId: aid, threadId: tid } = draftTargetRef.current;
      if (aid && tid) {
        const trimmed = newText.trim();
        if (trimmed) {
          useChatStore.getState().setDraft(aid, tid, trimmed);
        } else {
          useChatStore.getState().clearDraft(aid, tid);
        }
      }
    }, 1000);

    // Send a typing event if the content is being typed
    if (newText.length > 0) sendTypingEvent();

    // Compute the delta at the cursor
    const delta = newText.length - prevText.length;

    // Shift / adjust fmtRanges based on the delta at realCursor
    let activeRanges = fmtRanges;
    if (fmtRanges.length > 0 && delta !== 0) {
      const adjusted = fmtRanges
        .map(r => {
          const rStart = r.start;
          const rEnd = r.start + r.len;
          if (delta > 0) {
            // Insert characters at realCursor
            if (realCursor <= rStart) {
              return { ...r, start: rStart + delta };
            } else if (realCursor < rEnd) {
              return { ...r, len: r.len + delta };
            }
            return r;
          } else {
            // Delete |delta| characters: the deleted range is [delStart, delEnd)
            const delStart = realCursor;
            const delEnd = realCursor - delta;
            if (rStart >= delStart && rEnd <= delEnd) return null; // the deleted range is removed completely
            if (delEnd <= rStart) return { ...r, start: rStart + delta }; // deleted before the range
            if (delStart >= rEnd) return r; // deleted after the range
            // Overlap: shrink the range
            const overlapStart = Math.max(rStart, delStart);
            const overlapEnd = Math.min(rEnd, delEnd);
            const newLen = r.len - (overlapEnd - overlapStart);
            const newStart = delEnd <= rStart ? rStart + delta : Math.min(rStart, delStart);
            if (newLen <= 0) return null;
            return { ...r, start: newStart, len: newLen };
          }
        })
        .filter(Boolean) as Array<{ start: number; len: number; st: string }>;

      activeRanges = adjusted;
      if (JSON.stringify(adjusted) !== JSON.stringify(fmtRanges)) {
        setFmtRanges(adjusted);
      }
    }

    // ALWAYS rebuild the HTML if there are fmtRanges, to remove the styles the browser inherits by itself
    if (activeRanges.length > 0) {
      el.innerHTML = buildRichHtml(newText, activeRanges);
      const anchor = document.createTextNode('\u200B');
      el.appendChild(anchor);
      requestAnimationFrame(() => setCaretOffset(el, realCursor, realCursor));
    }

    // Detect @ mention trigger
    // Detect @ mention trigger
    // @ alone → show all members. @@, @@@ → skip.
    const textBeforeCursor = newText.slice(0, realCursor);
    let isValidMention = false;
    let mentionSearchText = '';
    let mentionTriggerIdx = -1;
    // Find the last standalone @. An empty query after @ intentionally shows
    // the full member list; @@ and email-like text do not trigger it.
    for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
      if (textBeforeCursor[i] !== '@') continue;
      const charBefore = i > 0 ? textBeforeCursor[i - 1] : '';
      const afterAt = textBeforeCursor.slice(i + 1);
      const hasMentionBoundary = !charBefore || /[\s([{"'“‘.,!?;:]/.test(charBefore);
      if (hasMentionBoundary && !afterAt.startsWith(' ') && !afterAt.startsWith('@') && !afterAt.includes('\n')) {
        isValidMention = true;
        mentionSearchText = afterAt;
        mentionTriggerIdx = i;
        break;
      }
    }
    if (isValidMention && mentionEnabled) {
      setShowMentionDropdown(true);
      setMentionSearch(mentionSearchText);
      setMentionTriggerPos(mentionTriggerIdx);
      setMentionSelectedIdx(0);
    } else {
      setShowMentionDropdown(false);
      setMentionSearch('');
      setMentionTriggerPos(-1);
    }

    const isSlashAtStart = textBeforeCursor.match(/^\/([^\s]*)$/);
    // Bot conversation: / → show bot commands menu
    const isBotChat = isTelegramUser(activeContact?.channel) && activeContact?.is_cov_bot === 1;
    if (isSlashAtStart) {
      if (isBotChat) {
        // Auto-load bot commands and show menu
        if (!showBotMenu) setShowBotMenu(true);
        if (botCommands.length === 0 && !botCommandsLoading && activeAccountId && activeThreadId) {
          setBotCommandsLoading(true);
          (async () => {
            try {
              const res = await (ipc as any).telegramUser?.getBotCommands({ accountId: activeAccountId, botId: activeThreadId });
              if (res?.success && res.commands) setBotCommands(res.commands);
            } catch {}
            setBotCommandsLoading(false);
          })();
        }
        setShowQuickDropdown(false);
      } else {
        setShowQuickDropdown(true);
        setQuickFilter(isSlashAtStart[1]);
        setQuickTriggerPos(0);
        setQuickSelectedIdx(0);
      }
    } else {
      setShowQuickDropdown(false);
      setQuickFilter('');
      setQuickTriggerPos(-1);
      if (isBotChat && !textBeforeCursor.startsWith('/')) {
        setShowBotMenu(false);
      }
    }

    updateActiveFmtsAtPos(realCursor, activeRanges);
  };

  const handleEditorKeyUp = () => {
    const el = textareaRef.current;
    if (!el) return;
    const rawText = getPlainText(el);
    const { start: rawStart } = getCaretOffset(el);
    const zwspBefore = (rawText.slice(0, rawStart).match(/\u200B/g) || []).length;
    updateActiveFmtsAtPos(rawStart - zwspBefore, fmtRanges);
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Keyboard shortcuts for formatting (like Zalo)
    if (e.ctrlKey || e.metaKey) {
      switch (e.key.toLowerCase()) {
        case 'b': e.preventDefault(); applyFormat('b'); return;
        case 'i': e.preventDefault(); applyFormat('i'); return;
        case 'u': e.preventDefault(); applyFormat('u'); return;
      }
    }

    // Handle bot commands menu navigation
    if (showBotMenu && botCommands.length > 0) {
      const filtered = text.startsWith('/')
        ? botCommands.filter(cmd => cmd.command.toLowerCase().includes(text.slice(1).toLowerCase()))
        : botCommands;
      if (e.key === 'ArrowDown') { e.preventDefault(); setBotCmdSelectedIdx(i => Math.min(i + 1, filtered.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setBotCmdSelectedIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' && !e.shiftKey && filtered[botCmdSelectedIdx]) {
        e.preventDefault(); handleSelectBotCommand(filtered[botCmdSelectedIdx].command); return;
      }
      if (e.key === 'Escape') { setShowBotMenu(false); return; }
    }
    // Handle quick message dropdown navigation
    const quickFiltered = quickFilter
      ? quickMessages.filter(i =>
          i.keyword.toLowerCase().includes(quickFilter.toLowerCase()) ||
          i.message.title.toLowerCase().includes(quickFilter.toLowerCase())
        )
      : quickMessages;
    if (showQuickDropdown && quickFiltered.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setQuickSelectedIdx(i => Math.min(i + 1, quickFiltered.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setQuickSelectedIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); handleSelectQuickMessage(quickFiltered[quickSelectedIdx]); return; }
      if (e.key === 'Escape') { setShowQuickDropdown(false); return; }
    }
    // Handle mention dropdown navigation
    if (showMentionDropdown && filteredMentions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (mentionSelectedIdx >= filteredMentions.length - 6) mentionList.loadMore();
        setMentionSelectedIdx(i => Math.min(i + 1, filteredMentions.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionSelectedIdx(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); handleSelectMention(filteredMentions[mentionSelectedIdx]); return; }
      if (e.key === 'Escape') { setShowMentionDropdown(false); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // Skip send while IME is composing (Vietnamese/Chinese input on macOS)
      if (e.nativeEvent.isComposing || isComposingRef.current) return;
      e.preventDefault(); handleSend(); return;
    }
    if (e.key === 'Escape' && replyTo) setReplyTo(null);
  };

  // ── Drag-and-drop handlers ────────────────────────────────────────────────
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current += 1;
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounterRef.current = 0;

    if (!activeThreadId || !activeAccountId) return;
    // Same handling path as dropping onto the message area (ChatWindow): read the data right in the event, then let
    // handleDragDropFiles send it (images go to the send tray, video / files through the send queue)
    window.dispatchEvent(new CustomEvent('chat:dragDropFiles', { detail: readDropPayload(e.dataTransfer) }));
  }, [activeThreadId, activeAccountId]);

  /** Save a drag-and-dropped file as a temp file on disk to send it */
  const saveDroppedFileAsTemp = async (file: File): Promise<string | null> => {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = reader.result as string;
        const ext = file.name.split('.').pop() || 'file';
        try {
          // Send the original file name to keep the name when saving the temp file
          const res = await ipc.file?.saveTempBlob?.({ base64, ext, filename: file.name });
          if (res?.success && res?.filePath) resolve(res.filePath);
          else resolve(null);
        } catch {
          resolve(null);
        }
      };
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  };

  const account = getActiveAccount();
  if (!activeThreadId) return null;
  // Comments section: commenting rights are decided by the comments section (the discussion group allows commenting without joining)
  const telegramComposerBlocked = !commentMode && isTelegramUser(activeContact?.channel) && (
    activeContact?.telegram_can_send === 0 ||
    (activeContact?.telegram_peer_type === 'channel' && activeContact?.telegram_can_send !== 1) ||
    (activeTopicClosed && !threadGroupInfo?.canManageTopics)
  );
  if (telegramComposerBlocked) {
    const joinAction = activeContact?.telegram_join_action;
    const canJoin = joinAction === 'join' || joinAction === 'request';
    const handleJoin = async () => {
      if (!activeAccountId || !activeThreadId || joiningTelegramGroup) return;
      setJoiningTelegramGroup(true);
      try {
        const result = await ipc.telegramUser?.joinGroup({ accountId: activeAccountId, chatId: activeThreadId });
        if (!result?.success) {
          showNotification(result?.error || tr('Không thể tham gia nhóm/kênh này'), 'error');
          return;
        }
        useChatStore.getState().updateContact(activeAccountId, {
          contact_id: activeThreadId,
          telegram_membership_state: result.requested ? 'pending' : 'member',
          telegram_join_action: 'none',
          ...(result.requested ? {} : {
            telegram_can_send: result.info?.canSend ? 1 : 0,
            telegram_send_reason: result.info?.sendReason || '',
          }),
        });
        showNotification(result.requested ? tr('Đã gửi yêu cầu tham gia') : tr('Đã tham gia cuộc trò chuyện'), 'success');
      } catch (error: any) {
        showNotification(error?.message || tr('Không thể tham gia nhóm/kênh này'), 'error');
      } finally {
        setJoiningTelegramGroup(false);
      }
    };
    const membershipNotice = getTelegramMembershipNotice(activeContact);
    return (
      <div className="border-t border-border bg-card px-4 py-3 text-center text-sm text-muted-foreground flex-shrink-0">
        <div>{activeTopicClosed
          ? tr('Chủ đề này đã đóng; chỉ quản trị viên có quyền mới có thể gửi tin nhắn')
          : activeContact.telegram_send_reason || tr('Bạn không có quyền gửi tin nhắn trong cuộc trò chuyện này')}</div>
        {membershipNotice && !activeTopicClosed && (
          <div className="mt-1 text-xs text-amber-400/90">{membershipNotice.description}</div>
        )}
        {canJoin && (
          <button
            type="button"
            disabled={joiningTelegramGroup}
            onClick={handleJoin}
            className="mt-2 rounded-lg bg-sky-600 px-4 py-2 font-semibold text-white hover:bg-sky-500 disabled:cursor-wait disabled:opacity-60"
          >
            {joiningTelegramGroup ? tr('Đang xử lý...') : joinAction === 'request' ? tr('Yêu cầu tham gia') : tr('Join Group')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      className="border-t border-border bg-card flex-shrink-0 relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Drag-overlay */}
      {isDragging && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm rounded-lg border-2 border-dashed border-blue-500 pointer-events-none"
          onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onDrop={(e) => { e.preventDefault(); e.stopPropagation(); }}
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.5" className="drop-shadow-lg">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <p className="text-blue-400 font-medium text-sm">{tr('Thả file / ảnh để gửi')}</p>
            <p className="text-muted-foreground text-xs">{tr('Hỗ trợ ảnh, video, file')}</p>
          </div>
        </div>
      )}

      {/* AI suggestions: only when suggestions exist (while calling AI → spin on the AI button); when called again for a new message, keep the old suggestions, faded */}
      {aiSuggest.suggestions.length > 0 && (
        <div className="ai-suggestion-bar border-b overflow-x-auto">
          <span className="ai-suggestion-badge">
            <SparklesIcon className="w-3 h-3" />
            <span>{tr('Gợi ý AI')}</span>
          </span>
          {aiSuggest.suggestions.map((s, i) => (
            <button
              key={i}
              onClick={() => { setText(s); if (textareaRef.current) textareaRef.current.innerText = s; aiSuggest.dismiss(); }}
              className={`ai-suggestion-chip group${aiSuggest.refreshing ? ' opacity-60' : ''}`}
              title={s}
            >
              <span className="ai-suggestion-chip-text line-clamp-2 break-words">{s}</span>
            </button>
          ))}
          <button
            onClick={aiSuggest.dismiss}
            className="ai-suggestion-close"
            title={tr('Ẩn gợi ý')}
          >
            ✕
          </button>
        </div>
      )}

      {/* Reply preview */}
      {replyTo && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <div className="flex-1 border-l-2 border-blue-500 pl-2 min-w-0 flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-blue-400 font-medium">{tr('Trả lời')}</p>
              <p className="text-xs text-muted-foreground truncate">{parseReplyContent(replyTo.content, replyTo.msg_type, replyTo.channel, replyTo.attachments)}</p>
            </div>
            {isImageMsg(replyTo.msg_type, replyTo.content) && (() => {
              const imgs = extractReplyImages(replyTo.content, replyTo.attachments);
              return imgs.length > 0 ? (
                <div className="flex gap-1 flex-shrink-0">
                  {imgs.slice(0, 3).map((url, i) => (
                    <img key={i} src={url} alt="" className="w-10 h-10 rounded object-cover border border-input" />
                  ))}
                  {imgs.length > 3 && <div className="w-10 h-10 rounded bg-accent flex items-center justify-center text-xs text-foreground/80">+{imgs.length - 3}</div>}
                </div>
              ) : null;
            })()}
          </div>
          <button onClick={() => setReplyTo(null)} className="text-muted-foreground hover:text-foreground flex-shrink-0 text-lg leading-none">✕</button>
        </div>
      )}

      {/* Edit mode indicator */}
      {editingMsg && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
          <div className="flex-1 border-l-2 border-amber-500 pl-2 min-w-0">
            <p className="text-xs text-amber-400 font-medium">{tr('Đang sửa tin nhắn')}</p>
            <p className="text-xs text-muted-foreground truncate">{editingMsg.content || ''}</p>
          </div>
          <button onClick={() => { setEditingMsg(null); }} className="text-muted-foreground hover:text-foreground flex-shrink-0 text-lg leading-none">✕</button>
        </div>
      )}

      {/* Clipboard image previews */}
      {clipboardImages.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card overflow-x-auto">
          <span className="text-xs text-muted-foreground flex-shrink-0">{tr('Ảnh đính kèm:')}</span>
          {clipboardImages.map((img) => (
            <div key={img.id} className="relative flex-shrink-0 group/clip">
              <img
                src={img.dataUrl}
                alt={tr('clipboard')}
                className="w-16 h-16 rounded-lg object-cover border border-input"
              />
              <button
                onClick={() => setClipboardImages(prev => prev.filter(i => i.id !== img.id))}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-accent hover:bg-red-500 rounded-full flex items-center justify-center text-white text-xs font-bold shadow-lg transition-colors"
                title={tr('Xóa ảnh')}
              >✕</button>
            </div>
          ))}
          <button
            onClick={() => setClipboardImages([])}
            className="flex-shrink-0 text-xs text-muted-foreground hover:text-red-400 px-2 py-1 rounded hover:bg-muted transition-colors ml-auto"
            title={tr('Xóa tất cả')}
          >{tr('Xóa tất cả')}</button>
        </div>
      )}

      {/* Local labels failed to load (employee mode) and there are no labels to show yet: a compact "Thử lại" (Retry) instead of hiding the whole label row */}
      {showLocalLabels && localLabels.length === 0 && localLabelsFailed && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50 text-xs text-muted-foreground">
          <span>{tr('Không tải được Nhãn Local')}</span>
          <button type="button" onClick={() => { void loadLocalLabelsForThread(); }} className="inline-flex items-center gap-1 text-primary hover:underline">
            {trx('<0/>Thử lại', { 0: <RefreshIcon className="w-3 h-3" /> })}
          </button>
        </div>
      )}

      {/* Local label row - Pancake-style horizontal pills */}
      {showLocalLabels && localLabels.length > 0 && (
        <div className="flex items-start gap-1.5 px-3 py-2 border-b border-border/50 transition-all">
          <div ref={labelRowRef} className="flex flex-wrap gap-1.5 flex-1 min-w-0 transition-all" style={{ maxHeight: localLabelExpanded ? 'none' : 56, overflow: localLabelExpanded ? 'visible' : 'hidden',}}>
            {localLabels.map(label => {
            const active = threadLocalLabelIds.has(label.id);
            const isToggling = togglingLocalLabelId === label.id;
            return (
              <button
                key={label.id}
                onClick={() => handleToggleLocalLabel(label)}
                disabled={isToggling}
                className={`inline-flex items-center gap-1 px-3 text-[12px] py-1 rounded-full text-[11px] font-medium whitespace-nowrap transition-all duration-150 border ${
                  isToggling ? 'scale-95 opacity-60' : 'hover:scale-[1.03]'
                } ${active ? 'shadow-sm' : ''}`}
                style={active ? {
                  backgroundColor: label.color || '#3b82f6',
                  color: label.text_color || '#fff',
                  borderColor: label.color,
                } : {
                  backgroundColor: `${label.color || '#3b82f6'}85`,
                  color: label.text_color || '#93c5fd',
                  borderColor: `${label.color || '#3b82f6'}80`,
                  opacity: 0.75,
                }}
                title={active ? tr('✓ {{name}} - nhấn để gỡ', { name: label.name }) : tr('Gắn nhãn "{{name}}"', { name: label.name })}
              >
                {label.emoji ? (
                  <span className="text-xs leading-none">{label.emoji}</span>
                ) : ''}
                <span className="leading-none">{label.name}</span>
                {active && (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="flex-shrink-0 ml-0.5 opacity-70">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                )}
              </button>
            );
          })}
          </div>
          {/* Right-side controls: expand/collapse arrow + close X */}
          <div className="flex items-center gap-1 flex-shrink-0 ml-1">
            {/* The latest load failed: the old labels are shown (the attached labels may not be correct) → retry */}
            {localLabelsFailed && (
              <button type="button" onClick={() => { void loadLocalLabelsForThread(); }} className="text-warning hover:text-foreground flex-shrink-0" title={tr('Không tải được Nhãn Local mới nhất — bấm để thử lại')}>
                <RefreshIcon className="w-4 h-4" />
              </button>
            )}
            {localLabelCanExpand && (
              <button type="button" onClick={() => setLocalLabelExpanded(v => !v)} className="text-muted-foreground hover:text-foreground/80 flex-shrink-0" title={localLabelExpanded ? tr('Thu gọn') : tr('Xem tất cả')}>
                {localLabelExpanded ? (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="6 15 12 9 18 15" />
                    </svg>
                )}
              </button>
            )}
            <button type="button" onClick={() => { setShowLocalLabels(false); localStorage.setItem('show_local_labels', '0'); }} className="text-red-400 hover:text-red-300 flex-shrink-0" title={tr('Đóng danh sách nhãn')}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        </div>
      )}


      {/* ── Inline sticker suggestions (Zalo-style) - above toolbar ── */}
      {inlineStickerSuggestions.length > 0 && (
        <div
          className="inline-sticker-bar flex items-center gap-1.5 px-2 py-1.5 border-b border-border/50 overflow-x-auto"
          style={{ scrollbarWidth: 'none' }}
          onWheel={e => {
            // Convert vertical wheel to horizontal scroll so mouse wheel works naturally
            if (e.deltaY !== 0) {
              e.preventDefault();
              e.currentTarget.scrollBy({ left: e.deltaY, behavior: 'auto' });
            }
          }}
        >
          <span className="text-[10px] text-muted-foreground flex-shrink-0 mr-0.5">🎭</span>
          {inlineStickerSuggestions.map((s: any) => (
            <button
              key={s.id}
              onClick={() => handleInlineStickerSend(s)}
              className="flex-shrink-0 w-12 h-12 rounded-xl hover:bg-muted/80 flex items-center justify-center overflow-hidden transition-all hover:scale-110 p-0.5"
              title={s.text || tr('Sticker {{id}} - bấm để gửi', { id: s.id })}
            >
              {s.stickerUrl ? (
                <img
                  src={s.stickerUrl}
                  alt=""
                  className="w-full h-full object-contain"
                  loading="lazy"
                  onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />
              ) : (
                <span className="text-xl">🎭</span>
              )}
            </button>
          ))}
          <button
            onClick={() => { setInlineStickerSuggestions([]); inlineStickerLastKwRef.current = ''; }}
            className="flex-shrink-0 w-6 h-6 rounded-full hover:bg-muted flex items-center justify-center text-muted-foreground hover:text-foreground/80 text-[10px] transition-colors ml-0.5"
            title={tr('Ẩn gợi ý sticker')}
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Contact card suggestion bar (phone number detected) ── */}
      {(contactCardSuggestion || contactCardLoading) && (
        <div className="flex items-center gap-3 px-3 py-2 border-b border-blue-500/30 bg-blue-950/30">
          {contactCardLoading ? (
            <div className="flex items-center gap-3 flex-1">
              <div className="w-9 h-9 rounded-full bg-blue-800/50 animate-pulse flex-shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-28 bg-blue-800/40 rounded animate-pulse" />
                <div className="h-2.5 w-20 bg-blue-800/30 rounded animate-pulse" />
              </div>
            </div>
          ) : contactCardSuggestion ? (
            <>
              <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 bg-blue-800/50">
                {contactCardSuggestion.avatarUrl ? (
                  <img src={contactCardSuggestion.avatarUrl} alt="" className="w-full h-full object-cover"
                    onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <PeerInitials id={contactCardSuggestion.userId} name={contactCardSuggestion.displayName} className="w-full h-full text-xs" />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-blue-200 truncate">{contactCardSuggestion.displayName}</p>
                <div className="flex items-center gap-1.5 mt-0.5">
                  <p className="text-xs text-blue-300/80">{contactCardSuggestion.phone}</p>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      navigator.clipboard.writeText(contactCardSuggestion.phone).then(() => {
                        showNotification(tr('Đã copy số điện thoại'), 'success');
                      }).catch(() => {});
                    }}
                    className="text-[10px] text-blue-400/60 hover:text-blue-200 transition-colors px-1 py-0.5 rounded hover:bg-blue-800/40"
                    title={tr('Copy số điện thoại')}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                    </svg>
                  </button>
                </div>
              </div>
              <span className="text-[11px] text-blue-300/70 flex-shrink-0 bg-blue-900/40 px-2.5 py-1 rounded-full border border-blue-500/30">
                {tr('Danh thiếp')}
              </span>
              <button
                onClick={() => { setContactCardSuggestion(null); setContactCardLoading(false); lastDetectedPhoneRef.current = ''; }}
                className="flex-shrink-0 w-5 h-5 rounded-full hover:bg-blue-800/50 flex items-center justify-center text-blue-300/70 hover:text-blue-200 text-xs transition-colors"
                title={tr('Bỏ gợi ý')}
              >
                ✕
              </button>
            </>
          ) : null}
        </div>
      )}

      {/* ── Toolbar row ── */}
      <div className="flex items-center gap-1 px-2 pt-2 pb-1 border-b border-border/50">
        {/* Emoji / Expressions */}
        {/* Sticker (hidden in employee mode without permission). Personal Telegram: the Emoji · Sticker · GIF panel syncs with the account;
            Telegram bots have no account sticker-set API → hidden */}
        {channelCap.supportsSticker && hasChatPermission && !isTelegramBot(activeContact?.channel) && (
        <div className="relative" ref={stickerToolbarRef}>
          <ToolbarBtn onClick={handleSendSticker} title={isTelegramUser(activeContact?.channel) ? tr('Sticker · GIF') : tr('Sticker')} active={showStickerPicker}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="10" r="1.5"/><circle cx="15" cy="10" r="1.5"/><path d="M9 15s1.5 2 3 2 3-2 3-2"/>
            </svg>
          </ToolbarBtn>
          {showStickerPicker && (
            isTelegramUser(activeContact?.channel)
            ? activeAccountId ? (
                <TelegramMediaPicker
                  accountId={activeAccountId}
                  initialTab="stickers"
                  emoji={renderEmojiGrid()}
                  canSendMedia={hasChatPermission}
                  onPick={handleSendTelegramSticker}
                  onClose={() => setShowStickerPicker(false)}
                  anchorRef={stickerToolbarRef}
                  className="absolute bottom-full left-0 mb-2 z-50"
                />
              ) : null
            : <StickerPicker
                getAuth={getAuth}
                onSelect={handleSendStickerItem}
                onClose={() => setShowStickerPicker(false)}
                onInsertEmoji={(emoji) => { insertEmoji(emoji); }}
              />
          )}
        </div>
        )}

        {/* Send image → open the library (hidden in employee mode without permission) */}
        {channelCap.supportsImage && hasChatPermission && (
          <ToolbarBtn
            onClick={() => {
              setLibraryPickerType('image');
              setShowLibraryPicker(true);
            }}
            title={tr('Gửi ảnh')}
            disabled={sending}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
            </svg>
          </ToolbarBtn>
        )}

        {/* Send file → open the library (hidden in employee mode without permission) */}
        {channelCap.supportsFile && hasChatPermission && (
        <ToolbarBtn
          onClick={() => {
            setLibraryPickerType('file');
            setShowLibraryPicker(true);
          }}
          title={tr('Gửi file')}
          disabled={sending}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </ToolbarBtn>
        )}

        {/* Send video → open the library (hidden in employee mode without permission) */}
        {channelCap.supportsVideo && hasChatPermission && (
        <ToolbarBtn
          onClick={() => {
            setLibraryPickerType('video');
            setShowLibraryPicker(true);
          }}
          title={tr('Gửi video')}
          disabled={sending || isRecording}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
        </ToolbarBtn>
        )}

        {/* Voice recording (hidden in employee mode without permission) */}
        {hasChatPermission && (<React.Fragment>
        <ToolbarBtn
          onClick={handleVoiceToggle}
          title={isRecording ? tr('Dừng & gửi ghi âm') : tr('Ghi âm giọng nói')}
          disabled={sending}
          active={isRecording}
        >
          {isRecording ? (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none">
              <rect x="6" y="6" width="12" height="12" rx="2" className="text-red-400"/>
            </svg>
          ) : (
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
              <path d="M19 10v2a7 7 0 01-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>
            </svg>
          )}
        </ToolbarBtn>
        {isRecording && (
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-red-950/30 border border-red-800/40">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"/>
            <span className="text-xs text-red-300 font-mono tabular-nums">
              {Math.floor(recordingDuration / 60).toString().padStart(2, '0')}:{(recordingDuration % 60).toString().padStart(2, '0')}
            </span>
            <button
              onClick={cancelRecording}
              className="ml-1 text-muted-foreground hover:text-red-400 transition-colors"
              title={tr('Huỷ ghi âm')}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        )}
        </React.Fragment>)}

        {/* Text formatting */}
        {channelCap.supportsTextStyle && !commentMode && (
        <ToolbarBtn onClick={() => setShowFormatBar(v => !v)} title={tr('Định dạng')} active={showFormatBar || activeFmts.size > 0}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>
          </svg>
        </ToolbarBtn>
        )}

        {/* Send contact card (hidden in employee mode without permission) */}
        {channelCap.supportsBusinessCard && hasChatPermission && (
        <ToolbarBtn onClick={() => setShowSendCard(true)} title={tr('Gửi danh thiếp')} disabled={sending}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
            <circle cx="8" cy="15" r="1.5"/><line x1="11" y1="15" x2="16" y2="15"/>
          </svg>
        </ToolbarBtn>
        )}

        {/* Send bank card (hidden in employee mode without permission) */}
        {channelCap.supportsBankCard && hasChatPermission && (
        <ToolbarBtn onClick={() => setShowBankCard(true)} title={tr('Gửi thẻ ngân hàng')} disabled={sending}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>
            <line x1="5" y1="15" x2="7" y2="15"/><line x1="9" y1="15" x2="13" y2="15"/>
          </svg>
        </ToolbarBtn>
        )}
        {/* Send product from the Zalo Business catalog (ZL-04) */}
        {canSendProducts && (
        <ToolbarBtn onClick={() => setShowCatalog(true)} title={tr('Gửi sản phẩm (Zalo Business)')} disabled={sending}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/>
            <path d="M16 10a4 4 0 0 1-8 0"/>
          </svg>
        </ToolbarBtn>
        )}
        {/* Plugin buttons (contributes.composerButtons): belong to the conversation, not the comments section */}
        {!commentMode && <PluginComposerButtons accountId={activeAccountId} threadId={activeThreadId} />}
        {/* Quick messages */}
        <div className="relative">
          <ToolbarBtn onClick={() => setShowQuickManager(v => !v)} title={tr('Tin nhắn nhanh')} active={showQuickManager}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
            </svg>
          </ToolbarBtn>
          {showQuickManager && (
              <QuickMessageManagerPanel
                  onSelect={handleSelectFromPanel}
                  onClose={() => {
                    setShowQuickManager(false);
                    if (activeAccountId) {
                      const account = getActiveAccount();
                      if (account) {
                        const channelCap = getCapability((account.channel || CHANNEL.ZALO) as any);
                        const auth = buildZaloAuth(account);
                        const mode = channelCap.quickMessageSyncMode === 'local' ? 'local' : ((localStorage.getItem(`qm_mode_${activeAccountId}`) as 'zalo' | 'local') || 'local');
                        if (channelCap.quickMessageSyncMode !== 'local') invalidateZaloQuickMessageCache(activeAccountId);
                        fetchQuickMessages(auth, activeAccountId, mode, true).then(setQuickMessages).catch(() => {});
                      }
                    }
                  }}
              />
          )}
        </div>

        {!commentMode && <ToolbarBtn onClick={toggleLocalLabels} title={showLocalLabels ? tr('Ẩn nhãn local') : tr('Hiện nhãn local')}>
          {showLocalLabels ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/>
                <line x1="7" y1="7" x2="7.01" y2="7"/>
              </svg>
          ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M2 12V2h10l8.59 8.59a2 2 0 010 2.82l-7.17 7.17a2 2 0 01-2.83 0L6 13" />
                <line x1="3" y1="3" x2="21" y2="21" />
              </svg>
          )}
        </ToolbarBtn>}

        {/* ── Pinned integration shortcuts ── */}
        {!commentMode && pinnedIntegrationShortcuts.length > 0 && (
          <>
            <div className="w-px h-4 bg-muted mx-0.5 flex-shrink-0" />
            {pinnedIntegrationShortcuts.map(shortcut => (
              <div key={shortcut.id} className="relative flex-shrink-0">
                <ToolbarBtn
                  onClick={() => {
                    setPinnedCtxMenu(null);
                    setPinnedEditIconId(null);
                    openIntegrationPanelTo(shortcut.integrationId, shortcut.action);
                  }}
                  title={tr('{{icon}} {{actionLabel}} ({{integrationName}})\nChuột phải để sửa / xóa', { icon: shortcut.icon, actionLabel: shortcut.actionLabel, integrationName: shortcut.integrationName })}
                  onContextMenu={e => {
                    e.preventDefault();
                    setPinnedEditIconId(null);
                    setPinnedCtxMenu(pinnedCtxMenu === shortcut.id ? null : shortcut.id);
                  }}
                >
                  <span className="text-base leading-none">{shortcut.icon}</span>
                </ToolbarBtn>

                {/* Right-click context menu */}
                {pinnedCtxMenu === shortcut.id && (
                  <PinContextMenu
                    onEditIcon={() => {
                      setPinnedCtxMenu(null);
                      setPinnedEditIconId(shortcut.id);
                    }}
                    onDelete={() => {
                      unpinIntegrationShortcut(shortcut.id);
                      setPinnedCtxMenu(null);
                    }}
                    onClose={() => setPinnedCtxMenu(null)}
                  />
                )}

                {/* Icon edit picker (opens after choosing "Đổi icon" (Change icon) from the context menu) */}
                {pinnedEditIconId === shortcut.id && (
                  <PinEmojiPicker
                    onSelect={icon => { editPinnedShortcutIcon(shortcut.id, icon); setPinnedEditIconId(null); }}
                    onClose={() => setPinnedEditIconId(null)}
                  />
                )}
              </div>
            ))}
          </>
        )}

        {/* AI Suggestions toggle with dropdown */}
        {!commentMode && <div ref={aiMenuRef} className="relative">
          <ToolbarBtn
            onClick={() => {
              setShowStickerPicker(false);
              setShowAiMenu(v => !v);
            }}
            title={aiSuggest.loading ? tr('Gợi ý AI: đang gợi ý câu trả lời…')
              : aiSuggest.error ? tr('Gợi ý AI: không gọi được AI ({{error}})', { error: aiSuggest.error }) : tr('Gợi ý AI')}
            active={aiSuggestOn}
          >
            <span className="leading-none relative">
              <BotIcon className="w-5 h-5" />
              {/* AI in progress: the star turns into a small spinner at the corner of the button; the most recent call failed: red star */}
              {aiSuggest.loading ? (
                <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" aria-hidden="true" />
              ) : (
                <SparklesIcon className={`absolute bottom-4 left-2 w-3 h-3${aiSuggest.error ? ' ai-tool-sparkle-error' : ''}`} />
              )}
            </span>
          </ToolbarBtn>
          {showAiMenu && (
            <AiSuggestionMenu accountId={activeAccountId} threadId={activeThreadId} channel={activeContact?.channel}
              kind={aiSuggestKind} onAssistantChanged={aiSuggest.refresh} />
          )}
        </div>}

        {/* More features - groups: poll / note / appointment reminder; users: appointment reminder only (comments section: none) */}
        {!commentMode && <div className="relative">
          <ToolbarBtn
            ref={moreMenuBtnRef}
            onClick={() => setShowMoreMenu(v => !v)}
            title={tr('Thêm tính năng')}
            active={showMoreMenu}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>
            </svg>
          </ToolbarBtn>

          {/* More menu dropdown */}
          {showMoreMenu && (
            <MoreMenuDropdown
              isGroup={activeThreadType === 1}
              onCreatePoll={() => { setShowMoreMenu(false); setShowCreatePoll(true); }}
              onCreateNote={() => { setShowMoreMenu(false); setShowCreateNote(true); }}
              onCreateReminder={() => { setShowMoreMenu(false); setShowReminderPopup(true); }}
              onOpenIntegration={() => { setShowMoreMenu(false); toggleIntegrationQuickPanel(); }}
              onClose={() => setShowMoreMenu(false)}
              supportsPoll={channelCap.supportsPoll}
              supportsReminder={channelCap.supportsReminder}
            />
          )}

          {/* Reminder popup */}
          {showReminderPopup && activeThreadId && (
            <ReminderPanel
              threadId={activeThreadId}
              threadType={activeThreadType || 0}
              onClose={() => setShowReminderPopup(false)}
              anchorRef={moreMenuBtnRef}
            />
          )}

        </div>}

        {/* Shortcuts: keyboard icon, click to see the list of shortcuts */}
        <div className="relative ml-auto">
          <ToolbarBtn
            ref={shortcutsBtnRef}
            onClick={() => setShowShortcuts(v => !v)}
            title={tr('Phím tắt')}
            active={showShortcuts}
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="4" width="20" height="16" rx="2" />
              <line x1="6" y1="8" x2="6.01" y2="8" />
              <line x1="10" y1="8" x2="10.01" y2="8" />
              <line x1="14" y1="8" x2="14.01" y2="8" />
              <line x1="18" y1="8" x2="18.01" y2="8" />
              <line x1="6" y1="12" x2="6.01" y2="12" />
              <line x1="10" y1="12" x2="10.01" y2="12" />
              <line x1="14" y1="12" x2="14.01" y2="12" />
              <line x1="18" y1="12" x2="18.01" y2="12" />
              <line x1="6" y1="16" x2="6.01" y2="16" />
              <line x1="10" y1="16" x2="10.01" y2="16" />
              <line x1="14" y1="16" x2="14.01" y2="16" />
              <line x1="18" y1="16" x2="18.01" y2="16" />
            </svg>
          </ToolbarBtn>

          {showShortcuts && (
            <ShortcutsPopup
              onClose={() => setShowShortcuts(false)}
            />
          )}
        </div>

      </div>

      {/* ── Format bar (expandable) ── */}
      {showFormatBar && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-border/50 flex-wrap">
          {/* Bold */}
          <FmtBtn active={activeFmts.has('b')} onClick={() => applyFormat('b')} title={tr('Đậm (Ctrl+B)')}>
            <span className="font-bold text-sm leading-none">B</span>
          </FmtBtn>
          {/* Italic */}
          <FmtBtn active={activeFmts.has('i')} onClick={() => applyFormat('i')} title={tr('Nghiêng (Ctrl+I)')}>
            <span className="italic text-sm leading-none">I</span>
          </FmtBtn>
          {/* Underline */}
          <FmtBtn active={activeFmts.has('u')} onClick={() => applyFormat('u')} title={tr('Gạch dưới (Ctrl+U)')}>
            <span className="underline text-sm leading-none">U</span>
          </FmtBtn>
          {/* Strikethrough */}
          <FmtBtn active={activeFmts.has('s')} onClick={() => applyFormat('s')} title={tr('Gạch ngang')}>
            <span className="line-through text-sm leading-none">S</span>
          </FmtBtn>

          <div className="w-px h-4 bg-accent mx-1" />

          {/* Font size */}
          <FmtBtn active={activeFmts.has('f_13')} onClick={() => applyFormat('f_13')} title={tr('Chữ nhỏ')}>
            <span className="text-xs leading-none font-medium">A</span>
          </FmtBtn>
          <FmtBtn active={activeFmts.has('f_18')} onClick={() => applyFormat('f_18')} title={tr('Chữ lớn')}>
            <span className="text-base leading-none font-medium">A</span>
          </FmtBtn>

          <div className="w-px h-4 bg-accent mx-1" />

          {/* Colors */}
          {([
            { st: 'c_db342e', color: '#db342e', label: tr('Đỏ') },
            { st: 'c_f27806', color: '#f27806', label: tr('Cam') },
            { st: 'c_f7b503', color: '#f7b503', label: tr('Vàng') },
            { st: 'c_15a85f', color: '#15a85f', label: tr('Xanh lá') },
          ] as const).map(({ st, color, label }) => (
            <button
              key={st}
              onMouseDown={(e) => { e.preventDefault(); applyFormat(st); }}
              title={label}
              className={`w-5 h-5 rounded-full border-2 transition-all hover:scale-110 ${activeFmts.has(st) ? 'border-white scale-110' : 'border-transparent'}`}
              style={{ backgroundColor: color }}
            />
          ))}

          <div className="w-px h-4 bg-accent mx-1" />

          {/* Clear all formats */}
          {fmtRanges.length > 0 && (
            <button
                onMouseDown={(e) => {
                  e.preventDefault();
                  setFmtRanges([]);
                  setActiveFmts(new Set());
                  const el = textareaRef.current;
                  if (el) {
                    el.textContent = getPlainText(el);
                    requestAnimationFrame(() => el.focus());
                  }
                }}
                title={tr('Xóa tất cả định dạng')}
              className="text-xs text-muted-foreground hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-muted transition-colors"
            >{tr('✕ Xóa định dạng')}</button>
          )}

          {/* Hint: select text to apply */}
          {fmtRanges.length === 0 && (
            <span className="text-xs text-muted-foreground ml-auto">{tr('Chọn văn bản rồi bấm định dạng')}</span>
          )}
          {fmtRanges.length > 0 && (
            <span className="text-xs text-blue-400 ml-auto">
              {trx('{{count}} định dạng đang áp dụng', { count: fmtRanges.length })}
            </span>
          )}
        </div>
      )}

      {/* SendCard Modal */}
      {showSendCard && activeThreadId && (
        <SendCardModal
          threadId={activeThreadId}
          threadType={activeThreadType}
          onClose={() => setShowSendCard(false)}
        />
      )}

      {/* BankCard Modal */}
      {showBankCard && activeThreadId && (
        <BankCardModal
          threadId={activeThreadId}
          threadType={activeThreadType}
          onClose={() => setShowBankCard(false)}
        />
      )}

      {/* Zalo Business product catalog (ZL-04) */}
      {showCatalog && activeThreadId && activeAccountId && (
        <ZaloCatalogPicker accountId={activeAccountId} threadId={activeThreadId} threadType={activeThreadType}
          onClose={() => setShowCatalog(false)} />
      )}

      {/* Create Poll Dialog - group only */}
      {showCreatePoll && activeThreadId && activeAccountId && (
        <CreatePollDialog
          groupId={activeThreadId}
          activeAccountId={activeAccountId}
          channel={activeContact?.channel || CHANNEL.ZALO}
          onClose={() => setShowCreatePoll(false)}
        />
      )}

      {/* Create Note Modal - group only */}
      {showCreateNote && activeThreadId && (
        <NoteViewModal
          groupId={activeThreadId}
          initialTitle=""
          isGroup={isGroupThread}
          activeAccountId={activeAccountId || ''}
          onClose={() => setShowCreateNote(false)}
        />
      )}

      {/* ── Input row ── */}
      <div className="relative flex items-end gap-2 px-3 py-2">
        {/* Bot Menu button, before the message input */}
        {isTelegramUser(activeContact?.channel) && activeContact?.is_cov_bot === 1 && (() => {
          const hasMainApp = activeContact?.has_main_app === 1;
          let menuBtnLabel = hasMainApp ? 'Open' : 'Menu';
          let menuBtnType: 'main_app' | 'commands' | 'custom' | 'default' = hasMainApp ? 'main_app' : 'commands';
          let menuBtnUrl = '';
          if (!hasMainApp) {
            try {
              const mb = activeContact.menu_button ? JSON.parse(activeContact.menu_button) : null;
              if (mb?.type === 'custom' && mb.text) { menuBtnLabel = mb.text; menuBtnType = 'custom'; menuBtnUrl = mb.url || ''; }
              else if (mb?.type === 'commands') { menuBtnType = 'commands'; }
              else if (mb?.type === 'default') { menuBtnType = 'default'; }
            } catch {}
          }
          return (<>
          <div className="relative flex-shrink-0 mb-0.5">
            <button
              onClick={() => {
                // Mini App opens inside the app like Telegram (lib/chat/telegram/telegramMiniApp): main app / bot menu button
                const botName = activeContact?.alias || activeContact?.display_name || undefined;
                if (menuBtnType === 'main_app' && activeAccountId && activeThreadId) {
                  openTelegramMiniApp({ accountId: activeAccountId, botId: activeThreadId, peerId: activeThreadId, kind: 'main', botName });
                } else if (menuBtnType === 'custom' && menuBtnUrl && activeAccountId && activeThreadId) {
                  openTelegramMiniApp({
                    accountId: activeAccountId, botId: activeThreadId, peerId: activeThreadId, kind: 'menu', url: menuBtnUrl, botName,
                  });
                } else {
                  handleToggleBotMenu();
                }
              }}
              className={`px-3 py-2 text-xs font-medium rounded-xl transition-colors ${showBotMenu ? 'bg-blue-600 text-white-important' : menuBtnType === 'main_app' ? 'bg-green-600 text-white-important hover:bg-green-500' : 'bg-blue-600/80 text-white-important hover:bg-blue-500'}`}
            >
              {menuBtnLabel}
            </button>
            {showBotMenu && (
              <div ref={botMenuRef} className="absolute bottom-full left-0 mb-2 w-80 bg-card border border-border rounded-xl shadow-2xl z-50 max-h-72 overflow-y-auto">
                {botCommandsLoading ? (
                  <div className="flex items-center justify-center py-6 text-muted-foreground text-xs">
                    <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin mr-2" />
                    {tr('Đang tải lệnh...')}
                  </div>
                ) : botCommands.length === 0 ? (
                  <div className="py-6 text-center text-subtle-foreground text-xs">
                    {tr('Bot này chưa có lệnh nào')}
                  </div>
                ) : (
                  <div className="py-1">
                    {botCommands
                      .filter(cmd => !text.startsWith('/') || cmd.command.toLowerCase().includes(text.slice(1).toLowerCase()))
                      .map((cmd, idx) => (
                      <button
                        key={cmd.command}
                        data-bot-cmd
                        onClick={() => handleSelectBotCommand(cmd.command)}
                        onMouseEnter={() => setBotCmdSelectedIdx(idx)}
                        className={`w-full flex items-start gap-3 px-4 py-2.5 transition-colors text-left ${idx === botCmdSelectedIdx ? 'bg-muted' : 'hover:bg-muted'}`}
                      >
                        <span className="text-blue-400 font-medium text-sm flex-shrink-0">/{cmd.command}</span>
                        <span className="text-muted-foreground text-xs mt-0.5 leading-relaxed">{cmd.description}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          </>
        )})()}
        {/* Quick message dropdown - show whenever / is typed at start (skip for bot chats) */}
        {showQuickDropdown && (
          <div className="absolute bottom-full left-3 right-3 mb-1 z-30">
            <QuickMessageDropdown
              items={quickMessages}
              filter={quickFilter}
              selectedIdx={quickSelectedIdx}
              onSelect={handleSelectQuickMessage}
              onManage={() => { setShowQuickDropdown(false); setShowQuickManager(true); }}
            />
          </div>
        )}

        {/* @ Mention dropdown: groups only; the list is read from the DB by page (scroll near the end → next page) */}
        {showMentionDropdown && mentionEnabled && (filteredMentions.length > 0 || mentionList.syncing || mentionList.searching) && (
          <div
            ref={mentionListRef}
            className="absolute bottom-full left-3 right-3 mb-1 bg-card border border-input rounded-xl shadow-2xl z-30 overflow-hidden"
            style={{ maxHeight: '15rem', overflowY: 'auto' }}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) mentionList.loadMore();
            }}
          >
            <p className="text-xs text-muted-foreground px-3 py-1.5 border-b border-border sticky top-0 bg-card z-10 flex items-center gap-2">
              <span className="min-w-0 truncate">{trx('Nhắc đến thành viên{{v1}}', { v1: mentionSearch ? ` - "${mentionSearch}"` : '' })}</span>
              {(mentionList.syncing || mentionList.searching) && (
                <span className="flex items-center gap-1 text-cyan-400 flex-shrink-0">
                  <Spinner size={3} />
                  <span className="text-[10px]">{mentionList.searching ? tr('Đang tìm trên Telegram...') : tr('Đang tải thành viên...')}</span>
                </span>
              )}
            </p>
            {filteredMentions.map((member, idx) => (
              <button
                key={member.userId}
                data-mention-idx={idx}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleSelectMention(member)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors scroll-mt-8 ${idx === mentionSelectedIdx ? 'bg-muted' : 'hover:bg-muted'}`}
              >
                {member.avatar ? (
                  <img src={member.avatar} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <PeerInitials id={member.userId} name={member.displayName} fallback="U" className="w-7 h-7 text-[10px]" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-foreground truncate">{member.displayName}</p>
                  {member.username && (
                    <p className="text-[11px] text-cyan-400 truncate">@{member.username}</p>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}

        {/* Rich-text editor (contenteditable) */}
        <div className="relative flex-1" style={{ minHeight: '2.25rem', maxHeight: '8rem' }}>
          {/* Placeholder */}
          {!text && (
            <span
              className="absolute inset-0 text-muted-foreground text-sm pointer-events-none select-none flex items-center px-0"
              style={{ top: 0 }}
            >
              {composerTarget?.placeholder || (account ? tr('Nhập @tên để tag, Shift+Enter xuống dòng, Enter gửi...') : tr('Nhập tin nhắn...'))}
            </span>
          )}
          <div
            ref={textareaRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleEditorInput}
            onKeyDown={handleEditorKeyDown}
            onKeyUp={handleEditorKeyUp}
            onMouseUp={handleEditorKeyUp}
            onPaste={handleEditorPaste}
            onCompositionStart={() => { isComposingRef.current = true; }}
            onCompositionEnd={() => {
              isComposingRef.current = false;
              // If we just sent, force-clear DOM to prevent IME from re-inserting composed text
              if (justSentRef.current && textareaRef.current) {
                textareaRef.current.innerHTML = '';
                setText('');
                prevTextRef.current = '';
              }
            }}
            className="w-full bg-transparent text-foreground text-sm focus:outline-none overflow-y-auto py-1"
            style={{ minHeight: '2rem', maxHeight: '8rem', wordBreak: 'break-word', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}
            spellCheck={false}
          />
        </div>

        {/* Emoji button, next to the like / send button */}
        <div ref={emojiPickerRef} className="relative flex-shrink-0">
          <button
            onMouseDown={(e) => { e.preventDefault(); setShowEmojiPicker(v => !v); setShowStickerPicker(false); }}
            title={tr('Biểu cảm')}
            className={`w-9 h-9 rounded-lg flex items-center justify-center text-xl transition-colors ${showEmojiPicker ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'}`}
          >
            <SmileIcon className="w-5 h-5" />
          </button>
          {showEmojiPicker && (
            isTelegramUser(activeContact?.channel) && activeAccountId ? (
              // Personal Telegram: Emoji · Sticker · GIF in one panel like Telegram (reopens on the most recently used tab)
              <TelegramMediaPicker
                accountId={activeAccountId}
                initialTab={lastTelegramPickerTab()}
                emoji={renderEmojiGrid()}
                canSendMedia={hasChatPermission}
                onPick={handleSendTelegramSticker}
                onClose={() => setShowEmojiPicker(false)}
                className="absolute bottom-12 right-0 z-30"
              />
            ) : (
              <div
                className="absolute bottom-12 right-0 bg-card border border-input rounded-2xl shadow-2xl z-30 w-80 overflow-hidden"
              >
                {/* Emoji sections - vertical scroll */}
                <div className="max-h-72 overflow-y-auto p-2">
                  {renderEmojiGrid()}
                </div>
              </div>
            )
          )}
        </div>

        {/* Send or Like */}
        {(text.trim() || clipboardImages.length > 0) ? (
          <button
            onClick={handleSend}
            disabled={sending}
            className={`flex-shrink-0 w-9 h-9 rounded-lg disabled:opacity-50 flex items-center justify-center text-white transition-colors ${isUrlOnly(text.trim()) && clipboardImages.length === 0 ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}
            title={isUrlOnly(text.trim()) && clipboardImages.length === 0 ? tr('Gửi link (Enter)') : tr('Gửi (Enter)')}
          >
            {isUrlOnly(text.trim()) && clipboardImages.length === 0 ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
                <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
              </svg>
            )}
          </button>
        ) : (
          <button
            onClick={handleSendLike}
            disabled={sending}
            className="flex-shrink-0 w-9 h-9 rounded-lg hover:bg-muted flex items-center justify-center text-blue-400 hover:text-blue-300 transition-colors text-xl"
            title={tr('Gửi 👍')}
          >
            👍
          </button>
        )}
      </div>

      {/* Merged inbox mode: shows which account the reply is from */}
      {mergedInboxMode && activeAccountId && (() => {
        const ownerAcc = allAccounts.find(a => a.zalo_id === activeAccountId);
        if (!ownerAcc) return null;
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-950/50 border-t border-blue-900/40">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400 flex-shrink-0">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
            </svg>
            <span className="text-[11px] text-muted-foreground flex-shrink-0">{tr('Đang trả lời từ:')}</span>
            {ownerAcc.avatar_url
              ? <img src={ownerAcc.avatar_url} alt="" className="w-4 h-4 rounded-full object-cover flex-shrink-0" />
              : <div className="w-4 h-4 rounded-full bg-blue-600 flex items-center justify-center text-white text-[7px] font-bold flex-shrink-0">{(ownerAcc.full_name || ownerAcc.zalo_id).charAt(0).toUpperCase()}</div>
            }
            <span className="text-[11px] text-blue-300 font-medium truncate">{ownerAcc.full_name || ownerAcc.zalo_id}</span>
          </div>
        );
      })()}

      {/* Library picker modal: opens when the image / file / video button is clicked */}
      {showLibraryPicker && activeAccountId && activeThreadId && (
        <LibraryPickerModal
          zaloId={activeAccountId}
          threadId={activeThreadId}
          threadType={activeThreadType}
          initialType={libraryPickerType}
          onClose={() => setShowLibraryPicker(false)}
          // Telegram: go into the right forum topic / comment thread (previously fell onto the main line), reply to the quoted message
          topicRootMessageId={activeTopicId || undefined}
          replyToMsgId={activeTopicId && replyTo?.msg_id ? String(replyTo.msg_id) : undefined}
          onSent={() => { if (activeTopicId && replyTo) finishReply(replyTo); }}
        />
      )}
    </div>
  );
}


// ─── Pin context menu (right-click on pinned shortcut) ───────────────────────
function PinContextMenu({ onEditIcon, onDelete, onClose }: {
  onEditIcon: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => {
      document.addEventListener('mousedown', h);
      document.addEventListener('keydown', k);
    }, 0);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [onClose]);
  return (
    <div ref={ref}
      className="absolute bottom-full left-0 mb-2 bg-card border border-border rounded-xl shadow-2xl z-50 py-1.5 w-44 overflow-hidden"
      onClick={e => e.stopPropagation()}
    >
      <button
        onClick={onEditIcon}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm text-foreground hover:bg-muted transition-colors"
      >
        <span className="text-base"><EditIcon className="w-4 h-4" /></span>
        <span>{tr('Đổi icon')}</span>
      </button>
      <div className="h-px bg-muted/60 mx-2 my-0.5" />
      <button
        onClick={onDelete}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm text-red-400 hover:bg-red-500/10 transition-colors"
      >
        <span className="text-base"><TrashIcon className="w-4 h-4" /></span>
        <span>{tr('Xóa ghim')}</span>
      </button>
    </div>
  );
}

// ─── Pin emoji picker (for editing pinned shortcut icons) ─────────────────────
const PIN_EMOJIS_TOOLBAR = [
  { id: 'cart', icon: <ShoppingCartIcon className="w-4 h-4" /> },
  { id: 'package', icon: <PackageIcon className="w-4 h-4" /> },
  { id: 'search', icon: <SearchIcon className="w-4 h-4" /> },
  { id: 'user', icon: <UserIcon className="w-4 h-4" /> },
  { id: 'clipboard', icon: <ClipboardListIcon className="w-4 h-4" /> },
  { id: 'credit', icon: <CreditCardIcon className="w-4 h-4" /> },
  { id: 'truck', icon: <TruckIcon className="w-4 h-4" /> },
  { id: 'chart', icon: <ChartIcon className="w-4 h-4" /> },
  { id: 'dollar', icon: <DollarIcon className="w-4 h-4" /> },
  { id: 'store', icon: <StoreIcon className="w-4 h-4" /> },
  { id: 'lightning', icon: <LightningIcon className="w-4 h-4" /> },
  { id: 'link', icon: <LinkIcon className="w-4 h-4" /> },
  { id: 'key', icon: <KeyIcon className="w-4 h-4" /> },
  { id: 'star', icon: <StarIcon className="w-4 h-4" /> },
  { id: 'pin', icon: <PinIcon className="w-4 h-4" /> },
  { id: 'tag', icon: <TagIcon className="w-4 h-4" /> },
  { id: 'phone', icon: <SmartphoneIcon className="w-4 h-4" /> },
  { id: 'check', icon: <CheckIcon className="w-4 h-4" /> },
  { id: 'bell', icon: <BellIcon className="w-4 h-4" /> },
  { id: 'edit', icon: <EditIcon className="w-4 h-4" /> },
  { id: 'target', icon: <TargetIcon className="w-4 h-4" /> },
  { id: 'folder', icon: <FolderIcon className="w-4 h-4" /> },
  { id: 'lightbulb', icon: <LightbulbIcon className="w-4 h-4" /> },
  { id: 'refresh', icon: <RefreshIcon className="w-4 h-4" /> },
  { id: 'trending', icon: <TrendingUpIcon className="w-4 h-4" /> },
  { id: 'gift', icon: <GiftIcon className="w-4 h-4" /> },
  { id: 'chat', icon: <ChatIcon className="w-4 h-4" /> },
  { id: 'bookmark', icon: <BookmarkIcon className="w-4 h-4" /> },
  { id: 'settings', icon: <SettingsIcon className="w-4 h-4" /> },
  { id: 'globe', icon: <GlobeIcon className="w-4 h-4" /> },
  { id: 'award', icon: <AwardIcon className="w-4 h-4" /> },
];

function PinEmojiPicker({ onSelect, onClose }: { onSelect: (icon: string) => void; onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  return (
    <div ref={ref}
      className="absolute bottom-full right-0 mb-2 bg-card border border-input rounded-xl shadow-2xl z-50 p-3 w-64"
      onClick={e => e.stopPropagation()}
    >
      <p className="text-[11px] text-muted-foreground mb-2 font-medium">{tr('Chọn icon:')}</p>
      <div className="grid grid-cols-8 gap-0.5">
        {PIN_EMOJIS_TOOLBAR.map(item => (
          <button key={item.id} onClick={() => onSelect(item.id)}
            className="w-10 h-10 flex items-center justify-center rounded hover:bg-muted transition-colors">
            {item.icon}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Toolbar button ───────────────────────────────────────────────────────────
const ToolbarBtn = React.forwardRef<HTMLButtonElement, {
  children: React.ReactNode; onClick: (e: React.MouseEvent) => void;
  title?: string; disabled?: boolean; active?: boolean;
  onContextMenu?: (e: React.MouseEvent) => void;
}>(({ children, onClick, title, disabled, active, onContextMenu }, ref) => {
  return (
    <button
      ref={ref}
      onClick={onClick}
      disabled={disabled}
      title={title}
      onContextMenu={onContextMenu}
      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 disabled:cursor-not-allowed
        ${active ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
    >
      {children}
    </button>
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isImageMsg(msgType: string, content: string): boolean {
  // Exclude msgTypes that are not images
  if (['share.file', 'share.link', 'file', 'chat.voice'].includes(msgType)) return false;

  if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') return true;

  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      // Parse params
      let paramsObj = parsed.params;
      if (typeof paramsObj === 'string') {
        try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
      }

      // If there is a title + href but NO image params (hd/rawUrl) → this is a link/file
      if (parsed.title && parsed.href) {
        const hasImageParams = !!(paramsObj?.hd || paramsObj?.rawUrl);
        if (!hasImageParams) return false;
      }

      // Has image params or thumb or href (no title) → image
      return !!(paramsObj?.hd || paramsObj?.rawUrl || parsed.thumb || (parsed.href && !parsed.title));
    }
  } catch {}
  return false;
}

function extractReplyImages(content: string, attachments?: string): string[] {
  const urls: string[] = [];
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object') {
      const url = parsed.params?.hd || parsed.params?.rawUrl || parsed.href || parsed.thumb || '';
      if (url) urls.push(url);
    }
  } catch {}
  if (urls.length === 0 && attachments) {
    try {
      const atts = JSON.parse(attachments);
      if (Array.isArray(atts)) {
        for (const a of atts) {
          const u = a.params?.hd || a.params?.rawUrl || a.href || a.thumb || a.url || '';
          if (u) urls.push(u);
        }
      }
    } catch {}
  }
  return urls;
}

function parseReplyContent(content: string, msgType?: string, channel?: string, attachments?: unknown): string {
  // Telegram: video / sticker / voice / file… with no text (or only the text the app sets itself) → a label of the right type, like the quote frame
  // in the bubble (telegramQuoteMedia); previously it showed "[Tin nhắn]" ([Message])
  if (isTelegram(channel)) {
    const media = telegramQuoteMedia(msgType, attachments);
    if (media && (!content || content === 'null' || isTelegramQuotePlaceholder(content))) return media.label;
  }
  if (!content || content === 'null') return tr('[Tin nhắn]');

  // Prefer msgType if there is one
  if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') return tr('[Hình ảnh]');
  if (msgType === 'chat.sticker') return '[Sticker]';
  if (msgType === 'chat.video.msg') return '[Video]';
  if (msgType === 'chat.voice') return tr('[Ghi âm]');
  if (msgType === 'chat.poll') return tr('[Bình chọn]');
  if (msgType === 'chat.webcontent') {
    try { if (JSON.parse(content)?.action === 'zinstant.bankcard') return tr('🏦 [Tài khoản ngân hàng]'); } catch {}
  }
  if (msgType === 'chat.location.new') return tr('📍 [Vị trí]');

  // For share.file / share.link: parse content to get the title
  if (msgType === 'share.file' || msgType === 'share.link' || msgType === 'file') {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.title) {
        return `📎 ${parsed.title}`;
      }
    } catch {}
    return msgType === 'share.link' ? '[Link]' : '[File]';
  }

  // Parse content to determine the type
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed !== 'object' || !parsed) return String(parsed);

    // Parse params if there are any
    let paramsObj = parsed.params;
    if (typeof paramsObj === 'string') {
      try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
    }

    // 1. Check text messages first
    if (parsed?.content && typeof parsed.content === 'string') return parsed.content;
    if (parsed?.msg && typeof parsed.msg === 'string') return parsed.msg;

    // 2. Check LINK/FILE: has title + href but NO params.hd/rawUrl
    if (parsed.title && parsed.href) {
      const hasImageParams = !!(paramsObj?.hd || paramsObj?.rawUrl);
      if (!hasImageParams) {
        return `📎 ${parsed.title}`;
      }
    }

    // 3. Check IMAGE: has params.hd/rawUrl or thumb
    const hasImageData = !!(paramsObj?.hd || paramsObj?.rawUrl || parsed.thumb || (parsed.href && !parsed.title));
    if (hasImageData) {
      return tr('[Hình ảnh]');
    }

    return tr('[Tin nhắn]');
  } catch { return content; }
}

// ─── StickerPicker ────────────────────────────────────────────────────────────
type StickerDetail = {
  id: number;
  cateId?: number;
  catId?: number;
  type?: number;
  text?: string;
  stickerUrl?: string;
  stickerSpriteUrl?: string;
  checksum?: string;
};

type StickerPack = {
  catId: number;
  name: string;
  thumbUrl: string;
  stickerCount: number;
  stickers?: StickerDetail[];
};

// Popular Vietnamese keywords to seed the sticker store
const STICKER_SEED_KEYWORDS = ['haha', 'buồn', 'yêu', 'vui', 'hi', 'ok', 'cảm ơn', 'chúc mừng', 'giận', 'ngủ'];

function StickerPicker({
  getAuth,
  onSelect,
  onClose,
  onInsertEmoji,
}: {
  getAuth: () => any;
  onSelect: (sticker: StickerDetail) => void;
  onClose: () => void;
  onInsertEmoji?: (emoji: string) => void;
}) {
  const [tab, setTab] = useState<'recent' | 'store' | 'search' | 'emoji'>('recent');
  const [keyword, setKeyword] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<StickerDetail[]>([]);
  const [recentStickers, setRecentStickers] = useState<StickerDetail[]>([]);
  const pickerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Store state
  const [packs, setPacks] = useState<StickerPack[]>([]);
  const [activePackId, setActivePackId] = useState<number | null>(null);
  const [packStickers, setPackStickers] = useState<StickerDetail[]>([]);
  const [loadingStore, setLoadingStore] = useState(false);
  const [loadingPack, setLoadingPack] = useState(false);
  const [storeError, setStoreError] = useState('');

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [onClose]);

  // Load recent stickers on open
  useEffect(() => {
    DataAccessor.getRecentStickers(30).then((res) => {
      if (res?.success && res.stickers?.length) setRecentStickers(res.stickers);
    }).catch(() => {});
  }, []);

  // Load sticker packs from DB cache on open (build from cached stickers)
  useEffect(() => {
    loadPacksFromDb();
  }, []);

  /** Load pack list from DB (sticker_packs + cached pack summaries) */
  const loadPacksFromDb = async () => {
    try {
      // Try sticker_packs first
      const res = await DataAccessor.getStickerPacks?.();
      if (res?.success && res.packs?.length) {
        setPacks(res.packs);
        return;
      }
      // Fallback: build from cached stickers grouped by cat_id
      const sumRes = await DataAccessor.getAllCachedPackSummaries?.();
      if (sumRes?.success && sumRes.packs?.length) {
        const builtPacks: StickerPack[] = sumRes.packs.map((p) => ({
          catId: p.catId,
          name: tr('Gói {{catId}}', { catId: p.catId }),
          thumbUrl: p.thumbUrl,
          stickerCount: p.count,
        }));
        setPacks(builtPacks);
      }
    } catch {}
  };

  // Switch to search tab when keyword is entered
  useEffect(() => {
    if (keyword.trim()) {
      setTab('search');
    }
  }, [keyword]);

  // Debounced search with keyword_stickers caching
  // >2 chars + 1s pause → check DB cache → if miss, call API → save keyword mapping + sticker details
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const kw = keyword.trim();
    if (!kw) { setSearchResults([]); return; }

    // Short keywords (<3 chars): no search
    if (kw.length < 3) {
      setSearchResults([]);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        // Step 1: Check keyword_stickers cache
        const cacheRes = await DataAccessor.getKeywordStickers(kw);
        if (cacheRes?.success && cacheRes.stickerIds?.length) {
          // Cache hit - load sticker details from stickers DB table
          const detailRes = await DataAccessor.getStickers({ stickerIds: cacheRes.stickerIds.slice(0, 30) });
          if (detailRes?.success && detailRes.stickers?.length) {
            setSearchResults(detailRes.stickers);
            setSearching(false);
            return;
          }
          // If stickers not in DB yet (edge case), fall through to API
        }

        // Step 2: Cache miss → call Zalo API
        const auth = getAuth();
        if (!auth) { setSearchResults([]); setSearching(false); return; }

        const idsRes = await ipc.zalo?.getStickers({ auth, keyword: kw });
        const ids: number[] = idsRes?.response || [];
        if (!ids.length) { setSearchResults([]); setSearching(false); return; }

        // Save keyword → stickerIds mapping
        DataAccessor.saveKeywordStickers?.({ keyword: kw, stickerIds: ids }).catch(() => {});

        // Step 3: Get sticker details
        const detailRes = await ipc.zalo?.getStickersDetail({ auth, stickerIds: ids.slice(0, 30) });
        const stickers: StickerDetail[] = detailRes?.response || [];
        setSearchResults(stickers);

        // Save ALL stickers to DB cache (cho kho sticker)
        if (stickers.length) {
          DataAccessor.saveStickers({ stickers }).catch(() => {});

          // Discover new packs from these stickers and save them
          discoverAndSavePacks(stickers, auth);
        }
      } catch {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 1000); // 1 second debounce

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [keyword]);

  /** Discover packs from stickers and save to DB + state */
  const discoverAndSavePacks = async (stickers: StickerDetail[], auth: any) => {
    try {
      const cateMap = new Map<number, StickerDetail[]>();
      for (const s of stickers) {
        const cid = s.cateId ?? s.catId ?? 0;
        if (cid === 0) continue;
        if (!cateMap.has(cid)) cateMap.set(cid, []);
        cateMap.get(cid)!.push(s);
      }

      const existingIds = new Set(packs.map((p) => p.catId));
      const newPacks: StickerPack[] = [];

      for (const [cateId, catStickers] of cateMap) {
        if (existingIds.has(cateId)) continue;
        newPacks.push({
          catId: cateId,
          name: tr('Gói {{cateId}}', { cateId }),
          thumbUrl: catStickers[0]?.stickerUrl || '',
          stickerCount: catStickers.length,
        });
      }

      if (newPacks.length) {
        DataAccessor.saveStickerPacks?.({ packs: newPacks }).catch(() => {});
        setPacks((prev) => {
          const ids = new Set(prev.map((p) => p.catId));
          return [...prev, ...newPacks.filter((p) => !ids.has(p.catId))];
        });
      }
    } catch {}
  };

  // Fetch sticker store using popular keywords (seed)
  const fetchStickerStore = async () => {
    const auth = getAuth();
    if (!auth) { setStoreError(tr('Chưa kết nối tài khoản')); return; }
    setLoadingStore(true);
    setStoreError('');
    try {
      const allStickers: StickerDetail[] = [];
      const allPacks: StickerPack[] = [];
      const seenCateIds = new Set<number>();

      // Fetch stickers for each seed keyword
      for (let i = 0; i < STICKER_SEED_KEYWORDS.length; i++) {
        const kw = STICKER_SEED_KEYWORDS[i];
        try {
          // Check keyword cache first
          let ids: number[] = [];
          const cacheRes = await DataAccessor.getKeywordStickers(kw);
          if (cacheRes?.success && cacheRes.stickerIds?.length) {
            ids = cacheRes.stickerIds;
          } else {
            // Call API
            const idsRes = await ipc.zalo?.getStickers({ auth, keyword: kw });
            ids = idsRes?.response || [];
            // Cache keyword → stickerIds
            if (ids.length) {
              DataAccessor.saveKeywordStickers?.({ keyword: kw, stickerIds: ids }).catch(() => {});
            }
          }

          if (!ids.length) continue;

          // Get sticker details (try DB first, then API for missing ones)
          let stickers: StickerDetail[] = [];
          const dbRes = await DataAccessor.getStickers({ stickerIds: ids.slice(0, 30) });
          if (dbRes?.success && dbRes.stickers?.length >= ids.slice(0, 30).length * 0.8) {
            // Most stickers already in DB
            stickers = dbRes.stickers;
          } else {
            // Fetch from API
            const detailRes = await ipc.zalo?.getStickersDetail({ auth, stickerIds: ids.slice(0, 30) });
            stickers = detailRes?.response || [];
            // Save to DB
            if (stickers.length) {
              DataAccessor.saveStickers({ stickers }).catch(() => {});
            }
          }

          allStickers.push(...stickers);

          // Discover packs
          for (const s of stickers) {
            const cid = s.cateId ?? s.catId ?? 0;
            if (cid === 0 || seenCateIds.has(cid)) continue;
            seenCateIds.add(cid);
            allPacks.push({
              catId: cid,
              name: tr('Gói {{cid}}', { cid }),
              thumbUrl: s.stickerUrl || '',
              stickerCount: stickers.filter((x) => (x.cateId ?? x.catId ?? 0) === cid).length,
            });
          }
        } catch {
          // Skip failed keyword
        }

        // Throttle: 500ms delay between keywords
        if (i < STICKER_SEED_KEYWORDS.length - 1) {
          await new Promise((r) => setTimeout(r, 500));
        }
      }

      if (allStickers.length === 0) {
        setStoreError(tr('Không tìm thấy sticker. Thử lại sau.'));
        setLoadingStore(false);
        return;
      }

      // For each discovered pack, try to fetch full category details (max 10)
      const packsToFetchDetail = allPacks.slice(0, 10);
      for (let i = 0; i < packsToFetchDetail.length; i++) {
        const pack = packsToFetchDetail[i];
        try {
          // Check if we already have enough stickers for this pack in DB
          const dbPack = await DataAccessor.getStickersByPackId(pack.catId);
          if (dbPack?.success && dbPack.stickers?.length >= 5) {
            pack.stickerCount = dbPack.stickers.length;
            pack.thumbUrl = dbPack.stickers[0]?.stickerUrl || pack.thumbUrl;
            continue;
          }

          const catRes = await ipc.zalo?.getStickerCategoryDetail({ auth, cateId: pack.catId });
          const catStickers: StickerDetail[] = catRes?.response || [];
          if (catStickers.length > 0) {
            DataAccessor.saveStickers({ stickers: catStickers }).catch(() => {});
            pack.stickerCount = catStickers.length;
            pack.thumbUrl = catStickers[0]?.stickerUrl || pack.thumbUrl;
          }
        } catch {}

        if (i < packsToFetchDetail.length - 1) {
          await new Promise((r) => setTimeout(r, 300));
        }
      }

      // Save packs to DB and update state
      if (allPacks.length) {
        DataAccessor.saveStickerPacks?.({ packs: allPacks }).catch(() => {});
        setPacks(allPacks);
      }
    } catch (err: any) {
      setStoreError(tr('Lỗi tải kho sticker'));
    } finally {
      setLoadingStore(false);
    }
  };

  // Load stickers for a specific pack
  const loadPackStickers = async (catId: number) => {
    setActivePackId(catId);
    setPackStickers([]);
    setLoadingPack(true);

    // Try from DB cache first
    try {
      const dbRes = await DataAccessor.getStickersByPackId(catId);
      if (dbRes?.success && dbRes.stickers?.length) {
        setPackStickers(dbRes.stickers);
        setLoadingPack(false);
        return;
      }
    } catch {}

    // Fetch from API
    const auth = getAuth();
    if (!auth) { setLoadingPack(false); return; }
    try {
      const catRes = await ipc.zalo?.getStickerCategoryDetail({ auth, cateId: catId });
      const stickers: StickerDetail[] = catRes?.response || [];
      setPackStickers(stickers);
      if (stickers.length) {
        DataAccessor.saveStickers({ stickers }).catch(() => {});
      }
    } catch {
      setPackStickers([]);
    } finally {
      setLoadingPack(false);
    }
  };

  // Auto-fetch store if no cached packs
  useEffect(() => {
    if (tab === 'store' && packs.length === 0 && !loadingStore) {
      fetchStickerStore();
    }
  }, [tab]);

  const mainTabs = [
    { key: 'recent' as const, label: <>{trx('<0/> Gần đây', { 0: <ClockIcon className="w-3.5 h-3.5 mr-2" /> })}</> },
    { key: 'store' as const, label: <>{trx('<0/> Kho sticker', { 0: <StoreIcon className="w-3.5 h-3.5 mr-2" /> })}</> },
    { key: 'emoji' as const, label: <>{trx('<0/> Emoji', { 0: <SmileIcon className="w-3.5 h-3.5 mr-2" /> })}</> },
  ];

  return (
    <div
      ref={pickerRef}
      className="absolute bottom-12 left-0 w-96 bg-card border border-input rounded-2xl shadow-2xl z-30 flex flex-col overflow-hidden"
      style={{ maxHeight: '27.5rem' }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Tabs */}
      <div className="flex border-b border-border flex-shrink-0">
        {mainTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); if (t.key === 'recent' || t.key === 'store' || t.key === 'emoji') setKeyword(''); }}
            className={`flex-1 py-2 text-[11px] font-semibold tracking-wide transition-colors place-content-center flex ${
              (tab === t.key || (tab === 'search' && t.key === 'recent'))
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Search input (always visible except emoji tab) */}
      {tab !== 'emoji' && (
        <div className="px-3 py-2 flex-shrink-0">
          <div className="flex items-center gap-2 bg-muted rounded-lg px-3 py-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              autoFocus
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder={tr('Tìm kiếm sticker...')}
              className="flex-1 bg-transparent text-sm text-foreground placeholder-subtle-foreground focus:outline-none"
            />
            {keyword && (
              <button onClick={() => { setKeyword(''); setTab('recent'); }} className="text-muted-foreground hover:text-foreground text-sm">✕</button>
            )}
          </div>
        </div>
      )}

      {/* Tab content */}
      {tab === 'search' ? (
        /* Search results */
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {searching ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-2" />
              <span className="text-xs">{tr('Đang tìm kiếm...')}</span>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-xs">
              {tr('😕 Không tìm thấy sticker')}
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground px-1 py-1.5 font-medium">{trx('Kết quả tìm kiếm ({{count}})', { count: searchResults.length })}</p>
              <div className="grid grid-cols-5 gap-1.5">
                {searchResults.map((s) => (
                  <StickerItem key={s.id} sticker={s} onSelect={onSelect} />
                ))}
              </div>
            </>
          )}
        </div>
      ) : tab === 'recent' ? (
        /* Recent stickers */
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {recentStickers.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-xs text-center">
              {trx('<0>🎭</0>Chưa có sticker nào gần đây<1/>Hãy tìm kiếm hoặc mở kho sticker', { 0: <span className="text-3xl mb-2" />, 1: <br/> })}
            </div>
          ) : (
            <>
              <p className="text-xs text-muted-foreground px-1 py-1.5 font-medium">{tr('Gần đây')}</p>
              <div className="grid grid-cols-5 gap-1.5">
                {recentStickers.map((s) => (
                  <StickerItem key={s.id} sticker={s} onSelect={onSelect} />
                ))}
              </div>
            </>
          )}
        </div>
      ) : tab === 'store' ? (
        /* Sticker Store */
        <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
          {loadingStore ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
              <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-2" />
              <span className="text-xs">{tr('Đang tải kho sticker...')}</span>
            </div>
          ) : storeError && packs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-xs gap-2">
              <span><AlertIcon className="w-4 h-4 inline" /> {storeError}</span>
              <button
                onClick={fetchStickerStore}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs transition-colors"
              >
                {tr('Thử lại')}
              </button>
            </div>
          ) : packs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-muted-foreground text-xs gap-2">
              <StoreIcon className="w-8 h-8 mb-1 opacity-40" />
              <span>{tr('Chưa có gói sticker nào')}</span>
              <button
                onClick={fetchStickerStore}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs transition-colors"
              >
                {tr('Tải kho sticker')}
              </button>
            </div>
          ) : (
            <>
              {/* Pack list - horizontal scroll */}
              <div className="flex gap-1 px-2 py-2 overflow-x-auto flex-shrink-0 border-b border-border/50"
                   onWheel={e => {
                     // Convert vertical wheel to horizontal scroll so mouse wheel works naturally
                     if (e.deltaY !== 0) {
                       e.preventDefault();
                       e.currentTarget.scrollBy({ left: e.deltaY, behavior: 'auto' });
                     }
                   }}>
                {packs.map((pack) => (
                  <button
                    key={pack.catId}
                    onClick={() => loadPackStickers(pack.catId)}
                    className={`flex-shrink-0 w-12 h-12 rounded-xl overflow-hidden border-2 transition-all hover:scale-105 ${
                      activePackId === pack.catId
                        ? 'border-blue-400 shadow-lg shadow-blue-500/20'
                        : 'border-transparent hover:border-border-strong'
                    }`}
                    title={pack.name || tr('Gói {{catId}}', { catId: pack.catId })}
                  >
                    {pack.thumbUrl ? (
                      <img
                        src={pack.thumbUrl}
                        alt={pack.name}
                        className="w-full h-full object-contain bg-muted/50"
                        loading="lazy"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-full h-full bg-muted/50 flex items-center justify-center text-lg">🎭</div>
                    )}
                  </button>
                ))}
                {/* Refresh button */}
                <button
                  onClick={fetchStickerStore}
                  disabled={loadingStore}
                  className="flex-shrink-0 w-12 h-12 rounded-xl border-2 border-dashed border-input hover:border-border-strong flex items-center justify-center text-muted-foreground hover:text-foreground/80 transition-all"
                  title={tr('Cập nhật kho sticker')}
                >
                  {loadingStore ? (
                    <div className="w-4 h-4 border-2 border-border-strong border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                      <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
                    </svg>
                  )}
                </button>
              </div>

              {/* Pack stickers grid */}
              <div className="flex-1 overflow-y-auto px-2 pb-2">
                {activePackId === null ? (
                  <div className="flex flex-col items-center justify-center py-6 text-muted-foreground text-xs">
                    {trx('<0>👆</0>Chọn một gói sticker ở trên', { 0: <span className="text-2xl mb-2" /> })}
                  </div>
                ) : loadingPack ? (
                  <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
                    <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-2" />
                    <span className="text-xs">{tr('Đang tải...')}</span>
                  </div>
                ) : packStickers.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 text-muted-foreground text-xs">
                    {tr('Gói sticker này trống hoặc không hỗ trợ')}
                  </div>
                ) : (
                  <div className="grid grid-cols-5 gap-1.5 pt-2">
                    {packStickers.map((s) => (
                      <StickerItem key={s.id} sticker={s} onSelect={onSelect} />
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        /* Emoji tab */
        <div className="flex-1 overflow-y-auto p-2 space-y-3">
          {Object.entries(EMOJI_CATEGORIES).map(([category, emojis]) => (
            <div key={category}>
              <p className="text-[11px] text-muted-foreground font-medium mb-1.5 px-1">{category}</p>
              <div className="grid grid-cols-6 gap-1">
                {emojis.map((emoji, idx) => (
                  <button
                    key={`${category}-${emoji}-${idx}`}
                    onClick={() => { onInsertEmoji?.(emoji); onClose(); }}
                    className="text-xl hover:bg-muted rounded-lg p-1 transition-colors aspect-square flex items-center justify-center"
                    title={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Single sticker item in grid */
function StickerItem({ sticker, onSelect }: { sticker: StickerDetail; onSelect: (s: StickerDetail) => void }) {
  return (
    <button
      onClick={() => onSelect(sticker)}
      className="aspect-square rounded-xl hover:bg-muted flex items-center justify-center overflow-hidden transition-colors p-0.5"
      title={sticker.text || String(sticker.id)}
    >
      {sticker.stickerUrl ? (
        <img
          src={sticker.stickerUrl}
          alt={sticker.text || ''}
          className="w-full h-full object-contain"
          loading="lazy"
          onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
        />
      ) : (
        <span className="text-2xl">🎭</span>
      )}
    </button>
  );
}

// ─── Format Bar Button ────────────────────────────────────────────────────────
function FmtBtn({ children, active, onClick, title }: {
  children: React.ReactNode;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      title={title}
      className={`w-7 h-7 rounded flex items-center justify-center transition-colors ${
        active ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      }`}
    >
      {children}
    </button>
  );
}

// ─── MoreMenuDropdown ─────────────────────────────────────────────────────────
function MoreMenuDropdown({ isGroup, onCreatePoll, onCreateNote, onCreateReminder, onOpenIntegration, onClose, supportsPoll, supportsReminder }: {
  isGroup: boolean;
  onCreatePoll: () => void;
  onCreateNote: () => void;
  onCreateReminder: () => void;
  onOpenIntegration: () => void;
  onClose: () => void;
  supportsPoll?: boolean;
  supportsReminder?: boolean;
}) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => {
      document.addEventListener('mousedown', h);
      document.addEventListener('keydown', k);
    }, 0);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [onClose]);

  const groupItems = [
    {
      icon: <ChartIcon className="w-4 h-4" />,
      label: tr('Tạo bình chọn'),
      sublabel: tr('Khảo sát ý kiến nhóm'),
      color: 'text-blue-400',
      onClick: onCreatePoll,
    },
    {
      icon: <FileTextIcon className="w-4 h-4" />,
      label: tr('Tạo ghi chú'),
      sublabel: tr('Ghim thông tin quan trọng'),
      color: 'text-orange-400',
      onClick: onCreateNote,
    },
  ];

  const reminderItem = {
    icon: <ClockIcon className="w-4 h-4" />,
    label: tr('Tạo nhắc hẹn'),
    sublabel: isGroup ? tr('Nhắc nhở lịch nhóm') : tr('Nhắc nhở trong hội thoại'),
    color: 'text-green-400',
    onClick: onCreateReminder,
  };

  const integrationItem = {
    icon: <PluginIcon className="w-4 h-4" />,
    label: tr('Tích hợp nhanh'),
    sublabel: tr('Tra cứu đơn, sản phẩm, vận chuyển...'),
    color: 'text-purple-400',
    onClick: onOpenIntegration,
  };

  const noteItem = {
    icon: <FileTextIcon className="w-4 h-4" />,
    label: tr('Ghi chú'),
    sublabel: isGroup ? tr('Ghi chú nhóm & local') : tr('Ghi chú local'),
    color: 'text-orange-400',
    onClick: onCreateNote,
  };

  const items = isGroup
    ? [supportsPoll !== false && groupItems[0], noteItem, supportsReminder !== false && reminderItem, integrationItem].filter(Boolean)
    : [noteItem, supportsReminder !== false && reminderItem, integrationItem].filter(Boolean);

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 mb-2 bg-card border border-border rounded-2xl shadow-2xl z-50 w-56 py-2 overflow-hidden"
    >
      <p className="text-[11px] text-muted-foreground px-4 pt-1 pb-2 font-medium uppercase tracking-wide">
        {isGroup ? tr('Tính năng nhóm') : tr('Tính năng')}
      </p>
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.onClick}
          className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/70 cursor-pointer"
        >
          <span className={`flex-shrink-0 ${item.color}`}>{item.icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">{item.label}</p>
            <p className="text-[11px] text-muted-foreground leading-tight">{item.sublabel}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

// ─── ShortcutsPopup ──────────────────────────────────────────────────────────
function ShortcutsPopup({ onClose }: { onClose: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    setTimeout(() => {
      document.addEventListener('mousedown', h);
      document.addEventListener('keydown', k);
    }, 0);
    return () => {
      document.removeEventListener('mousedown', h);
      document.removeEventListener('keydown', k);
    };
  }, [onClose]);

  const SHORTCUTS = [
    { key: 'Ctrl + Tab', desc: tr('Giữ để chuyển đổi nick nhanh') },
    { key: 'Tab', desc: tr('Chuyển đến hội thoại tiếp theo') },
    { key: 'Shift + Tab', desc: tr('Chuyển đến hội thoại trước đó') },
    { key: 'Ctrl + P', desc: tr('Ghim / bỏ ghim hội thoại trong app') },
    { key: 'Ctrl + K', desc: tr('Tìm kiếm hội thoại') },
    { key: 'Ctrl + F', desc: tr('Tìm kiếm tin nhắn trong hội thoại') },
    { key: 'Ctrl + N', desc: tr('Tạo ghi chú nội bộ') },
    { key: 'Ctrl + S', desc: tr('Mở trợ lý AI') },
    { key: 'Ctrl + I', desc: tr('Mở thông tin hội thoại') },
    { key: 'Ctrl + T', desc: tr('Ẩn / hiện danh sách tag nhanh') },
  ] as const;

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 mb-2 bg-card border border-border rounded-2xl shadow-2xl z-50 w-72 py-3 px-4"
    >
      <p className="text-[11px] text-muted-foreground font-medium uppercase tracking-wide mb-3">
        {tr('Phím tắt hội thoại')}
      </p>
      <div className="flex flex-col gap-1.5">
        {SHORTCUTS.map(sc => (
          <div key={sc.key} className="flex items-center justify-between gap-4">
            <span className="text-xs text-muted-foreground">{sc.desc}</span>
            <kbd className="flex-shrink-0 text-[11px] font-mono px-2 py-1 rounded-md bg-muted text-foreground border border-input leading-none">
              {sc.key}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  );
}
