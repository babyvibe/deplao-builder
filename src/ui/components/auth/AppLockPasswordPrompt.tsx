/**
 * Hỏi lại mật khẩu khoá màn hình trước thao tác nhạy cảm (vd đặt lại mã PIN hội thoại ẩn Zalo — SRS FR-ZL03.7). Khoá màn
 * hình chưa bật → cho qua. Sai mật khẩu tính chung bộ đếm / thời gian chờ của màn hình khoá (lockScreen:verify ở main).
 *
 *   if (!(await confirmAppLockPassword('Đặt lại mã PIN hội thoại ẩn'))) return;
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import ipc from '@/lib/ipc';
import { LockIcon } from '@/components/common/icons';

function AppLockPasswordPrompt({ reason, onDone, onCancel }: { reason: string; onDone: () => void; onCancel: () => void }) {
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError('');
    try {
      const res = await ipc.lockScreen?.verify({ password });
      if (res?.success) onDone();
      else setError(res?.error || 'Sai mật khẩu');
    } catch (err: any) {
      setError(err?.message || 'Không kiểm được mật khẩu');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" onClick={onCancel}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xs space-y-4 overflow-hidden rounded-2xl border border-input bg-card p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <LockIcon className="h-5 w-5 text-muted-foreground" />
          <h3 className="text-base font-semibold text-foreground">Nhập mật khẩu khoá màn hình</h3>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{reason}</p>
        <input type="password" autoFocus autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)}
          aria-label="Mật khẩu khoá màn hình"
          className="w-full rounded-lg border border-input bg-muted px-3 py-2 text-sm text-foreground focus:border-blue-500 focus:outline-none" />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onCancel}
            className="flex-1 rounded-xl py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            Huỷ
          </button>
          <button type="submit" disabled={busy || !password}
            className="flex-1 rounded-xl bg-blue-600 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50">
            {busy ? 'Đang kiểm...' : 'Tiếp tục'}
          </button>
        </div>
      </form>
    </div>
  );
}

/** true = khoá màn hình chưa bật hoặc nhập đúng mật khẩu; đọc trạng thái lỗi thì vẫn hỏi. */
export async function confirmAppLockPassword(reason: string): Promise<boolean> {
  const lock = ipc.lockScreen;
  if (!lock) return true;
  const status = await lock.status().catch(() => null);
  if (status?.success && !status.enabled) return true;
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const close = (result: boolean) => {
      root.unmount();
      container.remove();
      resolve(result);
    };
    root.render(<AppLockPasswordPrompt reason={reason} onDone={() => close(true)} onCancel={() => close(false)} />);
  });
}
