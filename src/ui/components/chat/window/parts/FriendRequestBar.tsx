import React from 'react';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { Spinner } from '@/components/common/PageLoading';
import { useAppStore } from '@/store/app/appStore';
import { useShallow } from 'zustand/react/shallow';
import { useAccountStore } from '@/store/accounts/accountStore';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { channelSupports, type Channel } from '@/../configs/channels/channelConfig';
import { CHANNEL } from '@/lib/channels/channelHelper';
import PeerInitials from '@/components/common/avatars/PeerInitials';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

type FriendStatus =
  | 'loading'
  | 'friend'           // already friends
  | 'stranger'         // not friends yet
  | 'sent'             // request sent, waiting for the other side to accept
  | 'received';        // the other side has sent a request to me

// Show the friend bar below the pinned bar when chatting with someone who is not a friend yet

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
  const { showNotification } = useAppStore(useShallow(s => ({
    showNotification: s.showNotification,
  })));

  // When the status leaves 'loading' → notify the parent to scroll to bottom
  React.useEffect(() => {
    if (status !== 'loading') {
      onReady?.();
    }
  }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  // Check friendship + request status
  React.useEffect(() => {
    // Skip for channels that don't support friend requests
    const acc = useAccountStore.getState().accounts.find(a => a.zalo_id === zaloId);
    if (acc && !channelSupports((acc.channel || CHANNEL.ZALO) as Channel, 'supportsFriendRequest')) {
      setStatus('friend'); // FB contacts are always "accessible"
      return;
    }
    // Only use Zalo IPC for Zalo accounts
    if (acc && (acc.channel || CHANNEL.ZALO) !== CHANNEL.ZALO) {
      setStatus('friend');
      return;
    }

    // Fast sync check: contact already has is_friend flag from Zalo sync
    // Check both is_friend (number) and isFr (extra flag in the store)
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
        // zca-js getFriendRequestStatus returns: { is_friend, is_requested, is_requesting }
        // is_friend=1 → friends
        // is_requested=1 → I sent the request (waiting for the other side to accept)
        // is_requesting=1 → the other side has sent a request to me
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

  // Realtime: sync the friend status right away when an event arrives from the listener
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

    // Unfriended (on Zalo / phone / another device) → show the "Kết bạn" (Add friend) bar again
    const unsubFriendRemoved = ipc.on?.('event:friendRemoved', (data: any) => {
      if (data?.zaloId === zaloId && String(data?.userId || '') === String(userId)) {
        setStatus('stranger');
      }
    });

    return () => {
      unsubAccepted?.();
      unsubSent?.();
      unsubRemoved?.();
      unsubFriendRemoved?.();
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
      showNotification(tr('Đã gửi yêu cầu kết bạn'), 'success');
    } catch (e: any) {
      showNotification(tr('Gửi yêu cầu thất bại: {{message}}', { message: e.message }), 'error');
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
      showNotification(tr('Đã chấp nhận kết bạn'), 'success');
      // Update local DB - also remove from friend_requests
      DataAccessor.addFriend({ zaloId, friend: { userId, displayName: contact?.display_name || contact?.alias || '', avatar: contact?.avatar_url || contact?.avatar || '' } }).catch(() => {});
      DataAccessor.removeFriendRequest({ zaloId, userId, direction: 'received' }).catch(() => {});
    } catch (e: any) {
      showNotification(tr('Thất bại: {{message}}', { message: e.message }), 'error');
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
      showNotification(tr('Đã từ chối yêu cầu kết bạn'), 'success');
    } catch (e: any) {
      showNotification(tr('Từ chối thất bại: {{message}}', { message: e.message }), 'error');
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
      showNotification(tr('Đã huỷ yêu cầu kết bạn'), 'success');
    } catch (e: any) {
      showNotification(tr('Huỷ thất bại: {{message}}', { message: e.message }), 'error');
    } finally { setSending(false); }
  };

  // Already friends → not shown
  if (status === 'loading' || status === 'friend') return null;

  const displayName = contact?.alias || contact?.display_name || userId;

  return (
    <>
      <div className="flex items-center gap-3 px-4 py-2.5 bg-card/80 border-b border-border/60 flex-shrink-0">
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
            <span className="text-sm text-foreground/80">
              {trx('Gửi yêu cầu kết bạn tới <0>{{displayName}}</0>', { 0: <span className="font-medium text-foreground" />, displayName })}
            </span>
          )}
          {status === 'sent' && (
            <span className="text-sm text-muted-foreground">
              {trx('Đã gửi yêu cầu kết bạn tới <0>{{displayName}}</0> - đang chờ chấp nhận', { 0: <span className="font-medium text-foreground/80" />, displayName })}
            </span>
          )}
          {status === 'received' && (
            <span className="text-sm text-foreground/80">
              {trx('<0>{{displayName}}</0> đã gửi cho bạn yêu cầu kết bạn', { 0: <span className="font-medium text-foreground" />, displayName })}
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
              {tr('Kết bạn')}
            </button>
          )}
          {status === 'sent' && (
            <button
              onClick={handleUndo}
              disabled={sending}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-muted hover:bg-accent text-foreground/80 hover:text-foreground text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
            >
              {sending
                ? <Spinner size={3} />
                : <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              }
              {tr('Huỷ yêu cầu')}
            </button>
          )}
          {status === 'received' && (
            <>
              <button
                onClick={handleReject}
                disabled={sending}
                className="px-3 py-1.5 bg-muted hover:bg-accent text-foreground/80 hover:text-foreground text-xs font-medium rounded-lg transition-colors disabled:opacity-50"
              >
                {tr('Từ chối')}
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
                {tr('Chấp nhận')}
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
            className="bg-card border border-border rounded-2xl shadow-2xl w-full max-w-sm mx-4 flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-border">
              <div className="flex items-center gap-3">
                {contact?.avatar_url ? (
                  <img src={toLocalMediaUrl(contact.avatar_url)} alt="" className="w-10 h-10 rounded-full object-cover"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <PeerInitials id={userId} name={displayName} fallback="U" className="w-10 h-10 text-sm" />
                )}
                <div>
                  <p className="font-semibold text-foreground text-sm">{displayName}</p>
                  <p className="text-xs text-muted-foreground">{tr('Gửi yêu cầu kết bạn')}</p>
                </div>
              </div>
              <button onClick={() => setSendPopupOpen(false)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-4 space-y-3">
              <div>
                <label className="text-xs text-muted-foreground font-medium block mb-1.5">{tr('Lời nhắn kèm theo (tùy chọn)')}</label>
                <textarea
                  autoFocus
                  value={sendMsg}
                  onChange={e => setSendMsg(e.target.value)}
                  maxLength={150}
                  placeholder={tr('Xin chào, tôi muốn kết bạn với bạn!')}
                  rows={3}
                  className="w-full bg-muted border border-input focus:border-blue-500 rounded-xl px-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none resize-none transition-colors"
                  onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSendRequest(); }}
                />
                <p className="text-right text-[11px] text-muted-foreground mt-0.5">{sendMsg.length}/150</p>
              </div>
            </div>

            {/* Footer */}
            <div className="flex gap-3 px-5 pb-5 pt-1">
              <button onClick={() => setSendPopupOpen(false)}
                className="flex-1 py-2.5 rounded-xl bg-muted hover:bg-accent text-sm text-foreground/80 transition-colors">
                {tr('Huỷ')}
              </button>
              <button
                onClick={handleSendRequest}
                disabled={sending}
                className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-sm text-white font-semibold transition-colors flex items-center justify-center gap-2"
              >
                {sending && <Spinner size={4} />}
                {tr('Gửi yêu cầu')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
