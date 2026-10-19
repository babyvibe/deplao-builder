/**
 * BossUrlAnnouncement — main process, phía NHÂN VIÊN: xử lý 'relay:bossUrlChanged' Boss gửi qua Socket.IO
 * (kênh đã xác thực bằng JWT của nhân viên) khi địa chỉ WAN của Boss đổi.
 *
 * - Workspace đang dùng đúng địa chỉ CŨ → lưu địa chỉ mới vào cấu hình workspace (nguồn sự thật duy nhất cho
 *   URL + token ở main) rồi HttpConnectionManager.onCredentialsChanged() — y như workspace:update đổi bossUrl:
 *   main phát employee:credentials (renderer init lại REST) và kết nối lại bằng địa chỉ mới, giữ token cũ.
 * - Workspace dùng địa chỉ khác (LAN…) → giữ nguyên, chỉ báo renderer để gợi ý khi cần.
 * - Đã dùng địa chỉ mới (sự kiện phát lại lúc catch-up) → bỏ qua.
 * Luôn kèm 'employee:bossUrlChanged' { workspaceId, applied, … } cho renderer (TopBar), trừ trường hợp bỏ qua.
 *
 * Wiring (HttpClientService.handlePushedEvent, trước nhánh FORWARD_CHANNELS):
 *   if (channel === BOSS_URL_CHANGED_EVENT) { applyBossUrlAnnouncement(this.workspaceId, data); return; }
 */
import Logger from '../../utils/Logger';
import WorkspaceManager from '../../utils/WorkspaceManager';
import EventBroadcaster from '../event/EventBroadcaster';
import {
  decideAnnouncedBossUrl,
  EMPLOYEE_BOSS_URL_CHANGED,
  parseBossUrlChangedEvent,
  type AnnouncedUrlDecision,
  type EmployeeBossUrlChangedPayload,
} from '../../shared/tunnelAddress';

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
      // require muộn: HttpConnectionManager → HttpClientService → module này (tránh vòng import lúc nạp)
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
  } catch { /* cửa sổ chưa sẵn sàng */ }
  return { applied, decision };
}

export default applyBossUrlAnnouncement;
