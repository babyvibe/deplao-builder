import React, { useRef, useState, useEffect, useCallback } from 'react';
import type { CRMContact } from '@/store/crmStore';
import type { ContactTypeFilter, GenderFilter, BirthdayFilter } from '@/store/crmStore';
import type { LabelData } from '@/store/appStore';
import { useAppStore } from '@/store/appStore';
import type { LocalLabelItem } from '@/components/common/LocalLabelSelector';
import ZaloLabelBadge from '../tags/ZaloLabelBadge';
import { UserProfilePopup } from '@/components/common/UserProfilePopup';
import PhoneDisplay from '@/components/common/PhoneDisplay';
import GroupAvatar from '@/components/common/GroupAvatar';


interface CRMContactListProps {
  contacts: CRMContact[];
  total: number;
  page: number;
  pageSize: number;
  loading: boolean;
  selectedIds: Set<string>;
  activeContactId: string | null;
  allLabels: LabelData[];
  filterLabelIds: number[];
  filterLocalLabelIds: number[];
  filterContactTypes: ContactTypeFilter[];
  filterGender: GenderFilter;
  filterBirthday: BirthdayFilter;
  searchText: string;
  sortBy: 'name' | 'last_message';
  sortDir: 'asc' | 'desc';
  activeAccountId: string;
  localLabels?: LocalLabelItem[];
  localLabelThreadMap?: Record<string, number[]>;
  onSelectContact: (id: string) => void;
  onActivateContact: (id: string) => void;
  onSelectAll: () => void;
  onClearAll: () => void;
  onSelectAllPages?: () => Promise<void>;
  onExportAll?: () => Promise<any[]>;
  onFilterChange: (f: any) => void;
  onPageChange: (page: number) => void;
  onMessage?: (contact: CRMContact) => void;
  onImportPhones?: () => void;
}

