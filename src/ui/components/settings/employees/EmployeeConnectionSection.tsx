/**
 * Settings → Employees → the "Kết nối" (Connection) section: one switch that opens the door for employees, right below it the address to send to employees (on the same
 * network / over the Internet, with a copy button), auto-start when the app opens, port. The Internet address is view only: turn it on / change it in Settings →
 * Internet & Cloud → Internet address (one place to configure it for employees, API, webhooks).
 */
import React, { useEffect, useState } from 'react';
import { Button, Input, Switch } from '@/components/ui';
import { CopyIcon } from '@/components/common/icons';
import { cn } from '@/lib/cn';
import { usePublicAddresses } from '../../common/cloud/PublicAddressCard';
import { navigateSettings } from '../cloud/cloudUi';
import { SettingsRow, SettingsSection } from '../settingsUi';
import RelayAddressNotice, { copyWithToast } from './RelayAddressNotice';
import type { RelayConnection } from './useRelayConnection';
import { tr } from '../../../../shared/i18n';

/** Address as a code + copy button (one block, clicking the whole block also copies). */
export function AddressChip({ value, label, className }: { value: string; label: string; className?: string }) {
  return (
    <button
      type="button"
      onClick={() => copyWithToast(value, tr('Đã sao chép địa chỉ'))}
      title={tr('Sao chép {{value}}', { value })}
      aria-label={tr('Sao chép {{label}}', { label })}
      className={cn(
        'group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border bg-muted py-1 pl-2.5 pr-1.5',
        'font-mono text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-selected',
        className,
      )}
    >
      <span className="min-w-0 truncate">{value}</span>
      <CopyIcon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground group-hover:text-primary" />
    </button>
  );
}

export interface InternetAddress {
  url: string | null;
  kind: 'fixed' | 'temporary' | null;
  pending: boolean;
  restarting: boolean;
  error: string | null;
  warning: string | null;
  /** This machine can configure an address (has the Cloudflare module, not an employee machine). */
  canConfigure: boolean;
}

/** Internet address for employees: follows Internet & Cloud (builds with the Cloudflare module), otherwise follows the old-style tunnel. */
export function useInternetAddress(connection: RelayConnection): InternetAddress {
  const pub = usePublicAddresses();
  const addr = pub.available && pub.loaded ? pub.get('relay') : null;
  if (addr) {
    const url = addr.enabled && addr.url ? addr.url.replace(/\/+$/, '') : null;
    return {
      url,
      kind: url ? addr.kind : null,
      pending: !url && addr.enabled && (addr.state === 'starting' || addr.state === 'restarting'),
      restarting: addr.state === 'restarting',
      error: addr.enabled && addr.state === 'error' ? addr.error || null : null,
      warning: null,
      canConfigure: pub.canConfigure,
    };
  }
  const tunnel = connection.tunnel;
  const url = tunnel.active && tunnel.tunnelUrl ? tunnel.tunnelUrl : null;
  return {
    url,
    kind: url ? tunnel.kind : null,
    pending: !url && (tunnel.state === 'starting' || tunnel.state === 'restarting'),
    restarting: tunnel.state === 'restarting',
    error: tunnel.lastError && tunnel.state === 'restarting' ? tunnel.lastError : null,
    warning: tunnel.warning,
    canConfigure: pub.canConfigure,
  };
}

