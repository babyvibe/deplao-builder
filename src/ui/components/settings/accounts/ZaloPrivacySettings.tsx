/**
 * Cài đặt → Tài khoản → dòng "Quyền riêng tư Zalo" dưới tài khoản Zalo (ZL-02, SRS Deplao): đọc getSettings mỗi lần
 * mở, đổi từng mục bằng updateSettings rồi đọc lại để xác nhận (hai khoá camelCase của zca-js chưa kiểm trên tài khoản
 * thật). Đổi sang "Chỉ bạn bè" ở Nhắn tin / Gọi điện phải xác nhận vì khách chưa kết bạn sẽ không liên hệ được nữa.
 */
import React from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accounts/accountStore';
import { Button, Select, Switch } from '@/components/ui';
import { showConfirm } from '../../common/ConfirmDialog';
import { RefreshIcon, ShieldIcon } from '@/components/common/icons';
import {
  ZALO_PRIVACY_SETTINGS, ZALO_SETTING_GROUPS, readZaloSettingValue, zaloTwoFactorEnabled, type ZaloSettingDef,
} from '../../../../shared/zalo/zaloPrivacySettings';

export default function ZaloPrivacySettings({ accountId }: { accountId: string }) {
  const [settings, setSettings] = React.useState<Record<string, any> | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [savingKey, setSavingKey] = React.useState<string | null>(null);
  const seq = React.useRef(0);

  const authOf = React.useCallback(() => {
    const account = useAccountStore.getState().accounts.find((a) => a.zalo_id === accountId);
    return account ? buildZaloAuth(account as any, accountId) : null;
  }, [accountId]);

  const load = React.useCallback(async (): Promise<Record<string, any> | null> => {
    const mySeq = ++seq.current;
    const auth = authOf();
    if (!auth) {
      setError('Không tìm thấy tài khoản');
      setLoading(false);
      return null;
    }
    setLoading(true);
    setError('');
    try {
      const res = await ipc.zalo?.getAccountSettings({ auth });
      if (mySeq !== seq.current) return null;
      if (res?.success && res.response) {
        setSettings(res.response);
        return res.response;
      }
      setError(res?.error || 'Không đọc được cài đặt từ Zalo');
    } catch (err: any) {
      if (mySeq === seq.current) setError(err?.message || 'Không đọc được cài đặt từ Zalo');
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
    return null;
  }, [authOf]);

  React.useEffect(() => {
    void load();
    return () => { seq.current++; };
  }, [load]);

  const change = async (def: ZaloSettingDef, value: number) => {
    const previous = readZaloSettingValue(def, settings);
    if (previous === value || savingKey) return;
    if (def.confirm && value === def.confirm.value) {
      const ok = await showConfirm({ title: def.confirm.title, message: def.confirm.message, confirmText: 'Vẫn đổi', variant: 'warning' });
      if (!ok) return;
    }
    const auth = authOf();
    if (!auth) return;
    setSavingKey(def.key);
    setNotice('');
    setError('');
    try {
      const res = await ipc.zalo?.updateAccountSetting({ auth, key: def.key, value, previous });
      if (!res?.success) {
        setError(res?.error || `Zalo từ chối đổi "${def.label}"`);
        return;
      }
      const fresh = await load();
      if (fresh && readZaloSettingValue(def, fresh) !== value) {
        setNotice(`Zalo chưa ghi nhận "${def.label}" — thử lại sau hoặc đổi trên app Zalo điện thoại.`);
      }
    } catch (err: any) {
      setError(err?.message || `Không đổi được "${def.label}"`);
    } finally {
      setSavingKey(null);
    }
  };

  const twoFactor = zaloTwoFactorEnabled(settings);
  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Đổi trực tiếp trên tài khoản Zalo — áp dụng cho cả điện thoại và Zalo PC.
        </p>
        <Button variant="ghost" size="sm" onClick={() => void load()} disabled={loading} title="Đọc lại từ Zalo" aria-label="Đọc lại từ Zalo">
          <RefreshIcon className="h-3.5 w-3.5" />
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      {notice && <p className="text-xs text-amber-500">{notice}</p>}

      {loading && !settings && (
        <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-border-strong border-t-transparent" />
          Đang đọc cài đặt từ Zalo...
        </div>
      )}

      {settings && ZALO_SETTING_GROUPS.map((group) => (
        <section key={group.id} className="space-y-2.5">
          <p className="text-xs font-semibold text-foreground">{group.label}</p>
          {ZALO_PRIVACY_SETTINGS.filter((def) => def.group === group.id).map((def) => {
            const value = readZaloSettingValue(def, settings);
            const disabled = !!savingKey || value === null;
            if (def.kind === 'toggle') {
              return (
                <Switch key={def.key} size="sm" checked={value === 1} disabled={disabled} label={def.label} description={def.hint}
                  onCheckedChange={(on: boolean) => void change(def, on ? 1 : 0)} />
              );
            }
            return (
              <div key={def.key} className="space-y-1">
                <p className="text-sm text-foreground">{def.label}</p>
                <Select value={value === null ? '' : String(value)} disabled={!!savingKey} aria-label={def.label}
                  onChange={(e) => void change(def, Number(e.target.value))}>
                  {value === null && <option value="">Không rõ</option>}
                  {(def.options || []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
                <p className="text-[11px] leading-4 text-muted-foreground">{def.hint}</p>
              </div>
            );
          })}
        </section>
      ))}

      {settings && (
        <section className="space-y-1">
          <p className="text-xs font-semibold text-foreground">Bảo mật</p>
          <p className="flex items-center gap-2 text-sm text-foreground">
            <ShieldIcon className="h-4 w-4 text-muted-foreground" />
            Xác thực 2 lớp: {twoFactor === null ? 'không rõ' : twoFactor ? 'đang bật' : 'đang tắt'}
          </p>
          <p className="text-[11px] leading-4 text-muted-foreground">Bật / tắt trên app Zalo điện thoại.</p>
        </section>
      )}
    </div>
  );
}
