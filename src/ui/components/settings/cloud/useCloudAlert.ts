/**
 * useCloudAlert — chấm đỏ "Internet & Đám mây" ở thanh trái Cài đặt khi phần Cloudflare cần người dùng xem:
 * token lỗi / thiếu quyền, địa chỉ cố định lỗi, đồng bộ ảnh / dữ liệu lỗi, hoặc vừa khôi phục và tự động hoá
 * đang tạm dừng.
 *
 * Rẻ: chỉ đọc trạng thái đã có trong main (không gọi Cloudflare), đọc một lần khi mở Cài đặt rồi đọc lại khi main
 * báo đổi (CLOUD_CHANGED_EVENT, gộp 1,5 s). Không có chu kỳ. Máy nhân viên / bản app cũ → không gọi gì.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudApi, useCloudChanged } from './cloudUi';

export interface CloudAlertState {
  /** Câu ngắn cho tooltip, rỗng = không có gì cần xem. */
  reasons: string[];
}

const EMPTY: CloudAlertState = { reasons: [] };

async function readCloudAlerts(): Promise<CloudAlertState> {
  const api = cloudApi();
  if (!api) return EMPTY;
  const safe = <T,>(p: Promise<T> | undefined): Promise<T | null> => (p ? p.catch(() => null) : Promise.resolve(null));
  const [conn, addrs, media, db, restore, store] = await Promise.all([
    safe(api.status()),
    safe(api.tunnel?.addresses?.()),
    safe(api.media?.status?.()),
    safe(api.db?.status?.()),
    safe(api.db?.restoreState?.()),
    safe(api.storage?.status?.()),
  ]);
  const reasons: string[] = [];
  // Kho lưu: bản app cũ không có → R2. Dùng Google Drive thì thiếu quyền R2 không còn là vấn đề.
  const st = store?.success ? store.storage : null;
  const gdrive = st?.provider === 'gdrive';

  const c = conn?.success ? conn.connection : null;
  if (c?.connected) {
    if (c.lastError) reasons.push('Kết nối Cloudflare lỗi');
    // Worker + D1 (cho ứng dụng) là quyền không bắt buộc — thiếu không chấm đỏ.
    else if (c.permissions?.some(p => !p.ok && p.feature !== 'workers' && !(gdrive && p.feature === 'r2'))) reasons.push('Token Cloudflare thiếu quyền');
  }

  const list = addrs?.success && Array.isArray(addrs.addresses) ? addrs.addresses : [];
  if (list.some(a => a.mode === 'cloudflare_auto' && a.enabled && a.state === 'error')) reasons.push('Địa chỉ cố định đang lỗi');

  const m = media?.success ? media.status : null;
  if (m?.enabled && m.lastError) reasons.push('Đồng bộ ảnh, file đang lỗi');

  const d = db?.success ? db.status : null;
  if (d && d.mode !== 'off' && d.workspaces?.some(w => w.state === 'error')) reasons.push('Đồng bộ dữ liệu đang lỗi');

  if (gdrive && !st.ready && ((d && d.mode !== 'off') || m?.enabled)) reasons.push('Cần đăng nhập lại Google Drive');

  if (restore?.success && restore.pausedAutomations) reasons.push('Đã khôi phục dữ liệu, tự động hoá đang tạm dừng');

  return reasons.length ? { reasons } : EMPTY;
}

/** enabled = false (máy nhân viên…) → luôn rỗng, không gọi IPC. */
export function useCloudAlert(enabled: boolean): CloudAlertState {
  const [state, setState] = useState<CloudAlertState>(EMPTY);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(() => {
    if (!enabled || !cloudApi()) return;
    void readCloudAlerts().then(next => {
      if (!alive.current) return;
      // Giữ nguyên object khi không đổi để không render lại thanh trái.
      setState(prev => (prev.reasons.join('|') === next.reasons.join('|') ? prev : next));
    });
  }, [enabled]);

  useEffect(() => {
    if (enabled) refresh();
    else setState(EMPTY);
  }, [enabled, refresh]);

  useCloudChanged(() => refresh(), 1500);
  return state;
}
