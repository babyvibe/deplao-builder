import { useCallback } from 'react';
import DataAccessor, { isReadFailure, readFailureMessage } from '@/lib/data/DataAccessor';
import { hasHiddenScanConsent } from '@/lib/crm/hiddenScanConsent';
import { useAppStore } from '@/store/app/appStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { ensureHiddenScanConsent } from '@/components/crm/groups/HiddenScanConsentDialog';
import { tr } from '../../../shared/i18n';

interface UseGroupMemberSyncOptions {
  accountId: string;
  groupId: string;
  onMembersSynced?: () => void;
}

/** synced = scanned + saved; declined = the user refused; skipped = not agreed and not asked; failed = error. */
export type GroupMemberSyncOutcome = 'synced' | 'declined' | 'skipped' | 'failed';

interface UseGroupMemberSyncResult {
  /**
   * Fully scans the group members via the Deplao server (sends the Zalo cookie, needs the user's consent).
   * `askConsent`: if no consent yet, asks with a dialog (the button the user clicks to scan); false = silently skip (e.g. the reload button
   * of the members panel: only scans more if consent was given earlier).
   */
  syncMembers: (options?: { askConsent?: boolean }) => Promise<GroupMemberSyncOutcome>;
}

/**
 * Synchronizes Zalo group members through the Deplao scan endpoint (POST deplaoapp.com/api/scan/group).
 *
 * PRIVACY: the scan sends the account's Zalo session (cookie + IMEI) to the Deplao server, so it only runs after the
 * user opted in (default OFF since 26.11.0): `ensureHiddenScanConsent()` asks first, `scanGroupViaBackend` re-checks
 * and refuses without consent. See lib/crm/hiddenScanConsent.ts and lib/crm/backendService.ts.
 *
 * The hidden-member scan is available to every Zalo account. Do not add plan,
 * expiry, or local Premium-cache checks here: this hook is used by both CRM
 * Groups and the conversation detail panel.
 */
export function useGroupMemberSync({
  accountId,
  groupId,
  onMembersSynced,
}: UseGroupMemberSyncOptions): UseGroupMemberSyncResult {
  const syncMembers = useCallback(async (options: { askConsent?: boolean } = {}): Promise<GroupMemberSyncOutcome> => {
    if (!accountId || !groupId) return 'failed';

    // The correct account of the group (not the account selected elsewhere): the cookie sent must be that of this same account
    const accountState = useAccountStore.getState();
    const account = accountState.accounts.find((item) => item.zalo_id === accountId) ?? accountState.getActiveAccount();
    if (!account || account.zalo_id !== accountId) return 'failed';

    // Sending the Zalo cookie to the server → consent is required first
    if (!hasHiddenScanConsent()) {
      if (!options.askConsent) return 'skipped';
      const agreed = await ensureHiddenScanConsent({ accountName: account.full_name || account.zalo_id });
      if (!agreed) return 'declined';
    }

    const { scanGroupViaBackend } = await import('@/lib/crm/backendService');
    const result = await scanGroupViaBackend({
      pageId: accountId,
      cookie: account.cookies,
      imei: account.imei,
      groupId,
    });

    if (!result?.success) {
      console.warn('[useGroupMemberSync] scan failed:', result?.error || 'Unknown error');
      if (options.askConsent && result?.error) {
        useAppStore.getState().showNotification(tr('Không quét được thành viên: {{error}}', { error: result.error }), 'error');
      }
      return 'failed';
    }

    // The scan API returns the complete member set, but group roles are owned
    // by the local group-info sync. Keep a known owner/admin role when a scan
    // response does not include it.
    const existing = await DataAccessor.getGroupMembers({ zaloId: accountId, groupId });
    // Cannot read the current roles (employee: connection to BOSS lost) → do not write: saving now would demote the group leaders / deputies
    // to regular members
    if (isReadFailure(existing)) {
      console.warn('[useGroupMemberSync] skip save — cannot read existing members:', readFailureMessage(existing));
      useAppStore.getState().showNotification(tr('Chưa lưu thành viên nhóm: không đọc được danh sách hiện có (mất kết nối). Thử lại sau.'), 'warning');
      return 'failed';
    }
    const existingRoles = new Map(
      (existing?.members || []).map((member: any) => [
        String(member.member_id || member.memberId || member.user_id || member.userId || ''),
        Number(member.role || 0),
      ]),
    );

    await DataAccessor.saveGroupMembers({
      zaloId: accountId,
      groupId,
      members: (result.members || []).map((member: any) => {
        const memberId = String(member.userId || member.id || '');
        return {
          memberId,
          displayName: member.displayName || member.zaloName || memberId,
          avatar: member.avatar || '',
          role: Number(member.role ?? existingRoles.get(memberId) ?? 0),
        };
      }),
    });
    onMembersSynced?.();
    return 'synced';
  }, [accountId, groupId, onMembersSynced]);

  return { syncMembers };
}
