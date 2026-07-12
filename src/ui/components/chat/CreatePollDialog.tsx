import React from 'react';
import { useAppStore } from '@/store/appStore';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import * as channelIpc from '../../lib/channelIpc';
import DateInputVN from '@/components/common/DateInputVN';
import { Spinner } from '@/components/common/PageLoading';

/** CreatePollDialog - tạo cuộc bình chọn mới trong nhóm */
export function CreatePollDialog({ groupId, activeAccountId, channel, onClose }: {
  groupId: string; activeAccountId: string; channel?: string; onClose: () => void;
}) {
  const [question, setQuestion] = React.useState('');
  const [options, setOptions] = React.useState(['', '']);
  const [expiredTime, setExpiredTime] = React.useState('');
  const [allowMulti, setAllowMulti] = React.useState(true);
  const [allowAdd, setAllowAdd] = React.useState(true);
  const [hidePreview, setHidePreview] = React.useState(false);
  const [isAnon, setIsAnon] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const { showNotification } = useAppStore();

  const setOption = (i: number, val: string) => setOptions(prev => prev.map((o, idx) => idx === i ? val : o));
  const addOption = () => { if (options.length < 20) setOptions(prev => [...prev, '']); };
  const removeOption = (i: number) => { if (options.length > 2) setOptions(prev => prev.filter((_, idx) => idx !== i)); };

  const handleCreate = async () => {
    const q = question.trim();
    const opts = options.map(o => o.trim()).filter(Boolean);
    if (!q) { showNotification('Vui lòng nhập câu hỏi bình chọn', 'error'); return; }
    if (opts.length < 2) { showNotification('Cần ít nhất 2 lựa chọn', 'error'); return; }
    setCreating(true);
    try {
      let res;
      if (channel === 'facebook') {
        res = await channelIpc.createPoll('facebook', {
          accountId: activeAccountId,
          threadId: groupId,
          question: q,
          options: opts,
        });
      } else {
        const accRes = await ipc.login?.getAccounts();
        const acc = accRes?.accounts?.find((a: any) => a.zalo_id === activeAccountId) || accRes?.accounts?.[0];
        if (!acc) throw new Error('No account');
        const expMs = expiredTime ? new Date(expiredTime).getTime() : 0;
        res = await ipc.zalo?.createPoll({
          auth: buildZaloAuth(acc, activeAccountId),
          options: {
            question: q,
            options: opts,
            expiredTime: expMs,
            allowMultiChoices: allowMulti,
            allowAddNewOption: allowAdd,
            hideVotePreview: hidePreview,
            isAnonymous: isAnon,
          },
          groupId,
        });
      }
      if (res?.success) {
        showNotification('Đã tạo bình chọn', 'success');
        onClose();
      } else {
        showNotification('Tạo bình chọn thất bại: ' + (res?.error || 'Lỗi không xác định'), 'error');
      }
    } catch (e: any) {
      showNotification('Lỗi: ' + e.message, 'error');
    } finally { setCreating(false); }
  };

  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-[#1e2535] rounded-2xl shadow-2xl border border-gray-700 w-full max-w-2xl mx-4 max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700 flex-shrink-0">
          <h2 className="text-white font-bold text-lg">Tạo bình chọn</h2>
          <button onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-6">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Left: question + options */}
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-300 font-medium mb-1.5 block">Chủ đề bình chọn</label>
                <textarea
                  value={question}
                  onChange={e => setQuestion(e.target.value)}
                  maxLength={200}
                  placeholder="Đặt câu hỏi bình chọn"
                  rows={3}
                  className="w-full bg-gray-800 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none"
                />
                <p className="text-right text-xs text-gray-400 mt-0.5">{question.length}/200</p>
              </div>

              <div>
                <label className="text-sm text-gray-300 font-medium mb-1.5 block">Các lựa chọn</label>
                <div className="space-y-2">
                  {options.map((opt, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <input
                        value={opt}
                        onChange={e => setOption(i, e.target.value)}
                        placeholder={`Lựa chọn ${i + 1}`}
                        className="flex-1 bg-gray-800 border border-gray-600 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
                      />
                      {options.length > 2 && (
                        <button onClick={() => removeOption(i)}
                          className="w-7 h-7 flex items-center justify-center text-gray-400 hover:text-red-400 transition-colors">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                          </svg>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {options.length < 20 && (
                  <button onClick={addOption}
                    className="mt-2 flex items-center gap-1.5 text-blue-400 hover:text-blue-300 text-sm font-medium transition-colors">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Thêm lựa chọn
                  </button>
                )}
              </div>
            </div>

            {/* Right: settings */}
            <div className="space-y-4">
              <div>
                <label className="text-sm text-gray-300 font-medium mb-1.5 block">Thời hạn bình chọn</label>
                <div className="relative">
                  <DateInputVN
                    type="datetime-local"
                    value={expiredTime}
                    onChange={e => setExpiredTime(e.target.value)}
                    min={new Date().toISOString().slice(0, 16)}
                    placeholder="Không thời hạn"
                    className="w-full bg-gray-800 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
                  />
                  {expiredTime && (
                    <button onClick={() => setExpiredTime('')}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                      </svg>
                    </button>
                  )}
                </div>
                {!expiredTime && <p className="text-xs text-gray-400 mt-1">Không giới hạn thời gian</p>}
              </div>

              <div>
                <p className="text-sm text-gray-300 font-medium mb-2">Thiết lập nâng cao</p>
                <div className="space-y-2.5">
                  <PollToggle label="Chọn nhiều phương án" checked={allowMulti} onChange={setAllowMulti} />
                  <PollToggle label="Có thể thêm phương án" checked={allowAdd} onChange={setAllowAdd} />
                </div>
              </div>

              <div>
                <p className="text-sm text-gray-300 font-medium mb-2">Bình chọn ẩn danh</p>
                <div className="space-y-2.5">
                  <PollToggle label="Ẩn kết quả khi chưa bình chọn" checked={hidePreview} onChange={setHidePreview} />
                  <PollToggle label="Ẩn người bình chọn" checked={isAnon} onChange={setIsAnon} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-gray-700 flex-shrink-0">
          <button onClick={onClose}
            className="px-5 py-2 rounded-xl text-sm font-semibold text-gray-300 hover:bg-gray-700 transition-colors">
            Huỷ
          </button>
          <button onClick={handleCreate} disabled={creating || !question.trim() || options.filter(o => o.trim()).length < 2}
            className="px-5 py-2 rounded-xl text-sm font-semibold bg-blue-600 hover:bg-blue-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2">
            {creating && <Spinner size={3} />}
            Tạo bình chọn
          </button>
        </div>
      </div>
    </div>
  );
}

function PollToggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center justify-between cursor-pointer select-none">
      <span className="text-sm text-gray-300">{label}</span>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${checked ? 'bg-blue-600' : 'bg-gray-600'}`}
      >
        <span className={`absolute top-0.5 left-0 w-4 h-4 bg-white rounded-full shadow transition-transform ${checked ? 'translate-x-5' : 'translate-x-0.5'}`} />
      </button>
    </label>
  );
}
