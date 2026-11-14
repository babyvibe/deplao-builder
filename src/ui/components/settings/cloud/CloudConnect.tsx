/**
 * Connect Cloudflare - 3 steps: create a token through the Cloudflare link with the permissions pre-filled → paste the token and Account ID → Connect.
 * Used in Settings → Internet & Cloud (not connected yet / changing the token) and in step 1 of the restore wizard.
 * The token only flows one way, renderer → main (main stores it with safeStorage); the renderer never reads it back.
 */
import React, { useId, useState } from 'react';
import { useAppStore } from '@/store/app/appStore';
import { CloudIcon, ExternalLinkIcon } from '@/components/common/icons';
import { Button, Card, FormField, Input } from '@/components/ui';
import { cn } from '@/lib/cn';
import type { CloudConnectionStatus } from '../../../../shared/cloud/cloudContracts';
import { cleanIpcError, cloudApi, openExternalUrl, useStorage } from './cloudUi';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

const ACCOUNT_ID_RE = /^[a-f0-9]{32}$/;

export interface ConnectFormProps {
  onConnected: (connection: CloudConnectionStatus) => void;
  /** Account ID pre-filled (changing the token for the account in use). */
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
    if (!api) { notify(tr('Bản app này chưa có tính năng Cloudflare. Hãy cập nhật Deplao.'), 'warning'); return; }
    setBusy('template');
    try {
      const res = await api.tokenTemplateUrl();
      if (res?.success && res.url) openExternalUrl(res.url);
      else notify(res?.error || tr('Không mở được trang tạo token'), 'error');
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
    if (!tok) { setError(tr('Dán token vừa tạo trên Cloudflare.')); return; }
    if (!ACCOUNT_ID_RE.test(id)) { setError(tr('Account ID gồm 32 ký tự (chữ a–f và số). Xem ở trang Overview của tên miền trên Cloudflare.')); return; }
    if (!api) { setError(tr('Bản app này chưa có tính năng Cloudflare. Hãy cập nhật Deplao.')); return; }
    setBusy('connect');
    setError(null);
    try {
      const res = await api.connect({ accountId: id, token: tok });
      if (!res?.success || !res.connection) {
        setError(res?.error || tr('Không kết nối được. Kiểm tra lại token và Account ID.'));
        return;
      }
      if (!res.connection.connected) {
        setError(res.connection.lastError || tr('Token không dùng được. Tạo token mới rồi thử lại.'));
        return;
      }
      setToken('');
      notify(tr('Đã kết nối Cloudflare'), 'success');
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
          title={tr('Tạo token')}
          description={tr('Mở trang Cloudflare đã điền sẵn quyền, bấm Continue to summary → Create Token rồi sao chép token.')}
        >
          <Button
            variant="outline"
            size="sm"
            rightIcon={<ExternalLinkIcon className="h-3.5 w-3.5" />}
            loading={busy === 'template'}
            onClick={() => void openTemplate()}
          >
            {tr('Tạo token trên Cloudflare')}
          </Button>
        </Step>
        <Step
          n={2}
          title={tr('Dán token và Account ID')}
          description={<>{tr('Account ID ở trang Overview của tên miền, hoặc trên thanh địa chỉ dash.cloudflare.com/<Account ID>.')}</>}
        >
          <div className="grid gap-3 md:grid-cols-2">
            <FormField label={tr('API token')} htmlFor={tokenId}>
              <Input
                id={tokenId}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={token}
                onChange={e => { setToken(e.target.value); setError(null); }}
                placeholder={tr('Dán token')}
              />
            </FormField>
            <FormField label={tr('Account ID')} htmlFor={accountFieldId}>
              <Input
                id={accountFieldId}
                autoComplete="off"
                spellCheck={false}
                value={accountId}
                onChange={e => { setAccountId(e.target.value); setError(null); }}
                placeholder={tr('32 ký tự')}
                className="font-mono"
              />
            </FormField>
          </div>
        </Step>
        <Step
          n={3}
          title={tr('Kết nối')}
          description={tr('Deplao kiểm tra token, đọc danh sách tên miền và thử quyền của từng tính năng. Token lưu mã hoá trên máy này.')}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={busy === 'connect'}>{tr('Kết nối')}</Button>
            {onCancel && <Button variant="ghost" onClick={onCancel} disabled={busy === 'connect'}>{tr('Huỷ')}</Button>}
          </div>
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </Step>
      </ol>
    </form>
  );
}

/** Which permissions each feature needs (shown next to the connect form). */
export function FeatureNeeds({ className }: { className?: string }) {
  // App build that has the storage choice (knows the storage status) → the Data sync hint says it can use Google Drive instead of R2.
  const storeChoice = useStorage() != null;
  return (
    <div className={cn('space-y-2 rounded-xl bg-muted px-4 py-3 text-xs leading-relaxed text-muted-foreground', className)}>
      <p className="text-sm font-semibold text-foreground">{tr('Tính năng nào cần gì')}</p>
      <ul className="space-y-2">
        <li>
          {trx('<0>Địa chỉ cố định:</0> quyền Cloudflare Tunnel (Edit), DNS (Edit), Zone (Read) và một tên miền đã thêm vào Cloudflare (gói Free là đủ).', { 0: <strong className="text-foreground" /> })}
        </li>
        <li>
          {trx('<0>Đồng bộ dữ liệu (kèm ảnh, file):</0> quyền Workers R2 Storage (Edit) và bật R2 trên tài khoản. Cloudflare yêu cầu thêm phương thức thanh toán; 10 GB mỗi tháng miễn phí.', { 0: <strong className="text-foreground" /> })}
        </li>
        {storeChoice && (
          <li>{tr('Đồng bộ dữ liệu cũng dùng được kho Google Drive (chỉ cần tài khoản Google) — chọn ở thẻ Kho lưu.')}</li>
        )}
        <li>
          {trx('<0>Worker, D1 (cho ứng dụng):</0> quyền Workers Scripts (Edit) và D1 (Edit) — chỉ cần khi cài ứng dụng tự triển khai lên Cloudflare của bạn; ứng dụng chỉ đụng tới tài nguyên mang tên của nó.', { 0: <strong className="text-foreground" /> })}
        </li>
        <li>{tr('Không có Cloudflare, Địa chỉ Internet vẫn dùng được với địa chỉ tạm và ngrok.')}</li>
      </ul>
    </div>
  );
}

export interface ConnectCardProps extends ConnectFormProps {
  title?: string;
  className?: string;
}

/** The "Kết nối Cloudflare" (Connect Cloudflare) card at the top of the Internet & Cloud page when not connected (or when changing the token). */
export function ConnectCard({ title = tr('Kết nối Cloudflare'), className, ...form }: ConnectCardProps) {
  return (
    <Card className={cn('space-y-4 p-4', className)}>
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
          <CloudIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            {tr('Dùng tài khoản Cloudflare của bạn. Deplao chỉ tạo tunnel, tên miền con và bucket có tên deplao-… (ứng dụng được cấp quyền chỉ tạo Worker, D1 mang tên của ứng dụng); dữ liệu đã có trên Cloudflare không bị đụng tới.')}
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
