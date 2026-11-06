/**
 * Ảnh đại diện tài khoản chat dùng chung (Cài đặt, ô chọn tài khoản, Nhân viên, Proxy…): ảnh tài khoản, không có ảnh thì
 * chữ cái đầu trên nền trung tính (không gradient), góc dưới có huy hiệu kênh. Cỡ 20 (xếp chồng, nút ô chọn) không có
 * huy hiệu; `className` cho viền khi xếp chồng.
 */
import React from 'react';
import { ChannelBadgeOverlay } from '@/components/common/avatars/ChannelBadge';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import type { AccountInfo } from '@/store/accounts/accountStore';
import { resolveAccountChannel } from '../../../../configs/channels/channelConfig';

export type AccountAvatarSize = 20 | 32 | 40;

export function AccountAvatar({ account, size = 32, className }: {
  account: Pick<AccountInfo, 'zalo_id' | 'full_name' | 'avatar_url' | 'channel'>;
  size?: AccountAvatarSize;
  className?: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const name = account.full_name || account.zalo_id;
  const box = size === 40 ? 'h-10 w-10' : size === 20 ? 'h-5 w-5' : 'h-8 w-8';
  return (
    <span className={`relative ${box} flex-shrink-0 rounded-full${className ? ` ${className}` : ''}`}>
      {account.avatar_url && !failed ? (
        <img src={toLocalMediaUrl(account.avatar_url)} alt="" className={`${box} rounded-full object-cover`} onError={() => setFailed(true)} />
      ) : (
        <span className={`flex ${box} items-center justify-center rounded-full bg-muted ${size === 20 ? 'text-[9px]' : 'text-xs'} font-semibold text-foreground`}>
          {(name.trim()[0] || '?').toUpperCase()}
        </span>
      )}
      {size !== 20 && <ChannelBadgeOverlay channel={resolveAccountChannel(account)} size="xs" />}
    </span>
  );
}
