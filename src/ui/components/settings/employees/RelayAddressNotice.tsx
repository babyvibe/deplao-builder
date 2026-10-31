import React, { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui';
import { AlertIcon, CheckIcon, CopyIcon } from '@/components/common/icons';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { cloudApi, navigateSettings } from '../cloud/cloudUi';
import {
  shouldShowUrlChangedNotice,
  type BossUrlChangeReason,
  type RelayTunnelStatus,
} from '../../../../shared/cloud/tunnelAddress';

const ACK_STORAGE_KEY = 'deplao_relay_url_ack';
const ACK_EVENT = 'relay:urlNoticeAck';

function readAck(): string | null {
  try { return localStorage.getItem(ACK_STORAGE_KEY); } catch { return null; }
}

/** Địa chỉ BOSS đã bấm "Đã gửi cho nhân viên" (đồng bộ giữa các màn đang mở). */
export function useRelayUrlAck(): [string | null, (url: string) => void] {
  const [ack, setAck] = useState<string | null>(readAck);
  useEffect(() => {
    const onAck = (event: Event) => setAck((event as CustomEvent<string>).detail ?? readAck());
    window.addEventListener(ACK_EVENT, onAck);
    return () => window.removeEventListener(ACK_EVENT, onAck);
  }, []);
  const acknowledge = useCallback((url: string) => {
    try { localStorage.setItem(ACK_STORAGE_KEY, url); } catch { /* ignore */ }
    setAck(url);
    window.dispatchEvent(new CustomEvent(ACK_EVENT, { detail: url }));
  }, []);
  return [ack, acknowledge];
}

const REASON_TEXT: Record<BossUrlChangeReason, string> = {
  restart: 'Tunnel bị ngắt và đã tự chạy lại với địa chỉ mới.',
  start: 'Tunnel vừa bật với địa chỉ khác lần trước (địa chỉ tạm đổi mỗi lần khởi động lại).',
  switch: 'Bạn vừa đổi cấu hình tunnel.',
};

/** Sao chép vào clipboard + báo kết quả. */
export function copyWithToast(text: string, okMessage = 'Đã sao chép'): void {
  const notify = useAppStore.getState().showNotification;
  navigator.clipboard.writeText(text)
    .then(() => notify(okMessage, 'success'))
    .catch(() => notify('Không sao chép được — hãy chọn và sao chép thủ công', 'error'));
}

interface RelayAddressNoticeProps {
  status: RelayTunnelStatus | null | undefined;
  /**
   * Bấm "Thiết lập địa chỉ cố định" (chỉ hiện khi đang dùng địa chỉ tạm). Mặc định mở Cài đặt → Internet & Đám mây →
   * Địa chỉ Internet (nơi duy nhất cấu hình địa chỉ); máy nhân viên / bản app không có module Cloudflare thì ẩn nút.
   */
  onSetupFixed?: () => void;
  className?: string;
}

/**
 * "Địa chỉ cho nhân viên đã đổi" — hiện tới khi BOSS bấm "Đã gửi cho nhân viên". Nhân viên còn nối được (LAN,
 * hoặc qua tunnel cũ khi đổi cấu hình) đã được báo tự động; nhân viên ở xa cần BOSS gửi địa chỉ mới.
 */
export default function RelayAddressNotice({ status, onSetupFixed, className }: RelayAddressNoticeProps) {
  const [ack, acknowledge] = useRelayUrlAck();
  const employeeMachine = useEmployeeStore(s => s.mode) === 'employee';
  const setupFixed = onSetupFixed
    ?? (!employeeMachine && cloudApi() ? () => navigateSettings('cloud', 'address') : undefined);
  if (!status || !shouldShowUrlChangedNotice(status, ack) || !status.tunnelUrl) return null;
  const url = status.tunnelUrl;
  const changedAt = status.urlChangedAt
    ? new Date(status.urlChangedAt).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })
    : '';
  const reasonText = status.changeReason ? REASON_TEXT[status.changeReason] : '';

  return (
    <div role="alert" className={`rounded-xl border border-warning/40 bg-warning/10 p-3.5 space-y-2.5 ${className || ''}`}>
      <div className="flex items-start gap-2">
        <AlertIcon className="w-4 h-4 text-warning flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-foreground">
            Địa chỉ cho nhân viên đã đổi{changedAt ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">lúc {changedAt}</span> : null}
          </p>
          {reasonText && <p className="text-xs text-muted-foreground mt-0.5">{reasonText}</p>}
        </div>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5">
        <code className="flex-1 min-w-0 truncate font-mono text-xs text-foreground select-all" title={url}>{url}</code>
        <Button size="sm" leftIcon={<CopyIcon className="w-4 h-4" />} onClick={() => copyWithToast(url, 'Đã sao chép địa chỉ mới')}>
          Sao chép
        </Button>
      </div>

      {status.previousUrl && (
        <p className="text-[11px] text-subtle-foreground truncate" title={status.previousUrl}>
          Địa chỉ cũ (không dùng được nữa): <span className="font-mono line-through">{status.previousUrl}</span>
        </p>
      )}

      <p className="text-xs text-muted-foreground leading-relaxed">
        Nhân viên còn kết nối được (qua mạng LAN) đã được báo và tự chuyển. Nhân viên làm việc từ xa: gửi họ địa chỉ mới
        để dán vào ô <strong className="text-foreground">"Kết nối lại"</strong> trên thanh tiêu đề.
      </p>

      {status.kind === 'temporary' && (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Dùng <strong className="text-foreground">Địa chỉ cố định</strong> để không phải gửi lại sau mỗi lần khởi động lại.
          {setupFixed && (
            <Button variant="link" size="sm" className="ml-1 text-xs" onClick={setupFixed}>Thiết lập địa chỉ cố định</Button>
          )}
        </p>
      )}

      <div className="flex justify-end">
        <Button variant="ghost" size="sm" leftIcon={<CheckIcon className="w-4 h-4" />} onClick={() => acknowledge(url)}>
          Đã gửi cho nhân viên
        </Button>
      </div>
    </div>
  );
}
