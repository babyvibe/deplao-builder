/**
 * Dải cảnh báo sau khi khôi phục dữ liệu từ Cloudflare: chiến dịch, workflow và lịch của ứng dụng đang tạm dừng
 * (tránh gửi trùng với máy cũ) cho tới khi người dùng xác nhận máy cũ đã tắt → db.resumeAutomations().
 * Đọc db.restoreState() khi mở và khi main báo phần 'db' đổi. Bản app cũ không có các hàm này → không hiện gì.
 * Dùng ở Cài đặt → Internet & Đám mây; có thể gắn thêm ở Dashboard.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui';
import { cloudApi, Notice, useCloudAction, useCloudChanged } from '../cloudUi';

export interface RestoreState {
  pausedAutomations: boolean;
  pendingRelogin: boolean;
}

export interface RestoreStateBannerProps {
  className?: string;
  /** Có thì hiện nút "Xem tài khoản" khi còn kênh phải đăng nhập lại. */
  onOpenAccounts?: () => void;
  /** Trạng thái đã đọc trước (test). */
  initialState?: RestoreState | null;
}

export function RestoreStateBanner({ className, onOpenAccounts, initialState = null }: RestoreStateBannerProps) {
  const { busy, run } = useCloudAction();
  const [state, setState] = useState<RestoreState | null>(initialState);

  const load = useCallback(async () => {
    const db = cloudApi()?.db;
    if (!db || typeof db.restoreState !== 'function') return;
    try {
      const res = await db.restoreState();
      if (res?.success) setState({ pausedAutomations: !!res.pausedAutomations, pendingRelogin: !!res.pendingRelogin });
    } catch { /* bản app cũ / main chưa sẵn sàng: giữ nguyên */ }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useCloudChanged(areas => { if (areas.includes('db')) void load(); });

  if (!state || (!state.pausedAutomations && !state.pendingRelogin)) return null;

  const resume = async () => {
    const ok = await showConfirm({
      title: 'Bật lại tự động hoá?',
      message: 'Chỉ bật khi máy cũ đã tắt hoặc đã ngắt Deplao.',
      confirmText: 'Bật lại',
      variant: 'warning',
    });
    if (!ok) return;
    const db = cloudApi()?.db;
    const res = await run(
      'resume',
      () => (db && typeof db.resumeAutomations === 'function' ? db.resumeAutomations() : undefined),
      'Đã bật lại chiến dịch, workflow và lịch của ứng dụng',
    );
    if (res) {
      setState(prev => (prev ? { ...prev, pausedAutomations: false } : prev));
      void load();
    }
  };

  const canResume = typeof cloudApi()?.db?.resumeAutomations === 'function';

  return (
    <Notice
      tone="warning"
      className={className}
      action={(
        <>
          {state.pausedAutomations && canResume && (
            <Button size="sm" loading={busy === 'resume'} onClick={() => void resume()}>Bật lại tự động hoá</Button>
          )}
          {state.pendingRelogin && onOpenAccounts && (
            <Button size="sm" variant="outline" onClick={onOpenAccounts}>Xem tài khoản</Button>
          )}
        </>
      )}
    >
      {state.pausedAutomations && (
        <p>
          <strong className="text-foreground">Đã khôi phục dữ liệu.</strong> Chiến dịch, workflow và lịch của ứng dụng đang
          tạm dừng để tránh gửi trùng với máy cũ.
        </p>
      )}
      {state.pendingRelogin && <p>Một số kênh cần đăng nhập lại.</p>}
    </Notice>
  );
}

export default RestoreStateBanner;
