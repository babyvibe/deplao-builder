/**
 * Account picker dropdown (old API: options / activeId / onSelect), now drawn with the standard AccountSelect picker so every place
 * (CRM, old message sync, copying labels / quick messages…) uses the same style: account picture with a channel badge, name, "Kênh · SĐT" (Channel · phone), grouped
 * by channel. The channel comes from the app's account list by id. New places use AccountSelect directly.
 */
import React, { useMemo } from 'react';
import { useAccountStore } from '@/store/accounts/accountStore';
import AccountSelect, { type SelectableAccount } from './AccountSelect';
import { tr } from '../../../../shared/i18n';

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
  /** Placeholder shown when no account is selected */
  placeholder?: string;
  /**
   * Dropdown position:
   * - 'down-right' (default): opens downward, right-aligned
   * - 'up-left': opens upward, left-aligned; used in modals to avoid overflowing the screen
   */
  position?: 'down-right' | 'up-left';
  /** Trigger button takes the full width */
  fullWidth?: boolean;
}

export default function AccountSelectorDropdown({ options, activeId, onSelect, placeholder = tr('Chọn tài khoản'), position = 'down-right', fullWidth = false }: Props) {
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
