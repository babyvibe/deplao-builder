/**
 * AIAssistantPage.tsx
 * Trang quản lý trợ lý AI — danh sách, tạo mới, sửa, xóa.
 * Hiển thị trong IntegrationPage khi chọn tab AI.
 */
import React, { useCallback, useEffect, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import AIAssistantDetailPage from './AIAssistantDetailPage';

const PLATFORM_META: Record<string, { label: string; color: string; icon: string }> = {
  openai:   { label: 'OpenAI',   color: 'bg-green-600',   icon: '🤖' },
  gemini:   { label: 'Gemini',   color: 'bg-blue-600',    icon: '✨' },
  claude:   { label: 'Claude',   color: 'bg-amber-600',   icon: '🟠' },
  deepseek: { label: 'DeepSeek', color: 'bg-purple-600',  icon: '🔮' },
  grok:     { label: 'Grok',     color: 'bg-orange-600',  icon: '⚡' },
  mistral:  { label: 'Mistral',  color: 'bg-sky-600',     icon: '🌀' },
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

export default function AIAssistantPage() {
  const [assistants, setAssistants] = useState<AIAssistantSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Per-account assignment
  const { accounts } = useAccountStore();
  const [accountAssignments, setAccountAssignments] = useState<Record<string, { suggestion: string | null; panel: string | null }>>({});
  const [showAccountSettings, setShowAccountSettings] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await ipc.ai?.listAssistants();
      if (res?.success) setAssistants(res.assistants || []);
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  // Load per-account assignments
  const loadAccountAssignments = useCallback(async () => {
    const result: Record<string, { suggestion: string | null; panel: string | null }> = {};
    for (const acc of accounts) {
      try {
        const res = await ipc.ai?.getAccountAssistants(acc.zalo_id);
        if (res?.success) {
          result[acc.zalo_id] = { suggestion: res.suggestion || null, panel: res.panel || null };
        }
      } catch {}
    }
    setAccountAssignments(result);
  }, [accounts]);

  useEffect(() => { if (showAccountSettings) loadAccountAssignments(); }, [showAccountSettings, loadAccountAssignments]);

  const handleSetAccountAssistant = async (zaloId: string, role: 'suggestion' | 'panel', assistantId: string | null) => {
    try {
      await ipc.ai?.setAccountAssistant(zaloId, role, assistantId);
      setAccountAssignments(prev => ({
        ...prev,
        [zaloId]: { ...prev[zaloId], [role]: assistantId },
      }));
    } catch {}
  };

  // If editing or creating → show detail page
  if (editingId || creating) {
    return (
      <AIAssistantDetailPage
        assistantId={editingId}
        onBack={() => { setEditingId(null); setCreating(false); loadList(); }}
      />
    );
  }

  const enabledAssistants = assistants.filter(a => a.enabled);

  return (
    <div className="flex flex-col h-full overflow-hidden bg-gray-900">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex-1">
            <h1 className="text-lg font-semibold text-white">🤖 Trợ lý AI</h1>
            <p className="text-xs text-gray-400 mt-0.5">
              Tạo và quản lý trợ lý AI — tùy chỉnh prompt, nạp dữ liệu sản phẩm, file kiến thức
            </p>
          </div>
          <button onClick={() => setShowAccountSettings(!showAccountSettings)}
            className={`px-3 py-2 text-sm rounded-lg transition-colors border ${
              showAccountSettings ? 'bg-blue-600/20 text-blue-400 border-blue-600/40' : 'text-gray-400 hover:text-white border-gray-600 hover:border-gray-500'
            }`}>
            👤 Gán theo tài khoản
          </button>
          <button onClick={() => setCreating(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors">
            + Tạo trợ lý
          </button>
        </div>
      </div>

      {/* Per-account assignment panel */}
      {showAccountSettings && accounts.length > 0 && (
        <div className="px-6 py-4 border-b border-gray-700/50 bg-gray-850 flex-shrink-0">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">
            Gán trợ lý theo tài khoản Zalo
          </h3>
          <p className="text-[10px] text-gray-500 mb-3">
            Mỗi tài khoản có thể dùng trợ lý khác nhau cho gợi ý tin nhắn và panel chat AI. Để trống = dùng trợ lý mặc định.
          </p>
          <div className="space-y-2 max-h-48 overflow-y-auto">
            {accounts.map(acc => {
              const assignment = accountAssignments[acc.zalo_id] || { suggestion: null, panel: null };
              return (
                <div key={acc.zalo_id} className="flex items-center gap-3 bg-gray-800 rounded-lg p-3">
                  <img src={acc.avatar_url || ''} alt="" className="w-8 h-8 rounded-full bg-gray-700 flex-shrink-0" />
                  <div className="flex-shrink-0 min-w-[120px]">
                    <p className="text-xs text-white font-medium truncate">{acc.full_name}</p>
                    <p className="text-[10px] text-gray-500">{acc.zalo_id}</p>
                  </div>
                  <div className="flex-1 grid grid-cols-2 gap-2">
                    <div>
                      <label className="text-[10px] text-gray-500 block mb-0.5">✨ Trợ lý gợi ý</label>
                      <select
                        value={assignment.suggestion || ''}
                        onChange={e => handleSetAccountAssistant(acc.zalo_id, 'suggestion', e.target.value || null)}
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-blue-500"
                      >
                        <option value="">Mặc định</option>
                        {enabledAssistants.map(a => (
                          <option key={a.id} value={a.id}>{PLATFORM_META[a.platform]?.icon} {a.name}</option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="text-[10px] text-gray-500 block mb-0.5">💬 Trợ lý panel</label>
                      <select
                        value={assignment.panel || ''}
                        onChange={e => handleSetAccountAssistant(acc.zalo_id, 'panel', e.target.value || null)}
                        className="w-full bg-gray-700 border border-gray-600 rounded px-2 py-1 text-[11px] text-white focus:outline-none focus:border-blue-500"
                      >
                        <option value="">Mặc định</option>
                        {enabledAssistants.map(a => (
                          <option key={a.id} value={a.id}>{PLATFORM_META[a.platform]?.icon} {a.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex items-center justify-center h-40">
            <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
            </svg>
          </div>
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
                      <p className="text-xs text-gray-400">{meta.label} — {a.model}</p>
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
    </div>
  );
}
