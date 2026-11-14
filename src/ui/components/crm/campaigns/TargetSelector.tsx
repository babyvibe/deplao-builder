import React, { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import type { LabelData } from '@/store/app/appStore';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import {
  collectGroupTargets, countMembersByGroup, readOutcome, targetConfirmBlockReason, type GroupMembersRead,
} from '@/lib/crm/loadFailure';
import ipc from '@/lib/ipc';
import ZaloLabelBadge from '../tags/ZaloLabelBadge';
import LoadFailedNotice from '../LoadFailedNotice';
import { formatPhone } from '@/lib/contacts/phoneUtils';
import { CloudIcon, HardDriveIcon, LinkIcon, TagIcon, UserCheckIcon, UsersIcon } from '@/components/common/icons';
import { CHANNEL } from '@/lib/channels/channelHelper';
import { getCapability, type Channel } from '../../../../configs/channels/channelConfig';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

export interface LocalLabelItem {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  emoji?: string;
}

interface TargetSelectorProps {
  zaloId: string;
  /**
   * The account's channel (default Zalo). "Theo SĐT" (By phone number) only appears when the channel can look up the phone number → the account at send time (Zalo); the Zalo label
   * tab only when the channel has Zalo labels. Telegram used to show both: a phone number not yet in the contacts became the recipient
   * "phone:…" which the queue could not send.
   */
  channel?: Channel;
  allLabels: LabelData[];
  localLabels?: LocalLabelItem[];
  localLabelThreadMap?: Record<string, number[]>;
  existingContactIds: Set<string>;
  onConfirm: (contacts: any[]) => void;
  onClose: () => void;
  headerContent?: React.ReactNode;
}

type SelectMode = 'manual' | 'by_label' | 'friends_only' | 'groups_only' | 'by_phone' | 'by_uid' | 'by_group';

/** Zalo labels store group IDs with a "g" prefix (e.g. "g4579..."); contact_id in the CRM does not. Strip the prefix to match. */
function stripGroupPrefix(id: string): string {
  return id.startsWith('g') ? id.slice(1) : id;
}

/** Normalize a phone string: remove spaces/dashes, convert +84/84 prefix → 0 */
function normalizePhone(raw: string): string {
  let s = raw.replace(/[\s\-().]/g, '');
  if (s.startsWith('+84')) s = '0' + s.slice(3);
  else if (s.startsWith('84') && s.length >= 11) s = '0' + s.slice(2);
  return s;
}


export default function TargetSelector({ zaloId, channel = CHANNEL.ZALO, allLabels, localLabels, localLabelThreadMap, existingContactIds, onConfirm, onClose, headerContent }: TargetSelectorProps) {
  const channelCap = getCapability(channel);
  const supportsPhoneTargets = channelCap.supportsCRMPhoneImport;
  const supportsZaloLabels = channelCap.supportsLabel;
  const [mode, setMode] = useState<SelectMode>('manual');
  const [selectedZaloLabelIds, setSelectedZaloLabelIds] = useState<number[]>([]);
  const [selectedLocalLabelIds, setSelectedLocalLabelIds] = useState<number[]>([]);
  const [manualSelected, setManualSelected] = useState<Set<string>>(new Set());  // In filter modes (groups / friends / labels) every item is selected by default; the user can unselect each one → stored here.
  const [search, setSearch] = useState('');
  const [allContacts, setAllContacts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  // The last contact list load failed (employee: lost connection to BOSS) → list is empty / old, the "Thêm" (Add) button is locked
  const [contactsFailed, setContactsFailed] = useState(false);
  /** Account of the `allContacts` on screen: an error only keeps the old list when it belongs to this account. */
  const contactsOwnerRef = useRef<string | null>(null);
  const contactsSeqRef = useRef(0);

  // ── Phone tab state ──
  const [phoneInput, setPhoneInput] = useState('');
  const [phoneList, setPhoneList] = useState<string[]>([]);
  const [phoneResolved, setPhoneResolved] = useState<Map<string, { uid: string; name: string; avatar?: string } | null>>(new Map());

  // ── UID tab state ──
  const [uidInput, setUidInput] = useState('');
  const [uidList, setUidList] = useState<string[]>([]);
  const [uidResolved, setUidResolved] = useState<Map<string, { name: string; avatar?: string } | null>>(new Map());

  // ── Group tab state ──
  const [selectedGroupIds, setSelectedGroupIds] = useState<Set<string>>(new Set());
  const [groupMemberCounts, setGroupMemberCounts] = useState<Record<string, number>>({});
  const [groupConfirmLoading, setGroupConfirmLoading] = useState(false);
  /** The last "Thêm thành viên" (Add members) could not read the members of a group → nobody was added yet. */
  const [groupConfirmError, setGroupConfirmError] = useState<string | null>(null);
  const [groupCountsFailed, setGroupCountsFailed] = useState(false);
  const countsOwnerRef = useRef<string | null>(null);
  const countsSeqRef = useRef(0);

  // Label section scroll ref
  const labelScrollRef = useRef<HTMLDivElement>(null);
  const [labelTab, setLabelTab] = useState<'local' | 'zalo'>('local');

  // ── Load local labels directly (self-sufficient, not relying on parent props) ──
  const [fetchedLocalLabels, setFetchedLocalLabels] = useState<LocalLabelItem[]>([]);
  const [fetchedThreadMap, setFetchedThreadMap] = useState<Record<string, number[]>>({});
  // Error (labels or the label-assignment table) → keep what is there, show "Không tải được - Thử lại" (Failed to load - Retry) where the list would otherwise be empty
  const [localLabelsFailed, setLocalLabelsFailed] = useState(false);
  const [localLabelsLoading, setLocalLabelsLoading] = useState(false);
  const labelsOwnerRef = useRef<string | null>(null);
  const labelsSeqRef = useRef(0);

  const loadLocalLabels = useCallback(async () => {
    if (!zaloId) return;
    const owner = zaloId;
    const seq = ++labelsSeqRef.current;
    setLocalLabelsLoading(true);
    let labelsRes: any;
    let threadsRes: any;
    try {
      [labelsRes, threadsRes] = await Promise.all([
        DataAccessor.getLocalLabels({ zaloId: owner }),
        DataAccessor.getLocalLabelThreads({ zaloId: owner }),
      ]);
    } catch (err: any) {
      labelsRes = threadsRes = { success: false, error: err?.message };
    }
    if (seq !== labelsSeqRef.current) return; // a newer load has already finished
    setLocalLabelsLoading(false);
    const labelsFailed = isReadFailure(labelsRes);
    const threadsFailed = isReadFailure(threadsRes);
    const failed = labelsFailed || threadsFailed;
    if (readOutcome(failed, labelsOwnerRef.current, owner) === 'clear') {
      // Error right after switching the account: do not filter / show the previous account's labels
      setFetchedLocalLabels([]);
      setFetchedThreadMap({});
    }
    labelsOwnerRef.current = owner;
    if (!labelsFailed) {
      // Filter only active labels (is_active !== 0)
      setFetchedLocalLabels((labelsRes?.labels || []).filter((l: any) => (l.is_active ?? 1) !== 0));
    }
    if (!threadsFailed) {
      const map: Record<string, number[]> = {};
      (threadsRes?.threads || []).forEach((row: any) => {
        if (!map[row.thread_id]) map[row.thread_id] = [];
        map[row.thread_id].push(Number(row.label_id));
      });
      setFetchedThreadMap(map);
    }
    setLocalLabelsFailed(failed);
  }, [zaloId]);

  useEffect(() => { loadLocalLabels(); }, [loadLocalLabels]);

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
  const loadContacts = useCallback(async () => {
    if (!zaloId) return;
    const owner = zaloId;
    const seq = ++contactsSeqRef.current;
    setLoading(true);
    let res: any;
    try {
      res = await DataAccessor.getCRMContacts({ zaloId: owner, opts: { limit: 99999, offset: 0 } });
    } catch (err: any) {
      res = { success: false, error: err?.message };
    }
    if (seq !== contactsSeqRef.current) return; // a newer load has already finished
    setLoading(false);
    if (res?.success) {
      contactsOwnerRef.current = owner;
      setAllContacts(res.contacts || []);
      setContactsFailed(false);
    } else if (isReadFailure(res)) {
      // Error → keep the current list for that exact account (the "Thêm" (Add) button is locked until a reload works); drop it if it belongs to another account
      if (readOutcome(true, contactsOwnerRef.current, owner) === 'clear') {
        contactsOwnerRef.current = owner;
        setAllContacts([]);
      }
      setContactsFailed(true);
    }
  }, [zaloId]);

  useEffect(() => { loadContacts(); }, [loadContacts]);

  // Changing mode / label (or the account) → reset the selected list so the selection is not carried over to another set.
  useEffect(() => {
    setManualSelected(new Set());
    setSelectedGroupIds(new Set());
    setGroupConfirmError(null);
  }, [mode, selectedZaloLabelIds, selectedLocalLabelIds, zaloId]);

  // Switching to a channel without "Theo SĐT" / Zalo label while it is open → back to a mode that is available
  useEffect(() => {
    if (!supportsPhoneTargets && mode === 'by_phone') setMode('manual');
    if (!supportsZaloLabels && labelTab === 'zalo') setLabelTab('local');
  }, [supportsPhoneTargets, supportsZaloLabels, mode, labelTab]);

  // Switching account while open (rare): the phone / UID matched from the previous account's contacts is not used for this account
  const resolvedForRef = useRef(zaloId);
  useEffect(() => {
    if (resolvedForRef.current === zaloId) return;
    resolvedForRef.current = zaloId;
    setPhoneResolved(new Map());
    setUidResolved(new Map());
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
      // Filter by selected Zalo labels.
      // Zalo labels store group IDs with a "g" prefix (e.g. "g4579..."), while contact_id in the CRM does not
      // without the prefix → normalize both sides before matching.
      if (supportsZaloLabels && selectedZaloLabelIds.length > 0) {
        list = list.filter(c => {
          const cid = stripGroupPrefix(c.contact_id);
          return selectedZaloLabelIds.every(labelId =>
            allLabels.find(l => l.id === labelId)?.conversations?.some(conv => stripGroupPrefix(conv) === cid)
          );
        });
      }
      // Filter by selected Local labels
      if (selectedLocalLabelIds.length > 0 && effectiveThreadMap) {
        list = list.filter(c => {
          const threadLabels = effectiveThreadMap[c.contact_id] || [];
          return selectedLocalLabelIds.every(lid => threadLabels.includes(lid));
        });
      }
      // If no labels selected at all, show nothing (require at least one label filter)
      if ((!supportsZaloLabels || selectedZaloLabelIds.length === 0) && selectedLocalLabelIds.length === 0) {
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
  }, [available, mode, selectedZaloLabelIds, selectedLocalLabelIds, search, allLabels, effectiveThreadMap, supportsZaloLabels]);

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

  // ── Groups list (for by_group mode) ──
  const groups = useMemo(() =>
    (allContacts || []).filter(c => c.contact_type === 'group'),
    [allContacts]
  );

  // Load member counts from DB when groups are available
  const loadGroupCounts = useCallback(async () => {
    if (!zaloId) return;
    const owner = zaloId;
    const seq = ++countsSeqRef.current;
    let res: any;
    try {
      res = await DataAccessor.getAllGroupMembers(owner);
    } catch (err: any) {
      res = { success: false, error: err?.message };
    }
    if (seq !== countsSeqRef.current) return;
    if (isReadFailure(res)) {
      // Error → keep the known numbers (same account) instead of "Chưa có thông tin" (No info yet) for every group; numbers of another account are dropped
      if (readOutcome(true, countsOwnerRef.current, owner) === 'clear') {
        countsOwnerRef.current = owner;
        setGroupMemberCounts({});
      }
      setGroupCountsFailed(true);
      return;
    }
    countsOwnerRef.current = owner;
    setGroupMemberCounts(countMembersByGroup(res?.rows));
    setGroupCountsFailed(false);
  }, [zaloId]);

  useEffect(() => {
    if (!zaloId || groups.length === 0) return;
    loadGroupCounts();
  }, [zaloId, groups.length]);

  // Employee mode: BOSS connection restored → reload the contact list, Local labels, group member counts
  useEmployeeResync(() => Promise.allSettled([
    loadContacts(),
    loadLocalLabels(),
    groups.length > 0 ? loadGroupCounts() : Promise.resolve(),
  ]));

  // Get member count for a group
  const getMemberCount = (groupId: string): number => {
    return groupMemberCounts[groupId] || 0;
  };

  // Total members across selected groups (estimated from counts)
  const totalEstimatedMembers = useMemo(() => {
    let sum = 0;
    for (const gid of selectedGroupIds) sum += groupMemberCounts[gid] || 0;
    return sum;
  }, [selectedGroupIds, groupMemberCounts]);

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
    // Manual mode & label-filter mode: nothing is ticked by default, the user picks each contact
    return filtered.filter(c => manualSelected.has(c.contact_id));
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

  // Confirm groups - fetch all members from DB, then add to campaign
  const handleConfirmGroups = async () => {
    if (selectedGroupIds.size === 0) return;
    setGroupConfirmLoading(true);
    setGroupConfirmError(null);
    try {
      const reads: GroupMembersRead[] = [];
      for (const groupId of selectedGroupIds) {
        let dbRes: any;
        try {
          dbRes = await DataAccessor.getGroupMembers({ zaloId, groupId });
        } catch (err: any) {
          dbRes = { success: false, error: err?.message };
        }
        const failed = isReadFailure(dbRes);
        reads.push({ groupId, failed, members: dbRes?.members });
        // One failed group is enough to add nothing: no need to wait for the errors / timeouts one group after another when the connection drops
        if (failed) break;
      }
      const { members: allMembers, failedGroupIds } = collectGroupTargets(reads, existingContactIds);
      if (failedGroupIds.length > 0) {
        // Before, a failed group was silently skipped → the campaign got an incomplete / empty recipient set. Now: nothing is added, and the reason is shown clearly.
        const failedId = failedGroupIds[0];
        const name = groups.find(g => g.contact_id === failedId)?.display_name || failedId;
        setGroupConfirmError(tr('Không tải được thành viên nhóm "{{name}}" — chưa thêm ai. Bấm "Thêm thành viên" để thử lại.', { name }));
        return;
      }
      if (allMembers.length > 0) {
        onConfirm(allMembers);
      }
      onClose();
    } finally {
      setGroupConfirmLoading(false);
    }
  };

  const totalLabelFilters = (supportsZaloLabels ? selectedZaloLabelIds.length : 0) + selectedLocalLabelIds.length;

  // ── Failed load → lock the "Thêm …" (Add …) button and state the reason ────────────────────────
  // A failed contact list / Local label assignment table can give an empty or incomplete recipient set that the user does not
  // recognize (and then run the campaign with that set). The label assignment table only counts when using the self-loaded copy (empty props).
  const localLabelMapFailed = localLabelsFailed && effectiveThreadMap === fetchedThreadMap;
  const blockReason = targetConfirmBlockReason(mode, {
    contactsFailed,
    localLabelMapFailed,
    filteringByLocalLabel: selectedLocalLabelIds.length > 0,
  });
  const retryFailedLoads = () => {
    if (contactsFailed) loadContacts();
    if (localLabelsFailed) loadLocalLabels();
  };
  const blockedHint = blockReason ? (
    <LoadFailedNotice className="justify-start px-0 py-0 text-warning" text={tr('{{blockReason}} — chưa thể thêm người nhận', { blockReason })}
      onRetry={retryFailedLoads} busy={loading || localLabelsLoading} />
  ) : null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50" onClick={onClose}>
      <div className={`bg-card border border-input rounded-2xl max-h-[85vh] flex flex-col shadow-2xl ${mode === 'by_phone' || mode === 'by_uid' ? 'w-[700px]' : 'w-[540px]'}`}
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <div>
            <h3 className="font-semibold text-foreground">{tr('Chọn liên hệ')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {loading ? tr('Đang tải...')
                : contactsFailed && allContacts.length === 0 ? tr('Không tải được danh sách liên hệ')
                : tr('{{count}} đã chọn · {{count1}} khả dụng', { count: finalSelected.length, count1: available.length })}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">✕</button>
        </div>

        {/* Header content slot (e.g. wizard step indicator) */}
        {headerContent && (
          <div className="border-b border-border flex-shrink-0 px-5">
            {headerContent}
          </div>
        )}

        {/* Mode selector */}
        <div className="flex gap-1 px-4 py-2.5 border-b border-border flex-shrink-0 overflow-x-auto">
          {([
            { key: 'manual' as const, label: tr('Thủ công') },
            { key: 'by_label' as const, label: tr('Theo nhãn') },
            { key: 'by_phone' as const, label: tr('Theo SĐT') },
            { key: 'by_uid' as const, label: tr('Theo UID') },
            { key: 'friends_only' as const, label: tr('Bạn bè') },
            { key: 'groups_only' as const, label: tr('Nhóm') },
            { key: 'by_group' as const, label: tr('Theo thành viên nhóm') },
          ]).filter(({ key }) => key !== 'by_phone' || supportsPhoneTargets).map(({ key, label }) => (
            <button key={key} onClick={() => setMode(key)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-colors whitespace-nowrap flex-shrink-0 ${
                mode === key ? 'border-blue-500 bg-blue-500/20 text-blue-300' : 'border-input text-muted-foreground hover:border-border-strong'
              }`}>{label}</button>
          ))}
        </div>

        {/* ── Label filter chips (by_label mode) ── */}
        {mode === 'by_label' && (
          <div className="border-b border-border flex-shrink-0 px-4 py-2.5 space-y-2">
            {/* Tab switcher */}
            <div className="flex gap-1 mb-1">
              <button onClick={() => setLabelTab('local')}
                className={`text-[11px] px-3 py-1 rounded-md font-medium transition-colors ${
                  labelTab === 'local'
                    ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                    : 'text-muted-foreground hover:text-foreground/80 border border-transparent'
                }`}>{trx('<0/> Nhãn Local{{v1}}', { 0: <HardDriveIcon className="w-4 h-4 inline" />, v1: effectiveLocalLabels.length > 0 ? ` (${effectiveLocalLabels.length})` : '' })}
              </button>
              {supportsZaloLabels && (
                <button onClick={() => setLabelTab('zalo')}
                  className={`text-[11px] px-3 py-1 rounded-md font-medium transition-colors ${
                    labelTab === CHANNEL.ZALO
                      ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40'
                      : 'text-muted-foreground hover:text-foreground/80 border border-transparent'
                  }`}>
                  {trx('<0/> Nhãn Zalo{{v1}}', { 0: <CloudIcon className="w-4 h-4 inline" />, v1: allLabels.length > 0 ? ` (${allLabels.length})` : '' })}
                </button>
              )}
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
                          isActive ? 'border-transparent' : 'border-input text-muted-foreground hover:border-border-strong'
                        }`}
                        style={isActive
                          ? { backgroundColor: (label.color || '#3b82f6') + '28', color: label.text_color || label.color || '#3b82f6', border: `1px solid ${label.color || '#3b82f6'}55` }
                          : {}}>
                        {label.emoji && <span className="mr-0.5">{label.emoji}</span>}{label.name}
                      </button>
                    );
                  })}
                </div>
              ) : localLabelsFailed ? (
                <LoadFailedNotice className="justify-start px-0" text={tr('Không tải được Nhãn Local')}
                  onRetry={loadLocalLabels} busy={localLabelsLoading} />
              ) : (
                <p className="text-xs text-muted-foreground py-2">{tr('Chưa có Nhãn Local nào. Tạo nhãn từ trang Liên hệ.')}</p>
              )
            )}

            {/* Zalo labels tab */}
            {supportsZaloLabels && labelTab === CHANNEL.ZALO && (
              allLabels.length > 0 ? (
                <div className="flex gap-1.5 overflow-x-auto pb-1 flex-wrap" style={{ scrollbarWidth: 'thin' }}>
                  {allLabels.map(label => {
                    const isActive = selectedZaloLabelIds.includes(label.id);
                    return (
                      <button key={`zalo-${label.id}`} onClick={() => toggleZaloLabel(label.id)}
                        className={`text-xs px-2.5 py-1 rounded-full border transition-all whitespace-nowrap flex-shrink-0 ${
                          isActive ? 'border-transparent' : 'border-input text-muted-foreground hover:border-border-strong'
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
                <p className="text-xs text-muted-foreground py-2">{tr('Chưa có nhãn Zalo nào. Đồng bộ nhãn từ header trước.')}</p>
              )
            )}

            {totalLabelFilters > 0 && (
              <p className="text-[11px] text-blue-400">{trx('{{count}} liên hệ phù hợp với {{totalLabelFilters}} nhãn đã chọn', { count: filtered.length, totalLabelFilters })}</p>
            )}
          </div>
        )}

        {/* ── Phone input mode ── */}
        {mode === 'by_phone' && supportsPhoneTargets ? (
          <>
            <div className="flex flex-1 overflow-hidden border-b border-border">
              {/* Left: textarea */}
              <div className="w-1/2 flex flex-col border-r border-border">
                <div className="px-3 py-2 border-b border-border/50 flex-shrink-0">
                  <p className="text-[11px] text-muted-foreground font-medium">{tr('Nhập hoặc dán SĐT (mỗi số 1 dòng)')}</p>
                </div>
                <textarea
                  value={phoneInput}
                  onChange={e => setPhoneInput(e.target.value)}
                  placeholder={"0901234567\n0912345678\n84987654321\n..."}
                  className="flex-1 bg-transparent text-xs text-foreground placeholder-subtle-foreground p-3 resize-none outline-none font-mono leading-relaxed"
                  spellCheck={false}
                />
              </div>
              {/* Right: phone list */}
              <div className="w-1/2 flex flex-col">
                <div className="px-3 py-2 border-b border-border/50 flex-shrink-0 flex items-center justify-between">
                  <p className="text-[11px] text-muted-foreground font-medium">
                    {trx('{{count}} số hợp lệ', { count: phoneList.length })}
                    {phoneList.length > 0 && (() => {
                      const resolved = phoneList.filter(p => phoneResolved.get(p) != null).length;
                      return resolved > 0 ? <span className="text-green-400 ml-1">{trx('· {{resolved}} có tên', { resolved })}</span> : null;
                    })()}
                  </p>
                  {phoneList.length > 0 && (
                    <button onClick={() => { setPhoneInput(''); setPhoneList([]); setPhoneResolved(new Map()); }}
                      className="text-[11px] text-red-400 hover:text-red-300">{tr('Xóa tất cả')}</button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {phoneList.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-8">{tr('Nhập SĐT bên trái →')}</p>
                  ) : (
                    phoneList.map((phone, i) => {
                      const resolved = phoneResolved.get(phone);
                      // Check both resolved UID and phone: prefix for previously added unresolved phones
                      const phoneContactId = `phone:${phone}`;
                      const existing = existingContactIds.has(resolved?.uid || '') || existingContactIds.has(phoneContactId);
                      return (
                        <div key={phone} className={`flex items-center gap-2 px-3 py-2 border-b border-border/30 ${existing ? 'opacity-40' : ''}`}>
                          <span className="text-[11px] text-muted-foreground w-5 text-right flex-shrink-0">{i + 1}</span>
                          {/* Avatar */}
                          <div className="w-7 h-7 rounded-full flex-shrink-0 overflow-hidden bg-muted">
                            {resolved?.avatar
                              ? <img src={resolved.avatar} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                              : <div className="w-full h-full flex items-center justify-center text-foreground text-[10px] font-bold"
                                  style={{ background: resolved ? 'linear-gradient(135deg,#3b82f6,#8b5cf6)' : '#374151' }}>
                                  {resolved ? (resolved.name || phone).charAt(0).toUpperCase() : '?'}
                                </div>}
                          </div>
                          {/* Name + phone */}
                          <div className="flex-1 min-w-0">
                            {resolved
                              ? <>
                                  <p className="text-xs text-foreground truncate font-medium leading-tight">{resolved.name || phone}</p>
                                  <p className="text-[10px] text-muted-foreground font-mono leading-tight">{phone}</p>
                                </>
                              : <p className="text-xs text-muted-foreground font-mono">{phone}</p>
                            }
                          </div>
                          {existing && <span className="text-[10px] text-yellow-500 flex-shrink-0">{tr('đã có')}</span>}
                          <button onClick={() => removePhone(phone)} className="text-muted-foreground hover:text-red-400 text-xs flex-shrink-0 ml-1">✕</button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* Phone footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-border flex-shrink-0">
              {blockedHint ? (
                // Matching phone ↔ UID and de-duplication rely on the contact list → adding is not allowed while the list has failed
                <div className="flex-1 min-w-0 text-xs">{blockedHint}</div>
              ) : (
              <span className="text-xs text-muted-foreground flex-1">
                {trx('{{count}} SĐT', { count: phoneList.length })}
                {phoneList.length > 0 && (() => {
                  const resolvedCount = phoneList.filter(p => phoneResolved.get(p) != null).length;
                  return resolvedCount > 0 ? <span className="text-green-400"> {trx('· {{resolvedCount}} có tên', { resolvedCount })}</span> : null;
                })()}
              </span>
              )}
              <button onClick={onClose} className="px-4 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent">{tr('Hủy')}</button>
              <button
                disabled={phoneList.length === 0 || !!blockReason}
                title={blockReason || undefined}
                onClick={handleConfirmPhones}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                {trx('Thêm {{count}} SĐT', { count: phoneList.length })}
              </button>
            </div>
          </>
        ) : mode === 'by_uid' ? (
          <>
            <div className="flex flex-1 overflow-hidden border-b border-border">
              {/* Left: textarea */}
              <div className="w-1/2 flex flex-col border-r border-border">
                <div className="px-3 py-2 border-b border-border/50 flex-shrink-0">
                  <p className="text-[11px] text-muted-foreground font-medium">{tr('Nhập hoặc dán UID (mỗi UID 1 dòng)')}</p>
                </div>
                <textarea
                  value={uidInput}
                  onChange={e => setUidInput(e.target.value)}
                  placeholder={"5872634901234\n1234567890123\n..."}
                  className="flex-1 bg-transparent text-xs text-foreground placeholder-subtle-foreground p-3 resize-none outline-none font-mono leading-relaxed"
                  spellCheck={false}
                />
              </div>
              {/* Right: uid list */}
              <div className="w-1/2 flex flex-col">
                <div className="px-3 py-2 border-b border-border/50 flex-shrink-0 flex items-center justify-between">
                  <p className="text-[11px] text-muted-foreground font-medium">
                    {trx('{{count}} UID hợp lệ', { count: uidList.length })}
                    {uidList.length > 0 && (() => {
                      const resolved = uidList.filter(u => uidResolved.get(u) != null).length;
                      return resolved > 0 ? <span className="text-green-400 ml-1">{trx('· {{resolved}} có tên', { resolved })}</span> : null;
                    })()}
                  </p>
                  {uidList.length > 0 && (
                    <button onClick={() => { setUidInput(''); setUidList([]); setUidResolved(new Map()); }}
                      className="text-[11px] text-red-400 hover:text-red-300">{tr('Xóa tất cả')}</button>
                  )}
                </div>
                <div className="flex-1 overflow-y-auto">
                  {uidList.length === 0 ? (
                    <p className="text-xs text-muted-foreground text-center py-8">{tr('Nhập UID bên trái →')}</p>
                  ) : (
                    uidList.map((uid, i) => {
                      const resolved = uidResolved.get(uid);
                      const existing = existingContactIds.has(uid);
                      return (
                        <div key={uid} className={`flex items-center gap-2 px-3 py-2 border-b border-border/30 ${existing ? 'opacity-40' : ''}`}>
                          <span className="text-[11px] text-muted-foreground w-5 text-right flex-shrink-0">{i + 1}</span>
                          {/* Avatar */}
                          <div className="w-7 h-7 rounded-full flex-shrink-0 overflow-hidden bg-muted">
                            {resolved?.avatar
                              ? <img src={resolved.avatar} alt="" className="w-full h-full object-cover" onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                              : <div className="w-full h-full flex items-center justify-center text-foreground text-[10px] font-bold"
                                  style={{ background: resolved ? 'linear-gradient(135deg,#3b82f6,#8b5cf6)' : '#374151' }}>
                                  {resolved ? (resolved.name || uid).charAt(0).toUpperCase() : '?'}
                                </div>}
                          </div>
                          {/* Name + uid */}
                          <div className="flex-1 min-w-0">
                            {resolved
                              ? <>
                                  <p className="text-xs text-foreground truncate font-medium leading-tight">{resolved.name || uid}</p>
                                  <p className="text-[10px] text-muted-foreground font-mono leading-tight">{uid}</p>
                                </>
                              : <p className="text-xs text-muted-foreground font-mono">{uid}</p>
                            }
                          </div>
                          {existing && <span className="text-[10px] text-yellow-500 flex-shrink-0">{tr('đã có')}</span>}
                          <button onClick={() => removeUid(uid)} className="text-muted-foreground hover:text-red-400 text-xs flex-shrink-0 ml-1">✕</button>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            {/* UID footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-border flex-shrink-0">
              <span className="text-xs text-muted-foreground flex-1">
                {uidList.length} UID
                {uidList.length > 0 && (() => {
                  const resolvedCount = uidList.filter(u => uidResolved.get(u) != null).length;
                  return resolvedCount > 0 ? <span className="text-green-400"> {trx('· {{resolvedCount}} có tên', { resolvedCount })}</span> : null;
                })()}
                {uidList.length > 0 && <span className="text-muted-foreground"> {tr('· Còn lại sẽ lấy tên khi gửi')}</span>}
              </span>
              <button onClick={onClose} className="px-4 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent">{tr('Hủy')}</button>
              <button
                disabled={uidList.length === 0}
                onClick={handleConfirmUids}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                {trx('Thêm {{count}} UID', { count: uidList.length })}
              </button>
            </div>
          </>
        ) : mode === 'by_group' ? (
          <>
            {/* Group list */}
            <div className="flex-1 overflow-y-auto">
              {groups.length > 0 && groupCountsFailed && (
                <LoadFailedNotice className="justify-start px-4" text={tr('Không tải được số thành viên nhóm')}
                  onRetry={loadGroupCounts} />
              )}
              {groups.length === 0 && loading ? (
                <p className="text-xs text-muted-foreground text-center py-8">{tr('Đang tải...')}</p>
              ) : groups.length === 0 && contactsFailed ? (
                <LoadFailedNotice className="py-8" text={tr('Không tải được danh sách nhóm')} onRetry={loadContacts} busy={loading} />
              ) : groups.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">{tr('Không có nhóm nào')}</p>
              ) : (
                groups.map(g => {
                  const isSelected = selectedGroupIds.has(g.contact_id);
                  const memberCount = getMemberCount(g.contact_id);
                  return (
                    <label key={g.contact_id}
                      className={`flex items-center gap-2.5 px-4 py-2.5 border-b border-border/50 cursor-pointer transition-colors hover:bg-muted/40 ${
                        isSelected ? 'bg-blue-500/5' : ''
                      }`}>
                      <input type="checkbox" checked={isSelected} className="accent-blue-500 flex-shrink-0"
                        onChange={() => {
                          setGroupConfirmError(null);
                          setSelectedGroupIds(prev => {
                            const next = new Set(prev);
                            next.has(g.contact_id) ? next.delete(g.contact_id) : next.add(g.contact_id);
                            return next;
                          });
                        }} />
                      <div className="w-8 h-8 rounded-lg overflow-hidden flex-shrink-0">
                        {g.avatar
                          ? <img src={g.avatar} alt="" className="w-full h-full object-cover" />
                          : <div className="w-full h-full bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center text-white text-xs font-bold">
                              {(g.display_name || '?').charAt(0).toUpperCase()}
                            </div>}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs text-foreground truncate font-medium">{g.display_name || g.contact_id}</p>
                        <p className="text-[10px] text-muted-foreground">
                          {memberCount > 0 ? tr('{{memberCount}} thành viên', { memberCount }) : tr('Chưa có thông tin')}
                        </p>
                      </div>
                    </label>
                  );
                })
              )}
            </div>

            {/* Group footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-border flex-shrink-0">
              {groupConfirmError ? (
                <p role="alert" className="flex-1 min-w-0 text-xs text-destructive">{groupConfirmError}</p>
              ) : blockedHint ? (
                <div className="flex-1 min-w-0 text-xs">{blockedHint}</div>
              ) : (
              <span className="text-xs text-muted-foreground flex-1">
                {trx('{{count}} nhóm · ~{{totalEstimatedMembers}} thành viên', { count: selectedGroupIds.size, totalEstimatedMembers })}
              </span>
              )}
              <button onClick={onClose} className="px-4 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent">{tr('Hủy')}</button>
              <button
                disabled={selectedGroupIds.size === 0 || groupConfirmLoading || !!blockReason}
                title={blockReason || undefined}
                onClick={handleConfirmGroups}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                {groupConfirmLoading ? tr('Đang tải...') : tr('Thêm thành viên')}
              </button>
            </div>
          </>
        ) : (
          <>
            {/* Search + select-all (for non-phone modes) */}
            <div className="flex items-center gap-2 px-4 py-2 border-b border-border flex-shrink-0">
              <div className="relative flex-1">
                <svg width="12" height="12" className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
                  viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                </svg>
                <input value={search} onChange={e => setSearch(e.target.value)}
                  placeholder={tr('Tìm tên, SĐT, UID...')}
                  className="w-full bg-muted border border-input rounded-full pl-7 pr-3 py-1.5 text-xs text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500" />
              </div>
              <button onClick={selectAllFiltered} className="text-xs text-blue-400 hover:text-blue-300 flex-shrink-0">
                {trx('Chọn tất cả ({{count}})', { count: filtered.length })}
              </button>
            </div>

            {/* Contact list */}
            <div className="flex-1 overflow-y-auto">
              {loading && (allContacts.length === 0 || contactsOwnerRef.current !== zaloId) ? (
                <div className="p-4 space-y-2">{[...Array(6)].map((_, i) => <div key={i} className="h-10 bg-muted/50 rounded-lg animate-pulse" />)}</div>
              ) : filtered.length === 0 && contactsFailed && allContacts.length === 0 ? (
                <LoadFailedNotice className="py-8" text={tr('Không tải được danh sách liên hệ')} onRetry={loadContacts} busy={loading} />
              ) : filtered.length === 0 && mode === 'by_label' && selectedLocalLabelIds.length > 0 && localLabelMapFailed ? (
                <LoadFailedNotice className="py-8" text={tr('Không tải được Nhãn Local')} onRetry={loadLocalLabels} busy={localLabelsLoading} />
              ) : filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-8">
                  {mode === 'by_label' && totalLabelFilters === 0
                    ? tr('Chọn ít nhất 1 nhãn để lọc liên hệ')
                    : tr('Không tìm thấy liên hệ phù hợp')}
                </p>
              ) : (
                filtered.map(c => {
                  const name = c.alias || c.display_name || c.contact_id;
                  const isChecked = manualSelected.has(c.contact_id);
                  const cidNoPrefix = stripGroupPrefix(c.contact_id);
                  const contactLabels = allLabels.filter(l => l.conversations?.some(conv => stripGroupPrefix(conv) === cidNoPrefix));
                  const contactLocalLabelIds = effectiveThreadMap[c.contact_id] || [];
                  const contactLocalLabels = effectiveLocalLabels.filter(l => contactLocalLabelIds.includes(l.id));
                  return (
                    <label key={c.contact_id}
                      className={`flex items-center gap-2.5 px-4 py-2.5 border-b border-border/50 transition-colors cursor-pointer hover:bg-muted/40 ${
                        isChecked ? 'bg-blue-500/5' : ''
                      }`}>
                      <input type="checkbox" checked={isChecked} className="accent-blue-500 flex-shrink-0"
                        onChange={() => toggleManual(c.contact_id)} />
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
                          <span className="text-xs text-foreground truncate font-medium">{name}</span>
                          {c.contact_type === 'group'
                            ? <span className="text-[9px] text-purple-400 flex-shrink-0 bg-purple-400/10 px-1 rounded">{tr('nhóm')}</span>
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
                      {c.phone && <span className="text-[11px] text-muted-foreground flex-shrink-0">{formatPhone(c.phone)}</span>}
                    </label>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-4 py-3 border-t border-border flex-shrink-0">
              {blockedHint ? (
                <div className="flex-1 min-w-0 text-xs">{blockedHint}</div>
              ) : (
                <span className="text-xs text-muted-foreground flex-1">{trx('{{count}} liên hệ được chọn', { count: finalSelected.length })}</span>
              )}
              <button onClick={onClose} className="px-4 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent">{tr('Hủy')}</button>
              <button disabled={finalSelected.length === 0 || !!blockReason}
                title={blockReason || undefined}
                onClick={() => { onConfirm(finalSelected); onClose(); }}
                className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                {trx('Thêm {{count}} liên hệ', { count: finalSelected.length })}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
