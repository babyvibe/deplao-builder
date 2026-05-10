import React, { useState, useEffect } from 'react';
import ipc from '@/lib/ipc';

type CampaignType = 'message' | 'friend_request' | 'mixed' | 'invite_to_group';
type MixedAction = 'message' | 'friend_request' | 'invite_to_groups';

export interface MixedConfig {
  actions: MixedAction[];
  group_ids?: string[];
}

interface CampaignFormData {
  name: string;
  template_message: string;
  friend_request_message: string;
  campaign_type: CampaignType;
  mixed_config: string;
  delay_seconds: number;
}

interface CampaignCreateModalProps {
  initialData?: Partial<CampaignFormData>;
  editMode?: boolean;
  zaloId?: string;
  onClose: () => void;
  onSave: (data: CampaignFormData) => Promise<void>;
}

const DELAY_OPTIONS = [
  { label: '1 phút', value: 60 },
  { label: '2 phút', value: 120 },
  { label: '3 phút', value: 180 },
  { label: '5 phút', value: 300 },
];
const TEMPLATE_VARS = ['{name}', '{userId}'];

const TYPE_OPTIONS: { value: CampaignType; label: string; icon: string; desc: string }[] = [
  { value: 'message',        icon: '💬', label: 'Tin nhắn',  desc: 'Gửi tin nhắn trực tiếp đến liên hệ' },
  { value: 'friend_request', icon: '🤝', label: 'Kết bạn',   desc: 'Gửi lời mời kết bạn kèm nội dung' },
  { value: 'invite_to_group',icon: '👥', label: 'Mời vào nhóm',  desc: 'Mời bạn bè vào một hoặc nhiều nhóm' },
  { value: 'mixed',          icon: '🔀', label: 'Hỗn hợp',   desc: 'Tự chọn các hành động sẽ thực hiện' },
];

const INVITE_ERROR_LABELS: Record<number, string> = {
  269: 'Chưa là bạn bè', 178: 'Đã là thành viên', 263: 'Đã gửi lời mời',
  262: 'Đã có lời mời', 177: 'Nhóm đầy', 166: 'Không có quyền',
  245: 'Người lạ', 122: 'Bị chặn', 247: 'Bị bỏ qua nhóm',
};

function parseMixedConfig(raw?: string): MixedConfig {
  if (!raw) return { actions: ['message', 'friend_request'] };
  try {
    const p = JSON.parse(raw);
    if (p && Array.isArray(p.actions)) return p as MixedConfig;
    // invite_to_group campaigns: no actions array, but may have group_ids
    if (p && Array.isArray(p.group_ids)) return { actions: [], group_ids: p.group_ids };
  } catch {}
  return { actions: ['message', 'friend_request'] };
}

