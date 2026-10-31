/**
 * Quản lý công việc → Cài đặt → "Thông báo qua Zalo": bật / tắt, chọn tài khoản Zalo gửi, loại thông báo, người nhận
 * (SĐT trong hồ sơ Nhân sự, sửa tại chỗ, gửi thử) và tin gửi gần đây. Mọi thay đổi lưu ngay.
 * Main: ErpNotificationService (getZaloStatus / setZaloSettings / sendZaloTest); nhân viên đi REST tới Boss.
 */
import React, { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Checkbox, Input, Select, Switch, type BadgeVariant } from '@/components/ui';
import { MessageCircleIcon, RefreshIcon, SendIcon } from '@/components/common/icons';
import DataAccessor from '@/lib/data/DataAccessor';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useErpEmployeeStore } from '@/store/erp/erpEmployeeStore';
import { withErpDeniedNotice } from '@/store/erp/erpStoreHelpers';
import { resolveAccountChannel } from '../../../../configs/channels/channelConfig';
import { erpWhenText } from '../../../../shared/erp/erpNotifyText';
import {
  ERP_ZALO_NOTIFY_TYPES, ERP_ZALO_RECIPIENT_STATE_LABELS, zaloPhoneDigits,
  type ErpZaloNotifySettings, type ErpZaloNotifyStatus, type ErpZaloRecipient, type ErpZaloRecipientState,
} from '../../../../shared/erp/erpZaloNotify';
import type { ErpNotificationType } from '../../../../models/erp';

const STATE_VARIANT: Record<ErpZaloRecipientState, BadgeVariant> = {
  ok: 'success',
  not_found: 'destructive',
  unchecked: 'default',
  no_phone: 'warning',
};

function accountBadge(account: NonNullable<ErpZaloNotifyStatus['account']>): { variant: BadgeVariant; text: string } {
  if (account.missing) return { variant: 'destructive', text: 'Không còn trong app' };
  if (account.notZalo) return { variant: 'destructive', text: 'Không phải Zalo' };
  return account.ready ? { variant: 'success', text: 'Đã kết nối' } : { variant: 'warning', text: 'Chưa kết nối' };
}

