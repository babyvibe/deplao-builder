import React, { useEffect, useRef, useState } from 'react';
import ipc from '../../lib/ipc';
import { useAppStore } from '@/store/appStore';
import { v4 as uuidv4 } from 'uuid';
import { showConfirm } from '../common/ConfirmDialog';
import { FacebookIcon, ZaloIcon } from '../common/ChannelBadge';
import type { Channel } from '../../../configs/channelConfig';
import { isUnsupportedWorkflowNodeType } from './workflowConfig';

interface PageAccount {
  zalo_id: string;
  full_name: string;
  avatar_url: string;
  phone?: string;
  channel?: Channel;
}

interface Props {
  onEdit: (id: string) => void;
  onOpenStore?: () => void;
}

const normalizeWorkflowChannel = (channel?: string): Channel => channel === 'facebook' ? 'facebook' : 'zalo';

const workflowHasUnsupportedNodes = (workflow: any): boolean => {
  return Array.isArray(workflow?.nodes) && workflow.nodes.some((node: any) => typeof node?.type === 'string' && isUnsupportedWorkflowNodeType(node.type));
};

function CreateWorkflowChannelModal({
  onClose,
  onSelect,
}: {
  onClose: () => void;
  onSelect: (channel: Channel) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="w-full max-w-xl rounded-2xl border border-gray-700 bg-gray-900 shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div>
            <h2 className="text-white font-semibold">Chọn kênh cho workflow mới</h2>
            <p className="text-gray-500 text-sm mt-0.5">Mỗi workflow hiện được cấu hình theo một kênh riêng để trigger và action đúng loại.</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              onClick={() => onSelect('zalo')}
              className="flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 border-gray-600 hover:border-blue-500 hover:bg-blue-500/10 bg-gray-800/60 transition-all group"
            >
              <div className="w-14 h-14 rounded-full bg-[#2B6AFF]/20 flex items-center justify-center group-hover:bg-[#2B6AFF]/30 transition-colors">
                <ZaloIcon size={32} />
              </div>
              <div className="text-center">
                <p className="text-white font-semibold text-sm">Zalo</p>
                <p className="text-gray-400 text-xs mt-0.5">Tạo workflow chạy được ngay</p>
              </div>
            </button>

            <button
              type="button"
              disabled
              className="relative flex flex-col items-center justify-center gap-3 p-6 rounded-2xl border-2 border-gray-700 bg-gray-800/30 opacity-70 cursor-not-allowed"
            >
              <span className="absolute top-3 right-3 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-300 border border-amber-500/30">
                Tạm khóa
              </span>
              <div className="w-14 h-14 rounded-full bg-[#1877F2]/20 flex items-center justify-center">
                <FacebookIcon size={32} />
              </div>
              <div className="text-center">
                <p className="text-white font-semibold text-sm">Facebook</p>
                <p className="text-gray-400 text-xs mt-0.5">Chưa hỗ trợ chạy workflow</p>
              </div>
            </button>
          </div>

          <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-4 py-3">
            <p className="text-amber-600 text-xs leading-relaxed">
              Facebook đã có mặt ở hệ thống tài khoản, nhưng workflow hiện chỉ hỗ trợ kênh <strong>Zalo</strong>. Các trigger/action Facebook đang được ẩn tạm thời cho đến khi runtime hoàn thiện.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Multi-select page filter dropdown ────────────────────────────────────────
function PageFilterButton({
  accounts,
  filterPages,
  onChange,
}: {
  accounts: PageAccount[];
  filterPages: string[];
  onChange: (pages: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggle = (id: string) => {
    onChange(filterPages.includes(id) ? filterPages.filter(p => p !== id) : [...filterPages, id]);
  };

  const label =
    filterPages.length === 0
      ? 'Tất cả tài khoản'
      : filterPages.length === 1
        ? accounts.find(a => a.zalo_id === filterPages[0])?.full_name || filterPages[0]
        : `${filterPages.length} tài khoản`;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-2 px-3.5 py-2.5 rounded-xl text-sm font-medium transition-colors border ${
          filterPages.length > 0
            ? 'bg-blue-600/20 border-blue-500/50 text-blue-300 hover:bg-blue-600/30'
            : 'bg-gray-800 border-gray-700 text-gray-300 hover:border-gray-600 hover:text-white'
        }`}
      >
        {/* show avatar of selected account when exactly 1 */}
        {filterPages.length === 1 && (() => {
          const acc = accounts.find(a => a.zalo_id === filterPages[0]);
          return acc?.avatar_url
            ? <img src={acc.avatar_url} className="w-4 h-4 rounded-full object-cover flex-shrink-0" alt="" />
            : <div className="w-4 h-4 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 text-[9px] text-white font-bold">
                {(acc?.full_name || filterPages[0]).charAt(0).toUpperCase()}
              </div>;
        })()}
        {filterPages.length !== 1 && (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>
          </svg>
        )}
        <span className="max-w-[140px] truncate">{label}</span>
        {filterPages.length > 0 && (
          <span className="bg-blue-500 text-white text-[11px] px-1.5 py-0.5 rounded-full flex-shrink-0">
            {filterPages.length}
          </span>
        )}
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
          className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1.5 w-[270px] bg-gray-900 border border-gray-700 rounded-xl shadow-2xl z-50 overflow-hidden">
          {/* Dropdown header */}
          <div className="px-3 py-2 border-b border-gray-800 flex items-center justify-between">
            <span className="text-gray-400 text-[11px] font-medium">Lọc theo tài khoản</span>
            {filterPages.length > 0 && (
              <button onClick={() => onChange([])} className="text-blue-400 text-[11px] hover:text-blue-300 transition-colors">
                Xóa lọc
              </button>
            )}
          </div>

          {/* "Tất cả" option */}
          <label className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors hover:bg-gray-800/70 ${filterPages.length === 0 ? 'bg-gray-800/40' : ''}`}>
            <input type="checkbox" checked={filterPages.length === 0} onChange={() => onChange([])} className="accent-blue-500 w-3.5 h-3.5" />
            <span className="text-white text-xs font-medium">Tất cả tài khoản</span>
          </label>

          <div className="h-px bg-gray-800 mx-3" />

          {/* Per-account options */}
          <div className="max-h-[240px] overflow-y-auto">
            {accounts.map(acc => {
              const selected = filterPages.includes(acc.zalo_id);
              return (
                <label key={acc.zalo_id}
                  className={`flex items-center gap-2.5 px-3 py-2 cursor-pointer transition-colors hover:bg-gray-800/70 ${selected ? 'bg-gray-800/40' : ''}`}>
                  <input type="checkbox" checked={selected} onChange={() => toggle(acc.zalo_id)} className="accent-blue-500 w-3.5 h-3.5 flex-shrink-0" />
                  {acc.avatar_url
                    ? <img src={acc.avatar_url} className="w-6 h-6 rounded-full object-cover flex-shrink-0" alt="" />
                    : <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 text-[11px] text-white font-bold">
                        {(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
                      </div>
                  }
                  <div className="min-w-0 flex-1">
                    <p className="text-white text-xs font-medium truncate">{acc.full_name || acc.zalo_id}</p>
                    {acc.phone && <p className="text-gray-400 text-[11px]">{acc.phone}</p>}
                    <p className="text-gray-600 text-[11px]">{acc.zalo_id}</p>
                  </div>
                  {selected && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400 flex-shrink-0">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                </label>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Clone-to-page modal ───────────────────────────────────────────────────────
function CloneModal({ workflow, accounts, onClose, onDone }: {
  workflow: any;
  accounts: PageAccount[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { showNotification } = useAppStore();
  const [targetId, setTargetId] = useState('');
  const [loading, setLoading] = useState(false);

  const sourceIds: string[] = Array.isArray(workflow.pageIds) ? workflow.pageIds : (workflow.pageId ? [workflow.pageId] : []);
  const available = accounts.filter(a => !sourceIds.includes(a.zalo_id));

  const handleClone = async () => {
    if (!targetId) return;
    setLoading(true);
    try {
      const res = await ipc.workflow?.clone(workflow.id, targetId);
      if (res?.success) {
        showNotification('Đã nhân bản workflow sang tài khoản mới', 'success');
        onDone();
        onClose();
      } else {
        showNotification(res?.error || 'Lỗi nhân bản', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[380px] overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between">
          <div>
            <p className="text-white font-semibold text-sm">Nhân bản workflow</p>
            <p className="text-gray-500 text-[11px] mt-0.5 truncate">"{workflow.name}"</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-gray-700 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-gray-400 text-xs leading-relaxed">
            Chọn tài khoản đích để sao chép workflow. Tất cả nodes, edges và cấu hình sẽ được copy — chỉ tài khoản áp dụng thay đổi.
          </p>
          {available.length === 0 ? (
            <div className="bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-5 text-center">
              <p className="text-gray-500 text-xs">Không có tài khoản nào khác để nhân bản vào.</p>
              <p className="text-gray-600 text-[11px] mt-1">Đăng nhập thêm tài khoản Zalo để dùng tính năng này.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {available.map(acc => (
                <label key={acc.zalo_id}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                    targetId === acc.zalo_id ? 'bg-blue-500/10 border-blue-500/50' : 'bg-gray-800/50 border-gray-700/60 hover:border-gray-600'
                  }`}>
                  <input type="radio" name="cloneTarget" value={acc.zalo_id}
                    checked={targetId === acc.zalo_id} onChange={() => setTargetId(acc.zalo_id)}
                    className="accent-blue-500" />
                  {acc.avatar_url
                    ? <img src={acc.avatar_url} className="w-7 h-7 rounded-full object-cover flex-shrink-0" alt="" />
                    : <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 text-xs text-white font-bold">
                        {(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
                      </div>
                  }
                  <div className="min-w-0 flex-1">
                    <p className="text-white text-xs font-medium truncate">{acc.full_name || acc.zalo_id}</p>
                    {acc.phone && <p className="text-gray-400 text-[11px]">{acc.phone}</p>}
                    <p className="text-gray-600 text-[11px]">{acc.zalo_id}</p>
                  </div>
                  {targetId === acc.zalo_id && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400 flex-shrink-0">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
        {available.length > 0 && (
          <div className="px-5 pb-5 flex gap-2">
            <button onClick={onClose} className="flex-1 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors">
              Hủy
            </button>
            <button onClick={handleClone} disabled={!targetId || loading}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2">
              {loading && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              Nhân bản
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Clone-ALL modal ───────────────────────────────────────────────────────────
function CloneAllModal({ sourceZaloId, accounts, onClose, onDone }: {
  sourceZaloId: string;
  accounts: PageAccount[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { showNotification } = useAppStore();
  const [targetId, setTargetId] = useState('');
  const [loading, setLoading] = useState(false);
  const sourceAcc = accounts.find(a => a.zalo_id === sourceZaloId);
  const available = accounts.filter(a => a.zalo_id !== sourceZaloId);

  const handleCloneAll = async () => {
    if (!targetId) return;
    setLoading(true);
    try {
      const res = await ipc.workflow?.cloneAll(sourceZaloId, targetId);
      if (res?.success) {
        showNotification(`Đã nhân bản ${res.count} workflow sang tài khoản mới`, 'success');
        onDone();
        onClose();
      } else {
        showNotification(res?.error || 'Lỗi nhân bản', 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[400px] overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between">
          <div>
            <p className="text-white font-semibold text-sm">Nhân bản tất cả workflows</p>
            <p className="text-gray-500 text-[11px] mt-0.5 flex items-center gap-1.5">
              <span>Từ:</span>
              {sourceAcc?.avatar_url && <img src={sourceAcc.avatar_url} className="w-4 h-4 rounded-full object-cover" alt="" />}
              <span className="text-blue-400">{sourceAcc?.full_name || sourceZaloId}</span>
            </p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-gray-700 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
            <p className="text-amber-300 text-xs leading-relaxed">
              ⚠ Tất cả workflows của tài khoản nguồn sẽ được sao chép sang tài khoản đích. Các workflows đã tồn tại ở tài khoản đích sẽ không bị thay thế.
            </p>
          </div>
          {available.length === 0 ? (
            <div className="bg-gray-800/60 border border-gray-700 rounded-xl px-4 py-5 text-center">
              <p className="text-gray-500 text-xs">Không có tài khoản nào khác để nhân bản vào.</p>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-gray-400 text-xs font-medium">Chọn tài khoản đích:</p>
              {available.map(acc => (
                <label key={acc.zalo_id}
                  className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                    targetId === acc.zalo_id ? 'bg-blue-500/10 border-blue-500/50' : 'bg-gray-800/50 border-gray-700/60 hover:border-gray-600'
                  }`}>
                  <input type="radio" name="cloneAllTarget" value={acc.zalo_id}
                    checked={targetId === acc.zalo_id} onChange={() => setTargetId(acc.zalo_id)}
                    className="accent-blue-500" />
                  {acc.avatar_url
                    ? <img src={acc.avatar_url} className="w-7 h-7 rounded-full object-cover flex-shrink-0" alt="" />
                    : <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 text-xs text-white font-bold">
                        {(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
                      </div>
                  }
                  <div className="min-w-0 flex-1">
                    <p className="text-white text-xs font-medium truncate">{acc.full_name || acc.zalo_id}</p>
                    {acc.phone && <p className="text-gray-400 text-[11px]">{acc.phone}</p>}
                    <p className="text-gray-600 text-[11px]">{acc.zalo_id}</p>
                  </div>
                  {targetId === acc.zalo_id && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-blue-400 flex-shrink-0">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
        {available.length > 0 && (
          <div className="px-5 pb-5 flex gap-2">
            <button onClick={onClose} className="flex-1 px-4 py-2 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors">
              Hủy
            </button>
            <button onClick={handleCloneAll} disabled={!targetId || loading}
              className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2">
              {loading && <span className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
              Nhân bản tất cả
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Test-run modal (ported from WorkflowEditor) ──────────────────────────────
function TestRunModal({ accounts, workflowPageIds, onRun, onClose }: {
  accounts: PageAccount[];
  workflowPageIds: string[];
  onRun: (triggerData: any) => void;
  onClose: () => void;
}) {
  const [selectedAccount, setSelectedAccount] = useState('');
  const [friends, setFriends] = useState<{ userId: string; displayName: string; avatar: string }[]>([]);
  const [loadingFriends, setLoadingFriends] = useState(false);
  const [selectedFriend, setSelectedFriend] = useState<{ userId: string; displayName: string } | null>(null);
  const [search, setSearch] = useState('');
  const [testContent, setTestContent] = useState('Xin chào, đây là tin nhắn thử nghiệm từ workflow');

  const availableAccounts = workflowPageIds.length > 0
    ? accounts.filter(a => workflowPageIds.includes(a.zalo_id))
    : accounts;

  useEffect(() => {
    if (availableAccounts.length > 0 && !selectedAccount) {
      setSelectedAccount(availableAccounts[0].zalo_id);
    }
  }, [availableAccounts]);

  useEffect(() => {
    if (!selectedAccount) return;
    setLoadingFriends(true);
    setSelectedFriend(null);
    ipc.db?.getFriends({ zaloId: selectedAccount }).then((res: any) => {
      if (res?.success) {
        const list = (res.friends || []).filter((f: any) => f.userId !== selectedAccount);
        setFriends(list);
      }
    }).catch(() => {}).finally(() => setLoadingFriends(false));
  }, [selectedAccount]);

  const filteredFriends = search.trim()
    ? friends.filter(f => f.displayName?.toLowerCase().includes(search.toLowerCase()) || f.userId?.includes(search))
    : friends;

  const handleRun = () => {
    if (!selectedFriend || !selectedAccount) return;
    onRun({
      zaloId: selectedAccount,
      threadId: selectedFriend.userId,
      threadType: 0,
      fromId: selectedFriend.userId,
      fromName: selectedFriend.displayName,
      content: testContent,
      isGroup: false,
      isSelf: false,
      timestamp: Date.now(),
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-[440px] max-h-[85vh] flex flex-col overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-700 flex items-center justify-between flex-shrink-0">
          <div>
            <p className="text-white font-semibold text-sm flex items-center gap-2">▶️ Chạy thử Workflow</p>
            <p className="text-gray-500 text-[11px] mt-0.5">Chọn người nhận để gửi tin nhắn thử nghiệm</p>
          </div>
          <button onClick={onClose} className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-500 hover:text-white hover:bg-gray-700 transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
        <div className="p-5 space-y-4 overflow-y-auto flex-1">
          {availableAccounts.length > 1 && (
            <div>
              <label className="text-gray-400 text-xs font-medium mb-1.5 block">Tài khoản gửi</label>
              <div className="space-y-1.5">
                {availableAccounts.map(acc => (
                  <button key={acc.zalo_id} type="button"
                    onClick={() => setSelectedAccount(acc.zalo_id)}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl border text-left transition-all ${
                      selectedAccount === acc.zalo_id
                        ? 'bg-blue-600/20 border-blue-500/60 ring-1 ring-blue-500/30'
                        : 'bg-gray-800/60 border-gray-700/50 hover:border-gray-600'
                    }`}>
                    {acc.avatar_url
                      ? <img src={acc.avatar_url} className="w-7 h-7 rounded-full object-cover flex-shrink-0" alt="" />
                      : <div className="w-7 h-7 rounded-full bg-blue-600 flex items-center justify-center flex-shrink-0 text-xs text-white font-bold">
                          {(acc.full_name || acc.zalo_id).charAt(0).toUpperCase()}
                        </div>}
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm font-medium truncate ${selectedAccount === acc.zalo_id ? 'text-blue-300' : 'text-gray-200'}`}>
                        {acc.full_name || acc.zalo_id}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <label className="text-gray-400 text-xs font-medium mb-1.5 block">Nội dung tin nhắn thử ($trigger.content)</label>
            <textarea
              value={testContent}
              onChange={e => setTestContent(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-blue-500 outline-none resize-none"
              rows={2}
              placeholder="Nhập tin nhắn thử nghiệm..."
            />
          </div>
          <div>
            <label className="text-gray-400 text-xs font-medium mb-1.5 block">
              Chọn người nhận <span className="text-gray-600">(không thể gửi cho chính mình)</span>
            </label>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-xl px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-blue-500 outline-none mb-2"
              placeholder="🔍 Tìm tên hoặc ID..."
            />
            {loadingFriends ? (
              <div className="flex items-center gap-2 py-4 justify-center text-gray-500 text-xs">
                <span className="w-4 h-4 border-2 border-blue-500/30 border-t-blue-500 rounded-full animate-spin" />
                Đang tải danh bạ…
              </div>
            ) : filteredFriends.length === 0 ? (
              <div className="py-4 text-center text-gray-600 text-xs">
                {friends.length === 0 ? 'Chưa có bạn bè nào' : 'Không tìm thấy'}
              </div>
            ) : (
              <div className="max-h-[200px] overflow-y-auto space-y-1 pr-1">
                {filteredFriends.slice(0, 50).map(f => {
                  const isActive = selectedFriend?.userId === f.userId;
                  return (
                    <button key={f.userId} type="button"
                      onClick={() => setSelectedFriend(isActive ? null : f)}
                      className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl border text-left transition-all ${
                        isActive
                          ? 'bg-green-600/20 border-green-500/60 ring-1 ring-green-500/30'
                          : 'bg-gray-800/40 border-gray-700/40 hover:border-gray-600'
                      }`}>
                      {f.avatar
                        ? <img src={f.avatar} className="w-7 h-7 rounded-full object-cover flex-shrink-0" alt="" />
                        : <div className="w-7 h-7 rounded-full bg-gray-700 flex items-center justify-center flex-shrink-0 text-[10px] text-gray-400 font-bold">
                            {(f.displayName || '?').charAt(0).toUpperCase()}
                          </div>}
                      <div className="min-w-0 flex-1">
                        <p className={`text-sm font-medium truncate ${isActive ? 'text-green-300' : 'text-gray-200'}`}>
                          {f.displayName || f.userId}
                        </p>
                        <p className="text-[10px] text-gray-600 truncate">{f.userId}</p>
                      </div>
                      {isActive && (
                        <svg className="w-5 h-5 text-green-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        <div className="px-5 py-4 border-t border-gray-700 flex gap-2 flex-shrink-0">
          <button onClick={onClose} className="flex-1 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors">
            Hủy
          </button>
          <button onClick={handleRun} disabled={!selectedFriend || !selectedAccount}
            className="flex-1 px-4 py-2.5 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-medium rounded-xl transition-colors flex items-center justify-center gap-2">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
            Chạy thử
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function WorkflowList({ onEdit, onOpenStore }: Props) {
  const { showNotification } = useAppStore();
  const [workflows, setWorkflows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<PageAccount[]>([]);
  const [cloningWf, setCloningWf] = useState<any | null>(null);
  const [cloneAllSource, setCloneAllSource] = useState<string | null>(null);
  const [filterPages, setFilterPages] = useState<string[]>([]);  // empty = all
  const [searchQuery, setSearchQuery] = useState('');
  const [runningId, setRunningId] = useState<string | null>(null);
  const [testRunWf, setTestRunWf] = useState<any | null>(null);
  const [showCreateChannelModal, setShowCreateChannelModal] = useState(false);
  const importFileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await ipc.workflow?.list();
      if (res?.success) setWorkflows(res.workflows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    ipc.login?.getAccounts().then((res: any) => {
      if (res?.success) setAccounts((res.accounts || [])
        .filter((a: any) => (a.channel || 'zalo') === 'zalo')
        .map((a: any) => ({
        zalo_id: a.zalo_id,
        full_name: a.full_name || '',
        avatar_url: a.avatar_url || '',
        phone: a.phone || '',
        channel: a.channel || 'zalo',
      })));
    }).catch(() => {});
  }, []);

  const createNew = async (channel: Channel) => {
    if (channel !== 'zalo') {
      showNotification('Workflow Facebook hiện chưa hỗ trợ tạo mới.', 'warning');
      return;
    }
    const id = uuidv4();
    const res = await ipc.workflow?.save({
      channel,
      id, name: 'Workflow mới', description: '', enabled: false,
      nodes: [], edges: [], createdAt: Date.now(), updatedAt: Date.now(),
    });
    if (res?.success) {
      setShowCreateChannelModal(false);
      onEdit(id);
    }
    else showNotification('Lỗi tạo workflow', 'error');
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    const res = await ipc.workflow?.toggle(id, enabled);
    if (res?.success) {
      setWorkflows(ws => ws.map(w => w.id === id ? { ...w, enabled } : w));
      return;
    }
    showNotification(res?.error || 'Không thể cập nhật trạng thái workflow', 'error');
  };

  const handleDelete = async (id: string, name: string) => {
    const ok = await showConfirm({
      title: `Xóa workflow "${name}"?`,
      message: 'Tất cả lịch sử chạy cũng sẽ bị xóa. Hành động này không thể hoàn tác.',
      confirmText: 'Xóa', cancelText: 'Hủy', variant: 'danger',
    });
    if (!ok) return;
    const res = await ipc.workflow?.delete(id);
    if (res?.success) {
      setWorkflows(ws => ws.filter(w => w.id !== id));
      showNotification('Đã xóa workflow', 'success');
    } else {
      showNotification(res?.error || 'Lỗi xóa workflow', 'error');
    }
  };

  const handleRunClick = (wf: any) => {
    if (normalizeWorkflowChannel(wf.channel) !== 'zalo' || workflowHasUnsupportedNodes(wf)) {
      showNotification('Workflow Facebook hiện chưa hỗ trợ chạy.', 'warning');
      return;
    }
    const hasSendNodes = (wf.nodes || []).some((n: any) => {
      const t = n.type || '';
      return t === 'zalo.sendMessage' || t === 'zalo.sendImage' || t === 'zalo.sendFile'
        || t === 'zalo.sendVoice' || t === 'zalo.sendTyping';
    });
    if (hasSendNodes) {
      setTestRunWf(wf);
    } else {
      handleRun(wf.id);
    }
  };

  const handleRun = async (id: string, triggerData?: any) => {
    setRunningId(id);
    try {
      const res = await ipc.workflow?.runManual(id, triggerData);
      if (res?.success) showNotification(`Chạy xong — ${res.log?.status}`, 'success');
      else showNotification(res?.error || 'Lỗi chạy workflow', 'error');
    } finally {
      setRunningId(null);
    }
  };

  const handleExport = (wf: any) => {
    const exportData = {
      _deplaoWorkflow: true,
      _version: 1,
      _exportedAt: new Date().toISOString(),
      channel: normalizeWorkflowChannel(wf.channel),
      name: wf.name,
      description: wf.description || '',
      nodes: wf.nodes || [],
      edges: wf.edges || [],
    };
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `workflow-${(wf.name || 'export').replace(/[^a-zA-Z0-9_\-\u00C0-\u024F\u1E00-\u1EFF]/g, '_').substring(0, 50)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showNotification('Đã xuất workflow thành file JSON', 'success');
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (!data._deplaoWorkflow) {
          showNotification('File không phải workflow Deplao hợp lệ', 'error');
          return;
        }
        if (normalizeWorkflowChannel(data.channel) !== 'zalo' || (data.nodes || []).some((n: any) => typeof n?.type === 'string' && isUnsupportedWorkflowNodeType(n.type))) {
          showNotification('Workflow Facebook hiện chưa hỗ trợ nhập vào hệ thống.', 'warning');
          return;
        }
        // Create new IDs for all nodes/edges
        const idMap: Record<string, string> = {};
        const importedNodes = (data.nodes || []).map((n: any) => {
          const newId = uuidv4();
          idMap[n.id] = newId;
          return { ...n, id: newId };
        });
        const importedEdges = (data.edges || []).map((edge: any) => ({
          ...edge,
          id: uuidv4(),
          source: idMap[edge.source] || edge.source,
          target: idMap[edge.target] || edge.target,
        }));

        const newId = uuidv4();
        const res = await ipc.workflow?.save({
          channel: 'zalo',
          id: newId,
          name: data.name ? `${data.name} (nhập)` : 'Workflow nhập',
          description: data.description || '',
          enabled: false,
          nodes: importedNodes,
          edges: importedEdges,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        });
        if (res?.success) {
          showNotification(`Đã nhập workflow "${data.name || 'Imported'}"`, 'success');
          load();
        } else {
          showNotification(res?.error || 'Lỗi nhập workflow', 'error');
        }
      } catch (err: any) {
        showNotification('Lỗi đọc file JSON: ' + (err.message || 'Invalid JSON'), 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  /** Filter by selected pages (empty = show all) and search query */
  const filteredWorkflows = (() => {
    let result = workflows;
    // Filter by pages
    if (filterPages.length > 0) {
      result = result.filter(wf => {
        const ids: string[] = Array.isArray(wf.pageIds) && wf.pageIds.length > 0
          ? wf.pageIds
          : (wf.pageId ? [wf.pageId] : []);
        if (ids.length === 0) return true;  // global workflows always shown
        return filterPages.some(fp => ids.includes(fp));
      });
    }
    // Filter by search query
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(wf =>
        (wf.name || '').toLowerCase().includes(q)
        || (wf.description || '').toLowerCase().includes(q)
      );
    }
    return result;
  })();

  const triggerTypeLabel: Record<string, string> = {
    'trigger.message':       '💬 Tin nhắn',
    'trigger.friendRequest': '👥 Kết bạn',
    'trigger.groupEvent':    '🏠 Sự kiện nhóm',
    'trigger.reaction':      '😊 Cảm xúc',
    'trigger.labelAssigned': '🏷️ Gán nhãn',
    'trigger.schedule':      '⏰ Lịch trình',
    'trigger.manual':        '▶ Thủ công',
  };

  const getTriggerLabel = (wf: any) => {
    const trigger = (wf.nodes || []).find((n: any) => n.type?.startsWith('trigger.'));
    return trigger ? (triggerTypeLabel[trigger.type] || trigger.type) : '—';
  };

  /** Page badges shown in each workflow card's meta row */
  const renderPageBadges = (wf: any) => {
    const ids: string[] = Array.isArray(wf.pageIds) && wf.pageIds.length > 0
      ? wf.pageIds
      : (wf.pageId ? [wf.pageId] : []);
    if (ids.length === 0) {
      return <span className="text-gray-600 text-[11px]">📱 Tất cả tài khoản</span>;
    }
    if (ids.length === 1) {
      const acc = accounts.find(a => a.zalo_id === ids[0]);
      return (
        <span className="flex items-center gap-1 text-gray-500 text-[11px]">
          {acc?.avatar_url
            ? <img src={acc.avatar_url} className="w-3.5 h-3.5 rounded-full object-cover flex-shrink-0" alt="" />
            : <span>📱</span>
          }
          <span className="truncate max-w-[120px]">{acc?.full_name || ids[0]}</span>
        </span>
      );
    }
    const names = ids.map(id => accounts.find(a => a.zalo_id === id)?.full_name || id);
    return (
      <span className="flex items-center gap-1 text-gray-500 text-[11px]" title={names.join(', ')}>
        <span>📱</span>
        <span>{ids.length} tài khoản</span>
      </span>
    );
  };

  const renderChannelBadge = (wf: any) => {
    const channel = normalizeWorkflowChannel(wf.channel);
    const unsupported = channel !== 'zalo' || workflowHasUnsupportedNodes(wf);
    return (
      <span className={`inline-flex items-center text-[11px] px-2 py-0.5 rounded-full border ${
        unsupported
          ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
          : 'bg-blue-500/10 border-blue-500/30 text-blue-300'
      }`}>
        {unsupported ? 'Facebook · tạm khóa' : 'Zalo'}
      </span>
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-5 border-b border-gray-800 flex-shrink-0">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-white text-xl font-bold flex items-center gap-2">
              <span>⚡</span>WorkFlow Automation
            </h1>
            <p className="text-gray-500 text-sm mt-0.5">Tự động hoá công việc với Workflow Automation</p>
          </div>

          <div className="flex items-center gap-2">
            {/* Clone-all — only available when exactly 1 account is filtered */}
            {filterPages.length === 1 && (
                <button
                    onClick={() => setCloneAllSource(filterPages[0])}
                    className="flex items-center gap-1.5 px-3.5 py-2.5 bg-amber-600/20 hover:bg-amber-600/30 border border-amber-600/30 text-amber-400 text-sm font-medium rounded-xl whitespace-nowrap transition-colors"
                    title="Nhân bản tất cả workflows của tài khoản này sang tài khoản khác"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                  Clone tất cả
                </button>
            )}

            {/* Multi-select page filter — only when accounts exist */}
            {accounts.length > 0 && (
              <PageFilterButton accounts={accounts} filterPages={filterPages} onChange={setFilterPages} />
            )}


            {onOpenStore && (
              <button
                onClick={onOpenStore}
                className="flex items-center gap-2 px-4 py-2.5 bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/40 text-violet-300 text-sm font-medium rounded-xl transition-colors"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/>
                </svg>
                Kho mẫu 🔥
              </button>
            )}
            <button
              onClick={() => importFileRef.current?.click()}
              className="flex items-center gap-2 px-4 py-2.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-300 text-sm font-medium rounded-xl transition-colors"
              title="Nhập workflow từ file JSON"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
              </svg>
              Nhập JSON
            </button>
            <input ref={importFileRef} type="file" accept=".json" className="hidden" onChange={handleImportFile} />
            <button
              onClick={() => setShowCreateChannelModal(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-xl transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Tạo workflow
            </button>
          </div>
        </div>

        {/* Search bar & stats */}
        {workflows.length > 0 && (
          <div className="flex items-center gap-3">
            <div className="relative flex-1 max-w-md">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
              <input
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                placeholder="Tìm workflow theo tên hoặc mô tả..."
                className="w-full bg-gray-800/80 border border-gray-700 rounded-xl pl-10 pr-4 py-2.5 text-sm text-white placeholder-gray-500 focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 outline-none transition-all"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300 transition-colors">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              )}
            </div>
            <div className="flex items-center gap-3 text-xs text-gray-500">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-500" />
                {workflows.filter(w => w.enabled).length} đang bật
              </span>
              <span className="text-gray-700">·</span>
              <span>{workflows.length} tổng cộng</span>
              {filteredWorkflows.length !== workflows.length && (
                <>
                  <span className="text-gray-700">·</span>
                  <span className="text-blue-400">{filteredWorkflows.length} kết quả</span>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading && (
          <div className="flex items-center justify-center py-16">
            <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {!loading && workflows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-2xl bg-gray-800 border border-gray-700 flex items-center justify-center mb-4">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-500">
                <circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/>
                <circle cx="12" cy="18" r="2"/>
                <path d="M7 6h10M5 8v4a7 7 0 0 0 7 7M19 8v4a7 7 0 0 1-7 7"/>
              </svg>
            </div>
            <p className="text-gray-300 font-semibold mb-1">Chưa có workflow nào</p>
            <p className="text-gray-600 text-sm mb-6 max-w-xs">
              Tạo workflow để Tự động hoá việc trả lời tin nhắn, xử lý kết bạn, gửi thông báo...
            </p>
            <button onClick={() => setShowCreateChannelModal(true)}
              className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-xl transition-colors">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
              </svg>
              Tạo workflow đầu tiên
            </button>
            {onOpenStore && (
              <button onClick={onOpenStore}
                className="flex items-center gap-2 px-5 py-2.5 bg-violet-600/20 hover:bg-violet-600/30 border border-violet-500/40 text-violet-300 text-sm font-medium rounded-xl transition-colors mt-3">
                <span>📦</span> Hoặc chọn từ Kho mẫu có sẵn
              </button>
            )}
          </div>
        )}

        {!loading && workflows.length > 0 && filteredWorkflows.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-gray-500 text-sm">
              {searchQuery ? `Không tìm thấy workflow nào với "${searchQuery}"` : 'Không có workflow nào khớp với bộ lọc.'}
            </p>
            <button onClick={() => { setFilterPages([]); setSearchQuery(''); }} className="mt-3 text-blue-400 text-xs hover:text-blue-300 transition-colors">
              Xóa bộ lọc
            </button>
          </div>
        )}

        {/* ── Card Grid ──────────────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredWorkflows.map(wf => {
            const isRunning = runningId === wf.id;
            const isUnsupported = normalizeWorkflowChannel(wf.channel) !== 'zalo' || workflowHasUnsupportedNodes(wf);
            const toggleBlocked = isUnsupported && !wf.enabled;
            return (
              <div key={wf.id}
                className="group bg-gray-900 border border-gray-700/80 rounded-2xl hover:border-gray-600 transition-all hover:shadow-lg hover:shadow-black/20 flex flex-col overflow-hidden">
                {/* Card header */}
                <div className="px-4 pt-4 pb-3 flex items-start gap-3">
                  {/* Status indicator */}
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 ${
                    wf.enabled
                      ? 'bg-green-500/15 text-green-400 border border-green-500/30'
                      : 'bg-gray-800 text-gray-500 border border-gray-700'
                  }`}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="5" cy="6" r="2"/><circle cx="19" cy="6" r="2"/>
                      <circle cx="12" cy="18" r="2"/>
                      <path d="M7 6h10M5 8v4a7 7 0 0 0 7 7M19 8v4a7 7 0 0 1-7 7"/>
                    </svg>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <h3 className="text-white font-semibold text-sm truncate flex-1">{wf.name}</h3>
                      {renderChannelBadge(wf)}
                      {/* Toggle */}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleToggle(wf.id, !wf.enabled); }}
                        className="flex-shrink-0"
                        title={isUnsupported
                          ? (wf.enabled ? 'Workflow Facebook đang bị khóa — bạn vẫn có thể tắt nó' : 'Workflow Facebook hiện chưa hỗ trợ chạy')
                          : (wf.enabled ? 'Đang bật — nhấn để tắt' : 'Đang tắt — nhấn để bật')}
                        disabled={toggleBlocked}
                      >
                        <div className={`w-9 h-[20px] rounded-full transition-colors relative ${wf.enabled ? 'bg-blue-600' : 'bg-gray-700'}`}>
                          <span className={`absolute top-[3px] w-[14px] h-[14px] bg-white rounded-full shadow transition-all ${wf.enabled ? 'left-[19px]' : 'left-[3px]'}`} />
                        </div>
                      </button>
                    </div>
                    {wf.description && (
                      <p className="text-gray-500 text-xs line-clamp-2 leading-relaxed">{wf.description}</p>
                    )}
                  </div>
                </div>

                {/* Card meta */}
                <div className="px-4 pb-3 flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center text-[11px] px-2 py-0.5 rounded-full bg-gray-800 border border-gray-700 text-gray-400">
                    {getTriggerLabel(wf)}
                  </span>
                  <span className="text-[11px] text-gray-600">{(wf.nodes || []).length} nodes</span>
                  <span className="text-gray-800">·</span>
                  {renderPageBadges(wf)}
                  {isUnsupported && (
                    <span className="text-[11px] text-amber-300">Chỉ xem tạm — chưa chạy được</span>
                  )}
                </div>

                {/* Card footer */}
                <div className="px-4 py-3 border-t border-gray-800 flex items-center justify-between mt-auto">
                  <span className="text-[11px] text-gray-600">
                    {new Date(wf.updatedAt).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' })}
                  </span>

                  <div className="flex items-center gap-1">
                    <button onClick={() => handleRunClick(wf)} disabled={isRunning || isUnsupported} title={isUnsupported ? 'Workflow Facebook hiện chưa hỗ trợ chạy' : 'Chạy thử'}
                      className="h-7 px-2.5 rounded-lg flex items-center justify-center gap-1.5 text-xs font-medium text-gray-400 hover:text-green-400 hover:bg-green-500/10 disabled:opacity-40 transition-colors">
                      {isRunning
                        ? <span className="w-3 h-3 border-2 border-green-500/30 border-t-green-500 rounded-full animate-spin" />
                        : <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                      }
                      <span className="hidden sm:inline">Chạy thử</span>
                    </button>
                    <button onClick={() => handleExport(wf)} title="Xuất JSON"
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>
                      </svg>
                    </button>
                    <button onClick={() => setCloningWf(wf)} title={isUnsupported ? 'Workflow Facebook hiện chưa hỗ trợ nhân bản' : 'Nhân bản'}
                      disabled={isUnsupported}
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-amber-400 hover:bg-amber-500/10 transition-colors">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                      </svg>
                    </button>
                    <button onClick={() => onEdit(wf.id)} title="Chỉnh sửa"
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-blue-400 hover:bg-blue-500/10 transition-colors">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                    <button onClick={() => handleDelete(wf.id, wf.name)} title="Xóa"
                      className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-red-400 hover:bg-red-500/10 transition-colors">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <polyline points="3 6 5 6 21 6"/>
                        <path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
                        <path d="M10 11v6M14 11v6"/>
                        <path d="M9 6V4a1 1 0 011-1h4a1 1 0 011 1v2"/>
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Clone single workflow modal */}
      {cloningWf && (
        <CloneModal
          workflow={cloningWf}
          accounts={accounts}
          onClose={() => setCloningWf(null)}
          onDone={load}
        />
      )}

      {/* Clone-all modal */}
      {cloneAllSource && (
        <CloneAllModal
          sourceZaloId={cloneAllSource}
          accounts={accounts}
          onClose={() => setCloneAllSource(null)}
          onDone={load}
        />
      )}

      {/* Test Run Modal */}
      {testRunWf && (
        <TestRunModal
          accounts={accounts}
          workflowPageIds={Array.isArray(testRunWf.pageIds) ? testRunWf.pageIds : (testRunWf.pageId ? [testRunWf.pageId] : [])}
          onRun={(triggerData) => handleRun(testRunWf.id, triggerData)}
          onClose={() => setTestRunWf(null)}
        />
      )}

      {showCreateChannelModal && (
        <CreateWorkflowChannelModal
          onClose={() => setShowCreateChannelModal(false)}
          onSelect={createNew}
        />
      )}
    </div>
  );
}
