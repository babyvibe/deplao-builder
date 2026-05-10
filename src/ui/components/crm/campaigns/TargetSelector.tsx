import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { LabelData } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import ipc from '@/lib/ipc';
import ZaloLabelBadge from '../tags/ZaloLabelBadge';
import { formatPhone } from '@/utils/phoneUtils';

export interface LocalLabelItem {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  emoji?: string;
}

interface TargetSelectorProps {
  zaloId: string;
  allLabels: LabelData[];
  localLabels?: LocalLabelItem[];
  localLabelThreadMap?: Record<string, number[]>;
  existingContactIds: Set<string>;
  onConfirm: (contacts: any[]) => void;
  onClose: () => void;
}

type SelectMode = 'manual' | 'by_label' | 'friends_only' | 'groups_only' | 'by_phone';

/** Normalize a phone string: remove spaces/dashes, convert +84/84 prefix → 0 */
function normalizePhone(raw: string): string {
  let s = raw.replace(/[\s\-().]/g, '');
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (s.startsWith('84') && s.length >= 11) s = '0' + s.slice(2);
  return s;
}


export default function TargetSelector({ zaloId, allLabels, localLabels, localLabelThreadMap, existingContactIds, onConfirm, onClose }: TargetSelectorProps) {
  const [mode, setMode] = useState<SelectMode>('manual');
  const [selectedZaloLabelIds, setSelectedZaloLabelIds] = useState<number[]>([]);
  const [selectedLocalLabelIds, setSelectedLocalLabelIds] = useState<number[]>([]);
  const [manualSelected, setManualSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [allContacts, setAllContacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // ── Phone tab state ──
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneList, setPhoneList] = useState<string[]>([]);
  const [phoneResolving, setPhoneResolving] = useState(false);
  const [phoneResolved, setPhoneResolved] = useState<Map<string, { uid: string; name: string; avatar?: string } | null>>(new Map());

  // Label section scroll ref
  const labelScrollRef = useRef<HTMLDivElement>(null);
  const [labelTab, setLabelTab] = useState<'local' | 'zalo'>('local');

  // ── Load local labels directly (self-sufficient, not relying on parent props) ──
  const [fetchedLocalLabels, setFetchedLocalLabels] = useState<LocalLabelItem[]>([]);
  const [fetchedThreadMap, setFetchedThreadMap] = useState<Record<string, number[]>>({});

  useEffect(() => {
    if (!zaloId) return;
    Promise.all([
      ipc.db?.getLocalLabels({ zaloId }),
      ipc.db?.getLocalLabelThreads({ zaloId }),
    ]).then(([labelsRes, threadsRes]) => {
      // Filter only active labels (is_active !== 0)
      const labels = (labelsRes?.labels || []).filter((l: any) => (l.is_active ?? 1) !== 0);
      setFetchedLocalLabels(labels);
      const map: Record<string, number[]> = {};
      (threadsRes?.threads || []).forEach((row: any) => {
        if (!map[row.thread_id]) map[row.thread_id] = [];
        map[row.thread_id].push(Number(row.label_id));
      });
      setFetchedThreadMap(map);
    }).catch(() => {});
  }, [zaloId]);

  // Use fetched labels if prop is empty, otherwise prefer props (merged)
  const effectiveLocalLabels = useMemo(() => {
    const fromProp = (localLabels || []).filter((l: any) => (l.is_active ?? 1) !== 0);
    if (fromProp.length > 0) return fromProp;
    return fetchedLocalLabels;
  }, [localLabels, fetchedLocalLabels]);

  const effectiveThreadMap = useMemo(() => {
    const propMap = localLabelThreadMap || {};
    if (Object.keys(propMap).length > 0) return propMap;
    return fetchedThreadMap;
  }, [localLabelThreadMap, fetchedThreadMap]);

  // Load ALL contacts (no pagination limit)
  useEffect(() => {
    if (!zaloId) return;
    setLoading(true);
    ipc.crm?.getContacts({ zaloId, opts: { limit: 99999, offset: 0 } })
      .then(res => { if (res?.success) setAllContacts(res.contacts); })
      .finally(() => setLoading(false));
  }, [zaloId]);

  // Available = not already in campaign
  const available = useMemo(() =>
    allContacts.filter(c => !existingContactIds.has(c.contact_id)),
    [allContacts, existingContactIds]
  );

  // Filtered by mode + search
  const filtered = useMemo(() => {
    let list = available;
    if (mode === 'friends_only') list = list.filter(c => c.is_friend === 1);
    if (mode === 'groups_only') list = list.filter(c => c.contact_type === 'group');
    if (mode === 'by_label') {
      // Filter by selected Zalo labels
      if (selectedZaloLabelIds.length > 0) {
        list = list.filter(c =>
          selectedZaloLabelIds.every(labelId =>
            allLabels.find(l => l.id === labelId)?.conversations?.includes(c.contact_id)
          )
        );
      }
      // Filter by selected Local labels
      if (selectedLocalLabelIds.length > 0 && effectiveThreadMap) {
        list = list.filter(c => {
          const threadLabels = effectiveThreadMap[c.contact_id] || [];
          return selectedLocalLabelIds.every(lid => threadLabels.includes(lid));
        });
      }
      // If no labels selected at all, show nothing (require at least one label filter)
      if (selectedZaloLabelIds.length === 0 && selectedLocalLabelIds.length === 0) {
        list = [];
      }
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c =>
        (c.alias || c.display_name || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q) ||
        c.contact_id.includes(q)
      );
    }
    return list;
  }, [available, mode, selectedZaloLabelIds, selectedLocalLabelIds, search, allLabels, effectiveThreadMap]);

  // ── Phone input handling ──
  useEffect(() => {
    if (!phoneInput.trim()) { setPhoneList([]); return; }
    const lines = phoneInput.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    const normalized = [...new Set(lines.map(normalizePhone).filter(s => /^\d{9,12}$/.test(s)))];
    setPhoneList(normalized);
  }, [phoneInput]);

  // Final selected contacts
  const finalSelected: any[] = useMemo(() => {
    if (mode === 'by_phone') {
      // Return resolved phone contacts
      return phoneList
        .map(phone => {
          const resolved = phoneResolved.get(phone);
          if (resolved) {
            return {
              contact_id: resolved.uid,
              display_name: resolved.name || phone,
              avatar: resolved.avatar || '',
              phone,
              source: 'phone',
            };
          }
          // Not resolved yet — will be resolved when adding
          return { contact_id: `phone:${phone}`, display_name: phone, avatar: '', phone, source: 'phone_pending' };
        })
        .filter(c => !existingContactIds.has(c.contact_id));
    }
    if (mode === 'manual') return available.filter(c => manualSelected.has(c.contact_id));
    return filtered;
  }, [mode, available, manualSelected, filtered, phoneList, phoneResolved, existingContactIds]);

  const toggleManual = (id: string) => {
    setManualSelected(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };
  const toggleZaloLabel = (id: number) => {
    setSelectedZaloLabelIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const toggleLocalLabel = (id: number) => {
    setSelectedLocalLabelIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };
  const selectAllFiltered = () => setManualSelected(new Set(filtered.map(c => c.contact_id)));

  const removePhone = (phone: string) => {
    setPhoneList(prev => prev.filter(p => p !== phone));
    // Also remove from input textarea
    setPhoneInput(prev => {
      const lines = prev.split('\n').filter(l => normalizePhone(l.trim()) !== phone);
      return lines.join('\n');
    });
  };

  // Resolve all phone numbers to UIDs before confirming
  const handleConfirmPhones = async () => {
    setPhoneResolving(true);
    const resolvedMap = new Map(phoneResolved);
    const toResolve = phoneList.filter(p => !resolvedMap.has(p));

    // Try to match from existing contacts first
    for (const phone of toResolve) {
      const match = allContacts.find(c => normalizePhone(c.phone || '') === phone);
      if (match) {
        resolvedMap.set(phone, { uid: match.contact_id, name: match.alias || match.display_name || phone, avatar: match.avatar });
      }
    }

    // For remaining unresolved, call findUser API
    const stillUnresolved = phoneList.filter(p => !resolvedMap.has(p));
    for (const phone of stillUnresolved) {
      try {
        // Get auth from account
        const acc = useAccountStore.getState().accounts.find((a) => a.zalo_id === zaloId);
        if (!acc) continue;
        const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };
        const res = await ipc.zalo?.findUser({ auth, phone });
        if (res?.response?.userId || res?.response?.uid) {
          const uid = res.response.userId || res.response.uid;
          const name = res.response.displayName || res.response.zaloName || phone;
          const avatar = res.response.avatar || '';
          resolvedMap.set(phone, { uid, name, avatar });
        } else {
          resolvedMap.set(phone, null); // Not found
        }
      } catch {
        resolvedMap.set(phone, null);
      }
    }

    setPhoneResolved(resolvedMap);

    // Build final contacts list from resolved
    // Use contact_id / display_name (snake_case) to match regular contact shape
    // so handleConfirmTargets in CampaignDetail can map them correctly
    const contacts = phoneList
      .map(phone => {
        const r = resolvedMap.get(phone);
        if (!r) return null;
        return { contact_id: r.uid, display_name: r.name || phone, avatar: r.avatar || '', phone };
      })
      .filter(Boolean);

    setPhoneResolving(false);
    if (contacts.length > 0) {
      onConfirm(contacts as any[]);
      onClose();
    }
  };

  const totalLabelFilters = selectedZaloLabelIds.length + selectedLocalLabelIds.length;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-gray-800 border border-gray-600 rounded-2xl max-h-[85vh] flex flex-col shadow-2xl ${mode === 'by_phone' ? 'w-[700px]' : 'w-[540px]'}`}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 flex-shrink-0">
          <div>
            <h3 className="font-semibold text-white">Chọn liên hệ</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              {loading ? 'Đang tải...' : `${finalSelected.length} đã chọn · ${available.length} khả dụng`}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        {/* Mode selector */}
        <div className="flex gap-1 px-4 py-2.5 border-b border-gray-700 flex-shrink-0 overflow-x-auto">
          {([
            { key: 'manual' as const, label: '☑ Thủ công' },
            { key: 'by_label' as const, label: '🏷️ Theo nhãn' },
            { key: 'by_phone' as const, label: '📞 Theo SĐT' },
            { key: 'friends_only' as const, label: '🤝 Bạn bè' },
            { key: 'groups_only' as const, label: '👥 Nhóm' },
          ]).map(({ key, label }) => (
            <button key={key} onClick={() => setMode(key)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors whitespace-nowrap flex-shrink-0 ${
                mode === key ? 'border-blue-500 bg-blue-500/20 text-blue-300' : 'border-gray-600 text-gray-400 hover:border-gray-500'
              }`}>{label}</button>
          ))}
        </div>

        {/* ── Label filter chips (by_label mode) ── */}
        {mode === 'by_label' && (
          <div className="border-b border-gray-700 flex-shrink-0 px-4 py-2.5 space-y-2">
            {/* Tab switcher */}
            <div className="flex gap-1 mb-1">
              <button onClick={() => setLabelTab('local')}
                className={`text-[11px] px-3 py-1 rounded-md font-medium transition-colors ${
                  labelTab === 'local'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : 'text-gray-500 hover:text-gray-300 border border-transparent'
                }`}>
                💾 Nhãn Local{effectiveLocalLabels.length > 0 ? ` (${effectiveLocalLabels.length})` : ''}
              </button>
              <button onClick={() => setLabelTab('zalo')}
                className={`text-[11px] px-3 py-1 rounded-md font-medium transition-colors ${
                  labelTab === 'zalo'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : 'text-gray-500 hover:text-gray-300 border border-transparent'
                }`}>
                ☁️ Nhãn Zalo{allLabels.length > 0 ? ` (${allLabels.length})` : ''}
              </button>
            </div>

            {/* Local labels tab */}
            {labelTab === 'local' && (
              effectiveLocalLabels.length > 0 ? (
                <div ref={labelScrollRef} className="flex gap-1.5 overflow-x-auto pb-1 flex-wrap" style={{ scrollbarWidth: 'thin' }}>
                  {effectiveLocalLabels.map(label => {
                    const isActive = selectedLocalLabelIds.includes(label.id);
                    return (
                      <button key={`local-${label.id}`} onClick={() => toggleLocalLabel(label.id)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-all whitespace-nowrap flex-shrink-0 ${
                          isActive ? 'border-transparent' : 'border-gray-600 text-gray-400 hover:border-gray-500'
                        }`}
                        style={isActive
                          ? { backgroundColor: (label.color || '#3b82f6') + '28', color: label.text_color || label.color || '#3b82f6', border: `1px solid ${label.color || '#3b82f6'}55` }
                          : {}}>
                        {label.emoji && <span className="mr-0.5">{label.emoji}</span>}{label.name}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-gray-500 py-2">Chưa có Nhãn Local nào. Tạo nhãn từ trang Liên hệ.</p>
              )
            )}

            {/* Zalo labels tab */}
            {labelTab === 'zalo' && (
              allLabels.length > 0 ? (
                <div className="flex gap-1.5 overflow-x-auto pb-1 flex-wrap" style={{ scrollbarWidth: 'thin' }}>
                  {allLabels.map(label => {
                    const isActive = selectedZaloLabelIds.includes(label.id);
                    return (
                      <button key={`zalo-${label.id}`} onClick={() => toggleZaloLabel(label.id)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-all whitespace-nowrap flex-shrink-0 ${
                          isActive ? 'border-transparent' : 'border-gray-600 text-gray-400 hover:border-gray-500'
                        }`}
                        style={isActive
                          ? { backgroundColor: (label.color || '#3b82f6') + '28', color: label.color || '#3b82f6', border: `1px solid ${label.color || '#3b82f6'}55` }
                          : {}}>
                        {label.emoji} {label.text}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="text-xs text-gray-500 py-2">Chưa có nhãn Zalo nào. Đồng bộ nhãn từ header trước.</p>
              )
            )}

            {totalLabelFilters > 0 && (
              <p className="text-[11px] text-blue-400">{filtered.length} liên hệ phù hợp với {totalLabelFilters} nhãn đã chọn</p>
            )}
          </div>
        )}

        {/* ── Phone input mode ── */}
        {mode === 'by_phone' ? (
          <>
            <div className="flex flex-1 overflow-hidden border-b border-gray-700">
              {/* Left: textarea */}
              <div className="w-1/2 flex flex-col border-r border-gray-700">
                <div className="px-3 py-2 border-b border-gray-700/50 flex-shrink-0">
                  <p className="text-[11px] text-gray-400 font-medium">Nhập hoặc dán SĐT (mỗi số 1 dòng)</p>
                </div>
                <textarea
                  value={phoneInput}
                  onChange={e => setPhoneInput(e.target.value)}
                  placeholder={"0901234567\n0912345678\n84987654321\n..."}
                  className="flex-1 bg-transparent text-xs text-white placeholder-gray-600 p-3 resize-none outline-none font-mono leading-relaxed"
                  spellCheck={false}
                />
              </div>
              {/* Right: phone list */}
              <div className="w-1/2 flex flex-col">
                <div className="px-3 py-2 border-b border-gray-700/50 flex-shrink-0 flex items-center justify-between">
                  <p className="text-[11px] text-gray-400 font-medium">{phoneList.length} số hợp lệ</p>
                  {phoneList.length > 0 && (
                    <button onClick={() => { setPhoneInput(''); setPhoneList([]); setPhoneResolved(new Map()); }}
                      className="text-[11px] text-red-400 hover:text-red-300">Xóa tất cả</button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {phoneList.length === 0 ? (
                    <p className="text-xs text-gray-600 text-center py-8">Nhập SĐT bên trái →</p>
                  ) : (
                    phoneList.map((phone, i) => {
                      const resolved = phoneResolved.get(phone);
                      const existing = existingContactIds.has(resolved?.uid || '');
                      const contactMatch = allContacts.find(c => normalizePhone(c.phone || '') === phone);
                      return (
                        <div key={phone} className={`flex items-center gap-2 px-3 py-2 border-b border-gray-700/30 ${existing ? 'opacity-40' : ''}`}>
                          <span className="text-[11px] text-gray-600 w-5 text-right flex-shrink-0">{i + 1}</span>
                          <span className="text-xs text-gray-200 font-mono flex-1">{phone}</span>
                          {contactMatch && (
                            <span className="text-[10px] text-green-400 truncate max-w-[80px]" title={contactMatch.display_name}>
                              ✓ {contactMatch.alias || contactMatch.display_name}
                            </span>
                          )}
                          {resolved === null && (
                            <span className="text-[10px] text-red-400">✕</span>
                          )}
                          {existing && <span className="text-[10px] text-yellow-500">đã có</span>}
                          <button onClick={() => removePhone(phone)} className="text-gray-600 hover:text-red-400 text-xs flex-shrink-0">✕</button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Phone footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-700 flex-shrink-0">
              <span className="text-xs text-gray-500 flex-1">
                {phoneList.length} SĐT · Sẽ tự tra UID khi thêm
              </span>
              <button onClick={onClose} className="px-4 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600">Hủy</button>
              <button disabled={phoneList.length === 0 || phoneResolving}
                onClick={handleConfirmPhones}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40 flex items-center gap-1.5">
                {phoneResolving && <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />}
                {phoneResolving ? 'Đang tra cứu...' : `Thêm ${phoneList.length} SĐT`}
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Search + select-all (for non-phone modes) */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 flex-shrink-0">
              <div className="relative flex-1">
                <svg width="12" height="12" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Tìm tên, SĐT, UID..."
                  className="w-full bg-gray-700 border border-gray-600 rounded-full pl-7 pr-3 py-1.5 text-xs text-white placeholder-gray-500 focus:outline-none focus:border-blue-500" />
              </div>
              {mode === 'manual' && (
                <button onClick={selectAllFiltered} className="text-xs text-blue-400 hover:text-blue-300 flex-shrink-0">
                  Chọn tất cả ({filtered.length})
                </button>
              )}
            </div>

            {/* Contact list */}
            <div className="flex-1 overflow-y-auto">
              {loading ? (
                <div className="p-4 space-y-2">{[...Array(6)].map((_, i) => <div key={i} className="h-10 bg-gray-700/50 rounded-lg animate-pulse" />)}</div>
              ) : filtered.length === 0 ? (
                <p className="text-xs text-gray-500 text-center py-8">
                  {mode === 'by_label' && totalLabelFilters === 0
                    ? 'Chọn ít nhất 1 nhãn để lọc liên hệ'
                    : 'Không tìm thấy liên hệ phù hợp'}
                </p>
              ) : (
                filtered.map(c => {
                  const name = c.alias || c.display_name || c.contact_id;
                  const isChecked = mode === 'manual' ? manualSelected.has(c.contact_id) : true;
                  const contactLabels = allLabels.filter(l => l.conversations?.includes(c.contact_id));
                  const contactLocalLabelIds = effectiveThreadMap[c.contact_id] || [];
                  const contactLocalLabels = effectiveLocalLabels.filter(l => contactLocalLabelIds.includes(l.id));
                  return (
                    <label key={c.contact_id}
                      className={`flex items-center gap-2.5 px-4 py-2.5 border-b border-gray-700/50 transition-colors ${
                        mode === 'manual' ? 'cursor-pointer hover:bg-gray-700/40' : 'cursor-default'
                      } ${isChecked && mode !== 'manual' ? 'bg-blue-500/5' : ''}`}>
                      {mode === 'manual'
                        ? <input type="checkbox" checked={isChecked} onChange={() => toggleManual(c.contact_id)} className="accent-blue-500 flex-shrink-0" />
                        : <span className="w-4 h-4 rounded-full bg-blue-600/30 border border-blue-500/50 flex items-center justify-center flex-shrink-0">
                            <span className="text-blue-400 text-[9px]">✓</span>
                          </span>}
                      {/* Avatar */}
                      <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0">
                        {c.avatar
                          ? <img src={c.avatar} alt="" className="w-full h-full object-cover" />
                          : <div className="w-full h-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-xs font-bold">
                              {name.charAt(0).toUpperCase()}
                            </div>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-gray-200 truncate font-medium">{name}</span>
                          {c.contact_type === 'group'
                            ? <span className="text-[9px] text-purple-400 flex-shrink-0 bg-purple-400/10 px-1 rounded">nhóm</span>
                            : c.is_friend === 1 && <span className="text-[9px] text-green-500 flex-shrink-0">●</span>}
                        </div>
                        {(contactLabels.length > 0 || contactLocalLabels.length > 0) && (
                          <div className="flex gap-1 mt-0.5 flex-wrap">
                            {contactLocalLabels.slice(0, 2).map(l => (
                              <span key={`ll-${l.id}`} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: (l.color || '#3b82f6') + '30', color: l.text_color || l.color || '#3b82f6' }}>
                                {l.emoji && <span className="mr-0.5">{l.emoji}</span>}{l.name}
                              </span>
                            ))}
                            {contactLabels.slice(0, 2).map(l => <ZaloLabelBadge key={l.id} label={l} size="xs" />)}
                          </div>
                        )}
                      </div>
                      {c.phone && <span className="text-[11px] text-gray-500 flex-shrink-0">{formatPhone(c.phone)}</span>}
                    </label>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-700 flex-shrink-0">
              <span className="text-xs text-gray-500 flex-1">{finalSelected.length} liên hệ được chọn</span>
              <button onClick={onClose} className="px-4 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600">Hủy</button>
              <button disabled={finalSelected.length === 0}
                onClick={() => { onConfirm(finalSelected); onClose(); }}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                Thêm {finalSelected.length} liên hệ
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
