import React, { useState, useEffect, useRef } from 'react';
import { v4 as uuidv4 } from 'uuid';
import ipc from '../../lib/ipc';
import { NODE_GROUPS, DEFAULT_CONFIGS, getNodeLabel } from './workflowConfig';
import { useAppStore } from '@/store/appStore';

interface WorkflowAIDialogProps {
  currentNodes: any[];
  currentEdges: any[];
  onApply: (nodes: any[], edges: any[]) => void;
  onClose: () => void;
}

// ── Build concise catalog of all node types for the AI system prompt ──────────
function buildNodeCatalog(): string {
  return NODE_GROUPS.map(g => {
    const items = g.items.map(it => {
      const cfgKeys = Object.keys(DEFAULT_CONFIGS[it.type] || {});
      return `  - type: "${it.type}"  |  label: "${it.label}"  |  desc: "${it.desc}"${cfgKeys.length ? `  |  config keys: [${cfgKeys.join(', ')}]` : ''}`;
    }).join('\n');
    return `## ${g.label}\n${items}`;
  }).join('\n\n');
}

// ── Build the system message ──────────────────────────────────────────────────
function buildSystemPrompt(currentNodes: any[], currentEdges: any[]): string {
  const catalog = buildNodeCatalog();
  const currentWf = JSON.stringify({ nodes: currentNodes, edges: currentEdges }, null, 2);

  return `Bạn là trợ lý AI chuyên xây dựng Workflow tự động cho phần mềm Deplao (quản lý Zalo).
Nhiệm vụ: Dựa trên yêu cầu của người dùng, trả về JSON chứa danh sách nodes và edges cần THÊM vào workflow hiện tại.

## QUY TẮC QUAN TRỌNG:
1. Chỉ trả về JSON hợp lệ, KHÔNG giải thích, KHÔNG markdown code fence.
2. Format trả về CHÍNH XÁC:
{
  "nodes": [
    {
      "id": "node_1",
      "type": "<node type từ catalog>",
      "label": "<tên hiển thị>",
      "position": { "x": <number>, "y": <number> },
      "config": { <config phù hợp với type> }
    }
  ],
  "edges": [
    {
      "source": "<node id nguồn>",
      "sourceHandle": "default",
      "target": "<node id đích>"
    }
  ]
}
3. Mỗi node PHẢI có id duy nhất (dùng node_1, node_2, ...).
4. Edges nối các node theo thứ tự logic. sourceHandle mặc định là "default". Với logic.if: dùng "true" hoặc "false".
5. Dùng biến template: {{ $trigger.content }}, {{ $trigger.threadId }}, {{ $trigger.fromId }}, {{ $trigger.fromName }}, {{ $trigger.threadType }}, {{ $prev.result }}, {{ $vars.<tên biến> }}.
6. Position: bắt đầu từ x=300, y=100, mỗi node cách nhau ~150px theo chiều dọc (y).
7. Nếu workflow hiện tại đã có nodes, đặt các node mới phía bên phải (x offset +400 so với node xa nhất).

## DANH MỤC NODE CÓ SẴN:
${catalog}

## WORKFLOW HIỆN TẠI (đã có trên canvas):
${currentWf.length > 8000 ? currentWf.substring(0, 8000) + '\n... (truncated)' : currentWf}

Hãy trả về JSON nodes & edges cần THÊM VÀO workflow.`;
}

// ── Extract JSON from AI response (handle markdown fences, etc.) ─────────────
function extractJSON(text: string): any {
  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch { /* continue */ }

  // Try extracting from markdown code fence
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch { /* continue */ }
  }

  // Try finding first { ... } block
  const braceStart = text.indexOf('{');
  const braceEnd = text.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    try {
      return JSON.parse(text.substring(braceStart, braceEnd + 1));
    } catch { /* continue */ }
  }

  return null;
}

