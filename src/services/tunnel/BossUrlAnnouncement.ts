/**
 * BossUrlAnnouncement: main process, EMPLOYEE side: handles 'relay:bossUrlChanged', which the Boss sends over Socket.IO
 * (a channel authenticated with the employee's JWT) when the Boss's WAN address changes.
 *
 * - The workspace in use has exactly the OLD address → save the new address in the workspace config (the single source of truth for
 *   the URL + token in main), then HttpConnectionManager.onCredentialsChanged(), exactly like workspace:update changing bossUrl:
 *   main emits employee:credentials (the renderer re-inits REST) and reconnects to the new address, keeping the old token.
 * - The workspace uses another address (LAN…) → unchanged, only tells the renderer so it can suggest something when needed.
 * - Already using the new address (the event replayed during catch-up) → skipped.
 * Always sends 'employee:bossUrlChanged' { workspaceId, applied, … } to the renderer (TopBar), except when skipped.
 *
 * Wiring (HttpClientService.handlePushedEvent, before the FORWARD_CHANNELS branch):
 *   if (channel === BOSS_URL_CHANGED_EVENT) { applyBossUrlAnnouncement(this.workspaceId, data); return; }
 */
import Logger from '../../utils/Logger';
import WorkspaceManager from '../../utils/app/WorkspaceManager';
import EventBroadcaster from '../event/EventBroadcaster';
import {
  decideAnnouncedBossUrl,
  EMPLOYEE_BOSS_URL_CHANGED,
  parseBossUrlChangedEvent,
  type AnnouncedUrlDecision,
  type EmployeeBossUrlChangedPayload,
} from '../../shared/cloud/tunnelAddress';

export interface BossUrlAnnouncementResult {
  applied: boolean;
  decision: AnnouncedUrlDecision | 'invalid' | 'not-remote' | 'save-failed';
}

export function applyBossUrlAnnouncement(workspaceId: string, raw: unknown): BossUrlAnnouncementResult {
  const event = parseBossUrlChangedEvent(raw);
  if (!workspaceId || !event) {
    Logger.warn(`[BossUrlAnnouncement] Bỏ qua thông báo đổi địa chỉ không hợp lệ (workspace="${workspaceId || ''}")`);
    return { applied: false, decision: 'invalid' };
  }

  let wm: WorkspaceManager;
  try {
    wm = WorkspaceManager.getInstance();
  } catch (err: any) {
    Logger.warn(`[BossUrlAnnouncement] WorkspaceManager chưa sẵn sàng: ${err?.message || err}`);
    return { applied: false, decision: 'invalid' };
  }
  const ws = wm.getWorkspaceById(workspaceId);
  if (!ws || ws.type !== 'remote') return { applied: false, decision: 'not-remote' };

  const decision = decideAnnouncedBossUrl(ws.bossUrl, event);
  if (decision === 'already-current') {
    Logger.log(`[BossUrlAnnouncement] "${workspaceId}": đã dùng địa chỉ mới ${event.newUrl} — bỏ qua`);
    return { applied: false, decision };
  }

  let applied = false;
  if (decision === 'apply') {
    const res = wm.updateWorkspace(workspaceId, { bossUrl: event.newUrl });
    if (!res?.success) {
      Logger.warn(`[BossUrlAnnouncement] "${workspaceId}": không lưu được địa chỉ mới ${event.newUrl}: ${res?.error || 'unknown'}`);
      return { applied: false, decision: 'save-failed' };
    }
    applied = true;
    Logger.log(`[BossUrlAnnouncement] "${workspaceId}": BOSS đổi địa chỉ ${event.previousUrl} → ${event.newUrl} (${event.reason}) — đã lưu, kết nối lại bằng địa chỉ mới`);
    try {
      // Late require: HttpConnectionManager → HttpClientService → this module (avoids an import cycle at load time)
      require('../http/HttpConnectionManager').default.getInstance().onCredentialsChanged(workspaceId);
    } catch (err: any) {
      Logger.warn(`[BossUrlAnnouncement] "${workspaceId}": kết nối lại thất bại: ${err?.message || err}`);
    }
  } else {
    Logger.log(`[BossUrlAnnouncement] "${workspaceId}": BOSS báo địa chỉ WAN mới ${event.newUrl}; workspace đang dùng ${ws.bossUrl || '(trống)'} — giữ nguyên`);
  }

  const payload: EmployeeBossUrlChangedPayload = { ...event, workspaceId, applied };
  try {
    EventBroadcaster.sendDirect(EMPLOYEE_BOSS_URL_CHANGED, payload);
  } catch { /* window not ready yet */ }
  return { applied, decision };
}

export default applyBossUrlAnnouncement;
