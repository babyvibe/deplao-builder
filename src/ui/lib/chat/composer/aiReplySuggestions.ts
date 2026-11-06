/**
 * Gợi ý trả lời AI cho ô soạn tin (thanh "Gợi ý AI" trên ô soạn) — phần thuần, không React (hook:
 * hooks/chat/useAiReplySuggestions; menu cài đặt: components/chat/composer/AiSuggestionMenu).
 *
 * Thanh chỉ hiện khi CHẮC CHẮN có gợi ý: tài khoản có trợ lý "Gợi ý" và AI trả về ít nhất một câu. Đang gọi AI chỉ báo
 * bằng `loading` (xoay nhỏ ở nút AI trên thanh công cụ). Trước đây mỗi tin mới tới là hiện thanh "Đang gợi ý…" (kể cả
 * tài khoản chưa có trợ lý), rồi thanh mất / đổi chiều cao → khung chat nhảy lên xuống.
 *  - Tin mới tới lúc đang hiện gợi ý: giữ gợi ý cũ tới khi có gợi ý mới (thanh không mất rồi hiện lại).
 *  - Nhớ gợi ý theo hội thoại (cả chủ đề diễn đàn Telegram): mở lại hội thoại chưa có tin mới → hiện ngay, không gọi AI.
 *  - Kết quả về muộn của hội thoại trước không hiện sang hội thoại đang mở.
 *  - Ẩn (✕ / đã chọn một gợi ý) → không hiện lại cho tới khi có tin mới.
 * Cài đặt (menu Gợi ý AI): loại hội thoại được gợi ý, số câu (mặc định 3), trợ lý gợi ý của tài khoản.
 */
import { DEFAULT_COMPOSER_AI_SUGGESTIONS, MAX_AI_SUGGESTIONS, normalizeSuggestionCount } from '../../../../shared/ai/replySuggestions';

export const AI_SUGGEST_DEBOUNCE_MS = 1500;
const DEFAULT_CONTEXT_MESSAGES = 30;
const CACHE_LIMIT = 100;

// ── Loại hội thoại được gợi ý ───────────────────────────────────────────────

/** user = chat 1-1; topic = chủ đề diễn đàn Telegram; channel = kênh Telegram; bot = chat với bot Telegram. */
export type AiSuggestKind = 'user' | 'group' | 'topic' | 'channel' | 'bot';
export type AiSuggestKinds = Record<AiSuggestKind, boolean>;

export const AI_SUGGEST_KIND_LABEL: Record<AiSuggestKind, string> = {
  user: 'Cá nhân',
  group: 'Nhóm',
  topic: 'Chủ đề',
  channel: 'Kênh',
  bot: 'Bot',
};

/** Như trước với chat 1-1 / nhóm / chủ đề; kênh (đăng bài, không trả lời ai) và bot (máy) mặc định không gợi ý. */
export const DEFAULT_AI_SUGGEST_KINDS: Readonly<AiSuggestKinds> = Object.freeze({ user: true, group: true, topic: true, channel: false, bot: false });

/** Giá trị đọc từ localStorage → đủ 5 loại (thiếu = mặc định). */
export function normalizeAiSuggestKinds(value: unknown): AiSuggestKinds {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const out = { ...DEFAULT_AI_SUGGEST_KINDS };
  for (const kind of Object.keys(out) as AiSuggestKind[]) {
    if (typeof raw[kind] === 'boolean') out[kind] = raw[kind] as boolean;
  }
  return out;
}

/** Số câu gợi ý của ô soạn tin (1..5, mặc định 3). */
export function normalizeComposerSuggestionCount(value: unknown): number {
  return normalizeSuggestionCount(value, DEFAULT_COMPOSER_AI_SUGGESTIONS);
}

type KindContact = {
  channel?: string | null; contact_type?: string | null; telegram_peer_type?: string | null;
  is_forum?: number | null; is_cov_bot?: number | null;
} | null | undefined;

