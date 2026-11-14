import { useEffect, type MutableRefObject } from 'react';
import ipc from '@/lib/ipc';
import { showDesktopNotification } from '@/lib/notifications/NotificationService';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore } from '@/store/app/appStore';
import { useEmployeeStore } from '@/store/employee/employeeStore';
import { campaignAutoStopNotice } from '../../../shared/crm/campaignAutoStop';

/**
 * The CRM campaign stops by itself after consecutive errors (CRMQueueService → crm:campaignAutoStopped; an employee assigned the account receives it
 * via relay): reported on every screen, not only the CRM page, because the campaign runs in the background for hours. App in use → in-app notification; window
 * in the background → OS popup + taskbar flash. The campaign screen keeps the "Tự dừng" (auto-stopped) label and the reason until Resume is clicked.
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
