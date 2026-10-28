/**
 * Cài đặt → Tài khoản: mỗi tài khoản là một thẻ, cài đặt riêng của tài khoản hiện ngay dưới dòng tài khoản kèm trạng
 * thái hiện tại, bấm dòng nào mở phần chỉnh của dòng đó ngay bên dưới (trước đây giấu sau nút bánh răng → hộp thoại).
 * "Thông báo trong app" là công tắc ngay trên dòng (InAppNotifySettings).
 * "Tự động xoá media" có ở mọi kênh và đọc cấu hình khi mở trang (chỉ đọc app_settings trên máy); Zalo thêm
 * "Quyền riêng tư Zalo" và "Hội thoại ẩn" — hai mục này gọi Zalo nên chỉ tải khi mở ra.
 */
import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAccountStore, type AccountInfo } from '@/store/accountStore';
import { useAppStore } from '@/store/appStore';
import { showConfirm } from '../common/ConfirmDialog';
import { extractApiError } from '@/utils/apiError';
import { ChevronDownIcon, EyeOffIcon, FolderIcon, ShieldIcon, TrashIcon, UserIcon } from '@/components/common/icons';
import { Button, Switch } from '@/components/ui';
import { getChannelLabel, resolveAccountChannel } from '../../../configs/channelConfig';
import { isZalo } from '@/lib/channelHelper';
import ZaloPrivacySettings from './ZaloPrivacySettings';
import ZaloHiddenPinSection from './ZaloHiddenPinSection';
import { InAppNotifyAccountLine } from './InAppNotifySettings';

type MediaConfig = { enabled: boolean; days: number };
type MediaDraft = { enabled: boolean; days: string };
type SettingId = 'media' | 'privacy' | 'hidden';

const DEFAULT_MEDIA: MediaConfig = { enabled: false, days: 30 };
const toDraft = (config: MediaConfig): MediaDraft => ({ enabled: config.enabled, days: String(config.days) });
/** Số ngày 1–365; ô để trống / gõ sai thì giữ số đã lưu. */
const clampDays = (text: string, fallback: number) => {
  const n = parseInt(text, 10);
  return Number.isFinite(n) ? Math.min(365, Math.max(1, n)) : fallback;
};

function Section({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card rounded-xl p-4">
      {children}
    </div>
  );
}

