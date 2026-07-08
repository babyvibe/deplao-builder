import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { LabelData } from '@/store/appStore';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import ZaloLabelBadge from '../tags/ZaloLabelBadge';
import { formatPhone } from '@/utils/phoneUtils';
import { CloudIcon, HardDriveIcon, LinkIcon, TagIcon, UserCheckIcon, UsersIcon } from '@/components/common/icons';

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
  headerContent?: React.ReactNode;
}

type SelectMode = 'manual' | 'by_label' | 'friends_only' | 'groups_only' | 'by_phone' | 'by_uid';

/** Normalize a phone string: remove spaces/dashes, convert +84/84 prefix → 0 */
function normalizePhone(raw: string): string {
  let s = raw.replace(/[\s\-().]/g, '');
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (s.startsWith('84') && s.length >= 11) s = '0' + s.slice(2);
  return s;
}


export default function TargetSelector({ zaloId, allLabels, localLabels, localLabelThreadMap, existingContactIds, onConfirm, onClose, headerContent }: TargetSelectorProps) {
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
  const [phoneResolved, setPhoneResolved] = useState<Map<string, { uid: string; name: string; avatar?: string } | null>>(new Map());

  // ── UID tab state ──
  const [uidInput, setUidInput] = useState('');
  const [uidList, setUidList] = useState<string[]>([]);
  const [uidResolved, setUidResolved] = useState<Map<string, { name: string; avatar?: string } | null>>(new Map());

  // Label section scroll ref
  const labelScrollRef = useRef<HTMLDivElement>(null);
  const [labelTab, setLabelTab] = useState<'local' | 'zalo'>('local');

  // ── Load local labels directly (self-sufficient, not relying on parent props) ──
  const [fetchedLocalLabels, setFetchedLocalLabels] = useState<LocalLabelItem[]>([]);
  const [fetchedThreadMap, setFetchedThreadMap] = useState<Record<string, number[]>>({});

  useEffect(() => {
    if (!zaloId) return;
    Promise.all([
      DataAccessor.getLocalLabels({ zaloId }),
      DataAccessor.getLocalLabelThreads({ zaloId }),
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
    DataAccessor.getCRMContacts({ zaloId, opts: { limit: 99999, offset: 0 } })
      .then(res => { if (res?.success) setAllContacts(res.contacts || []); })
      .finally(() => setLoading(false));
  }, [zaloId]);

  // Available = not already in campaign
  const available = useMemo(() =>
    (allContacts || []).filter(c => !existingContactIds.has(c.contact_id)),
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

  // ── UID input handling ──
  useEffect(() => {
    if (!uidInput.trim()) { setUidList([]); return; }
    const lines = uidInput.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    // UID is typically a numeric string (Zalo UID)
    const validUids = [...new Set(lines.filter(s => /^\d{5,}$/.test(s)))];
    setUidList(validUids);
  }, [uidInput]);

  // ── Auto-resolve from local contacts whenever phoneList or allContacts changes ──
  useEffect(() => {
    if (phoneList.length === 0 || allContacts.length === 0) return;
    setPhoneResolved(prev => {
      const next = new Map(prev);
      let changed = false;
      for (const phone of phoneList) {
        if (!next.has(phone)) {
          const match = allContacts.find(c => normalizePhone(c.phone || '') === phone);
          if (match) {
            next.set(phone, {
              uid: match.contact_id,
              name: match.alias || match.display_name || phone,
              avatar: match.avatar_url || match.avatar || '',
            });
            changed = true;
          }
        }
      }
      return changed ? next : prev;
    });
  }, [phoneList, allContacts]);

  // NOTE: Phone numbers are no longer resolved via Zalo API at add time.
  // Resolution happens at send time in CRMQueueService to avoid rate limiting.
  // Local-contact cache matching (above) still works without API calls.

  // ── Auto-resolve UIDs from local contacts whenever uidList or allContacts changes ──
  useEffect(() => {
    if (uidList.length === 0 || allContacts.length === 0) return;
    setUidResolved(prev => {
      const next = new Map(prev);
      let changed = false;
      for (const uid of uidList) {
        if (!next.has(uid)) {
          const match = allContacts.find(c => c.contact_id === uid);
          if (match) {
            next.set(uid, {
              name: match.alias || match.display_name || '',
              avatar: match.avatar_url || match.avatar || '',
            });
          } else {
            // Not in local contacts - will be resolved at send time via getUserInfo
            next.set(uid, null);
            changed = true;
          }
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [uidList, allContacts]);

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
          // Not resolved yet - will be resolved when adding
          return { contact_id: `phone:${phone}`, display_name: phone, avatar: '', phone, source: 'phone_pending' };
        })
        .filter(c => {
          // Check both contact_id and phone: prefix to prevent duplicates
          if (existingContactIds.has(c.contact_id)) return false;
          if (c.phone && existingContactIds.has(`phone:${c.phone}`)) return false;
          return true;
        });
    }
    if (mode === 'by_uid') {
      return uidList
        .map(uid => {
          const resolved = uidResolved.get(uid);
          if (resolved) {
            return {
              contact_id: uid,
              display_name: resolved.name || uid,
              avatar: resolved.avatar || '',
              source: 'uid',
            };
          }
          // Not resolved locally - will be resolved at send time via getUserInfo
          return { contact_id: uid, display_name: '', avatar: '', source: 'uid_pending' };
        })
        .filter(c => {
          if (existingContactIds.has(c.contact_id)) return false;
          return true;
        });
    }
    if (mode === 'manual') return available.filter(c => manualSelected.has(c.contact_id));
    return filtered;
  }, [mode, available, manualSelected, filtered, phoneList, phoneResolved, uidList, uidResolved, existingContactIds]);

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

  // Confirm phone contacts - unresolved phones are added directly,
  // Zalo API resolution will happen at send time in CRMQueueService.
  const handleConfirmPhones = () => {
    const contacts = phoneList
      .map(phone => {
        const r = phoneResolved.get(phone);
        if (r) return { contact_id: r.uid, display_name: r.name || phone, avatar: r.avatar || '', phone };
        // Not resolved - add as pending phone, will be resolved at send time
        return { contact_id: `phone:${phone}`, display_name: phone, avatar: '', phone };
      })
      .filter(c => {
        // Check both contact_id and phone: prefix to prevent duplicates
        // when resolution status changes between sessions
        if (existingContactIds.has(c.contact_id)) return false;
        if (c.phone && existingContactIds.has(`phone:${c.phone}`)) return false;
        return true;
      });
    if (contacts.length > 0) {
      onConfirm(contacts);
      onClose();
    } else if (phoneList.length > 0) {
      // All phones already exist in campaign - close modal
      onClose();
    }
  };

  const removeUid = (uid: string) => {
    setUidList(prev => prev.filter(u => u !== uid));
    setUidInput(prev => {
      const lines = prev.split('\n').filter(l => l.trim() !== uid);
      return lines.join('\n');
    });
  };

  // Confirm UID contacts - unresolved UIDs are added directly,
  // getUserInfo will be called at send time in CRMQueueService.
  const handleConfirmUids = () => {
    const contacts = uidList
      .map(uid => {
        const r = uidResolved.get(uid);
        if (r) return { contact_id: uid, display_name: r.name || uid, avatar: r.avatar || '' };
        // Not resolved locally - will be resolved at send time
        return { contact_id: uid, display_name: '', avatar: '' };
      })
      .filter(c => !existingContactIds.has(c.contact_id));
    if (contacts.length > 0) {
      onConfirm(contacts);
      onClose();
    } else if (uidList.length > 0) {
      // All UIDs already exist in campaign - close modal
      onClose();
    }
  };

  const totalLabelFilters = selectedZaloLabelIds.length + selectedLocalLabelIds.length;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-gray-800 border border-gray-600 rounded-2xl max-h-[85vh] flex flex-col shadow-2xl ${mode === 'by_phone' || mode === 'by_uid' ? 'w-[700px]' : 'w-[540px]'}`}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700 flex-shrink-0">
          <div>
            <h3 className="font-semibold text-white">Chọn liên hệ</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {loading ? 'Đang tải...' : `${finalSelected.length} đã chọn · ${available.length} khả dụng`}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white">✕</button>
        </div>

        {/* Header content slot (e.g. wizard step indicator) */}
        {headerContent && (
          <div className="border-b border-gray-700 flex-shrink-0 px-5">
            {headerContent}
          </div>
        )}

        {/* Mode selector */}
        <div className="flex gap-1 px-4 py-2.5 border-b border-gray-700 flex-shrink-0 overflow-x-auto">
          {([
            { key: 'manual' as const, label: '☑ Thủ công' },
            { key: 'by_label' as const, label: 'Theo nhãn' },
            { key: 'by_phone' as const, label: 'Theo SĐT' },
            { key: 'by_uid' as const, label: 'Theo UID' },
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
                    : 'text-gray-400 hover:text-gray-300 border border-transparent'
                }`}><HardDriveIcon className="w-4 h-4 inline" /> Nhãn Local{effectiveLocalLabels.length > 0 ? ` (${effectiveLocalLabels.length})` : ''}
              </button>
              <button onClick={() => setLabelTab('zalo')}
                className={`text-[11px] px-3 py-1 rounded-md font-medium transition-colors ${
                  labelTab === 'zalo'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : 'text-gray-400 hover:text-gray-300 border border-transparent'
                }`}>
                <CloudIcon className="w-4 h-4 inline" /> Nhãn Zalo{allLabels.length > 0 ? ` (${allLabels.length})` : ''}
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
                <p className="text-xs text-gray-400 py-2">Chưa có Nhãn Local nào. Tạo nhãn từ trang Liên hệ.</p>
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
                <p className="text-xs text-gray-400 py-2">Chưa có nhãn Zalo nào. Đồng bộ nhãn từ header trước.</p>
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
                  <p className="text-[11px] text-gray-400 font-medium">
                    {phoneList.length} số hợp lệ
                    {phoneList.length > 0 && (() => {
                      const resolved = phoneList.filter(p => phoneResolved.get(p) != null).length;
                      return resolved > 0 ? <span className="text-green-400 ml-1">· {resolved} có tên</span> : null;
                    })()}
                  </p>
                  {phoneList.length > 0 && (
                    <button onClick={() => { setPhoneInput(''); setPhoneList([]); setPhoneResolved(new Map()); }}
                      className="text-[11px] text-red-400 hover:text-red-300">Xóa tất cả</button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {phoneList.length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-8">Nhập SĐT bên trái →</p>
                  ) : (
                    phoneList.map((phone, i) => {
                      const resolved = phoneResolved.get(phone);
                      // Check both resolved UID and phone: prefix for previously added unresolved phones
                      const phoneContactId = `phone:${phone}`;
                      const existing = existingContactIds.has(resolved?.uid || '') || existingContactIds.has(phoneContactId);
                      return (
                        <div key={phone} className={`flex items-center gap-2 px-3 py-2 border-b border-gray-700/30 ${existing ? 'opacity-40' : ''}`}>
                          <span className="text-[11px] text-gray-400 w-5 text-right flex-shrink-0">{i + 1}</span>
                          {/* Avatar */}
                          <div className="w-7 h-7 rounded-full flex-shrink-0 overflow-hidden bg-gray-700">
                            {resolved?.avatar
                              ? <img src={resolved.avatar} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                              : <div className="w-full h-full flex items-center justify-center text-white text-[10px] font-bold"
                                  style={{ background: resolved ? 'linear-gradient(135deg,#3b82f6,#8b5cf6)' : '#374151' }}>
                                  {resolved ? (resolved.name || phone).charAt(0).toUpperCase() : '?'}
                                </div>}
                          </div>
                          {/* Name + phone */}
                          <div className="flex-1 min-w-0">
                            {resolved
                              ? <>
                                  <p className="text-xs text-gray-100 truncate font-medium leading-tight">{resolved.name || phone}</p>
                                  <p className="text-[10px] text-gray-400 font-mono leading-tight">{phone}</p>
                                </>
                              : <p className="text-xs text-gray-400 font-mono">{phone}</p>
                            }
                          </div>
                          {existing && <span className="text-[10px] text-yellow-500 flex-shrink-0">đã có</span>}
                          <button onClick={() => removePhone(phone)} className="text-gray-400 hover:text-red-400 text-xs flex-shrink-0 ml-1">✕</button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Phone footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-700 flex-shrink-0">
              <span className="text-xs text-gray-400 flex-1">
                {phoneList.length} SĐT
                {phoneList.length > 0 && (() => {
                  const resolvedCount = phoneList.filter(p => phoneResolved.get(p) != null).length;
                  return resolvedCount > 0 ? <span className="text-green-400"> · {resolvedCount} có tên</span> : null;
                })()}
              </span>
              <button onClick={onClose} className="px-4 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600">Hủy</button>
              <button
                disabled={phoneList.length === 0}
                onClick={handleConfirmPhones}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                Thêm {phoneList.length} SĐT
              </button>
            </div>
          </>
        ) : mode === 'by_uid' ? (
          <>
            <div className="flex flex-1 overflow-hidden border-b border-gray-700">
              {/* Left: textarea */}
              <div className="w-1/2 flex flex-col border-r border-gray-700">
                <div className="px-3 py-2 border-b border-gray-700/50 flex-shrink-0">
                  <p className="text-[11px] text-gray-400 font-medium">Nhập hoặc dán UID (mỗi UID 1 dòng)</p>
                </div>
                <textarea
                  value={uidInput}
                  onChange={e => setUidInput(e.target.value)}
                  placeholder={"5872634901234\n1234567890123\n..."}
                  className="flex-1 bg-transparent text-xs text-white placeholder-gray-600 p-3 resize-none outline-none font-mono leading-relaxed"
                  spellCheck={false}
                />
              </div>
              {/* Right: uid list */}
              <div className="w-1/2 flex flex-col">
                <div className="px-3 py-2 border-b border-gray-700/50 flex-shrink-0 flex items-center justify-between">
                  <p className="text-[11px] text-gray-400 font-medium">
                    {uidList.length} UID hợp lệ
                    {uidList.length > 0 && (() => {
                      const resolved = uidList.filter(u => uidResolved.get(u) != null).length;
                      return resolved > 0 ? <span className="text-green-400 ml-1">· {resolved} có tên</span> : null;
                    })()}
                  </p>
                  {uidList.length > 0 && (
                    <button onClick={() => { setUidInput(''); setUidList([]); setUidResolved(new Map()); }}
                      className="text-[11px] text-red-400 hover:text-red-300">Xóa tất cả</button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {uidList.length === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-8">Nhập UID bên trái →</p>
                  ) : (
                    uidList.map((uid, i) => {
                      const resolved = uidResolved.get(uid);
                      const existing = existingContactIds.has(uid);
                      return (
                        <div key={uid} className={`flex items-center gap-2 px-3 py-2 border-b border-gray-700/30 ${existing ? 'opacity-40' : ''}`}>
                          <span className="text-[11px] text-gray-400 w-5 text-right flex-shrink-0">{i + 1}</span>
                          {/* Avatar */}
                          <div className="w-7 h-7 rounded-full flex-shrink-0 overflow-hidden bg-gray-700">
                            {resolved?.avatar
                              ? <img src={resolved.avatar} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                              : <div className="w-full h-full flex items-center justify-center text-white text-[10px] font-bold"
                                  style={{ background: resolved ? 'linear-gradient(135deg,#3b82f6,#8b5cf6)' : '#374151' }}>
                                  {resolved ? (resolved.name || uid).charAt(0).toUpperCase() : '?'}
                                </div>}
                          </div>
                          {/* Name + uid */}
                          <div className="flex-1 min-w-0">
                            {resolved
                              ? <>
                                  <p className="text-xs text-gray-100 truncate font-medium leading-tight">{resolved.name || uid}</p>
                                  <p className="text-[10px] text-gray-400 font-mono leading-tight">{uid}</p>
                                </>
                              : <p className="text-xs text-gray-400 font-mono">{uid}</p>
                            }
                          </div>
                          {existing && <span className="text-[10px] text-yellow-500 flex-shrink-0">đã có</span>}
                          <button onClick={() => removeUid(uid)} className="text-gray-400 hover:text-red-400 text-xs flex-shrink-0 ml-1">✕</button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* UID footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-700 flex-shrink-0">
              <span className="text-xs text-gray-400 flex-1">
                {uidList.length} UID
                {uidList.length > 0 && (() => {
                  const resolvedCount = uidList.filter(u => uidResolved.get(u) != null).length;
                  return resolvedCount > 0 ? <span className="text-green-400"> · {resolvedCount} có tên</span> : null;
                })()}
                {uidList.length > 0 && <span className="text-gray-400"> · Còn lại sẽ lấy tên khi gửi</span>}
              </span>
              <button onClick={onClose} className="px-4 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600">Hủy</button>
              <button
                disabled={uidList.length === 0}
                onClick={handleConfirmUids}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                Thêm {uidList.length} UID
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Search + select-all (for non-phone modes) */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-700 flex-shrink-0">
              <div className="relative flex-1">
                <svg width="12" height="12" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"
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
                <p className="text-xs text-gray-400 text-center py-8">
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
                      {c.phone && <span className="text-[11px] text-gray-400 flex-shrink-0">{formatPhone(c.phone)}</span>}
                    </label>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-gray-700 flex-shrink-0">
              <span className="text-xs text-gray-400 flex-1">{finalSelected.length} liên hệ được chọn</span>
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
