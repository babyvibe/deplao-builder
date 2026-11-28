/**
 * Encrypted Messenger chat whose older messages Deplao cannot load yet: offers to unlock them with the Messenger PIN
 * (the PIN goes to the bridge for one recovery call and is never stored). Shown after loading older messages stopped
 * with "E2EE" for this conversation (facebook/chatWindow.ts fires FB_ENCRYPTED_HISTORY_LOCKED).
 */
import React from 'react';
import { Spinner } from '@/components/common/PageLoading';
import { useAppStore } from '@/store/app/appStore';
import { ipc } from '@/lib/ipc';
import { tr } from '../../../../../shared/i18n';
import { FB_ENCRYPTED_HISTORY_LOCKED, clearEncryptedHistoryLocks, isEncryptedHistoryLocked } from '@/lib/chat/facebook/encryptedHistoryLock';

export default function FacebookEncryptedHistoryBar({ accountId, threadId }: { accountId: string; threadId: string }) {
  const [locked, setLocked] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [pin, setPin] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const showNotification = useAppStore(s => s.showNotification);

  React.useEffect(() => {
    setLocked(isEncryptedHistoryLocked(accountId, threadId));
    setOpen(false);
    setPin('');
    setError('');
    const onLocked = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      if (detail.accountId === accountId && detail.threadId === threadId) setLocked(true);
    };
    window.addEventListener(FB_ENCRYPTED_HISTORY_LOCKED, onLocked);
    return () => window.removeEventListener(FB_ENCRYPTED_HISTORY_LOCKED, onLocked);
  }, [accountId, threadId]);

  if (!locked) return null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const res = await ipc.fb?.unlockEncryptedHistory({ accountId, pin });
      if (res?.success) {
        setPin('');
        setOpen(false);
        setLocked(false);
        clearEncryptedHistoryLocks(accountId);
        showNotification(tr('Đã mở khoá tin nhắn cũ. Mở lại cuộc trò chuyện rồi kéo lên để tải.'), 'success');
        return;
      }
      setError(res?.error || tr('Không mở khoá được tin nhắn cũ'));
    } catch (err: any) {
      setError(err?.message || tr('Không mở khoá được tin nhắn cũ'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 px-4 py-2.5 bg-card/80 border-b border-border/60 flex-shrink-0" data-fb-encrypted-history="1">
      <div className="flex items-center gap-3">
        <div className="w-7 h-7 rounded-full bg-blue-500/20 flex items-center justify-center flex-shrink-0">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
            <rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0110 0v4" />
          </svg>
        </div>
        <p className="flex-1 min-w-0 text-sm text-foreground/80">{tr('Tin nhắn cũ của cuộc trò chuyện này được mã hoá.')}</p>
        {!open && (
          <button
            onClick={() => setOpen(true)}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors flex-shrink-0"
          >
            {tr('Mở khoá bằng mã PIN')}
          </button>
        )}
      </div>
      {open && (
        <form onSubmit={submit} className="flex flex-col gap-2 pl-10">
          <p className="text-xs text-muted-foreground">
            {tr('Mã PIN là mã bạn đặt cho tin nhắn mã hoá trên Messenger. Deplao không lưu mã này. Nhập sai nhiều lần có thể bị Messenger khoá.')}
          </p>
          <div className="flex items-center gap-2">
            <input
              type="password"
              inputMode="numeric"
              autoComplete="off"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
              placeholder={tr('Mã PIN Messenger')}
              className="w-40 rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm text-foreground"
            />
            <button
              type="submit"
              disabled={busy || pin.length < 4}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white text-xs font-semibold rounded-lg transition-colors disabled:opacity-50"
            >
              {busy ? <Spinner size={3} /> : tr('Mở khoá')}
            </button>
            <button
              type="button"
              onClick={() => { setOpen(false); setPin(''); setError(''); }}
              className="px-3 py-1.5 bg-muted hover:bg-accent text-foreground/80 text-xs font-medium rounded-lg transition-colors"
            >
              {tr('Huỷ')}
            </button>
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
        </form>
      )}
    </div>
  );
}
