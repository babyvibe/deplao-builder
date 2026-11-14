/**
 * AI reply suggestions for the composer (the "Gợi ý AI" (AI suggestions) bar above the composer): pure logic, no React (hook:
 * hooks/chat/useAiReplySuggestions; settings menu: components/chat/composer/AiSuggestionMenu).
 *
 * The bar only shows when there ARE suggestions for sure: the account has a "Gợi ý" (Suggest) assistant and the AI returned at least one line. A running AI call is only
 * shown via `loading` (a small spinner on the AI button in the toolbar). Previously every incoming message showed the "Đang gợi ý…" (Suggesting…) bar (even for
 * accounts without an assistant), then the bar disappeared / changed height → the chat frame jumped up and down.
 *  - A new message arrives while suggestions are shown: keep the old suggestions until new ones arrive (the bar does not disappear and come back).
 *  - Suggestions are remembered per conversation (including Telegram forum topics): reopening a conversation with no new message shows them right away, without calling AI.
 *  - A late result from the previous conversation does not show up in the open conversation.
 *  - Hidden (✕ / one suggestion picked) → not shown again until a new message arrives.
 * Settings (AI suggestions menu): the conversation types that get suggestions, the number of lines (default 3), the account's suggestion assistant.
 */
import { DEFAULT_COMPOSER_AI_SUGGESTIONS, MAX_AI_SUGGESTIONS, normalizeSuggestionCount } from '../../../../shared/ai/replySuggestions';
import { tr } from '../../../../shared/i18n';

export const AI_SUGGEST_DEBOUNCE_MS = 1500;
const DEFAULT_CONTEXT_MESSAGES = 30;
const CACHE_LIMIT = 100;

// ── Conversation types that get suggestions ───────────────────────────────

/** user = 1-1 chat; topic = Telegram forum topic; channel = Telegram channel; bot = chat with a Telegram bot. */
export type AiSuggestKind = 'user' | 'group' | 'topic' | 'channel' | 'bot';
export type AiSuggestKinds = Record<AiSuggestKind, boolean>;

export const AI_SUGGEST_KIND_LABEL: Record<AiSuggestKind, string> = {
  user: tr('Cá nhân'),
  group: tr('Nhóm'),
  topic: tr('Chủ đề'),
  channel: 'Kênh',
  bot: 'Bot',
};

/** As before for 1-1 chats / groups / topics; channels (posts, no one to reply to) and bots (machines) do not get suggestions by default. */
export const DEFAULT_AI_SUGGEST_KINDS: Readonly<AiSuggestKinds> = Object.freeze({ user: true, group: true, topic: true, channel: false, bot: false });

/** Value read from localStorage → all 5 types (missing = defaults). */
export function normalizeAiSuggestKinds(value: unknown): AiSuggestKinds {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const out = { ...DEFAULT_AI_SUGGEST_KINDS };
  for (const kind of Object.keys(out) as AiSuggestKind[]) {
    if (typeof raw[kind] === 'boolean') out[kind] = raw[kind] as boolean;
  }
  return out;
}

/** Number of suggested lines for the composer (1..5, default 3). */
export function normalizeComposerSuggestionCount(value: unknown): number {
  return normalizeSuggestionCount(value, DEFAULT_COMPOSER_AI_SUGGESTIONS);
}

type KindContact = {
  channel?: string | null; contact_type?: string | null; telegram_peer_type?: string | null;
  is_forum?: number | null; is_cov_bot?: number | null;
} | null | undefined;

/** Type of the open conversation (threadType 1 = group; topicId = the open forum topic). */
export function aiSuggestKindOf(contact: KindContact, threadType: number | null | undefined, topicId?: string | null): AiSuggestKind {
  const telegram = String(contact?.channel || '').startsWith('telegram');
  if (telegram) {
    if (contact?.telegram_peer_type === 'channel') return 'channel';
    if (topicId || contact?.telegram_peer_type === 'forum' || Number(contact?.is_forum) === 1) return 'topic';
    if (Number(contact?.is_cov_bot) === 1) return 'bot';
  }
  return threadType === 1 || contact?.contact_type === 'group' ? 'group' : 'user';
}

/** Conversation types available on the channel (the menu only shows the usable ones): Zalo / Facebook = personal + group. */
export function aiSuggestKindsForChannel(channel: string | null | undefined): AiSuggestKind[] {
  const ch = String(channel || '');
  if (ch === 'telegram_user') return ['user', 'group', 'topic', 'channel', 'bot'];
  if (ch === 'telegram_bot') return ['user', 'group', 'topic'];
  return ['user', 'group'];
}

// ── Context sent to AI ─────────────────────────────────────────────────────────

export interface AiSuggestionTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Latest messages → the conversation turns sent to AI: my messages = assistant; an image becomes "[Hình ảnh…]" (Image…); messages with no text are dropped. */
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

/** Context key: unchanged = the existing suggestions are still correct, no need to call AI. */
export function aiSuggestionContextHash(turns: readonly AiSuggestionTurn[]): string {
  return turns.map((turn) => `${turn.role}:${turn.content}`).join('|');
}