export default function ErpZaloNotifySettings() {
  const accounts = useAccountStore(s => s.accounts);
  const showNotification = useAppStore(s => s.showNotification);
  const upsertProfile = useErpEmployeeStore(s => s.upsertProfile);
  const [status, setStatus] = useState<ErpZaloNotifyStatus | null>(null);
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res: any = await DataAccessor.erpZaloNotifyStatus();
    if (res?.success && res.zalo) {
      setStatus(res.zalo);
      setLoadError('');
      return;
    }
    withErpDeniedNotice(res);
    setLoadError(res?.error || 'Không tải được cài đặt');
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Còn tin chờ tới lượt gửi → làm mới mỗi 5 giây tới khi gửi xong
  const pending = status?.pending ?? 0;
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(timer);
  }, [pending, load]);

  const save = async (patch: Partial<ErpZaloNotifySettings>) => {
    if (!status) return;
    setSaving(true);
    setStatus({ ...status, settings: { ...status.settings, ...patch } }); // hiện ngay, lỗi thì tải lại bên dưới
    const res: any = withErpDeniedNotice(await DataAccessor.erpSetZaloNotifySettings(patch));
    setSaving(false);
    if (!res?.success && res?.code !== 'permission_denied') showNotification(res?.error || 'Không lưu được', 'error');
    await load();
  };

  const sendTest = async (recipient: ErpZaloRecipient) => {
    setTestingId(recipient.employeeId);
    const res: any = withErpDeniedNotice(await DataAccessor.erpTestZaloNotify(recipient.employeeId));
    setTestingId(null);
    if (res?.success) showNotification(`Đã gửi tin thử cho ${recipient.name}`, 'success');
    else if (res?.code !== 'permission_denied') showNotification(res?.error || 'Gửi thử không được', 'error');
    await load();
  };

  const savePhone = async (employeeId: string, phone: string): Promise<boolean> => {
    const res = await upsertProfile(employeeId, { phone: phone.trim() });
    if (!res.success && res.error) showNotification(res.error, 'error');
    if (res.success) await load();
    return res.success;
  };

  if (!status) {
    return (
      <Card>
        {loadError ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-destructive">{loadError}</p>
            <Button size="sm" variant="outline" onClick={() => { void load(); }}>Thử lại</Button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Đang tải...</p>
        )}
      </Card>
    );
  }

  const { settings, account, recipients, recent, gapSeconds, dailyCap } = status;
  const zaloAccounts = accounts.filter(item => resolveAccountChannel(item) === 'zalo');
  // Tài khoản đang chọn không có trong danh sách (đã xoá, hoặc nhân viên không được giao) → vẫn hiện tên
  const currentMissing = !!settings.accountId && !zaloAccounts.some(item => item.zalo_id === settings.accountId);
  const badge = account ? accountBadge(account) : null;

  const pickAccount = (accountId: string) => {
    if (!accountId || accountId === settings.accountId) return;
    // Chọn tài khoản lần đầu = muốn dùng: bật luôn
    void save(settings.accountId ? { accountId } : { accountId, enabled: true });
  };

  const toggleType = (type: ErpNotificationType, on: boolean) => {
    const types = on ? [...settings.types, type] : settings.types.filter(item => item !== type);
    void save({ types });
  };

  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <MessageCircleIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">Thông báo qua Zalo</p>
          <p className="text-xs text-muted-foreground">Gửi kèm thông báo công việc vào Zalo nhân viên.</p>
        </div>
        <Switch
          checked={settings.enabled}
          disabled={saving || !settings.accountId}
          onCheckedChange={(enabled) => { void save({ enabled }); }}
          aria-label="Bật thông báo qua Zalo"
          title={settings.accountId ? undefined : 'Chọn tài khoản gửi trước'}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-foreground">Tài khoản gửi</p>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={settings.accountId}
            onChange={(event) => pickAccount(event.target.value)}
            disabled={saving}
            wrapperClassName="w-72 max-w-full"
            aria-label="Tài khoản Zalo gửi"
          >
            <option value="" disabled>Chọn tài khoản Zalo</option>
            {currentMissing && <option value={settings.accountId} disabled>{account?.name || settings.accountId}</option>}
            {zaloAccounts.map(item => (
              <option key={item.zalo_id} value={item.zalo_id}>
                {item.full_name || item.zalo_id}{item.phone ? ` (${item.phone})` : ''}
              </option>
            ))}
          </Select>
          {badge && <Badge variant={badge.variant} size="sm" dot>{badge.text}</Badge>}
        </div>
        {!zaloAccounts.length && <p className="text-[11px] text-warning">Chưa có tài khoản Zalo nào trong app.</p>}
        {!settings.accountId && zaloAccounts.length > 0 && <p className="text-[11px] text-primary">Chọn tài khoản để bật.</p>}
        <p className="text-[11px] text-muted-foreground">
          Gửi lần lượt, cách nhau {gapSeconds.min} - {gapSeconds.max} giây. Mỗi người tối đa {dailyCap} tin/ngày.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Gửi khi có</p>
        {/* Theo cột: task bên trái, lịch / nghỉ phép / ghi chú bên phải */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-flow-col sm:grid-cols-2 sm:grid-rows-4">
          {ERP_ZALO_NOTIFY_TYPES.map(option => (
            <Checkbox
              key={option.type}
              checked={settings.types.includes(option.type)}
              onCheckedChange={(on) => toggleType(option.type, on)}
              disabled={saving}
              label={option.label}
              description={option.hint}
            />
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground">
            Người nhận <span className="font-normal text-muted-foreground">(SĐT trong Nhân sự)</span>
          </p>
          <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" leftIcon={<RefreshIcon className="h-3.5 w-3.5" />} onClick={() => { void load(); }}>
            Làm mới
          </Button>
        </div>
        {recipients.length ? (
          <div className="divide-y divide-border/60 rounded-lg border border-border/60">
            {recipients.map(recipient => (
              <RecipientRow
                key={recipient.employeeId}
                recipient={recipient}
                canTest={!!settings.accountId && !testingId}
                testing={testingId === recipient.employeeId}
                onTest={() => { void sendTest(recipient); }}
                onSavePhone={(phone) => savePhone(recipient.employeeId, phone)}
              />
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">Chưa có nhân viên.</p>
        )}
        <p className="text-[11px] text-muted-foreground">Nên kết bạn Zalo giữa nhân viên và tài khoản gửi để tin không bị chặn.</p>
      </div>

      {(recent.length > 0 || pending > 0) && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-foreground">
            Gửi gần đây
            {pending > 0 && <span className="font-normal text-muted-foreground"> · {pending} tin đang chờ</span>}
          </p>
          {recent.length > 0 && (
            <div className="max-h-64 divide-y divide-border/60 overflow-auto rounded-lg border border-border/60">
              {recent.map((entry, index) => (
                <div key={`${entry.at}-${entry.employeeId}-${index}`} className="flex items-start gap-2 px-3 py-1.5 text-xs">
                  <span className="w-20 flex-shrink-0 tabular-nums text-muted-foreground">{erpWhenText(entry.at, false, Date.now())}</span>
                  <span className="min-w-0 flex-1">
                    <span className="text-foreground">{entry.name}</span>
                    <span className="text-muted-foreground"> · {entry.title}</span>
                    {entry.error && <span className={`block ${entry.skipped ? 'text-muted-foreground' : 'text-destructive'}`}>{entry.error}</span>}
                  </span>
                  <Badge size="sm" variant={entry.ok ? 'success' : entry.skipped ? 'default' : 'destructive'}>
                    {entry.ok ? (entry.test ? 'Đã gửi thử' : 'Đã gửi') : entry.skipped ? 'Bỏ qua' : 'Lỗi'}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="space-y-4 rounded-xl border border-border/60 bg-card p-4">{children}</div>;
}

/** Một người nhận: tên, SĐT (thêm / sửa tại chỗ), trạng thái tìm Zalo, lần gửi gần nhất, "Gửi thử". */
function RecipientRow({ recipient, canTest, testing, onTest, onSavePhone }: {
  recipient: ErpZaloRecipient;
  canTest: boolean;
  testing: boolean;
  onTest: () => void;
  onSavePhone: (phone: string) => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [phone, setPhone] = useState(recipient.phone);
  const [savingPhone, setSavingPhone] = useState(false);
  const hasPhone = !!zaloPhoneDigits(recipient.phone);

  const startEdit = () => { setPhone(recipient.phone); setEditing(true); };
  const submit = async () => {
    if (phone.trim() === recipient.phone) { setEditing(false); return; }
    setSavingPhone(true);
    const ok = await onSavePhone(phone);
    setSavingPhone(false);
    if (ok) setEditing(false);
  };

  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{recipient.name}</p>
        {editing ? (
          <div className="mt-1 flex items-center gap-1.5">
            <Input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void submit();
                if (event.key === 'Escape') setEditing(false);
              }}
              placeholder="Số điện thoại"
              inputMode="tel"
              autoFocus
              className="h-7 w-40 px-2 text-xs"
            />
            <Button size="sm" className="h-7 px-2 text-xs" loading={savingPhone} onClick={() => { void submit(); }}>Lưu</Button>
            <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => setEditing(false)}>Huỷ</Button>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {recipient.phone || 'Chưa có SĐT'}
            {' · '}
            <button type="button" className="text-primary hover:underline" onClick={startEdit}>
              {recipient.phone ? 'Sửa' : 'Thêm SĐT'}
            </button>
            {recipient.last && (
              recipient.last.ok
                ? <> · Gửi lúc {erpWhenText(recipient.last.at, false, Date.now())}</>
                : <span className="text-destructive"> · {recipient.last.error || 'Gửi lỗi'}</span>
            )}
          </p>
        )}
      </div>
      <Badge size="sm" variant={STATE_VARIANT[recipient.state]}>{ERP_ZALO_RECIPIENT_STATE_LABELS[recipient.state]}</Badge>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2.5 text-xs"
        leftIcon={<SendIcon className="h-3.5 w-3.5" />}
        disabled={!hasPhone || !canTest}
        loading={testing}
        onClick={onTest}
        title={hasPhone ? undefined : 'Thêm SĐT trước'}
      >
        Gửi thử
      </Button>
    </div>
  );
}
