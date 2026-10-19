/**
 * Kết nối Cloudflare — 3 bước: tạo token qua link Cloudflare điền sẵn quyền → dán token và Account ID → Kết nối.
 * Dùng ở Cài đặt → Internet & Đám mây (chưa kết nối / đổi token) và bước 1 của trình khôi phục.
 * Token chỉ đi một chiều renderer → main (main lưu bằng safeStorage); renderer không bao giờ đọc lại.
 */
import React, { useId, useState } from 'react';
import { useAppStore } from '@/store/appStore';
import { CloudIcon, ExternalLinkIcon } from '@/components/common/icons';
import { Button, Card, FormField, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { CloudConnectionStatus } from '../../../../shared/cloudContracts';
import { cleanIpcError, cloudApi, openExternalUrl, useStorage } from './cloudUi';

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/;

export interface ConnectFormProps {
  onConnected: (connection: CloudConnectionStatus) => void;
  /** Điền sẵn Account ID (đổi token cho tài khoản đang dùng). */
  initialAccountId?: string;
  onCancel?: () => void;
}

function Step({ n, title, description, children }: { n: number; title: string; description?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full border border-primary/40 bg-primary/10 text-[11px] font-semibold text-primary">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <div>
          <p className="text-sm font-semibold text-foreground">{title}</p>
          {description != null && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
        </div>
        {children}
      </div>
    </li>
  );
}

export function ConnectForm({ onConnected, initialAccountId = '', onCancel }: ConnectFormProps) {
  const notify = useAppStore(s => s.showNotification);
  const tokenId = useId();
  const accountFieldId = useId();
  const [token, setToken] = useState('');
  const [accountId, setAccountId] = useState(initialAccountId);
  const [busy, setBusy] = useState<'template' | 'connect' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openTemplate = async () => {
    const api = cloudApi();
    if (!api) { notify('Bản app này chưa có tính năng Cloudflare. Hãy cập nhật Deplao.', 'warning'); return; }
    setBusy('template');
    try {
      const res = await api.tokenTemplateUrl();
      if (res?.success && res.url) openExternalUrl(res.url);
      else notify(res?.error || 'Không mở được trang tạo token', 'error');
    } catch (err) {
      notify(cleanIpcError(err), 'error');
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    const api = cloudApi();
    const id = accountId.trim().toLowerCase();
    const tok = token.trim();
    if (!tok) { setError('Dán token vừa tạo trên Cloudflare.'); return; }
    if (!ACCOUNT_ID_RE.test(id)) { setError('Account ID gồm 32 ký tự (chữ a–f và số). Xem ở trang Overview của tên miền trên Cloudflare.'); return; }
    if (!api) { setError('Bản app này chưa có tính năng Cloudflare. Hãy cập nhật Deplao.'); return; }
    setBusy('connect');
    setError(null);
    try {
      const res = await api.connect({ accountId: id, token: tok });
      if (!res?.success || !res.connection) {
        setError(res?.error || 'Không kết nối được. Kiểm tra lại token và Account ID.');
        return;
      }
      if (!res.connection.connected) {
        setError(res.connection.lastError || 'Token không dùng được. Tạo token mới rồi thử lại.');
        return;
      }
      setToken('');
      notify('Đã kết nối Cloudflare', 'success');
      onConnected(res.connection);
    } catch (err) {
      setError(cleanIpcError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <form
      className="space-y-4"
      autoComplete="off"
      onSubmit={e => { e.preventDefault(); void connect(); }}
    >
      <ol className="space-y-4">
        <Step
          n={1}
          title="Tạo token"
          description="Mở trang Cloudflare đã điền sẵn quyền, bấm Continue to summary → Create Token rồi sao chép token."
        >
          <Button
            variant="outline"
            size="sm"
            rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
            loading={busy === 'template'}
            onClick={() => void openTemplate()}
          >
            Tạo token trên Cloudflare
          </Button>
        </Step>
        <Step
          n={2}
          title="Dán token và Account ID"
          description={<>Account ID ở trang Overview của tên miền, hoặc trên thanh địa chỉ {'dash.cloudflare.com/<Account ID>'}.</>}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label="API token" htmlFor={tokenId}>
              <Input
                id={tokenId}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={token}
                onChange={e => { setToken(e.target.value); setError(null); }}
                placeholder="Dán token"
              />
            </FormField>
            <FormField label="Account ID" htmlFor={accountFieldId}>
              <Input
                id={accountFieldId}
                autoComplete="off"
                spellCheck={false}
                value={accountId}
                onChange={e => { setAccountId(e.target.value); setError(null); }}
                placeholder="32 ký tự"
                className="font-mono"
              />
            </FormField>
          </div>
        </Step>
        <Step
          n={3}
          title="Kết nối"
          description="Deplao kiểm tra token, đọc danh sách tên miền và thử quyền của từng tính năng. Token lưu mã hoá trên máy này."
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={busy === 'connect'}>Kết nối</Button>
            {onCancel && <Button variant="ghost" onClick={onCancel} disabled={busy === 'connect'}>Huỷ</Button>}
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </Step>
      </ol>
    </form>
  );
}

/** Tính năng nào cần quyền gì (hiện cạnh form kết nối). */
export function FeatureNeeds({ className }: { className?: string }) {
  // Bản app có chọn kho lưu (biết trạng thái kho) → nhắc Đồng bộ dữ liệu dùng được Google Drive thay cho R2.
  const storeChoice = useStorage() != null;
  return (
    <div className={cn('space-y-2 rounded-xl bg-muted px-4 py-3 text-xs leading-relaxed text-muted-foreground', className)}>
      <p className="text-sm font-semibold text-foreground">Tính năng nào cần gì</p>
      <ul className="space-y-2">
        <li>
          <strong className="text-foreground">Địa chỉ cố định:</strong> quyền Cloudflare Tunnel (Edit), DNS (Edit), Zone (Read)
          và một tên miền đã thêm vào Cloudflare (gói Free là đủ).
        </li>
        <li>
          <strong className="text-foreground">Đồng bộ dữ liệu (kèm ảnh, file):</strong> quyền Workers R2 Storage (Edit) và bật R2 trên
          tài khoản. Cloudflare yêu cầu thêm phương thức thanh toán; 10 GB mỗi tháng miễn phí.
        </li>
        {storeChoice && (
          <li>Đồng bộ dữ liệu cũng dùng được kho Google Drive (chỉ cần tài khoản Google) — chọn ở thẻ Kho lưu.</li>
        )}
        <li>Không có Cloudflare, Địa chỉ Internet vẫn dùng được với địa chỉ tạm và ngrok.</li>
      </ul>
    </div>
  );
}

export interface ConnectCardProps extends ConnectFormProps {
  title?: string;
  className?: string;
}

/** Thẻ "Kết nối Cloudflare" ở đầu trang Internet & Đám mây khi chưa kết nối (hoặc khi đổi token). */
export function ConnectCard({ title = 'Kết nối Cloudflare', className, ...form }: ConnectCardProps) {
  return (
    <Card className={cn('space-y-4 p-4', className)}>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <CloudIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            Dùng tài khoản Cloudflare của bạn. Deplao chỉ tạo tunnel, tên miền con và bucket có tên deplao-…; dữ liệu
            đã có trên Cloudflare không bị đụng tới.
          </p>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <ConnectForm {...form} />
        <FeatureNeeds className="self-start" />
      </div>
    </Card>
  );
}
