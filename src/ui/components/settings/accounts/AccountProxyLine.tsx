/**
 * Dòng "Proxy" dưới mỗi tài khoản Zalo / Facebook ở Cài đặt → Tài khoản: hiện proxy đang dùng, bấm để chọn proxy khác
 * (hoặc bỏ proxy) ngay tại chỗ. "Áp dụng" thử proxy, lưu rồi kết nối lại tài khoản, không cần đăng nhập lại (issue #73,
 * trước đây proxy chỉ chọn được lúc đăng nhập).
 */
import React, { useEffect, useState } from 'react';
import { cn } from '@/lib/cn';
import type { AccountInfo } from '@/store/accounts/accountStore';
import { useApplyAccountProxy } from '@/hooks/accounts/useAccountProxy';
import { GlobeIcon } from '@/components/common/icons';
import { Button } from '@/components/ui';
import { SettingLine } from '../settingsUi';

export interface ProxyOption {
  id: number;
  name: string;
  type: string;
  host: string;
  port: number;
}

/** Chữ tóm tắt bên phải dòng: tên proxy đang dùng / "Không dùng"; proxy đã xoá khỏi danh sách thì cần để ý. */
export function accountProxySummary(proxyId: number | null | undefined, proxies: ProxyOption[] | null): { text: string; warning?: boolean } {
  if (proxyId == null) return { text: 'Không dùng' };
  if (!proxies) return { text: 'Đang tải...' };
  const proxy = proxies.find((p) => p.id === proxyId);
  return proxy ? { text: `${proxy.name} · ${proxy.type.toUpperCase()}` } : { text: 'Proxy đã bị xoá', warning: true };
}

const openProxySettings = () => {
  window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'proxy' } }));
};

export default function AccountProxyLine({ account, proxies, panelId, open, onToggle }: {
  account: AccountInfo;
  /** null = đang tải danh sách proxy */
  proxies: ProxyOption[] | null;
  panelId: string;
  open: boolean;
  onToggle: () => void;
}) {
  const applyProxy = useApplyAccountProxy();
  const current = account.proxy_id ?? null;
  const [choice, setChoice] = useState<number | null>(current);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');

  // Mở dòng: chọn theo giá trị đang lưu, bỏ lỗi cũ
  useEffect(() => {
    if (!open) return;
    setChoice(current);
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Proxy đổi ở nơi khác (trang Proxy) hoặc vừa lưu: theo giá trị mới, giữ lỗi kết nối lại (nếu có) để người dùng thấy
  useEffect(() => {
    if (!applying) setChoice(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const dirty = choice !== current;
  const summary = accountProxySummary(current, proxies);

  const apply = async () => {
    if (!dirty || applying) return;
    setApplying(true);
    setError('');
    const outcome = await applyProxy(account.zalo_id, choice);
    setApplying(false);
    if (!outcome.ok) setError(outcome.error || 'Không đổi được proxy');
    else if (outcome.connected === false) setError(`Đã lưu nhưng chưa kết nối lại được: ${outcome.error}`);
    else onToggle();
  };

  const option = (id: number | null, title: string, detail: string) => {
    const active = choice === id;
    return (
      <label key={id ?? 'none'} className={cn(
        'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 transition-colors',
        active ? 'border-primary bg-primary/5' : 'border-border/60 hover:bg-muted',
        applying && 'pointer-events-none opacity-60',
      )}>
        <input type="radio" name={`${panelId}-proxy`} checked={active} disabled={applying}
          onChange={() => setChoice(id)} className="accent-primary" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-foreground">
            {title}
            {id === current && <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">(đang dùng)</span>}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">{detail}</span>
        </span>
      </label>
    );
  };

  return (
    <SettingLine panelId={panelId} icon={<GlobeIcon className="h-4 w-4" />} title="Proxy"
      summary={summary.text} summaryTone={summary.warning ? 'warning' : undefined} open={open} onToggle={onToggle}>
      {!proxies ? (
        <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-border-strong border-t-transparent" />
          Đang tải danh sách proxy...
        </div>
      ) : (
        <div className="space-y-3">
          <div role="radiogroup" aria-label="Proxy cho tài khoản" className="space-y-1.5">
            {option(null, 'Không dùng proxy', 'Kết nối thẳng bằng mạng của máy')}
            {proxies.map((p) => option(p.id, p.name, `${p.type.toUpperCase()} · ${p.host}:${p.port}`))}
          </div>
          {proxies.length === 0 && (
            <p className="text-xs text-muted-foreground">
              Chưa có proxy nào.{' '}
              <button type="button" onClick={openProxySettings} className="font-medium text-primary hover:underline">Thêm proxy</button>
            </p>
          )}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <p className="flex-1 text-[11px] leading-relaxed text-muted-foreground">Đổi xong tài khoản tự kết nối lại, không cần đăng nhập lại.</p>
            {dirty && !applying && (
              <Button variant="ghost" size="sm" onClick={() => setChoice(current)}>Huỷ</Button>
            )}
            <Button size="sm" onClick={() => void apply()} disabled={!dirty || applying}>
              {applying ? 'Đang kết nối lại...' : 'Áp dụng'}
            </Button>
          </div>
        </div>
      )}
    </SettingLine>
  );
}
