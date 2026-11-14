/**
 * Settings → Notifications → Start with the machine: opens Deplao when the machine boots (on by default) so no message is missed after a reboot;
 * when opened automatically it runs in the background in the tray (default). Saved per machine, handled in main (src/utils/startup/autoLaunch.ts).
 */
import React from 'react';
import { Switch } from '@/components/ui';
import ipc, { type AutoLaunchStatus } from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { SettingsRow, SettingsSection } from '../settingsUi';
import { tr } from '../../../../shared/i18n';

/** The OS is blocking the auto-start entry: this shows where to turn it back on. */
export function autoLaunchBlockedHint(platform: string): string {
  if (platform === 'win32') return tr('Windows đang tắt Deplao ở Task Manager → Ứng dụng khởi động. Tắt rồi bật lại công tắc trên để mở lại.');
  if (platform === 'darwin') return tr('macOS cần cho phép: Cài đặt hệ thống → Chung → Mục đăng nhập → bật Deplao.');
  return tr('Hệ điều hành đang tắt Deplao trong Ứng dụng khởi động. Tắt rồi bật lại công tắc trên để mở lại.');
}

export default function AutoLaunchSettings() {
  const showNotification = useAppStore((s) => s.showNotification);
  const [status, setStatus] = React.useState<AutoLaunchStatus | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    ipc.app?.getAutoLaunch?.()
      .then((next) => { if (!cancelled && next) setStatus(next); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const update = async (patch: { enabled?: boolean; hidden?: boolean }) => {
    if (!ipc.app?.setAutoLaunch || saving) return;
    setSaving(true);
    try {
      const next = await ipc.app.setAutoLaunch(patch);
      setStatus(next);
      if (!next.success) showNotification(tr('Không đổi được: {{v1}}', { v1: next.error || tr('lỗi không rõ') }), 'error');
    } catch (err: any) {
      showNotification(tr('Không đổi được: {{v1}}', { v1: err?.message || err }), 'error');
    } finally {
      setSaving(false);
    }
  };

  // Status not readable yet: hide the whole row (no empty card)
  if (!status) return null;
  const locked = !status.supported || saving;
  const hint = !status.supported
    ? <p className="text-xs text-muted-foreground">{tr('Chỉ có ở bản cài đặt, bản đang chạy là bản dev.')}</p>
    : status.enabled && status.blocked
      ? <p className="text-xs text-warning">{autoLaunchBlockedHint(status.platform)}</p>
      : undefined;
  // Same row style as the other rows on the Notifications page: name + description on the left, toggle on the right, with a divider
  return (
    <SettingsSection title={tr('Khởi động cùng máy')}>
      <SettingsRow
        title={tr('Tự mở Deplao khi bật máy')}
        description={tr('Không lỡ tin nhắn sau khi khởi động lại máy.')}
        control={(
          <Switch
            aria-label={tr('Tự mở Deplao khi bật máy')}
            checked={status.enabled}
            disabled={locked}
            onCheckedChange={(on) => void update({ enabled: on })}
          />
        )}
      >
        {hint}
      </SettingsRow>
      {status.enabled && (
        <SettingsRow
          title={tr('Chạy ngầm ở khay')}
          description={tr('Tự mở thì không bật cửa sổ, vẫn nhận tin và thông báo.')}
          control={(
            <Switch
              aria-label={tr('Chạy ngầm ở khay')}
              checked={status.hidden}
              disabled={locked}
              onCheckedChange={(on) => void update({ hidden: on })}
            />
          )}
        />
      )}
    </SettingsSection>
  );
}
