/**
 * Cài đặt → Tài khoản → dòng "Hội thoại ẩn" dưới tài khoản Zalo (ZL-03): trạng thái mã PIN + số hội thoại đang ẩn (đọc từ
 * Zalo), nút đặt / đổi PIN và "Quên mã PIN? Đặt lại" — hỏi xác nhận 2 lần vì Zalo có thể xoá tin của các hội thoại đang
 * ẩn trên điện thoại và Zalo PC (quyết định Q5, đổi ngày 22/10/2026), khoá màn hình đang bật thì nhập lại mật khẩu
 * (FR-ZL03.7); xong mở luôn hộp đặt PIN mới.
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
      else setError(res?.error || 'Không đọc được hội thoại ẩn từ Zalo');
    } catch (err: any) {
      if (mySeq === seq.current) setError(err?.message || 'Không đọc được hội thoại ẩn từ Zalo');
    }
  }, [accountId]);

  React.useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  const openDialog = async () => {
    const mode = status?.hasPin ? 'change' : 'setup';
    if (await showZaloPinDialog({ accountId, mode })) {
      showNotification(mode === 'change' ? 'Đã đổi mã PIN hội thoại ẩn' : 'Đã đặt mã PIN hội thoại ẩn', 'success');
      void load();
    }
  };

  const resetPin = async () => {
    if (resetting || !status) return;
    const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId);
    const name = account?.full_name || accountId;
    const count = status.hiddenCount;
    const proceed = await showConfirm({
      title: 'Quên mã PIN — đặt lại?',
      message: `Zalo sẽ xoá mã PIN hội thoại ẩn của ${name} và có thể xoá luôn toàn bộ tin nhắn của ${count > 0 ? `${count} ` : 'các '}hội thoại đang ẩn trên điện thoại và Zalo PC (không lấy lại được trên Zalo). Deplao vẫn giữ tin đã lưu trên máy này.`,
      confirmText: 'Tiếp tục',
      variant: 'warning',
    });
    if (!proceed) return;
    // Khoá màn hình đang bật → nhập lại mật khẩu trước khi đặt lại (FR-ZL03.7)
    if (!(await confirmAppLockPassword(`Đặt lại mã PIN hội thoại ẩn Zalo của ${name}.`))) return;
    const sure = await showConfirm({
      title: 'Xác nhận lần cuối',
      message: 'Đặt lại mã PIN hội thoại ẩn ngay bây giờ? Thao tác này không hoàn tác. Xong bạn đặt mã PIN mới.',
      confirmText: 'Đặt lại mã PIN',
      variant: 'danger',
    });
    if (!sure) return;
    const auth = zaloAuthFor(accountId);
    if (!auth) return;
    setResetting(true);
    try {
      const res = await ipc.zalo?.hiddenResetPin({ auth });
      if (!res?.success) {
        showNotification(res?.error || 'Zalo từ chối đặt lại mã PIN', 'error');
        return;
      }
      useAppStore.getState().setHiddenUnlocked(accountId, false);
      showNotification('Đã đặt lại mã PIN hội thoại ẩn', 'success');
      await load();
      if (!res.response?.hasPin && await showZaloPinDialog({ accountId, mode: 'setup' })) {
        showNotification('Đã đặt mã PIN mới', 'success');
        void load();
      }
    } catch (err: any) {
      showNotification(err?.message || 'Không đặt lại được mã PIN', 'error');
    } finally {
      setResetting(false);
    }
  };

  return (
    <section className="space-y-1.5" aria-label="Hội thoại ẩn">
      <p className="flex items-center gap-2 text-sm text-foreground">
        <EyeOffIcon className="h-4 w-4 text-muted-foreground" />
        {status === null
          ? (error ? 'Không rõ' : 'Đang đọc...')
          : status.hasPin ? `Đã đặt mã PIN · ${status.hiddenCount} hội thoại đang ẩn` : 'Chưa đặt mã PIN'}
      </p>
      <p className="text-[11px] leading-4 text-muted-foreground">
        Chuột phải một hội thoại Zalo → "Ẩn hội thoại". Gõ đúng 4 số PIN vào ô tìm kiếm để xem; PIN dùng chung với app Zalo.
      </p>
      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
      {status !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => void openDialog()} disabled={resetting}
            className="rounded-lg border border-input px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50">
            {status.hasPin ? 'Đổi mã PIN' : 'Đặt mã PIN'}
          </button>
          {status.hasPin && (
            <button type="button" onClick={() => void resetPin()} disabled={resetting}
              className="rounded-lg px-2 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:opacity-50">
              {resetting ? 'Đang đặt lại...' : 'Quên mã PIN? Đặt lại'}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