export default function CampaignCreateModal({ initialData, editMode = false, zaloId, onClose, onSave }: CampaignCreateModalProps) {
  const [name, setName] = useState(initialData?.name ?? '');
  const [type, setType] = useState<CampaignType>(initialData?.campaign_type ?? 'message');
  const [template, setTemplate] = useState(initialData?.template_message ?? '');
  const [friendReqMsg, setFriendReqMsg] = useState(initialData?.friend_request_message ?? '');
  const [delay, setDelay] = useState(initialData?.delay_seconds ?? 120);
  const [saving, setSaving] = useState(false);

  // ── Mixed config state ────────────────────────────────────────────────────
  const initMixed = parseMixedConfig(initialData?.mixed_config);
  const [mixedActions, setMixedActions] = useState<MixedAction[]>(initMixed.actions);
  const [inviteGroupIds, setInviteGroupIds] = useState<string[]>(initMixed.group_ids ?? []);
  // For group picker inside modal
  const [availableGroups, setAvailableGroups] = useState<{ contact_id: string; display_name: string; avatar_url?: string }[]>([]);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const [groupSearch, setGroupSearch] = useState('');

  const hasMsg    = type === 'message' || (type === 'mixed' && mixedActions.includes('message'));
  const hasFR     = type === 'friend_request' || (type === 'mixed' && mixedActions.includes('friend_request'));
  const hasInvite = type === 'invite_to_group' || (type === 'mixed' && mixedActions.includes('invite_to_groups'));

  // Load groups when invite_to_groups is toggled on
  useEffect(() => {
    if (!hasInvite || groupsLoaded || !zaloId) return;
    ipc.db?.getContacts(zaloId).then(res => {
      const contacts: any[] = res?.contacts ?? res ?? [];
      setAvailableGroups(contacts.filter((c: any) => c.contact_type === 'group').map((c: any) => ({
        contact_id: c.contact_id,
        display_name: c.display_name || c.contact_id,
        avatar_url: c.avatar_url || '',
      })));
      setGroupsLoaded(true);
    });
  }, [hasInvite, groupsLoaded, zaloId]);

  const toggleMixedAction = (action: MixedAction) => {
    setMixedActions(prev =>
      prev.includes(action) ? prev.filter(a => a !== action) : [...prev, action]
    );
  };

  const toggleGroupId = (id: string) => {
    setInviteGroupIds(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]);
  };

  const buildMixedConfig = (): string => {
    if (type === 'invite_to_group') {
      return JSON.stringify({ group_ids: inviteGroupIds });
    }
    if (type !== 'mixed') return '{}';
    const cfg: MixedConfig = { actions: mixedActions };
    if (mixedActions.includes('invite_to_groups') && inviteGroupIds.length > 0) {
      cfg.group_ids = inviteGroupIds;
    }
    return JSON.stringify(cfg);
  };

  const isValid = () => {
    if (!name.trim()) return false;
    if (type === 'invite_to_group') {
      return inviteGroupIds.length > 0;
    }
    if (type === 'mixed') {
      if (mixedActions.length === 0) return false;
      if (mixedActions.includes('message') && !template.trim()) return false;
      if (mixedActions.includes('friend_request') && !friendReqMsg.trim()) return false;
      if (mixedActions.includes('invite_to_groups') && inviteGroupIds.length === 0) return false;
    } else {
      if (hasMsg && !template.trim()) return false;
      if (hasFR && !friendReqMsg.trim()) return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!isValid()) return;
    setSaving(true);
    await onSave({
      name: name.trim(),
      template_message: template.trim(),
      friend_request_message: friendReqMsg.trim(),
      campaign_type: type,
      mixed_config: buildMixedConfig(),
      delay_seconds: delay,
    });
    setSaving(false);
    onClose();
  };

  const insertVar = (setter: React.Dispatch<React.SetStateAction<string>>, v: string) =>
    setter(t => t + v);

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-gray-800 border border-gray-600 rounded-2xl w-[540px] shadow-2xl flex flex-col max-h-[92vh]"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 flex-shrink-0">
          <h3 className="font-semibold text-white">{editMode ? 'Chỉnh sửa chiến dịch' : 'Tạo chiến dịch mới'}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-white transition-colors">✕</button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 space-y-5">

          {/* Name */}
          <div>
            <label className="text-xs text-gray-400 font-medium block mb-1.5">Tên chiến dịch *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="VD: Chào mừng khách hàng mới..."
              className="w-full bg-gray-700 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors" />
          </div>

          {/* Campaign type */}
          <div>
            <label className="text-xs text-gray-400 font-medium block mb-2">Kiểu chiến dịch *</label>
            <div className="grid grid-cols-2 gap-2">
              {TYPE_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => setType(opt.value)}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-center transition-colors
                    ${type === opt.value
                      ? 'border-blue-500 bg-blue-500/15 text-white'
                      : 'border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-200'}`}>
                  <span className="text-xl">{opt.icon}</span>
                  <span className="text-xs font-semibold">{opt.label}</span>
                  <span className="text-[11px] leading-snug opacity-70">{opt.desc}</span>
                </button>
              ))}
            </div>
          </div>

          {/* ── Mixed mode: action checkboxes ── */}
          {type === 'mixed' && (
            <div className="bg-gray-700/40 border border-gray-600 rounded-xl p-4 space-y-3">
              <p className="text-xs text-gray-300 font-medium">🔀 Chọn hành động thực hiện cho mỗi liên hệ</p>

              {/* ☑ Gửi tin nhắn */}
              <label className="flex items-start gap-3 cursor-pointer group">
                <input type="checkbox" checked={mixedActions.includes('message')}
                  onChange={() => toggleMixedAction('message')}
                  className="mt-0.5 accent-blue-500 flex-shrink-0 cursor-pointer" />
                <div>
                  <span className="text-sm text-gray-200 group-hover:text-blue-600 transition-colors">💬 Gửi tin nhắn</span>
                  <p className="text-[11px] text-gray-500 mt-0.5">Gửi tin nhắn văn bản tới người dùng / nhóm</p>
                </div>
              </label>

              {/* ☑ Gửi lời mời kết bạn */}
              <label className="flex items-start gap-3 cursor-pointer group">
                <input type="checkbox" checked={mixedActions.includes('friend_request')}
                  onChange={() => toggleMixedAction('friend_request')}
                  className="mt-0.5 accent-blue-500 flex-shrink-0 cursor-pointer" />
                <div>
                  <span className="text-sm text-gray-200 group-hover:text-blue-600 transition-colors">🤝 Gửi lời mời kết bạn</span>
                  <p className="text-[11px] text-gray-500 mt-0.5">Gửi kèm nội dung lời mời</p>
                </div>
              </label>

              {/* ☐ Mời vào nhóm */}
              <label className="flex items-start gap-3 cursor-pointer group">
                <input type="checkbox" checked={mixedActions.includes('invite_to_groups')}
                  onChange={() => toggleMixedAction('invite_to_groups')}
                  className="mt-0.5 accent-purple-500 flex-shrink-0 cursor-pointer" />
                <div>
                  <span className="text-sm text-gray-200 group-hover:text-blue-600 transition-colors">👥 Mời vào nhóm</span>
                  <p className="text-[11px] text-gray-500 mt-0.5">Tự động mời, thêm bạn bè vào nhóm</p>
                </div>
              </label>

              {mixedActions.length === 0 && (
                <p className="text-[11px] text-red-400">Phải chọn ít nhất một hành động</p>
              )}
            </div>
          )}

          {/* ── Invite to groups — group picker ── */}
          {hasInvite && (
            <div>
              <div className="text-[12px] text-yellow-500/80 mt-0.5 mb-2">⚠️ Chú ý: Tính năng chỉ mời được bạn bè - Không mời được người lạ</div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-gray-400 font-medium">
                  {type === 'invite_to_group' ? '👥 Chọn nhóm mời *' : 'Chọn nhóm để mời *'}
                </label>
                {inviteGroupIds.length > 0 && (
                  <span className="text-xs font-medium text-blue-400 bg-blue-500/15 px-2 py-0.5 rounded-full">
                    {inviteGroupIds.length} nhóm đã chọn
                  </span>
                )}
              </div>

              {!zaloId ? (
                <p className="text-xs text-yellow-500/80 bg-yellow-500/10 border border-yellow-500/20 rounded-xl p-3">
                  ⚠️ Mở modal từ tab Chiến dịch để xem danh sách nhóm
                </p>
              ) : !groupsLoaded ? (
                <div className="flex items-center gap-2 text-xs text-gray-400 py-3 px-3 bg-gray-700/40 border border-gray-600 rounded-xl">
                  <svg className="animate-spin flex-shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                  </svg>
                  Đang tải danh sách nhóm...
                </div>
              ) : availableGroups.length === 0 ? (
                <p className="text-xs text-gray-500 bg-gray-700/50 border border-gray-600 rounded-xl p-3">
                  Chưa có nhóm nào trong DB. Hãy đồng bộ nhóm từ tab Nhóm trước.
                </p>
              ) : (
                <div className="border border-gray-600 rounded-xl overflow-hidden bg-gray-700/30">
                  {/* Search bar */}
                  <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-600 bg-gray-700/50">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-500 flex-shrink-0">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    </svg>
                    <input
                      value={groupSearch}
                      onChange={e => setGroupSearch(e.target.value)}
                      placeholder="Tìm tên nhóm..."
                      className="flex-1 bg-transparent text-xs text-white placeholder-gray-500 focus:outline-none"
                    />
                    {groupSearch && (
                      <button onClick={() => setGroupSearch('')} className="text-gray-500 hover:text-white text-xs flex-shrink-0">✕</button>
                    )}
                    {/* Select all / deselect all */}
                    {(() => {
                      const visibleIds = availableGroups
                        .filter(g => !groupSearch.trim() || g.display_name.toLowerCase().includes(groupSearch.toLowerCase()))
                        .map(g => g.contact_id);
                      const allSelected = visibleIds.length > 0 && visibleIds.every(id => inviteGroupIds.includes(id));
                      return visibleIds.length > 1 ? (
                        <button
                          onClick={() => allSelected
                            ? setInviteGroupIds(prev => prev.filter(id => !visibleIds.includes(id)))
                            : setInviteGroupIds(prev => [...new Set([...prev, ...visibleIds])])
                          }
                          className="text-[11px] text-blue-400 hover:text-blue-300 flex-shrink-0 ml-1">
                          {allSelected ? 'Bỏ chọn tất cả' : 'Chọn tất cả'}
                        </button>
                      ) : null;
                    })()}
                  </div>

                  {/* Group list */}
                  <div className="max-h-56 overflow-y-auto">
                    {availableGroups
                      .filter(g => !groupSearch.trim() || g.display_name.toLowerCase().includes(groupSearch.toLowerCase()))
                      .map(g => {
                        const checked = inviteGroupIds.includes(g.contact_id);
                        const initial = (g.display_name || '?').charAt(0).toUpperCase();
                        return (
                          <label key={g.contact_id}
                            className={`flex items-center gap-3 px-3 py-2.5 cursor-pointer border-b border-gray-700/50 last:border-0 transition-colors
                              ${checked ? 'bg-blue-500/10 hover:bg-blue-500/15' : 'hover:bg-gray-700/50'}`}>
                            {/* Custom blue checkbox */}
                            <div onClick={() => toggleGroupId(g.contact_id)}
                              className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all
                                ${checked ? 'bg-blue-500 border-blue-500' : 'border-gray-500 bg-transparent hover:border-blue-400'}`}>
                              {checked && (
                                <svg width="9" height="7" viewBox="0 0 9 7" fill="none">
                                  <path d="M1 3.5L3.5 6L8 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                              )}
                            </div>
                            {/* Avatar */}
                            {g.avatar_url ? (
                              <img src={g.avatar_url} alt="" className="w-8 h-8 rounded-full object-cover flex-shrink-0" />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-600 to-indigo-700 flex items-center justify-center text-white text-xs font-bold flex-shrink-0">
                                {initial}
                              </div>
                            )}
                            {/* Name */}
                            <span className={`flex-1 text-xs truncate ${checked ? 'text-white font-medium' : 'text-gray-200'}`}>
                              {g.display_name}
                            </span>
                          </label>
                        );
                      })
                    }
                    {availableGroups.filter(g => !groupSearch.trim() || g.display_name.toLowerCase().includes(groupSearch.toLowerCase())).length === 0 && (
                      <p className="text-xs text-gray-500 text-center py-4">Không tìm thấy nhóm nào</p>
                    )}
                  </div>
                </div>
              )}

              {inviteGroupIds.length === 0 && groupsLoaded && availableGroups.length > 0 && (
                <p className="text-[11px] text-red-400 mt-1.5">Phải chọn ít nhất một nhóm</p>
              )}
              {/* Error codes reference */}
              <details className="mt-2">
                <summary className="text-[11px] text-gray-500 cursor-pointer hover:text-gray-400">📋 Mã lỗi thường gặp</summary>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {Object.entries(INVITE_ERROR_LABELS).map(([code, label]) => (
                    <span key={code} className="text-[11px] text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded">
                      {code}: {label}
                    </span>
                  ))}
                </div>
              </details>
            </div>
          )}

          {/* Message template */}
          {hasMsg && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-gray-400 font-medium">
                  {type === 'mixed' ? '💬 Nội dung tin nhắn *' : 'Nội dung tin nhắn *'}
                </label>
                <div className="flex gap-1">
                  {TEMPLATE_VARS.map(v => (
                    <button key={v} onClick={() => insertVar(setTemplate, v)}
                      className="text-[11px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 hover:bg-blue-500/40 border border-blue-500/30 transition-colors">
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <textarea value={template} onChange={e => setTemplate(e.target.value)}
                rows={4} placeholder="Xin chào {name}, tôi muốn nhắn tin với bạn..."
                className="w-full bg-gray-700 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none transition-colors" />
            </div>
          )}

          {/* Friend request message */}
          {hasFR && (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-xs text-gray-400 font-medium">
                  {type === 'mixed' ? '🤝 Lời nhắn kết bạn *' : 'Lời nhắn kết bạn *'}
                </label>
                <div className="flex gap-1">
                  {TEMPLATE_VARS.map(v => (
                    <button key={v} onClick={() => insertVar(setFriendReqMsg, v)}
                      className="text-[11px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-400 hover:bg-purple-500/40 border border-purple-500/30 transition-colors">
                      {v}
                    </button>
                  ))}
                </div>
              </div>
              <textarea value={friendReqMsg} onChange={e => setFriendReqMsg(e.target.value)}
                rows={3} placeholder="Xin chào {name}, tôi muốn kết bạn với bạn!"
                className="w-full bg-gray-700 border border-purple-600/40 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-purple-500 resize-none transition-colors" />
              <p className="text-[11px] text-gray-600 mt-1">Tối đa 200 ký tự • {friendReqMsg.length}/200</p>
            </div>
          )}

          {/* Delay */}
          <div>
            <label className="text-xs text-gray-400 font-medium block mb-1.5">Delay giữa các lượt gửi *</label>
            <p className="text-xs text-gray-500 mb-2">Zalo giới hạn ~30 tin/giờ. Khuyến nghị tối thiểu 2 phút/lượt.</p>
            <div className="grid grid-cols-4 gap-2">
              {DELAY_OPTIONS.map(opt => (
                <button key={opt.value} onClick={() => setDelay(opt.value)}
                  className={`py-2 rounded-xl border text-xs transition-colors ${delay === opt.value ? 'border-blue-500 bg-blue-500/20 text-blue-300' : 'border-gray-600 text-gray-400 hover:border-gray-500'}`}>
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Warning */}
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-xl p-3">
            <p className="text-xs text-yellow-400 font-medium mb-1">⚠️ Lưu ý</p>
            <p className="text-[11px] text-yellow-300/80 leading-relaxed">
              Tính năng gửi hàng loạt có rủi ro vi phạm điều khoản Zalo. Bạn tự chịu trách nhiệm.
              Giới hạn cứng 60 lượt/giờ/tài khoản được áp dụng tự động để bảo vệ tài khoản.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 py-4 border-t border-gray-700 flex-shrink-0">
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors">
            Hủy
          </button>
          <button onClick={handleSave} disabled={saving || !isValid()}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40 transition-colors font-medium">
            {saving ? (editMode ? 'Đang lưu...' : 'Đang tạo...') : (editMode ? 'Lưu thay đổi' : 'Tạo chiến dịch')}
          </button>
        </div>
      </div>
    </div>
  );
}