export default function WorkflowAIDialog({ currentNodes, currentEdges, onApply, onClose }: WorkflowAIDialogProps) {
  const { showNotification, theme } = useAppStore();
  const isLight = theme === 'light';
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [assistants, setAssistants] = useState<any[]>([]);
  const [selectedAssistantId, setSelectedAssistantId] = useState<string>('');
  const [preview, setPreview] = useState<{ nodes: any[]; edges: any[] } | null>(null);
  const [error, setError] = useState('');
  const [history, setHistory] = useState<{ role: string; text: string }[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Load assistants on mount
  useEffect(() => {
    (async () => {
      try {
        // Try to get default first
        const defRes = await ipc.ai?.getDefault();
        if (defRes?.success && defRes.assistant) {
          setSelectedAssistantId(defRes.assistant.id);
        }
        // Then list all
        const listRes = await ipc.ai?.listAssistants();
        if (listRes?.success) {
          setAssistants(listRes.assistants || []);
          // If no default, pick first
          if (!defRes?.assistant && listRes.assistants.length > 0) {
            setSelectedAssistantId(listRes.assistants[0].id);
          }
        }
      } catch { /* ignore */ }
    })();
    textareaRef.current?.focus();
  }, []);

  const handleSubmit = async () => {
    if (!prompt.trim() || !selectedAssistantId) return;
    setLoading(true);
    setError('');
    setPreview(null);

    try {
      const systemPrompt = buildSystemPrompt(currentNodes, currentEdges);
      const messages = [
        { role: 'system', content: systemPrompt },
        // Include conversation history for multi-turn
        ...history.map(h => ({ role: h.role === 'user' ? 'user' : 'assistant', content: h.text })),
        { role: 'user', content: prompt },
      ];

      const res = await ipc.ai?.chat(selectedAssistantId, messages);

      if (!res?.success || !res.result) {
        setError(res?.error || 'AI không trả về kết quả');
        return;
      }

      // Parse response
      const parsed = extractJSON(res.result);
      if (!parsed || !Array.isArray(parsed.nodes)) {
        setError('AI trả về dữ liệu không đúng format. Thử mô tả rõ hơn.');
        setHistory(h => [...h, { role: 'user', text: prompt }, { role: 'assistant', text: res.result! }]);
        return;
      }

      setPreview(parsed);
      setHistory(h => [...h, { role: 'user', text: prompt }, { role: 'assistant', text: res.result! }]);
      setPrompt('');
    } catch (err: any) {
      setError(err.message || 'Lỗi gọi AI');
    } finally {
      setLoading(false);
    }
  };

  const handleApply = () => {
    if (!preview) return;

    // Calculate offset: place new nodes to the right of existing ones
    const maxX = currentNodes.length > 0
      ? Math.max(...currentNodes.map(n => (n.position?.x || 0) + 250))
      : 100;

    // Remap IDs
    const idMap: Record<string, string> = {};
    const newNodes = (preview.nodes || []).map((n: any) => {
      const newId = uuidv4();
      idMap[n.id] = newId;
      return {
        id: newId,
        type: n.type,
        label: n.label || getNodeLabel(n.type),
        position: {
          x: (n.position?.x || 300) + (currentNodes.length > 0 ? maxX - 200 : 0),
          y: n.position?.y || 100,
        },
        config: n.config || { ...(DEFAULT_CONFIGS[n.type] || {}) },
      };
    });

    const newEdges = (preview.edges || []).map((e: any) => ({
      id: uuidv4(),
      source: idMap[e.source] || e.source,
      sourceHandle: e.sourceHandle || 'default',
      target: idMap[e.target] || e.target,
    }));

    onApply(newNodes, newEdges);
    showNotification(`Đã thêm ${newNodes.length} node từ AI — nhớ Lưu!`, 'success');
    onClose();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const bgCard = isLight ? 'bg-white' : 'bg-gray-900';
  const borderCard = isLight ? 'border-gray-200' : 'border-gray-700';
  const bgInput = isLight ? 'bg-gray-50 border-gray-200' : 'bg-gray-800 border-gray-700';
  const textPrimary = isLight ? 'text-gray-900' : 'text-white';
  const textSecondary = isLight ? 'text-gray-500' : 'text-gray-400';
  const textMuted = isLight ? 'text-gray-400' : 'text-gray-600';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`${bgCard} border ${borderCard} rounded-2xl shadow-2xl w-[560px] max-h-[85vh] flex flex-col overflow-hidden`}>
        {/* Header */}
        <div className={`px-5 py-4 border-b ${borderCard} flex items-center justify-between flex-shrink-0`}>
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center text-white text-sm">
              ✨
            </div>
            <div>
              <p className={`${textPrimary} font-semibold text-sm`}>AI Workflow Builder</p>
              <p className={`${textMuted} text-[11px] mt-0.5`}>Mô tả yêu cầu → AI tạo nodes & edges tự động</p>
            </div>
          </div>
          <button onClick={onClose} className={`w-7 h-7 rounded-lg flex items-center justify-center ${textSecondary} hover:${textPrimary} hover:bg-gray-700/50 transition-colors`}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {/* Assistant picker */}
          {assistants.length > 0 && (
            <div>
              <label className={`${textSecondary} text-xs font-medium mb-1.5 block`}>Trợ lý AI</label>
              <select
                value={selectedAssistantId}
                onChange={e => setSelectedAssistantId(e.target.value)}
                className={`w-full ${bgInput} border rounded-xl px-3 py-2 text-sm ${textPrimary} outline-none focus:border-violet-500`}
              >
                {assistants.map(a => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.platform || 'openai'} — {a.model || 'default'})
                  </option>
                ))}
              </select>
            </div>
          )}

          {assistants.length === 0 && (
            <div className={`text-center py-6 ${textMuted}`}>
              <p className="text-sm mb-1">⚠ Chưa có trợ lý AI nào</p>
              <p className="text-xs">Vào <strong>Cài đặt → Trợ lý AI</strong> để tạo trợ lý trước</p>
            </div>
          )}

          {/* Conversation history */}
          {history.length > 0 && (
            <div className="space-y-2 max-h-[200px] overflow-y-auto">
              {history.map((h, i) => (
                <div key={i} className={`text-xs px-3 py-2 rounded-xl ${
                  h.role === 'user'
                    ? (isLight ? 'bg-blue-50 text-blue-700' : 'bg-blue-900/30 text-blue-300')
                    : (isLight ? 'bg-gray-100 text-gray-600' : 'bg-gray-800 text-gray-400')
                }`}>
                  <span className="font-semibold">{h.role === 'user' ? '🧑 Bạn: ' : '🤖 AI: '}</span>
                  <span className="whitespace-pre-wrap">{h.role === 'user' ? h.text : h.text.substring(0, 200) + (h.text.length > 200 ? '…' : '')}</span>
                </div>
              ))}
            </div>
          )}

          {/* Prompt input */}
          {assistants.length > 0 && (
            <div>
              <label className={`${textSecondary} text-xs font-medium mb-1.5 block`}>
                {history.length > 0 ? 'Tiếp tục yêu cầu' : 'Mô tả workflow bạn muốn tạo'}
              </label>
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={handleKeyDown}
                className={`w-full ${bgInput} border rounded-xl px-3 py-2.5 text-sm ${textPrimary} placeholder-gray-500 focus:border-violet-500 outline-none resize-none`}
                rows={4}
                placeholder="VD: Khi nhận tin nhắn chứa &quot;giá&quot;, dùng AI phân loại rồi trả lời tự động bằng ChatGPT. Nếu là hỏi giá thì gửi bảng giá, nếu khiếu nại thì gửi tin xin lỗi."
                disabled={loading}
              />
              <div className="flex items-center justify-between mt-1.5">
                <p className={`${textMuted} text-[11px]`}>Ctrl+Enter để gửi</p>
                <p className={`${textMuted} text-[11px]`}>
                  {currentNodes.length} node hiện có trên canvas
                </p>
              </div>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className={`text-xs px-3 py-2.5 rounded-xl ${isLight ? 'bg-red-50 text-red-600 border border-red-200' : 'bg-red-900/20 text-red-400 border border-red-500/30'}`}>
              ⚠ {error}
            </div>
          )}

          {/* Preview */}
          {preview && (
            <div className={`border ${isLight ? 'border-green-200 bg-green-50' : 'border-green-500/30 bg-green-900/10'} rounded-xl p-3`}>
              <p className={`text-xs font-semibold mb-2 ${isLight ? 'text-green-700' : 'text-green-400'}`}>
                ✅ AI đề xuất thêm {preview.nodes.length} node, {(preview.edges || []).length} liên kết:
              </p>
              <div className="space-y-1">
                {preview.nodes.map((n: any, i: number) => (
                  <div key={i} className={`flex items-center gap-2 text-xs ${isLight ? 'text-green-800' : 'text-green-300'}`}>
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                    <span className="font-medium">{n.label || getNodeLabel(n.type)}</span>
                    <span className={`${textMuted}`}>({n.type})</span>
                  </div>
                ))}
              </div>
              {/* Edge summary */}
              {(preview.edges || []).length > 0 && (
                <p className={`text-[11px] mt-2 ${textMuted}`}>
                  Liên kết: {(preview.edges || []).map((e: any) => `${e.source} → ${e.target}`).join(', ')}
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className={`px-5 py-4 border-t ${borderCard} flex gap-2 flex-shrink-0`}>
          <button
            onClick={onClose}
            className={`flex-1 px-4 py-2.5 ${isLight ? 'bg-gray-100 hover:bg-gray-200 text-gray-700' : 'bg-gray-800 hover:bg-gray-700 text-gray-300'} text-sm font-medium rounded-xl transition-colors`}
          >
            {preview ? 'Hủy' : 'Đóng'}
          </button>
          {preview ? (
            <button
              onClick={handleApply}
              className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-500 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Áp dụng {preview.nodes.length} node
            </button>
          ) : (
            <button
              onClick={handleSubmit}
              disabled={loading || !prompt.trim() || !selectedAssistantId}
              className="flex-1 px-4 py-2.5 bg-violet-600/30 hover:bg-violet-800 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  AI đang suy nghĩ…
                </>
              ) : (
                <>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
                  </svg>
                  Gửi cho AI
                </>
              )}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}


