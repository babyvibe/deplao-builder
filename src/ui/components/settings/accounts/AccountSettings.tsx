/**
 * Settings → Accounts: each account is a card; the account's own settings appear right under the account row with its
 * current status. Click a row to open its editor right below it (previously hidden behind the gear button → dialog).
 * "Thông báo trong app" (In-app notifications) is a switch right on the row (InAppNotifySettings).
 * "Tự động xoá media" (Auto-delete media) is available on every channel and reads its config when the page opens (reads app_settings on the machine only); Zalo adds
 * "Quyền riêng tư Zalo" (Zalo privacy) and "Hội thoại ẩn" (Hidden conversations): these two call Zalo, so they only load when opened.
 * "Proxy" (Zalo, Facebook, server): add / change / remove a proxy, the account reconnects by itself (AccountProxyLine).
 */
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore, type AccountInfo } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { showConfirm } from '../../common/ConfirmDialog';
import { extractApiError } from '@/lib/app/apiError';
import { EyeOffIcon, FolderIcon, SearchIcon, ShieldIcon, TrashIcon } from '@/components/common/icons';
import { Button, Input, Switch } from '@/components/ui';
import { matchAccountSearch } from '@/lib/accounts/accountSearch';
import { getChannelLabel, resolveAccountChannel } from '../../../../configs/channels/channelConfig';
import { isZalo } from '@/lib/channels/channelHelper';
import ZaloPrivacySettings from './ZaloPrivacySettings';
import ZaloHiddenPinSection from './ZaloHiddenPinSection';
import AccountProxyLine, { type ProxyOption } from './AccountProxyLine';
import { supportsAccountProxy } from '../../../../shared/accounts/accountProxy';
import { InAppNotifyAccountLine, MiniAccountAvatar } from '../notifications/InAppNotifySettings';
import { SettingLine, SettingsPage } from '../settingsUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

type MediaConfig = { enabled: boolean; days: number };
type MediaDraft = { enabled: boolean; days: string };
type SettingId = 'proxy' | 'media' | 'privacy' | 'hidden';

const DEFAULT_MEDIA: MediaConfig = { enabled: false, days: 30 };
const toDraft = (config: MediaConfig): MediaDraft => ({ enabled: config.enabled, days: String(config.days) });
/** Number of days 1–365; if the field is empty or the input is invalid, keep the saved number. */
const clampDays = (text: string, fallback: number) => {
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : fallback;
};

