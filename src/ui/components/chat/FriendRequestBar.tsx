import React from 'react';
import { Spinner } from '@/components/common/PageLoading';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';

type FriendStatus =
  | 'loading'
  | 'friend'           // đã là bạn bè
  | 'stranger'         // chưa kết bạn
  | 'sent'             // đã gửi yêu cầu, đang chờ đối phương chấp nhận
  | 'received';        // đối phương đã gửi yêu cầu đến mình

// Hiển thị thanh kết bạn phía dưới pinned bar khi chat với người chưa là bạn

export default function FriendRequestBar({ zaloId, userId, contact, getAuth, onReady }: {
  zaloId: string;
  userId: string;
  contact: any;
  getAuth: () => { cookies: string; imei: string; userAgent: string } | null;
  onReady?: () => void;
}) {
  const [status, setStatus] = React.useState<FriendStatus>('loading');
  const [sendPopupOpen, setSendPopupOpen] = React.useState(false);
  const [sendMsg, setSendMsg] = React.useState('');
  const [sending, setSending] = React.useState(false);
  const { showNotification } = useAppStore();

  // Khi status thoát khỏi 'loading' → thông báo parent để scroll to bottom
  React.useEffect(() => {
    if (status !== 'loading') {
      onReady?.();
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check friendship + request status
  React.useEffect(() => {
    // Skip for non-Zalo channels (FB doesn't have friend requests)
    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
    if (acc && (acc.channel || 'zalo') !== 'zalo') {
      setStatus('friend'); // FB contacts are always "accessible"
      return;
    }

    // Fast sync check: contact already has is_friend flag from Zalo sync
    // Kiểm tra cả is_friend (số) và isFr (flag bổ sung trong store)
    if (contact?.is_friend === 1 || contact?.isFr === 1) {
      setStatus('friend');
      return;
    }

    let cancelled = false;
    const check = async () => {
      try {
        // 1. Check DB (friends table)
        const friendRes = await DataAccessor.isFriend({ zaloId, userId });
        if (cancelled) return;
        if (friendRes?.isFriend) { setStatus('friend'); return; }

        // 2. Confirm via Zalo API (authoritative source)
        // zca-js getFriendRequestStatus trả về: { is_friend, is_requested, is_requesting }
        // is_friend=1 → bạn bè
        // is_requested=1 → mình đã gửi yêu cầu (đang chờ đối phương chấp nhận)
        // is_requesting=1 → đối phương đã gửi yêu cầu đến mình
        const auth = getAuth();
        if (!auth) { setStatus('stranger'); return; }
        const res = await ipc.zalo?.getFriendRequestStatus({ auth, userId });
        if (cancelled) return;

        const resp = res?.response ?? res;
        if (resp?.is_friend === 1) setStatus('friend');
        else if (resp?.is_requested === 1) setStatus('sent');
        else if (resp?.is_requesting === 1) setStatus('received');
        else setStatus('stranger');
      } catch {
        if (!cancelled) setStatus('stranger');
      }
    };
    check();
    return () => { cancelled = true; };
  }, [zaloId, userId, contact?.is_friend, contact?.isFr]);

  // Realtime: đồng bộ trạng thái kết bạn ngay khi có event từ listener
  React.useEffect(() => {
    const unsubAccepted = ipc.on?.('event:friendAccepted', (data: any) => {
      if (data?.zaloId === zaloId && data?.userId === userId) {
        setStatus('friend');
      }
    });

    const unsubSent = ipc.on?.('event:friendRequestSent', (data: any) => {
      const sentUserId = data?.requester?.userId || '';
      if (data?.zaloId === zaloId && sentUserId === userId) {
        setStatus('sent');
      }
    });

    const unsubRemoved = ipc.on?.('event:friendRequestRemoved', (data: any) => {
      if (data?.zaloId === zaloId && data?.userId === userId) {
        setStatus('stranger');
      }
    });

    return () => {
      unsubAccepted?.();
      unsubSent?.();
      unsubRemoved?.();
    };
  }, [zaloId, userId]);

  const handleSendRequest = async () => {
    if (sending) return;
    setSending(true);
    try {
      const auth = getAuth();
      if (!auth) throw new Error('No auth');
      await ipc.zalo?.sendFriendRequest({ auth, userId, msg: sendMsg.trim() });
      setStatus('sent');
      setSendPopupOpen(false);
      showNotification('Đã gửi yêu cầu kết bạn', 'success');
    } catch (e: any) {
      showNotification('Gửi yêu cầu thất bại: ' + e.message, 'error');
    } finally { setSending(false); }
  };

  const handleAccept = async () => {
    if (sending) return;
    setSending(true);
    try {
      const auth = getAuth();
      if (!auth) throw new Error('No auth');
      await ipc.zalo?.acceptFriendRequest({ auth, userId });
      setStatus('friend');
      showNotification('Đã chấp nhận kết bạn', 'success');
      // Update local DB - also remove from friend_requests
      DataAccessor.addFriend({ zaloId, friend: { userId, displayName: contact?.display_name || contact?.alias || '', avatar: contact?.avatar_url || contact?.avatar || '' } }).catch(() => {});
      DataAccessor.removeFriendRequest({ zaloId, userId, direction: 'received' }).catch(() => {});
    } catch (e: any) {
      showNotification('Thất bại: ' + e.message, 'error');
    } finally { setSending(false); }
  };

  const handleReject = async () => {
    if (sending) return;
    setSending(true);
    try {
      const auth = getAuth();
      if (!auth) throw new Error('No auth');
      await ipc.zalo?.rejectFriendRequest({ auth, userId });
      setStatus('stranger');
      showNotification('Đã từ chối yêu cầu kết bạn', 'success');
    } catch (e: any) {
      showNotification('Từ chối thất bại: ' + e.message, 'error');
    } finally { setSending(false); }
  };

  const handleUndo = async () => {
    if (sending) return;
    setSending(true);
    try {
      const auth = getAuth();
      if (!auth) throw new Error('No auth');
      await ipc.zalo?.undoFriendRequest({ auth, userId });
      setStatus('stranger');
      showNotification('Đã huỷ yêu cầu kết bạn', 'success');
    } catch (e: any) {
      showNotification('Huỷ thất bại: ' + e.message, 'error');
    } finally { setSending(false); }
  };

  // Đã là bạn bè → không hiện
  if (status === 'loading' || status === 'friend') return null;

  const displayName = contact?.alias || contact?.display_name || userId;

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-800/80 border-b border-gray-700/60 flex-shrink-0">
        {/* Icon */}
        <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
            <path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/>
            <circle cx="9" cy="7" r="4"/>
            <line x1="19" y1="8" x2="19" y2="14"/>
            <line x1="22" y1="11" x2="16" y2="11"/>
          </svg>
        </div>

        {/* Text */}
        <div className="flex-1 min-w-0">
          {status === 'stranger' && (
            <span className="text-sm text-gray-300">
              Gửi yêu cầu kết bạn tới <span className="font-medium text-white">{displayName}</span>
            </span>
          )}
          {status === 'sent' && (
            <span className="text-sm text-gray-400">
              Đã gửi yêu cầu kết bạn tới <span className="font-medium text-gray-300">{displayName}</span> - đang chờ chấp nhận
            </span>
          )}
          {status === 'received' && (
            <span className="text-sm text-gray-300">
              <span className="font-medium text-white">{displayName}</span> đã gửi cho bạn yêu cầu kết bạn
            </span>
          )}
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 flex-shrink-0">
          {status === 'stranger' && (
            <button
              onClick={() => setSendPopupOpen(true)}
              disabled={sending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Kết bạn
            </button>
          )}
          {status === 'sent' && (
            <button
              onClick={handleUndo}
              disabled={sending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {sending
                ? <Spinner size={3} />
                : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              }
              Huỷ yêu cầu
            </button>
          )}
          {status === 'received' && (
            <>
              <button
                onClick={handleReject}
                disabled={sending}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                Từ chối
              </button>
              <button
                onClick={handleAccept}
                disabled={sending}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
              >
                {sending
                  ? <Spinner size={3} />
                  : <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                }
                Chấp nhận
              </button>
            </>
          )}
        </div>
      </div>

      {/* Send friend request popup */}
      {sendPopupOpen && (
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onClick={() => setSendPopupOpen(false)}
        >
          <div
            className="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-sm mx-4 flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
              <div className="flex items-center gap-3">
                {contact?.avatar_url ? (
                  <img src={contact.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-bold">
                    {(displayName || 'U').charAt(0).toUpperCase()}
                  </div>
                )}
                <div>
                  <p className="font-semibold text-white text-sm">{displayName}</p>
                  <p className="text-xs text-gray-400">Gửi yêu cầu kết bạn</p>
                </div>
              </div>
              <button onClick={() => setSendPopupOpen(false)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="text-xs text-gray-400 font-medium block mb-1.5">Lời nhắn kèm theo (tùy chọn)</label>
                <textarea
                  autoFocus
                  value={sendMsg}
                  onChange={e => setSendMsg(e.target.value)}
                  maxLength={150}
                  placeholder="Xin chào, tôi muốn kết bạn với bạn!"
                  rows={3}
                  className="w-full bg-gray-700 border border-gray-600 focus:border-blue-500 rounded-xl px-3 py-2.5 text-sm text-white placeholder-gray-500 focus:outline-none resize-none transition-colors"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSendRequest(); }}
                />
                <p className="text-right text-[11px] text-gray-400 mt-0.5">{sendMsg.length}/150</p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex gap-3 px-5 pb-5 pt-1">
              <button onClick={() => setSendPopupOpen(false)}
                className="flex-1 py-2.5 rounded-xl bg-gray-700 hover:bg-gray-600 text-sm text-gray-300 transition-colors">
                Huỷ
              </button>
              <button
                onClick={handleSendRequest}
                disabled={sending}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm text-white font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {sending && <Spinner size={4} />}
                Gửi yêu cầu
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
