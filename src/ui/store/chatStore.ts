import { create } from 'zustand';
import ipc from "@/lib/ipc";
import type { Channel } from '@/../configs/channelConfig';

// Thông tin "đã xem" của một thread: ai đã seen + msgId cuối cùng họ seen
export interface SeenEntry {
  msgId: string;           // msgId của tin nhắn đã seen gần nhất
  seenUids: string[];      // danh sách userId đã seen (group: nhiều người, user: 1 người)
  isGroup: boolean;
}

export interface ReactionEmoji {
  total: number;
  users: Record<string, number>; // userId -> count
}
export interface ReactionData {
  total: number;
  lastReact: string;
  emoji: Record<string, ReactionEmoji>; // emojiChar -> stats
}

export interface MessageItem {
  id?: number;
  msg_id: string;
  cli_msg_id?: string;
  owner_zalo_id: string;
  thread_id: string;
  thread_type: number;
  sender_id: string;
  content: string;
  msg_type: string;
  timestamp: number;
  is_sent: number;
  attachments?: string;
  local_paths?: string;
  status: string;
  is_recalled?: number;  // 1 = tin nhắn đã thu hồi
  recalled_content?: string | null; // Nội dung gốc trước khi thu hồi
  reactions?: ReactionData | Record<string, string> | string;
  quote_data?: string;
  handled_by_employee?: string | null;  // employee_id of employee who sent/handled this message
  /** Kênh chat: 'zalo' | 'facebook'. Default 'zalo' cho backward compat */
  channel?: Channel;
}

export interface ContactItem {
  id?: number;
  owner_zalo_id: string;
  contact_id: string;
  display_name: string;
  /** Biệt danh do người dùng đặt — ưu tiên hiển thị hơn display_name */
  alias?: string;
  avatar_url: string;
  phone?: string;
  is_friend: number;
  contact_type: string;
  unread_count: number;
  last_message?: string;
  last_message_time?: number;
  isFr?: number; // 1 = bạn bè, 0 = không phải bạn bè, dùng để hiển thị icon friend ở danh sách
  /** 1 = tin nhắn cuối là do mình gửi (đã trả lời), dùng để hiển thị icon "đã trả lời" ở danh sách */
  is_replied?: number;
  /** Kênh chat: 'zalo' | 'facebook'. Default 'zalo' cho backward compat */
  channel?: Channel;
  // Facebook-specific fields (nullable)
  fb_emoji?: string;
  fb_participant_count?: number;
}

interface ChatStore {
  contacts: Record<string, ContactItem[]>; // zaloId -> contacts[]
  messages: Record<string, MessageItem[]>; // `${zaloId}_${threadId}` -> messages[]
  activeThreadId: string | null;
  activeThreadType: number;
  replyTo: MessageItem | null;
  /** Draft messages per thread: key = `${zaloId}_${threadId}` → text */
  drafts: Record<string, string>;
  /** Draft updated_at per thread: key = `${zaloId}_${threadId}` → epoch ms */
  draftTimestamps: Record<string, number>;

  /** Filter conversations by channel: 'all' | 'zalo' | 'facebook' */
  channelFilter: Channel | 'all';
  setChannelFilter: (filter: Channel | 'all') => void;
  /** Get contacts for a given account, filtered by current channelFilter */
  getFilteredContacts: (accountId: string) => ContactItem[];

