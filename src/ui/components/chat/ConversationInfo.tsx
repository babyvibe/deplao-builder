import React, { useEffect, useRef, useState } from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import ipc from '@/lib/ipc';
import PhoneDisplay from '../common/PhoneDisplay';
import { CreateGroupModal } from './GroupModals';
import GroupInfoPanel from './GroupInfoPanel';
import MediaSection, { MediaDetailPanel, MediaTab } from './MediaSection';
import { UserActionSection } from './ConversationActions';
import { extractUserProfile } from '../../../utils/profileUtils';
import GroupAvatar from '../common/GroupAvatar';
import { getCapability, type Channel } from '../../../configs/channelConfig';

function muteUntilToDuration(until: number): number | string {
  if (until === 0) return -1;
  const remainSec = Math.round((until - Date.now()) / 1000);
  if (Math.abs(remainSec - 3600) <= 300) return 3600;
  if (Math.abs(remainSec - 14400) <= 300) return 14400;
  const t = new Date(until);
  if (t.getHours() === 8 && t.getMinutes() === 0) return 'until8AM';
  return remainSec > 0 ? remainSec : -1;
}



export default function ConversationInfo() {
  const { activeThreadId, activeThreadType, contacts } = useChatStore();
  const { activeAccountId } = useAccountStore();

  const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];
  const contact = contactList.find((c) => c.contact_id === activeThreadId);
  const isGroup = activeThreadType === 1 || contact?.contact_type === 'group';

  if (isGroup) return <GroupInfoPanel />;
  return <UserConversationInfo />;
}