/** Loại của hội thoại đang mở (threadType 1 = nhóm; topicId = chủ đề diễn đàn đang mở). */
export function aiSuggestKindOf(contact: KindContact, threadType: number | null | undefined, topicId?: string | null): AiSuggestKind {
  const telegram = String(contact?.channel || '').startsWith('telegram');
  if (telegram) {
    if (contact?.telegram_peer_type === 'channel') return 'channel';
    if (topicId || contact?.telegram_peer_type === 'forum' || Number(contact?.is_forum) === 1) return 'topic';
    if (Number(contact?.is_cov_bot) === 1) return 'bot';
  }
  return threadType === 1 || contact?.contact_type === 'group' ? 'group' : 'user';
}

/** Loại hội thoại có ở kênh (menu chỉ hiện loại dùng được): Zalo / Facebook = cá nhân + nhóm. */
export function aiSuggestKindsForChannel(channel: string | null | undefined): AiSuggestKind[] {
  const ch = String(channel || '');
  if (ch === 'telegram_user') return ['user', 'group', 'topic', 'channel', 'bot'];
  if (ch === 'telegram_bot') return ['user', 'group', 'topic'];
  return ['user', 'group'];
}

// ── Ngữ cảnh gửi AI ─────────────────────────────────────────────────────────

export interface AiSuggestionTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Tin gần nhất → lượt hội thoại gửi AI: tin mình gửi = assistant; ảnh thành "[Hình ảnh…]"; bỏ tin không có chữ. */
export function aiSuggestionContext(messages: readonly any[], contextCount: number): AiSuggestionTurn[] {
  const count = Math.max(1, Math.round(Number(contextCount) || DEFAULT_CONTEXT_MESSAGES));
  return messages.slice(-count).map((m: any): AiSuggestionTurn => {
    const role = m?.is_sent ? 'assistant' : 'user';
    const msgType = String(m?.msg_type || '');
    if (msgType === 'chat.photo' || msgType === 'photo' || msgType === 'image') return { role, content: '[Hình ảnh được gửi]' };
    const content = m?.content;
    if (typeof content === 'object' && content !== null) {
      let params: any = content.params;
      if (typeof params === 'string') { try { params = JSON.parse(params); } catch { params = null; } }
      if (params?.hd || params?.rawUrl || content.thumb) {
        const textPart = String(content.msg || content.title || '');
        return { role, content: textPart ? `[Hình ảnh kèm text: ${textPart}]` : '[Hình ảnh được gửi]' };
      }
      return { role, content: String(content.msg || content.title || '') };
    }
    return { role, content: typeof content === 'string' ? content : '' };
  }).filter((turn) => turn.content.trim());
}

/** Khoá ngữ cảnh: không đổi = gợi ý đã có vẫn đúng, khỏi gọi AI. */
export function aiSuggestionContextHash(turns: readonly AiSuggestionTurn[]): string {
  return turns.map((turn) => `${turn.role}:${turn.content}`).join('|');
}