  setContacts: (zaloId: string, contacts: ContactItem[]) => void;
  setMessages: (zaloId: string, threadId: string, messages: MessageItem[]) => void;
  addMessage: (zaloId: string, threadId: string, message: MessageItem) => void;
  replaceTempMessage: (zaloId: string, threadId: string, tempContent: string, realMsg: Partial<MessageItem>) => void;
  prependMessages: (zaloId: string, threadId: string, messages: MessageItem[]) => void;
  updateContact: (zaloId: string, contact: Partial<ContactItem> & { contact_id: string }) => void;
  setActiveThread: (threadId: string | null, type?: number) => void;
  incrementUnread: (zaloId: string, contactId: string) => void;
  clearUnread: (zaloId: string, contactId: string) => void;
  /** Đặt is_replied=1 + unread_count=0 cho conversation (khi mình là người gửi tin nhắn cuối) */
  markReplied: (zaloId: string, contactId: string) => void;
  /** Sync is_replied dựa trên tin nhắn cuối thực tế (gọi sau khi load messages) */
  syncRepliedState: (zaloId: string, contactId: string, ownZaloId: string) => void;
  setReplyTo: (msg: MessageItem | null) => void;
  /** Lưu draft cho thread (gọi khi chuyển thread hoặc khi text thay đổi) — debounced persist to DB */
  setDraft: (zaloId: string, threadId: string, text: string) => void;
  /** Xoá draft cho thread (gọi khi gửi tin nhắn thành công) */
  clearDraft: (zaloId: string, threadId: string) => void;
  /** Load tất cả drafts cho account từ DB — gọi khi khởi tạo hoặc switch account */
  loadDrafts: (zaloId: string) => Promise<void>;
  removeMessage: (zaloId: string, threadId: string, msgId: string) => void;
  recallMessage: (zaloId: string, msgId: string, threadId?: string) => void;
  updateMessageReaction: (zaloId: string, threadId: string, msgId: string, userId: string, icon: string) => void;
  updateLocalPaths: (zaloId: string, threadId: string, msgId: string, localPaths: Record<string, string>) => void;
  updateMessageLocalPath: (zaloId: string, threadId: string, msgId: string, localPaths: Record<string, string>) => void;
  removeContact: (zaloId: string, contactId: string) => void;
  // Typing & seen
  typingUsers: Record<string, number>;      // key=`${zaloId}_${threadId}_${userId}`, value=timestamp
  seenInfo: Record<string, SeenEntry>;       // key=`${zaloId}_${threadId}`
  setTyping: (zaloId: string, threadId: string, userId: string) => void;
  clearTypingForThread: (zaloId: string, threadId: string) => void;
  setSeen: (zaloId: string, threadId: string, seenUids: string[], msgId: string, isGroup: boolean) => void;
  // Per-account last active thread (restored when switching back)
  perAccountThread: Record<string, { threadId: string; threadType: number } | null>;
  saveAccountThread: (accountId: string, threadId: string, threadType: number) => void;
  /** Reset all chat state when switching workspace — clears messages cache, active thread, etc. */
  resetForWorkspaceSwitch: () => void;
}