// ─── UserConversationInfo ─────────────────────────────────────────────────────
function UserConversationInfo() {
  const { activeThreadId, activeThreadType, contacts, updateContact } = useChatStore();
  const { activeAccountId, getActiveAccount } = useAccountStore();
  const { showNotification, setMuted, clearMuted, isMuted: isMutedFn } = useAppStore();

  const [isPinned, setIsPinned] = useState(false);
  const [isLocalPinned, setIsLocalPinned] = useState(false);
  const [editingAlias, setEditingAlias] = useState(false);
  const [aliasValue, setAliasValue] = useState('');
  const [hovering, setHovering] = useState(false);
  const [muteDropdownOpen, setMuteDropdownOpen] = useState(false);
  const [muteDropdownPos, setMuteDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const muteRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [mediaDetailTab, setMediaDetailTab] = useState<MediaTab | null>(null);
  const [showMutualGroups, setShowMutualGroups] = useState(false);
  const [mutualGroups, setMutualGroups] = useState<{ groupId: string; name: string; avatar: string }[]>([]);
  const [mutualGroupsLoading, setMutualGroupsLoading] = useState(false);
  // isFriendDB: check thực từ bảng friends trong DB (đáng tin hơn contact.is_friend)
  const [isFriendDB, setIsFriendDB] = useState<boolean | null>(null);

  const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];
  const contact = contactList.find((c) => c.contact_id === activeThreadId);
  const channelCap = getCapability((contact?.channel || 'zalo') as Channel);
  // Hiển thị: ưu tiên alias → display_name
  const displayName = contact?.alias || contact?.display_name || activeThreadId || '';
  const avatarUrl = contact?.avatar_url || '';

  // Check friends table mỗi khi thread thay đổi
  useEffect(() => {
    setIsFriendDB(null);
    if (!activeAccountId || !activeThreadId) return;
    ipc.db?.isFriend({ zaloId: activeAccountId, userId: activeThreadId })
      .then((res: any) => setIsFriendDB(!!res?.isFriend))
      .catch(() => setIsFriendDB(!!(contact?.is_friend)));
  }, [activeAccountId, activeThreadId]);
  // Init aliasValue từ alias (không phải display_name) khi thread thay đổi
  useEffect(() => {
    setAliasValue(contact?.alias || '');
  }, [activeThreadId, contact?.alias]);

  const getAuth = () => {
    const acc = getActiveAccount();
    if (!acc) return null;
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  };

  // Load pin status on mount / thread change
  useEffect(() => {
    if (!activeAccountId || !activeThreadId) return;
    loadPinStatus();
    // Always load local pin status regardless of channel
    ipc.db?.getLocalPinnedConversations({ zaloId: activeAccountId })
      .then((res: any) => setIsLocalPinned((res?.threadIds || []).includes(activeThreadId)))
      .catch(() => {});
  }, [activeAccountId, activeThreadId]);

  // Close mute dropdown on outside click
  useEffect(() => {
    if (!muteDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (muteRef.current && !muteRef.current.contains(e.target as Node)) setMuteDropdownOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [muteDropdownOpen]);

  const loadPinStatus = async () => {
    if (!channelCap.supportsPinConversation) return;
    const auth = getAuth();
    if (!auth) return;
    try {
      const res = await ipc.zalo?.getPinConversations(auth);
      // FIX: response is { conversations: string[], version: number }
      // IDs are prefixed with 'u' (user) or 'g' (group)
      const convIds: string[] = res?.response?.conversations || [];
      setIsPinned(convIds.some((id: string) => id.replace(/^[ug]/, '') === activeThreadId));
    } catch {}
  };

  const handleRefresh = async () => {
    if (loading) return;
    setLoading(true);
    try {
      await loadPinStatus();
      // Also fetch fresh user profile (avatar, name, phone)
      if (activeAccountId && activeThreadId) {
        const auth = getAuth();
        if (auth) {
          try {
            const res = await ipc.zalo?.getUserInfo({ auth, userId: activeThreadId });
            const profile = res?.response?.changed_profiles?.[activeThreadId]
              || res?.response?.data?.[activeThreadId];
            if (profile) {
              const { displayName: newName, avatar: newAvatar, phone: newPhone, gender, birthday, alias: newAlias } = extractUserProfile(profile);
              // Only patch fields that have actual values — never spread undefined
              const patch: any = { contact_id: activeThreadId };
              if (newName) patch.display_name = newName;
              if (newAvatar) patch.avatar_url = newAvatar;
              if (newPhone) patch.phone = newPhone;
              if (newAlias) patch.alias = newAlias;
              if (newName || newAvatar || newPhone || newAlias) {
                updateContact(activeAccountId, patch);
                await ipc.db?.updateContactProfile({
                  zaloId: activeAccountId, contactId: activeThreadId,
                  displayName: newName, avatarUrl: newAvatar, phone: newPhone,
                  gender, birthday,
                });
                // Lưu alias vào DB (field riêng, không overwrite display_name)
                if (newAlias) {
                  ipc.db?.setContactAlias({
                    zaloId: activeAccountId,
                    contactId: activeThreadId,
                    alias: newAlias,
                  }).catch(() => {});
                }
              }
            }
          } catch {}
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleMuteWithTime = (until: number) => {
    if (!activeAccountId || !activeThreadId) return;
    setMuted(activeAccountId, activeThreadId, until);
    showNotification('Đã tắt thông báo', 'success');
    setMuteDropdownOpen(false);
    // Gọi API đồng bộ lên Zalo (fire-and-forget) — chỉ khi kênh hỗ trợ
    if (channelCap.supportsMuteSync) {
      const auth = getAuth();
      if (auth) {
        const duration = muteUntilToDuration(until);
        ipc.zalo?.setMute({ auth, threadId: activeThreadId, threadType: 0, duration, action: 1 }).catch(() => {});
      }
    }
  };

  const handleUnmute = () => {
    if (!activeAccountId || !activeThreadId) return;
    clearMuted(activeAccountId, activeThreadId);
    showNotification('Đã bật thông báo', 'success');
    // Gọi API đồng bộ lên Zalo (fire-and-forget) — chỉ khi kênh hỗ trợ
    if (channelCap.supportsMuteSync) {
      const auth = getAuth();
      if (auth) {
        ipc.zalo?.setMute({ auth, threadId: activeThreadId, threadType: 0, action: 3 }).catch(() => {});
      }
    }
  };

  const handleTogglePin = async () => {
    if (!activeThreadId) return;
    if (!channelCap.supportsPinConversation) {
      // FB / non-Zalo: use local pin only
      if (!activeAccountId) return;
      const newVal = !isLocalPinned;
      await ipc.db?.setLocalPinnedConversation({ zaloId: activeAccountId, threadId: activeThreadId, isPinned: newVal });
      setIsLocalPinned(newVal);
      showNotification(newVal ? 'Đã ghim trong app' : 'Đã bỏ ghim khỏi app', 'success');
      return;
    }
    const auth = getAuth();
    if (!auth) return;
    try {
      await ipc.zalo?.setPinConversation({
        auth,
        conversations: [{ threadId: activeThreadId, type: activeThreadType }],
        isPin: !isPinned,
      });
      setIsPinned(!isPinned);
      showNotification(isPinned ? 'Đã bỏ ghim hội thoại' : 'Đã ghim hội thoại', 'success');
    } catch (e: any) {
      showNotification('Lỗi: ' + e.message, 'error');
    }
  };

  const handleSaveAlias = async () => {
    if (!channelCap.supportsAlias) return;
    const auth = getAuth();
    if (!auth || !activeThreadId) return;
    try {
      const trimmed = aliasValue.trim();
      const res = await ipc.zalo?.changeFriendAlias({ auth, alias: trimmed, friendId: activeThreadId });
      if (res && !res.success && res.error) {
        showNotification('Lỗi cập nhật biệt danh: ' + res.error, 'error');
        return;
      }
      if (activeAccountId) {
        // Lưu alias vào field riêng, KHÔNG overwrite display_name
        useChatStore.getState().updateContact(activeAccountId, {
          contact_id: activeThreadId,
          alias: trimmed,
        });
        ipc.db?.setContactAlias({
          zaloId: activeAccountId,
          contactId: activeThreadId,
          alias: trimmed,
        }).catch(() => {});
      }
      showNotification('Đã cập nhật biệt danh', 'success');
      setEditingAlias(false);
    } catch (e: any) {
      showNotification('Lỗi: ' + e.message, 'error');
    }
  };

  // Load mutual groups khi mở sub-panel
  const handleOpenMutualGroups = () => {
    if (!channelCap.supportsMutualGroups) return;
    setShowMutualGroups(true);
    if (mutualGroups.length > 0) return;
    if (!activeAccountId || !activeThreadId) return;
    const acc = getActiveAccount();
    if (!acc) return;
    const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
    setMutualGroupsLoading(true);
    ipc.zalo?.getRelatedFriendGroup({ auth, userId: activeThreadId })
      .then((res: any) => {
        if (!res?.success || !res.response) return;
        const raw = res.response;
        let groupIds: string[] = [];
        if (raw.groupRelateds && typeof raw.groupRelateds === 'object') {
          const val = raw.groupRelateds[activeThreadId] || raw.groupRelateds['all'];
          if (Array.isArray(val)) groupIds = val;
          else if (val && typeof val === 'object') groupIds = Object.keys(val);
          else {
            const firstVal = Object.values(raw.groupRelateds)[0];
            if (Array.isArray(firstVal)) groupIds = firstVal as string[];
          }
        } else if (Array.isArray(raw.groupIds)) {
          groupIds = raw.groupIds;
        } else if (Array.isArray(raw)) {
          groupIds = raw;
        }
        const allContacts = useChatStore.getState().contacts[activeAccountId] || [];
        const groups = groupIds.map((gid: string) => {
          const cached = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[gid];
          if (cached?.name) return { groupId: String(gid), name: cached.name, avatar: cached.avatar || '' };
          const gc = allContacts.find((c: any) => c.contact_id === String(gid));
          return { groupId: String(gid), name: gc?.display_name || '', avatar: gc?.avatar_url || '' };
        });
        setMutualGroups(groups);
      })
      .catch(() => {})
      .finally(() => setMutualGroupsLoading(false));
  };

  const isMuted = activeAccountId && activeThreadId ? isMutedFn(activeAccountId, activeThreadId) : false;

  // Mutual groups sub-panel
  if (showMutualGroups && activeThreadId) {
    return (
      <div className="w-72 h-full flex-shrink-0 bg-gray-800 border-l border-gray-700 flex flex-col overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-3 border-b border-gray-700">
          <button onClick={() => setShowMutualGroups(false)}
            className="p-1 rounded-lg hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <span className="text-sm font-semibold text-white flex-1 text-center pr-6">
            Nhóm chung ({mutualGroups.length})
          </span>
        </div>
        <div className="flex-1 overflow-y-auto">
          {mutualGroupsLoading && mutualGroups.length === 0 && (
            <div className="flex items-center justify-center py-10">
              <svg className="animate-spin w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
              </svg>
            </div>
          )}
          {mutualGroups.map(g => (
            <button key={g.groupId}
              onClick={() => { useChatStore.getState().setActiveThread(g.groupId, 1); setShowMutualGroups(false); }}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700/50 transition-colors text-left">
              <GroupAvatar
                name={g.name || g.groupId}
                avatarUrl={g.avatar}
                groupInfo={useAppStore.getState().groupInfoCache?.[activeAccountId || '']?.[g.groupId] || null}
                size="sm"
              />
              <span className="text-sm text-gray-200 truncate flex-1">{g.name || g.groupId}</span>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-600 flex-shrink-0">
                <polyline points="9 18 15 12 9 6"/>
              </svg>
            </button>
          ))}
          {!mutualGroupsLoading && mutualGroups.length === 0 && (
            <p className="text-xs text-gray-500 text-center py-8">Không có nhóm chung</p>
          )}
        </div>
      </div>
    );
  }

  // Media detail — thay thế toàn bộ panel
  if (mediaDetailTab !== null && activeThreadId) {
    return (
      <MediaDetailPanel
        threadId={activeThreadId}
        activeAccountId={activeAccountId || ''}
        tab={mediaDetailTab}
        onBack={() => setMediaDetailTab(null)}
      />
    );
  }

  const isFriend = isFriendDB !== null
    ? isFriendDB
    : !!(contact?.is_friend || contact?.isFr === 1);

  // @ts-ignore
  // @ts-ignore
  return (
    <>
    <div className="w-72 h-full flex-shrink-0 bg-gray-800 border-l border-gray-700 flex flex-col overflow-y-auto">
      {/* Header */}
      <div className="flex items-center px-4 py-3 border-b border-gray-700">
        <span className="flex-1 text-sm font-semibold text-white text-center">Thông tin liên hệ</span>
        {channelCap.supportsAlias && (
        <button title="Cập nhật thông tin" onClick={handleRefresh} disabled={loading}
          className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors hover:bg-gray-700 text-gray-400 hover:text-white disabled:opacity-50 flex-shrink-0">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={loading ? 'animate-spin' : ''}>
            <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
            <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
          </svg>
        </button>
        )}
      </div>

      {/* Avatar + name */}
      <div className="flex flex-col items-center py-6 px-4 border-b border-gray-700">
        {avatarUrl ? (
          <img src={avatarUrl} alt={displayName} className="w-16 h-16 rounded-full object-cover mb-3" />
        ) : (
          <div className="w-16 h-16 rounded-full flex items-center justify-center text-white text-2xl font-bold mb-3 bg-blue-600">
            {(displayName || 'U').charAt(0).toUpperCase()}
          </div>
        )}
        {editingAlias ? (
          <div className="flex items-center gap-2 mt-2 w-full px-2">
            <input value={aliasValue} onChange={e => setAliasValue(e.target.value)}
              className="flex-1 bg-gray-700 border border-gray-600 rounded-lg px-2 py-1 text-sm text-white focus:outline-none focus:border-blue-500 text-center"
              placeholder="Nhập biệt danh..." autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleSaveAlias(); if (e.key === 'Escape') setEditingAlias(false); }} />
            <button onClick={handleSaveAlias} className="px-2 py-1 bg-blue-600 rounded-lg text-xs text-white hover:bg-blue-700 flex-shrink-0">Lưu</button>
            <button onClick={() => setEditingAlias(false)} className="px-2 py-1 bg-gray-700 rounded-lg text-xs text-gray-300 hover:bg-gray-600 flex-shrink-0">✕</button>
          </div>
        ) : (
          <div className={`group flex items-center gap-1.5 mt-1 ${channelCap.supportsAlias ? 'cursor-pointer' : ''}`}
            onMouseEnter={() => channelCap.supportsAlias && setHovering(true)} onMouseLeave={() => setHovering(false)}
            onClick={() => { if (!channelCap.supportsAlias) return; setAliasValue(contact?.alias || ''); setEditingAlias(true); }}>
            <p className="text-white font-semibold text-base text-center">{displayName}</p>
            {channelCap.supportsAlias && (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className={`text-gray-300 transition-opacity flex-shrink-0 ${hovering ? 'opacity-100' : 'opacity-0'}`}>
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            )}
          </div>
        )}
        {contact?.alias && contact?.display_name && contact.alias !== contact.display_name && (
          <p className="text-gray-500 text-xs mt-0.5 text-center">({contact.display_name})</p>
        )}
        {contact?.phone && (
          <p className="text-gray-400 text-xs mt-0.5">
            📞 <PhoneDisplay phone={contact.phone} className="text-gray-400 text-xs" />
          </p>
        )}
      </div>

      {/* Action buttons */}
      <div className="flex justify-around py-3 border-b border-gray-700 relative">
        {/* Mute with time picker dropdown */}
        <div className="relative" ref={muteRef}>
          <UserActionBtn
            icon={isMuted ? '🔔' : '🔕'}
            label={isMuted ? 'Bật thông báo' : 'Tắt thông báo'}
            onClick={isMuted ? handleUnmute : () => {
              if (muteRef.current) {
                const rect = muteRef.current.getBoundingClientRect();
                setMuteDropdownPos({ top: rect.bottom + 4, left: Math.max(4, rect.left - 60) });
              }
              setMuteDropdownOpen(p => !p);
            }}
            active={isMuted}
          />
          {muteDropdownOpen && !isMuted && muteDropdownPos && (
            <div className="fixed z-50 bg-gray-800 border border-gray-700 rounded-xl shadow-2xl min-w-[210px] py-1"
              style={{ top: muteDropdownPos.top, left: muteDropdownPos.left }}>
              {[
                { label: 'Trong 1 giờ',             until: () => Date.now() + 60 * 60 * 1000 },
                { label: 'Trong 4 giờ',             until: () => Date.now() + 4 * 60 * 60 * 1000 },
                { label: 'Cho đến 8:00 AM',         until: () => { const d = new Date(); d.setDate(d.getDate() + (d.getHours() >= 8 ? 1 : 0)); d.setHours(8,0,0,0); return d.getTime(); } },
                { label: 'Cho đến khi được mở lại', until: () => 0 },
              ].map(opt => (
                <button key={opt.label} onClick={() => handleMuteWithTime(opt.until())}
                  className="w-full flex items-center px-4 py-2.5 text-sm text-gray-300 hover:bg-gray-700 hover:text-white text-left transition-colors">
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>
        {channelCap.supportsPinConversation && (
          <UserActionBtn icon={isPinned ? '📌' : '📍'} label={isPinned ? 'Bỏ ghim' : 'Ghim hội thoại'} onClick={handleTogglePin} active={isPinned} />
        )}
        {!channelCap.supportsPinConversation && (
          <UserActionBtn icon={isLocalPinned ? '🔖' : '📎'} label={isLocalPinned ? 'Bỏ ghim app' : 'Ghim trong app'} onClick={handleTogglePin} active={isLocalPinned} />
        )}
        {channelCap.supportsCreateGroup && (
          <UserActionBtn icon="👥" label="Tạo nhóm" onClick={() => setCreateGroupOpen(true)} />
        )}
      </div>


      {/* Shared media / file / link section */}
      {activeThreadId && (
        <MediaSection
          threadId={activeThreadId}
          onOpenDetail={(t) => setMediaDetailTab(t)}
        />
      )}

      {/* User actions: nhóm chung, chặn, báo xấu, xoá bạn, xoá lịch sử */}
      {activeThreadId && (
        <UserActionSection
          userId={activeThreadId}
          userName={displayName}
          isFriend={isFriend}
          onMutualGroupsOpen={handleOpenMutualGroups}
          channelCap={channelCap}
          onFriendRemoved={() => {
            setIsFriendDB(false);
            if (activeAccountId) {
              useChatStore.getState().updateContact(activeAccountId, { contact_id: activeThreadId, is_friend: 0 });
            }
          }}
        />
      )}


      {/* Create group modal */}
      {createGroupOpen && activeThreadId && (
        <CreateGroupModal preSelected={[activeThreadId]} onClose={() => setCreateGroupOpen(false)} />
      )}
    </div>
    </>
  );
}

function UserActionBtn({ icon, label, onClick, active }: { icon: string; label: string; onClick: () => void; active?: boolean }) {
  return (
    <button onClick={onClick}
      className="flex flex-col items-center gap-1 py-2 px-1 rounded-xl hover:bg-gray-700 transition-colors text-center"
      title={label}
    >
      <div className={`w-9 h-9 rounded-full flex items-center justify-center text-lg ${active ? 'bg-blue-600' : 'bg-gray-700'}`}>{icon}</div>
      <span className={`text-[9px] leading-tight ${active ? 'text-blue-400' : 'text-gray-400'}`}>{label}</span>
    </button>
  );
}
