/**
 * Dropdown chọn tài khoản (API cũ: options / activeId / onSelect) — nay vẽ bằng ô chọn chuẩn AccountSelect để mọi nơi
 * (CRM, đồng bộ tin cũ, sao chép nhãn / tin nhắn nhanh…) cùng một kiểu: ảnh kèm huy hiệu kênh, tên, "Kênh · SĐT", chia
 * theo kênh. Kênh lấy từ danh sách tài khoản của app theo id. Nơi mới dùng thẳng AccountSelect.
 */
import React, { useMemo } from 'react';
import { useAccountStore } from '@/store/accounts/accountStore';
import AccountSelect, { type SelectableAccount } from './AccountSelect';

export interface AccountOption {
  id: string;
  name?: string;
  phone?: string;
  avatarUrl?: string;
}

interface Props {
  options: AccountOption[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Placeholder khi chưa chọn tài khoản */
  placeholder?: string;
  /**
   * Vị trí dropdown:
   * - 'down-right' (mặc định): mở xuống, căn phải
   * - 'up-left': mở lên, căn trái - dùng trong modal để tránh tràn màn hình
   */
  position?: 'down-right' | 'up-left';
  /** Trigger button chiếm toàn bộ chiều ngang */
  fullWidth?: boolean;
}

export default function AccountSelectorDropdown({ options, activeId, onSelect, placeholder = 'Chọn tài khoản', position = 'down-right', fullWidth = false }: Props) {
  const storeAccounts = useAccountStore((s) => s.accounts);
  const accounts = useMemo<SelectableAccount[]>(() => {
    const byId = new Map(storeAccounts.map((account) => [account.zalo_id, account]));
    return options.map((option) => {
      const known = byId.get(option.id);
      return {
        zalo_id: option.id,
        full_name: option.name || known?.full_name || option.id,
        avatar_url: option.avatarUrl ?? known?.avatar_url ?? '',
        phone: option.phone ?? known?.phone,
        username: known?.username,
        channel: known?.channel,
      };
    });
  }, [options, storeAccounts]);

  if (options.length === 0) return null;

  const upLeft = position === 'up-left';
  return (
    <AccountSelect
      accounts={accounts}
      value={activeId}
      onChange={(id) => { if (id) onSelect(id); }}
      placeholder={placeholder}
      size="sm"
      align={upLeft ? 'start' : 'end'}
      side={upLeft ? 'top' : 'bottom'}
      triggerClassName={fullWidth ? 'w-full' : 'w-48'}
    />
  );
}
