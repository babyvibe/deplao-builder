/**
 * AIQuickPanel.tsx
 * Side panel chat trực tiếp với AI — hiển thị bên phải khung chat.
 * Cho phép chọn trợ lý, chat hỏi đáp, insert câu trả lời vào MessageInput.
 * Tự động inject ngữ cảnh hội thoại Zalo hiện tại khi gửi câu hỏi.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  segments?: Array<{ type: 'text' | 'image'; content: any }>; // Parsed structured JSON segments
}

interface AssistantSummary {
  id: string;
  name: string;
  platform: string;
  model: string;
  isDefault: boolean;
  enabled: boolean;
  contextMessageCount?: number;
}

const PLATFORM_ICONS: Record<string, string> = {
  openai: '🤖', gemini: '✨', deepseek: '🔮', grok: '⚡',
};

const clampContextCount = (value: number) => Math.min(100, Math.max(1, Math.round(value)));

// ─── Parse structured AI JSON response (text/image segments) ─────────────────

function parseStructuredResponse(raw: string): Array<{ type: 'text' | 'image'; content: any }> | null {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed) && parsed.length > 0 &&
        parsed.every((item: any) => item && (item.type === 'text' || item.type === 'image') && item.content !== undefined)) {
      return parsed;
    }
  } catch {
    try {
      const jsonMatch = trimmed.match(/\[[\s\S]*]/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (Array.isArray(parsed) && parsed.length > 0 &&
            parsed.every((item: any) => item && (item.type === 'text' || item.type === 'image') && item.content !== undefined)) {
          return parsed;
        }
      }
    } catch {}
  }
  return null;
}

export default function AIQuickPanel({ onClose }: { onClose: () => void }) {
  const [assistants, setAssistants] = useState<AssistantSummary[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingAssistants, setLoadingAssistants] = useState(true);
  const [assistantContextMsgCount, setAssistantContextMsgCount] = useState(30);
  const [contextCountInput, setContextCountInput] = useState('30');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const { activeThreadId } = useChatStore();
  const { activeAccountId } = useAccountStore();
  const {
    aiAutoInjectZaloContext,
    setAiAutoInjectZaloContext,
    aiQuickPanelContextCountOverride,
    setAiQuickPanelContextCountOverride,
  } = useAppStore();

  // Load assistants
  useEffect(() => {
    (async () => {
      setLoadingAssistants(true);
      try {
        const res = await ipc.ai?.listAssistants();
        if (res?.success) {
          const enabled = (res.assistants || []).filter((a: AssistantSummary) => a.enabled);
          setAssistants(enabled);
          const def = enabled.find((a: AssistantSummary) => a.isDefault) || enabled[0];
          if (def) setActiveId(def.id);
        }
      } catch {}
      setLoadingAssistants(false);
    })();
  }, []);

  // Auto scroll
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Clear chat & fetch contextMessageCount when assistant changes
  useEffect(() => {
    setMessages([]);
    if (!activeId) return;

    const currentAssistant = assistants.find(a => a.id === activeId);
    const initialDefault = clampContextCount(currentAssistant?.contextMessageCount || 30);
    setAssistantContextMsgCount(initialDefault);

    (async () => {
      try {
        const res = await ipc.ai?.getAssistant(activeId);
        if (res?.success && res.assistant) {
          setAssistantContextMsgCount(clampContextCount(res.assistant.contextMessageCount || 30));
        } else {
          setAssistantContextMsgCount(initialDefault);
        }
      } catch {
        setAssistantContextMsgCount(initialDefault);
      }
    })();
  }, [activeId, assistants]);

  const effectiveContextMsgCount = aiQuickPanelContextCountOverride ?? assistantContextMsgCount;
  const isUsingAssistantDefaultContext = aiQuickPanelContextCountOverride === null;

  useEffect(() => {
    setContextCountInput(String(effectiveContextMsgCount));
  }, [effectiveContextMsgCount]);

  /** Lấy ngữ cảnh hội thoại Zalo hiện tại (trả về null nếu không có) */
  const getRawZaloChatContext = useCallback((): string | null => {
    if (!activeAccountId || !activeThreadId) return null;
    const key = `${activeAccountId}_${activeThreadId}`;
    const msgs = useChatStore.getState().messages[key] || [];
    const recent = msgs.slice(-effectiveContextMsgCount);
    if (recent.length === 0) return null;
    const contextText = recent.map((m: any) => {
      const content = typeof m.content === 'string'
        ? m.content
        : (m.content?.msg || JSON.stringify(m.content));
      return `${m.is_sent ? 'Tôi' : 'Khách'}: ${content}`;
    }).join('\n');
    return contextText || null;
  }, [activeAccountId, activeThreadId, effectiveContextMsgCount]);

  const getZaloChatContext = useCallback((): string | null => {
    if (!aiAutoInjectZaloContext) return null;
    return getRawZaloChatContext();
  }, [aiAutoInjectZaloContext, getRawZaloChatContext]);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || !activeId || loading) return;

    const userMsg: ChatMsg = { role: 'user', content: text };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    setLoading(true);

    try {
      const panelMsgs = [...messages, userMsg];

      // Auto-inject Zalo chat context nếu có thread đang active
      const msgsToSend: ChatMsg[] = [];
      const zaloContext = getZaloChatContext();
      if (zaloContext) {
        msgsToSend.push(
          { role: 'user', content: `[Ngữ cảnh hội thoại Zalo hiện tại — ${effectiveContextMsgCount} tin nhắn gần nhất]\n${zaloContext}` },
          { role: 'assistant', content: 'Đã nắm được ngữ cảnh hội thoại. Tôi sẽ trả lời dựa trên ngữ cảnh này.' },
        );
      }
      msgsToSend.push(...panelMsgs);

      const res = await ipc.ai?.chat(activeId, msgsToSend, true);
      if (res?.success && res.result) {
        const segments = parseStructuredResponse(res.result);
        setMessages(prev => [...prev, { role: 'assistant', content: res.result!, segments: segments || undefined }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${res?.error || 'Không có phản hồi'}` }]);
      }
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ Lỗi: ${e.message}` }]);
    }
    setLoading(false);
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [input, activeId, loading, messages, getZaloChatContext, effectiveContextMsgCount]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  /** Insert AI text vào MessageInput bằng cách dispatch custom event */
  const insertToChat = (text: string) => {
    window.dispatchEvent(new CustomEvent('ai:insertToChat', { detail: { text } }));
  };

  /** Tóm tắt hội thoại: lấy tin nhắn gần đây, gửi AI tóm tắt */
  const handleSummarize = useCallback(async () => {
    if (!activeId || loading) return;
    const zaloContext = getRawZaloChatContext();
    if (!zaloContext) return;
    setLoading(true);
    const summaryPrompt = `Hãy tóm tắt cuộc hội thoại sau trong 3-5 dòng, nêu rõ: chủ đề chính, yêu cầu của khách, trạng thái hiện tại.\n\n${zaloContext}`;
    const userMsg: ChatMsg = { role: 'user', content: '📑 Tóm tắt hội thoại' };
    setMessages(prev => [...prev, userMsg]);
    try {
      const res = await ipc.ai?.chat(activeId, [{ role: 'user', content: summaryPrompt }]);
      if (res?.success && res.result) {
        setMessages(prev => [...prev, { role: 'assistant', content: res.result! }]);
      } else {
        setMessages(prev => [...prev, { role: 'assistant', content: `❌ ${res?.error || 'Không có phản hồi'}` }]);
      }
    } catch (e: any) {
      setMessages(prev => [...prev, { role: 'assistant', content: `❌ Lỗi: ${e.message}` }]);
    }
    setLoading(false);
  }, [activeId, loading, getRawZaloChatContext]);

  const activeAssistant = assistants.find(a => a.id === activeId);
  const canUseZaloContext = !!(activeAccountId && activeThreadId);
  const hasZaloContext = canUseZaloContext && aiAutoInjectZaloContext;

  const applyContextCountInput = useCallback(() => {
    const trimmed = contextCountInput.trim();
    if (!trimmed) {
      setContextCountInput(String(effectiveContextMsgCount));
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      setContextCountInput(String(effectiveContextMsgCount));
      return;
    }
    const next = clampContextCount(parsed);
    setAiQuickPanelContextCountOverride(next);
    setContextCountInput(String(next));
  }, [contextCountInput, effectiveContextMsgCount, setAiQuickPanelContextCountOverride]);

  return (
    <div className="w-[330px] h-full flex flex-col bg-gray-800 border-l border-gray-700">
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-semibold text-white flex items-center gap-1.5">
            🤖 Trợ lý AI
          </h2>
          <button onClick={onClose}
            className="w-7 h-7 rounded-lg hover:bg-gray-700 flex items-center justify-center text-gray-400 hover:text-white transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Assistant selector */}
        {loadingAssistants ? (
          <div className="text-xs text-gray-500">Đang tải...</div>
        ) : assistants.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-2">
            <div className="text-3xl">🤖</div>
            <p className="text-xs text-gray-400 text-center leading-relaxed">
              Chưa có trợ lý AI nào.<br/>Tạo trợ lý để bắt đầu hỗ trợ chat thông minh.
            </p>
            <button
              onClick={() => {
                const { setView, openIntegrationPanelTo } = useAppStore.getState();
                setView('integration');
                openIntegrationPanelTo('ai-assistant', 'list');
                onClose();
              }}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold transition-colors shadow-lg shadow-blue-900/30"
            >
              ✨ Tạo trợ lý AI ngay
            </button>
            <div className="w-full pt-1 border-t border-gray-700/60">
              <p className="text-[10px] text-gray-500 text-center mb-2">Nền tảng hỗ trợ</p>
              <div className="flex justify-center gap-3">
                {[['🤖','OpenAI'],['✨','Gemini'],['🔮','DeepSeek'],['⚡','Grok']].map(([icon, name]) => (
                  <div key={name} className="flex flex-col items-center gap-0.5">
                    <span className="text-base">{icon}</span>
                    <span className="text-[9px] text-gray-500">{name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <select value={activeId} onChange={e => setActiveId(e.target.value)}
            className="w-full bg-gray-800 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500">
            {assistants.map(a => (
              <option key={a.id} value={a.id}>
                {PLATFORM_ICONS[a.platform] || '🤖'} {a.name} — {a.model}
                {a.isDefault ? ' ⭐' : ''}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Auto-context indicator + quick actions */}
      {activeId && canUseZaloContext && (
        <div className="px-3 py-2 border-b border-gray-700/50 flex-shrink-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 text-[10px] text-gray-500 min-w-0">
              <span>{hasZaloContext ? 'Ngữ cảnh bật' : 'Ngữ cảnh tắt'}</span>
              <button
                type="button"
                role="switch"
                aria-checked={hasZaloContext}
                onClick={() => setAiAutoInjectZaloContext(!aiAutoInjectZaloContext)}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${hasZaloContext ? 'bg-green-600' : 'bg-gray-600 hover:bg-gray-500'}`}
                title={hasZaloContext ? 'Tắt tự động gửi ngữ cảnh Zalo' : 'Bật tự động gửi ngữ cảnh Zalo'}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${hasZaloContext ? 'translate-x-5' : 'translate-x-1'}`}
                />
              </button>
            </div>
            <button
              onClick={handleSummarize}
              disabled={loading}
              className="text-[10px] px-2 py-0.5 rounded bg-purple-900/60 text-purple-100 hover:bg-purple-800/50 disabled:opacity-40 transition-colors flex-shrink-0"
              title="AI tóm tắt hội thoại hiện tại"
            >
              📑 Tóm tắt
            </button>
          </div>

          {hasZaloContext && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] uppercase tracking-wide text-gray-500">Số ngữ cảnh</span>
              <input
                type="number"
                min={1}
                max={100}
                step={1}
                value={contextCountInput}
                onChange={(e) => setContextCountInput(e.target.value)}
                onBlur={applyContextCountInput}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    applyContextCountInput();
                  }
                }}
                className="w-16 bg-gray-800 border border-gray-600 rounded-md px-2 py-1 text-[11px] text-white focus:outline-none focus:border-blue-500"
                title="Số lượng tin nhắn dùng làm ngữ cảnh"
              />
              <span className="text-[10px] text-gray-500">Hỗ trợ ngữ cảnh: 1–100 tin</span>
            </div>
          )}
        </div>
      )}

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && activeId && (
          <div className="text-center py-10">
            <div className="text-3xl mb-2">{PLATFORM_ICONS[activeAssistant?.platform || 'openai']}</div>
            <p className="text-xs text-gray-500">
              {canUseZaloContext
                ? (hasZaloContext
                    ? 'Hỏi bất kỳ điều gì — AI sẽ tự động nắm ngữ cảnh hội thoại Zalo hiện tại'
                    : 'Hỏi bất kỳ điều gì — đang chat với AI nội bộ, không tự gửi ngữ cảnh Zalo')
                : 'Hỏi bất kỳ điều gì — AI sẽ trả lời dựa trên prompt và dữ liệu đã cấu hình'}
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
              msg.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-200 border border-gray-700'
            }`}>
              {/* Render structured segments (text + images) or plain text */}
              {msg.segments && msg.segments.length > 0 ? (
                <div className="space-y-2">
                  {msg.segments.map((seg, si) => (
                    seg.type === 'image' && Array.isArray(seg.content) ? (
                      <div key={si} className="flex flex-wrap gap-1.5">
                        {seg.content.map((url: string, ui: number) => (
                          <img key={ui} src={url} alt="" className="max-w-full max-h-32 rounded-lg object-cover border border-gray-600/30"
                            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                        ))}
                      </div>
                    ) : seg.type === 'text' && seg.content ? (
                      <div key={si} className="whitespace-pre-wrap break-words">{seg.content}</div>
                    ) : null
                  ))}
                </div>
              ) : (
                <div className="whitespace-pre-wrap break-words">{msg.content}</div>
              )}
              {msg.role === 'assistant' && !msg.content.startsWith('❌') && (
                <div className="flex items-center gap-1.5 mt-2 pt-1.5 border-t border-gray-700/50">
                  <button onClick={() => {
                    const textToInsert = msg.segments
                      ? msg.segments.filter(s => s.type === 'text').map(s => s.content).join('\n')
                      : msg.content;
                    insertToChat(textToInsert);
                  }}
                    className="text-[10px] px-2 py-0.5 rounded bg-blue-900/40 text-blue-400 hover:bg-blue-800/50 transition-colors"
                    title="Chèn vào ô chat">
                    ✏️ Chèn vào chat
                  </button>
                  <button onClick={() => {
                    const textToCopy = msg.segments
                      ? msg.segments.filter(s => s.type === 'text').map(s => s.content).join('\n')
                      : msg.content;
                    navigator.clipboard.writeText(textToCopy);
                  }}
                    className="text-[10px] px-2 py-0.5 rounded bg-gray-700 text-gray-400 hover:text-white transition-colors"
                    title="Copy">
                    📋 Copy
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="bg-gray-800 border border-gray-700 rounded-xl px-3 py-2">
              <div className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}/>
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}/>
                <span className="w-1.5 h-1.5 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}/>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      {activeId && (
        <div className="px-3 pb-3 pt-1 flex-shrink-0">
          <div className="flex items-end gap-2 bg-gray-800 border border-gray-700 rounded-xl px-3 py-2">
            <textarea ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Nhập câu hỏi..."
              rows={1}
              className="flex-1 bg-transparent text-sm text-white placeholder-gray-500 resize-none outline-none max-h-24 overflow-y-auto"
              style={{ minHeight: '24px' }}
            />
            <button onClick={handleSend} disabled={loading || !input.trim()}
              className="w-7 h-7 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 flex items-center justify-center text-white transition-colors flex-shrink-0">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
              </svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
