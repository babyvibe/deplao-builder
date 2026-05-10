import React, { useState, useEffect } from 'react';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { useCRMStore } from '@/store/crmStore';
import ipc from '@/lib/ipc';
import { extractApiError } from '@/utils/apiError';
import { UserProfilePopup } from '../../common/UserProfilePopup';

/**
 * CRM Requests Tab — quản lý lời mời kết bạn (nhận được + đã gửi).
 * Tách từ FriendList để dùng trong CRMPage.
 */
export default function CRMRequestsTab() {
  const [requestSubTab, setRequestSubTab] = useState<'received' | 'sent'>('received');
  const [requests, setRequests] = useState<any[]>([]);
  const [sentRequests, setSentRequests] = useState<any[]>([]);
  const [requestsLoading, setRequestsLoading] = useState(false);
  const [requestsRefreshing, setRequestsRefreshing] = useState(false);
  const [requestSearch, setRequestSearch] = useState('');
  const [profilePopup, setProfilePopup] = useState<{ userId: string; x: number; y: number } | null>(null);
  const [initialLoaded, setInitialLoaded] = useState(false);

  const { getActiveAccount } = useAccountStore();
  const activeAccountId = useAccountStore((s) => s.activeAccountId);
  const { showNotification, clearCRMRequestUnseen } = useAppStore();
  const setRequestCount = useCRMStore((s) => s.setRequestCount);

  const getAuth = () => {
    const acc = getActiveAccount();
    return acc ? { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent } : null;
  };

  // ─── Load from DB ─────────────────────────────────────────────────────
  const loadRequestsFromDb = async (): Promise<number> => {
    if (!activeAccountId) return 0;
    setRequestsLoading(true);
    let count = 0;
    try {
      const [recRes, sentRes] = await Promise.all([
        ipc.db?.getFriendRequests({ zaloId: activeAccountId, direction: 'received' }),
        ipc.db?.getFriendRequests({ zaloId: activeAccountId, direction: 'sent' }),
      ]);
      if (recRes?.requests) {
        setRequests(recRes.requests);
        setRequestCount(recRes.requests.length);
        if (recRes.requests.length === 0) clearCRMRequestUnseen(activeAccountId);
        count += recRes.requests.length;
      }
      if (sentRes?.requests) { setSentRequests(sentRes.requests); count += sentRes.requests.length; }
    } catch {}
    setRequestsLoading(false);
    return count;
  };

  const refreshRequestsFromApi = async () => {
    const auth = getAuth();
    if (!auth || !activeAccountId) return;
    setRequestsRefreshing(true);
    try {
      const recRes = await ipc.zalo?.getFriendRecommendations(auth);
      const recommItems: any[] = recRes?.response?.recommItems || [];
      const incoming = recommItems
        .filter((item: any) => item?.dataInfo?.recommType === 2)
        .map((item: any) => {
          const d = item.dataInfo as any;
          return {
            userId: d.userId || '',
            displayName: d.displayName || d.zaloName || '',
            avatar: d.avatar || '',
            phone: d.phoneNumber || '',
            msg: d.recommInfo?.message || d.recommInfo?.customText || '',
            createdAt: d.recommTime ? Number(d.recommTime) : Date.now(),
          };
        }).filter((r: any) => r.userId);
      setRequests(incoming);
      setRequestCount(incoming.length);
      await ipc.db?.saveFriendRequests({ zaloId: activeAccountId, requests: incoming, direction: 'received' });
      if (incoming.length === 0) clearCRMRequestUnseen(activeAccountId);

      const sentApiRes = await ipc.zalo?.getSentFriendRequests(auth);
      const sentMap: Record<string, any> = sentApiRes?.response || {};
      const sentEntries = Array.isArray(sentMap) ? sentMap : Object.values(sentMap);
      const normalizedSent = sentEntries.map((r: any) => ({
        userId: r.userId || r.uid || '',
        displayName: r.displayName || r.zaloName || '',
        avatar: r.avatar || '',
        phone: r.phoneNumber || r.phone || '',
        msg: r.fReqInfo?.message || '',
        createdAt: r.fReqInfo?.time ? Number(r.fReqInfo.time) : Date.now(),
      })).filter((r: any) => r.userId);
      setSentRequests(normalizedSent);
      await ipc.db?.saveFriendRequests({ zaloId: activeAccountId, requests: normalizedSent, direction: 'sent' });

      showNotification('Đã cập nhật lời mời kết bạn', 'success');
    } catch (err: any) {
      showNotification(extractApiError(err, 'Lỗi tải lời mời kết bạn'), 'error');
    }
    setRequestsRefreshing(false);
  };

  // ─── Actions ──────────────────────────────────────────────────────────
  const handleAcceptRequest = async (userId: string) => {
    const auth = getAuth();
    if (!auth || !activeAccountId) return;
    try {
      await ipc.zalo?.acceptFriendRequest({ auth, userId });
      showNotification('Đã chấp nhận lời mời!', 'success');
      await ipc.db?.removeFriendRequest({ zaloId: activeAccountId, userId, direction: 'received' });
      setRequests(prev => {
        const next = prev.filter(r => r.userId !== userId);
        setRequestCount(next.length);
        if (next.length === 0) clearCRMRequestUnseen(activeAccountId);
        return next;
      });
    } catch (err: any) { showNotification(extractApiError(err, 'Chấp nhận lời mời thất bại'), 'error'); }
  };

  const handleRejectRequest = async (userId: string) => {
    const auth = getAuth();
    if (!auth || !activeAccountId) return;
    try {
      await ipc.zalo?.rejectFriendRequest({ auth, userId });
      showNotification('Đã từ chối lời mời', 'info');
      await ipc.db?.removeFriendRequest({ zaloId: activeAccountId, userId, direction: 'received' });
      setRequests(prev => {
        const next = prev.filter(r => r.userId !== userId);
        setRequestCount(next.length);
        if (next.length === 0) clearCRMRequestUnseen(activeAccountId);
        return next;
      });
    } catch (err: any) { showNotification(extractApiError(err, 'Từ chối lời mời thất bại'), 'error'); }
  };

  const handleCancelSentRequest = async (userId: string) => {
    const auth = getAuth();
    if (!auth || !activeAccountId) return;
    try {
      await ipc.zalo?.undoFriendRequest({ auth, userId });
      showNotification('Đã hủy lời mời kết bạn', 'info');
      await ipc.db?.removeFriendRequest({ zaloId: activeAccountId, userId, direction: 'sent' });
      setSentRequests(prev => prev.filter(r => (r.userId || r.uid) !== userId));
    } catch (err: any) { showNotification(extractApiError(err, 'Hủy lời mời thất bại'), 'error'); }
  };

  // ─── Mount: load from DB ─────────────────────────────────────────────
  useEffect(() => {
    if (!activeAccountId || initialLoaded) return;
    setInitialLoaded(true);
    clearCRMRequestUnseen(activeAccountId);
    loadRequestsFromDb().then(count => {
      if (count === 0) refreshRequestsFromApi();
    });
  }, [activeAccountId]);

  useEffect(() => {
    setInitialLoaded(false);
    setRequests([]);
    setSentRequests([]);
  }, [activeAccountId]);

  // ─── Real-time: lắng nghe lời mời kết bạn mới ────────────────────────
  useEffect(() => {
    const normalizeRequest = (req: any) => {
      const userId = req.userId || req.uid || req.actorId || '';
      if (!userId) return null;
      return {
        userId,
        displayName: req.displayName || req.dName || req.zaloName || userId,
        avatar: req.avatar || req.avt || '',
        phone: req.phoneNumber || req.phone || '',
        msg: req.recommInfo?.message || req.recommInfo?.customText || req.msg || '',
        createdAt: req.recommTime ? Number(req.recommTime) : Date.now(),
      };
    };

    const upsertRequest = (prev: any[], next: any) => {
      const filtered = prev.filter(r => r.userId !== next.userId);
      return [next, ...filtered];
    };

    const unsubIncoming = ipc.on?.('event:friendRequest', (data: any) => {
      if (!activeAccountId || data.zaloId !== activeAccountId) return;
      const newReq = normalizeRequest(data.requester || {});
      if (!newReq) return;
      setRequests(prev => {
        const next = upsertRequest(prev, newReq);
        setRequestCount(next.length);
        return next;
      });
    });

    const unsubSent = ipc.on?.('event:friendRequestSent', (data: any) => {
      if (!activeAccountId || data.zaloId !== activeAccountId) return;
      const newReq = normalizeRequest(data.requester || {});
      if (!newReq) return;
      setSentRequests(prev => upsertRequest(prev, newReq));
    });

    const unsubRemoved = ipc.on?.('event:friendRequestRemoved', (data: any) => {
      if (!activeAccountId || data.zaloId !== activeAccountId) return;
      const userId = data.userId || '';
      const direction: 'received' | 'sent' | 'all' = data.direction || 'sent';
      if (!userId) return;

      if (direction === 'received' || direction === 'all') {
        setRequests(prev => {
          const next = prev.filter(r => r.userId !== userId);
          setRequestCount(next.length);
          if (activeAccountId && next.length === 0) clearCRMRequestUnseen(activeAccountId);
          return next;
        });
      }
      if (direction === 'sent' || direction === 'all') {
        setSentRequests(prev => prev.filter(r => r.userId !== userId));
      }
    });

    return () => {
      unsubIncoming?.();
      unsubSent?.();
      unsubRemoved?.();
    };
  }, [activeAccountId]);

  // ─── Nav event: click desktop notification → chuyển sang tab Lời mời ─
  useEffect(() => {
    const handler = () => { setRequestSubTab('received'); };
    window.addEventListener('nav:friendRequests', handler);
    return () => window.removeEventListener('nav:friendRequests', handler);
  }, []);

  return (
    <div className="h-full flex flex-col">

      {/* ── Sticky header: sub-tabs + toolbar ────────────────────────── */}
      <div className="flex-shrink-0 px-4 pt-4 pb-2 border-b border-gray-700/60">
        {/* Sub-tabs */}
        <div className="flex bg-gray-800 rounded-lg p-0.5 mb-3">
          <button onClick={() => setRequestSubTab('received')}
            className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${requestSubTab === 'received' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
            📥 Nhận được{requests.length > 0 ? ` (${requests.length})` : ''}
          </button>
          <button onClick={() => setRequestSubTab('sent')}
            className={`flex-1 py-1.5 rounded-md text-xs font-medium transition-colors ${requestSubTab === 'sent' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
            📤 Đã gửi{sentRequests.length > 0 ? ` (${sentRequests.length})` : ''}
          </button>
        </div>

        {/* Toolbar: search + count + refresh */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input type="text" value={requestSearch} onChange={e => setRequestSearch(e.target.value)}
              placeholder="Tên, SĐT, UID..."
              className="w-full bg-gray-700 border border-gray-600 rounded-full pl-7 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
          </div>
          <span className="text-xs text-gray-500 flex-shrink-0">
            {requestsLoading ? '...' : (requestSubTab === 'received' ? requests.length : sentRequests.length)} lời mời
          </span>
          <button onClick={refreshRequestsFromApi} disabled={requestsRefreshing}
            title="Cập nhật từ Zalo"
            className="w-7 h-7 rounded-full flex items-center justify-center text-blue-400 hover:text-blue-300 hover:bg-gray-700 disabled:opacity-40 transition-colors flex-shrink-0">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
              className={requestsRefreshing ? 'animate-spin' : ''}>
              <polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
          </button>
        </div>
      </div>

      {/* ── Scrollable list ───────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-1.5">
        {requestsLoading ? (
          <div className="text-center text-gray-500 py-10 text-sm">Đang tải...</div>
        ) : requestSubTab === 'received' ? (
          requests.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-3xl mb-2">📭</p>
              <p className="text-gray-500 text-sm mb-3">Không có lời mời nào</p>
              <button onClick={refreshRequestsFromApi} disabled={requestsRefreshing}
                className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors">
                {requestsRefreshing ? 'Đang tải...' : 'Tải từ Zalo'}
              </button>
            </div>
          ) : (
            requests
              .filter(req => {
                if (!requestSearch.trim()) return true;
                const q = requestSearch.toLowerCase();
                return (req.displayName || '').toLowerCase().includes(q) ||
                  (req.phone || '').toLowerCase().includes(q) ||
                  (req.userId || '').toLowerCase().includes(q);
              })
              .map((req: any) => {
                const uid = req.userId;
                const name = req.displayName || uid;
                const msgText = req.msg || '';
                return (
                  <div key={uid}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gray-800 border border-gray-700/60 hover:border-gray-600 transition-colors">
                    {/* Avatar */}
                    <button
                      onClick={(e) => setProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })}
                      className="flex-shrink-0 focus:outline-none"
                      title="Xem thông tin"
                    >
                      {req.avatar
                        ? <img src={req.avatar} alt="" className="w-10 h-10 rounded-full object-cover hover:ring-2 hover:ring-blue-400 transition-all" />
                        : <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold hover:ring-2 hover:ring-blue-400 transition-all">
                            {(name || 'U').charAt(0).toUpperCase()}
                          </div>}
                    </button>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-100 truncate">{name}</p>
                      {msgText
                        ? <p className="text-[11px] text-gray-400 italic truncate mt-0.5">"{msgText}"</p>
                        : <p className="text-[11px] text-gray-500 mt-0.5">Muốn kết bạn với bạn</p>}
                    </div>
                    {/* Actions */}
                    <div className="flex gap-1.5 flex-shrink-0">
                      <button onClick={() => handleAcceptRequest(uid)}
                        className="bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-lg transition-colors font-medium">
                        Đồng ý
                      </button>
                      <button onClick={() => handleRejectRequest(uid)}
                        className="bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs px-3 py-1.5 rounded-lg transition-colors">
                        Từ chối
                      </button>
                    </div>
                  </div>
                );
              })
          )
        ) : (
          sentRequests.length === 0 ? (
            <div className="text-center py-10">
              <p className="text-3xl mb-2">📤</p>
              <p className="text-gray-500 text-sm mb-3">Chưa gửi lời mời nào</p>
              <button onClick={refreshRequestsFromApi} disabled={requestsRefreshing}
                className="text-xs bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg transition-colors">
                {requestsRefreshing ? 'Đang tải...' : 'Tải từ Zalo'}
              </button>
            </div>
          ) : (
            sentRequests
              .filter(req => {
                if (!requestSearch.trim()) return true;
                const q = requestSearch.toLowerCase();
                return (req.displayName || '').toLowerCase().includes(q) ||
                  (req.phone || '').toLowerCase().includes(q) ||
                  (req.userId || req.uid || '').toLowerCase().includes(q);
              })
              .map((req: any) => {
                const uid = req.userId || req.uid;
                const name = req.displayName || uid;
                const msgText = req.msg || '';
                return (
                  <div key={uid}
                    className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-gray-800 border border-gray-700/60 hover:border-gray-600 transition-colors">
                    {/* Avatar */}
                    <button
                      onClick={(e) => setProfilePopup({ userId: uid, x: e.clientX, y: e.clientY })}
                      className="flex-shrink-0 focus:outline-none"
                      title="Xem thông tin"
                    >
                      {req.avatar
                        ? <img src={req.avatar} alt="" className="w-10 h-10 rounded-full object-cover hover:ring-2 hover:ring-blue-400 transition-all" />
                        : <div className="w-10 h-10 rounded-full bg-gray-600 flex items-center justify-center text-white font-bold hover:ring-2 hover:ring-blue-400 transition-all">
                            {(name || 'U').charAt(0).toUpperCase()}
                          </div>}
                    </button>
                    {/* Info */}
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-gray-100 truncate">{name}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[11px] text-yellow-500">⏳ Chờ chấp nhận</span>
                        {msgText && <span className="text-[11px] text-gray-500 italic truncate">· "{msgText}"</span>}
                      </div>
                    </div>
                    {/* Action */}
                    <button onClick={() => handleCancelSentRequest(uid)}
                      className="flex-shrink-0 bg-gray-700 hover:bg-red-700 text-gray-300 hover:text-white text-xs px-3 py-1.5 rounded-lg transition-colors">
                      Hủy
                    </button>
                  </div>
                );
              })
          )
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
    </div>
  );
}

