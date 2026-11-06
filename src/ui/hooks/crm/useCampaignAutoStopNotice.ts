import { useEffect, type MutableRefObject } from 'react';
import ipc from '@/lib/ipc';
import { showDesktopNotification } from '@/lib/notifications/NotificationService';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { campaignAutoStopNotice } from '../../../shared/crm/campaignAutoStop';

/**
 * Chiến dịch CRM tự dừng vì lỗi liên tiếp (CRMQueueService → crm:campaignAutoStopped; nhân viên được giao tài khoản nhận
 * qua relay): báo ở mọi màn chứ không chỉ trang CRM, vì chiến dịch chạy nền hàng giờ. Đang dùng app → thông báo nổi; cửa
 * sổ ở nền → popup hệ điều hành + nháy taskbar. Màn chiến dịch giữ nhãn "Tự dừng" + lý do tới khi bấm Tiếp tục.
 */
export function useCampaignAutoStopNotice(isWindowFocusedRef: MutableRefObject<boolean>): void {
  useEffect(() => {
    const unsub = ipc.on?.('crm:campaignAutoStopped', (data: any) => {
      if (!data?.campaignId) return;
      if (!useEmployeeStore.getState().hasPermission('crm')) return;
      const accountId = String(data.zaloId || '');
      const account = useAccountStore.getState().accounts.find(a => a.zalo_id === accountId);
      const notice = campaignAutoStopNotice({
        name: data.name, failures: data.failures, accountName: account?.full_name, strangersOnly: data.strangersOnly, resumeAt: data.resumeAt,
      });
      if (isWindowFocusedRef.current) {
        useAppStore.getState().showNotification(notice.toast, 'warning');
        return;
      }
      if (useAppStore.getState().notifSettings.desktopEnabled) showDesktopNotification(notice.title, notice.body);
      window.electronAPI?.app?.flashFrame?.(true);
    });
    return () => unsub?.();
  }, [isWindowFocusedRef]);
}
