import React, { useMemo, useState } from 'react';
import { ClipboardListIcon, EditIcon, UsersIcon } from '@/components/common/icons';
import AccountMultiDropdown from '@/components/common/accounts/AccountMultiDropdown';
import type { AccountInfo } from '@/store/accounts/accountStore';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';


export interface CampaignCloneOptions {
  includeContacts: boolean;
  newName: string;
  /** Accounts that get a copy (at least one). */
  targetIds: string[];
}

interface CampaignCloneModalProps {
  campaignName: string;
  totalContacts: number;
  /** Account that owns the campaign: picked by default and listed first. */
  sourceAccountId: string;
  /** Accounts of the campaign's channel that can get a copy (employees: their assigned accounts). */
  accounts: AccountInfo[];
  /** Other accounts get the recipients that have a phone number (the channel looks numbers up when sending: Zalo); else none. */
  canCopyPhoneRecipients: boolean;
  /** The campaign invites into groups: group IDs belong to each account, a copy for another account picks its own groups. */
  invitesToGroups: boolean;
  onClose: () => void;
  onConfirm: (options: CampaignCloneOptions) => Promise<void>;
}

export default function CampaignCloneModal({
  campaignName, totalContacts, sourceAccountId, accounts, canCopyPhoneRecipients, invitesToGroups, onClose, onConfirm,
}: CampaignCloneModalProps) {
  const [includeContacts, setIncludeContacts] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneName, setCloneName] = useState(tr('{{campaignName}} (bản sao)', { campaignName }));
  const [targetIds, setTargetIds] = useState<string[]>([sourceAccountId]);

  // The campaign's own account first, then the others in the usual order
  const orderedAccounts = useMemo(() => {
    const own = accounts.find(a => a.zalo_id === sourceAccountId);
    return own ? [own, ...accounts.filter(a => a.zalo_id !== sourceAccountId)] : accounts;
  }, [accounts, sourceAccountId]);
  const toOtherAccounts = targetIds.some(id => id !== sourceAccountId);

  const handleConfirm = async () => {
    if (!cloneName.trim() || targetIds.length === 0) return;
    setCloning(true);
    try {
      await onConfirm({ includeContacts, newName: cloneName.trim(), targetIds });
      onClose();
    } catch {
      // error notification handled by parent
    } finally {
      setCloning(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-card border border-input rounded-2xl w-[400px] shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-lg"><ClipboardListIcon className="w-4 h-4" /></span>
            <h3 className="font-semibold text-foreground text-sm">{tr('Nhân bản chiến dịch')}</h3>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground transition-colors">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Campaign preview */}
          <div className="bg-muted/60 rounded-xl px-4 py-3">
            <p className="text-[11px] text-muted-foreground mb-0.5">{tr('Chiến dịch gốc')}</p>
            <p className="text-sm text-foreground font-medium truncate">{campaignName}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{trx('{{totalContacts}} liên hệ', { totalContacts })}</p>
          </div>

          {/* New name input */}
          <div>
            <label className="text-xs text-muted-foreground font-medium mb-1.5 block">{tr('Tên bản sao')}</label>
            <input
              value={cloneName}
              onChange={e => setCloneName(e.target.value)}
              placeholder={tr('Nhập tên cho bản sao...')}
              className="w-full bg-muted border border-input rounded-xl px-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 transition-colors"
            />
            {!cloneName.trim() && (
              <p className="text-[11px] text-red-400 mt-1">{tr('Tên không được để trống')}</p>
            )}
          </div>

          {/* Accounts that get a copy: one draft per account (only accounts of the same channel are listed) */}
          {orderedAccounts.length > 1 && (
            <div>
              <label className="text-xs text-muted-foreground font-medium mb-1.5 block">{tr('Tài khoản nhận bản sao')}</label>
              <AccountMultiDropdown
                accounts={orderedAccounts}
                selectedIds={targetIds}
                onChange={setTargetIds}
                fullWidth
                minSelected={1}
                showOnlyAction
                searchable
                placeholder={tr('Chọn tài khoản...')}
                triggerClassName="bg-muted rounded-xl py-2.5 text-sm"
              />
            </div>
          )}

          {/* Include contacts option */}
          <div>
            <p className="text-xs text-muted-foreground font-medium mb-2">{tr('Tuỳ chọn sao chép tệp khách')}</p>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setIncludeContacts(false)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-center transition-colors ${
                  !includeContacts
                    ? 'border-blue-500 bg-blue-500/15 text-foreground'
                    : 'border-input text-muted-foreground hover:border-border-strong hover:text-foreground'
                }`}
              >
                <span className="text-xl"><EditIcon className="w-4 h-4" /></span>
                <span className="text-xs font-semibold">{tr('Chỉ clone template')}</span>
                <span className="text-[11px] leading-snug opacity-70">
                  {tr('Sao chép nội dung trừ danh sách tệp gửi.')}
                </span>
              </button>

              <button
                onClick={() => setIncludeContacts(true)}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-xl border text-center transition-colors ${
                  includeContacts
                    ? 'border-purple-500 bg-purple-500/15 text-foreground'
                    : 'border-input text-muted-foreground hover:border-border-strong hover:text-foreground'
                }`}
              >
                <span className="text-xl"><UsersIcon className="w-4 h-4" /></span>
                <span className="text-xs font-semibold">{tr('Clone giống hệt')}</span>
                <span className="text-[11px] leading-snug opacity-70">
                  {tr('Sao chép toàn bộ, cả danh sách tệp gửi.')}
                </span>
              </button>
            </div>
            {/* Recipient and group IDs belong to each account (shared/crm/campaignCopy): say what another account gets */}
            {toOtherAccounts && (includeContacts || invitesToGroups) && (
              <div className="mt-2 space-y-1 text-[11px] leading-snug text-muted-foreground">
                {includeContacts && (
                  <p>{canCopyPhoneRecipients
                    ? tr('Tài khoản khác chỉ nhận người nhận có SĐT.')
                    : tr('Tài khoản khác chỉ nhận nội dung, không kèm người nhận.')}</p>
                )}
                {invitesToGroups && <p>{tr('Tài khoản khác cần chọn lại nhóm mời.')}</p>}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex gap-2 px-5 py-4 border-t border-border">
          <button
            onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent transition-colors"
          >
            {tr('Hủy')}
          </button>
          <button
            onClick={handleConfirm}
            disabled={cloning || !cloneName.trim() || targetIds.length === 0}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40 transition-colors font-medium"
          >
            {cloning
              ? tr('Đang nhân bản...')
              : targetIds.length > 1
                ? tr('📋 Nhân bản sang {{count}} tài khoản', { count: targetIds.length })
                : tr('📋 Nhân bản')}
          </button>
        </div>
      </div>
    </div>
  );
}
