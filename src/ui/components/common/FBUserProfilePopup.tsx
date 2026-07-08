/**
 * FBUserProfilePopup - Popup thông tin người dùng Facebook
 * Thiết kế riêng, khác biệt với Zalo UserProfilePopup.
 * Reusable: dùng được trong ChatWindow, ConversationInfo, ...
 */
import React from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';

export function FBUserProfilePopup({ userId, anchorX, anchorY, contacts, activeAccountId, activeThreadId, onClose }: {
  userId: string; anchorX: number; anchorY: number;
  contacts: any[]; activeAccountId: string; activeThreadId: string | null;
  onClose: () => void;
}) {
  const { setActiveThread } = useChatStore();
  const { setView, showNotification } = useAppStore();
  const overlayRef = React.useRef<HTMLDivElement>(null);

  const [userInfo, setUserInfo] = React.useState<any>(() => {
    const contact = contacts.find(c => c.contact_id === userId);
    return contact || null;
  });
  const [confirmBlock, setConfirmBlock] = React.useState(false);
  const [blocking, setBlocking] = React.useState(false);
  const [isBlocked, setIsBlocked] = React.useState(false);
  const avatarRefreshedRef = React.useRef(false);

  React.useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (confirmBlock) setConfirmBlock(false);
        else onClose();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose, confirmBlock]);

  // Fetch user info từ Facebook HTML nếu chưa có (E2EE / hội thoại mới)
  React.useEffect(() => {
    const hasName = userInfo?.display_name || userInfo?.alias;
    const hasAvatar = userInfo?.avatar_url;
    if (hasName && hasAvatar) return;
    if (!activeAccountId || !/^\d+$/.test(userId)) return;
    ipc.fb?.getUserInfoFacebookHtml({ accountId: activeAccountId, userId })
      .then(res => {
        if (res.success && (res.name || res.avatarUrl)) {
          const patch: any = {};
          if (res.name) { patch.display_name = res.name; patch.alias = res.name; }
          if (res.avatarUrl) patch.avatar_url = res.avatarUrl;
          setUserInfo(prev => ({ ...prev, ...patch }));
          if (activeAccountId) {
            useChatStore.getState().updateContact(activeAccountId, { contact_id: userId, ...patch });
          }
        }
      })
      .catch(() => {});
  }, [userId, activeAccountId]);

  const name = userInfo?.alias || userInfo?.display_name || userId;
  const rawAvatar = userInfo?.avatar_url || '';
  const avatar = toLocalMediaUrl(rawAvatar);
  const [avatarFailed, setAvatarFailed] = React.useState(false);
  const isMe = userId === activeAccountId;

  const modalW = 300;
  const left = Math.max(8, Math.min(anchorX + 12, window.innerWidth - modalW - 8));
  const topPos = Math.max(8, Math.min(anchorY - 60, window.innerHeight - 520));

  const handleOpenChat = () => { setActiveThread(userId, 0); setView('chat'); onClose(); };

  const handleOpenFBProfile = () => {
    ipc.shell?.openExternal(`https://facebook.com/${userId}`);
    onClose();
  };

  const handleToggleBlock = async () => {
    setBlocking(true);
    try {
      if (isBlocked) {
        await ipc.fb?.unblockUser({ accountId: activeAccountId, userId });
        setIsBlocked(false);
        showNotification(`Đã bỏ chặn ${name}`, 'success');
      } else {
        await ipc.fb?.blockUser({ accountId: activeAccountId, userId });
        setIsBlocked(true);
        showNotification(`Đã chặn ${name}`, 'success');
      }
    } catch (e: any) {
      showNotification('Thất bại: ' + (e?.message || e), 'error');
    }
    setBlocking(false);
    setConfirmBlock(false);
  };

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[200]"
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}>
      <div style={{ position: 'absolute', left, top: topPos, width: modalW }}
        className="bg-white rounded-2xl shadow-2xl overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}>

        {/* Facebook-style header gradient */}
        <div className="relative h-24 bg-gradient-to-r from-[#1877F2] via-[#2565d3] to-[#42b72a] flex-shrink-0">
          <button onClick={onClose}
            className="absolute top-2.5 right-2.5 w-7 h-7 bg-white/20 hover:bg-white/40 rounded-full flex items-center justify-center text-white transition-colors z-10">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* Avatar + Name (overlapping the header) */}
        <div className="relative px-5 pb-3">
          <div className="absolute -top-10 left-5">
            {avatar && !avatarFailed ? (
              <img src={avatar} alt=""
                className="w-20 h-20 rounded-full object-cover border-4 border-white shadow-md"
                onError={() => {
                  setAvatarFailed(true);
                  if (activeAccountId && /^\d+$/.test(userId) && !avatarRefreshedRef.current) {
                    avatarRefreshedRef.current = true;
                    ipc.fb.refreshContactAvatar({ accountId: activeAccountId, userId })
                      .then(res => {
                        if (res.success && res.avatarUrl) {
                          setUserInfo(prev => ({ ...prev, avatar_url: res.avatarUrl }));
                          setAvatarFailed(false);
                          useChatStore.getState().updateContact(activeAccountId, {
                            contact_id: userId,
                            avatar_url: res.avatarUrl,
                          });
                        }
                      })
                      .catch(() => {});
                  }
                }} />
            ) : (
              <div className="w-20 h-20 rounded-full bg-[#1877F2] border-4 border-white shadow-md flex items-center justify-center text-white text-2xl font-bold">
                {(name || 'U').charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <div className="pl-[5.5rem] pt-1.5 min-w-0">
            <p className="text-gray-900 font-bold text-base leading-tight truncate">{name}</p>
            <div className="flex items-center gap-1.5 mt-0.5">
              <span className="text-gray-400 text-xs">ID: {userId}</span>
              <button onClick={() => { navigator.clipboard.writeText(userId); showNotification('Đã sao chép ID', 'success'); }}
                className="text-gray-400 hover:text-[#1877F2] transition-colors"
                title="Sao chép ID">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
              </button>
            </div>
            {/* Friend status badge */}
            {userInfo?.is_friend === 1 && (
              <div className="inline-flex items-center gap-1 mt-1.5 bg-blue-50 text-[#1877F2] text-[11px] font-medium px-2.5 py-0.5 rounded-full">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                Bạn bè
              </div>
            )}
          </div>
        </div>

        <div className="h-px bg-gray-100 mx-5" />

        {/* Quick actions */}
        <div className="px-5 py-4 space-y-2">
          <p className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Hành động</p>
          <button onClick={handleOpenChat}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl bg-[#1877F2] hover:bg-[#166fe5] text-white text-sm font-medium transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            Nhắn tin
          </button>
          <button onClick={handleOpenFBProfile}
            className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="#1877F2">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
            </svg>
            Mở trang Facebook
          </button>
          {!isMe && (
            <>
              <div className="h-px bg-gray-100" />
              <button onClick={() => setConfirmBlock(true)}
                className="w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl hover:bg-red-50 text-red-500 text-sm font-medium transition-colors">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/>
                </svg>
                {isBlocked ? 'Bỏ chặn người dùng' : 'Chặn người dùng'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Confirm block dialog */}
      {confirmBlock && (
        <div className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50"
          onClick={() => setConfirmBlock(null)}>
          <div className="bg-white rounded-2xl p-5 w-72 border shadow-xl"
            onClick={e => e.stopPropagation()}>
            <h3 className="text-gray-900 font-semibold text-base mb-2">
              {isBlocked ? 'Bỏ chặn người dùng?' : 'Chặn người dùng?'}
            </h3>
            <p className="text-gray-400 text-sm mb-4">
              {isBlocked
                ? `Bạn có chắc muốn bỏ chặn ${name}?`
                : `${name} sẽ không thể nhắn tin hoặc gọi cho bạn.`}
            </p>
            <div className="flex gap-2">
              <button onClick={() => setConfirmBlock(null)} disabled={blocking}
                className="flex-1 bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm py-2 rounded-xl font-medium transition-colors">Huỷ</button>
              <button onClick={handleToggleBlock} disabled={blocking}
                className="flex-1 bg-red-600 hover:bg-red-700 text-white text-sm py-2 rounded-xl font-medium transition-colors flex items-center justify-center gap-1">
                {blocking ? (
                  <><svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Đang xử lý...</>
                ) : (isBlocked ? 'Bỏ chặn' : 'Chặn')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
