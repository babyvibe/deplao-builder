import React from 'react';
import { useAppStore } from '@/store/appStore';
import { useAccountStore } from '@/store/accountStore';
import DataAccessor from '@/lib/data/DataAccessor';
import GroupAvatar from '../common/GroupAvatar';
import { HardDriveIcon, CloudIcon } from '@/components/common/icons';
import { formatMsgTime } from '@/lib/chat/messageParser';

export default function ForwardMessageModal({ messages, contacts, onClose, onForward }: {
  messages: any[];
  contacts: any[];
  onClose: () => void;
  onForward: (messages: any[], targets: Array<{ threadId: string; threadType: number }>, composeText: string) => void;
}) {
  const { labels: allLabels, groupInfoCache } = useAppStore();
  const { activeAccountId } = useAccountStore();
  const labels = activeAccountId ? (allLabels[activeAccountId] || []) : [];

  const [search, setSearch] = React.useState('');
  const [tab, setTab] = React.useState<'recent' | 'friends' | 'groups' | 'categories'>('recent');
  const [selectedLabelId, setSelectedLabelId] = React.useState<number | null>(null);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [labelSource, setLabelSource] = React.useState<'local' | 'zalo'>('local');
  const [composeText, setComposeText] = React.useState('');

  // ── Local labels ──────────────────────────────────────────────────────────
  const [localLabels, setLocalLabels] = React.useState<{ id: number; name: string; color: string; text_color?: string; emoji?: string }[]>([]);
  const [localLabelThreadMap, setLocalLabelThreadMap] = React.useState<Record<string, number[]>>({});

  React.useEffect(() => {
    if (!activeAccountId) return;
    (async () => {
      try {
        const [labelsRes, threadsRes] = await Promise.all([
          DataAccessor.getLocalLabels({ zaloId: activeAccountId }),
          DataAccessor.getLocalLabelThreads({ zaloId: activeAccountId }),
        ]);
        const raw = (labelsRes?.labels || [])
          .filter((l: any) => (l?.is_active ?? 1) === 1)
          .sort((a: any, b: any) => {
            const sa = Number(a?.sort_order ?? 0);
            const sb = Number(b?.sort_order ?? 0);
            if (sa !== sb) return sa - sb;
            return String(a?.name || '').localeCompare(String(b?.name || ''));
          });
        setLocalLabels(raw);
        const map: Record<string, number[]> = {};
        (threadsRes?.threads || []).forEach((row: any) => {
          const tid = String(row.thread_id || '');
          if (!tid) return;
          if (!map[tid]) map[tid] = [];
          map[tid].push(Number(row.label_id));
        });
        setLocalLabelThreadMap(map);
      } catch {}
    })();
  }, [activeAccountId]);

  // Build a reverse map: localLabelId -> Set<threadId>
  const localLabelToThreads = React.useMemo(() => {
    const m: Record<number, Set<string>> = {};
    for (const [tid, lids] of Object.entries(localLabelThreadMap)) {
      for (const lid of lids) {
        if (!m[lid]) m[lid] = new Set();
        m[lid].add(tid);
      }
    }
    return m;
  }, [localLabelThreadMap]);

  const activeLabelsForPills = labelSource === 'local' ? localLabels : labels;

  const getFiltered = () => {
    let list = contacts;
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(c => (c.display_name || c.contact_id || '').toLowerCase().includes(q));
    }
    switch (tab) {
      case 'recent':
        return [...list].sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
      case 'friends':
        return list.filter(c => c.contact_type !== 'group').sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
      case 'groups':
        return list.filter(c => c.contact_type === 'group').sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
      case 'categories': {
        if (labelSource === 'local') {
          if (selectedLabelId !== null) {
            const threadSet = localLabelToThreads[selectedLabelId] || new Set();
            return list.filter(c => threadSet.has(c.contact_id));
          }
          // All local-labeled threads
          const allLabeledIds = new Set(Object.keys(localLabelThreadMap));
          return [...list].filter(c => allLabeledIds.has(c.contact_id)).sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
        } else {
          const targetLabel = selectedLabelId !== null ? labels.find(l => l.id === selectedLabelId) : null;
          if (targetLabel) return list.filter(c => targetLabel.conversations.includes(c.contact_id));
          const labeledIds = new Set(labels.flatMap(l => l.conversations));
          return [...list].filter(c => labeledIds.has(c.contact_id)).sort((a, b) => (b.last_message_time || 0) - (a.last_message_time || 0));
        }
      }
      default: return list;
    }
  };

  const filtered = getFiltered();

  const toggleSelect = (contactId: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(contactId)) next.delete(contactId);
      else next.add(contactId);
      return next;
    });
  };

  const handleForward = () => {
    const targets = filtered
      .filter(c => selected.has(c.contact_id))
      .map(c => ({ threadId: c.contact_id, threadType: c.contact_type === 'group' ? 1 : 0 }));
    if (targets.length === 0) return;
    onForward(messages, targets, composeText);
  };

  const msgCount = messages.length;
  const previewText = msgCount === 1
    ? (() => { try { const c = messages[0].content; if (!c || c === 'null') return '[Tin nhắn]'; const p = JSON.parse(c); if (typeof p === 'string') return p; if (p?.title) return `File: ${p.title}`; if (p?.href || p?.thumb) return '[Hình ảnh]'; if (p?.msg) return String(p.msg); return '[Tin nhắn]'; } catch { return messages[0].content || '[Tin nhắn]'; } })()
    : `[${msgCount} tin nhắn]`;

  const TABS: { key: 'recent' | 'friends' | 'groups' | 'categories'; label: string; icon: React.ReactNode }[] = [
    { key: 'recent', label: 'Gần nhất', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
    { key: 'friends', label: 'Bạn bè', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> },
    { key: 'groups', label: 'Nhóm', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87"/><path d="M16 3.13a4 4 0 010 7.75"/></svg> },
    { key: 'categories', label: 'Nhãn', icon: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg> },
  ];

  // Helper to get contact labels for display in categories tab
  const getContactLabelBadges = (contactId: string) => {
    if (labelSource === 'local') {
      const lids = localLabelThreadMap[contactId] || [];
      if (!lids.length) return null;
      const matched = lids.map(lid => localLabels.find(l => l.id === lid)).filter(Boolean) as typeof localLabels;
      if (!matched.length) return null;
      return (
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          {matched.map(l => (
            <span key={l.id} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: (l.color || '#3b82f6') + '30', color: l.color || '#3b82f6', border: `1px solid ${l.color || '#3b82f6'}60` }}>
              {l.emoji ? `${l.emoji} ` : ''}{l.name}
            </span>
          ))}
        </div>
      );
    } else {
      const clabels = labels.filter(l => l.conversations.includes(contactId));
      if (!clabels.length) return null;
      return (
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          {clabels.map(l => (
            <span key={l.id} className="text-[9px] px-1.5 py-0.5 rounded-full" style={{ backgroundColor: (l.color || '#3b82f6') + '30', color: l.color || '#3b82f6', border: `1px solid ${l.color || '#3b82f6'}60` }}>
              {l.emoji} {l.text}
            </span>
          ))}
        </div>
      );
    }
  };

  const grpCache = activeAccountId ? (groupInfoCache[activeAccountId] || {}) : {};

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-gray-800 rounded-2xl shadow-2xl w-[420px] max-h-[85vh] flex flex-col border border-gray-700 overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-700">
          <div>
            <h2 className="text-white font-semibold text-base">Chuyển tiếp {msgCount > 1 ? `${msgCount} tin nhắn` : 'tin nhắn'}</h2>
            <p className="text-xs text-gray-400 mt-0.5 truncate max-w-[300px]">{previewText}</p>
          </div>
          <button onClick={onClose} className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-gray-700 text-gray-400 hover:text-white transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        {/* Compose text */}
        <div className="px-4 py-2.5 border-b border-gray-700 flex-shrink-0">
          <textarea
            value={composeText}
            onChange={e => setComposeText(e.target.value)}
            placeholder="Nhập nội dung kèm..."
            rows={2}
            className="w-full bg-gray-700 border border-gray-600 rounded-lg px-3 py-2 text-sm text-white placeholder-gray-500 resize-none focus:outline-none focus:border-blue-500"
          />
        </div>

        {/* Tabs */}
        <div className="flex border-b border-gray-700 flex-shrink-0">
          {TABS.map(t => (
            <button key={t.key}
              onClick={() => { setTab(t.key); setSelectedLabelId(null); }}
              className={`flex-1 flex items-center justify-center gap-1 py-2.5 text-xs transition-colors border-b-2 ${tab === t.key ? 'border-blue-500 text-blue-400' : 'border-transparent text-gray-400 hover:text-gray-300'}`}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        {/* Label source tabs + filter pills - only for categories tab */}
        {tab === 'categories' && (
          <div className="border-b border-gray-700 flex-shrink-0">
            {/* Local / Zalo sub-tabs */}
            <div className="flex items-center gap-1 px-3 pt-2 pb-1">
              <button
                onClick={() => { setLabelSource('local'); setSelectedLabelId(null); }}
                className={`text-[11px] px-3 py-1 rounded-full border transition-colors ${labelSource === 'local' ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-300'}`}
              ><HardDriveIcon className="w-4 h-4 inline" /> Local</button>
              <button
                onClick={() => { setLabelSource('zalo'); setSelectedLabelId(null); }}
                className={`text-[11px] px-3 py-1 rounded-full border transition-colors ${labelSource === 'zalo' ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-300'}`}
              ><CloudIcon className="w-4 h-4 inline" /> Zalo</button>
            </div>

            {/* Label pills */}
            {activeLabelsForPills.length > 0 && (
              <div className="px-3 py-1.5 flex items-center gap-1.5 overflow-x-auto">
                <button
                  onClick={() => setSelectedLabelId(null)}
                  className={`flex-shrink-0 text-xs px-2.5 py-1 rounded-full border transition-colors ${selectedLabelId === null ? 'bg-blue-600 border-blue-500 text-white' : 'border-gray-600 text-gray-400 hover:border-gray-500'}`}
                >Tất cả</button>
                {labelSource === 'local'
                  ? localLabels.map(l => (
                    <button key={l.id}
                      onClick={() => setSelectedLabelId(selectedLabelId === l.id ? null : l.id)}
                      className={`flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${selectedLabelId === l.id ? 'text-white' : 'text-gray-300 hover:border-gray-400'}`}
                      style={{ borderColor: selectedLabelId === l.id ? (l.color || '#3b82f6') : '#4b5563', backgroundColor: selectedLabelId === l.id ? (l.color || '#3b82f6') + '40' : 'transparent' }}
                    >
                      {l.emoji && <span>{l.emoji}</span>}
                      <span>{l.name}</span>
                    </button>
                  ))
                  : labels.map(l => (
                    <button key={l.id}
                      onClick={() => setSelectedLabelId(selectedLabelId === l.id ? null : l.id)}
                      className={`flex-shrink-0 flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border transition-colors ${selectedLabelId === l.id ? 'text-white' : 'text-gray-300 hover:border-gray-400'}`}
                      style={{ borderColor: selectedLabelId === l.id ? (l.color || '#3b82f6') : '#4b5563', backgroundColor: selectedLabelId === l.id ? (l.color || '#3b82f6') + '40' : 'transparent' }}
                    >
                      {l.emoji && <span>{l.emoji}</span>}
                      <span>{l.text}</span>
                    </button>
                  ))
                }
              </div>
            )}
          </div>
        )}

        {/* Search */}
        <div className="px-4 py-2.5 border-b border-gray-700 flex-shrink-0">
          <div className="relative">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              autoFocus
              placeholder="Tìm hội thoại..."
              className="w-full bg-gray-700 border border-gray-600 rounded-full pl-9 pr-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Contact list */}
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-400">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-2 opacity-40"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
              <p className="text-sm">Không tìm thấy</p>
            </div>
          ) : filtered.map(c => {
            const isSelected = selected.has(c.contact_id);
            return (
              <button
                key={c.contact_id}
                onClick={() => toggleSelect(c.contact_id)}
                className={`w-full flex items-center gap-3 px-4 py-2.5 transition-colors text-left ${isSelected ? 'bg-blue-600/20' : 'hover:bg-gray-700'}`}
              >
                {/* Checkbox */}
                <div className={`w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors ${isSelected ? 'bg-blue-500 border-blue-500' : 'border-gray-500'}`}>
                  {isSelected && (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                  )}
                </div>
                {c.contact_type === 'group' ? (
                  <GroupAvatar
                    avatarUrl={c.avatar_url}
                    groupInfo={grpCache[c.contact_id]}
                    name={c.display_name || c.contact_id}
                    size="md"
                  />
                ) : c.avatar_url ? (
                  <img src={c.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                    onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold flex-shrink-0 bg-blue-600">
                    {(c.display_name || 'U').charAt(0).toUpperCase()}
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-200 truncate">{c.alias || c.display_name || c.contact_id}
                    {c.alias && c.display_name && <span className="text-xs text-gray-400 ml-1">({c.display_name})</span>}</p>
                  {c.contact_type === 'group'
                    ? <p className="text-xs text-gray-400">Nhóm</p>
                    : c.last_message_time
                      ? <p className="text-xs text-gray-400">{formatMsgTime(c.last_message_time)}</p>
                      : null}
                  {tab === 'categories' && getContactLabelBadges(c.contact_id)}
                </div>
              </button>
            );
          })}
        </div>

        {/* Footer */}
        {selected.size > 0 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-700 flex-shrink-0">
            <button
              onClick={() => setSelected(new Set())}
              className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
            >
              Bỏ chọn tất cả
            </button>
            <button
              onClick={handleForward}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Chuyển tiếp ({selected.size})
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
