/**
 * Settings → Accounts → the "Hội thoại ẩn" (Hidden conversations) row under a Zalo account (ZL-03): PIN status + number of hidden conversations (read from
 * Zalo), the set / change PIN button and "Quên mã PIN? Đặt lại" (Forgot PIN? Reset): asks for confirmation twice because Zalo may delete messages of the hidden conversations
 * on the phone and Zalo PC (decision Q5, changed on 22/10/2026), and if the screen lock is on, the password must be entered again
 * (FR-ZL03.7); then the new PIN dialog opens right away.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { EyeOffIcon } from '@/components/common/icons';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { confirmAppLockPassword } from '@/components/auth/lock/AppLockPasswordPrompt';
import { zaloAuthFor } from '@/hooks/zalo/useZaloHidden';
import { showZaloPinDialog } from '../../chat/zalo/hidden/ZaloHiddenPinDialog';
import { tr } from '../../../../shared/i18n';

export default function ZaloHiddenPinSection({ accountId }: { accountId: string }) {
  const showNotification = useAppStore((s) => s.showNotification);
  const [status, setStatus] = React.useState<{ hasPin: boolean; hiddenCount: number } | null>(null);
  const [error, setError] = React.useState('');
  const [resetting, setResetting] = React.useState(false);
  const seq = React.useRef(0);

  const load = React.useCallback(async () => {
    const mySeq = ++seq.current;
    const auth = zaloAuthFor(accountId);
    if (!auth) return;
    setError('');
    try {
      const res = await ipc.zalo?.hiddenStatus({ auth, force: true });
      if (mySeq !== seq.current) return;
      if (res?.success && res.response) setStatus({ hasPin: !!res.response.hasPin, hiddenCount: Number(res.response.hiddenCount) || 0 });
      else setError(res?.error || tr('Không đọc được hội thoại ẩn từ Zalo'));
    } catch (err: any) {
      if (mySeq === seq.current) setError(err?.message || tr('Không đọc được hội thoại ẩn từ Zalo'));
    }
  }, [accountId]);

  React.useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  const openDialog = async () => {
    const mode = status?.hasPin ? 'change' : 'setup';
    if (await showZaloPinDialog({ accountId, mode })) {
      showNotification(mode === 'change' ? tr('Đã đổi mã PIN hội thoại ẩn') : tr('Đã đặt mã PIN hội thoại ẩn'), 'success');
      void load();
    }
  };

  const resetPin = async () => {
    if (resetting || !status) return;
    const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId);
    const name = account?.full_name || accountId;
    const count = status.hiddenCount;
    const proceed = await showConfirm({
      title: tr('Quên mã PIN — đặt lại?'),
      message: tr('Zalo sẽ xoá mã PIN hội thoại ẩn của {{name}} và có thể xoá luôn toàn bộ tin nhắn của {{v1}}hội thoại đang ẩn trên điện thoại và Zalo PC (không lấy lại được trên Zalo). Deplao vẫn giữ tin đã lưu trên máy này.', { name, v1: count > 0 ? `${count} ` : tr('các ') }),
      confirmText: tr('Tiếp tục'),
      variant: 'warning',
    });
    if (!proceed) return;
    // Screen lock is on → enter the password again before resetting (FR-ZL03.7)
    if (!(await confirmAppLockPassword(tr('Đặt lại mã PIN hội thoại ẩn Zalo của {{name}}.', { name })))) return;
    const sure = await showConfirm({
      title: tr('Xác nhận lần cuối'),
      message: tr('Đặt lại mã PIN hội thoại ẩn ngay bây giờ? Thao tác này không hoàn tác. Xong bạn đặt mã PIN mới.'),
      confirmText: tr('Đặt lại mã PIN'),
      variant: 'danger',
    });
    if (!sure) return;
    const auth = zaloAuthFor(accountId);
    if (!auth) return;
    setResetting(true);
    try {
      const res = await ipc.zalo?.hiddenResetPin({ auth });
      if (!res?.success) {
        showNotification(res?.error || tr('Zalo từ chối đặt lại mã PIN'), 'error');
        return;
      }
      useAppStore.getState().setHiddenUnlocked(accountId, false);
      showNotification(tr('Đã đặt lại mã PIN hội thoại ẩn'), 'success');
      await load();
      if (!res.response?.hasPin && await showZaloPinDialog({ accountId, mode: 'setup' })) {
        showNotification(tr('Đã đặt mã PIN mới'), 'success');
        void load();
      }
    } catch (err: any) {
      showNotification(err?.message || tr('Không đặt lại được mã PIN'), 'error');
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="space-y-1.5" aria-label={tr('Hội thoại ẩn')}>
      <p className="flex items-center gap-2 text-sm text-foreground">
        <EyeOffIcon className="h-4 w-4 text-muted-foreground" />
        {status === null
          ? (error ? tr('Không rõ') : tr('Đang đọc...'))
          : status.hasPin ? tr('Đã đặt mã PIN · {{hiddenCount}} hội thoại đang ẩn', { hiddenCount: status.hiddenCount }) : tr('Chưa đặt mã PIN')}
      </p>
      <p className="text-[11px] leading-4 text-muted-foreground">
        {tr('Chuột phải một hội thoại Zalo → "Ẩn hội thoại". Gõ đúng 4 số PIN vào ô tìm kiếm để xem; PIN dùng chung với app Zalo.')}
      </p>
      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
      {status !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void openDialog()} disabled={resetting}
            className="rounded-lg border border-input px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
            {status.hasPin ? tr('Đổi mã PIN') : tr('Đặt mã PIN')}
          </button>
          {status.hasPin && (
            <button type="button" onClick={() => void resetPin()} disabled={resetting}
              className="rounded-lg px-2 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50">
              {resetting ? tr('Đang đặt lại...') : tr('Quên mã PIN? Đặt lại')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
