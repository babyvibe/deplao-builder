import React, {useCallback, useEffect, useLayoutEffect, useRef, useState} from 'react';
import {useChatStore} from '@/store/chatStore';
import {useAccountStore} from '@/store/accountStore';
import {useAppStore} from '@/store/appStore';
import ipc from '@/lib/ipc';
import {SendCardModal} from './GroupModals';
import {CreatePollDialog, NoteViewModal} from './ChatWindow';
import BankCardModal from './BankCardModal';
import {
  fetchQuickMessages,
  invalidateZaloQuickMessageCache,
  QuickMessage,
  QuickMessageDropdown,
  QuickMessageManagerPanel,
} from './QuickMessageManager';
import ReminderPanel from './ReminderPanel';
import { matchesShortcut } from '../common/LabelEmojiPicker';
import { getCapability } from '../../../configs/channelConfig';
import * as channelIpc from '../../lib/channelIpc';

interface LocalLabel {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  emoji?: string;
  sort_order?: number;
  shortcut?: string;
}

/**
 * Dùng HTMLVideoElement + Canvas để capture frame video làm thumbnail.
 * Trả về base64 JPEG data URL, hoặc '' nếu thất bại.
 */
async function extractVideoThumbViaCanvas(videoPath: string, seekSec = 1): Promise<string> {
  // Helper: capture frame từ video element tại currentTime
  const captureFrame = (vid: HTMLVideoElement): string => {
    const canvas = document.createElement('canvas');
    const maxW = 480;
    const vw = vid.videoWidth || 480;
    const vh = vid.videoHeight || 270;
    const ratio = maxW / vw;
    canvas.width = maxW;
    canvas.height = Math.round(vh * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.drawImage(vid, 0, 0, canvas.width, canvas.height);
    // Kiểm tra frame có phải toàn đen không (sample 20x20 pixel ở giữa)
    try {
      const cx = Math.floor(canvas.width / 2) - 10;
      const cy = Math.floor(canvas.height / 2) - 10;
      const id = ctx.getImageData(cx, cy, 20, 20);
      const allBlack = Array.from(id.data).every((v, i) => i % 4 === 3 || v < 15);
      if (allBlack) return '__BLACK__';
    } catch { /* ignore */ }
    return canvas.toDataURL('image/jpeg', 0.85);
  };

  const loadAndSeek = (src: string, t: number): Promise<string> =>
    new Promise((resolve) => {
      const vid = document.createElement('video');
      vid.muted = true;
      vid.preload = 'metadata';
      vid.src = src;
      let resolved = false;
      const done = (val: string) => { if (!resolved) { resolved = true; vid.src = ''; resolve(val); } };
      vid.onerror = () => done('');
      vid.onloadedmetadata = () => {
        // Clamp seek time to [0, duration-0.1]
        vid.currentTime = Math.max(0, Math.min(t, (vid.duration || 1) - 0.1));
      };
      vid.onseeked = () => { done(captureFrame(vid)); };
      // Timeout 8s
      setTimeout(() => done(''), 8000);
      vid.load();
    });

  const fileUrl = videoPath.startsWith('file://')
    ? videoPath
    : `file:///${videoPath.replace(/\\/g, '/')}`;

  // Thử seek tại seekSec trước
  let result = await loadAndSeek(fileUrl, seekSec);
  // Nếu frame đen và seekSec > 0, thử lại tại 0s
  if ((result === '__BLACK__' || result === '') && seekSec > 0) {
    result = await loadAndSeek(fileUrl, 0);
  }
  return result === '__BLACK__' ? '' : (result || '');
}

// Extended emoji categories for the emoji picker
const EMOJI_CATEGORIES = {
  'Phổ biến': ['😊', '😂', '❤️', '👍', '😮', '😢', '😡', '🔥', '👋', '🙏', '✌️', '😍', '😎', '🥰', '😜', '🤩', '😭', '🤗', '😇', '🤔', '😤', '🥳', '💪', '✅', '🎉', '💯', '🚀', '⭐', '🌈', '💙'],
  'Cảm xúc': ['😀', '😃', '😄', '😁', '😆', '🥹', '😅', '🤣', '🥲', '☺️', '😋', '😛', '😝', '🤑', '🤭', '🤫', '🤐', '🤨', '😏', '😒', '🙄', '😬', '😮‍💨', '🤥', '🙂', '😌', '😔', '😪', '🤤', '😴'],
  'Trái tim': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '❤️‍🔥', '❤️‍🩹', '💑', '💏', '🫂', '💋', '🫶', '🤲', '🙌', '👏', '🤝'],
  'Tay & Cử chỉ': ['👍', '👎', '👊', '✊', '🤛', '🤜', '🤞', '✌️', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👋', '🤚', '🖐️', '✋', '🖖', '💪', '🦾', '🙏', '✍️', '🤳', '💅', '🤌', '👌', '🫰'],
  'Động vật': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧', '🐦', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🦋', '🐌'],
  'Đồ ăn': ['🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🫐', '🍒', '🍑', '🥭', '🍍', '🥥', '🥝', '🍔', '🍕', '🌭', '🍟', '🍗', '🥩', '🍣', '🍜', '🍝', '🍰', '🎂', '🍩', '🍪', '☕', '🍺', '🥂'],
  'Hoạt động': ['⚽', '🏀', '🏈', '⚾', '🎾', '🏐', '🎱', '🏓', '🏸', '🥊', '🎯', '🎮', '🎲', '🎭', '🎨', '🎬', '🎤', '🎧', '🎵', '🎹', '🥇', '🏆', '🏅', '🎖️', '🎗️', '🎟️', '🎪', '🎠', '🎡', '🎢'],
  'Du lịch': ['✈️', '🚗', '🚕', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🏍️', '🚲', '🛵', '🚀', '🛸', '🚁', '⛵', '🚢', '⛺', '🏠', '🏢', '🏰', '🗼', '🗽', '⛩️', '🕌', '🛕', '⛪'],
  'Đồ vật': ['⌚', '📱', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '💿', '📷', '📹', '🎥', '📞', '☎️', '📺', '📻', '🎙️', '⏰', '⏱️', '⏲️', '🕰️', '💡', '🔦', '🏮', '📦', '💰', '💳', '💎', '⚖️', '🔧', '🔨'],
  'Biểu tượng': ['✨', '⚡', '🌟', '💫', '💥', '💢', '💦', '💨', '🕳️', '💣', '💬', '👁️‍🗨️', '🗯️', '💭', '💤', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '🟤', '⚫', '⚪', '🔶', '🔷', '🔸', '🔹', '▶️', '⏩'],
};

// Flat array for backward compatibility
const QUICK_EMOJIS = Object.values(EMOJI_CATEGORIES).flat();

export default function MessageInput() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [showSendCard, setShowSendCard] = useState(false);
  const [showBankCard, setShowBankCard] = useState(false);
  const [showCreatePoll, setShowCreatePoll] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const [showCreateNote, setShowCreateNote] = useState(false);
  const [showFormatBar, setShowFormatBar] = useState(false);
  // Format ranges: mỗi entry = { start, len, st } — theo chuẩn zca-js Style[]
  const [fmtRanges, setFmtRanges] = useState<Array<{ start: number; len: number; st: string }>>([]);
  // Active fmts tại cursor (để highlight toolbar buttons)
  const [activeFmts, setActiveFmts] = useState<Set<string>>(new Set());
  // Quick message states
  const [quickMessages, setQuickMessages] = useState<QuickMessage[]>([]);
  const [showQuickDropdown, setShowQuickDropdown] = useState(false);
  const [quickFilter, setQuickFilter] = useState('');
  const [quickSelectedIdx, setQuickSelectedIdx] = useState(0);
  const [quickTriggerPos, setQuickTriggerPos] = useState(-1);
  const [showQuickManager, setShowQuickManager] = useState(false);
  const [showReminderPopup, setShowReminderPopup] = useState(false);
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
  const [mentions, setMentions] = useState<Array<{ uid: string; pos: number; len: number }>>([]);
  // Clipboard images state: {id, dataUrl, blob}[]
  const [clipboardImages, setClipboardImages] = useState<Array<{ id: string; dataUrl: string; blob: Blob }>>([]);
  const [localLabels, setLocalLabels] = useState<LocalLabel[]>([]);
  const [threadLocalLabelIds, setThreadLocalLabelIds] = useState<Set<number>>(new Set());
  const [togglingLocalLabelId, setTogglingLocalLabelId] = useState<number | null>(null);
  // Pinned shortcut: id of shortcut whose icon edit picker is open
  const [pinnedEditIconId, setPinnedEditIconId] = useState<string | null>(null);
  // Pinned shortcut: id of shortcut whose right-click context menu is open
  const [pinnedCtxMenu, setPinnedCtxMenu] = useState<string | null>(null);
  // AI suggestions dropdown menu
  const [showAiMenu, setShowAiMenu] = useState(false);
  // Inline sticker suggestions (above input area)
  const [inlineStickerSuggestions, setInlineStickerSuggestions] = useState<any[]>([]);
  const inlineStickerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inlineStickerLastKwRef = useRef<string>('');

  const textareaRef = useRef<HTMLDivElement>(null);
  const mentionListRef = useRef<HTMLDivElement>(null);
  const emojiPickerRef = useRef<HTMLDivElement>(null);
  const moreMenuBtnRef = useRef<HTMLButtonElement>(null);
  const aiMenuRef = useRef<HTMLDivElement>(null);
  // Track IME composition state (Vietnamese, Chinese, etc.) to avoid
  // clearing input before compositionend on macOS
  const isComposingRef = useRef(false);
  // Flag to prevent compositionEnd/input from re-inserting text after send
  const justSentRef = useRef(false);
  // Track previous plain text để tính delta shift cho fmtRanges
  const prevTextRef = useRef<string>('');
  // Track previous thread to save draft on switch
  const prevThreadRef = useRef<{ accountId: string; threadId: string } | null>(null);
  // Debounce timer for auto-saving draft while typing (~1s)
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { activeThreadId, activeThreadType, addMessage, removeMessage, replyTo, setReplyTo, markReplied, setDraft, clearDraft } = useChatStore();
  const { activeAccountId, getActiveAccount, accounts: allAccounts } = useAccountStore();
  const { showNotification, groupInfoCache, mergedInboxMode, toggleIntegrationQuickPanel, pinnedIntegrationShortcuts, unpinIntegrationShortcut, editPinnedShortcutIcon, openIntegrationPanelTo, aiSuggestionsEnabled, aiSuggestions, aiSuggestionsLoading, setAiSuggestionsEnabled, setAiSuggestions, setAiSuggestionsLoading, isAiSuggestDisabled, toggleAiDisableForThread, toggleAiDisableForAccount, aiSuggestDisabledThreads, aiSuggestDisabledAccounts } = useAppStore();

  // Channel capability for active thread
  const activeContact = useChatStore(s => (s.contacts[activeAccountId || ''] || []).find(c => c.contact_id === activeThreadId));
  const channelCap = getCapability((activeContact?.channel || 'zalo') as any);

  // state
  const [showLocalLabels, setShowLocalLabels] = useState(true);
  const [localLabelExpanded, setLocalLabelExpanded] = useState(false);
  const [localLabelCanExpand, setLocalLabelCanExpand] = useState(false);
  const labelRowRef = useRef<HTMLDivElement>(null);

  // đo chiều cao để biết có overflow hay không
  useLayoutEffect(() => {
    const saved = localStorage.getItem('show_local_labels');
    if (saved !== null) setShowLocalLabels(saved === '1');

    const el = labelRowRef.current;
    if (!el) return;

    // Giả định 1 dòng ~ 28px (tùy design); có thể đo cụ thể từ label đầu tiên
    const rowHeight = 28;
    const maxCollapsed = rowHeight * 2;

    // Nếu scrollHeight > maxCollapsed => có thể expand
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

  const loadLocalLabelsForThread = useCallback(async () => {
    if (!activeAccountId || !activeThreadId) {
      setLocalLabels([]);
      setThreadLocalLabelIds(new Set());
      return;
    }

    try {
      const [labelsRes, threadRes] = await Promise.all([
        ipc.db?.getLocalLabels({ zaloId: activeAccountId }),
        ipc.db?.getThreadLocalLabels({ zaloId: activeAccountId, threadId: activeThreadId }),
      ]);
      const labels = (labelsRes?.labels || [])
        .filter((l: any) => (l?.is_active ?? 1) === 1)
        .sort((a: any, b: any) => {
          const sa = Number(a?.sort_order ?? 0);
          const sb = Number(b?.sort_order ?? 0);
          if (sa !== sb) return sa - sb;
          return String(a?.name || '').localeCompare(String(b?.name || ''));
        });
      const threadLabels = threadRes?.labels || [];
      setLocalLabels(labels);
      setThreadLocalLabelIds(new Set(threadLabels.map((l: any) => Number(l.id))));
    } catch {
      setLocalLabels([]);
      setThreadLocalLabelIds(new Set());
    }
  }, [activeAccountId, activeThreadId]);

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

  // ─── AI: fetch suggestions when new message arrives in active thread ──────
  const aiSuggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aiSuggestCacheRef = useRef<{ hash: string; suggestions: string[] }>({ hash: '', suggestions: [] });

  // Shared function to fetch AI suggestions for the current thread
  const fetchAiSuggestions = useCallback(async () => {
    if (!activeAccountId || !activeThreadId) return;
    if (useAppStore.getState().isAiSuggestDisabled(activeAccountId, activeThreadId)) return;
    try {
      setAiSuggestionsLoading(true);
      // Get per-account suggestion assistant
      const accRes = await ipc.ai?.getAccountAssistant(activeAccountId, 'suggestion');
      const assistantId = accRes?.assistant?.id;
      if (!assistantId) { setAiSuggestionsLoading(false); return; }
      // Get context message count from assistant
      const contextCount = accRes?.assistant?.contextMessageCount || 30;
      // Get recent messages — include image context
      const key = `${activeAccountId}_${activeThreadId}`;
      const msgs = useChatStore.getState().messages[key] || [];
      const recent = msgs.slice(-contextCount).map((m: any) => {
        const role = m.is_sent ? 'assistant' : 'user';
        // Detect image messages and describe them in context
        const msgType = m.msg_type || '';
        const isImage = msgType === 'chat.photo' || msgType === 'photo' || msgType === 'image';
        if (isImage) {
          return { role, content: '[Hình ảnh được gửi]' };
        }
        // Try to detect image from content structure
        if (typeof m.content === 'object' && m.content !== null) {
          let params: any = m.content?.params;
          if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
          if (params?.hd || params?.rawUrl || m.content?.thumb) {
            const textPart = m.content?.msg || m.content?.title || '';
            return { role, content: textPart ? `[Hình ảnh kèm text: ${textPart}]` : '[Hình ảnh được gửi]' };
          }
          return { role, content: m.content?.msg || m.content?.title || '' };
        }
        return { role, content: typeof m.content === 'string' ? m.content : '' };
      }).filter((m: any) => m.content.trim());
      if (recent.length === 0) { setAiSuggestionsLoading(false); return; }
      // Cache: skip API call if context hasn't changed
      const contextHash = recent.map((m: any) => `${m.role}:${m.content}`).join('|');
      if (contextHash === aiSuggestCacheRef.current.hash && aiSuggestCacheRef.current.suggestions.length > 0) {
        setAiSuggestions(aiSuggestCacheRef.current.suggestions);
        setAiSuggestionsLoading(false);
        return;
      }
      const res = await ipc.ai?.suggest(assistantId, recent);
      if (res?.success && res.suggestions?.length) {
        setAiSuggestions(res.suggestions);
        aiSuggestCacheRef.current = { hash: contextHash, suggestions: res.suggestions };
      } else {
      }
    } catch {}
    setAiSuggestionsLoading(false);
  }, [activeAccountId, activeThreadId]);

  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;
    // Check granular disable
    if (isAiSuggestDisabled(activeAccountId, activeThreadId)) return;

    // Trigger initial fetch when effect runs (feature enabled, thread switch, etc.)
    if (aiSuggestTimerRef.current) clearTimeout(aiSuggestTimerRef.current);
    aiSuggestTimerRef.current = setTimeout(() => {
      fetchAiSuggestions();
    }, 1500);

    // Listen for new messages via custom event from useZaloEvents
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.zaloId !== activeAccountId || detail?.threadId !== activeThreadId) return;
      // Re-check disable in case it changed
      if (useAppStore.getState().isAiSuggestDisabled(activeAccountId, activeThreadId)) return;
      // Debounce 1.5s
      if (aiSuggestTimerRef.current) clearTimeout(aiSuggestTimerRef.current);
      aiSuggestTimerRef.current = setTimeout(() => {
        fetchAiSuggestions();
      }, 1500);
    };
    window.addEventListener('ai:newMessage', handler);
    return () => {
      window.removeEventListener('ai:newMessage', handler);
      if (aiSuggestTimerRef.current) clearTimeout(aiSuggestTimerRef.current);
    };
  }, [activeAccountId, activeThreadId, aiSuggestDisabledThreads, aiSuggestDisabledAccounts, aiSuggestionsEnabled, fetchAiSuggestions]);

  // Clear suggestions & cache when thread changes
  useEffect(() => {
    setAiSuggestions([]);
    aiSuggestCacheRef.current = { hash: '', suggestions: [] };
  }, [activeThreadId]);

  // ─── Notify ChatWindow when AI suggestions bar height changes ─────────────
  // Khi thanh gợi ý AI xuất hiện/biến mất, input area thay đổi chiều cao
  // → cần scroll chat xuống dưới nếu user đang ở cuối trang
  const prevSuggestionsVisibleRef = useRef(false);
  useEffect(() => {
    const isVisible = !!(aiSuggestions.length > 0 || aiSuggestionsLoading);
    if (isVisible !== prevSuggestionsVisibleRef.current) {
      prevSuggestionsVisibleRef.current = isVisible;
      // Dispatch sau 1 frame để DOM đã cập nhật chiều cao
      requestAnimationFrame(() => {
        window.dispatchEvent(new CustomEvent('ai:suggestionsBarChanged', { detail: { visible: isVisible } }));
      });
    }
  }, [aiSuggestions, aiSuggestionsLoading]);

  // ─── Outgoing typing event (debounced) ────────────────────────────────────
  // Theo chuẩn các nền tảng lớn (WhatsApp/Telegram):
  //   - Gửi typing notification khi bắt đầu nhập (chỉ 1 lần / 4 giây)
  //   - Tự động dừng sau khi không nhập trong 6 giây
  const lastTypingSentRef = useRef<number>(0);
  const typingStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sendTypingEvent = useCallback(() => {
    if (!activeAccountId || !activeThreadId) return;
    const now = Date.now();
    // Throttle: chỉ gửi tối đa 1 lần / 4 giây
    if (now - lastTypingSentRef.current < 4000) return;
    lastTypingSentRef.current = now;

    const account = getActiveAccount();
    if (!account) return;
    const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent };

    // Gọi API sendTyping nếu có (best-effort, silent fail)
    (ipc.zalo as any)?.sendTyping?.({ auth, threadId: activeThreadId, type: activeThreadType })?.catch?.(() => {});

    // Reset stop timer
    if (typingStopTimerRef.current) clearTimeout(typingStopTimerRef.current);
    typingStopTimerRef.current = setTimeout(() => {
      lastTypingSentRef.current = 0; // Reset để lần nhập tiếp theo gửi lại ngay
    }, 6000);
  }, [activeAccountId, activeThreadId, activeThreadType, getActiveAccount]);

  // @ mention: chỉ áp dụng cho thread nhóm, dùng groupMembers từ cache
  const isGroupThread = activeThreadType === 1;
  const groupMembers: Array<{ userId: string; displayName: string; avatar: string }> =
    (activeAccountId && activeThreadId && isGroupThread)
      ? (groupInfoCache?.[activeAccountId]?.[activeThreadId]?.members || [])
      : [];

  const filteredMentions = showMentionDropdown && isGroupThread
    ? groupMembers
        .filter(m =>
          !mentionSearch ||
          m.displayName.toLowerCase().includes(mentionSearch.toLowerCase()) ||
          m.userId.includes(mentionSearch)
        )
        .slice(0, 50)   // giới hạn 50 để tránh render quá nhiều (nhóm 5k thành viên)
    : [];

  useEffect(() => {
    if (replyTo) textareaRef.current?.focus();
  }, [replyTo]);

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
    if (prev?.accountId && prev?.threadId) {
      const el = textareaRef.current;
      const currentText = el ? el.innerText.replace(/\u200B/g, '').trim() : '';
      if (currentText) {
        setDraft(prev.accountId, prev.threadId, currentText);
      } else {
        clearDraft(prev.accountId, prev.threadId);
      }
    }

    // ── Update ref to current thread ────────────────────────────────
    prevThreadRef.current = (activeAccountId && activeThreadId)
      ? { accountId: activeAccountId, threadId: activeThreadId }
      : null;

    // ── Reset states ────────────────────────────────────────────────
    setShowMentionDropdown(false);
    setMentionSearch('');
    setMentionTriggerPos(-1);
    setMentions([]);
    setFmtRanges([]);
    setActiveFmts(new Set());
    setClipboardImages([]);
    prevTextRef.current = '';
    lastTypingSentRef.current = 0;
    if (typingStopTimerRef.current) { clearTimeout(typingStopTimerRef.current); typingStopTimerRef.current = null; }
    if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null; }

    // ── Restore draft for the NEW thread (or clear) ─────────────────
    const draftKey = activeAccountId && activeThreadId ? `${activeAccountId}_${activeThreadId}` : '';
    const savedDraft = draftKey ? (useChatStore.getState().drafts[draftKey] || '') : '';
    const el = textareaRef.current;
    if (el) {
      el.innerText = savedDraft;
    }
    setText(savedDraft);

    // Focus editor sau khi đổi thread
    setTimeout(() => textareaRef.current?.focus(), 50);
  }, [activeThreadId, activeAccountId]);

  // Preload quick messages when account changes
  useEffect(() => {
    if (!activeAccountId) return;
    const account = getActiveAccount();
    if (!account) return;
    const isFb = account.channel === 'facebook';
    const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent };
    const mode = isFb ? 'local' : ((localStorage.getItem(`qm_mode_${activeAccountId}`) as 'zalo' | 'local') || 'zalo');
    fetchQuickMessages(auth, activeAccountId, mode).then(setQuickMessages).catch(() => {});
  }, [activeAccountId]);

  useEffect(() => {
    loadLocalLabelsForThread().catch(() => {});
  }, [loadLocalLabelsForThread]);

  // ── Paste: bắt ảnh từ clipboard ──────────────────────────────────
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

  // ── Paste text: bỏ định dạng (màu nền, màu chữ, font...) khi paste ──
  const handleEditorPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    // Nếu có ảnh thì để handler ở trên xử lý
    const items = e.clipboardData?.items;
    if (items) {
      const hasImage = Array.from(items).some(item => item.type.startsWith('image/'));
      if (hasImage) return;
    }
    // Chặn paste mặc định (giữ nguyên HTML formatting)
    e.preventDefault();
    const plainText = e.clipboardData.getData('text/plain');
    if (!plainText) return;
    // Insert plain text tại vị trí cursor
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    sel.deleteFromDocument();
    const textNode = document.createTextNode(plainText);
    const range = sel.getRangeAt(0);
    range.insertNode(textNode);
    // Di chuyển cursor tới cuối text vừa paste
    range.setStartAfter(textNode);
    range.setEndAfter(textNode);
    sel.removeAllRanges();
    sel.addRange(range);
    // Trigger input event để cập nhật state
    textareaRef.current?.dispatchEvent(new Event('input', { bubbles: true }));
  };

  // ── Inline sticker suggestions: when user types >2 chars + 1s pause ──
  // Only for plain text (no reply quote, no clipboard images)
  useEffect(() => {
    if (inlineStickerTimerRef.current) clearTimeout(inlineStickerTimerRef.current);
    const kw = text.trim().toLowerCase();

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
        const cacheRes = await ipc.db?.getKeywordStickers?.({ keyword: kw });
        if (cacheRes?.success && cacheRes.stickerIds !== null && cacheRes.stickerIds !== undefined) {
          // Cache hit (including empty array = previously searched with no results)
          if (cacheRes.stickerIds.length === 0) {
            setInlineStickerSuggestions([]);
            return;
          }
          const detailRes = await ipc.db?.getStickersByIds?.({ stickerIds: cacheRes.stickerIds.slice(0, 20) });
          if (detailRes?.success && detailRes.stickers?.length) {
            setInlineStickerSuggestions(detailRes.stickers);
            return;
          }
        }

        // Step 2: Cache miss → call Zalo API
        const account = getActiveAccount();
        if (!account) { setInlineStickerSuggestions([]); return; }
        const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent };

        const idsRes = await ipc.zalo?.getStickers({ auth, keyword: kw });
        const ids: number[] = idsRes?.response || [];

        // Always cache keyword → stickerIds (even empty = no results, so next time skip API)
        ipc.db?.saveKeywordStickers?.({ keyword: kw, stickerIds: ids }).catch(() => {});

        if (!ids.length) { setInlineStickerSuggestions([]); return; }

        // Step 3: Get sticker details
        const detailRes = await ipc.zalo?.getStickersDetail({ auth, stickerIds: ids.slice(0, 20) });
        const stickers: any[] = detailRes?.response || [];
        setInlineStickerSuggestions(stickers);

        // Save ALL stickers to DB cache (for sticker store)
        if (stickers.length) {
          ipc.db?.saveStickers({ stickers }).catch(() => {});
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

  const getAuth = () => {
    const account = getActiveAccount();
    if (!account) return null;
    // FB accounts may not have Zalo credentials — return a placeholder so send flow continues
    if ((account.channel || 'zalo') !== 'zalo') {
      return { cookies: '', imei: '', userAgent: '' };
    }
    return { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent };
  };

  const handleToggleLocalLabel = useCallback(async (label: LocalLabel) => {
    if (!activeAccountId || !activeThreadId || togglingLocalLabelId !== null) return;
    const exists = threadLocalLabelIds.has(label.id);
    setTogglingLocalLabelId(label.id);
    try {
      if (exists) {
        await ipc.db?.removeLocalLabelFromThread({ zaloId: activeAccountId, labelId: label.id, threadId: activeThreadId, threadType: activeThreadType ?? 0, labelText: label.name || '', labelColor: label.color || '', labelEmoji: label.emoji || '' });
      } else {
        await ipc.db?.assignLocalLabelToThread({ zaloId: activeAccountId, labelId: label.id, threadId: activeThreadId, threadType: activeThreadType ?? 0, labelText: label.name || '', labelColor: label.color || '', labelEmoji: label.emoji || '' });
      }
      await loadLocalLabelsForThread();
      // Dispatch event so ConversationList & CRM reload local labels
      window.dispatchEvent(new CustomEvent('local-labels-changed', { detail: { zaloId: activeAccountId } }));
    } catch {
      showNotification('Không thể cập nhật Nhãn Local', 'error');
    } finally {
      setTogglingLocalLabelId(null);
    }
  }, [activeAccountId, activeThreadId, activeThreadType, loadLocalLabelsForThread, showNotification, threadLocalLabelIds, togglingLocalLabelId]);

  // ─── Keyboard shortcuts for label toggle ─────────────────────────────────────
  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;
    
    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if user is typing in an input/textarea/contenteditable
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        // Still allow if it's a modifier key combination (Ctrl/Alt/Meta + key)
        if (!e.ctrlKey && !e.altKey && !e.metaKey) return;
      }
      
      // Check if any label has a shortcut that matches
      for (const label of localLabels) {
        if (label.shortcut && matchesShortcut(e, label.shortcut)) {
          e.preventDefault();
          e.stopPropagation();
          
          // Toggle this label
          const exists = threadLocalLabelIds.has(label.id);
          const action = exists ? 'Gỡ' : 'Gắn';
          
          // Call toggle function
          handleToggleLocalLabel(label).then(() => {
            showNotification(`${action} nhãn "${label.emoji || ''} ${label.name}" thành công`, 'success');
          });
          
          return;
        }
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeAccountId, activeThreadId, localLabels, threadLocalLabelIds, handleToggleLocalLabel, showNotification]);

  /** Trả về true nếu chuỗi là 1 URL thuần (không có khoảng trắng, bắt đầu bằng http/https) */
  const isUrlOnly = (s: string): boolean => {
    const t = s.trim();
    if (!t || t.includes(' ') || t.includes('\n')) return false;
    return /^https?:\/\/.+\..+/.test(t);
  };

  /** Parse message dạng: <url> + (text tùy chọn). Chỉ nhận khi URL đứng đầu để tránh bắt nhầm câu thường. */
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

      // Parse content thành object nếu là JSON string (file/link/ảnh lưu dạng JSON string trong DB)
      if (content && typeof content === 'string' && content.trim().startsWith('{')) {
        try {
          content = JSON.parse(content);
        } catch {
          // Keep as string if parse fails
        }
      }

      // GIỮ content dạng object nếu đã parse được — zca-js cần object để:
      //   • prepareQMSGAttach() build qmsgAttach đúng cho group (file/link/ảnh)
      //   • qmsg: typeof content == "string" ? content : prepareQMSG(content)
      // KHÔNG normalize chat.recommended → share.link: getClientMessageType() không có case
      // cho share.link → trả về 1 (webchat) thay vì 38 → Zalo hiểu nhầm loại quote.
      const msgType = msg.msg_type || 'webchat';

      const payload = {
        content,                              // object hoặc string, JSON.stringify giữ đúng kiểu
        msgType,
        propertyExt: msg.property_ext ?? undefined,
        uidFrom: msg.sender_id || '',
        msgId: String(msg.msg_id || ''),
        cliMsgId: String(msg.cli_msg_id || msg.msg_id || ''),
        ts: String(msg.timestamp || Date.now()),   // TMessage.ts là string timestamp ms
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
   * Lấy plain-text từ contenteditable div (bảo toàn newline từ <br> và block elements)
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
          // thêm newline sau block nếu chưa có
          if (result && !result.endsWith('\n')) result += '\n';
        }
      }
    };
    el.childNodes.forEach(walk);
    // bỏ trailing newline cuối (contenteditable hay thêm 1 <br> cuối)
    return result.replace(/\n$/, '');
  };

  /**
   * Lấy vị trí cursor (caret) trong plain-text tương đương
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
   * Rebuild HTML hiển thị cho contenteditable dựa trên plain text + fmtRanges.
   * Mỗi ký tự được đặt trong một span với các class tương ứng.
   * Dùng approach đơn giản: chia đoạn text thành segments theo ranges.
   */
  const buildRichHtml = useCallback((plainText: string, ranges: Array<{ start: number; len: number; st: string }>): string => {
    if (!plainText) return '';
    const n = plainText.length;
    // Tập hợp styles tại mỗi vị trí ký tự
    const charStyles: Set<string>[] = Array.from({ length: n }, () => new Set<string>());
    for (const r of ranges) {
      const end = Math.min(r.start + r.len, n);
      for (let i = r.start; i < end; i++) {
        charStyles[i].add(r.st);
      }
    }

    // Gộp ký tự có cùng styles thành segments
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
   * Đặt caret trong contenteditable về vị trí plain-text offset
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
   * Áp dụng định dạng lên vùng text đang chọn.
   * Nếu không có selection, toggle active state (áp dụng khi gõ tiếp — chưa hỗ trợ).
   * Nếu có selection: toggle range trong fmtRanges.
   */
  const applyFormat = (style: string) => {
    const el = textareaRef.current;
    if (!el) return;

    // Lấy raw text (có \u200B) để tính offset \u200B trước/trong selection
    const rawText = getPlainText(el);
    const { start: rawStart, end: rawEnd } = getCaretOffset(el);
    // Trừ số \u200B trước selection và trong selection để có vị trí "sạch"
    const zwspBefore = (rawText.slice(0, rawStart).match(/\u200B/g) || []).length;
    const zwspInSel  = (rawText.slice(rawStart, rawEnd).match(/\u200B/g) || []).length;
    const start  = rawStart - zwspBefore;
    const selLen = (rawEnd - rawStart) - zwspInSel;

    if (selLen === 0) {
      // Toggle active state (hiển thị hint cho user)
      setActiveFmts(prev => {
        const next = new Set(prev);
        if (next.has(style)) next.delete(style); else next.add(style);
        return next;
      });
      el.focus();
      return;
    }

    // Kiểm tra xem range này đã tồn tại chưa (để toggle off)
    const existingIdx = fmtRanges.findIndex(r => r.start === start && r.len === selLen && r.st === style);
    let newRanges: Array<{ start: number; len: number; st: string }>;
    if (existingIdx >= 0) {
      newRanges = fmtRanges.filter((_, i) => i !== existingIdx);
    } else {
      newRanges = [...fmtRanges, { start, len: selLen, st: style }];
    }
    setFmtRanges(newRanges);
    updateActiveFmtsAtPos(start + selLen, newRanges);

    // Rebuild HTML từ text ĐÃ loại \u200B để tránh tích lũy nhiều \u200B
    const plain = rawText.replace(/\u200B/g, '');
    // Đặt innerHTML rồi thêm text node rỗng ở cuối để cursor không kế thừa style span
    el.innerHTML = buildRichHtml(plain, newRanges);
    // Thêm text node plain ở cuối (anchor để gõ tiếp không bị kế thừa style)
    const anchor = document.createTextNode('\u200B');
    el.appendChild(anchor);

    // Đặt cursor ngay SAU selection (vào text node plain, không phải trong span)
    requestAnimationFrame(() => {
      const sel2 = window.getSelection();
      if (!sel2) return;
      // Tìm text node cuối cùng không phải trong span (anchor vừa tạo)
      const r2 = document.createRange();
      // anchor là node cuối el
      r2.setStart(anchor, 0);
      r2.collapse(true);
      sel2.removeAllRanges();
      sel2.addRange(r2);
      el.focus();
    });
  };

  /** Update activeFmts dựa trên các ranges chứa vị trí pos */
  const updateActiveFmtsAtPos = (pos: number, ranges: Array<{ start: number; len: number; st: string }>) => {
    const active = new Set<string>();
    for (const r of ranges) {
      if (pos >= r.start && pos <= r.start + r.len) active.add(r.st);
    }
    setActiveFmts(active);
  };

  /**
   * Xây dựng mảng styles[] từ fmtRanges để gửi kèm với tin nhắn.
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
              await ipc.zalo?.sendImages({ auth, threadId, type: threadType, filePaths: imagePaths });
              removeMessage(accountId, threadId, tempImgId);
              markReplied(accountId, threadId);
            } catch (e: any) {
              showNotification(`Gửi ảnh thất bại: ${e.message}`, 'error');
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

              let thumbUrl = '';
              if (thumbPath) {
                const uploadRes = await ipc.zalo?.uploadVideoThumb?.({ auth, thumbPath, threadId, type: threadType });
                const resp = uploadRes?.response;
                thumbUrl = resp?.normalUrl || resp?.hdUrl || resp?.url || resp?.thumbUrl || resp?.fileUrl || resp?.href || '';
              }

              const uploadVideoRes = await ipc.zalo?.uploadVideoFile?.({ auth, videoPath, threadId, type: threadType });
              const videoUrl: string = uploadVideoRes?.response?.fileUrl || '';
              if (!videoUrl) throw new Error('Upload video thất bại');

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
              removeMessage(accountId, threadId, tempVidId);
              markReplied(accountId, threadId);
            } catch (e: any) {
              showNotification(`Gửi video thất bại: ${e.message}`, 'error');
              removeMessage(accountId, threadId, tempVidId);
            }
          }

          // Send text
          if (msgTitle && tempTextId) {
            try {
              await ipc.zalo?.sendMessage({ auth, threadId, type: threadType, message: msgTitle });
              removeMessage(accountId, threadId, tempTextId);
              markReplied(accountId, threadId);
            } catch (e: any) {
              showNotification(`Gửi tin nhắn thất bại: ${e.message}`, 'error');
              removeMessage(accountId, threadId, tempTextId);
            }
          }
        } catch (err: any) {
          showNotification('Gửi tin nhắn nhanh thất bại: ' + err.message, 'error');
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

  /** Được gọi khi user click vào item trong QuickMessageManagerPanel.
   *  Clear editor → gọi handleSelectQuickMessage với triggerPos=0 (từ đầu). */
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

  const handleSelectMention = (member: { userId: string; displayName: string; avatar: string }) => {
    const el = textareaRef.current;
    if (!el || mentionTriggerPos < 0) return;
    const cursorPos = getCaretOffset(el).start;
    const curText = getPlainText(el);
    const beforeAt = curText.slice(0, mentionTriggerPos);
    const afterCursor = curText.slice(cursorPos);
    const mentionText = `@${member.displayName} `;
    const newText = beforeAt + mentionText + afterCursor;
    const newMention = { uid: member.userId, pos: mentionTriggerPos, len: mentionText.length - 1 };
    setText(newText);
    setMentions(prev => [...prev, newMention]);
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
    const quotePayload = buildQuotePayload(replyTo);

    // Clear editor — delay 1 tick to let IME compositionend finalize on macOS
    const doClear = () => {
      if (el) { el.innerHTML = ''; }
      setText('');
      prevTextRef.current = '';
      setMentions([]);
      setFmtRanges([]);
      setActiveFmts(new Set());
      // Reset flag after a short delay so any trailing input events are ignored
      setTimeout(() => { justSentRef.current = false; }, 50);
    };
    justSentRef.current = true;
    // Always use setTimeout to ensure compositionEnd + its input event finish first
    setTimeout(doClear, 0);
    const imagesToSend = [...clipboardImages];
    setClipboardImages([]);
    setSending(true);
    // ── Cancel pending debounced draft save to prevent re-saving stale draft ──
    if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null; }
    // Clear draft khi gửi tin nhắn
    if (activeAccountId && activeThreadId) clearDraft(activeAccountId, activeThreadId);

    try {
      // ── Gửi ảnh clipboard trước ──────────────────────────────────
      if (imagesToSend.length > 0) {
        // Lưu từng blob thành file tạm rồi gửi batch
        const tempPaths: string[] = [];
        for (const img of imagesToSend) {
          const ext = img.blob.type.split('/')[1] || 'png';
          const res = await ipc.file?.saveTempBlob({ base64: img.dataUrl, ext });
          if (res?.success && res.filePath) tempPaths.push(res.filePath);
        }
        if (tempPaths.length > 0) {
          const ch = activeContact?.channel || 'zalo';
          if (ch === 'facebook') {
            // FB: batch temp + single request with all images
            const batchTempId = `temp_${Date.now()}_batch`;
            addMessage(activeAccountId, activeThreadId, {
              msg_id: batchTempId, owner_zalo_id: activeAccountId, thread_id: activeThreadId,
              thread_type: activeThreadType, sender_id: activeAccountId, content: '🖼️ Hình ảnh',
              msg_type: 'image', timestamp: Date.now(), is_sent: 1, status: 'sending', channel: 'facebook',
              attachments: JSON.stringify(tempPaths.map(fp => ({ type: 'image', localPath: fp }))),
            });
            const batchRes = await ipc.fb?.sendAttachments({
              accountId: activeAccountId!,
              threadId: activeThreadId,
              filePaths: tempPaths,
              typeChat: activeThreadType === 0 ? 'user' : null,
            });
            removeMessage(activeAccountId!, activeThreadId, batchTempId);
            if (!batchRes?.success) showNotification(batchRes?.error || 'Gửi ảnh Facebook thất bại', 'error');
          } else {
            await ipc.zalo?.sendImages({
              auth,
              threadId: activeThreadId,
              type: activeThreadType,
              filePaths: tempPaths,
              // Only attach quote to media when this send is image-only.
              ...(!hasText && quotePayload ? { quote: quotePayload } : {}),
            });
          }
        }
      }

      if (!hasText) {
        if (quotePayload) setReplyTo(null);
        setSending(false);
        textareaRef.current?.focus();
        return;
      }

      // ── Chỉ gửi qua sendLink khi là URL thuần để tránh bị tách thành 2 tin (text + link) ──
      const linkPayload = parseLinkWithCaption(msgText);
      if (linkPayload && !linkPayload.caption && isUrlOnly(msgText)) {
        const ch = activeContact?.channel || 'zalo';
        if (ch === 'facebook') {
          await channelIpc.sendMessage('facebook', { accountId: activeAccountId, threadId: activeThreadId, body: msgText, threadType: activeThreadType })
            .then((r: any) => { if (!r?.success) showNotification(r?.error || 'Gửi tin nhắn Facebook thất bại', 'error'); });
        } else {
          await ipc.zalo?.sendLink({
            auth,
            url: linkPayload.url,
            threadId: activeThreadId,
            type: activeThreadType,
            ...(quotePayload ? { quote: quotePayload } : {}),
          });
        }
        if (quotePayload) setReplyTo(null);
        setSending(false); textareaRef.current?.focus(); return;
      }

      // ── Gửi tin nhắn văn bản thường ─────────────────────────────
      const activeChannel = activeContact?.channel || 'zalo';

      if (activeChannel === 'facebook') {
        // Facebook: route through channelIpc facade
        setReplyTo(null);
        addMessage(activeAccountId, activeThreadId, {
          msg_id: `temp_${Date.now()}`, owner_zalo_id: activeAccountId, thread_id: activeThreadId,
          thread_type: activeThreadType, sender_id: activeAccountId, content: msgText,
          msg_type: 'text', timestamp: Date.now(), is_sent: 1, status: 'sending', channel: 'facebook',
        });
        const fbResult = await channelIpc.sendMessage('facebook', {
          accountId: activeAccountId,
          threadId: activeThreadId,
          body: msgText,
          threadType: activeThreadType,
        });
        if (!fbResult?.success) {
          const errMsg = fbResult?.error || 'Gửi tin nhắn Facebook thất bại';
          showNotification(errMsg, 'error');
        }
        if (activeAccountId) markReplied(activeAccountId, activeThreadId);
      } else {
      // Zalo path (unchanged)
      const rawStyles = buildStyles();

      // Chuẩn hoá style ranges: clamp start/len vào [0, msgText.length]
      // Điều này xử lý trường hợp \u200B bị chọn cùng (Ctrl+A / Shift+End)
      // khiến len vượt quá độ dài thực của msgText → Zalo API từ chối request.
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
      setReplyTo(null);
      addMessage(activeAccountId, activeThreadId, {
        msg_id: `temp_${Date.now()}`, owner_zalo_id: activeAccountId, thread_id: activeThreadId,
        thread_type: activeThreadType, sender_id: activeAccountId, content: tempContent,
        msg_type: tempMsgType, timestamp: Date.now(), is_sent: 1, status: 'sending',
      });
      await ipc.zalo?.sendMessage({
        auth, threadId: activeThreadId, type: activeThreadType, message: msgText,
        ...(quotePayload ? { quote: quotePayload } : {}),
        ...(mentions.length > 0 ? { mentions } : {}),
        ...(finalStyles ? { styles: finalStyles } : {}),
      });
      // Đánh dấu "đã trả lời" cho conversation này
      if (activeAccountId) markReplied(activeAccountId, activeThreadId);
      } // end else (Zalo path)
    } catch (err: any) {
      showNotification('Gửi thất bại: ' + err.message, 'error');
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleSendLike = async () => {
    const auth = getAuth();
    if (!auth || !activeThreadId || !activeAccountId) return;
    setSending(true);
    try {
      const ch = activeContact?.channel || 'zalo';
      if (ch === 'facebook') {
        const likeRes = await channelIpc.sendMessage('facebook', { accountId: activeAccountId, threadId: activeThreadId, body: '👍', threadType: activeThreadType });
        if (!likeRes?.success) showNotification(likeRes?.error || 'Gửi thất bại', 'error');
      } else {
        await ipc.zalo?.sendMessage({ auth, threadId: activeThreadId, type: activeThreadType, message: '👍' });
      }
    } catch {} finally { setSending(false); }
  };

  const handleSendImage = async () => {
    const auth = getAuth();
    if (!auth || !activeThreadId) return;
    const result = await ipc.file?.openDialog({
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
      multiSelect: true,
    });
    if (result?.canceled || !result?.filePaths?.length) return;
    setSending(true);
    try {
      const quotePayload = buildQuotePayload(replyTo);
      const ch = activeContact?.channel || 'zalo';
      if (ch === 'facebook') {
        // FB: create ONE batch temp with all images for immediate local preview
        const batchTempId = `temp_${Date.now()}_batch`;
        addMessage(activeAccountId!, activeThreadId, {
          msg_id: batchTempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
          thread_type: activeThreadType, sender_id: activeAccountId!, content: '🖼️ Hình ảnh',
          msg_type: 'image', timestamp: Date.now(), is_sent: 1, status: 'sending', channel: 'facebook',
          attachments: JSON.stringify(result.filePaths.map(fp => ({
            type: 'image', localPath: fp, name: fp.split(/[\\/]/).pop() || 'image',
          }))),
        });
        // Send all images in ONE request (upload in parallel, send as batch)
        const batchRes = await ipc.fb?.sendAttachments({
          accountId: activeAccountId!,
          threadId: activeThreadId,
          filePaths: result.filePaths,
          typeChat: activeThreadType === 0 ? 'user' : null,
        });
        // Remove batch temp — MQTT echo will add the real message
        removeMessage(activeAccountId!, activeThreadId, batchTempId);
        if (!batchRes?.success) {
          showNotification(batchRes?.error || 'Gửi ảnh Facebook thất bại', 'error');
        } else if ((batchRes.uploadedCount || 0) < (batchRes.totalCount || 0)) {
          showNotification(`${(batchRes.totalCount || 0) - (batchRes.uploadedCount || 0)} ảnh upload thất bại`, 'error');
        }
      } else {
        // Zalo: sendImages batch
        await ipc.zalo?.sendImages({
          auth,
          threadId: activeThreadId,
          type: activeThreadType,
          filePaths: result.filePaths,
          ...(quotePayload ? { quote: quotePayload } : {}),
        });
      }
      if (quotePayload) setReplyTo(null);
    } catch (err: any) {
      showNotification('Gửi ảnh thất bại: ' + err.message, 'error');
    } finally { setSending(false); }
  };

  const handleSendFile = async () => {
    const auth = getAuth();
    if (!auth || !activeThreadId) return;
    const result = await ipc.file?.openDialog({ filters: [{ name: 'All Files', extensions: ['*'] }] });
    if (result?.canceled || !result?.filePaths?.length) return;
    const filePath = result.filePaths[0];
    setSending(true);
    try {
      const quotePayload = buildQuotePayload(replyTo);
      const ch = activeContact?.channel || 'zalo';
      if (ch === 'facebook') {
        const fileName = filePath.split(/[\\/]/).pop() || 'file';
        const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
        addMessage(activeAccountId!, activeThreadId, {
          msg_id: tempId, owner_zalo_id: activeAccountId!, thread_id: activeThreadId,
          thread_type: activeThreadType, sender_id: activeAccountId!, content: `📎 ${fileName}`,
          msg_type: 'file', timestamp: Date.now(), is_sent: 1, status: 'sending', channel: 'facebook',
          attachments: JSON.stringify([{ type: 'file', localPath: filePath, name: fileName }]),
        });
        const fileRes = await channelIpc.sendAttachment('facebook', { accountId: activeAccountId!, threadId: activeThreadId, filePath, threadType: activeThreadType });
        if (!fileRes?.success) {
          showNotification(fileRes?.error || 'Gửi file Facebook thất bại', 'error');
          removeMessage(activeAccountId!, activeThreadId, tempId);
        }
        // The MQTT echo will arrive and replace tempId automatically via useChatEvents
      } else {
        await ipc.zalo?.sendFile({
          auth,
          threadId: activeThreadId,
          type: activeThreadType,
          filePath,
          ...(quotePayload ? { quote: quotePayload } : {}),
        });
      }
      if (quotePayload) setReplyTo(null);
      showNotification('Đã gửi file!', 'success');
    } catch (err: any) {
      showNotification('Gửi file thất bại: ' + err.message, 'error');
    } finally { setSending(false); }
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
    setSending(true);
    try {
      const quotePayload = buildQuotePayload(replyTo);
      // Lấy metadata và thumbnail từ video (dùng ffmpeg nếu có)
      const metaRes = await ipc.file?.getVideoMeta?.({ filePath: videoPath });
      let thumbPath: string = metaRes?.thumbPath || '';
      const duration: number = metaRes?.duration || 0;
      const width: number = metaRes?.width || 0;
      const height: number = metaRes?.height || 0;

      // Fallback: nếu ffmpeg không tạo được thumbnail, dùng canvas để capture frame
      if (!thumbPath) {
        const seekSec = duration > 2 ? 1 : 0;
        const dataUrl = await extractVideoThumbViaCanvas(videoPath, seekSec);
        if (dataUrl && dataUrl.length > 100) {
          // Lưu base64 thành file tạm để upload
          const saveRes = await ipc.file?.saveTempBlob?.({
            base64: dataUrl,
            ext: 'jpg',
          });
          if (saveRes?.success && saveRes?.filePath) {
            thumbPath = saveRes.filePath;
            console.log('[sendVideo] Canvas thumbnail saved to:', thumbPath);
          }
        }
      }

      // Upload thumbnail trước
      let thumbUrl = '';
      if (thumbPath) {
        const uploadRes = await ipc.zalo?.uploadVideoThumb?.({
          auth, thumbPath, threadId: activeThreadId, type: activeThreadType,
        });
        console.log('[sendVideo] uploadVideoThumb response:', JSON.stringify(uploadRes));
        // uploadAttachment trả về { normalUrl, hdUrl, thumbUrl, photoId, ... } cho ảnh jpg
        const resp = uploadRes?.response;
        thumbUrl =
          resp?.normalUrl ||
          resp?.hdUrl ||
          resp?.url ||
          resp?.thumbUrl ||
          resp?.fileUrl ||
          resp?.href ||
          '';
        if (!thumbUrl) {
          console.warn('[sendVideo] Không lấy được URL thumbnail từ response:', JSON.stringify(uploadRes));
        }
      }

      // Upload video
      const uploadVideoRes = await ipc.zalo?.uploadVideoFile?.({
        auth, videoPath, threadId: activeThreadId, type: activeThreadType,
      });
      console.log('[sendVideo] uploadVideoFile response:', JSON.stringify(uploadVideoRes));
      const videoUrl: string = uploadVideoRes?.response?.fileUrl || '';

      if (!videoUrl) {
        showNotification('Upload video thất bại', 'error');
        return;
      }

      await ipc.zalo?.sendVideo({
        auth,
        options: {
          videoUrl,
          // Nếu không có thumbnail URL thì dùng videoUrl (Zalo sẽ tự generate hoặc hiện default)
          thumbnailUrl: thumbUrl || videoUrl,
          duration: duration ? duration * 1000 : undefined,
          width: width || undefined,
          height: height || undefined,
        },
        threadId: activeThreadId,
        type: activeThreadType,
        ...(quotePayload ? { quote: quotePayload } : {}),
      });
      if (quotePayload) setReplyTo(null);
      showNotification('Đã gửi video!', 'success');
    } catch (err: any) {
      showNotification('Gửi video thất bại: ' + err.message, 'error');
    } finally { setSending(false); }
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
    // ⚡ Set flag TRƯỚC khi stop — onstop sẽ check flag này để bỏ qua gửi
    recordingCancelledRef.current = true;
    recordingChunksRef.current = [];
    // Dừng mic tracks ngay để ondataavailable không thêm data mới
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
      // Đang thu → dừng (sẽ trigger onstop → gửi)
      recordingCancelledRef.current = false; // Đảm bảo không bị cancel
      stopRecording();
      return;
    }

    const auth = getAuth();
    if (!auth || !activeThreadId) return;

    // Bắt đầu thu âm
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/ogg';

      const recorder = new MediaRecorder(stream, { mimeType });
      recordingChunksRef.current = [];
      recordingCancelledRef.current = false; // Reset flag cho lần ghi mới

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0 && !recordingCancelledRef.current) {
          recordingChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        // Dừng tất cả track micro
        stream.getTracks().forEach(t => t.stop());

        // ⚡ Nếu đã cancel → không gửi
        if (recordingCancelledRef.current) {
          recordingChunksRef.current = [];
          return;
        }

        const chunks = recordingChunksRef.current;
        if (chunks.length === 0) return;

        const blob = new Blob(chunks, { type: mimeType });
        recordingChunksRef.current = [];

        if (blob.size < 1000) {
          showNotification('Đoạn ghi âm quá ngắn', 'error');
          return;
        }

        setSending(true);
        try {
          // Chuyển blob → base64 → lưu file tạm
          const reader = new FileReader();
          const base64 = await new Promise<string>((resolve, reject) => {
            reader.onloadend = () => resolve(reader.result as string);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });

          const ext = mimeType.includes('webm') ? 'webm' : 'ogg';
          const saveRes = await ipc.file?.saveTempBlob?.({ base64, ext });
          if (!saveRes?.success || !saveRes?.filePath) {
            showNotification('Lưu file ghi âm tạm thất bại', 'error');
            return;
          }

          // Upload file lên Zalo để lấy URL
          const uploadRes = await ipc.zalo?.uploadVoiceFile?.({
            auth,
            voicePath: saveRes.filePath,
            threadId: activeThreadId,
            type: activeThreadType,
          });

          const voiceUrl: string =
            uploadRes?.response?.fileUrl ||
            uploadRes?.response?.normalUrl ||
            uploadRes?.response?.hdUrl ||
            uploadRes?.response?.url ||
            uploadRes?.response?.href ||
            '';

          if (!voiceUrl) {
            showNotification('Upload file ghi âm thất bại', 'error');
            return;
          }

          // Gửi voice message
          const quotePayload = buildQuotePayload(replyTo);
          await ipc.zalo?.sendVoice({
            auth,
            options: { voiceUrl },
            threadId: activeThreadId,
            type: activeThreadType,
            ...(quotePayload ? { quote: quotePayload } : {}),
          });
          if (quotePayload) setReplyTo(null);
          showNotification('Đã gửi ghi âm!', 'success');
        } catch (err: any) {
          showNotification('Gửi ghi âm thất bại: ' + err.message, 'error');
        } finally {
          setSending(false);
        }
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250); // collect data every 250ms
      setIsRecording(true);
      setRecordingDuration(0);

      // Timer đếm giây
      const startTime = Date.now();
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 500);

    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        showNotification('Vui lòng cho phép truy cập microphone', 'error');
      } else {
        showNotification('Không thể bắt đầu ghi âm: ' + err.message, 'error');
      }
    }
  }, [isRecording, activeThreadId, activeThreadType, getAuth, stopRecording, replyTo]);

  // Cleanup recording khi unmount hoặc đổi thread
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

  const handleSendSticker = () => {
    setShowEmojiPicker(false);
    setShowAiMenu(false);
    setShowStickerPicker((v) => !v);
  };

  const handleSendStickerItem = async (sticker: any) => {
    const auth = getAuth();
    if (!auth || !activeThreadId || sending) return;
    setShowStickerPicker(false);
    setSending(true);
    try {
      await ipc.zalo?.sendSticker({ auth, stickerId: sticker.id, threadId: activeThreadId, type: activeThreadType });
      // Save to recent + DB cache
      await ipc.db?.addRecentSticker({ stickerId: sticker.id });
      await ipc.db?.saveStickers({ stickers: [sticker] });
      // Clear text input + draft sau khi gửi sticker
      setText('');
      setFmtRanges([]);
      setActiveFmts(new Set());
      prevTextRef.current = '';
      if (textareaRef.current) textareaRef.current.innerHTML = '';
      if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null; }
      if (activeAccountId && activeThreadId) clearDraft(activeAccountId, activeThreadId);
    } catch (err: any) {
      showNotification('Gửi sticker thất bại: ' + err.message, 'error');
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
      await ipc.db?.addRecentSticker({ stickerId: sticker.id });
      await ipc.db?.saveStickers({ stickers: [sticker] });
      // Clear the text input after sending sticker
      setText('');
      setFmtRanges([]);
      setActiveFmts(new Set());
      prevTextRef.current = '';
      if (textareaRef.current) textareaRef.current.innerHTML = '';
      if (draftSaveTimerRef.current) { clearTimeout(draftSaveTimerRef.current); draftSaveTimerRef.current = null; }
      if (activeAccountId && activeThreadId) clearDraft(activeAccountId, activeThreadId);
    } catch (err: any) {
      showNotification('Gửi sticker thất bại: ' + err.message, 'error');
    } finally {
      setSending(false);
    }
  };

  const insertEmoji = (emoji: string) => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    // Insert vào vị trí caret hiện tại
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
    // Trigger input event để sync state
    el.dispatchEvent(new Event('input', { bubbles: true }));
  };

  /**
   * Handler cho contenteditable input event.
   * LUÔN rebuild HTML từ fmtRanges sau mỗi lần gõ để ngăn browser kế thừa style span.
   * Tự động shift fmtRanges khi chèn/xóa ký tự trước vùng định dạng.
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

    // ── Debounced draft save (~1s) ────────────────────────────────────
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      const aid = useAccountStore.getState().activeAccountId;
      const tid = useChatStore.getState().activeThreadId;
      if (aid && tid) {
        const trimmed = newText.trim();
        if (trimmed) {
          useChatStore.getState().setDraft(aid, tid, trimmed);
        } else {
          useChatStore.getState().clearDraft(aid, tid);
        }
      }
    }, 1000);

    // Gửi typing event nếu đang nhập nội dung
    if (newText.length > 0) sendTypingEvent();

    // Tính delta tại cursor
    const delta = newText.length - prevText.length;

    // Shift/adjust fmtRanges dựa trên delta tại realCursor
    let activeRanges = fmtRanges;
    if (fmtRanges.length > 0 && delta !== 0) {
      const adjusted = fmtRanges
        .map(r => {
          const rStart = r.start;
          const rEnd = r.start + r.len;
          if (delta > 0) {
            // Thêm ký tự tại realCursor
            if (realCursor <= rStart) {
              return { ...r, start: rStart + delta };
            } else if (realCursor < rEnd) {
              return { ...r, len: r.len + delta };
            }
            return r;
          } else {
            // Xóa |delta| ký tự: vùng xóa [delStart, delEnd)
            const delStart = realCursor;
            const delEnd = realCursor - delta;
            if (rStart >= delStart && rEnd <= delEnd) return null; // range bị xóa hoàn toàn
            if (delEnd <= rStart) return { ...r, start: rStart + delta }; // xóa trước range
            if (delStart >= rEnd) return r; // xóa sau range
            // Overlap: thu hẹp range
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

    // LUÔN rebuild HTML nếu có fmtRanges để loại bỏ style browser tự kế thừa
    if (activeRanges.length > 0) {
      el.innerHTML = buildRichHtml(newText, activeRanges);
      const anchor = document.createTextNode('\u200B');
      el.appendChild(anchor);
      requestAnimationFrame(() => setCaretOffset(el, realCursor, realCursor));
    }

    // Detect @ mention trigger
    const textBeforeCursor = newText.slice(0, realCursor);
    const atMatch = textBeforeCursor.match(/@([^@\n]*)$/);
    if (atMatch && isGroupThread && groupMembers.length > 0) {
      setShowMentionDropdown(true);
      setMentionSearch(atMatch[1]);
      setMentionTriggerPos(realCursor - atMatch[0].length);
      setMentionSelectedIdx(0);
    } else {
      setShowMentionDropdown(false);
      setMentionSearch('');
      setMentionTriggerPos(-1);
    }

    const isSlashAtStart = textBeforeCursor.match(/^\/([^\s]*)$/);
    if (isSlashAtStart) {
      setShowQuickDropdown(true);
      setQuickFilter(isSlashAtStart[1]);
      setQuickTriggerPos(0);
      setQuickSelectedIdx(0);
    } else {
      setShowQuickDropdown(false);
      setQuickFilter('');
      setQuickTriggerPos(-1);
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
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionSelectedIdx(i => Math.min(i + 1, filteredMentions.length - 1)); return; }
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

  const account = getActiveAccount();
  if (!activeThreadId) return null;

  return (
    <div className="border-t border-gray-700 bg-gray-800 flex-shrink-0">
      {/* AI Suggestions bar */}
      {activeAccountId && activeThreadId && !isAiSuggestDisabled(activeAccountId, activeThreadId) && (aiSuggestions.length > 0 || aiSuggestionsLoading) && (
        <div className="ai-suggestion-bar border-b overflow-x-auto">
          <span className="ai-suggestion-badge">
            <span className="text-[11px]">✨</span>
            <span>Gợi ý AI</span>
          </span>
          {aiSuggestionsLoading ? (
            <span className="ai-suggestion-loading animate-pulse">
              Đang gợi ý câu trả lời...
            </span>
          ) : (
            aiSuggestions.map((s, i) => (
              <button
                key={i}
                onClick={() => { setText(s); if (textareaRef.current) textareaRef.current.innerText = s; setAiSuggestions([]); }}
                className="ai-suggestion-chip group"
                title={s}
              >
                <span className="ai-suggestion-chip-text line-clamp-2 break-words">{s}</span>
              </button>
            ))
          )}
          <button
            onClick={() => setAiSuggestions([])}
            className="ai-suggestion-close"
            title="Ẩn gợi ý"
          >
            ✕
          </button>
        </div>
      )}

      {/* Reply preview */}
      {replyTo && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700 bg-gray-750">
          <div className="flex-1 border-l-2 border-blue-500 pl-2 min-w-0 flex items-center gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs text-blue-400 font-medium">Trả lời</p>
              <p className="text-xs text-gray-400 truncate">{parseReplyContent(replyTo.content, replyTo.msg_type)}</p>
            </div>
            {isImageMsg(replyTo.msg_type, replyTo.content) && (() => {
              const imgs = extractReplyImages(replyTo.content, replyTo.attachments);
              return imgs.length > 0 ? (
                <div className="flex gap-1 flex-shrink-0">
                  {imgs.slice(0, 3).map((url, i) => (
                    <img key={i} src={url} alt="" className="w-10 h-10 rounded object-cover border border-gray-600" />
                  ))}
                  {imgs.length > 3 && <div className="w-10 h-10 rounded bg-gray-600 flex items-center justify-center text-xs text-gray-300">+{imgs.length - 3}</div>}
                </div>
              ) : null;
            })()}
          </div>
          <button onClick={() => setReplyTo(null)} className="text-gray-500 hover:text-white flex-shrink-0 text-lg leading-none">✕</button>
        </div>
      )}

      {/* Clipboard image previews */}
      {clipboardImages.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-700 bg-gray-800 overflow-x-auto">
          <span className="text-xs text-gray-400 flex-shrink-0">Ảnh đính kèm:</span>
          {clipboardImages.map((img) => (
            <div key={img.id} className="relative flex-shrink-0 group/clip">
              <img
                src={img.dataUrl}
                alt="clipboard"
                className="w-16 h-16 rounded-lg object-cover border border-gray-600"
              />
              <button
                onClick={() => setClipboardImages(prev => prev.filter(i => i.id !== img.id))}
                className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-gray-600 hover:bg-red-500 rounded-full flex items-center justify-center text-white text-xs font-bold shadow-lg transition-colors"
                title="Xóa ảnh"
              >✕</button>
            </div>
          ))}
          <button
            onClick={() => setClipboardImages([])}
            className="flex-shrink-0 text-xs text-gray-500 hover:text-red-400 px-2 py-1 rounded hover:bg-gray-700 transition-colors ml-auto"
            title="Xóa tất cả"
          >Xóa tất cả</button>
        </div>
      )}

      {/* Local label row — Pancake-style horizontal pills */}
      {showLocalLabels && localLabels.length > 0 && (
        <div className="flex items-start gap-1.5 px-3 py-2 border-b border-gray-700/50 flex-wrap transition-all">
          <div ref={labelRowRef} className="flex flex-wrap gap-1.5 transition-all" style={{ maxHeight: localLabelExpanded ? 'none' : 56, overflow: localLabelExpanded ? 'visible' : 'hidden',}}>
            <button type="button" onClick={() => localLabelCanExpand && setLocalLabelExpanded(v => !v)} className="text-gray-500 flex-shrink-0" title={localLabelExpanded ? 'Thu gọn' : 'Xem tất cả'}>
              {/* Icon đầu hàng: có thể đổi icon theo trạng thái */}
              {localLabelExpanded ? (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
              ) : (
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 15 12 9 18 15" />
                  </svg>
              )}
            </button>
            {localLabels.map(label => {
            const active = threadLocalLabelIds.has(label.id);
            const isToggling = togglingLocalLabelId === label.id;
            return (
              <button
                key={label.id}
                onClick={() => handleToggleLocalLabel(label)}
                disabled={isToggling}
                className={`inline-flex items-center gap-1 px-3 text-[12px] py-1 rounded-full rounded-full text-[11px] font-medium whitespace-nowrap transition-all duration-150 border ${
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
                title={active ? `✓ ${label.name} — nhấn để gỡ` : `Gắn nhãn "${label.name}"`}
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
      </div>
      )}


      {/* ── Inline sticker suggestions (Zalo-style) — above toolbar ── */}
      {inlineStickerSuggestions.length > 0 && (
        <div
          className="inline-sticker-bar flex items-center gap-1.5 px-2 py-1.5 border-b border-gray-700/50 overflow-x-auto"
        >
          <span className="text-[10px] text-gray-500 flex-shrink-0 mr-0.5">🎭</span>
          {inlineStickerSuggestions.map((s: any) => (
            <button
              key={s.id}
              onClick={() => handleInlineStickerSend(s)}
              className="flex-shrink-0 w-12 h-12 rounded-xl hover:bg-gray-700/80 flex items-center justify-center overflow-hidden transition-all hover:scale-110 p-0.5"
              title={s.text || `Sticker ${s.id} — bấm để gửi`}
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
            className="flex-shrink-0 w-6 h-6 rounded-full hover:bg-gray-700 flex items-center justify-center text-gray-500 hover:text-gray-300 text-[10px] transition-colors ml-0.5"
            title="Ẩn gợi ý sticker"
          >
            ✕
          </button>
        </div>
      )}

      {/* ── Toolbar row ── */}
      <div className="flex items-center gap-1 px-2 pt-2 pb-1 border-b border-gray-700/50">
        {/* Emoji / Biểu cảm */}
        {/* Sticker */}
        {channelCap.supportsSticker && (
        <div className="relative">
          <ToolbarBtn onClick={handleSendSticker} title="Sticker" active={showStickerPicker}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="10" r="1.5"/><circle cx="15" cy="10" r="1.5"/><path d="M9 15s1.5 2 3 2 3-2 3-2"/>
            </svg>
          </ToolbarBtn>
          {showStickerPicker && (
            <StickerPicker
              getAuth={getAuth}
              onSelect={handleSendStickerItem}
              onClose={() => setShowStickerPicker(false)}
              onInsertEmoji={(emoji) => { insertEmoji(emoji); }}
            />
          )}
        </div>
        )}

        {/* Gửi ảnh */}
        {channelCap.supportsImage && (
        <ToolbarBtn onClick={handleSendImage} title="Gửi ảnh" disabled={sending}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>
          </svg>
        </ToolbarBtn>
        )}

        {/* Gửi file */}
        {channelCap.supportsFile && (
        <ToolbarBtn onClick={handleSendFile} title="Gửi file" disabled={sending}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
          </svg>
        </ToolbarBtn>
        )}

        {/* Gửi video */}
        {channelCap.supportsVideo && (
        <ToolbarBtn onClick={handleSendVideo} title="Gửi video" disabled={sending || isRecording}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polygon points="23 7 16 12 23 17 23 7"/>
            <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
          </svg>
        </ToolbarBtn>
        )}

        {/* Ghi âm giọng nói */}
        <ToolbarBtn
          onClick={handleVoiceToggle}
          title={isRecording ? 'Dừng & gửi ghi âm' : 'Ghi âm giọng nói'}
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
              className="ml-1 text-gray-400 hover:text-red-400 transition-colors"
              title="Huỷ ghi âm"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
        )}

        {/* Định dạng văn bản */}
        {channelCap.supportsTextStyle && (
        <ToolbarBtn onClick={() => setShowFormatBar(v => !v)} title="Định dạng" active={showFormatBar || activeFmts.size > 0}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M4 7V4h16v3"/><path d="M9 20h6"/><path d="M12 4v16"/>
          </svg>
        </ToolbarBtn>
        )}

        {/* Gửi danh thiếp */}
        {channelCap.supportsBusinessCard && (
        <ToolbarBtn onClick={() => setShowSendCard(true)} title="Gửi danh thiếp" disabled={sending}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="4" width="20" height="16" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>
            <circle cx="8" cy="15" r="1.5"/><line x1="11" y1="15" x2="16" y2="15"/>
          </svg>
        </ToolbarBtn>
        )}

        {/* Gửi thẻ ngân hàng */}
        {channelCap.supportsBankCard && (
        <ToolbarBtn onClick={() => setShowBankCard(true)} title="Gửi thẻ ngân hàng" disabled={sending}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/>
            <line x1="5" y1="15" x2="7" y2="15"/><line x1="9" y1="15" x2="13" y2="15"/>
          </svg>
        </ToolbarBtn>
        )}
        {/* Tin nhắn nhanh */}
        <div className="relative">
          <ToolbarBtn onClick={() => setShowQuickManager(v => !v)} title="Tin nhắn nhanh" active={showQuickManager}>
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
                        const isFb = account.channel === 'facebook';
                        const auth = { cookies: account.cookies, imei: account.imei, userAgent: account.user_agent };
                        const mode = isFb ? 'local' : ((localStorage.getItem(`qm_mode_${activeAccountId}`) as 'zalo' | 'local') || 'local');
                        if (!isFb) invalidateZaloQuickMessageCache(activeAccountId);
                        fetchQuickMessages(auth, activeAccountId, mode, true).then(setQuickMessages).catch(() => {});
                      }
                    }
                  }}
              />
          )}
        </div>

        <ToolbarBtn onClick={toggleLocalLabels} title={showLocalLabels ? 'Ẩn nhãn local' : 'Hiện nhãn local'}>
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
        </ToolbarBtn>

        {/* ── Pinned integration shortcuts ── */}
        {pinnedIntegrationShortcuts.length > 0 && (
          <>
            <div className="w-px h-4 bg-gray-700 mx-0.5 flex-shrink-0" />
            {pinnedIntegrationShortcuts.map(shortcut => (
              <div key={shortcut.id} className="relative flex-shrink-0">
                <ToolbarBtn
                  onClick={() => {
                    setPinnedCtxMenu(null);
                    setPinnedEditIconId(null);
                    openIntegrationPanelTo(shortcut.integrationId, shortcut.action);
                  }}
                  title={`${shortcut.icon} ${shortcut.actionLabel} (${shortcut.integrationName})\nChuột phải để sửa / xóa`}
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

                {/* Icon edit picker (opens after choosing "Đổi icon" from context menu) */}
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
        <div ref={aiMenuRef} className="relative">
          <ToolbarBtn
            onClick={() => {
              setShowStickerPicker(false);
              setShowAiMenu(v => !v);
            }}
            title="Gợi ý AI"
            active={aiSuggestionsEnabled && !(activeAccountId && activeThreadId && isAiSuggestDisabled(activeAccountId, activeThreadId))}
          >
            <span className="text-sm leading-none relative">
                🤖
              <span className="absolute bottom-3 left-2">✨</span>
            </span>
          </ToolbarBtn>
          {showAiMenu && (
            <div className="absolute bottom-full left-0 mb-2 w-64 overflow-hidden rounded-2xl border border-purple-500/20 bg-gray-800/95 shadow-2xl shadow-black/40 backdrop-blur z-50">
              <div className="border-b border-purple-500/10 bg-gradient-to-r from-purple-500/10 via-transparent to-transparent px-3 py-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-purple-500">Gợi ý AI</p>
                <p className="mt-0.5 text-[11px] text-gray-400">Tuỳ chỉnh nhanh cho hội thoại hiện tại</p>
              </div>
              <button
                onClick={() => { setAiSuggestionsEnabled(!aiSuggestionsEnabled); setShowAiMenu(false); }}
                className="w-full text-left px-3 py-2.5 hover:bg-purple-500/10 flex items-center gap-2.5 transition-colors"
              >
                <span className={`w-4 h-4 rounded-md border ${aiSuggestionsEnabled ? 'bg-blue-500 border-blue-500 shadow-sm shadow-blue-900/40' : 'border-gray-500 bg-gray-800'} flex items-center justify-center flex-shrink-0`}>
                  {aiSuggestionsEnabled && <span className="text-white-important text-[8px]">✓</span>}
                </span>
                <span className="text-gray-200 leading-5">Bật gợi ý AI (toàn bộ)</span>
              </button>
              {activeAccountId && activeThreadId && (
                <>
                  <div className="mx-3 border-t border-gray-700/80" />
                  <button
                    onClick={() => { toggleAiDisableForThread(activeAccountId, activeThreadId); setShowAiMenu(false); }}
                    className="w-full text-left px-3 py-2.5 hover:bg-purple-500/10 flex items-center gap-2.5 transition-colors"
                  >
                    <span className={`w-4 h-4 rounded-md border ${isAiSuggestDisabled(activeAccountId, activeThreadId) && !useAppStore.getState().aiSuggestDisabledAccounts[activeAccountId] ? 'bg-red-500 border-red-500 shadow-sm shadow-red-900/40' : 'border-gray-500 bg-gray-800'} flex items-center justify-center flex-shrink-0`}>
                      {isAiSuggestDisabled(activeAccountId, activeThreadId) && !useAppStore.getState().aiSuggestDisabledAccounts[activeAccountId] && <span className="text-white-important text-[8px]">✓</span>}
                    </span>
                    <span className="text-gray-200 leading-5">Tắt ở hội thoại này</span>
                  </button>
                </>
              )}
              {activeAccountId && (
                <button
                  onClick={() => { toggleAiDisableForAccount(activeAccountId); setShowAiMenu(false); }}
                  className="w-full text-left px-3 py-2.5 hover:bg-purple-500/10 flex items-center gap-2.5 transition-colors"
                >
                  <span className={`w-4 h-4 rounded-md border ${useAppStore.getState().aiSuggestDisabledAccounts[activeAccountId] ? 'bg-red-500 border-red-500 shadow-sm shadow-red-900/40' : 'border-gray-500 bg-gray-800'} flex items-center justify-center flex-shrink-0`}>
                    {useAppStore.getState().aiSuggestDisabledAccounts[activeAccountId] && <span className="text-white-important text-[8px]">✓</span>}
                  </span>
                  <span className="text-gray-200 leading-5">Tắt toàn bộ tài khoản này</span>
                </button>
              )}
            </div>
          )}
        </div>

        {/* Thêm tính năng — nhóm: poll/note/nhắc hẹn; user: chỉ nhắc hẹn */}
        <div className="relative">
          <ToolbarBtn
            ref={moreMenuBtnRef}
            onClick={() => setShowMoreMenu(v => !v)}
            title="Thêm tính năng"
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

        </div>

      </div>

      {/* ── Format bar (expandable) ── */}
      {showFormatBar && (
        <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-700/50 flex-wrap">
          {/* Bold */}
          <FmtBtn active={activeFmts.has('b')} onClick={() => applyFormat('b')} title="Đậm (Ctrl+B)">
            <span className="font-bold text-sm leading-none">B</span>
          </FmtBtn>
          {/* Italic */}
          <FmtBtn active={activeFmts.has('i')} onClick={() => applyFormat('i')} title="Nghiêng (Ctrl+I)">
            <span className="italic text-sm leading-none">I</span>
          </FmtBtn>
          {/* Underline */}
          <FmtBtn active={activeFmts.has('u')} onClick={() => applyFormat('u')} title="Gạch dưới (Ctrl+U)">
            <span className="underline text-sm leading-none">U</span>
          </FmtBtn>
          {/* Strikethrough */}
          <FmtBtn active={activeFmts.has('s')} onClick={() => applyFormat('s')} title="Gạch ngang">
            <span className="line-through text-sm leading-none">S</span>
          </FmtBtn>

          <div className="w-px h-4 bg-gray-600 mx-1" />

          {/* Font size */}
          <FmtBtn active={activeFmts.has('f_13')} onClick={() => applyFormat('f_13')} title="Chữ nhỏ">
            <span className="text-xs leading-none font-medium">A</span>
          </FmtBtn>
          <FmtBtn active={activeFmts.has('f_18')} onClick={() => applyFormat('f_18')} title="Chữ lớn">
            <span className="text-base leading-none font-medium">A</span>
          </FmtBtn>

          <div className="w-px h-4 bg-gray-600 mx-1" />

          {/* Colors */}
          {([
            { st: 'c_db342e', color: '#db342e', label: 'Đỏ' },
            { st: 'c_f27806', color: '#f27806', label: 'Cam' },
            { st: 'c_f7b503', color: '#f7b503', label: 'Vàng' },
            { st: 'c_15a85f', color: '#15a85f', label: 'Xanh lá' },
          ] as const).map(({ st, color, label }) => (
            <button
              key={st}
              onMouseDown={(e) => { e.preventDefault(); applyFormat(st); }}
              title={label}
              className={`w-5 h-5 rounded-full border-2 transition-all hover:scale-110 ${activeFmts.has(st) ? 'border-white scale-110' : 'border-transparent'}`}
              style={{ backgroundColor: color }}
            />
          ))}

          <div className="w-px h-4 bg-gray-600 mx-1" />

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
                title="Xóa tất cả định dạng"
              className="text-xs text-gray-400 hover:text-red-400 px-1.5 py-0.5 rounded hover:bg-gray-700 transition-colors"
            >✕ Xóa định dạng</button>
          )}

          {/* Hint: select text to apply */}
          {fmtRanges.length === 0 && (
            <span className="text-xs text-gray-500 ml-auto">Chọn văn bản rồi bấm định dạng</span>
          )}
          {fmtRanges.length > 0 && (
            <span className="text-xs text-blue-400 ml-auto">
              {fmtRanges.length} định dạng đang áp dụng
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

      {/* Create Poll Dialog — group only */}
      {showCreatePoll && activeThreadId && activeAccountId && (
        <CreatePollDialog
          groupId={activeThreadId}
          activeAccountId={activeAccountId}
          onClose={() => setShowCreatePoll(false)}
        />
      )}

      {/* Create Note Modal — group only */}
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
        {/* Quick message dropdown — show whenever / is typed at start */}
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

        {/* @ Mention dropdown — chỉ hiện cho nhóm */}
        {showMentionDropdown && filteredMentions.length > 0 && isGroupThread && (
          <div
            ref={mentionListRef}
            className="absolute bottom-full left-3 right-3 mb-1 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-30 overflow-hidden"
            style={{ maxHeight: '240px', overflowY: 'auto' }}
          >
            <p className="text-xs text-gray-500 px-3 py-1.5 border-b border-gray-700 sticky top-0 bg-gray-800 z-10">
              Nhắc đến thành viên{mentionSearch ? ` — "${mentionSearch}"` : ''}
            </p>
            {filteredMentions.map((member, idx) => (
              <button
                key={member.userId}
                onClick={() => handleSelectMention(member)}
                className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${idx === mentionSelectedIdx ? 'bg-gray-700' : 'hover:bg-gray-700'}`}
              >
                {member.avatar ? (
                  <img src={member.avatar} alt="" className="w-7 h-7 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                    {(member.displayName || 'U').charAt(0).toUpperCase()}
                  </div>
                )}
                <p className="text-sm text-white truncate flex-1">{member.displayName}</p>
              </button>
            ))}
          </div>
        )}

        {/* Rich-text editor (contenteditable) */}
        <div className="relative flex-1" style={{ minHeight: '36px', maxHeight: '128px' }}>
          {/* Placeholder */}
          {!text && (
            <span
              className="absolute inset-0 text-gray-500 text-sm pointer-events-none select-none flex items-center px-0"
              style={{ top: 0 }}
            >
              {account ? 'Nhập @tên để tag, Shift+Enter xuống dòng, Enter gửi...' : 'Nhập tin nhắn...'}
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
            className="w-full bg-transparent text-gray-200 text-sm focus:outline-none overflow-y-auto"
            style={{ minHeight: '32px', maxHeight: '128px', wordBreak: 'break-word', whiteSpace: 'pre-wrap', lineHeight: '1.5' }}
            spellCheck={false}
          />
        </div>

        {/* Emoji button — cạnh nút like/gửi */}
        <div ref={emojiPickerRef} className="relative flex-shrink-0">
          <button
            onMouseDown={(e) => { e.preventDefault(); setShowEmojiPicker(v => !v); setShowStickerPicker(false); }}
            title="Biểu cảm"
            className={`w-9 h-9 rounded-lg flex items-center justify-center text-xl transition-colors ${showEmojiPicker ? 'bg-blue-600' : 'hover:bg-gray-700'}`}
          >
            😊
          </button>
          {showEmojiPicker && (
            <div
              className="absolute bottom-12 right-0 bg-gray-800 border border-gray-600 rounded-2xl shadow-2xl z-30 w-80 overflow-hidden"
            >
              {/* Emoji sections - vertical scroll */}
              <div className="max-h-72 overflow-y-auto p-2 space-y-3">
                {Object.entries(EMOJI_CATEGORIES).map(([category, emojis]) => (
                  <div key={category}>
                    <p className="text-[11px] text-gray-500 font-medium mb-1.5 px-1">{category}</p>
                    <div className="grid grid-cols-8 gap-0.5">
                      {emojis.map((emoji, idx) => (
                        <button
                          key={`${category}-${emoji}-${idx}`}
                          onMouseDown={(e) => { e.preventDefault(); insertEmoji(emoji); }}
                          className="text-xl hover:bg-gray-700 rounded-lg p-1 transition-colors aspect-square flex items-center justify-center hover:scale-110"
                          title={emoji}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Send or Like */}
        {(text.trim() || clipboardImages.length > 0) ? (
          <button
            onClick={handleSend}
            disabled={sending}
            className={`flex-shrink-0 w-9 h-9 rounded-lg disabled:opacity-50 flex items-center justify-center text-white transition-colors ${isUrlOnly(text.trim()) && clipboardImages.length === 0 ? 'bg-green-600 hover:bg-green-700' : 'bg-blue-600 hover:bg-blue-700'}`}
            title={isUrlOnly(text.trim()) && clipboardImages.length === 0 ? 'Gửi link (Enter)' : 'Gửi (Enter)'}
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
            className="flex-shrink-0 w-9 h-9 rounded-lg hover:bg-gray-700 flex items-center justify-center text-blue-400 hover:text-blue-300 transition-colors text-xl"
            title="Gửi 👍"
          >
            👍
          </button>
        )}
      </div>

      {/* Chế độ Gộp trang: hiển thị đang trả lời từ tài khoản nào */}
      {mergedInboxMode && activeAccountId && (() => {
        const ownerAcc = allAccounts.find(a => a.zalo_id === activeAccountId);
        if (!ownerAcc) return null;
        return (
          <div className="flex items-center gap-2 px-3 py-1.5 bg-blue-950/50 border-t border-blue-900/40">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400 flex-shrink-0">
              <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/>
            </svg>
            <span className="text-[11px] text-gray-400 flex-shrink-0">Đang trả lời từ:</span>
            {ownerAcc.avatar_url
              ? <img src={ownerAcc.avatar_url} alt="" className="w-4 h-4 rounded-full object-cover flex-shrink-0" />
              : <div className="w-4 h-4 rounded-full bg-blue-600 flex items-center justify-center text-white text-[7px] font-bold flex-shrink-0">{(ownerAcc.full_name || ownerAcc.zalo_id).charAt(0).toUpperCase()}</div>
            }
            <span className="text-[11px] text-blue-300 font-medium truncate">{ownerAcc.full_name || ownerAcc.zalo_id}</span>
          </div>
        );
      })()}
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
      className="absolute bottom-full left-0 mb-2 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl z-50 py-1.5 w-44 overflow-hidden"
      onClick={e => e.stopPropagation()}
    >
      <button
        onClick={onEditIcon}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-700 transition-colors"
      >
        <span className="text-base">✏️</span>
        <span>Đổi icon</span>
      </button>
      <div className="h-px bg-gray-700/60 mx-2 my-0.5" />
      <button
        onClick={onDelete}
        className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-sm text-red-400 hover:bg-red-500/10 transition-colors"
      >
        <span className="text-base">🗑️</span>
        <span>Xóa ghim</span>
      </button>
    </div>
  );
}

// ─── Pin emoji picker (for editing pinned shortcut icons) ─────────────────────
const PIN_EMOJIS_TOOLBAR = [
  '🛒','📦','🔍','👤','📋','💳','🚚','📊','💰','🏪',
  '🟢','🍽️','⚡','🔗','🔌','⭐','📌','🏷️','💼','📱',
  '✅','🔔','📝','🎯','🔑','🗂️','💡','🔄','📈','🎁',
  '🤝','🧾','🗃️','📲','💬','🔖','🧩','⚙️','🌐','🏅',
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
      className="absolute bottom-full right-0 mb-2 bg-gray-800 border border-gray-600 rounded-xl shadow-2xl z-50 p-3 w-64"
      onClick={e => e.stopPropagation()}
    >
      <p className="text-[11px] text-gray-400 mb-2 font-medium">Chọn icon:</p>
      <div className="grid grid-cols-8 gap-0.5">
        {PIN_EMOJIS_TOOLBAR.map(emoji => (
          <button key={emoji} onClick={() => onSelect(emoji)}
            className="w-10 h-10 flex items-center justify-center text-sm rounded hover:bg-gray-700 transition-colors">
            {emoji}
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
        ${active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white hover:bg-gray-700'}`}
    >
      {children}
    </button>
  );
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function isImageMsg(msgType: string, content: string): boolean {
  // Loại trừ các msgType không phải ảnh
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
      
      // Nếu có title + href nhưng KHÔNG có params ảnh (hd/rawUrl) → đây là link/file
      if (parsed.title && parsed.href) {
        const hasImageParams = !!(paramsObj?.hd || paramsObj?.rawUrl);
        if (!hasImageParams) return false;
      }
      
      // Có params ảnh hoặc thumb hoặc href (không có title) → ảnh
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

function parseReplyContent(content: string, msgType?: string): string {
  if (!content || content === 'null') return '[Tin nhắn]';
  
  // Ưu tiên sử dụng msgType nếu có
  if (msgType === 'photo' || msgType === 'image' || msgType === 'chat.photo') return '[Hình ảnh]';
  if (msgType === 'chat.sticker') return '[Sticker]';
  if (msgType === 'chat.video.msg') return '[Video]';
  if (msgType === 'chat.voice') return '[Ghi âm]';
  if (msgType === 'chat.poll') return '[Bình chọn]';
  if (msgType === 'chat.webcontent') {
    try { if (JSON.parse(content)?.action === 'zinstant.bankcard') return '🏦 [Tài khoản ngân hàng]'; } catch {}
  }
  
  // Với share.file/share.link: parse content để lấy title
  if (msgType === 'share.file' || msgType === 'share.link' || msgType === 'file') {
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && parsed.title) {
        return `📎 ${parsed.title}`;
      }
    } catch {}
    return msgType === 'share.link' ? '[Link]' : '[File]';
  }
  
  // Phân tích content để xác định loại
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'string') return parsed;
    if (typeof parsed !== 'object' || !parsed) return String(parsed);
    
    // Parse params nếu có
    let paramsObj = parsed.params;
    if (typeof paramsObj === 'string') {
      try { paramsObj = JSON.parse(paramsObj); } catch { paramsObj = null; }
    }
    
    // 1. Kiểm tra text message trước
    if (parsed?.content && typeof parsed.content === 'string') return parsed.content;
    if (parsed?.msg && typeof parsed.msg === 'string') return parsed.msg;
    
    // 2. Kiểm tra LINK/FILE: có title + href nhưng KHÔNG có params.hd/rawUrl
    if (parsed.title && parsed.href) {
      const hasImageParams = !!(paramsObj?.hd || paramsObj?.rawUrl);
      if (!hasImageParams) {
        return `📎 ${parsed.title}`;
      }
    }
    
    // 3. Kiểm tra HÌNH ẢNH: có params.hd/rawUrl hoặc thumb
    const hasImageData = !!(paramsObj?.hd || paramsObj?.rawUrl || parsed.thumb || (parsed.href && !parsed.title));
    if (hasImageData) {
      return '[Hình ảnh]';
    }
    
    return '[Tin nhắn]';
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
    ipc.db?.getRecentStickers({ limit: 30 }).then((res) => {
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
      const res = await ipc.db?.getStickerPacks?.();
      if (res?.success && res.packs?.length) {
        setPacks(res.packs);
        return;
      }
      // Fallback: build from cached stickers grouped by cat_id
      const sumRes = await ipc.db?.getAllCachedPackSummaries?.();
      if (sumRes?.success && sumRes.packs?.length) {
        const builtPacks: StickerPack[] = sumRes.packs.map((p) => ({
          catId: p.catId,
          name: `Gói ${p.catId}`,
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
        const cacheRes = await ipc.db?.getKeywordStickers?.({ keyword: kw });
        if (cacheRes?.success && cacheRes.stickerIds?.length) {
          // Cache hit — load sticker details from stickers DB table
          const detailRes = await ipc.db?.getStickersByIds?.({ stickerIds: cacheRes.stickerIds.slice(0, 30) });
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
        ipc.db?.saveKeywordStickers?.({ keyword: kw, stickerIds: ids }).catch(() => {});

        // Step 3: Get sticker details
        const detailRes = await ipc.zalo?.getStickersDetail({ auth, stickerIds: ids.slice(0, 30) });
        const stickers: StickerDetail[] = detailRes?.response || [];
        setSearchResults(stickers);

        // Save ALL stickers to DB cache (cho kho sticker)
        if (stickers.length) {
          ipc.db?.saveStickers({ stickers }).catch(() => {});

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
          name: `Gói ${cateId}`,
          thumbUrl: catStickers[0]?.stickerUrl || '',
          stickerCount: catStickers.length,
        });
      }

      if (newPacks.length) {
        ipc.db?.saveStickerPacks?.({ packs: newPacks }).catch(() => {});
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
    if (!auth) { setStoreError('Chưa kết nối tài khoản'); return; }
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
          const cacheRes = await ipc.db?.getKeywordStickers?.({ keyword: kw });
          if (cacheRes?.success && cacheRes.stickerIds?.length) {
            ids = cacheRes.stickerIds;
          } else {
            // Call API
            const idsRes = await ipc.zalo?.getStickers({ auth, keyword: kw });
            ids = idsRes?.response || [];
            // Cache keyword → stickerIds
            if (ids.length) {
              ipc.db?.saveKeywordStickers?.({ keyword: kw, stickerIds: ids }).catch(() => {});
            }
          }

          if (!ids.length) continue;

          // Get sticker details (try DB first, then API for missing ones)
          let stickers: StickerDetail[] = [];
          const dbRes = await ipc.db?.getStickersByIds?.({ stickerIds: ids.slice(0, 30) });
          if (dbRes?.success && dbRes.stickers?.length >= ids.slice(0, 30).length * 0.8) {
            // Most stickers already in DB
            stickers = dbRes.stickers;
          } else {
            // Fetch from API
            const detailRes = await ipc.zalo?.getStickersDetail({ auth, stickerIds: ids.slice(0, 30) });
            stickers = detailRes?.response || [];
            // Save to DB
            if (stickers.length) {
              ipc.db?.saveStickers({ stickers }).catch(() => {});
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
              name: `Gói ${cid}`,
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
        setStoreError('Không tìm thấy sticker. Thử lại sau.');
        setLoadingStore(false);
        return;
      }

      // For each discovered pack, try to fetch full category details (max 10)
      const packsToFetchDetail = allPacks.slice(0, 10);
      for (let i = 0; i < packsToFetchDetail.length; i++) {
        const pack = packsToFetchDetail[i];
        try {
          // Check if we already have enough stickers for this pack in DB
          const dbPack = await ipc.db?.getStickersByPackId?.({ catId: pack.catId });
          if (dbPack?.success && dbPack.stickers?.length >= 5) {
            pack.stickerCount = dbPack.stickers.length;
            pack.thumbUrl = dbPack.stickers[0]?.stickerUrl || pack.thumbUrl;
            continue;
          }

          const catRes = await ipc.zalo?.getStickerCategoryDetail({ auth, cateId: pack.catId });
          const catStickers: StickerDetail[] = catRes?.response || [];
          if (catStickers.length > 0) {
            ipc.db?.saveStickers({ stickers: catStickers }).catch(() => {});
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
        ipc.db?.saveStickerPacks?.({ packs: allPacks }).catch(() => {});
        setPacks(allPacks);
      }
    } catch (err: any) {
      setStoreError('Lỗi tải kho sticker');
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
      const dbRes = await ipc.db?.getStickersByPackId?.({ catId });
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
        ipc.db?.saveStickers({ stickers }).catch(() => {});
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
    { key: 'recent' as const, label: '⏱️ Gần đây' },
    { key: 'store' as const, label: '🏪 Kho sticker' },
    { key: 'emoji' as const, label: '😊 Emoji' },
  ];

  return (
    <div
      ref={pickerRef}
      className="absolute bottom-12 left-0 w-96 bg-gray-800 border border-gray-600 rounded-2xl shadow-2xl z-30 flex flex-col overflow-hidden"
      style={{ maxHeight: '440px' }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Tabs */}
      <div className="flex border-b border-gray-700 flex-shrink-0">
        {mainTabs.map((t) => (
          <button
            key={t.key}
            onClick={() => { setTab(t.key); if (t.key === 'recent' || t.key === 'store' || t.key === 'emoji') setKeyword(''); }}
            className={`flex-1 py-2 text-[11px] font-semibold tracking-wide transition-colors ${
              (tab === t.key || (tab === 'search' && t.key === 'recent'))
                ? 'text-blue-400 border-b-2 border-blue-400'
                : 'text-gray-400 hover:text-gray-200'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Search input (always visible except emoji tab) */}
      {tab !== 'emoji' && (
        <div className="px-3 py-2 flex-shrink-0">
          <div className="flex items-center gap-2 bg-gray-700 rounded-lg px-3 py-1.5">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 flex-shrink-0">
              <circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>
            </svg>
            <input
              autoFocus
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="Tìm kiếm sticker..."
              className="flex-1 bg-transparent text-sm text-gray-200 placeholder-gray-500 focus:outline-none"
            />
            {keyword && (
              <button onClick={() => { setKeyword(''); setTab('recent'); }} className="text-gray-400 hover:text-white text-sm">✕</button>
            )}
          </div>
        </div>
      )}

      {/* Tab content */}
      {tab === 'search' ? (
        /* Search results */
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {searching ? (
            <div className="flex flex-col items-center justify-center py-8 text-gray-400">
              <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-2" />
              <span className="text-xs">Đang tìm kiếm...</span>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-gray-500 text-xs">
              😕 Không tìm thấy sticker
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500 px-1 py-1.5 font-medium">Kết quả tìm kiếm ({searchResults.length})</p>
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
            <div className="flex flex-col items-center justify-center py-8 text-gray-500 text-xs text-center">
              <span className="text-3xl mb-2">🎭</span>
              Chưa có sticker nào gần đây<br/>
              Hãy tìm kiếm hoặc mở kho sticker
            </div>
          ) : (
            <>
              <p className="text-xs text-gray-500 px-1 py-1.5 font-medium">Gần đây</p>
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
            <div className="flex flex-col items-center justify-center py-8 text-gray-400">
              <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-2" />
              <span className="text-xs">Đang tải kho sticker...</span>
            </div>
          ) : storeError && packs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-gray-500 text-xs gap-2">
              <span>⚠️ {storeError}</span>
              <button
                onClick={fetchStickerStore}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs transition-colors"
              >
                Thử lại
              </button>
            </div>
          ) : packs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-gray-500 text-xs gap-2">
              <span className="text-3xl mb-1">🏪</span>
              <span>Chưa có gói sticker nào</span>
              <button
                onClick={fetchStickerStore}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-xs transition-colors"
              >
                Tải kho sticker
              </button>
            </div>
          ) : (
            <>
              {/* Pack list — horizontal scroll */}
              <div className="flex gap-1 px-2 py-2 overflow-x-auto flex-shrink-0 border-b border-gray-700/50">
                {packs.map((pack) => (
                  <button
                    key={pack.catId}
                    onClick={() => loadPackStickers(pack.catId)}
                    className={`flex-shrink-0 w-12 h-12 rounded-xl overflow-hidden border-2 transition-all hover:scale-105 ${
                      activePackId === pack.catId
                        ? 'border-blue-400 shadow-lg shadow-blue-500/20'
                        : 'border-transparent hover:border-gray-500'
                    }`}
                    title={pack.name || `Gói ${pack.catId}`}
                  >
                    {pack.thumbUrl ? (
                      <img
                        src={pack.thumbUrl}
                        alt={pack.name}
                        className="w-full h-full object-contain bg-gray-700/50"
                        loading="lazy"
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : (
                      <div className="w-full h-full bg-gray-700/50 flex items-center justify-center text-lg">🎭</div>
                    )}
                  </button>
                ))}
                {/* Refresh button */}
                <button
                  onClick={fetchStickerStore}
                  disabled={loadingStore}
                  className="flex-shrink-0 w-12 h-12 rounded-xl border-2 border-dashed border-gray-600 hover:border-gray-400 flex items-center justify-center text-gray-500 hover:text-gray-300 transition-all"
                  title="Cập nhật kho sticker"
                >
                  {loadingStore ? (
                    <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
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
                  <div className="flex flex-col items-center justify-center py-6 text-gray-500 text-xs">
                    <span className="text-2xl mb-2">👆</span>
                    Chọn một gói sticker ở trên
                  </div>
                ) : loadingPack ? (
                  <div className="flex flex-col items-center justify-center py-6 text-gray-400">
                    <div className="w-5 h-5 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-2" />
                    <span className="text-xs">Đang tải...</span>
                  </div>
                ) : packStickers.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-6 text-gray-500 text-xs">
                    Gói sticker này trống hoặc không hỗ trợ
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
              <p className="text-[11px] text-gray-500 font-medium mb-1.5 px-1">{category}</p>
              <div className="grid grid-cols-6 gap-1">
                {emojis.map((emoji, idx) => (
                  <button
                    key={`${category}-${emoji}-${idx}`}
                    onClick={() => { onInsertEmoji?.(emoji); onClose(); }}
                    className="text-xl hover:bg-gray-700 rounded-lg p-1 transition-colors aspect-square flex items-center justify-center"
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
      className="aspect-square rounded-xl hover:bg-gray-700 flex items-center justify-center overflow-hidden transition-colors p-0.5"
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
        active ? 'bg-blue-600 text-white' : 'text-gray-400 hover:bg-gray-700 hover:text-white'
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
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="3" y="3" width="18" height="18" rx="2"/>
          <line x1="8" y1="9" x2="16" y2="9"/>
          <line x1="8" y1="13" x2="13" y2="13"/>
          <line x1="8" y1="17" x2="11" y2="17"/>
        </svg>
      ),
      label: 'Tạo bình chọn',
      sublabel: 'Khảo sát ý kiến nhóm',
      color: 'text-blue-400',
      onClick: onCreatePoll,
    },
    {
      icon: (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="16" y1="13" x2="8" y2="13"/>
          <line x1="16" y1="17" x2="8" y2="17"/>
        </svg>
      ),
      label: 'Tạo ghi chú',
      sublabel: 'Ghim thông tin quan trọng',
      color: 'text-orange-400',
      onClick: onCreateNote,
    },
  ];

  const reminderItem = {
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="12" cy="12" r="10"/>
        <polyline points="12 6 12 12 16 14"/>
      </svg>
    ),
    label: 'Tạo nhắc hẹn',
    sublabel: isGroup ? 'Nhắc nhở lịch nhóm' : 'Nhắc nhở trong hội thoại',
    color: 'text-green-400',
    onClick: onCreateReminder,
  };

  const integrationItem = {
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 2v4m0 12v4m10-10h-4M6 12H2m15.07-5.07l-2.83 2.83M9.76 14.24l-2.83 2.83m0-10.14l2.83 2.83m4.48 4.48l2.83 2.83"/>
      </svg>
    ),
    label: 'Tích hợp nhanh',
    sublabel: 'Tra cứu đơn, sản phẩm, vận chuyển...',
    color: 'text-purple-400',
    onClick: onOpenIntegration,
  };

  const noteItem = {
    icon: (
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
        <polyline points="14 2 14 8 20 8"/>
        <line x1="16" y1="13" x2="8" y2="13"/>
        <line x1="16" y1="17" x2="8" y2="17"/>
      </svg>
    ),
    label: 'Ghi chú',
    sublabel: isGroup ? 'Ghi chú nhóm & local' : 'Ghi chú local',
    color: 'text-orange-400',
    onClick: onCreateNote,
  };

  const items = isGroup
    ? [supportsPoll !== false && groupItems[0], noteItem, supportsReminder !== false && reminderItem, integrationItem].filter(Boolean)
    : [noteItem, supportsReminder !== false && reminderItem, integrationItem].filter(Boolean);

  return (
    <div
      ref={ref}
      className="absolute bottom-full right-0 mb-2 bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl z-50 w-56 py-2 overflow-hidden"
    >
      <p className="text-[11px] text-gray-500 px-4 pt-1 pb-2 font-medium uppercase tracking-wide">
        {isGroup ? 'Tính năng nhóm' : 'Tính năng'}
      </p>
      {items.map((item) => (
        <button
          key={item.label}
          onClick={item.onClick}
          className="w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-gray-700/70 cursor-pointer"
        >
          <span className={`flex-shrink-0 ${item.color}`}>{item.icon}</span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-gray-200">{item.label}</p>
            <p className="text-[11px] text-gray-500 leading-tight">{item.sublabel}</p>
          </div>
        </button>
      ))}
    </div>
  );
}