/** Dropdown to pick labels for filtering — supports Local + Zalo tabs */
function LabelFilterDropdown({ allLabels, filterLabelIds, filterLocalLabelIds, onChange, localLabels }: {
  allLabels: LabelData[];
  filterLabelIds: number[];
  filterLocalLabelIds: number[];
  onChange: (update: { filterLabelIds?: number[]; filterLocalLabelIds?: number[] }) => void;
  localLabels?: LocalLabelItem[];
}) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'local' | 'zalo'>('local');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const toggleLocal = (id: number) => onChange({
    filterLocalLabelIds: filterLocalLabelIds.includes(id)
      ? filterLocalLabelIds.filter(x => x !== id)
      : [...filterLocalLabelIds, id],
  });
  const toggleZalo = (id: number) => onChange({
    filterLabelIds: filterLabelIds.includes(id)
      ? filterLabelIds.filter(x => x !== id)
      : [...filterLabelIds, id],
  });

  const activeCount = filterLabelIds.length + filterLocalLabelIds.length;

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${
          activeCount > 0 ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500'
        }`}>
        🏷️ {activeCount > 0 ? `${activeCount} nhãn` : 'Nhãn'}
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-50 min-w-[180px] max-h-64 overflow-hidden flex flex-col">
          {/* Local / Zalo tabs */}
          <div className="px-2 pt-1.5 pb-1 border-b border-gray-700/60 flex-shrink-0">
            <div className="flex bg-gray-700/60 rounded-md p-0.5 gap-0.5">
              <button onClick={() => setTab('local')}
                className={`flex-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  tab === 'local' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}>💾 Local</button>
              <button onClick={() => setTab('zalo')}
                className={`flex-1 px-2 py-0.5 rounded text-[11px] font-medium transition-colors ${
                  tab === 'zalo' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'
                }`}>☁️ Zalo</button>
            </div>
          </div>
          <div className="overflow-y-auto">
            {tab === 'local' ? (
              !localLabels?.length
                ? <p className="text-xs text-gray-500 px-3 py-2">Chưa có Nhãn Local</p>
                : localLabels.map(label => (
                    <button key={`local-${label.id}`} onClick={() => toggleLocal(label.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 text-left transition-colors">
                      <span className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[11px] ${filterLocalLabelIds.includes(label.id) ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-500'}`}>
                        {filterLocalLabelIds.includes(label.id) && '✓'}
                      </span>
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium"
                        style={{ backgroundColor: label.color || '#3b82f6', color: label.text_color || '#fff' }}>
                        {label.emoji && <span className="text-[9px]">{label.emoji}</span>}
                        <span className="truncate">{label.name}</span>
                      </span>
                    </button>
                  ))
            ) : (
              !allLabels.length
                ? <p className="text-xs text-gray-500 px-3 py-2">Chưa có nhãn Zalo</p>
                : allLabels.map(label => (
                    <button key={label.id} onClick={() => toggleZalo(label.id)}
                      className="w-full flex items-center gap-2 px-3 py-2 hover:bg-gray-700 text-left transition-colors">
                      <span className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[11px] ${filterLabelIds.includes(label.id) ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-500'}`}>
                        {filterLabelIds.includes(label.id) && '✓'}
                      </span>
                      <ZaloLabelBadge label={label} size="xs" />
                    </button>
                  ))
            )}
          </div>
          {activeCount > 0 && (
            <button onClick={() => onChange({ filterLabelIds: [], filterLocalLabelIds: [] })}
              className="w-full text-xs text-gray-400 hover:text-white px-3 py-2 border-t border-gray-700 text-left flex-shrink-0">
              Xóa bộ lọc
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Multi-select dropdown for contact type filter */
function ContactTypeFilterDropdown({ filterContactTypes, onChange }: {
  filterContactTypes: ContactTypeFilter[];
  onChange: (types: ContactTypeFilter[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const toggle = (type: ContactTypeFilter) => {
    onChange(filterContactTypes.includes(type)
      ? filterContactTypes.filter(t => t !== type)
      : [...filterContactTypes, type]);
  };

  const OPTIONS: { key: ContactTypeFilter; label: string; icon: string }[] = [
    { key: 'friend', label: 'Bạn bè', icon: '🤝' },
    { key: 'non_friend', label: 'Chưa là bạn bè', icon: '👻' },
    { key: 'group', label: 'Nhóm', icon: '👥' },
    { key: 'has_phone', label: 'Có SĐT', icon: '📞' },
    { key: 'has_notes', label: 'Có ghi chú', icon: '📝' },
  ];

  const activeCount = filterContactTypes.length;
  const label = activeCount === 0
    ? 'Loại'
    : activeCount === 1
      ? OPTIONS.find(o => o.key === filterContactTypes[0])?.label ?? 'Loại'
      : `${activeCount} loại`;

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${
          activeCount > 0 ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500'
        }`}>
        🗂️ {label}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-0.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-50 min-w-[180px] overflow-hidden">
          {OPTIONS.map(opt => (
            <button key={opt.key} onClick={() => toggle(opt.key)}
              className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-700 text-left transition-colors">
              <span className={`w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[11px] ${filterContactTypes.includes(opt.key) ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-500'}`}>
                {filterContactTypes.includes(opt.key) && '✓'}
              </span>
              <span className="text-xs">{opt.icon}</span>
              <span className="text-xs text-gray-200">{opt.label}</span>
            </button>
          ))}
          {activeCount > 0 && (
            <button onClick={() => onChange([])}
              className="w-full text-xs text-gray-400 hover:text-white px-3 py-2 border-t border-gray-700 text-left">
              Xóa bộ lọc
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** Styled sort dropdown matching other filter dropdowns */
function GenderFilterDropdown({ value, onChange }: {
  value: GenderFilter;
  onChange: (v: GenderFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const OPTIONS: { key: GenderFilter; label: string; icon: string }[] = [
    { key: 'all', label: 'Tất cả', icon: '👤' },
    { key: 'male', label: 'Nam', icon: '♂️' },
    { key: 'female', label: 'Nữ', icon: '♀️' },
    { key: 'unknown', label: 'Không xác định', icon: '❓' },
  ];

  const current = OPTIONS.find(o => o.key === value);
  const isActive = value !== 'all';

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${
          isActive ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500'
        }`}>
        {isActive ? `${current?.icon} ${current?.label}` : '⚧ Giới tính'}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-0.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-50 min-w-[140px] overflow-hidden">
          {OPTIONS.map(opt => (
            <button key={opt.key} onClick={() => { onChange(opt.key); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-700 text-left transition-colors ${
                value === opt.key ? 'bg-gray-700/60' : ''
              }`}>
              <span className="text-xs">{opt.icon}</span>
              <span className="text-xs text-gray-200">{opt.label}</span>
              {value === opt.key && <span className="ml-auto text-blue-400 text-[11px]">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BirthdayFilterDropdown({ value, onChange }: {
  value: BirthdayFilter;
  onChange: (v: BirthdayFilter) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const OPTIONS: { key: BirthdayFilter; label: string; icon: string }[] = [
    { key: 'all', label: 'Tất cả', icon: '📅' },
    { key: 'today', label: 'Hôm nay', icon: '🎁' },
    { key: 'this_week', label: 'Tuần này', icon: '📆' },
    { key: 'this_month', label: 'Tháng này', icon: '🎉' },
    { key: 'has_birthday', label: 'Có ngày sinh', icon: '🎂' },
    { key: 'no_birthday', label: 'Chưa có', icon: '❌' },
  ];

  const current = OPTIONS.find(o => o.key === value);
  const isActive = value !== 'all';

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={() => setOpen(v => !v)}
        className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${
          isActive ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500'
        }`}>
        {isActive ? `${current?.icon} ${current?.label}` : '🎂 Sinh nhật'}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-0.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-50 min-w-[180px] overflow-hidden">
          {OPTIONS.map(opt => (
            <button key={opt.key} onClick={() => { onChange(opt.key); setOpen(false); }}
              className={`w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-700 text-left transition-colors ${
                value === opt.key ? 'bg-gray-700/60' : ''
              }`}>
              <span className="text-xs">{opt.icon}</span>
              <span className="text-xs text-gray-200">{opt.label}</span>
              {value === opt.key && <span className="ml-auto text-blue-400 text-[11px]">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Styled sort dropdown matching other filter dropdowns */
function SortDropdown({ sortBy, sortDir, onChange }: {
  sortBy: string; sortDir: string;
  onChange: (sortBy: string, sortDir: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const OPTIONS = [
    { key: 'name:asc', label: 'Tên A → Z', icon: '🔤' },
    { key: 'name:desc', label: 'Tên Z → A', icon: '🔤' },
    { key: 'last_message:desc', label: 'Tin nhắn gần nhất', icon: '🕐' },
  ];
  const current = `${sortBy}:${sortDir}`;
  const currentLabel = OPTIONS.find(o => o.key === current)?.label || 'Sắp xếp';

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border border-gray-600 text-gray-400 hover:border-gray-500 transition-colors">
        ↕️ {currentLabel}
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="ml-0.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-50 min-w-[180px] overflow-hidden">
          {OPTIONS.map(opt => {
            const isActive = current === opt.key;
            return (
              <button key={opt.key} onClick={() => { const [sb, sd] = opt.key.split(':'); onChange(sb, sd); setOpen(false); }}
                className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-gray-700 text-left transition-colors">
                <span className={`w-3.5 h-3.5 rounded-full border flex-shrink-0 flex items-center justify-center text-[11px] ${isActive ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-500'}`}>
                  {isActive && '●'}
                </span>
                <span className="text-xs">{opt.icon}</span>
                <span className="text-xs text-gray-200">{opt.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Actions dropdown — replaces the old Export CSV button */
function ActionsDropdown({ total, exportingCSV, onExportCSV, onImportPhones }: {
  total: number;
  exportingCSV: boolean;
  onExportCSV: () => void;
  onImportPhones?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button onClick={() => setOpen(v => !v)}
        className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-white bg-gray-700 hover:bg-gray-600 px-2.5 py-1.5 rounded-lg transition-colors border border-gray-600 hover:border-gray-500">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
        </svg>
        Thao tác
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && (
        <div className="absolute top-full right-0 mt-1 bg-gray-800 border border-gray-600 rounded-xl shadow-xl z-50 min-w-[200px] overflow-hidden py-1">
          {/* Export CSV */}
          <button
            onClick={() => { onExportCSV(); setOpen(false); }}
            disabled={total === 0 || exportingCSV}
            className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors text-left disabled:opacity-40">
            {exportingCSV ? (
              <svg className="animate-spin flex-shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
              </svg>
            ) : (
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
            )}
            <span>{exportingCSV ? 'Đang xuất...' : `Xuất CSV (${total})`}</span>
          </button>
          {/* Import phones */}
          {onImportPhones && (
            <button
              onClick={() => { onImportPhones(); setOpen(false); }}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-gray-200 hover:bg-gray-700 transition-colors text-left">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="flex-shrink-0 text-green-400">
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/>
                <line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/>
              </svg>
              <span>Thêm liên hệ theo SĐT</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function CRMContactList({
  contacts, total, page, pageSize, loading, selectedIds, activeContactId,
  allLabels, filterLabelIds, filterLocalLabelIds, filterContactTypes, filterGender, filterBirthday, searchText, sortBy, sortDir,
  activeAccountId, localLabels, localLabelThreadMap,
  onSelectContact, onActivateContact, onSelectAll, onClearAll, onSelectAllPages,
  onExportAll,
  onFilterChange, onPageChange, onMessage, onImportPhones,
}: CRMContactListProps) {
  const totalPages = Math.ceil(total / pageSize);
  const groupInfoCache = useAppStore(s => s.groupInfoCache);

  const [avatarPopup, setAvatarPopup] = useState<{ userId: string; x: number; y: number } | null>(null);
  const [selectingAllPages, setSelectingAllPages] = useState(false);
  const [exportingCSV, setExportingCSV] = useState(false);

  const fmt = (ts: number) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    if (d.getFullYear() === now.getFullYear())
      return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
    return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: '2-digit' });
  };

  function escapeCSV(val: any): string {
    const s = String(val ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r'))
      return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  const exportToCSV = useCallback(async () => {
    if (total === 0) return;
    setExportingCSV(true);
    try {
      // Fetch ALL contacts matching current filter (not just current page)
      const allContacts = onExportAll ? await onExportAll() : contacts;
      if (!allContacts.length) return;

      const headers = ['Tên hiển thị', 'Biệt danh', 'Điện thoại', 'UID', 'Loại', 'Bạn bè', 'Giới tính', 'Sinh nhật', 'Tin nhắn cuối', 'Ghi chú'];
      const rows = allContacts.map((c: any) => {
        const typeLabel = c.contact_type === 'group' ? 'Nhóm' : c.is_friend === 1 ? 'Bạn bè' : 'Chưa là bạn bè';
        const genderLabel = c.gender === 0 ? 'Nam' : c.gender === 1 ? 'Nữ' : '';
        return [
          escapeCSV(c.display_name || c.contact_id),
          escapeCSV(c.alias || ''),
          escapeCSV(c.phone || ''),
          escapeCSV(c.contact_id),
          typeLabel,
          c.is_friend === 1 ? 'Có' : 'Không',
          genderLabel,
          escapeCSV(c.birthday || ''),
          c.last_message_time ? new Date(c.last_message_time).toLocaleString('vi-VN') : '',
          c.note_count || 0,
        ].join(',');
      });
      const csv = [headers.join(','), ...rows].join('\r\n');
      const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `lien_he_${new Date().toISOString().split('T')[0]}.csv`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setExportingCSV(false);
    }
  }, [contacts, total, onExportAll]);

  const getContactLabels = (contact: CRMContact): LabelData[] => {
    const contactId = contact.contact_id;
    const isGroup = contact.contact_type === 'group';
    const prefixedId = isGroup ? `g${contactId}` : contactId;
    return allLabels.filter(l =>
      l.conversations?.includes(contactId) ||
      (isGroup && l.conversations?.includes(prefixedId))
    );
  };

  const allSelected = contacts.length > 0 && contacts.every(c => selectedIds.has(c.contact_id));

  // contacts mapped to the shape UserProfilePopup expects
  const contactsForPopup = contacts.map(c => ({
    contact_id: c.contact_id,
    display_name: c.display_name,
    alias: c.alias,
    avatar_url: c.avatar,
    phone: c.phone,
  }));

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-gray-700 flex-shrink-0">
        {/* Select-all button — chọn TOÀN BỘ tất cả trang */}
        <button
          disabled={selectingAllPages}
          onClick={async () => {
            if (selectedIds.size >= total && total > 0) {
              onClearAll();
            } else if (onSelectAllPages) {
              setSelectingAllPages(true);
              try { await onSelectAllPages(); } finally { setSelectingAllPages(false); }
            } else {
              onSelectAll();
            }
          }}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap flex-shrink-0 transition-colors border disabled:opacity-50
            ${selectedIds.size >= total && total > 0
              ? 'bg-blue-600/20 border-blue-500/50 text-blue-300 hover:bg-blue-600/30'
              : 'bg-blue-600 border-blue-600 text-white hover:bg-blue-700'}`}>
          {selectedIds.size >= total && total > 0 ? (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              Bỏ chọn tất cả
            </>
          ) : selectingAllPages ? (
            <>
              <svg className="animate-spin" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
              Đang chọn...
            </>
          ) : (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><polyline points="9 11 12 14 22 4"/></svg>
              Chọn tất cả {total > 0 ? `(${total})` : ''}
            </>
          )}
        </button>

        {/* Label dropdown filter (Local + Zalo) */}
        <LabelFilterDropdown
          allLabels={allLabels}
          filterLabelIds={filterLabelIds}
          filterLocalLabelIds={filterLocalLabelIds}
          onChange={update => onFilterChange({ ...update, page: 0 })}
          localLabels={localLabels}
        />

        {/* Contact type multi-select filter */}
        <ContactTypeFilterDropdown
          filterContactTypes={filterContactTypes}
          onChange={types => onFilterChange({ filterContactTypes: types, page: 0 })}
        />

        {/* Gender filter */}
        <GenderFilterDropdown
          value={filterGender}
          onChange={v => onFilterChange({ filterGender: v, page: 0 })}
        />

        {/* Birthday filter */}
        <BirthdayFilterDropdown
          value={filterBirthday}
          onChange={v => onFilterChange({ filterBirthday: v, page: 0 })}
        />

        {/* Sort dropdown (styled) */}
        <SortDropdown sortBy={sortBy} sortDir={sortDir} onChange={(sb, sd) => onFilterChange({ sortBy: sb, sortDir: sd, page: 0 })} />


        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <svg width="13" height="13" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none"
               viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input value={searchText} onChange={e => onFilterChange({ searchText: e.target.value, page: 0 })}
                 placeholder="Tên, SĐT, UID..."
                 className="w-full bg-gray-800 border border-gray-600 rounded-lg pl-7 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors" />
        </div>

        <div className="flex-1"></div>

        {/* Actions dropdown (Export CSV + Import SĐT) */}
        <ActionsDropdown
          total={total}
          exportingCSV={exportingCSV}
          onExportCSV={exportToCSV}
          onImportPhones={onImportPhones}
        />
      </div>

      {/* Table header */}
      <div className="flex items-center px-4 py-2 border-b border-gray-700 bg-gray-800/50 text-xs text-gray-500 flex-shrink-0">
        {/* Per-page select button */}
        <button onClick={allSelected ? onClearAll : onSelectAll}
          className={`flex items-center gap-1 mr-3 px-2 py-0.5 rounded-md text-[11px] font-medium whitespace-nowrap flex-shrink-0 transition-colors border
            ${allSelected
              ? 'bg-blue-600/20 border-blue-500/50 text-blue-300 hover:bg-blue-600/30'
              : 'border-gray-600 text-gray-500 hover:border-gray-400 hover:text-gray-300'}`}>
          {allSelected ? (
            <>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
              Bỏ chọn ({contacts.length})
            </>
          ) : (
            <>
              <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              Trang này ({contacts.length})
            </>
          )}
        </button>
        <span className="w-8 flex-shrink-0" />
        <span className="flex-1 ml-2">Tên</span>
        <span className="w-16 flex-shrink-0 text-center">Giới tính</span>
        <span className="w-24 flex-shrink-0 text-center">Sinh nhật</span>
        <span className="w-28 flex-shrink-0 ">Điện thoại</span>
        <span className="w-20 flex-shrink-0 text-right">Tin nhắn</span>
      </div>


      {/* Rows */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex flex-col gap-2 p-4">
            {[...Array(8)].map((_, i) => <div key={i} className="h-10 bg-gray-700/50 rounded-lg animate-pulse" />)}
          </div>
        ) : contacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-gray-500">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-40">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/>
            </svg>
            <p className="text-sm">Không có liên hệ nào</p>
          </div>
        ) : (
          contacts.map(contact => {
            const name = contact.alias || contact.display_name || contact.contact_id;
            const isSelected = selectedIds.has(contact.contact_id);
            const isActive = activeContactId === contact.contact_id;
            const contactLabels = getContactLabels(contact);
            return (
              <div key={contact.contact_id}
                onClick={() => onActivateContact(contact.contact_id)}
                className={`flex items-center px-4 py-2.5 border-b border-gray-700/50 cursor-pointer transition-colors group ${isActive ? 'bg-blue-600/15' : 'hover:bg-gray-700/40'}`}>
                {/* Styled checkbox */}
                <div
                  onClick={e => { e.stopPropagation(); onSelectContact(contact.contact_id); }}
                  className={`w-4 h-4 rounded flex items-center justify-center flex-shrink-0 border transition-colors mr-3 cursor-pointer
                    ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-600 bg-gray-800 group-hover:border-gray-400'}`}>
                  {isSelected && (
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                      <polyline points="20 6 9 17 4 12"/>
                    </svg>
                  )}
                </div>
                {/* Avatar — click opens UserProfilePopup */}
                <div className="w-8 h-8 flex-shrink-0 rounded-full overflow-hidden relative group/av cursor-pointer"
                  onClick={e => {
                    e.stopPropagation();
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setAvatarPopup({ userId: contact.contact_id, x: rect.right + 8, y: rect.top });
                  }}>
                  {contact.contact_type === 'group' ? (
                    <GroupAvatar
                      avatarUrl={contact.avatar}
                      groupInfo={(groupInfoCache[activeAccountId] || {})[contact.contact_id]}
                      name={name}
                      size="xs"
                    />
                  ) : contact.avatar
                    ? <img src={contact.avatar} alt="" className="w-full h-full object-cover" />
                    : <div className="w-full h-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
                        {(name || 'U').charAt(0).toUpperCase()}
                      </div>}
                  {/* hover overlay */}
                  <div className="absolute inset-0 bg-black/50 rounded-full flex items-center justify-center opacity-0 group-hover/av:opacity-100 transition-opacity">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                      <circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/>
                    </svg>
                  </div>
                </div>
                {/* Name + Labels underneath */}
                <div className="flex-1 ml-2 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm text-gray-200 truncate font-medium">{name}</span>
                    {contact.contact_type === 'group'
                      ? <span className="text-[9px] text-purple-400 flex-shrink-0 bg-purple-400/10 px-1 rounded">nhóm</span>
                      : contact.is_friend === 1 && <span className="text-[9px] text-green-500 flex-shrink-0">●</span>}
                    {contact.note_count > 0 && <span className="text-[12px] text-yellow-500 flex-shrink-0">📝</span>}
                  </div>
                  {contact.alias && contact.alias !== contact.display_name &&
                    <p className="text-[11px] text-gray-500 truncate">{contact.display_name}</p>}
                  {/* Labels (Local + Zalo) under name */}
                  {(() => {
                    const threadLIds = localLabelThreadMap?.[contact.contact_id] || [];
                    const hasLabels = threadLIds.length > 0 || contactLabels.length > 0;
                    if (!hasLabels) return null;
                    return (
                      <div className="flex gap-1 flex-wrap mt-0.5">
                        {threadLIds.slice(0, 3).map(lid => {
                          const ll = localLabels?.find(l => l.id === lid);
                          if (!ll) return null;
                          return (
                            <span key={`ll-${lid}`}
                              className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[9px] font-medium max-w-[80px]"
                              style={{ backgroundColor: ll.color || '#3b82f6', color: ll.text_color || '#fff' }}>
                              {ll.emoji && <span className="text-[8px]">{ll.emoji}</span>}
                              <span className="truncate">{ll.name}</span>
                            </span>
                          );
                        })}
                        {contactLabels.slice(0, 3).map(l => <ZaloLabelBadge key={l.id} label={l} size="xs" />)}
                        {(threadLIds.length + contactLabels.length) > 3 && (
                          <span className="text-[10px] text-gray-500">+{threadLIds.length + contactLabels.length - 3}</span>
                        )}
                      </div>
                    );
                  })()}
                </div>
                {/* Gender column */}
                <span className="w-16 flex-shrink-0 hidden lg:block text-center">
                  {contact.gender === 0 && <span className="text-[11px] text-blue-400">♂ Nam</span>}
                  {contact.gender === 1 && <span className="text-[11px] text-pink-400">♀ Nữ</span>}
                </span>
                {/* Birthday column */}
                <span className="w-24 flex-shrink-0 hidden lg:block text-center text-[11px] text-gray-500">
                  {contact.birthday || ''}
                </span>
                {/* Phone */}
                <span className="w-28 flex-shrink-0 hidden md:block">
                  <PhoneDisplay phone={contact.phone} className="text-xs text-gray-500" />
                </span>
                {/* Message button + last message time */}
                <div className="w-20 flex-shrink-0 flex items-center justify-end gap-1">
                  {onMessage && (
                    <button
                      onClick={e => { e.stopPropagation(); onMessage(contact); }}
                      title="Nhắn tin"
                      className="p-1 rounded-md text-gray-600 hover:text-blue-400 hover:bg-blue-500/10 transition-colors opacity-0 group-hover:opacity-100">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                      </svg>
                    </button>
                  )}
                  <span className="text-[11px] text-gray-500">{fmt(contact.last_message_time)}</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 px-4 py-2.5 border-t border-gray-700 flex-shrink-0">
          <button disabled={page === 0} onClick={() => onPageChange(page - 1)}
            className="px-2.5 py-1 rounded-lg bg-gray-700 text-xs text-gray-300 hover:bg-gray-600 disabled:opacity-40">‹</button>
          <span className="text-xs text-gray-400">{page + 1} / {totalPages}</span>
          <button disabled={page >= totalPages - 1} onClick={() => onPageChange(page + 1)}
            className="px-2.5 py-1 rounded-lg bg-gray-700 text-xs text-gray-300 hover:bg-gray-600 disabled:opacity-40">›</button>
        </div>
      )}

      {/* UserProfilePopup */}
      {avatarPopup && (
        <UserProfilePopup
          userId={avatarPopup.userId}
          anchorX={avatarPopup.x}
          anchorY={avatarPopup.y}
          contacts={contactsForPopup}
          activeAccountId={activeAccountId}
          activeThreadId={null}
          onClose={() => setAvatarPopup(null)}
        />
      )}
    </div>
  );
}