/** Một dòng cài đặt dưới tài khoản: tên + trạng thái hiện tại; bấm để mở / đóng phần chỉnh ngay bên dưới. */
function SettingLine({ panelId, icon, title, summary, open, onToggle, children }: {
  panelId: string;
  icon: React.ReactNode;
  title: string;
  summary: React.ReactNode;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button type="button" onClick={onToggle} aria-expanded={open} aria-controls={open ? panelId : undefined}
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted">
        <span className="flex-shrink-0 text-muted-foreground">{icon}</span>
        <span className="flex-shrink-0 text-[13px] text-foreground">{title}</span>
        <span className="ml-auto min-w-0 truncate text-right text-xs text-muted-foreground">{summary}</span>
        <ChevronDownIcon className={`h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div id={panelId} className="max-w-lg px-2 pb-3 pt-1.5">{children}</div>}
    </div>
  );
}

function AccountCard({ acc, onDelete }: { acc: AccountInfo; onDelete: () => void }) {
  const showNotification = useAppStore((s) => s.showNotification);
  const baseId = useId();
  const zalo = isZalo(acc.channel);
  const [open, setOpen] = useState<ReadonlySet<SettingId>>(() => new Set());

  // Tự động xoá media — saved = cấu hình đang lưu (null khi chưa đọc xong / đọc lỗi), draft = đang chỉnh
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
        setLoadError(extractApiError(res, 'Không đọc được cấu hình'));
      }
    } catch (err: any) {
      if (mySeq === loadSeq.current) setLoadError(err?.message || 'Không đọc được cấu hình');
    }
  }, [acc.zalo_id]);

  useEffect(() => {
    void loadMedia();
    return () => { loadSeq.current++; };
  }, [loadMedia]);

  const toggle = (id: SettingId) => {
    const closing = open.has(id);
    // Đóng "Tự động xoá media" = bỏ thay đổi chưa lưu
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
        showNotification(res.message || 'Đã lưu cấu hình xoá media', 'success');
      } else {
        showNotification(extractApiError(res, 'Lỗi lưu cấu hình'), 'error');
      }
    } catch (err: any) {
      showNotification(err?.message || 'Lỗi lưu cấu hình', 'error');
    } finally {
      setSaving(false);
    }
  };

  const mediaSummary = saved
    ? (saved.enabled ? <><span className="font-medium text-foreground">Bật</span> · xoá media cũ hơn {saved.days} ngày</> : 'Tắt')
    : (loadError ? 'Không đọc được' : 'Đang tải...');

  return (
    <div className="rounded-xl border border-border/60 bg-card">
      {/* Dòng tài khoản */}
      <div className="flex items-center gap-3 p-2.5">
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${acc.isOnline ? 'bg-green-400' : 'bg-accent'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <p className="text-sm text-foreground truncate font-medium">{acc.full_name || acc.zalo_id}</p>
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-blue-900/50 text-blue-300">
              {getChannelLabel(resolveAccountChannel(acc))}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{acc.zalo_id}</p>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 ${acc.isOnline ? 'bg-green-900/50 text-green-400' : 'bg-accent text-muted-foreground'}`}>
          {acc.isOnline ? 'Online' : 'Offline'}
        </span>
        <button
          onClick={onDelete}
          className="text-red-400 hover:text-red-300 text-xs flex-shrink-0 ml-1"
        >
          Xóa
        </button>
      </div>

      {/* Cài đặt riêng của tài khoản */}
      <div className="border-t border-border/60 px-1.5 py-1">
        <InAppNotifyAccountLine accountId={acc.zalo_id} />
        <SettingLine panelId={`${baseId}-media`} icon={<FolderIcon className="h-4 w-4" />} title="Tự động xoá media"
          summary={mediaSummary} open={open.has('media')} onToggle={() => toggle('media')}>
          {saved ? (
            <div className="space-y-3">
              <Switch size="sm" checked={draft.enabled} disabled={saving}
                onCheckedChange={(on) => setDraft((d) => ({ ...d, enabled: on }))}
                label="Bật tự động xoá" description="Xoá file media (ảnh, video, file) cũ hơn số ngày cài đặt" />
              <div className="flex items-center gap-2">
                <label htmlFor={`${baseId}-days`} className="text-xs text-muted-foreground">Xoá sau</label>
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
                <span className="text-xs text-muted-foreground">ngày</span>
              </div>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Hệ thống tự kiểm tra và xoá media cũ mỗi ngày một lần (3:00 AM). Lưu khi đang bật thì dọn dẹp chạy ngay lập tức.
              </p>
              <div className="flex justify-end gap-2">
                {dirty && (
                  <Button variant="ghost" size="sm" onClick={() => setDraft(toDraft(saved))} disabled={saving}>Huỷ</Button>
                )}
                <Button size="sm" onClick={() => void saveMedia()} disabled={saving || (!dirty && !draft.enabled)}>
                  {saving ? 'Đang lưu...' : draft.enabled ? 'Lưu & chạy ngay' : 'Lưu'}
                </Button>
              </div>
            </div>
          ) : loadError ? (
            <div className="flex items-center gap-2 text-xs">
              <span role="alert" className="text-destructive">{loadError}</span>
              <Button variant="ghost" size="sm" onClick={() => void loadMedia()}>Thử lại</Button>
            </div>
          ) : (
            <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
              <div className="w-3 h-3 border-2 border-border-strong border-t-transparent rounded-full animate-spin" />
              Đang tải cấu hình...
            </div>
          )}
        </SettingLine>

        {zalo && (
          <>
            <SettingLine panelId={`${baseId}-privacy`} icon={<ShieldIcon className="h-4 w-4" />} title="Quyền riêng tư Zalo"
              summary="Nhắn tin, gọi điện, ngày sinh, trạng thái truy cập…" open={open.has('privacy')} onToggle={() => toggle('privacy')}>
              <ZaloPrivacySettings accountId={acc.zalo_id} />
            </SettingLine>
            <SettingLine panelId={`${baseId}-hidden`} icon={<EyeOffIcon className="h-4 w-4" />} title="Hội thoại ẩn"
              summary="Mã PIN, đặt lại khi quên" open={open.has('hidden')} onToggle={() => toggle('hidden')}>
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

  // Delete modal state
  const [deleteModalAcc, setDeleteModalAcc] = useState<string | null>(null);
  const [deleteWithData, setDeleteWithData] = useState(true);

  const handleDeleteAccount = async (zaloId: string) => {
    const ok = await showConfirm({
      title: deleteWithData ? 'Xoá tài khoản và tất cả dữ liệu?' : 'Xoá tài khoản này?',
      message: deleteWithData
        ? 'Tài khoản, tin nhắn, hội thoại, danh bạ, khách hàng, file media, nhãn, ghi chú và tất cả dữ liệu CRM sẽ bị XOÁ VĨNH VIỄN. Không thể khôi phục!'
        : 'Tài khoản sẽ bị xoá khỏi ứng dụng. Bạn cần đăng nhập lại để thêm lại. Dữ liệu tin nhắn và media được giữ lại.',
      confirmText: deleteWithData ? 'Xoá tất cả' : 'Xoá tài khoản',
      variant: deleteWithData ? 'danger' : 'warning',
    });
    if (!ok) return;
    const res = await ipc.login?.removeAccount(zaloId, deleteWithData);
    if (res?.success) {
      removeAccount(zaloId);
      showNotification(
        deleteWithData ? 'Đã xoá tài khoản và toàn bộ dữ liệu' : 'Đã xoá tài khoản',
        'success'
      );
      setDeleteModalAcc(null);
    } else {
      showNotification(extractApiError(res, 'Xoá tài khoản thất bại'), 'error');
    }
  };

  return (
    <>
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold text-foreground"><UserIcon className="w-4 h-4 inline" /> Tài khoản đã đăng nhập</h2>
      </div>
      <Section>
        <div className="space-y-2">
          {accounts.map((acc) => (
            <AccountCard key={acc.zalo_id} acc={acc} onDelete={() => setDeleteModalAcc(acc.zalo_id)} />
          ))}
          {accounts.length === 0 && <p className="text-muted-foreground text-sm">Chưa có tài khoản nào</p>}
        </div>
      </Section>

      {/* ── Delete account confirmation modal ── */}
      {deleteModalAcc && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={() => setDeleteModalAcc(null)}>
          <div className="bg-card border border-input rounded-2xl w-full max-w-md shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-5 pt-5 pb-3 border-b border-border">
              <div className="flex items-center gap-3 mb-1">
                <span className="text-2xl"><TrashIcon className="w-4 h-4" /></span>
                <h3 className="text-base font-semibold text-foreground">Xoá tài khoản</h3>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {accounts.find(a => a.zalo_id === deleteModalAcc)?.full_name || deleteModalAcc}
              </p>
            </div>

            {/* Options */}
            <div className="p-4 space-y-3">
              <label className={`flex items-start gap-3 p-3.5 rounded-xl border-2 transition-colors cursor-pointer ${deleteWithData ? 'border-red-500 bg-red-500/10' : 'border-input hover:bg-muted'}`}>
                <input
                  type="radio"
                  name="deleteMode"
                  checked={deleteWithData}
                  onChange={() => setDeleteWithData(true)}
                  className="mt-0.5 accent-red-500"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-red-300">Xoá tất cả dữ liệu</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    Xoá vĩnh viễn tài khoản, tin nhắn, hội thoại, danh bạ, khách hàng,
                    nhãn, ghi chú, chiến dịch CRM, workflow và toàn bộ file media (ảnh,
                    video, file đính kèm). <strong className="text-red-400">Không thể khôi phục!</strong>
                  </p>
                </div>
              </label>

              <label className={`flex items-start gap-3 p-3.5 rounded-xl border-2 transition-colors cursor-pointer ${!deleteWithData ? 'border-blue-500 bg-blue-500/10' : 'border-input hover:bg-muted'}`}>
                <input
                  type="radio"
                  name="deleteMode"
                  checked={!deleteWithData}
                  onChange={() => setDeleteWithData(false)}
                  className="mt-0.5 accent-blue-500"
                />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-blue-300">Chỉ xoá tài khoản</p>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    Xoá tài khoản khỏi danh sách đăng nhập. Dữ liệu tin nhắn,
                    danh bạ, CRM và file media được giữ nguyên trên ổ cứng.
                  </p>
                </div>
              </label>
            </div>

            {/* Footer */}
            <div className="px-4 pb-4 flex gap-2">
              <button
                onClick={() => setDeleteModalAcc(null)}
                className="flex-1 py-2 text-sm text-muted-foreground hover:text-foreground hover:bg-muted rounded-xl transition-colors"
              >
                Hủy
              </button>
              <button
                onClick={() => handleDeleteAccount(deleteModalAcc)}
                className={`flex-1 py-2 text-sm font-medium text-white rounded-xl transition-colors ${deleteWithData ? 'bg-red-600 hover:bg-red-500' : 'bg-orange-600 hover:bg-orange-500'}`}
              >
                {deleteWithData ? <><TrashIcon className="w-4 h-4 inline" /> Xoá tất cả</> : 'Xoá tài khoản'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
