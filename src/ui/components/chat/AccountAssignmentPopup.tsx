import React, { useEffect, useState, useRef } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { Spinner } from '@/components/common/PageLoading';
import { AlertIcon, BotIcon, ChatIcon, LightningIcon, SparklesIcon, TargetIcon, UserIcon } from '@/components/common/icons';

const PLATFORM_META: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  openai:   { label: 'OpenAI',   color: 'bg-green-600',   icon: <BotIcon className="w-4 h-4" /> },
  gemini:   { label: 'Gemini',   color: 'bg-blue-600',    icon: <SparklesIcon className="w-4 h-4" /> },
  claude:   { label: 'Claude',   color: 'bg-amber-600',   icon: <AlertIcon className="w-4 h-4" /> },
  deepseek: { label: 'DeepSeek', color: 'bg-purple-600',  icon: <TargetIcon className="w-4 h-4" /> },
  grok:     { label: 'Grok',     color: 'bg-orange-600',  icon: <LightningIcon className="w-4 h-4" /> },
};

interface AIAssistantSummary {
  id: string;
  name: string;
  platform: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
}

export default function AccountAssignmentPopup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { accounts } = useAccountStore();
  const [assignments, setAssignments] = useState<Record<string, { suggestion: string | null; panel: string | null }>>({});
  const [assistants, setAssistants] = useState<AIAssistantSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    const promises: Promise<any>[] = [
      DataAccessor.getAssistants(),
      ...accounts.map(acc =>
        DataAccessor.getAccountAssistants(acc.zalo_id).then(res => ({ zaloId: acc.zalo_id, res }))
      ),
    ];
    Promise.all(promises).then(results => {
      const first = results[0];
      if (first?.success) setAssistants(first.assistants || []);

      const assignMap: Record<string, { suggestion: string | null; panel: string | null }> = {};
      for (let i = 1; i < results.length; i++) {
        const r = results[i] as any;
        if (r?.res?.success) {
          assignMap[r.zaloId] = {
            suggestion: r.res.suggestion || null,
            panel: r.res.panel || null,
          };
        }
      }
      setAssignments(assignMap);
    }).catch(() => {}).finally(() => setLoading(false));
  }, [open, accounts]);

  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (overlayRef.current && e.target === overlayRef.current) onClose();
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [open, onClose]);

  const handleSet = async (zaloId: string, role: 'suggestion' | 'panel', assistantId: string | null) => {
    try {
      await ipc.ai?.setAccountAssistant(zaloId, role, assistantId);
      setAssignments(prev => ({
        ...prev,
        [zaloId]: { ...prev[zaloId], [role]: assistantId },
      }));
    } catch {}
  };

  const enabledAssistants = assistants.filter(a => a.enabled);
  if (!open) return null;

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50">
      <div className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-shrink-0">
          <div>
            <h2 className="text-base font-semibold text-white"><UserIcon className="w-4 h-4 inline" /> Gán trợ lý theo tài khoản</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              Mỗi tài khoản Zalo có thể dùng trợ lý riêng cho gợi ý tin nhắn và panel chat AI. Để trống = dùng trợ lý mặc định.
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors p-1">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6">
          {loading ? (
            <div className="flex items-center justify-center h-32">
              <Spinner size={5} />
            </div>
          ) : accounts.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-10">Chưa có tài khoản Zalo nào.</p>
          ) : (
            <div className="space-y-3">
              {accounts.map(acc => {
                const assignment = assignments[acc.zalo_id] || { suggestion: null, panel: null };
                return (
                  <div key={acc.zalo_id}
                    className="flex items-center gap-4 bg-gray-900/60 rounded-xl p-4 border border-gray-700/50"
                  >
                    <img src={acc.avatar_url || ''} alt=""
                      className="w-10 h-10 rounded-full bg-gray-700 flex-shrink-0 object-cover"
                    />
                    <div className="flex-shrink-0 min-w-[130px]">
                      <p className="text-sm text-white font-medium truncate">{acc.full_name}</p>
                      <p className="text-[11px] text-gray-400">{acc.zalo_id}</p>
                    </div>
                    <div className="flex-1 grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] text-gray-400 block mb-1 font-medium"><SparklesIcon className="w-3.5 h-3.5 inline" /> Gợi ý tin nhắn</label>
                        <select
                          value={assignment.suggestion || ''}
                          onChange={e => handleSet(acc.zalo_id, 'suggestion', e.target.value || null)}
                          className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
                        >
                          <option value="">Mặc định</option>
                          {enabledAssistants.map(a => (
                            <option key={a.id} value={a.id}>{PLATFORM_META[a.platform]?.icon} {a.name}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-[10px] text-gray-400 block mb-1 font-medium"><ChatIcon className="w-4 h-4 inline" /> Panel chat AI</label>
                        <select
                          value={assignment.panel || ''}
                          onChange={e => handleSet(acc.zalo_id, 'panel', e.target.value || null)}
                          className="w-full bg-gray-700 border border-gray-600 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-blue-500"
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
          )}
        </div>

        <div className="flex justify-end px-6 py-4 border-t border-gray-700 flex-shrink-0">
          <button onClick={onClose}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            Đóng
          </button>
        </div>
      </div>
    </div>
  );
}