/** Câu gợi ý dùng được: chữ, bỏ trống / trùng, tối đa `max`. */
export function cleanAiSuggestions(list: unknown, max = MAX_AI_SUGGESTIONS): string[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const text = String(item ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

// ── Bộ nhớ gợi ý ────────────────────────────────────────────────────────────

interface CacheEntry {
  hash: string;
  suggestions: string[];
  contextCount: number;
  /** Số câu đã xin; đổi "Số câu gợi ý" → gọi lại. */
  count: number;
  /** Trợ lý đã trả lời; đổi trợ lý → gọi lại. */
  assistantId: string;
  /** Người dùng đã ẩn gợi ý của ngữ cảnh này. */
  dismissed: boolean;
}

/** Gợi ý đã có theo hội thoại (khoá tin của chatStore), giữ 100 hội thoại gần nhất. */
export class AiSuggestionCache {
  private readonly entries = new Map<string, CacheEntry>();

  get(key: string): CacheEntry | undefined {
    return this.entries.get(key);
  }

  set(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > CACHE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  markDismissed(key: string): void {
    const entry = this.entries.get(key);
    if (entry) entry.dismissed = true;
  }
}

/** Dùng chung mọi ô soạn tin: đóng / mở lại khung chat vẫn còn gợi ý đã có. */
export const aiSuggestionCache = new AiSuggestionCache();

// ── Bộ điều khiển ───────────────────────────────────────────────────────────

export interface AiReplySuggestionState {
  /** Hội thoại của gợi ý (khoá tin); khác hội thoại đang mở = không có gì để hiện. */
  key: string;
  suggestions: string[];
  /** Đang gọi AI. */
  loading: boolean;
  /** Lỗi của lần gọi AI gần nhất ('' = không lỗi). */
  error: string;
}

export const EMPTY_AI_SUGGESTIONS: AiReplySuggestionState = Object.freeze({ key: '', suggestions: [], loading: false, error: '' }) as AiReplySuggestionState;

export interface AiReplySuggesterDeps {
  /** Trợ lý "Gợi ý" của tài khoản (null = chưa cài → không gọi AI, không hiện gì). */
  getAssistant(accountId: string): Promise<{ id?: string; contextMessageCount?: number } | null | undefined>;
  suggest(assistantId: string, turns: AiSuggestionTurn[], count: number): Promise<{ success?: boolean; suggestions?: unknown; error?: string } | null | undefined>;
  /** Tin đang có trong khung chat (khoá tin của chatStore: `tàiKhoản_hộiThoại[__tg_topic__chủĐề]`). */
  messages(key: string): readonly any[];
  onChange(state: AiReplySuggestionState): void;
  cache?: AiSuggestionCache;
  debounceMs?: number;
}

export interface AiReplySuggestTarget {
  accountId: string | null | undefined;
  threadId: string | null | undefined;
  /** Khoá tin của hội thoại / chủ đề đang mở (getMessageCacheKey). */
  messagesKey: string;
  enabled: boolean;
  /** Số câu gợi ý (1..5). */
  count: number;
}

type Target = { accountId: string; threadId: string; key: string; count: number };

function sameState(a: AiReplySuggestionState, b: AiReplySuggestionState): boolean {
  return a.key === b.key && a.loading === b.loading && a.error === b.error
    && a.suggestions.length === b.suggestions.length && a.suggestions.every((s, i) => s === b.suggestions[i]);
}

/** Bộ điều khiển gợi ý của một ô soạn tin — xem đầu file. */
export class AiReplySuggester {
  private state: AiReplySuggestionState = EMPTY_AI_SUGGESTIONS;
  private target: Target | null = null;
  /** Mỗi lượt gọi một số; đổi hội thoại / ẩn / gọi lượt mới → kết quả lượt cũ bỏ. */
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Đã ẩn gợi ý từ lúc có tin mới gần nhất. */
  private dismissed = false;
  private readonly cache: AiSuggestionCache;

  constructor(private readonly deps: AiReplySuggesterDeps) {
    this.cache = deps.cache || aiSuggestionCache;
  }

  getState(): AiReplySuggestionState {
    return this.state;
  }

  /** Mở hội thoại / đổi cài đặt: bỏ gợi ý đang hiện; gợi ý đã có còn đúng (ngữ cảnh + số câu) thì hiện ngay; hẹn gọi AI. */
  open({ accountId, threadId, messagesKey, enabled, count }: AiReplySuggestTarget): void {
    this.close();
    const key = accountId && threadId ? messagesKey || `${accountId}_${threadId}` : '';
    if (!enabled || !key) {
      this.set(EMPTY_AI_SUGGESTIONS);
      return;
    }
    const wanted = normalizeComposerSuggestionCount(count);
    this.target = { accountId: String(accountId), threadId: String(threadId), key, count: wanted };
    let next: AiReplySuggestionState = { ...EMPTY_AI_SUGGESTIONS, key };
    const cached = this.cache.get(key);
    if (cached && !cached.dismissed && cached.count === wanted) {
      const turns = aiSuggestionContext(this.deps.messages(key), cached.contextCount);
      if (turns.length && aiSuggestionContextHash(turns) === cached.hash) next = { key, suggestions: cached.suggestions, loading: false, error: '' };
    }
    this.set(next);
    this.schedule();
  }

  /** Tin mới (của người khác) tới hội thoại đang mở (mọi chủ đề): gọi lại sau một nhịp, gộp tin tới dồn dập. */
  newMessage(accountId: string, threadId: string): void {
    const target = this.target;
    if (!target || target.accountId !== accountId || target.threadId !== threadId) return;
    this.dismissed = false;
    this.schedule();
  }

  /** Gọi lại ngay (vừa đổi trợ lý gợi ý): gợi ý đang hiện giữ tới khi có gợi ý của trợ lý mới. */
  refresh(): void {
    if (!this.target) return;
    this.dismissed = false;
    this.schedule(0);
  }

  /** Ẩn gợi ý (✕ / đã chọn một gợi ý): không hiện lại cho tới khi có tin mới. */
  dismiss(): void {
    const target = this.target;
    if (!target) return;
    this.dismissed = true;
    this.cache.markDismissed(target.key);
    this.seq++;
    this.set({ ...EMPTY_AI_SUGGESTIONS, key: target.key });
  }

  /** Huỷ hẹn giờ + lượt gọi dở (đóng ô soạn / trước khi mở hội thoại khác). Kết quả về sau vẫn vào bộ nhớ. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.seq++;
    this.target = null;
    this.dismissed = false;
  }

  private schedule(delay = this.deps.debounceMs ?? AI_SUGGEST_DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.fetch();
    }, delay);
  }

  private stateFor(key: string): AiReplySuggestionState {
    return this.state.key === key ? this.state : { ...EMPTY_AI_SUGGESTIONS, key };
  }

  private set(next: AiReplySuggestionState): void {
    if (sameState(this.state, next)) return;
    this.state = next;
    this.deps.onChange(next);
  }

  private async fetch(): Promise<void> {
    const target = this.target;
    if (!target) return;
    const seq = ++this.seq;
    const current = () => this.seq === seq && this.target === target;
    try {
      const assistant = await this.deps.getAssistant(target.accountId);
      if (!current()) return;
      // Chưa cài trợ lý gợi ý cho tài khoản → không gọi AI, không hiện gì
      if (!assistant?.id) { this.set({ ...EMPTY_AI_SUGGESTIONS, key: target.key }); return; }
      const contextCount = Math.round(Number(assistant.contextMessageCount) || DEFAULT_CONTEXT_MESSAGES);
      const turns = aiSuggestionContext(this.deps.messages(target.key), contextCount);
      if (!turns.length) { this.set({ ...EMPTY_AI_SUGGESTIONS, key: target.key }); return; }
      const hash = aiSuggestionContextHash(turns);
      const cached = this.cache.get(target.key);
      if (cached && cached.hash === hash && cached.count === target.count && cached.assistantId === assistant.id) {
        this.set({ key: target.key, suggestions: cached.dismissed || this.dismissed ? [] : cached.suggestions, loading: false, error: '' });
        return;
      }
      // Đang hiện gợi ý cũ thì giữ tới khi có gợi ý mới (thanh không mất rồi hiện lại)
      this.set({ ...this.stateFor(target.key), loading: true, error: '' });
      const res = await this.deps.suggest(assistant.id, turns, target.count);
      const suggestions = res?.success ? cleanAiSuggestions(res.suggestions, target.count) : [];
      if (suggestions.length) {
        this.cache.set(target.key, {
          hash, suggestions, contextCount, count: target.count, assistantId: assistant.id,
          dismissed: this.dismissed && this.target === target,
        });
      }
      if (!current()) return;
      const error = res?.success ? '' : (String(res?.error || '').trim() || 'Không gọi được AI');
      this.set({ key: target.key, suggestions, loading: false, error });
    } catch (err: any) {
      if (current()) this.set({ key: target.key, suggestions: [], loading: false, error: String(err?.message || err || 'Không gọi được AI') });
    }
  }
}
