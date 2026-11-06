/**
 * Cài đặt → Thông báo → Khởi động cùng máy: tự mở Deplao khi bật máy (mặc định bật) để không lỡ tin sau khi khởi động
 * lại máy; tự mở thì chạy ngầm ở khay (mặc định). Lưu theo máy, xử lý ở main (src/utils/startup/autoLaunch.ts).
 */
import React from 'react';
import { Switch } from '@/components/ui';
import ipc, { type AutoLaunchStatus } from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { SettingsRow, SettingsSection } from '../settingsUi';

/** Hệ điều hành đang chặn mục tự mở: chỉ chỗ bật lại. */
export function autoLaunchBlockedHint(platform: string): string {
  if (platform === 'win32') return 'Windows đang tắt Deplao ở Task Manager → Ứng dụng khởi động. Tắt rồi bật lại công tắc trên để mở lại.';
  if (platform === 'darwin') return 'macOS cần cho phép: Cài đặt hệ thống → Chung → Mục đăng nhập → bật Deplao.';
  return 'Hệ điều hành đang tắt Deplao trong Ứng dụng khởi động. Tắt rồi bật lại công tắc trên để mở lại.';
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
      if (!next.success) showNotification(`Không đổi được: ${next.error || 'lỗi không rõ'}`, 'error');
    } catch (err: any) {
      showNotification(`Không đổi được: ${err?.message || err}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Chưa đọc được trạng thái: chưa hiện cả mục (không có thẻ trống)
  if (!status) return null;
  const locked = !status.supported || saving;
  const hint = !status.supported
    ? <p className="text-xs text-muted-foreground">Chỉ có ở bản cài đặt, bản đang chạy là bản dev.</p>
    : status.enabled && status.blocked
      ? <p className="text-xs text-warning">{autoLaunchBlockedHint(status.platform)}</p>
      : undefined;
  // Cùng kiểu dòng với các mục khác của trang Thông báo: tên + mô tả bên trái, công tắc bên phải, có vạch ngăn
  return (
    <SettingsSection title="Khởi động cùng máy">
      <SettingsRow
        title="Tự mở Deplao khi bật máy"
        description="Không lỡ tin nhắn sau khi khởi động lại máy."
        control={(
          <Switch
            aria-label="Tự mở Deplao khi bật máy"
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
          title="Chạy ngầm ở khay"
          description="Tự mở thì không bật cửa sổ, vẫn nhận tin và thông báo."
          control={(
            <Switch
              aria-label="Chạy ngầm ở khay"
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
