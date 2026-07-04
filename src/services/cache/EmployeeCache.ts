/**
 * EmployeeCache - In-memory cache cho employee mode.
 *
 * Lưu conversation list, recent messages, labels trong memory.
 * Khi user mở app, cache giúp hiển thị ngay lập tức (từ memory)
 * mà không cần chờ REST response.
 *
 * Khi SSE push event mới → cache tự động update.
 * Khi user refresh page → cache mất, load lại từ REST.
 *
 * Chỉ active khi mode=employee.
 */

import Logger from '../../utils/Logger';

interface ConversationsCache {
  items: any[];
  total: number;
  fetchedAt: number;
  zaloId: string;
}

interface MessagesCache {
  items: any[];
  threadId: string;
  zaloId: string;
  fetchedAt: number;
  hasMore: boolean;
}

interface LabelsCache {
  items: any[];
  fetchedAt: number;
}

interface QuickMessagesCache {
  items: any[];
  fetchedAt: number;
}

const CACHE_TTL = {
  CONVERSATIONS: 60_000,   // 1 phút
  MESSAGES: 120_000,       // 2 phút
  LABELS: 300_000,         // 5 phút
  QUICK_MSGS: 300_000,     // 5 phút
  DRAFTS: 60_000,          // 1 phút
};

class EmployeeCache {
  private static instance: EmployeeCache;

  private conversations: Map<string, ConversationsCache> = new Map();
  private messages: Map<string, MessagesCache> = new Map();
  private labels: LabelsCache | null = null;
  private quickMessages: QuickMessagesCache | null = null;
  private drafts: Map<string, any[]> = new Map();

  public static getInstance(): EmployeeCache {
    if (!EmployeeCache.instance) {
      EmployeeCache.instance = new EmployeeCache();
    }
    return EmployeeCache.instance;
  }

  // ═══════════════════════════════════════════════════════════════
  // CONVERSATIONS
  // ═══════════════════════════════════════════════════════════════

  public getConversations(zaloId: string): ConversationsCache | null {
    const cached = this.conversations.get(zaloId);
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt > CACHE_TTL.CONVERSATIONS) {
      this.conversations.delete(zaloId);
      return null;
    }
    return cached;
  }

  public setConversations(zaloId: string, items: any[], total: number): void {
    this.conversations.set(zaloId, {
      items,
      total,
      fetchedAt: Date.now(),
      zaloId,
    });
  }

  /**
   * Update 1 conversation trong cache (khi có SSE push update).
   * Dùng để refresh unread_count, last_message mà ko cần re-fetch.
   */
  public updateConversation(zaloId: string, contactId: string, updates: Partial<any>): void {
    const cached = this.conversations.get(zaloId);
    if (!cached?.items) return;

    const idx = cached.items.findIndex((c: any) =>
      c.contact_id === contactId || c.id === contactId
    );
    if (idx >= 0) {
      cached.items[idx] = { ...cached.items[idx], ...updates };
    }
  }

  public invalidateConversations(zaloId?: string): void {
    if (zaloId) {
      this.conversations.delete(zaloId);
    } else {
      this.conversations.clear();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // MESSAGES
  // ═══════════════════════════════════════════════════════════════

  public getMessages(zaloId: string, threadId: string): MessagesCache | null {
    const key = `${zaloId}:${threadId}`;
    const cached = this.messages.get(key);
    if (!cached) return null;
    if (Date.now() - cached.fetchedAt > CACHE_TTL.MESSAGES) {
      this.messages.delete(key);
      return null;
    }
    return cached;
  }

  public setMessages(zaloId: string, threadId: string, items: any[], hasMore: boolean): void {
    const key = `${zaloId}:${threadId}`;
    this.messages.set(key, {
      items,
      threadId,
      zaloId,
      fetchedAt: Date.now(),
      hasMore,
    });
  }

  /** Prepend messages (khi load more) */
  public prependMessages(zaloId: string, threadId: string, olderItems: any[]): void {
    const key = `${zaloId}:${threadId}`;
    const cached = this.messages.get(key);
    if (cached) {
      cached.items = [...olderItems, ...cached.items];
    }
  }

  /** Append a single new message (khi SSE push) */
  public appendMessage(zaloId: string, threadId: string, message: any): void {
    const key = `${zaloId}:${threadId}`;
    const cached = this.messages.get(key);
    if (cached) {
      // Tránh duplicate
      const exists = cached.items.some((m: any) =>
        m.msg_id === message.msg_id || m.cli_msg_id === message.cli_msg_id
      );
      if (!exists) {
        cached.items.push(message);
      }
    }
  }

  public invalidateMessages(zaloId?: string, threadId?: string): void {
    if (zaloId && threadId) {
      this.messages.delete(`${zaloId}:${threadId}`);
    } else if (zaloId) {
      for (const key of this.messages.keys()) {
        if (key.startsWith(`${zaloId}:`)) {
          this.messages.delete(key);
        }
      }
    } else {
      this.messages.clear();
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // LABELS
  // ═══════════════════════════════════════════════════════════════

  public getLabels(): LabelsCache | null {
    if (!this.labels) return null;
    if (Date.now() - this.labels.fetchedAt > CACHE_TTL.LABELS) {
      this.labels = null;
      return null;
    }
    return this.labels;
  }

  public setLabels(items: any[]): void {
    this.labels = { items, fetchedAt: Date.now() };
  }

  // ═══════════════════════════════════════════════════════════════
  // QUICK MESSAGES
  // ═══════════════════════════════════════════════════════════════

  public getQuickMessages(): QuickMessagesCache | null {
    if (!this.quickMessages) return null;
    if (Date.now() - this.quickMessages.fetchedAt > CACHE_TTL.QUICK_MSGS) {
      this.quickMessages = null;
      return null;
    }
    return this.quickMessages;
  }

  public setQuickMessages(items: any[]): void {
    this.quickMessages = { items, fetchedAt: Date.now() };
  }

  // ═══════════════════════════════════════════════════════════════
  // DRAFTS
  // ═══════════════════════════════════════════════════════════════

  public getDrafts(zaloId: string): any[] | null {
    const cached = this.drafts.get(zaloId);
    if (!cached) return null;
    return cached;
  }

  public setDrafts(zaloId: string, items: any[]): void {
    this.drafts.set(zaloId, items);
  }

  public updateDraft(zaloId: string, threadId: string, content: string): void {
    const drafts = this.drafts.get(zaloId) || [];
    const existing = drafts.findIndex((d: any) =>
      d.threadId === threadId || d.thread_id === threadId
    );
    if (existing >= 0) {
      drafts[existing] = { ...drafts[existing], content };
    } else {
      drafts.push({ threadId, thread_id: threadId, content });
    }
    this.drafts.set(zaloId, drafts);
  }

  // ═══════════════════════════════════════════════════════════════
  // RESET
  // ═══════════════════════════════════════════════════════════════

  public clear(): void {
    this.conversations.clear();
    this.messages.clear();
    this.labels = null;
    this.quickMessages = null;
    this.drafts.clear();
    Logger.log('[EmployeeCache] Cleared');
  }
}

export default EmployeeCache;
