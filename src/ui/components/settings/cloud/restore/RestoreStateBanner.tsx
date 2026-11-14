/**
 * Warning bar after restoring data from Cloudflare: campaigns, workflows and schedules of the app stay paused
 * (to avoid sending duplicates with the old machine) until the user confirms the old machine is off → db.resumeAutomations().
 * Reads db.restoreState() on open and when main reports that the 'db' section changed. Old app builds without these functions → show nothing.
 * Used in Settings → Internet & Cloud; can also be added to the Dashboard.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui';
import { cloudApi, Notice, useCloudAction, useCloudChanged } from '../cloudUi';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export interface RestoreState {
  pausedAutomations: boolean;
  pendingRelogin: boolean;
}

export interface RestoreStateBannerProps {
  className?: string;
  /** If set, shows the "Xem tài khoản" (View accounts) button when some channels still need to log in again. */
  onOpenAccounts?: () => void;
  /** Restore state read earlier (test). */
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
    } catch { /* old app build / main not ready: leave as is */ }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useCloudChanged(areas => { if (areas.includes('db')) void load(); });

  if (!state || (!state.pausedAutomations && !state.pendingRelogin)) return null;

  const resume = async () => {
    const ok = await showConfirm({
      title: tr('Bật lại tự động hoá?'),
      message: tr('Chỉ bật khi máy cũ đã tắt hoặc đã ngắt Deplao.'),
      confirmText: tr('Bật lại'),
      variant: 'warning',
    });
    if (!ok) return;
    const db = cloudApi()?.db;
    const res = await run(
      'resume',
      () => (db && typeof db.resumeAutomations === 'function' ? db.resumeAutomations() : undefined),
      tr('Đã bật lại chiến dịch, workflow và lịch của ứng dụng'),
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
            <Button size="sm" loading={busy === 'resume'} onClick={() => void resume()}>{tr('Bật lại tự động hoá')}</Button>
          )}
          {state.pendingRelogin && onOpenAccounts && (
            <Button size="sm" variant="outline" onClick={onOpenAccounts}>{tr('Xem tài khoản')}</Button>
          )}
        </>
      )}
    >
      {state.pausedAutomations && (
        <p>
          {trx('<0>Đã khôi phục dữ liệu.</0> Chiến dịch, workflow và lịch của ứng dụng đang tạm dừng để tránh gửi trùng với máy cũ.', { 0: <strong className="text-foreground" /> })}
        </p>
      )}
      {state.pendingRelogin && <p>{tr('Một số kênh cần đăng nhập lại.')}</p>}
    </Notice>
  );
}

export default RestoreStateBanner;
