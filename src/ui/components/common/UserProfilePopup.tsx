/**
 * UserProfilePopup — Popup thông tin người dùng
 * Reusable: dùng được trong ChatWindow, FriendList, Dashboard, ...
 */
import React from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import ipc from '@/lib/ipc';
import PhoneDisplay from './PhoneDisplay';
import GroupAvatarCommon from './GroupAvatar';

// ─── ActionRow ────────────────────────────────────────────────────────────────
export function ActionRow({ icon, label, onClick, textColor = 'text-gray-300' }: {
  icon: React.ReactNode; label: string; onClick: () => void; textColor?: string;
}) {
  return (
    <button onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700/50 transition-colors text-left ${textColor}`}>
      <span className="flex-shrink-0 text-gray-400">{icon}</span>
      <span className="text-sm">{label}</span>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="ml-auto text-gray-600 flex-shrink-0">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </button>
  );
}

// ─── UserProfilePopup ─────────────────────────────────────────────────────────
export function UserProfilePopup({ userId, anchorX, anchorY, contacts, activeAccountId, activeThreadId, onClose }: {
  userId: string; anchorX: number; anchorY: number;
  contacts: any[]; activeAccountId: string; activeThreadId: string | null;
  onClose: () => void;
}) {
  const { setActiveThread } = useChatStore();
  const { setView, showNotification } = useAppStore();
  const overlayRef = React.useRef<HTMLDivElement>(null);

  const [userInfo, setUserInfo] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [confirmAction, setConfirmAction] = React.useState<string | null>(null);
  const [isBlocked, setIsBlocked] = React.useState(false);
  const [mutualGroups, setMutualGroups] = React.useState<{ groupId: string; name: string; avatar: string }[]>([]);
  const [mutualGroupsLoading, setMutualGroupsLoading] = React.useState(true);
  const [showGroups, setShowGroups] = React.useState(false);
  const [editingAlias, setEditingAlias] = React.useState(false);
  const [aliasValue, setAliasValue] = React.useState('');
  const aliasInputRef = React.useRef<HTMLInputElement>(null);

  // ── Image lightbox ─────────────────────────────────────────────────────
  const [imageViewer, setImageViewer] = React.useState<{ url: string; label: string } | null>(null);

  const isInGroup = !!(activeThreadId && /^\d{15,}$/.test(activeThreadId));

  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (imageViewer) { setImageViewer(null); }
        else if (showGroups) setShowGroups(false);
        else onClose();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose, showGroups, imageViewer]);

  const getAuth = React.useCallback(async () => {
    const accRes = await ipc.login?.getAccounts();
    const acc = accRes?.accounts?.find((a: any) => a.zalo_id === activeAccountId) || accRes?.accounts?.[0];
    if (!acc) throw new Error('No account');
    return { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
  }, [activeAccountId]);

  // Load user info
  React.useEffect(() => {
    const contactInfo = contacts.find(c => c.contact_id === userId);
    if (contactInfo) {
      setUserInfo({ ...contactInfo });
      setAliasValue(contactInfo.display_name || '');
    }
    const load = async () => {
      setLoading(true);
      try {
        const auth = await getAuth();
        const res = await ipc.zalo?.getUserInfo({ auth, userId });
        if (res?.success && res.response) {
          const raw = res.response;
          const profile: any = raw.changed_profiles?.[userId];
          if (!profile) return;
          const apiAlias: string = profile.friendAlias || profile.alias || profile.nickName || '';
          const contactAlias = contactInfo?.alias || '';
          const resolvedAlias = apiAlias || contactAlias;
          const realName = profile.displayName || profile.zaloName || userId;
          const u = {
            display_name: realName,
            alias: resolvedAlias,
            avatar_url: profile.avatar || '',
            cover_url: profile.bgavatar || profile.cover || '',
            bio: profile.status || '',
            gender: profile.gender,
            dob: profile.dob,
            sdob: profile.sdob || '',
            phone: profile.phoneNumber || '',
            isFr: profile.isFr,
            isBlocked: profile.isBlocked,
            zaloName: profile.zaloName || '',
          };
          setUserInfo(u);
          setAliasValue(resolvedAlias);
          setIsBlocked(!!profile.isBlocked);
          if (resolvedAlias && activeAccountId) {
            useChatStore.getState().updateContact(activeAccountId, { contact_id: userId, alias: resolvedAlias });
            ipc.db?.setContactAlias({ zaloId: activeAccountId, contactId: userId, alias: resolvedAlias }).catch(() => {});
          }
        }
      } catch {}
      setLoading(false);
    };
    load();
  }, [userId, activeAccountId]);

  // Load mutual groups
  React.useEffect(() => {
    setMutualGroupsLoading(true);
    setMutualGroups([]);
    const loadGroups = async () => {
      try {
        const auth = await getAuth();
        const res = await ipc.zalo?.getRelatedFriendGroup({ auth, userId });
        if (res?.success && res.response) {
          const raw = res.response;
          let groupIds: string[] = [];
          if (raw.groupRelateds && typeof raw.groupRelateds === 'object') {
            const val = raw.groupRelateds[userId] || raw.groupRelateds['all'];
            if (Array.isArray(val)) groupIds = val;
            else if (val && typeof val === 'object') groupIds = Object.keys(val);
            else {
              const firstVal = Object.values(raw.groupRelateds)[0];
              if (Array.isArray(firstVal)) groupIds = firstVal;
              else if (firstVal && typeof firstVal === 'object') groupIds = Object.keys(firstVal as object);
            }
          } else if (Array.isArray(raw.groupIds)) {
            groupIds = raw.groupIds;
          } else if (Array.isArray(raw)) {
            groupIds = raw;
          }

          if (groupIds.length > 0) {
            const getGroupMeta = (gid: string): { name: string; avatar: string } => {
              const cached = useAppStore.getState().groupInfoCache?.[activeAccountId]?.[gid];
              if (cached?.name) return { name: cached.name, avatar: cached.avatar || '' };
              const allContacts = useChatStore.getState().contacts[activeAccountId] || [];
              const gc = allContacts.find((c: any) => c.contact_id === String(gid));
              if (gc?.display_name && gc.display_name !== gid) return { name: gc.display_name, avatar: gc.avatar_url || '' };
              const gc2 = contacts.find((c: any) => c.contact_id === String(gid));
              if (gc2?.display_name && gc2.display_name !== gid) return { name: gc2.display_name, avatar: gc2.avatar_url || '' };
              return { name: '', avatar: '' };
            };

            const parseMemVerList = (list: string[]): string[] =>
              list.map((entry: string) => {
                const lastUnder = entry.lastIndexOf('_');
                if (lastUnder <= 0) return entry;
                const possibleVer = entry.substring(lastUnder + 1);
                if (/^\d+$/.test(possibleVer) && possibleVer.length < entry.substring(0, lastUnder).length) {
                  return entry.substring(0, lastUnder);
                }
                return entry;
              }).filter(Boolean);

            const groups: { groupId: string; name: string; avatar: string }[] = groupIds.map((gid: string) => ({
              groupId: String(gid),
              ...getGroupMeta(String(gid)),
            }));
            setMutualGroups([...groups]);

            const missing = groups.filter(g => !g.name || /^\d+$/.test(g.name));
            if (missing.length > 0) {
              const updated = [...groups];
              await Promise.allSettled(
                missing.map(async (g) => {
                  try {
                    const infoRes = await ipc.zalo?.getGroupInfo({ auth, groupId: g.groupId });
                    if (!infoRes?.success || !infoRes.response) return;
                    const gridMap = infoRes.response.gridInfoMap || infoRes.response.changed_groups || {};
                    const gi: any = gridMap[g.groupId] || gridMap[`g${g.groupId}`] || (Object.values(gridMap)[0] as any);
                    if (!gi) return;
                    const groupName: string = gi.name || gi.nameChanged || g.groupId;
                    const groupAvt: string = gi.avt || gi.fullAvt || gi.avatar || '';
                    const creatorId: string = String(gi.creatorId || gi.creator || '');
                    const adminIds: string[] = (gi.adminIds || gi.subAdmins || gi.admins || []).map(String);
                    const idx = updated.findIndex(x => x.groupId === g.groupId);
                    if (idx !== -1) updated[idx] = { ...updated[idx], name: groupName, avatar: groupAvt };
                    const currentMemMap = new Map<string, any>();
                    for (const cm of (gi.currentMems || [])) { if (cm?.id) currentMemMap.set(String(cm.id), cm); }
                    const rawMemberIds: string[] = gi.memberIds?.length
                      ? gi.memberIds.map(String)
                      : currentMemMap.size > 0 ? Array.from(currentMemMap.keys()) : parseMemVerList(gi.memVerList || []);
                    let members = rawMemberIds.map((uid: string) => {
                      const cm = currentMemMap.get(uid);
                      return { memberId: uid, displayName: cm?.dName || cm?.zaloName || '', avatar: cm?.avatar || '', role: uid === creatorId ? 1 : adminIds.includes(uid) ? 2 : 0 };
                    });
                    if (rawMemberIds.length > 0) {
                      try {
                        const membRes = await ipc.zalo?.getGroupMembersInfo({ auth, groupId: g.groupId, memberIds: rawMemberIds });
                        const profiles: Record<string, any> = membRes?.response?.profiles || {};
                        if (Object.keys(profiles).length > 0) {
                          members = rawMemberIds.map((uid: string) => {
                            const m = profiles[uid] || {};
                            const cm = currentMemMap.get(uid);
                            return { memberId: uid, displayName: m.displayName || m.zaloName || cm?.dName || '', avatar: m.avatar || cm?.avatar || '', role: uid === creatorId ? 1 : adminIds.includes(uid) ? 2 : 0 };
                          });
                        }
                      } catch {}
                    }
                    ipc.db?.updateContactProfile({ zaloId: activeAccountId, contactId: g.groupId, displayName: groupName, avatarUrl: groupAvt, phone: '', contactType: 'group' }).catch(() => {});
                    if (members.length) ipc.db?.saveGroupMembers({ zaloId: activeAccountId, groupId: g.groupId, members }).catch(() => {});
                    useAppStore.getState().setGroupInfo(activeAccountId, g.groupId, {
                      groupId: g.groupId, name: groupName, avatar: groupAvt,
                      memberCount: gi.totalMember || members.length,
                      members: members.map(m => ({ userId: m.memberId, displayName: m.displayName, avatar: m.avatar, role: m.role })),
                      creatorId, adminIds, settings: gi.setting, fetchedAt: Date.now(),
                    });
                    useChatStore.getState().updateContact(activeAccountId, { contact_id: g.groupId, display_name: groupName, avatar_url: groupAvt, contact_type: 'group' });
                  } catch (err: any) { console.warn(`[MutualGroups] failed for ${g.groupId}:`, err?.message); }
                })
              );
              setMutualGroups([...updated]);
            }
          }
        }
      } catch {}
      setMutualGroupsLoading(false);
    };
    loadGroups();
  }, [userId, activeAccountId]);

  // Display values: alias first
  const name = userInfo?.alias || userInfo?.display_name || userId;
  const realName = userInfo?.display_name || userId;
  const avatar = userInfo?.avatar_url || '';
  const cover = userInfo?.cover_url || '';
  const bio = userInfo?.bio || '';
  const isFriend = !!(userInfo?.isFr === 1 || userInfo?.isFriend || userInfo?.is_friend);
  const isMe = userId === activeAccountId;

  const formatGender = (g: number | undefined) => {
    if (g === undefined || g === null) return null;
    return g === 1 ? 'Nữ' : g === 0 ? 'Nam' : null;
  };

  const formatDob = () => {
    if (userInfo?.sdob && userInfo.sdob !== '00/00/0000') return userInfo.sdob;
    if (userInfo?.dob && userInfo.dob > 0) {
      const d = new Date(userInfo.dob * 1000);
      return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
    }
    return '**/**/****';
  };

  const handleOpenChat = () => { setActiveThread(userId, 0); setView('chat'); onClose(); };

  // ── Add-friend inline compose ──────────────────────────────────────────
  const [friendCompose, setFriendCompose] = React.useState(false);
  const [friendMsg, setFriendMsg] = React.useState('Xin chào! Mình muốn kết bạn với bạn.');
  const [sendingFriendReq, setSendingFriendReq] = React.useState(false);

  const handleAddFriend = () => setFriendCompose(true);

  const doSendFriendRequest = async () => {
    try {
      setSendingFriendReq(true);
      const auth = await getAuth();
      await ipc.zalo?.sendFriendRequest({ auth, userId, msg: friendMsg.trim() || 'Xin chào!' });
      setUserInfo((p: any) => ({ ...p, isFr: 1 }));
      setFriendCompose(false);
      showNotification('Đã gửi lời mời kết bạn!', 'success');
    } catch (e: any) {
      showNotification('Gửi lời mời thất bại: ' + (e?.message || e), 'error');
    } finally {
      setSendingFriendReq(false);
    }
  };

  const handleShareCard = async () => {
    if (!activeThreadId) return;
    try {
      const auth = await getAuth();
      await ipc.zalo?.sendCard({ auth, threadId: activeThreadId, type: isInGroup ? 1 : 0, options: { userId } });
      showNotification('Đã chia sẻ danh thiếp', 'success');
      onClose();
    } catch (e: any) { showNotification('Thất bại: ' + e.message, 'error'); }
  };

  const handleToggleBlock = async () => {
    try {
      const auth = await getAuth();
      if (isBlocked) {
        await ipc.zalo?.unblockUser({ auth, userId });
        setIsBlocked(false);
        showNotification(`Đã bỏ chặn ${name}`, 'success');
      } else {
        await ipc.zalo?.blockUser({ auth, userId });
        setIsBlocked(true);
        showNotification(`Đã chặn ${name}`, 'success');
      }
    } catch (e: any) { showNotification('Thất bại: ' + e.message, 'error'); }
  };

  const handleReport = async () => {
    try {
      const auth = await getAuth();
      await (ipc.zalo as any)?.reportUser?.({ auth, userId, reason: 0 });
      showNotification(`Đã báo cáo ${name}`, 'success');
      onClose();
    } catch (e: any) { showNotification('Thất bại: ' + e.message, 'error'); }
  };

  const handleUnfriend = async () => {
    try {
      const auth = await getAuth();
      await (ipc.zalo as any)?.deleteFriend?.({ auth, userId })
        ?? await (ipc.zalo as any)?.unfriend?.({ auth, userId });
      setUserInfo((p: any) => ({ ...p, isFr: 0 }));
      showNotification(`Đã xoá bạn bè ${name}`, 'success');
      setConfirmAction(null);
    } catch (e: any) { showNotification('Thất bại: ' + e.message, 'error'); }
  };

  const handleSaveAlias = async () => {
    if (!aliasValue.trim()) return;
    try {
      const auth = await getAuth();
      const trimmed = aliasValue.trim();
      await ipc.zalo?.changeFriendAlias({ auth, alias: trimmed, friendId: userId });
      setUserInfo((p: any) => ({ ...p, alias: trimmed }));
      if (activeAccountId) {
        useChatStore.getState().updateContact(activeAccountId, { contact_id: userId, alias: trimmed });
        ipc.db?.setContactAlias({ zaloId: activeAccountId, contactId: userId, alias: trimmed }).catch(() => {});
      }
      showNotification('Đã cập nhật tên gợi nhớ', 'success');
    } catch (e: any) { showNotification('Thất bại: ' + e.message, 'error'); }
    setEditingAlias(false);
  };

  const modalW = 320;
  const left = Math.max(8, Math.min(anchorX + 12, window.innerWidth - modalW - 8));
  const topPos = Math.max(8, Math.min(anchorY - 60, window.innerHeight - 600));

  // ── Mutual groups sub-view ──────────────────────────────────────────────────
  if (showGroups) {
    return (
      <div ref={overlayRef} className="fixed inset-0 z-[200]"
        onClick={(e) => { if (e.target === overlayRef.current) setShowGroups(false); }}>
        <div style={{ position: 'absolute', left, top: topPos, width: modalW }}
          className="bg-[#1e2535] rounded-2xl shadow-2xl border border-gray-700/60 overflow-hidden flex flex-col max-h-[70vh]"
          onClick={e => e.stopPropagation()}>
          <div className="flex items-center gap-2 px-4 py-3 border-b border-gray-700/60">
            <button onClick={() => setShowGroups(false)} className="text-gray-400 hover:text-white transition-colors">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
            </button>
            <h3 className="text-white font-semibold text-sm">Nhóm chung ({mutualGroups.length})</h3>
          </div>
          <div className="flex-1 overflow-y-auto">
            {mutualGroupsLoading && mutualGroups.length === 0 && (
              <div className="flex items-center justify-center py-8">
                <svg className="animate-spin w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              </div>
            )}
            {mutualGroups.map(g => (
              <button key={g.groupId} onClick={() => { setActiveThread(g.groupId, 1); setView('chat'); onClose(); }}
                className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700/50 transition-colors text-left">
                <GroupAvatarCommon name={g.name || g.groupId} avatarUrl={g.avatar} size="sm" />
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
      </div>
    );
  }

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[200]"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div style={{ position: 'absolute', left, top: topPos, width: modalW }}
        className="bg-[#1e2535] rounded-2xl shadow-2xl border border-gray-700/60 overflow-hidden flex flex-col max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>

        {/* Cover */}
        <div className="relative h-28 bg-gradient-to-br from-blue-800 via-indigo-800 to-purple-900 flex-shrink-0">
          {cover && (
            <button
              className="absolute inset-0 w-full h-full focus:outline-none group"
              onClick={() => setImageViewer({ url: cover, label: 'Ảnh bìa' })}
              title="Xem ảnh bìa"
            >
              <img src={cover} alt="" className="w-full h-full object-cover group-hover:brightness-90 transition-all"
                onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
              <span className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                <span className="bg-black/50 rounded-full p-1.5">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                    <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
                  </svg>
                </span>
              </span>
            </button>
          )}
          <div className="absolute inset-0 bg-black/20 pointer-events-none" />
          <button onClick={onClose}
            className="absolute top-2.5 right-2.5 w-7 h-7 bg-black/50 hover:bg-black/70 rounded-full flex items-center justify-center text-white transition-colors z-10">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Avatar + Name */}
        <div className="relative px-4 pb-0">
          <div className="absolute -top-10 left-4">
            {avatar ? (
              <button
                className="relative focus:outline-none group"
                onClick={() => setImageViewer({ url: avatar, label: 'Ảnh đại diện' })}
                title="Xem ảnh đại diện"
              >
                <img src={avatar} alt={name} className="w-20 h-20 rounded-full object-cover border-4 border-[#1e2535] group-hover:brightness-90 transition-all" />
                <span className="absolute inset-0 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <span className="bg-black/50 rounded-full p-1">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                      <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                      <line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>
                    </svg>
                  </span>
                </span>
              </button>
            ) : (
              <div className="w-20 h-20 rounded-full bg-blue-600 border-4 border-[#1e2535] flex items-center justify-center text-white text-2xl font-bold">
                {(name || 'U').charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <div className="pl-24 pt-2 pb-3 min-w-0">
            {loading && !userInfo ? (
              <div className="h-8 flex items-center">
                <svg className="animate-spin w-4 h-4 text-blue-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"/>
                </svg>
              </div>
            ) : editingAlias ? (
              <div className="flex items-center gap-1">
                <input ref={aliasInputRef} value={aliasValue}
                  onChange={e => setAliasValue(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleSaveAlias(); if (e.key === 'Escape') setEditingAlias(false); }}
                  className="flex-1 bg-gray-700 text-white text-sm px-2 py-1 rounded-lg border border-blue-500 focus:outline-none min-w-0"
                  autoFocus
                />
                <button onClick={handleSaveAlias} className="text-blue-400 hover:text-blue-300 p-1">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                </button>
                <button onClick={() => setEditingAlias(false)} className="text-gray-500 hover:text-gray-300 p-1">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 min-w-0">
                <p className="text-white font-bold text-base leading-tight truncate">{name}</p>
                {!isMe && (
                  <button onClick={() => { setEditingAlias(true); setTimeout(() => aliasInputRef.current?.select(), 50); }}
                    title="Đặt tên gợi nhớ"
                    className="text-gray-500 hover:text-blue-400 transition-colors flex-shrink-0">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                )}
              </div>
            )}
            {userInfo?.alias && realName && userInfo.alias !== realName && (
              <p className="text-gray-500 text-xs truncate mt-0.5">({realName})</p>
            )}
            {userInfo?.zaloName && userInfo.zaloName !== name && userInfo.zaloName !== realName && (
              <p className="text-gray-500 text-xs truncate mt-0.5">{userInfo.zaloName}</p>
            )}
          </div>
        </div>

        {/* Primary actions */}
        {!isMe && (
          <div className="px-4 pb-3">
            {friendCompose ? (
              <div className="bg-gray-700/60 border border-gray-600 rounded-xl p-3">
                <p className="text-xs text-gray-400 mb-2">Soạn lời mời kết bạn gửi đến <span className="text-white font-medium">{name}</span></p>
                <textarea
                  value={friendMsg}
                  onChange={e => setFriendMsg(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doSendFriendRequest(); } if (e.key === 'Escape') setFriendCompose(false); }}
                  rows={2}
                  maxLength={200}
                  autoFocus
                  className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none mb-2"
                  placeholder="Lời nhắn kết bạn..."
                />
                <div className="flex gap-2">
                  <button onClick={() => setFriendCompose(false)} disabled={sendingFriendReq}
                    className="flex-1 py-1.5 rounded-lg bg-gray-600 text-gray-300 text-xs hover:bg-gray-500 transition-colors disabled:opacity-50">
                    Hủy
                  </button>
                  <button onClick={doSendFriendRequest} disabled={sendingFriendReq}
                    className="flex-1 py-1.5 rounded-lg bg-blue-600 text-white text-xs hover:bg-blue-700 disabled:opacity-50 transition-colors font-medium flex items-center justify-center gap-1">
                    {sendingFriendReq
                      ? <><svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Đang gửi...</>
                      : <><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> Gửi lời mời</>}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                {!isFriend && (
                  <button onClick={handleAddFriend}
                    className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs py-2 rounded-xl font-semibold transition-colors flex items-center justify-center gap-1.5">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/>
                      <line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>
                    </svg>
                    Kết bạn
                  </button>
                )}
                <button onClick={handleOpenChat}
                  className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs py-2 rounded-xl font-semibold transition-colors flex items-center justify-center gap-1.5">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                  </svg>
                  Nhắn tin
                </button>
              </div>
            )}
          </div>
        )}

        <div className="h-px bg-gray-700/60" />

        {/* Personal info */}
        <div className="px-4 py-3">
          <p className="text-xs font-semibold text-gray-300 mb-2">Thông tin cá nhân</p>
          <div className="space-y-2">
            {bio && (
              <div className="flex gap-3 text-xs">
                <span className="text-gray-500 w-20 flex-shrink-0">Bio</span>
                <span className="text-gray-300 break-words flex-1">{bio}</span>
              </div>
            )}
            <div className="flex gap-3 text-xs">
              <span className="text-gray-500 w-20 flex-shrink-0">Giới tính</span>
              <span className="text-gray-300">{formatGender(userInfo?.gender) ?? '**'}</span>
            </div>
            <div className="flex gap-3 text-xs">
              <span className="text-gray-500 w-20 flex-shrink-0">Ngày sinh</span>
              <span className="text-gray-300">{formatDob()}</span>
            </div>
            <div className="flex gap-3 text-xs">
              <span className="text-gray-500 w-20 flex-shrink-0">Điện thoại</span>
              <span className={userInfo?.phone ? 'text-blue-400' : 'text-gray-600'}>
                {userInfo?.phone
                  ? <PhoneDisplay phone={userInfo.phone} className="text-xs text-blue-400" />
                  : '**********'}
              </span>
            </div>
          </div>
        </div>

        <div className="h-px bg-gray-700/60" />

        {/* Action list */}
        <div className="py-1">
          <ActionRow
            icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg>}
            label={mutualGroupsLoading ? 'Nhóm chung (đang tải...)' : `Nhóm chung${mutualGroups.length > 0 ? ` (${mutualGroups.length})` : ' (0)'}`}
            onClick={() => !mutualGroupsLoading && setShowGroups(true)}
            textColor={mutualGroupsLoading ? 'text-gray-500' : 'text-gray-300'}
          />
          {!isInGroup && activeThreadId && !isMe && (
            <ActionRow
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="2" y="4" width="20" height="16" rx="2"/><circle cx="9" cy="12" r="2"/><path d="M13 12h4M13 16h4"/></svg>}
              label="Chia sẻ danh thiếp"
              onClick={handleShareCard}
            />
          )}
          {!isMe && (
            <ActionRow
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>}
              label={isBlocked ? 'Bỏ chặn tin nhắn và cuộc gọi' : 'Chặn tin nhắn và cuộc gọi'}
              onClick={handleToggleBlock}
              textColor={isBlocked ? 'text-orange-400' : 'text-gray-300'}
            />
          )}
          {!isMe && (
            <ActionRow
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}
              label="Báo xấu"
              onClick={handleReport}
            />
          )}
          {isFriend && !isMe && (
            <ActionRow
              icon={<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M16 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="23" y1="11" x2="17" y2="11"/></svg>}
              label="Xoá khỏi danh sách bạn bè"
              onClick={() => setConfirmAction('unfriend')}
              textColor="text-red-400"
            />
          )}
        </div>
      </div>

      {/* Confirm unfriend */}
      {confirmAction === 'unfriend' && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/70"
          onClick={() => setConfirmAction(null)}>
          <div className="bg-gray-800 rounded-2xl p-5 w-72 border border-gray-700 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-white font-semibold text-base mb-2">Xoá bạn bè?</h3>
            <p className="text-gray-400 text-sm mb-4">Bạn có chắc muốn xoá <span className="text-white font-medium">{name}</span> khỏi danh sách bạn bè?</p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmAction(null)}
                className="flex-1 bg-gray-700 hover:bg-gray-600 text-gray-200 text-sm py-2 rounded-xl font-medium transition-colors">Huỷ</button>
              <button onClick={handleUnfriend}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white text-sm py-2 rounded-xl font-medium transition-colors">Xoá</button>
            </div>
          </div>
        </div>
      )}
      {/* ── Image lightbox ────────────────────────────────────────────── */}
      {imageViewer && (
        <div
          className="fixed inset-0 z-[99999] flex flex-col items-center justify-center bg-black/90 animate-in fade-in duration-150"
          onClick={() => setImageViewer(null)}
        >
          {/* Header */}
          <div className="absolute top-0 left-0 right-0 flex items-center justify-between px-5 py-3 bg-gradient-to-b from-black/70 to-transparent z-10">
            <span className="text-white text-sm font-medium">{imageViewer.label}</span>
            <button
              onClick={() => setImageViewer(null)}
              className="w-8 h-8 rounded-full bg-white/10 hover:bg-white/25 flex items-center justify-center text-white transition-colors"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>
          {/* Image */}
          <img
            src={imageViewer.url}
            alt={imageViewer.label}
            className="max-w-[90vw] max-h-[85vh] object-contain rounded-lg shadow-2xl"
            onClick={e => e.stopPropagation()}
          />
          {/* Hint */}
          <p className="absolute bottom-4 text-white/40 text-xs">Nhấn bên ngoài hoặc Esc để đóng</p>
        </div>
      )}
    </div>
  );
}