function AccountCard({ acc, proxies, onDelete }: {
  acc: AccountInfo;
  /** Proxy list (null = loading, undefined = the Proxy row is not shown) */
  proxies?: ProxyOption[] | null;
  onDelete: () => void;
}) {
  const showNotification = useAppStore((s) => s.showNotification);
  const baseId = useId();
  const zalo = isZalo(acc.channel);
  const [open, setOpen] = useState<ReadonlySet<SettingId>>(() => new Set());

  // Auto-delete media: saved = the config currently saved (null while not yet read / on read error), draft = being edited
  const [saved, setSaved] = useState<MediaConfig | null>(null);
  const [draft, setDraft] = useState<MediaDraft>(() => toDraft(DEFAULT_MEDIA));
  const [loadError, setLoadError] = useState('');
  const [saving, setSaving] = useState(false);
  const loadSeq = useRef(0);

  const loadMedia = useCallback(async () => {
    const mySeq = ++loadSeq.current;
    setLoadError('');
    try {
      const res = await ipc.login?.getMediaAutoDelete(acc.zalo_id);
      if (mySeq !== loadSeq.current) return;
      if (res?.success) {
        const config = res.config ? { enabled: !!res.config.enabled, days: Number(res.config.days) || DEFAULT_MEDIA.days } : DEFAULT_MEDIA;
        setSaved(config);
        setDraft(toDraft(config));
      } else {
        setLoadError(extractApiError(res, tr('Không đọc được cấu hình')));
      }
    } catch (err: any) {
      if (mySeq === loadSeq.current) setLoadError(err?.message || tr('Không đọc được cấu hình'));
    }
  }, [acc.zalo_id]);

  useEffect(() => {
    void loadMedia();
    return () => { loadSeq.current++; };
  }, [loadMedia]);

  const toggle = (id: SettingId) => {
    const closing = open.has(id);
    // Closing "Tự động xoá media" (Auto-delete media) = discard unsaved changes
    if (closing && id === 'media' && saved) setDraft(toDraft(saved));
    setOpen((prev) => {
      const next = new Set(prev);
      if (closing) next.delete(id); else next.add(id);
      return next;
    });
  };

  const draftDays = clampDays(draft.days, saved?.days ?? DEFAULT_MEDIA.days);
  const dirty = !!saved && (draft.enabled !== saved.enabled || draftDays !== saved.days);

  const saveMedia = async () => {
    if (!saved || saving) return;
    setSaving(true);
    try {
      const res = await ipc.login?.setMediaAutoDelete(acc.zalo_id, draft.enabled, draftDays);
      if (res?.success) {
        const config = res.config ?? { enabled: draft.enabled, days: draftDays };
        setSaved(config);
        setDraft(toDraft(config));
        setOpen((prev) => {
          const next = new Set(prev);
          next.delete('media');
          return next;
        });
        showNotification(res.message || tr('Đã lưu cấu hình xoá media'), 'success');
      } else {
        showNotification(extractApiError(res, tr('Lỗi lưu cấu hình')), 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || tr('Lỗi lưu cấu hình'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const mediaSummary = saved
    ? (saved.enabled ? <>{trx('<0>Bật</0> · xoá media cũ hơn {{days}} ngày', { 0: <span className="font-medium text-foreground" />, days: saved.days })}</> : tr('Tắt'))
    : (loadError ? tr('Không đọc được') : tr('Đang tải...'));

  return (
    <div className="rounded-xl border border-border/60 bg-card">
      {/* Account row */}
      <div className="flex items-center gap-3 px-3 py-2.5">
        <MiniAccountAvatar account={acc} size={40} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm text-foreground truncate font-medium">{acc.full_name || acc.zalo_id}</p>
            <span className="flex-shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {getChannelLabel(resolveAccountChannel(acc))}
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground" title={acc.phone ? tr('UID {{zalo_id}} · SĐT {{phone}}', { zalo_id: acc.zalo_id, phone: acc.phone }) : `UID ${acc.zalo_id}`}>
            {acc.zalo_id}
            {acc.phone && <> {trx('· SĐT {{phone}}', { phone: acc.phone })}</>}
          </p>
        </div>
        <span className={`flex flex-shrink-0 items-center gap-1.5 text-xs ${acc.isOnline ? 'text-success' : 'text-muted-foreground'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${acc.isOnline ? 'bg-success' : 'bg-border-strong'}`} />
          {acc.isOnline ? tr('Online') : tr('Offline')}
        </span>
        <Button variant="ghost" size="icon" onClick={onDelete} aria-label={tr('Xoá tài khoản')} title={tr('Xoá tài khoản')}
          className="h-8 w-8 flex-shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
          <TrashIcon className="h-4 w-4" />
        </Button>
      </div>

      {/* Account's own settings */}
      <div className="border-t border-border/60 px-1.5 py-1">
        <InAppNotifyAccountLine accountId={acc.zalo_id} />
        {proxies !== undefined && supportsAccountProxy(acc.channel) && (
          <AccountProxyLine account={acc} proxies={proxies} panelId={`${baseId}-proxy`}
            open={open.has('proxy')} onToggle={() => toggle('proxy')} />
        )}
        <SettingLine panelId={`${baseId}-media`} icon={<FolderIcon className="h-4 w-4" />} title={tr('Tự động xoá media')}
          summary={mediaSummary} open={open.has('media')} onToggle={() => toggle('media')}>
          {saved ? (
            <div className="space-y-3">
              <Switch size="sm" checked={draft.enabled} disabled={saving}
                onCheckedChange={(on) => setDraft((d) => ({ ...d, enabled: on }))}
                label={tr('Bật tự động xoá')} description={tr('Xoá ảnh, video, file trên máy cũ hơn số ngày dưới đây (tin nhắn vẫn giữ)')} />
              <div className="flex items-center gap-2">
                <label htmlFor={`${baseId}-days`} className="text-xs text-muted-foreground">{tr('Xoá sau')}</label>
                <input
                  id={`${baseId}-days`}
                  type="number"
                  min={1}
                  max={365}
                  value={draft.days}
                  disabled={!draft.enabled || saving}
                  onChange={(e) => setDraft((d) => ({ ...d, days: e.target.value }))}
                  onBlur={() => setDraft((d) => ({ ...d, days: String(clampDays(d.days, saved.days)) }))}
                  className="w-20 rounded-lg border border-input bg-muted px-2.5 py-1.5 text-sm text-foreground transition-colors disabled:opacity-60"
                />
                <span className="text-xs text-muted-foreground">{tr('ngày')}</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {tr('Tự dọn mỗi ngày lúc 3:00. Lưu khi đang bật thì dọn ngay.')}
              </p>
              <div className="flex justify-end gap-2">
                {dirty && (
                  <Button variant="ghost" size="sm" onClick={() => setDraft(toDraft(saved))} disabled={saving}>{tr('Huỷ')}</Button>
                )}
                <Button size="sm" onClick={() => void saveMedia()} disabled={saving || (!dirty && !draft.enabled)}>
                  {saving ? tr('Đang lưu...') : draft.enabled ? tr('Lưu & chạy ngay') : tr('Lưu')}
                </Button>
              </div>
            </div>
          ) : loadError ? (
            <div className="flex items-center gap-2 text-xs">
              <span role="alert" className="text-destructive">{loadError}</span>
              <Button variant="ghost" size="sm" onClick={() => void loadMedia()}>{tr('Thử lại')}</Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
              <div className="w-3 h-3 border-2 border-border-strong border-t-transparent rounded-full animate-spin" />
              {tr('Đang tải cấu hình...')}
            </div>
          )}
        </SettingLine>

        {zalo && (
          <>
            <SettingLine panelId={`${baseId}-privacy`} icon={<ShieldIcon className="h-4 w-4" />} title={tr('Quyền riêng tư Zalo')}
              summary={tr('Nhắn tin, gọi điện, ngày sinh, trạng thái truy cập…')} open={open.has('privacy')} onToggle={() => toggle('privacy')}>
              <ZaloPrivacySettings accountId={acc.zalo_id} />
            </SettingLine>
            <SettingLine panelId={`${baseId}-hidden`} icon={<EyeOffIcon className="h-4 w-4" />} title={tr('Hội thoại ẩn')}
              summary={tr('Mã PIN, đặt lại khi quên')} open={open.has('hidden')} onToggle={() => toggle('hidden')}>
              <ZaloHiddenPinSection accountId={acc.zalo_id} />
            </SettingLine>
          </>
        )}
      </div>
    </div>
  );
}

export default function AccountSettings() {
  const accounts = useAccountStore((s) => s.accounts);
  const removeAccount = useAccountStore((s) => s.removeAccount);
  const showNotification = useAppStore((s) => s.showNotification);
  // Proxy managed by the server: employee machines do not have a Proxy row
  const isEmployeeMachine = useEmployeeStore((s) => s.mode) === 'employee';
  // Quick search by name, UID, phone number
  const [query, setQuery] = useState('');
  const visible = useMemo(() => accounts.filter((acc) => matchAccountSearch(acc, query)), [accounts, query]);
  const [proxies, setProxies] = useState<ProxyOption[] | null>(null);
  useEffect(() => {
    if (isEmployeeMachine) return;
    let alive = true;
    ipc.proxy?.list()
      .then((res) => { if (alive) setProxies(res?.success && Array.isArray(res.proxies) ? res.proxies : []); })
      .catch(() => { if (alive) setProxies([]); });
    return () => { alive = false; };
  }, [isEmployeeMachine]);

  // Delete account dialog: defaults to "Chỉ xoá tài khoản" (Delete account only) (keeps data); deleting all data must be chosen explicitly
  const [deleteModalAcc, setDeleteModalAcc] = useState<string | null>(null);
  const [deleteWithData, setDeleteWithData] = useState(false);
  const openDelete = (zaloId: string) => {
    setDeleteWithData(false);
    setDeleteModalAcc(zaloId);
  };

  const handleDeleteAccount = async (zaloId: string) => {
    const ok = await showConfirm({
      title: deleteWithData ? tr('Xoá tài khoản và tất cả dữ liệu?') : tr('Xoá tài khoản này?'),
      message: deleteWithData
        ? tr('Tài khoản, tin nhắn, hội thoại, danh bạ, khách hàng, file media, nhãn, ghi chú và tất cả dữ liệu CRM sẽ bị XOÁ VĨNH VIỄN. Không thể khôi phục!')
        : tr('Tài khoản sẽ bị xoá khỏi ứng dụng. Bạn cần đăng nhập lại để thêm lại. Dữ liệu tin nhắn và media được giữ lại.'),
      confirmText: deleteWithData ? tr('Xoá tất cả') : tr('Xoá tài khoản'),
      variant: deleteWithData ? 'danger' : 'warning',
    });
    if (!ok) return;
    const res = await ipc.login?.removeAccount(zaloId, deleteWithData);
    if (res?.success) {
      removeAccount(zaloId);
      showNotification(
        deleteWithData ? tr('Đã xoá tài khoản và toàn bộ dữ liệu') : tr('Đã xoá tài khoản'),
        'success'
      );
      setDeleteModalAcc(null);
    } else {
      showNotification(extractApiError(res, tr('Xoá tài khoản thất bại')), 'error');
    }
  };

  const deleteOption = (withData: boolean, title: string, description: string) => {
    const active = deleteWithData === withData;
    return (
      <label className={`flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3.5 transition-colors ${
        active ? (withData ? 'border-destructive bg-destructive/5' : 'border-primary bg-primary/5') : 'border-border hover:bg-muted'
      }`}>
        <input
          type="radio"
          name="deleteMode"
          checked={active}
          onChange={() => setDeleteWithData(withData)}
          className={`mt-0.5 ${withData ? 'accent-destructive' : 'accent-primary'}`}
        />
        <div className="min-w-0">
          <p className={`text-sm font-semibold ${withData ? 'text-destructive' : 'text-foreground'}`}>{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </label>
    );
  };

  return (
    <SettingsPage
      title={tr('Tài khoản')}
      description={tr('Bấm một dòng dưới tài khoản để chỉnh ngay tại chỗ.')}
      actions={accounts.length > 0 ? (
        <div className="relative w-56">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={tr('Tìm tên, UID, SĐT')} aria-label={tr('Tìm tài khoản')}
            className="h-8 pl-8" />
        </div>
      ) : undefined}
    >
      <div className="space-y-3">
        {visible.map((acc) => (
          <AccountCard key={acc.zalo_id} acc={acc} proxies={isEmployeeMachine ? undefined : proxies}
            onDelete={() => openDelete(acc.zalo_id)} />
        ))}
        {accounts.length === 0 && (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">{tr('Chưa có tài khoản nào')}</p>
        )}
        {accounts.length > 0 && visible.length === 0 && (
          <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            {trx('Không thấy tài khoản khớp "{{v1}}". ', { v1: query.trim() })}
            <button type="button" onClick={() => setQuery('')} className="font-medium text-primary hover:underline">{tr('Xoá tìm kiếm')}</button>
          </div>
        )}
      </div>

      {/* ── Delete account confirmation dialog ── */}
      {deleteModalAcc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={() => setDeleteModalAcc(null)}>
          <div role="dialog" aria-modal="true" aria-labelledby="delete-account-title"
            className="w-full max-w-md overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="border-b border-border px-5 pb-3 pt-5">
              <h3 id="delete-account-title" className="flex items-center gap-2 text-base font-semibold text-foreground">
                {trx('<0/> Xoá tài khoản', { 0: <TrashIcon className="h-4 w-4 text-destructive" /> })}
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {accounts.find(a => a.zalo_id === deleteModalAcc)?.full_name || deleteModalAcc}
              </p>
            </div>

            <div className="space-y-2.5 p-4">
              {deleteOption(false, tr('Chỉ xoá tài khoản'), tr('Gỡ khỏi danh sách đăng nhập. Tin nhắn, danh bạ, CRM và file vẫn giữ trên máy.'))}
              {deleteOption(true, tr('Xoá tất cả dữ liệu'), tr('Xoá vĩnh viễn tin nhắn, hội thoại, danh bạ, khách hàng, nhãn, ghi chú, chiến dịch, workflow và mọi file của tài khoản. Không thể khôi phục.'))}
            </div>

            <div className="flex gap-2 px-4 pb-4">
              <Button variant="ghost" className="flex-1" onClick={() => setDeleteModalAcc(null)}>{tr('Huỷ')}</Button>
              <Button variant="destructive" className="flex-1" onClick={() => handleDeleteAccount(deleteModalAcc)}>
                {deleteWithData ? tr('Xoá tất cả') : tr('Xoá tài khoản')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </SettingsPage>
  );
}
