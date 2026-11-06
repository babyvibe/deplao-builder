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
  /** Gợi ý để hiện; rỗng = không hiện thanh. */
  suggestions: string[];
  /** Đang gọi AI → xoay nhỏ ở nút AI (không hiện thanh "Đang gợi ý…"). */
  loading: boolean;
  /** Đang gọi lại khi vẫn hiện gợi ý cũ (làm mờ gợi ý cũ). */
  refreshing: boolean;
  /** Lỗi lần gọi AI gần nhất ('' = không). */
  error: string;
  /** Ẩn gợi ý (✕ / đã chọn): không hiện lại tới khi có tin mới. */
  dismiss: () => void;
  /** Gọi lại ngay (vừa đổi trợ lý gợi ý). */
  refresh: () => void;
}

const NONE: string[] = [];

/**
 * Gợi ý trả lời AI của ô soạn tin (lib/chat/composer/aiReplySuggestions): thanh chỉ hiện khi đã có gợi ý từ trợ lý
 * "Gợi ý" của tài khoản. `enabled` = không ở phần bình luận, có hội thoại, chưa tắt (toàn bộ / tài khoản / hội thoại),
 * loại hội thoại được chọn ở menu Gợi ý AI. `topicId` = chủ đề diễn đàn Telegram đang mở (ngữ cảnh là tin của chủ đề).
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

  // Tin mới của người khác (useZaloEvents phát 'ai:newMessage')
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

  // Thanh hiện / mất → ô soạn đổi chiều cao: khung chat đang ở cuối thì cuộn theo (useScrollFollow)
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
