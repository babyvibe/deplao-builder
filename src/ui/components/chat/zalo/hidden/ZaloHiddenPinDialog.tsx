/**
 * Dialog to set / change the Zalo hidden-conversation PIN (ZL-03). The PIN is shared with the Zalo app on the phone; Deplao does not store the PIN.
 * Changing the PIN requires the correct old PIN (Deplao checks it in main itself, zca-js does not require it). Forgot the old PIN: Settings → Account → the
 * "Hội thoại ẩn" (Hidden conversations) row under the Zalo account → "Quên mã PIN? Đặt lại" (Forgot PIN? Reset) (ZaloHiddenPinSection).
 *
 *   const ok = await showZaloPinDialog({ accountId, mode: 'setup' });
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import ipc from '@/lib/ipc';
import { LockIcon } from '@/components/common/icons';
import { zaloAuthFor } from '@/hooks/zalo/useZaloHidden';
import { tr } from '../../../../../shared/i18n';

export type ZaloPinDialogMode = 'setup' | 'change';

function PinField({ label, value, onChange, autoFocus }: { label: string; value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type="password" inputMode="numeric" autoComplete="off" maxLength={4} autoFocus={autoFocus}
        value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 4))}
        className="w-full rounded-lg border border-input bg-muted px-3 py-2 text-center text-lg tracking-[0.6em] text-foreground focus:border-blue-500 focus:outline-none"
      />
    </label>
  );
}

export function ZaloHiddenPinDialog({ accountId, mode, onDone, onCancel }: {
  accountId: string;
  mode: ZaloPinDialogMode;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [oldPin, setOldPin] = React.useState('');
  const [pin, setPin] = React.useState('');
  const [pin2, setPin2] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (mode === 'change' && oldPin.length !== 4) { setError(tr('Nhập mã PIN hiện tại (4 chữ số)')); return; }
    if (pin.length !== 4) { setError(tr('Mã PIN mới phải gồm 4 chữ số')); return; }
    if (pin !== pin2) { setError(tr('Hai lần nhập mã PIN mới không khớp')); return; }
    const auth = zaloAuthFor(accountId);
    if (!auth) { setError(tr('Không tìm thấy tài khoản')); return; }
    setBusy(true);
    setError('');
    try {
      const res = await ipc.zalo?.hiddenSetPin({ auth, pin, oldPin: mode === 'change' ? oldPin : undefined });
      if (res?.success) onDone();
      else setError(res?.error || tr('Zalo từ chối đặt mã PIN'));
    } catch (err: any) {
      setError(err?.message || tr('Không đặt được mã PIN'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-4" onClick={onCancel}>
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xs space-y-4 overflow-hidden rounded-2xl border border-input bg-card p-5 shadow-2xl">
        <div className="flex items-center gap-2">
          <LockIcon className="h-5 w-5 text-red-500" />
          <h3 className="text-base font-semibold text-foreground">{mode === 'setup' ? tr('Đặt mã PIN hội thoại ẩn') : tr('Đổi mã PIN hội thoại ẩn')}</h3>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {tr('Mã PIN dùng chung với app Zalo trên điện thoại. Gõ đúng 4 số vào ô tìm kiếm để xem hội thoại ẩn. PIN chỉ che hội thoại khỏi người nhìn màn hình, không mã hoá tin nhắn.')}
        </p>
        {mode === 'change' && <PinField label={tr('Mã PIN hiện tại')} value={oldPin} onChange={setOldPin} autoFocus />}
        <PinField label={tr('Mã PIN mới (4 chữ số)')} value={pin} onChange={setPin} autoFocus={mode === 'setup'} />
        <PinField label={tr('Nhập lại mã PIN mới')} value={pin2} onChange={setPin2} />
        {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        <div className="flex gap-2">
          <button type="button" onClick={onCancel}
            className="flex-1 rounded-xl py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            {tr('Huỷ')}
          </button>
          <button type="submit" disabled={busy}
            className="flex-1 rounded-xl bg-blue-600 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-50">
            {busy ? tr('Đang lưu...') : tr('Lưu mã PIN')}
          </button>
        </div>
      </form>
    </div>
  );
}

/** Open the set / change PIN dialog from anywhere; true = the PIN has been saved on Zalo. */
export function showZaloPinDialog(options: { accountId: string; mode: ZaloPinDialogMode }): Promise<boolean> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const close = (result: boolean) => {
      root.unmount();
      container.remove();
      resolve(result);
    };
    root.render(<ZaloHiddenPinDialog {...options} onDone={() => close(true)} onCancel={() => close(false)} />);
  });
}