export default function EmployeeConnectionSection({ connection, internet, onlineCount }: {
  connection: RelayConnection;
  internet: InternetAddress;
  onlineCount: number;
}) {
  const { running, busy, port, localIPs, autoStart } = connection;
  const [portDraft, setPortDraft] = useState(String(port));
  useEffect(() => { setPortDraft(String(port)); }, [port]);
  const draftPort = parseInt(portDraft, 10);
  const portValid = Number.isInteger(draftPort) && draftPort > 0 && draftPort < 65536;

  const toggle = (on: boolean) => {
    if (on) void connection.start(portValid ? draftPort : port);
    else void connection.stop();
  };

  const status = busy
    ? (running ? tr('Đang tắt…') : tr('Đang mở…'))
    : running
      ? (onlineCount > 0 ? tr('Đang mở · {{onlineCount}} nhân viên online', { onlineCount }) : tr('Đang mở · chưa ai vào'))
      : tr('Đang tắt, nhân viên chưa vào được.');

  const internetLink = internet.canConfigure ? (
    <Button variant="link" size="sm" className="text-xs" onClick={() => navigateSettings('cloud', 'address')}>
      {!internet.url && !internet.pending ? tr('Bật ở Internet & Cloud →') : internet.kind === 'temporary' ? tr('Dùng địa chỉ cố định →') : tr('Đổi địa chỉ →')}
    </Button>
  ) : null;

  const internetDesc = internet.url
    ? (internet.kind === 'temporary' ? tr('Cho nhân viên ở xa. Địa chỉ tạm, đổi mỗi lần khởi động lại.') : tr('Cho nhân viên ở xa. Địa chỉ cố định.'))
    : internet.pending
      ? (internet.restarting ? tr('Đang tự chạy lại…') : tr('Đang tạo địa chỉ…'))
      : tr('Chưa bật. Dùng khi nhân viên ở xa.');

  const internetNotes = internet.url || internet.error || internet.warning;

  return (
    <>
    {/* The Internet address just changed (the temporary address restarted…): remind to send it again to remote employees */}
    <RelayAddressNotice status={connection.tunnel} />
    <SettingsSection title={tr('Kết nối')} footer={tr('Nhân viên chỉ vào được khi Deplao trên máy này đang mở.')}>
      <SettingsRow
        title={tr('Cho nhân viên kết nối')}
        description={<span className={cn(running && !busy && 'text-success')}>{status}</span>}
        control={(
          <Switch checked={running} disabled={busy} onCheckedChange={toggle} aria-label={tr('Cho nhân viên kết nối')} />
        )}
      />

      {running && (
        <SettingsRow title={tr('Cùng mạng (LAN)')} description={tr('Cùng wifi, mạng công ty. Nên đặt IP tĩnh cho máy này.')}>
          {localIPs.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {localIPs.map((ip) => <AddressChip key={ip} value={`${ip}:${port}`} label={tr('địa chỉ {{ip}}', { ip })} />)}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{tr('Chưa thấy địa chỉ mạng của máy này.')}</p>
          )}
        </SettingsRow>
      )}

      <SettingsRow title={tr('Qua Internet')} description={internetDesc} control={!internet.url ? internetLink : undefined}>
        {internetNotes ? (
          <div className="space-y-2">
            {internet.url && (
              <div className="flex flex-wrap items-center gap-2">
                <AddressChip value={internet.url} label={tr('địa chỉ Internet')} />
                {internetLink}
              </div>
            )}
            {internet.url && !running && (
              <p className="text-xs text-warning">{tr('Bật "Cho nhân viên kết nối" ở trên thì nhân viên mới vào được qua địa chỉ này.')}</p>
            )}
            {internet.error && <p className="break-words text-xs text-destructive">{internet.error}</p>}
            {internet.warning && <p className="break-words text-xs text-warning">{internet.warning}</p>}
          </div>
        ) : undefined}
      </SettingsRow>

      <SettingsRow
        title={tr('Tự bật khi mở app')}
        description={tr('Mở Deplao là nhân viên vào lại được ngay.')}
        control={(
          <Switch checked={autoStart} onCheckedChange={(on) => { void connection.setAutoStart(on, portValid ? draftPort : port); }}
            aria-label={tr('Tự bật khi mở app')} />
        )}
      />

      <SettingsRow
        title={tr('Cổng')}
        description={running ? tr('Tắt kết nối để đổi cổng.') : tr('Mặc định 9900.')}
        control={(
          <Input
            value={portDraft}
            onChange={(e) => setPortDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
            onBlur={() => {
              if (!portValid) { setPortDraft(String(port)); return; }
              if (draftPort !== port) void connection.savePort(draftPort);
            }}
            disabled={running || busy}
            inputMode="numeric"
            aria-label={tr('Cổng')}
            invalid={!portValid}
            className="h-8 w-24 text-center font-mono"
          />
        )}
      />
    </SettingsSection>
    </>
  );
}
