/**
 * Cài đặt "Thông báo tin nhắn trong app" (store/chat/inAppNotifyStore): công tắc "Tất cả tài khoản" (áp cả tài khoản thêm
 * sau) và từng tài khoản. Dùng ở chuông thông báo trên thanh tiêu đề (bấm ⚙) và Cài đặt → Thông báo; Cài đặt → Tài khoản
 * có dòng riêng dưới mỗi tài khoản (InAppNotifyAccountLine).
 */
import React from 'react';
import { Switch } from '@/components/ui';
import { BellIcon } from '@/components/common/icons';
import { ChannelBadgeOverlay } from '@/components/common/avatars/ChannelBadge';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { useAccountStore, type AccountInfo } from '@/store/accounts/accountStore';
import { useInAppNotifyStore } from '@/store/chat/inAppNotifyStore';
import {
  IN_APP_TOAST_MAX, IN_APP_TOAST_MS, isInAppNotifyEnabled, summarizeInAppNotify, type InAppNotifyPrefs,
} from '@/lib/chat/notifications/inAppNotify';
import { getChannelLabel, resolveAccountChannel } from '../../../../configs/channels/channelConfig';

/** Dòng mô tả dưới "Tất cả tài khoản". */
export function inAppNotifySummaryText(prefs: InAppNotifyPrefs, accountIds: readonly string[]): string {
  const summary = summarizeInAppNotify(prefs, accountIds);
  const later = prefs.all ? 'bật' : 'tắt';
  if (summary.allOn) return 'Đang bật cho mọi tài khoản, cả tài khoản thêm sau';
  if (summary.allOff) return 'Đang tắt cho mọi tài khoản, cả tài khoản thêm sau';
  return `Đang bật ${summary.enabled}/${summary.total} tài khoản · tài khoản thêm sau: ${later}`;
}

/** Ảnh đại diện nhỏ của tài khoản + huy hiệu kênh (dùng cả ở Cài đặt → Tài khoản). */
export function MiniAccountAvatar({ account, size = 32 }: { account: AccountInfo; size?: 32 | 40 }) {
  const [failed, setFailed] = React.useState(false);
  const name = account.full_name || account.zalo_id;
  const box = size === 40 ? 'h-10 w-10' : 'h-8 w-8';
  return (
    <span className={`relative ${box} flex-shrink-0`}>
      {account.avatar_url && !failed ? (
        <img src={toLocalMediaUrl(account.avatar_url)} alt="" className={`${box} rounded-full object-cover`} onError={() => setFailed(true)} />
      ) : (
        <span className={`flex ${box} items-center justify-center rounded-full bg-muted text-xs font-semibold text-foreground`}>
          {(name.trim()[0] || '?').toUpperCase()}
        </span>
      )}
      <ChannelBadgeOverlay channel={resolveAccountChannel(account)} size="xs" />
    </span>
  );
}

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
          <span className="block text-[13px] font-medium text-foreground">Tất cả tài khoản</span>
          <span className="block text-[11px] leading-4 text-muted-foreground">{inAppNotifySummaryText(prefs, ids)}</span>
        </span>
        <Switch size="sm" checked={summary.allOn} onCheckedChange={setAllAccounts}
          aria-label="Thông báo tin nhắn trong app cho tất cả tài khoản" />
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
              aria-label={`Thông báo tin nhắn trong app: ${name}`} />
          </div>
        );
      })}

      {showHint && (
        <p className="px-2 pt-1.5 text-[11px] leading-relaxed text-muted-foreground">
          Hiện {IN_APP_TOAST_MS / 1000} giây, tối đa {IN_APP_TOAST_MAX} thẻ. Không hiện với hội thoại đang mở, đã tắt thông báo
          hoặc ở thư mục Khác. Đang dùng app thì thay cho popup của Windows / macOS.
        </p>
      )}
    </div>
  );
}

/** Dòng dưới mỗi tài khoản ở Cài đặt → Tài khoản. */
export function InAppNotifyAccountLine({ accountId }: { accountId: string }) {
  const on = useInAppNotifyStore((s) => isInAppNotifyEnabled(s.prefs, accountId));
  const setAccount = useInAppNotifyStore((s) => s.setAccount);
  return (
    <div className="flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5">
      <span className="flex-shrink-0 text-muted-foreground"><BellIcon className="h-4 w-4" /></span>
      <span className="flex-shrink-0 text-[13px] text-foreground">Thông báo trong app</span>
      <span className="ml-auto min-w-0 truncate text-right text-xs text-muted-foreground">
        {on ? 'Hiện tin nhắn mới ở góc trên' : 'Tắt'}
      </span>
      <Switch size="sm" checked={on} onCheckedChange={(next) => setAccount(accountId, next)}
        aria-label="Thông báo tin nhắn trong app" />
    </div>
  );
}
