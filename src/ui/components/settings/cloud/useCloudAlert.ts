/**
 * useCloudAlert - red dot on "Internet & Cloud" in the Settings left bar when the Cloudflare section needs the user's attention:
 * token error / missing permission, fixed address error, image / data sync error, or just restored with automations
 * paused.
 *
 * Cheap: only reads the state already in main (does not call Cloudflare), reads once when Settings opens, then reads again when main
 * reports a change (CLOUD_CHANGED_EVENT, merged over 1,5 s). No timer. Employee machines / old app builds → calls nothing.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { cloudApi, useCloudChanged } from './cloudUi';
import { tr } from '../../../../shared/i18n';

export interface CloudAlertState {
  /** Short sentence for the tooltip; empty = nothing to look at. */
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
  // Storage: old app build without it → R2. With Google Drive, missing R2 permission is no longer a problem.
  const st = store?.success ? store.storage : null;
  const gdrive = st?.provider === 'gdrive';

  const c = conn?.success ? conn.connection : null;
  if (c?.connected) {
    if (c.lastError) reasons.push(tr('Kết nối Cloudflare lỗi'));
    // Worker + D1 (for apps) are optional permissions: missing them does not show a red dot.
    else if (c.permissions?.some(p => !p.ok && p.feature !== 'workers' && !(gdrive && p.feature === 'r2'))) reasons.push(tr('Token Cloudflare thiếu quyền'));
  }

  const list = addrs?.success && Array.isArray(addrs.addresses) ? addrs.addresses : [];
  if (list.some(a => a.mode === 'cloudflare_auto' && a.enabled && a.state === 'error')) reasons.push(tr('Địa chỉ cố định đang lỗi'));

  const m = media?.success ? media.status : null;
  if (m?.enabled && m.lastError) reasons.push(tr('Đồng bộ ảnh, file đang lỗi'));

  const d = db?.success ? db.status : null;
  if (d && d.mode !== 'off' && d.workspaces?.some(w => w.state === 'error')) reasons.push(tr('Đồng bộ dữ liệu đang lỗi'));

  if (gdrive && !st.ready && ((d && d.mode !== 'off') || m?.enabled)) reasons.push(tr('Cần đăng nhập lại Google Drive'));

  if (restore?.success && restore.pausedAutomations) reasons.push(tr('Đã khôi phục dữ liệu, tự động hoá đang tạm dừng'));

  return reasons.length ? { reasons } : EMPTY;
}

/** enabled = false (employee machine…) → always empty, does not call IPC. */
export function useCloudAlert(enabled: boolean): CloudAlertState {
  const [state, setState] = useState<CloudAlertState>(EMPTY);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const refresh = useCallback(() => {
    if (!enabled || !cloudApi()) return;
    void readCloudAlerts().then(next => {
      if (!alive.current) return;
      // Keep the same object when nothing changed so the left bar does not re-render.
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
