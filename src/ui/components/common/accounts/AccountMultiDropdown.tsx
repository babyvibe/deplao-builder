/**
 * AccountMultiDropdown - dropdown to pick several accounts with checkboxes.
 * Shared by: the header filter (ConversationSettings, Reports) + the modal (LabelModal, LocalMsgModal).
 */
import React, { useState, useEffect, useRef } from 'react';
import { AccountInfo } from '@/store/accounts/accountStore';
import { matchAccountSearch } from '@/lib/accounts/accountSearch';
import { cn } from '@/lib/cn';
import { AccountAvatar } from './AccountAvatar';
import { tr } from '../../../../shared/i18n';

/** A search box shows above the list from this many accounts (searchable). */
const SEARCH_MIN_ACCOUNTS = 6;

interface Props {
  accounts: AccountInfo[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  /** Opens below (default) or above */
  dropPosition?: 'down' | 'up';
  /** takes the full width of the container */
  fullWidth?: boolean;
  /** placeholder text when nothing is selected yet */
  placeholder?: string;
  /** Label of the select-all row (default "Chọn tất cả" (Select all)) */
  selectAllLabel?: string;
  /** Minimum number of accounts that must stay selected (default 0 = can clear all); unselecting below this level is ignored */
  minSelected?: number;
  /** "Chỉ chọn" (Only select) button when hovering a row: selects only that account */
  showOnlyAction?: boolean;
  /** Search box (name, @username, UID, phone) when there are many accounts; "Chọn tất cả" then acts on the matches */
  searchable?: boolean;
  /** Extra classes for the trigger button (e.g. the taller field of a form) */
  triggerClassName?: string;
}

/** Shared account avatar (AccountAvatar): sm = 20px stacked on the button, md = 32px with the channel badge in the list. */
function AvatarThumb({ acc, size = 'sm' }: { acc: AccountInfo; size?: 'sm' | 'md' }) {
  return <AccountAvatar account={acc} size={size === 'sm' ? 20 : 32} className={size === 'sm' ? 'ring-2 ring-card' : undefined} />;
}

export default function AccountMultiDropdown({
  accounts,
  selectedIds,
  onChange,
  dropPosition = 'down',
  fullWidth = false,
  placeholder = tr('Chọn tài khoản...'),
  selectAllLabel = tr('Chọn tất cả'),
  minSelected = 0,
  showOnlyAction = false,
  searchable = false,
  triggerClassName,
}: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // A closed list opens again on the full list
  useEffect(() => { if (!open) setQuery(''); }, [open]);

  const showSearch = searchable && accounts.length >= SEARCH_MIN_ACCOUNTS;
  const visible = showSearch && query.trim() ? accounts.filter(a => matchAccountSearch(a, query)) : accounts;

  const toggleOne = (id: string) => {
    const s = new Set(selectedIds);
    if (s.has(id)) {
      if (s.size <= minSelected) return; // keep at least minSelected accounts
      s.delete(id);
    } else {
      s.add(id);
    }
    onChange(Array.from(s));
  };

  // Select all / clear all acts on the rows shown (the search matches, or every account)
  const allChecked = visible.length > 0 && visible.every(a => selectedIds.includes(a.zalo_id));
  const someChecked = !allChecked && visible.some(a => selectedIds.includes(a.zalo_id));

  const toggleAll = () => {
    // While searching, the accounts picked outside the matches stay picked
    const filtering = visible !== accounts;
    if (allChecked) {
      const shown = new Set(visible.map(a => a.zalo_id));
      const rest = filtering ? selectedIds.filter(id => !shown.has(id)) : [];
      if (rest.length < minSelected) return; // cannot clear everything: narrow it down row by row or with "Chỉ chọn" (Only select)
      onChange(rest);
    } else {
      onChange(filtering ? [...new Set([...selectedIds, ...visible.map(a => a.zalo_id)])] : accounts.map(a => a.zalo_id));
    }
  };

  // Trigger label
  const labelText =
    selectedIds.length === 0
      ? placeholder
      : selectedIds.length === accounts.length
        ? tr('Tất cả tài khoản')
        : selectedIds.length === 1
          ? (accounts.find(a => a.zalo_id === selectedIds[0])?.full_name || selectedIds[0])
          : tr('{{count}} tài khoản', { count: selectedIds.length });

  if (accounts.length === 0) return null;

  const panelClass = dropPosition === 'up'
    ? 'absolute bottom-full left-0 mb-1.5'
    : 'absolute top-full left-0 mt-1.5';

  return (
    <div ref={ref} className={`relative ${fullWidth ? 'w-full' : ''}`}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className={cn('flex items-center gap-2 px-3 py-1.5 rounded-lg border border-input hover:border-border-strong bg-card text-xs text-foreground transition-colors', fullWidth ? 'w-full' : 'min-w-[160px]', triggerClassName)}
      >
        {/* Avatar stack */}
        <div className="flex -space-x-1 shrink-0">
          {selectedIds.slice(0, 3).map(id => {
            const acc = accounts.find(a => a.zalo_id === id);
            if (!acc) return null;
            return <AvatarThumb key={id} acc={acc} size="sm" />;
          })}
          {selectedIds.length === 0 && (
            <div className="w-5 h-5 rounded-full border border-dashed border-border-strong bg-muted flex items-center justify-center shrink-0">
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-muted-foreground">
                <circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
              </svg>
            </div>
          )}
        </div>
        <span className={`truncate ${fullWidth ? 'flex-1 text-left' : 'max-w-[130px]'} ${selectedIds.length === 0 ? 'text-muted-foreground' : 'text-foreground'}`}>
          {labelText}
        </span>
        <span className="flex-1"></span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
          className={`text-muted-foreground flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className={`${panelClass} bg-card border border-border rounded-xl shadow-2xl z-[60] overflow-hidden ${fullWidth ? 'w-full' : 'w-[260px]'}`}>
          {showSearch && (
            <div className="px-2 pt-2 pb-1.5 border-b border-border/60">
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape' && query) { e.stopPropagation(); setQuery(''); } }}
                placeholder={tr('Tìm tên, SĐT, UID...')}
                className="w-full bg-muted border border-input rounded-lg px-2.5 py-1.5 text-xs text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>
          )}
          {/* Select All row */}
          <button
            type="button"
            onClick={toggleAll}
            className={`w-full flex items-center gap-2.5 px-3 py-2.5 border-b border-border/60 hover:bg-muted transition-colors text-left ${allChecked ? 'bg-blue-500/10' : ''}`}
          >
            {/* Custom checkbox */}
            <span className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${
              allChecked
                ? 'bg-blue-600 border-blue-600'
                : someChecked
                  ? 'bg-blue-600/40 border-blue-500'
                  : 'border-border-strong bg-muted'
            }`}>
              {allChecked && (
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
              )}
              {someChecked && (
                <span className="w-2 h-0.5 bg-white rounded-full block"/>
              )}
            </span>
            <span className="text-xs font-semibold text-foreground">{selectAllLabel}</span>
            <span className="ml-auto text-[11px] text-muted-foreground">{selectedIds.length}/{accounts.length}</span>
          </button>

          {/* Account rows */}
          <div className="max-h-[220px] overflow-y-auto">
            {visible.length === 0 && (
              <p className="px-3 py-3 text-xs text-muted-foreground">{tr('Không có tài khoản nào khớp')}</p>
            )}
            {visible.map(acc => {
              const checked = selectedIds.includes(acc.zalo_id);
              const locked = checked && selectedIds.length <= minSelected;
              return (
                <div key={acc.zalo_id} className="relative group">
                  <button
                    type="button"
                    onClick={() => toggleOne(acc.zalo_id)}
                    title={locked ? tr('Cần chọn ít nhất {{minSelected}} tài khoản', { minSelected }) : undefined}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 hover:bg-muted transition-colors text-left ${checked ? 'bg-blue-500/10' : ''}`}
                  >
                    {/* Custom checkbox */}
                    <span className={`w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 transition-colors ${checked ? 'bg-blue-600 border-blue-600' : 'border-border-strong bg-muted'}`}>
                      {checked && (
                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                      )}
                    </span>
                    <AvatarThumb acc={acc} size="md" />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-foreground truncate leading-tight">{acc.full_name || acc.zalo_id}</p>
                      {acc.phone && <p className="text-[11px] text-muted-foreground truncate">{acc.phone}</p>}
                    </div>
                  </button>
                  {showOnlyAction && !(checked && selectedIds.length === 1) && (
                    <button
                      type="button"
                      onClick={() => onChange([acc.zalo_id])}
                      className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md border border-border bg-card px-2 py-0.5 text-[11px] font-medium text-primary opacity-0 transition-opacity hover:bg-accent focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      {tr('Chỉ chọn')}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