export const useChatStore = create<ChatStore>((set, get) => ({
  contacts: {},
  messages: {},
  activeThreadId: null,
  activeThreadType: 0,
  replyTo: null,
  typingUsers: {},
  seenInfo: {},
  perAccountThread: {},
  drafts: {},
  draftTimestamps: {},
  channelFilter: 'all',

  setChannelFilter: (filter) => set({ channelFilter: filter }),

  getFilteredContacts: (accountId) => {
    const { contacts, channelFilter } = get();
    const list = contacts[accountId] || [];
    if (channelFilter === 'all') return list;
    return list.filter((c) => (c.channel || 'zalo') === channelFilter);
  },

  saveAccountThread: (accountId, threadId, threadType) =>
    set((state) => ({
      perAccountThread: { ...state.perAccountThread, [accountId]: { threadId, threadType } },
    })),

  resetForWorkspaceSwitch: () => set({
    contacts: {},
    messages: {},
    activeThreadId: null,
    activeThreadType: 0,
    replyTo: null,
    perAccountThread: {},
    drafts: {},
    draftTimestamps: {},
    typingUsers: {},
    seenInfo: {},
  }),

  setContacts: (zaloId, contacts) =>
    set((state) => ({ contacts: { ...state.contacts, [zaloId]: contacts } })),

  setMessages: (zaloId, threadId, messages) => {
    const key = `${zaloId}_${threadId}`;
    set((state) => {
      // Preserve recalled state: nếu tin nhắn đang bị recalled trong store hiện tại
      // mà DB chưa kịp lưu, giữ nguyên trạng thái recalled để tránh hiện lại nội dung gốc
      const existing = state.messages[key] || [];
      const recalledMap = new Map<string, MessageItem>();
      for (const m of existing) {
        if (m.is_recalled === 1) recalledMap.set(String(m.msg_id), m);
      }
      const merged = recalledMap.size > 0
        ? messages.map((m) => {
            const rec = recalledMap.get(String(m.msg_id));
            if (rec) return { ...m, is_recalled: 1, status: 'recalled', msg_type: 'recalled', content: '', recalled_content: rec.recalled_content ?? m.content };
            return m;
          })
        : messages;

      // Evict old cached threads to cap memory — keep active thread + 20 most recent
      const MAX_CACHED_THREADS = 20;
      let newMessages = { ...state.messages, [key]: merged };
      const threadKeys = Object.keys(newMessages);
      if (threadKeys.length > MAX_CACHED_THREADS) {
        const activeKey = state.activeThreadId ? `${zaloId}_${state.activeThreadId}` : null;
        // Keep current key + active key, evict oldest (by insertion order)
        const toEvict = threadKeys.filter(k => k !== key && k !== activeKey);
        const evictCount = threadKeys.length - MAX_CACHED_THREADS;
        for (let i = 0; i < evictCount && i < toEvict.length; i++) {
          delete newMessages[toEvict[i]];
        }
      }
      return { messages: newMessages };
    });
  },

  addMessage: (zaloId, threadId, message) => {
    const key = `${zaloId}_${threadId}`;
    set((state) => {
      const existing = state.messages[key] || [];
      // Deduplicate by msg_id (dùng String() để tránh type mismatch number vs string)
      const isDuplicate = existing.some((m) => String(m.msg_id) === String(message.msg_id));
      if (isDuplicate) return state;

      // Khi real sent message đến (không phải temp_), xóa temp_ message trùng nội dung
      // để tránh hiển thị 2 lần do optimistic update + self-listen echo.
      // RTF/styled messages arrive as webchat with JSON content {action:'rtf', title, params:{styles}}
      // so we compare extracted plain text to handle both plain and RTF temp messages.
      const extractDedupText = (c: string): string => {
        try {
          const p = JSON.parse(c);
          if (p?.action === 'rtf' && typeof p.title === 'string') return p.title;
          if (typeof p === 'string') return p;
        } catch {}
        return c;
      };
      let filtered = existing;
      if (message.is_sent === 1 && !message.msg_id.startsWith('temp_')) {
        const incomingText = extractDedupText(message.content);
        filtered = existing.filter(
          (m) => !(m.msg_id.startsWith('temp_') && m.is_sent === 1 && extractDedupText(m.content) === incomingText)
        );
      }

      const updated = [...filtered, message];
      // Sort by timestamp ASC to maintain chronological order
      // (needed when old messages arrive after new ones, e.g. getGroupChatHistory)
      updated.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
      return { messages: { ...state.messages, [key]: updated } };
    });
  },

  prependMessages: (zaloId, threadId, messages) => {
    const key = `${zaloId}_${threadId}`;
    set((state) => {
      const existing = state.messages[key] || [];
      const existingIds = new Set(existing.map(m => m.msg_id));
      const newMessages = messages.filter(m => !existingIds.has(m.msg_id));
      if (newMessages.length === 0) return state;
      return { messages: { ...state.messages, [key]: [...newMessages, ...existing] } };
    });
  },

  replaceTempMessage: (zaloId, threadId, tempContent, realMsg) => {
    const key = `${zaloId}_${threadId}`;
    set((state) => {
      const existing = state.messages[key] || [];
      const updated = existing.map((m) =>
        m.msg_id.startsWith('temp_') && m.content === tempContent
          ? { ...m, ...realMsg }
          : m
      );
      return { messages: { ...state.messages, [key]: updated } };
    });
  },

  updateContact: (zaloId, contact) =>
    set((state) => {
      const list = state.contacts[zaloId] || [];
      const exists = list.some((c) => c.contact_id === contact.contact_id);
      const updated = exists
        ? list.map((c) => (c.contact_id === contact.contact_id ? { ...c, ...contact } : c))
        : [
            ...list,
            {
              // Safe defaults so display_name is never undefined
              owner_zalo_id: zaloId,
              display_name: contact.contact_id || '',
              avatar_url: '',
              is_friend: 0,
              contact_type: 'user',
              unread_count: 0,
              last_message: '',
              last_message_time: 0,
              ...contact,
            } as ContactItem,
          ];
      // Sort by last_message_time desc
      updated.sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
      return { contacts: { ...state.contacts, [zaloId]: updated } };
    }),

  setActiveThread: (threadId, type = 0) =>
    set({ activeThreadId: threadId, activeThreadType: type }),

  incrementUnread: (zaloId, contactId) =>
    set((state) => {
      const list = state.contacts[zaloId] || [];
      return {
        contacts: {
          ...state.contacts,
          [zaloId]: list.map((c) =>
            c.contact_id === contactId
              ? { ...c, unread_count: (c.unread_count || 0) + 1, is_replied: 0 }
              : c
          ),
        },
      };
    }),

  clearUnread: (zaloId, contactId) =>
    set((state) => {
      const list = state.contacts[zaloId] || [];
      return {
        contacts: {
          ...state.contacts,
          [zaloId]: list.map((c) =>
            c.contact_id === contactId ? { ...c, unread_count: 0 } : c
          ),
        },
      };
    }),

  markReplied: (zaloId, contactId) =>
    set((state) => {
      const list = state.contacts[zaloId] || [];
      return {
        contacts: {
          ...state.contacts,
          [zaloId]: list.map((c) =>
            c.contact_id === contactId ? { ...c, unread_count: 0, is_replied: 1 } : c
          ),
        },
      };
    }),

  syncRepliedState: (zaloId, contactId, ownZaloId) =>
    set((state) => {
      const key = `${zaloId}_${contactId}`;
      const msgs = state.messages[key] || [];
      if (msgs.length === 0) return state;
      // Tìm tin nhắn cuối không phải system/temp
      const lastReal = [...msgs].reverse().find(m =>
        !m.msg_id.startsWith('temp_') && m.msg_type !== 'system'
      );
      if (!lastReal) return state;
      const isReplied = lastReal.sender_id === ownZaloId || lastReal.is_sent === 1 ? 1 : 0;
      const list = state.contacts[zaloId] || [];
      return {
        contacts: {
          ...state.contacts,
          [zaloId]: list.map((c) =>
            c.contact_id === contactId ? { ...c, is_replied: isReplied } : c
          ),
        },
      };
    }),

  setReplyTo: (msg) => set({ replyTo: msg }),

  setDraft: (zaloId, threadId, text) => {
    const key = `${zaloId}_${threadId}`;
    set((state) => {
      if (!text.trim()) {
        // Xoá draft nếu text rỗng
        const { [key]: _, ...restDrafts } = state.drafts;
        const { [key]: __, ...restTs } = state.draftTimestamps;
        // Persist delete to DB
        ipc?.db?.deleteDraft({ zaloId, threadId }).catch(() => {});
        return { drafts: restDrafts, draftTimestamps: restTs };
      }
      // Persist upsert to DB
      ipc?.db?.upsertDraft({ zaloId, threadId, content: text }).catch(() => {});
      return {
        drafts: { ...state.drafts, [key]: text },
        draftTimestamps: { ...state.draftTimestamps, [key]: Date.now() },
      };
    });
  },

  clearDraft: (zaloId, threadId) => {
    const key = `${zaloId}_${threadId}`;
    set((state) => {
      const { [key]: _, ...restDrafts } = state.drafts;
      const { [key]: __, ...restTs } = state.draftTimestamps;
      // Persist delete to DB
      ipc?.db?.deleteDraft({ zaloId, threadId }).catch(() => {});
      return { drafts: restDrafts, draftTimestamps: restTs };
    });
  },

  loadDrafts: async (zaloId) => {
    try {
      const res = await ipc?.db?.getDrafts({ zaloId });
      if (!res?.success || !res.drafts?.length) return;
      const newDrafts: Record<string, string> = {};
      const newTimestamps: Record<string, number> = {};
      for (const d of res.drafts) {
        const key = `${zaloId}_${d.threadId}`;
        newDrafts[key] = d.content;
        newTimestamps[key] = d.updatedAt;
      }
      set((state) => ({
        drafts: { ...state.drafts, ...newDrafts },
        draftTimestamps: { ...state.draftTimestamps, ...newTimestamps },
      }));
    } catch { /* ignore */ }
  },

  removeMessage: (zaloId, threadId, msgId) => {
    const key = `${zaloId}_${threadId}`;
    set((state) => ({
      messages: {
        ...state.messages,
        [key]: (state.messages[key] || []).filter((m) => m.msg_id !== msgId),
      },
    }));
  },

  recallMessage: (zaloId, msgId, threadId?) => {
    // Tìm trong tất cả threads nếu không biết threadId
    set((state) => {
      const updatedMessages = { ...state.messages };
      const keysToCheck = threadId
        ? [`${zaloId}_${threadId}`]
        : Object.keys(updatedMessages).filter(k => k.startsWith(zaloId + '_'));
      const msgIdStr = String(msgId);
      for (const key of keysToCheck) {
        const list = updatedMessages[key];
        if (!list) continue;
        // Match bằng msg_id HOẶC cli_msg_id
        const idx = list.findIndex(m =>
          String(m.msg_id) === msgIdStr || String(m.cli_msg_id || '') === msgIdStr
        );
        if (idx !== -1) {
          const updated = [...list];
          // Nếu đã recalled rồi (lần 2 từ webhook) → chỉ giữ nguyên, không overwrite recalled_content
          // Trường hợp handleUndo gọi trước → recalled_content đã có nội dung gốc
          // Webhook đến sau, content='', nếu overwrite thì mất recalled_content
          const alreadyRecalled = updated[idx].is_recalled === 1;
          const originalContent = alreadyRecalled
            ? (updated[idx].recalled_content ?? updated[idx].content ?? null) // preserve existing
            : (updated[idx].content || null);                                   // capture original
          updated[idx] = {
            ...updated[idx],
            msg_type: 'recalled',
            content: '',
            recalled_content: originalContent,
            status: 'recalled',
            is_recalled: 1,
          };
          updatedMessages[key] = updated;
          break;
        }
      }
      return { messages: updatedMessages };
    });
  },

  updateMessageReaction: (zaloId, threadId, msgId, userId, icon) => {
    const key = `${zaloId}_${threadId}`;
    const msgIdStr = String(msgId);
    set((state) => ({
      messages: {
        ...state.messages,
        [key]: (state.messages[key] || []).map((m) => {
          if (String(m.msg_id) !== msgIdStr) return m;

          // Parse reactions from string (comes as string from DB)
          let current: ReactionData;
          const raw = m.reactions;
          let parsed: any = {};
          if (typeof raw === 'string') {
            try { parsed = JSON.parse(raw || '{}'); } catch { parsed = {}; }
          } else if (raw && typeof raw === 'object') {
            parsed = raw;
          }

          // Detect format: new = has .emoji object, old = { userId: emojiChar }
          if (parsed && typeof parsed === 'object' && parsed.emoji && typeof parsed.emoji === 'object') {
            current = parsed as ReactionData;
          } else {
            // Migrate old format { userId: emojiChar } to new format
            current = { total: 0, lastReact: '', emoji: {} };
            for (const [uid, emo] of Object.entries(parsed as Record<string, string>)) {
              if (!emo) continue;
              if (!current.emoji[emo]) current.emoji[emo] = { total: 0, users: {} };
              current.emoji[emo].total++;
              current.emoji[emo].users[uid] = (current.emoji[emo].users[uid] || 0) + 1;
              current.total++;
              current.lastReact = emo;
            }
          }

          // Apply PHP-like reaction logic
          if (!icon) {
            // Remove user's reactions across all emojis
            for (const emo of Object.keys(current.emoji)) {
              const userCount = current.emoji[emo].users[userId] || 0;
              if (userCount > 0) {
                current.emoji[emo].total -= userCount;
                current.total -= userCount;
                delete current.emoji[emo].users[userId];
                if (current.emoji[emo].total <= 0) delete current.emoji[emo];
              }
            }
          } else {
            if (!current.emoji[icon]) {
              current.emoji[icon] = { total: 1, users: { [userId]: 1 } };
            } else {
              current.emoji[icon].total++;
              current.emoji[icon].users[userId] = (current.emoji[icon].users[userId] || 0) + 1;
            }
            current.total++;
            current.lastReact = icon;
          }

          return { ...m, reactions: { ...current } };
        }),
      },
    }));
  },

  updateMessageLocalPath: (zaloId, threadId, msgId, localPaths) => {
    const key = `${zaloId}_${threadId}`;
    const msgIdStr = String(msgId);
    set((state) => ({
      messages: {
        ...state.messages,
        [key]: (state.messages[key] || []).map((m) => {
          if (String(m.msg_id) !== msgIdStr) return m;
          let existing: Record<string, string> = {};
          if (typeof m.local_paths === 'string') {
            try { existing = JSON.parse(m.local_paths || '{}'); } catch {}
          }
          return { ...m, local_paths: JSON.stringify({ ...existing, ...localPaths }) };
        }),
      },
    }));
  },

  updateLocalPaths: (zaloId, threadId, msgId, localPaths) => {
    useChatStore.getState().updateMessageLocalPath(zaloId, threadId, msgId, localPaths);
  },

  setTyping: (zaloId, threadId, userId) => {
    const key = `${zaloId}_${threadId}_${userId}`;
    set((state) => ({ typingUsers: { ...state.typingUsers, [key]: Date.now() } }));
    // Auto-clear after 8s max (tin nhắn đến sẽ clear sớm hơn qua clearTypingForThread)
    setTimeout(() => {
      set((state) => {
        const updated = { ...state.typingUsers };
        if (updated[key] && Date.now() - updated[key] >= 9500) delete updated[key];
        return { typingUsers: updated };
      });
    }, 8000);
  },

  clearTypingForThread: (zaloId, threadId) => {
    const prefix = `${zaloId}_${threadId}_`;
    set((state) => {
      const updated = { ...state.typingUsers };
      let changed = false;
      for (const key of Object.keys(updated)) {
        if (key.startsWith(prefix)) { delete updated[key]; changed = true; }
      }
      return changed ? { typingUsers: updated } : state;
    });
  },

  setSeen: (zaloId, threadId, seenUids, msgId, isGroup) => {
    const key = `${zaloId}_${threadId}`;
    set((state) => {
      const prev = state.seenInfo[key];
      // Merge UIDs — deduplicate, keep union
      const prevUids = prev?.seenUids || [];
      const merged = Array.from(new Set([...prevUids, ...seenUids]));
      return {
        seenInfo: {
          ...state.seenInfo,
          [key]: { msgId: msgId || prev?.msgId || 'seen', seenUids: merged, isGroup },
        },
      };
    });
  },

  removeContact: (zaloId, contactId) => {
    set((state) => {
      const existing = state.contacts[zaloId] || [];
      const updated = existing.filter(c => c.contact_id !== contactId);
      // Also clear messages for that thread
      const msgKey = `${zaloId}_${contactId}`;
      const newMessages = { ...state.messages };
      delete newMessages[msgKey];
      return { contacts: { ...state.contacts, [zaloId]: updated }, messages: newMessages };
    });
  },
}));

