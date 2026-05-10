import React, { useState, useEffect, useRef } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useChatStore } from '@/store/chatStore';
import ipc from '@/lib/ipc';
import { extractApiError } from '@/utils/apiError';
import PhoneDisplay from '../../common/PhoneDisplay';
import { UserProfilePopup } from '../../common/UserProfilePopup';
import AddFriendModal from '../../common/AddFriendModal';

/**
 * CRM Search Tab — tìm kiếm người dùng theo SĐT + gợi ý kết bạn.
 * Tách từ FriendList để dùng trong CRMPage.
 */
export default function CRMSearchTab() {
  const [searchPhone, setSearchPhone] = useState('');
  const [searchResult, setSearchResult] = useState<any>(null);
  const [searching, setSearching] = useState(false);
  const [recommendations, setRecommendations] = useState<any[]>([]);
  const [recsLoading, setRecsLoading] = useState(false);
  const [dismissedRecs, setDismissedRecs] = useState<Set<string>>(new Set());
  const [addFriendModal, setAddFriendModal] = useState<{ userId: string; displayName: string; avatar: string } | null>(null);
  const [sendingFriendReq, setSendingFriendReq] = useState(false);
  const [profilePopup, setProfilePopup] = useState<{ userId: string; x: number; y: number } | null>(null);
  const [friends, setFriends] = useState<any[]>([]);

  const { getActiveAccount } = useAccountStore();
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const { showNotification, openQuickChat } = useAppStore();
  const contactList = useChatStore((s) => s.contacts[activeAccountId || ''] || []);

  const getAuth = () => {
    const acc = getActiveAccount();
    return acc ? { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent } : null;
  };

  const handleMessage = (userId: string, opts?: { displayName?: string; avatar?: string; phone?: string }) => {
    openQuickChat({
      target: {
        userId,
        displayName: opts?.displayName || userId,
        avatarUrl: opts?.avatar || '',
        threadType: 0,
        phone: opts?.phone || '',
      },
      zaloId: activeAccountId ?? undefined,
    });
  };

  // Load friends from DB to check if already friends
  useEffect(() => {
    if (!activeAccountId) return;
    ipc.db?.getFriends({ zaloId: activeAccountId }).then(res => {
      if (res?.friends) setFriends(res.friends);
    }).catch(() => {});
  }, [activeAccountId]);

  // Load recommendations on mount
  useEffect(() => {
    if (recommendations.length === 0 && !recsLoading) {
      loadRecommendations();
    }
  }, []);

  const handleSearch = async () => {
    const auth = getAuth();
    if (!auth || !searchPhone.trim()) return;
    setSearching(true);
    setSearchResult(null);
    try {
      const res = await ipc.zalo?.findUser({ auth, phone: searchPhone.trim() });
      const user = res?.response || null;
      if (user?.uid) {
        try {
          const infoRes = await ipc.zalo?.getUserInfo({ auth, userId: user.uid });
          const profile = infoRes?.response?.changed_profiles?.[user.uid];
          setSearchResult(profile ? { ...user, isFr: profile.isFr ?? 0, isBlocked: profile.isBlocked ?? 0 } : user);
        } catch { setSearchResult(user); }
      } else { setSearchResult(user); }
    } catch (err: any) {
      showNotification(extractApiError(err, 'Lỗi tìm kiếm'), 'error');
    }
    setSearching(false);
  };

  const openAddFriendModal = (userId: string, displayName: string, avatar: string) => {
    setAddFriendModal({ userId, displayName, avatar });
  };

  const doSendFriendRequest = async (userId: string, displayName: string, avatar: string, msg: string) => {
    const auth = getAuth();
    if (!auth) return;
    setSendingFriendReq(true);
    try {
      await ipc.zalo?.sendFriendRequest({ auth, userId, msg });
      showNotification('Đã gửi lời mời kết bạn!', 'success');
      setAddFriendModal(null);
      setSearchResult((p: any) => p?.uid === userId ? { ...p, _sentRequest: true } : p);
    } catch (err: any) {
      showNotification(extractApiError(err, 'Gửi lời mời kết bạn thất bại'), 'error');
    } finally {
      setSendingFriendReq(false);
    }
  };

  const loadRecommendations = async () => {
    const auth = getAuth();
    if (!auth || recsLoading) return;
    setRecsLoading(true);
    try {
      const res = await ipc.zalo?.getFriendRecommendations(auth);
      const items = (res?.response?.recommItems || [])
        .filter((item: any) => item?.dataInfo?.recommType === 1)
        .map((item: any) => item.dataInfo as any);
      setRecommendations(items);
      setDismissedRecs(new Set());
    } catch {}
    setRecsLoading(false);
  };

  const isAlreadyFriend = searchResult
    ? (searchResult.isFr === 1 || friends.some((f: any) => (f.userId || f.uid) === searchResult.uid))
    : false;
  const isBlocked = searchResult?.isBlocked === 1;

  return (
    <div className="flex-1 overflow-y-auto p-4">
      <div className="flex gap-2 mb-4">
        <input type="text" value={searchPhone} onChange={e => setSearchPhone(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSearch()}
          placeholder="Nhập số điện thoại..."
          autoFocus
          className="input-field text-sm flex-1" />
        <button onClick={handleSearch} disabled={searching} className="btn-primary text-white px-3 py-2 text-sm">
          {searching ? '...' : 'Tìm'}
        </button>
      </div>
      {searchResult && (
        <div className="bg-gray-700 rounded-xl p-4">
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={(e) => setProfilePopup({ userId: searchResult.uid, x: e.clientX, y: e.clientY })}
              className="flex-shrink-0 focus:outline-none"
              title="Xem thông tin"
            >
              {searchResult.avatar
                ? <img src={searchResult.avatar} alt="" className="w-12 h-12 rounded-full object-cover hover:ring-2 hover:ring-blue-400 transition-all" />
                : <div className="w-12 h-12 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold hover:ring-2 hover:ring-blue-400 transition-all">
                    {(searchResult.display_name || searchResult.zalo_name || 'U').charAt(0).toUpperCase()}
                  </div>}
            </button>
            <div className="flex-1 min-w-0">
              {(() => {
                const searchContact = contactList.find(c => c.contact_id === searchResult.uid);
                const searchAlias = searchContact?.alias || '';
                const searchRealName = searchResult.display_name || searchResult.zalo_name || '';
                const searchDisplayName = searchAlias || searchRealName;
                return <>
                  <p className="text-white font-medium truncate">{searchDisplayName}</p>
                  {searchAlias && searchAlias !== searchRealName && (
                    <p className="text-xs text-gray-400 truncate">({searchRealName})</p>
                  )}
                  {!searchAlias && <p className="text-xs text-gray-400">{searchResult.uid}</p>}
                </>;
              })()}
            </div>
          </div>
          <div className="flex gap-2">
            {isBlocked
              ? <span className="flex-1 text-center text-sm text-red-400 py-2 border border-red-700 rounded-lg">🚫 Đã chặn</span>
              : isAlreadyFriend
                ? <span className="flex-1 text-center text-sm text-green-400 py-2 border border-green-700 rounded-lg">✓ Đã là bạn bè</span>
                : <button onClick={() => openAddFriendModal(searchResult.uid, searchResult.display_name || searchResult.zalo_name, searchResult.avatar)} className="btn-primary text-white flex-1 text-sm">Kết bạn</button>}
            <button onClick={() => handleMessage(searchResult.uid, { displayName: searchResult.display_name || searchResult.zalo_name, avatar: searchResult.avatar })}
              className="btn-primary text-white flex-1 text-sm flex items-center justify-center gap-1">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              Nhắn tin
            </button>
          </div>
        </div>
      )}
      {!searching && searchPhone && searchResult === null && (
        <p className="text-gray-500 text-sm text-center">Không tìm thấy người dùng</p>
      )}

      {/* ── Gợi ý kết bạn carousel ── */}
      <div className="mt-5">
        <div className="flex items-center justify-between mb-2.5">
          <span className="text-xs font-semibold text-gray-300 uppercase tracking-wide">Gợi ý kết bạn</span>
          <button onClick={loadRecommendations} disabled={recsLoading}
            className="flex items-center gap-1 text-[11px] text-blue-400 hover:text-blue-300 disabled:opacity-40 transition-colors">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={recsLoading ? 'animate-spin' : ''}>
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            {recsLoading ? 'Đang tải...' : 'Làm mới'}
          </button>
        </div>

        {recsLoading ? (
          <div className="flex gap-3 overflow-hidden">
            {[1, 2, 3].map(i => (
              <div key={i} className="flex-shrink-0 w-36 h-44 rounded-xl bg-gray-700/50 animate-pulse" />
            ))}
          </div>
        ) : recommendations.filter(r => !dismissedRecs.has(r.userId)).length === 0 ? (
          <p className="text-xs text-gray-500 text-center py-4">Không có gợi ý nào</p>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-2 snap-x snap-mandatory"
            style={{ scrollbarWidth: 'thin', scrollbarColor: '#4B5563 transparent' }}>
            {recommendations
              .filter((r: any) => !dismissedRecs.has(r.userId))
              .map((rec: any) => {
                const name = rec.displayName || rec.zaloName || rec.userId;
                const rawMsg = rec.recommInfo?.message || rec.recommInfo?.customText || '';
                const isJsonMsg = rawMsg.trim().startsWith('{') || rawMsg.trim().startsWith('[');
                const msg = isJsonMsg ? '' : rawMsg;
                const way = rec.recommInfo?.suggestWay;
                const reason = msg || (way === 1 ? '📱 Từ danh bạ' : way === 2 ? '👥 Bạn chung' : way === 3 ? '🏢 Cùng nơi làm việc' : '✨ Gợi ý cho bạn');
                const phone = rec.phoneNumber || '';
                return (
                  <div key={rec.userId}
                    className="flex-shrink-0 w-36 snap-start flex flex-col items-center bg-gray-800 border border-gray-700 rounded-xl p-3 gap-2 transition-colors hover:border-gray-600">
                    <button
                      onClick={(e) => setProfilePopup({ userId: rec.userId, x: e.clientX, y: e.clientY })}
                      className="focus:outline-none mt-1"
                      title="Xem thông tin"
                    >
                      {rec.avatar
                        ? <img src={rec.avatar} alt="" className="w-14 h-14 rounded-full object-cover hover:ring-2 hover:ring-blue-400 transition-all" />
                        : <div className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xl font-bold hover:ring-2 hover:ring-blue-400 transition-all">
                            {(name || 'U').charAt(0).toUpperCase()}
                          </div>}
                    </button>
                    <div className="text-center w-full min-w-0">
                      <p className="text-xs font-semibold text-gray-100 truncate leading-tight">{name}</p>
                      {phone && <p className="text-[11px] text-gray-500 truncate mt-0.5">{phone}</p>}
                      <p className="text-[11px] text-gray-500 truncate mt-0.5 italic" title={reason}>{reason}</p>
                    </div>
                    <div className="flex gap-1.5 w-full mt-auto">
                      <button onClick={() => openAddFriendModal(rec.userId, name, rec.avatar || '')}
                        className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-[11px] py-1.5 rounded-lg transition-colors font-medium">
                        Kết bạn
                      </button>
                      <button
                        onClick={() => setDismissedRecs(prev => new Set([...prev, rec.userId]))}
                        title="Bỏ qua"
                        className="w-7 flex-shrink-0 flex items-center justify-center bg-gray-700 hover:bg-gray-600 rounded-lg text-gray-400 hover:text-gray-200 transition-colors text-xs">
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>
        )}
      </div>

      {/* User profile popup */}
      {profilePopup && activeAccountId && (
        <UserProfilePopup
          userId={profilePopup.userId}
          anchorX={profilePopup.x}
          anchorY={profilePopup.y}
          contacts={[]}
          activeAccountId={activeAccountId}
          activeThreadId={null}
          onClose={() => setProfilePopup(null)}
        />
      )}

      {/* AddFriend modal */}
      {addFriendModal && (
        <AddFriendModal
          displayName={addFriendModal.displayName}
          avatar={addFriendModal.avatar}
          sending={sendingFriendReq}
          onConfirm={msg => doSendFriendRequest(addFriendModal.userId, addFriendModal.displayName, addFriendModal.avatar, msg)}
          onClose={() => !sendingFriendReq && setAddFriendModal(null)}
        />
      )}
    </div>
  );
}

