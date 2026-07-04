import React, { useCallback, useEffect, useState } from 'react';
import PageLoading from '@/components/common/PageLoading';
import DataAccessor from '@/lib/data/DataAccessor';
import { useWorkspaceStore } from '@/store/workspaceStore';
import AIAssistantDetailPage from './AIAssistantDetailPage';
import AccountAssignmentPopup from '@/components/chat/AccountAssignmentPopup';

const PLATFORM_META: Record<string, { label: string; color: string; icon: string }> = {
  openai:   { label: 'OpenAI',   color: 'bg-green-600',   icon: '🤖' },
  gemini:   { label: 'Gemini',   color: 'bg-blue-600',    icon: '✨' },
  claude:   { label: 'Claude',   color: 'bg-amber-600',   icon: '🟠' },
  deepseek: { label: 'DeepSeek', color: 'bg-purple-600',  icon: '🔮' },
  grok:     { label: 'Grok',     color: 'bg-orange-600',  icon: '⚡' },
};

interface AIAssistantSummary {
  id: string;
  name: string;
  platform: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  updatedAt: number;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function AIAssistantPage() {
  const [assistants, setAssistants] = useState<AIAssistantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showAccountPopup, setShowAccountPopup] = useState(false);

  const workspaceId = useWorkspaceStore(s => s.activeWorkspaceId);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await DataAccessor.getAssistants();
      if (res?.success) setAssistants(res.assistants || []);
    } catch {}
    setLoading(false);
  }, [workspaceId]); // ← re-fetch khi chuyển workspace

  useEffect(() => { loadList(); }, [loadList]);

  if (editingId || creating) {
    return (
      <AIAssistantDetailPage
        assistantId={editingId}
        onBack={() => { setEditingId(null); setCreating(false); loadList(); }}
      />
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-gray-900">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-white">🤖 Trợ lý AI</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              Tạo và quản lý trợ lý AI - tùy chỉnh prompt, nạp dữ liệu sản phẩm, file kiến thức
            </p>
          </div>
          <button onClick={() => setShowAccountPopup(true)}
            className="px-3 py-2 text-sm rounded-lg transition-colors border text-gray-400 hover:text-white border-gray-600 hover:border-gray-500">
            👤 Gán theo tài khoản
          </button>
          <button onClick={() => setCreating(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors">
            + Tạo trợ lý
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <PageLoading variant="inline" text="Đang tải trợ lý AI..." />
        ) : assistants.length === 0 ? (
          <div className="text-center py-20">
            <div className="text-5xl mb-4">🤖</div>
            <h3 className="text-lg font-medium text-white mb-2">Chưa có trợ lý AI nào</h3>
            <p className="text-sm text-gray-400 mb-6 max-w-md mx-auto">
              Tạo trợ lý AI để tự động gợi ý câu trả lời trong chat, hỏi đáp trực tiếp và nhiều hơn nữa
            </p>
            <button onClick={() => setCreating(true)}
              className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors">
              + Tạo trợ lý đầu tiên
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {assistants.map(a => {
              const meta = PLATFORM_META[a.platform] || PLATFORM_META.openai;
              return (
                <button key={a.id}
                  onClick={() => setEditingId(a.id)}
                  className="text-left p-5 rounded-xl border border-gray-700 hover:border-blue-500 bg-gray-800 hover:bg-gray-750 transition-all group"
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-11 h-11 rounded-xl ${meta.color} flex items-center justify-center text-xl flex-shrink-0`}>
                      {meta.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-white text-sm truncate">{a.name}</span>
                        {a.isDefault && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/50 text-blue-400 font-bold flex-shrink-0">
                            MẶC ĐỊNH
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-400">{meta.label} - {a.model}</p>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center justify-between">
                    <span className={`text-xs flex items-center gap-1 ${a.enabled ? 'text-green-400' : 'text-gray-500'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${a.enabled ? 'bg-green-400' : 'bg-gray-600'}`}/>
                      {a.enabled ? 'Đang bật' : 'Đã tắt'}
                    </span>
                    <span className="text-xs text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">
                      Cấu hình →
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Assignment popup */}
      <AccountAssignmentPopup open={showAccountPopup} onClose={() => setShowAccountPopup(false)} />
    </div>
  );
}