/** Usable suggested lines: text, drop empty / duplicates, at most `max`. */
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

// ── Suggestion memory ────────────────────────────────────────────────────────────

interface CacheEntry {
  hash: string;
  suggestions: string[];
  contextCount: number;
  /** Number of lines requested; changing "Số câu gợi ý" (number of suggestions) → call again. */
  count: number;
  /** Assistant that answered; changing the assistant → call again. */
  assistantId: string;
  /** The user hid the suggestions of this context. */
  dismissed: boolean;
}

/** Suggestions already there per conversation (key = the chatStore message key), keeps the 100 most recent conversations. */
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

/** Shared by all composers: closing / reopening the chat frame still keeps the existing suggestions. */
export const aiSuggestionCache = new AiSuggestionCache();

// ── Controller ───────────────────────────────────────────────────────────────

export interface AiReplySuggestionState {
  /** Conversation of the suggestions (message key); different from the open conversation = nothing to show. */
  key: string;
  suggestions: string[];
  /** AI call in progress. */
  loading: boolean;
  /** Error from the latest AI call ('' = no error). */
  error: string;
}

export const EMPTY_AI_SUGGESTIONS: AiReplySuggestionState = Object.freeze({ key: '', suggestions: [], loading: false, error: '' }) as AiReplySuggestionState;

export interface AiReplySuggesterDeps {
  /** The account's "Gợi ý" (Suggest) assistant (null = not set up → no AI call, nothing shown). */
  getAssistant(accountId: string): Promise<{ id?: string; contextMessageCount?: number } | null | undefined>;
  suggest(assistantId: string, turns: AiSuggestionTurn[], count: number): Promise<{ success?: boolean; suggestions?: unknown; error?: string } | null | undefined>;
  /** Messages in the chat frame (chatStore message key: `accountId_conversationId[__tg_topic__topicId]`). */
  messages(key: string): readonly any[];
  onChange(state: AiReplySuggestionState): void;
  cache?: AiSuggestionCache;
  debounceMs?: number;
}

export interface AiReplySuggestTarget {
  accountId: string | null | undefined;
  threadId: string | null | undefined;
  /** Message key of the open conversation / topic (getMessageCacheKey). */
  messagesKey: string;
  enabled: boolean;
  /** Number of suggested lines (1..5). */
  count: number;
}

type Target = { accountId: string; threadId: string; key: string; count: number };

function sameState(a: AiReplySuggestionState, b: AiReplySuggestionState): boolean {
  return a.key === b.key && a.loading === b.loading && a.error === b.error
    && a.suggestions.length === b.suggestions.length && a.suggestions.every((s, i) => s === b.suggestions[i]);
}

/** Suggestion controller of one composer: see the top of the file. */
export class AiReplySuggester {
  private state: AiReplySuggestionState = EMPTY_AI_SUGGESTIONS;
  private target: Target | null = null;
  /** Each call gets a number; switching conversation / hiding / calling a new round → the old round's result is dropped. */
  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Hidden the suggestions since the latest message. */
  private dismissed = false;
  private readonly cache: AiSuggestionCache;

  constructor(private readonly deps: AiReplySuggesterDeps) {
    this.cache = deps.cache || aiSuggestionCache;
  }

  getState(): AiReplySuggestionState {
    return this.state;
  }

  /** Opening a conversation / changing settings: drops the suggestions being shown; existing suggestions that are still valid (context + number of lines) show right away; schedules an AI call. */
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

  /** A new message (from someone else) arrives in the open conversation (any topic): call again after a short pause, merging messages that arrive in bursts. */
  newMessage(accountId: string, threadId: string): void {
    const target = this.target;
    if (!target || target.accountId !== accountId || target.threadId !== threadId) return;
    this.dismissed = false;
    this.schedule();
  }

  /** Call again right away (the suggestion assistant was just changed): the suggestions being shown are kept until the new assistant's suggestions arrive. */
  refresh(): void {
    if (!this.target) return;
    this.dismissed = false;
    this.schedule(0);
  }

  /** Hide the suggestions (✕ / one suggestion picked): not shown again until a new message arrives. */
  dismiss(): void {
    const target = this.target;
    if (!target) return;
    this.dismissed = true;
    this.cache.markDismissed(target.key);
    this.seq++;
    this.set({ ...EMPTY_AI_SUGGESTIONS, key: target.key });
  }

  /** Cancel the timer + the pending call (the composer closed / before opening another conversation). A late result still goes into memory. */
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
      // The account has no suggestion assistant set up → no AI call, nothing shown
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
      // If old suggestions are being shown, keep them until new ones arrive (the bar does not disappear and come back)
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
      const error = res?.success ? '' : (String(res?.error || '').trim() || tr('Không gọi được AI'));
      this.set({ key: target.key, suggestions, loading: false, error });
    } catch (err: any) {
      if (current()) this.set({ key: target.key, suggestions: [], loading: false, error: String(err?.message || err || tr('Không gọi được AI')) });
    }
  }
}
