import React from 'react';
import { useChatStore } from '@/store/chatStore';
import { useAppStore } from '@/store/appStore';
import { getAdapter } from '@/lib/adapters/registry';

interface TelegramUserProfilePopupProps {
  userId: string;
  anchorX: number;
  anchorY: number;
  contacts: any[];
  activeAccountId: string;
  activeThreadId: string | null;
  onClose: () => void;
}

/** Telegram-only profile surface, populated from MTProto on demand. */
export function TelegramUserProfilePopup({
  userId, anchorX, anchorY, contacts, activeAccountId, activeThreadId, onClose,
}: TelegramUserProfilePopupProps) {
  const { setActiveThread, getPresence } = useChatStore();
  const { setView, showNotification } = useAppStore();
  const overlayRef = React.useRef<HTMLDivElement>(null);
  const contact = contacts.find(contactItem => String(contactItem.contact_id) === String(userId));
  const [profile, setProfile] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const displayName = contact?.alias || profile?.displayName || contact?.display_name || userId;
  const avatarUrl = profile?.avatarUrl || contact?.avatar_url || '';
  const phone = profile?.phone || contact?.phone || '';
  const isMe = String(userId) === String(activeAccountId);
  const width = 320;
  const left = Math.max(8, Math.min(anchorX + 12, window.innerWidth - width - 8));
  const top = Math.max(8, Math.min(anchorY - 60, window.innerHeight - 500));
  const username = profile?.username ? `@${profile.username}` : '';
  const bio = profile?.bio || '';
  const presence = getPresence(activeAccountId, userId);
  const presenceText = presence?.status === 'online' ? '🟢 Trực tuyến'
    : presence?.status === 'offline' && presence?.lastSeen
      ? `⚫ Hoạt động ${new Date(presence.lastSeen * 1000).toLocaleString('vi-VN')}`
    : presence?.status === 'recently' ? '⚫ Hoạt động gần đây'
    : presence?.status === 'last_week' ? '⚫ Hoạt động tuần trước'
    : presence?.status === 'last_month' ? '⚫ Hoạt động tháng trước'
    : '';
  const flags = [
    profile?.isVerified ? 'Đã xác minh' : '',
    profile?.isPremium ? 'Premium' : '',
    profile?.isBot ? 'Bot' : '',
    profile?.isMutualContact ? 'Liên hệ hai chiều' : '',
  ].filter(Boolean);

  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await (getAdapter('telegram_user') as any).getUserProfile({
          accountId: activeAccountId, userId, threadId: activeThreadId || undefined,
        });
        if (!cancelled && res?.success) setProfile(res.profile || null);
      } catch {
        // Local contact data remains a useful fallback while offline.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeAccountId, activeThreadId, userId]);

  const copyUserName = async () => {
    try {
      await navigator.clipboard.writeText(String(username));
      showNotification('Đã sao chép', 'success');
    } catch {
      showNotification('Không thể sao chép', 'error');
    }
  };

  return (
    <div ref={overlayRef} className="fixed inset-0 z-[200]" onClick={(event) => {
      if (event.target === overlayRef.current) onClose();
    }}>
      <div
        style={{ position: 'absolute', left, top, width }}
        className="overflow-hidden rounded-2xl border border-sky-500/20 bg-popover shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="h-16 bg-gradient-to-br from-sky-600 to-blue-800" />
        <button onClick={onClose} className="absolute right-2 top-2 rounded-full bg-black/35 p-1.5 text-white-important hover:bg-black/55" title="Đóng">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
        <div className="relative px-4 pb-4">
          <div className="absolute -top-9 left-4">
            {avatarUrl ? (
              <img src={avatarUrl} alt={displayName} className="h-[72px] w-[72px] rounded-full border-4 border-border object-cover" />
            ) : (
              <div className="flex h-[72px] w-[72px] items-center justify-center rounded-full border-4 border-border bg-sky-600 text-2xl font-bold text-white">
                {(displayName || 'T').charAt(0).toUpperCase()}
              </div>
            )}
          </div>
          <div className="min-w-0 pl-20 pt-2">
            <p className="truncate text-base font-semibold text-foreground">{displayName}</p>
            {presenceText && <p className="mt-0.5 text-[11px] text-muted-foreground">{presenceText}</p>}
          </div>

          <div className="mt-5 overflow-hidden rounded-xl border border-border/70 text-sm">
            <div className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground">Username</p>
                <p className="truncate font-mono text-xs text-foreground">{username}</p>
              </div>
              <button onClick={copyUserName} className="rounded-lg bg-muted px-2 py-1 text-xs text-foreground hover:bg-accent">Sao chép</button>
            </div>
            <div className="flex items-center justify-between gap-3 px-3 py-2.5">
              <div className="min-w-0">
                <p className="text-[11px] text-muted-foreground">Telegram ID</p>
                <p className="truncate font-mono text-xs text-foreground">{userId}</p>
              </div>
            </div>
            {phone && (
              <div className="border-t border-border/70 px-3 py-2.5">
                <p className="text-[11px] text-muted-foreground">Số điện thoại</p>
                <p className="text-sm text-foreground">{phone}</p>
              </div>
            )}
            {bio && (
              <div className="border-t border-border/70 px-3 py-2.5">
                <p className="text-[11px] text-muted-foreground">Giới thiệu</p>
                <p className="mt-0.5 whitespace-pre-wrap text-sm text-foreground">{bio}</p>
              </div>
            )}
            {profile?.commonChatsCount > 0 && (
              <div className="border-t border-border/70 px-3 py-2.5 text-sm text-foreground">
                {profile.commonChatsCount} nhóm chung
              </div>
            )}
            {flags.length > 0 && (
              <div className="flex flex-wrap gap-1 border-t border-border/70 px-3 py-2.5">
                {flags.map((flag: string) => <span key={flag} className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px]">{flag}</span>)}
              </div>
            )}
          </div>
          {loading && <p className="mt-2 text-center text-[11px] text-subtle-foreground">Đang tải hồ sơ Telegram…</p>}

          {!isMe && (
            <button
              onClick={() => { setActiveThread(userId, 0); setView('chat'); onClose(); }}
              className="mt-3 w-full rounded-xl bg-sky-600 py-2 text-sm font-medium text-white hover:bg-sky-500"
            >
              Nhắn tin
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
