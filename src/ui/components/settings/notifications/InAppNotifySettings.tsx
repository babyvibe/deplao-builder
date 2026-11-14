/**
 * Setting "Thông báo tin nhắn trong app" (in-app message notifications, store/chat/inAppNotifyStore): the "Tất cả tài khoản" toggle (also applies to accounts added
 * later) and one toggle per account. Used by the notification bell in the title bar (click ⚙) and Settings → Notifications; Settings → Accounts
 * has its own line under each account (InAppNotifyAccountLine).
 */
import React from 'react';
import { Switch } from '@/components/ui';
import { BellIcon } from '@/components/common/icons';
import { AccountAvatar as MiniAccountAvatar } from '@/components/common/accounts/AccountAvatar';
import { useAccountStore, type AccountInfo } from '@/store/accounts/accountStore';
import { useInAppNotifyStore } from '@/store/chat/inAppNotifyStore';
import {
  IN_APP_TOAST_MAX, IN_APP_TOAST_MS, isInAppNotifyEnabled, summarizeInAppNotify, type InAppNotifyPrefs,
} from '@/lib/chat/notifications/inAppNotify';
import { getChannelLabel, resolveAccountChannel } from '../../../../configs/channels/channelConfig';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

/** Description line under "Tất cả tài khoản". */
export function inAppNotifySummaryText(prefs: InAppNotifyPrefs, accountIds: readonly string[]): string {
  const summary = summarizeInAppNotify(prefs, accountIds);
  const later = prefs.all ? tr('bật') : tr('tắt');
  if (summary.allOn) return tr('Đang bật cho mọi tài khoản, cả tài khoản thêm sau');
  if (summary.allOff) return tr('Đang tắt cho mọi tài khoản, cả tài khoản thêm sau');
  return tr('Đang bật {{enabled}}/{{total}} tài khoản · tài khoản thêm sau: {{later}}', { enabled: summary.enabled, total: summary.total, later });
}

/** Account avatar + channel badge: shared from common/accounts/AccountAvatar (old name kept for the places that still import it). */
export { MiniAccountAvatar };

export default function InAppNotifySettings({ showHint = true }: { showHint?: boolean }) {
  const accounts = useAccountStore((s) => s.accounts);
  const prefs = useInAppNotifyStore((s) => s.prefs);
  const ids = accounts.map((account) => account.zalo_id);
  const summary = summarizeInAppNotify(prefs, ids);
  const { setAllAccounts, setAccount } = useInAppNotifyStore.getState();

  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-3 rounded-lg px-2 py-2">
        <span className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
          <BellIcon className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-foreground">{tr('Tất cả tài khoản')}</span>
          <span className="block text-[11px] leading-4 text-muted-foreground">{inAppNotifySummaryText(prefs, ids)}</span>
        </span>
        <Switch size="sm" checked={summary.allOn} onCheckedChange={setAllAccounts}
          aria-label={tr('Thông báo tin nhắn trong app cho tất cả tài khoản')} />
      </div>

      {accounts.length > 0 && <div className="mx-2 border-t border-border/60" />}

      {accounts.map((account) => {
        const name = account.full_name || account.display_name || account.zalo_id;
        return (
          <div key={account.zalo_id} className="flex items-center gap-3 rounded-lg px-2 py-1.5">
            <MiniAccountAvatar account={account} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] text-foreground">{name}</span>
              <span className="block text-[11px] leading-4 text-muted-foreground">{getChannelLabel(resolveAccountChannel(account))}</span>
            </span>
            <Switch size="sm" checked={isInAppNotifyEnabled(prefs, account.zalo_id)}
              onCheckedChange={(on) => setAccount(account.zalo_id, on)}
              aria-label={tr('Thông báo tin nhắn trong app: {{name}}', { name })} />
          </div>
        );
      })}

      {showHint && (
        <p className="px-2 pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          {trx('Hiện {{v1}} giây, tối đa {{IN_APP_TOAST_MAX}} thẻ. Không hiện với hội thoại đang mở, đã tắt thông báo hoặc ở thư mục Khác. Đang dùng app thì thay cho popup của Windows / macOS.', { v1: IN_APP_TOAST_MS / 1000, IN_APP_TOAST_MAX })}
        </p>
      )}
    </div>
  );
}

/** Line under each account in Settings → Accounts. */
export function InAppNotifyAccountLine({ accountId }: { accountId: string }) {
  const on = useInAppNotifyStore((s) => isInAppNotifyEnabled(s.prefs, accountId));
  const setAccount = useInAppNotifyStore((s) => s.setAccount);
  return (
    <div className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5">
      <span className="flex-shrink-0 text-muted-foreground"><BellIcon className="h-4 w-4" /></span>
      <span className="flex-shrink-0 text-[13px] text-foreground">{tr('Thông báo trong app')}</span>
      <span className="ml-auto min-w-0 truncate text-right text-xs text-muted-foreground">
        {on ? tr('Hiện tin nhắn mới ở góc trên') : tr('Tắt')}
      </span>
      <Switch size="sm" checked={on} onCheckedChange={(next) => setAccount(accountId, next)}
        aria-label={tr('Thông báo tin nhắn trong app')} />
    </div>
  );
}
