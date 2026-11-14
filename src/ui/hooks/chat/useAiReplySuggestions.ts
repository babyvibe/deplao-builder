import { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import { getMessageCacheKey, useChatStore } from '@/store/chat/chatStore';
import {
  AiReplySuggester,
  EMPTY_AI_SUGGESTIONS,
  type AiReplySuggestionState,
} from '@/lib/chat/composer/aiReplySuggestions';

export interface AiReplySuggestionsView {
  /** Suggestions to show; empty = do not show the bar. */
  suggestions: string[];
  /** AI call in progress → small spinner on the AI button (the "Đang gợi ý…" (Suggesting…) bar is not shown). */
  loading: boolean;
  /** Calling again while the old suggestions are still shown (the old suggestions are dimmed). */
  refreshing: boolean;
  /** Error from the latest AI call ('' = none). */
  error: string;
  /** Suggestions hidden (✕ / picked): not shown again until a new message arrives. */
  dismiss: () => void;
  /** Call again right away (the suggestion assistant was just changed). */
  refresh: () => void;
}

const NONE: string[] = [];

/**
 * AI reply suggestions for the composer (lib/chat/composer/aiReplySuggestions): the bar only shows when the account's
 * "Gợi ý" (Suggest) assistant has returned suggestions. `enabled` = not in the comments area, a conversation is open, not turned off (all / account / conversation),
 * and the conversation type is selected in the AI suggestions menu. `topicId` = the open Telegram forum topic (the context is that topic's messages).
 */
export function useAiReplySuggestions({ accountId, threadId, topicId, enabled, count }: {
  accountId: string | null | undefined;
  threadId: string | null | undefined;
  topicId?: string | null;
  enabled: boolean;
  count: number;
}): AiReplySuggestionsView {
  const [state, setState] = useState<AiReplySuggestionState>(EMPTY_AI_SUGGESTIONS);
  const suggesterRef = useRef<AiReplySuggester | null>(null);
  if (!suggesterRef.current) {
    suggesterRef.current = new AiReplySuggester({
      getAssistant: async (account) => (await DataAccessor.getAccountAssistant(account, 'suggestion'))?.assistant || null,
      suggest: async (assistantId, turns, wanted) => ipc.ai?.suggest(assistantId, turns, wanted),
      messages: (key) => useChatStore.getState().messages[key] || NONE,
      onChange: setState,
    });
  }
  const suggester = suggesterRef.current;
  const key = accountId && threadId ? getMessageCacheKey(accountId, threadId, topicId ? String(topicId) : null) : '';

  useEffect(() => {
    suggester.open({ accountId, threadId, messagesKey: key, enabled, count });
    return () => suggester.close();
  }, [suggester, accountId, threadId, key, enabled, count]);

  // New messages from others (useZaloEvents emits 'ai:newMessage')
  useEffect(() => {
    const onNewMessage = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      suggester.newMessage(String(detail?.zaloId || ''), String(detail?.threadId || ''));
    };
    window.addEventListener('ai:newMessage', onNewMessage);
    return () => window.removeEventListener('ai:newMessage', onNewMessage);
  }, [suggester]);

  const current = enabled && !!key && state.key === key;
  const suggestions = current ? state.suggestions : NONE;
  const visible = suggestions.length > 0;

  // Bar shows / hides → composer changes height: if the chat is at the bottom, it scrolls along (useScrollFollow)
  const visibleRef = useRef(false);
  useEffect(() => {
    if (visibleRef.current === visible) return;
    visibleRef.current = visible;
    requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('ai:suggestionsBarChanged', { detail: { visible } }));
    });
  }, [visible]);

  const dismiss = useCallback(() => suggester.dismiss(), [suggester]);
  const refresh = useCallback(() => suggester.refresh(), [suggester]);
  return {
    suggestions,
    loading: current && state.loading,
    refreshing: current && state.loading && visible,
    error: current ? state.error : '',
    dismiss,
    refresh,
  };
}
