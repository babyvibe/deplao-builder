import React, { useEffect, useCallback, useState } from 'react';
import { useCRMStore, CRMContact } from '@/store/crmStore';
import { useAccountStore } from '@/store/accountStore';
import { useAppStore, LabelData } from '@/store/appStore';
import ipc from '@/lib/ipc';
import CRMContactList from './contacts/CRMContactList';
import CRMContactDetailPanel from './contacts/CRMContactDetailPanel';
import BulkActionBar from './contacts/BulkActionBar';
import CampaignList from './campaigns/CampaignList';
import CampaignDetail from './campaigns/CampaignDetail';
import CampaignCreateModal from './campaigns/CampaignCreateModal';
import CampaignCloneModal from './campaigns/CampaignCloneModal';
import ZaloLabelSelector from './tags/ZaloLabelSelector';
import LocalLabelSelector from '@/components/common/LocalLabelSelector';
import QueueStatusBar from './queue/QueueStatusBar';
import SendHistoryLog from './queue/SendHistoryLog';
import GroupMembersTab from './groups/GroupMembersTab';
import CRMSearchTab from './search/CRMSearchTab';
import CRMRequestsTab from './search/CRMRequestsTab';
import AddToContactsModal from './contacts/AddToContactsModal';
import AccountSelectorDropdown from '@/components/common/AccountSelectorDropdown';


export default function CRMPage() {
  const { activeAccountId, accounts, setActiveAccount } = useAccountStore();
  const { showNotification, openQuickChat, labels, setLabels, navigateToAnalytics, crmRequestUnseenByAccount, clearCRMRequestUnseen } = useAppStore();
  const store = useCRMStore();
  const hasUnreadRequestDot = !!(activeAccountId && crmRequestUnseenByAccount[activeAccountId]);

  const zaloLabels: LabelData[] = activeAccountId ? (labels[activeAccountId] || []) : [];

  const [showCreateCampaign, setShowCreateCampaign] = useState(false);
  const [showCloneCampaign, setShowCloneCampaign] = useState(false);
  const [cloneCampaignId, setCloneCampaignId] = useState<number | null>(null);
  const [showBulkLocalModal, setShowBulkLocalModal] = useState(false);
  const [showBulkZaloModal, setShowBulkZaloModal] = useState(false);
  const [bulkLabelIds, setBulkLabelIds] = useState<number[]>([]);
  const [bulkLocalLabelIds, setBulkLocalLabelIds] = useState<number[]>([]);
  const [applyingBulkLabel, setApplyingBulkLabel] = useState(false);
  const [addToCampaignModal, setAddToCampaignModal] = useState(false);
  const [selectedCampaignForAdd, setSelectedCampaignForAdd] = useState<number | null>(null);
  const [showCreateInAddModal, setShowCreateInAddModal] = useState(false);
  const [showPhoneImport, setShowPhoneImport] = useState(false);


  // ── Local labels state ──────────────────────────────────────────────────
  const [localLabels, setLocalLabels] = useState<Array<{ id: number; name: string; color: string; text_color?: string; emoji?: string }>>([]);
  const [localLabelThreadMap, setLocalLabelThreadMap] = useState<Record<string, number[]>>({});

  const loadLocalLabels = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      const [labelsRes, threadsRes] = await Promise.all([
        ipc.db?.getLocalLabels({ zaloId: activeAccountId }),
        ipc.db?.getLocalLabelThreads({ zaloId: activeAccountId }),
      ]);
      setLocalLabels(labelsRes?.labels || []);
      // Build thread→labelIds map
      const map: Record<string, number[]> = {};
      (threadsRes?.threads || []).forEach((row: any) => {
        if (!map[row.thread_id]) map[row.thread_id] = [];
        map[row.thread_id].push(Number(row.label_id));
      });
      setLocalLabelThreadMap(map);
    } catch {}
  }, [activeAccountId]);

  useEffect(() => { loadLocalLabels(); }, [activeAccountId]);

  // Listen for local-labels-changed to refresh local labels
  useEffect(() => {
    const handler = () => { loadLocalLabels(); };
    window.addEventListener('local-labels-changed', handler);
    return () => window.removeEventListener('local-labels-changed', handler);
  }, [loadLocalLabels]);

  // ── Load data ────────────────────────────────────────────────────────────
  const loadContacts = useCallback(async () => {
    if (!activeAccountId) return;
    store.setContactsLoading(true);
    // Strip client-only filters (has_phone, has_notes) before sending to backend
    const backendContactTypes = store.filterContactTypes.filter(t => t !== 'has_phone' && t !== 'has_notes');
    const res = await ipc.crm?.getContacts({
      zaloId: activeAccountId,
      opts: {
        search: store.searchText,
        contactTypes: backendContactTypes.length > 0 ? backendContactTypes : undefined,
        contactType: backendContactTypes.length === 0 ? 'all' : undefined,
        sortBy: store.sortBy,
        sortDir: store.sortDir,
        limit: store.pageSize,
        offset: store.page * store.pageSize,
      },
    });
    store.setContactsLoading(false);
    if (res?.success) store.setContacts(res.contacts, res.total);
  }, [activeAccountId, store.searchText, store.filterContactTypes, store.sortBy, store.sortDir, store.page]);

  const loadCampaigns = useCallback(async () => {
    if (!activeAccountId) return;
    store.setCampaignsLoading(true);
    const res = await ipc.crm?.getCampaigns({ zaloId: activeAccountId });
    store.setCampaignsLoading(false);
    if (res?.success) store.setCampaigns(res.campaigns);
  }, [activeAccountId]);

  // Load group count from DB eagerly so the tab badge shows before entering the groups page
  const loadGroupCount = useCallback(async () => {
    if (!activeAccountId) return;
    const res = await ipc.db?.getContacts(activeAccountId);
    const allContacts: any[] = res?.contacts ?? res ?? [];
    const count = allContacts.filter((c: any) => c.contact_type === 'group').length;
    store.setGroupCount(count);
  }, [activeAccountId]);

  // Load request count from DB eagerly so the tab badge shows before entering the requests page
  const loadRequestCount = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      const recRes = await ipc.db?.getFriendRequests({ zaloId: activeAccountId, direction: 'received' });
      const count = recRes?.requests?.length ?? 0;
      store.setRequestCount(count);
      if (count === 0) clearCRMRequestUnseen(activeAccountId);
    } catch {}
  }, [activeAccountId, clearCRMRequestUnseen]);

  useEffect(() => { loadContacts(); loadCampaigns(); loadGroupCount(); loadRequestCount(); }, [activeAccountId]);
  useEffect(() => { loadContacts(); }, [store.searchText, store.filterContactTypes, store.sortBy, store.sortDir, store.page]);
  useEffect(() => {
    if (activeAccountId && store.tab === 'requests') {
      clearCRMRequestUnseen(activeAccountId);
    }
  }, [activeAccountId, store.tab, clearCRMRequestUnseen]);

  // ── Load initial queue status when account changes ────────────────────────
  useEffect(() => {
    if (!activeAccountId) return;
    ipc.crm?.getQueueStatus({ zaloId: activeAccountId }).then(res => {
      if (res?.success && res.status) {
        store.updateQueueStatus(activeAccountId, {
          running: res.status.running,
          tokens: res.status.tokens,
          maxTokens: res.status.maxTokens ?? 60,
          lastSentAt: res.status.lastSentAt,
        });
      }
    });
  }, [activeAccountId]);

  // ── Real-time queue events ────────────────────────────────────────────────
  useEffect(() => {
    const unsubUpdate = ipc.on?.('crm:queueUpdate', (data: any) => {
      if (data.zaloId !== activeAccountId) return;
      store.updateQueueStatus(data.zaloId, {
        running: true,
        tokens: data.tokens,
        maxTokens: data.maxTokens ?? 60,
        lastSentAt: data.lastSentAt,
      });
      loadCampaigns();
    });
    // Rate-limited / status-only broadcasts (no send happened)
    const unsubStatus = ipc.on?.('crm:queueStatus', (data: any) => {
      if (data.zaloId !== activeAccountId) return;
      store.updateQueueStatus(data.zaloId, {
        running: data.running ?? true,   // false khi queue dừng hẳn
        tokens: data.tokens,
        maxTokens: data.maxTokens ?? 60,
        lastSentAt: data.lastSentAt,
      });
    });
    const unsubDone = ipc.on?.('crm:campaignDone', (data: any) => {
      if (data.zaloId !== activeAccountId) return;
      showNotification('Chiến dịch đã hoàn thành!', 'success');
      loadCampaigns();
      // Queue có thể đã dừng → refresh trạng thái để ẩn status bar nếu cần
      ipc.crm?.getQueueStatus({ zaloId: activeAccountId }).then(res => {
        if (res?.success && res.status) {
          store.updateQueueStatus(activeAccountId, {
            running: res.status.running,
            tokens: res.status.tokens,
            maxTokens: res.status.maxTokens ?? 60,
            lastSentAt: res.status.lastSentAt,
          });
        }
      });
    });
    return () => { unsubUpdate?.(); unsubStatus?.(); unsubDone?.(); };
  }, [activeAccountId]);

  // ── Campaign actions ─────────────────────────────────────────────────────
  const handleCreateCampaign = async (data: any) => {
    if (!activeAccountId) return;
    const res = await ipc.crm?.saveCampaign({ zaloId: activeAccountId, campaign: data });
    if (res?.success) {
      await loadCampaigns();
      store.setActiveCampaign(res.id);
      showNotification('Đã tạo chiến dịch', 'success');
    }
  };

  const handleUpdateCampaignStatus = async (id: number, status: string) => {
    await ipc.crm?.updateCampaignStatus({ campaignId: id, status });
    await loadCampaigns();
    showNotification(
      status === 'active' ? '▶ Chiến dịch đang chạy'
        : status === 'paused' ? '⏸ Đã tạm dừng'
        : 'Đã cập nhật',
      'info'
    );
  };

  const handleDeleteCampaign = async (id: number) => {
    if (!activeAccountId) return;
    await ipc.crm?.deleteCampaign({ zaloId: activeAccountId, campaignId: id });
    if (store.activeCampaignId === id) store.setActiveCampaign(null);
    await loadCampaigns();
  };

  const handleCloneCampaign = async (includeContacts: boolean, newName: string) => {
    if (!activeAccountId || cloneCampaignId === null) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res: { success: boolean; id?: number; error?: string } | undefined = await (ipc.crm?.cloneCampaign({ zaloId: activeAccountId, campaignId: cloneCampaignId, includeContacts, newName }) as any);
    if (res?.success) {
      await loadCampaigns();
      if (res.id) store.setActiveCampaign(res.id);
      showNotification('Đã nhân bản chiến dịch', 'success');
    } else {
      showNotification('Lỗi nhân bản: ' + (res?.error || 'Không rõ'), 'error');
    }
  };

  const handleAddContactsToCampaign = async (campaignId: number, contacts: any[]) => {
    if (!activeAccountId) return;
    await ipc.crm?.addCampaignContacts({ zaloId: activeAccountId, campaignId, contacts });
    await loadCampaigns();
    showNotification(`Đã thêm ${contacts.length} liên hệ vào chiến dịch`, 'success');
  };

  const handleUpdateCampaign = async (data: any) => {
    if (!activeAccountId || !store.activeCampaignId) return;
    const currentCampaign = store.campaigns.find(c => c.id === store.activeCampaignId);
    const res = await ipc.crm?.saveCampaign({
      zaloId: activeAccountId,
      campaign: {
        ...data,
        id: store.activeCampaignId,
        status: currentCampaign?.status ?? 'draft',  // giữ nguyên trạng thái hiện tại
      },
    });
    if (res?.success) {
      await loadCampaigns();
      showNotification('Đã cập nhật chiến dịch', 'success');
    } else {
      showNotification('Lỗi: Không thể lưu', 'error');
    }
  };

  const handleCreateCampaignInAddModal = async (data: any) => {
    if (!activeAccountId) return;
    const res = await ipc.crm?.saveCampaign({ zaloId: activeAccountId, campaign: data });
    if (res?.success) {
      await loadCampaigns();
      if (res.id) setSelectedCampaignForAdd(res.id);
      showNotification('Đã tạo chiến dịch', 'success');
    }
  };

  // ── Bulk actions ─────────────────────────────────────────────────────────
  const handleBulkAddToCampaign = async () => {
    if (store.campaigns.length === 0) {
      showNotification('Hãy tạo chiến dịch trước', 'info');
      store.setTab('campaigns');
      return;
    }
    setSelectedCampaignForAdd(null);
    setAddToCampaignModal(true);
  };

  const handleBulkTagLocal = () => {
    setBulkLocalLabelIds([]);
    setShowBulkLocalModal(true);
  };

  const handleBulkTagZalo = () => {
    setBulkLabelIds([]);
    setShowBulkZaloModal(true);
  };

  /** Bulk-assign Zalo labels to all selected contacts via Zalo API */
  const handleApplyBulkLabel = async () => {
    if (!activeAccountId || bulkLabelIds.length === 0) return;
    setApplyingBulkLabel(true);
    try {
      const acc = useAccountStore.getState().getActiveAccount();
      if (!acc) throw new Error('No account');
      const auth = { cookies: acc.cookies, imei: acc.imei, userAgent: acc.user_agent };

      // Fetch fresh labels to avoid version mismatch
      const freshRes = await ipc.zalo?.getLabels({ auth });
      const freshLabels: LabelData[] = freshRes?.response?.labelData || zaloLabels;
      const version: number = freshRes?.response?.version || 0;

      const selectedContactIds = [...store.selectedContactIds];
      const updated = freshLabels.map(label => {
        if (!bulkLabelIds.includes(label.id)) return label;
        const existing = new Set(label.conversations || []);
        selectedContactIds.forEach(id => existing.add(id));
        return { ...label, conversations: [...existing] };
      });

      const res = await ipc.zalo?.updateLabels({ auth, labelData: updated, version });
      if (res?.success) {
        const finalLabels: LabelData[] = res.response?.labelData || updated;
        setLabels(activeAccountId, finalLabels);
        // Note: Workflow events are emitted by backend (zaloIpc.ts) to avoid duplicates
        showNotification(`Đã gán nhãn Zalo cho ${store.selectedContactIds.size} liên hệ`, 'success');
        setShowBulkZaloModal(false);
        setBulkLabelIds([]);
        store.clearSelection();
      } else {
        throw new Error(res?.error || 'Không thể gán nhãn');
      }
    } catch (err: any) {
      showNotification('Lỗi: ' + (err?.message || 'Không rõ'), 'error');
    }
    setApplyingBulkLabel(false);
  };

  /** Bulk-assign local labels to all selected contacts via DB */
  const handleApplyBulkLocalLabel = async () => {
    if (!activeAccountId || bulkLocalLabelIds.length === 0) return;
    setApplyingBulkLabel(true);
    try {
      const selectedContactIds = [...store.selectedContactIds];
      for (const labelId of bulkLocalLabelIds) {
        for (const contactId of selectedContactIds) {
          await ipc.db?.assignLocalLabelToThread({ zaloId: activeAccountId, labelId, threadId: contactId });
        }
      }
      // Note: Workflow events are emitted by backend (databaseIpc.ts) to avoid duplicates
      showNotification(`Đã gán Nhãn Local cho ${selectedContactIds.length} liên hệ`, 'success');
      setShowBulkLocalModal(false);
      setBulkLocalLabelIds([]);
      store.clearSelection();
      window.dispatchEvent(new CustomEvent('local-labels-changed', { detail: { zaloId: activeAccountId } }));
      loadLocalLabels();
    } catch (err: any) {
      showNotification('Lỗi: ' + (err?.message || 'Không rõ'), 'error');
    }
    setApplyingBulkLabel(false);
  };

  /** Select ALL contacts across all pages (not just current page) */
  const handleSelectAllPages = useCallback(async () => {
    if (!activeAccountId) return;
    const backendContactTypes = store.filterContactTypes.filter(t => t !== 'has_phone' && t !== 'has_notes');
    const res = await ipc.crm?.getContacts({
      zaloId: activeAccountId,
      opts: {
        search: store.searchText,
        contactTypes: backendContactTypes.length > 0 ? backendContactTypes : undefined,
        contactType: backendContactTypes.length === 0 ? 'all' : undefined,
        sortBy: store.sortBy,
        sortDir: store.sortDir,
        limit: 100000,
        offset: 0,
      },
    });
    if (res?.success) {
      store.selectAllContacts(res.contacts.map((c: any) => c.contact_id));
    }
  }, [activeAccountId, store.searchText, store.filterContactTypes, store.sortBy, store.sortDir]);

  /** Fetch toàn bộ liên hệ theo bộ lọc hiện tại (không phân trang) để xuất CSV */
  const handleExportAll = useCallback(async (): Promise<any[]> => {
    if (!activeAccountId) return [];
    const backendContactTypes = store.filterContactTypes.filter(t => t !== 'has_phone' && t !== 'has_notes');
    const res = await ipc.crm?.getContacts({
      zaloId: activeAccountId,
      opts: {
        search: store.searchText,
        contactTypes: backendContactTypes.length > 0 ? backendContactTypes : undefined,
        contactType: backendContactTypes.length === 0 ? 'all' : undefined,
        sortBy: store.sortBy,
        sortDir: store.sortDir,
        limit: 100000,
        offset: 0,
      },
    });
    return res?.success ? res.contacts : [];
  }, [activeAccountId, store.searchText, store.filterContactTypes, store.sortBy, store.sortDir]);

  const handleMessage = (contact: CRMContact) => {    openQuickChat({
      target: { userId: contact.contact_id, displayName: contact.alias || contact.display_name, avatarUrl: contact.avatar, threadType: 0 },
      zaloId: activeAccountId ?? undefined,
    });
  };

  const queueStatus = store.queueStatus[activeAccountId || ''];
  const activeCampaign = store.campaigns.find(c => c.id === store.activeCampaignId) || null;
  const activeContact = store.contacts.find(c => c.contact_id === store.activeContactId) || null;

  // Client-side filtering: Zalo labels, local labels, has_phone, has_notes
  const filteredContacts = (() => {
    let result = store.contacts;

    // Filter by Zalo labels
    if (store.filterLabelIds.length > 0) {
      result = result.filter(c => {
        const isGroup = c.contact_type === 'group';
        const labelThreadId = isGroup ? `g${c.contact_id}` : c.contact_id;
        return store.filterLabelIds.every(labelId => {
          const convs = zaloLabels.find(l => l.id === labelId)?.conversations;
          return convs?.includes(c.contact_id) || convs?.includes(labelThreadId);
        });
      });
    }

    // Filter by local labels
    if (store.filterLocalLabelIds.length > 0) {
      result = result.filter(c => {
        const threadLIds = localLabelThreadMap[c.contact_id] || [];
        return store.filterLocalLabelIds.every(lid => threadLIds.includes(lid));
      });
    }

    // Client-side filter: has_phone
    if (store.filterContactTypes.includes('has_phone')) {
      result = result.filter(c => !!c.phone);
    }

    // Client-side filter: has_notes
    if (store.filterContactTypes.includes('has_notes')) {
      result = result.filter(c => c.note_count > 0);
    }

    // Client-side filter: gender
    if (store.filterGender === 'male') {
      result = result.filter(c => c.gender === 0);
    } else if (store.filterGender === 'female') {
      result = result.filter(c => c.gender === 1);
    } else if (store.filterGender === 'unknown') {
      result = result.filter(c => c.gender === null || c.gender === undefined);
    }

    // Client-side filter: birthday
    if (store.filterBirthday === 'has_birthday') {
      result = result.filter(c => !!c.birthday);
    } else if (store.filterBirthday === 'no_birthday') {
      result = result.filter(c => !c.birthday);
    } else if (store.filterBirthday === 'today') {
      const now = new Date();
      const todayDD = String(now.getDate()).padStart(2, '0');
      const todayMM = String(now.getMonth() + 1).padStart(2, '0');
      result = result.filter(c => {
        if (!c.birthday) return false;
        const parts = c.birthday.split('/');
        return parts.length >= 2 && parts[0] === todayDD && parts[1] === todayMM;
      });
    } else if (store.filterBirthday === 'this_week') {
      const now = new Date();
      // Build set of DD/MM for the next 7 days (including today)
      const weekDates = new Set<string>();
      for (let i = 0; i < 7; i++) {
        const d = new Date(now);
        d.setDate(d.getDate() + i);
        weekDates.add(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`);
      }
      result = result.filter(c => {
        if (!c.birthday) return false;
        const parts = c.birthday.split('/');
        if (parts.length < 2) return false;
        return weekDates.has(`${parts[0]}/${parts[1]}`);
      });
    } else if (store.filterBirthday === 'this_month') {
      const currentMonth = String(new Date().getMonth() + 1).padStart(2, '0');
      result = result.filter(c => {
        if (!c.birthday) return false;
        // birthday format: DD/MM/YYYY
        const parts = c.birthday.split('/');
        return parts.length >= 2 && parts[1] === currentMonth;
      });
    }

    return result;
  })();

  return (
    <div className="flex flex-col h-full bg-gray-900">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-700 flex-shrink-0 bg-gray-850">
        <div className="flex bg-gray-800 rounded-lg p-0.5">
          {(['search', 'contacts', 'groups', 'requests', 'campaigns', 'history'] as const).map(t => (
            <button key={t} onClick={() => store.setTab(t)}
              className={`px-4 py-1.5 rounded-md text-xs font-medium transition-colors ${store.tab === t ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-gray-200'}`}>
              {t === 'search' ? '🔍 Tìm kiếm'
                : t === 'contacts' ? `👤 Liên hệ${store.totalContacts ? ` (${store.totalContacts})` : ''}`
                : t === 'groups' ? `👥 Nhóm${store.groupCount ? ` (${store.groupCount})` : ''}`
                : t === 'requests' ? (
                  <span className="relative inline-flex items-center gap-1.5">
                    <span>{`📨 Lời mời${store.requestCount ? ` (${store.requestCount})` : ''}`}</span>
                    {hasUnreadRequestDot && (
                      <span className="w-2 h-2 bg-red-500 rounded-full border border-gray-900 flex-shrink-0" />
                    )}
                  </span>
                )
                : t === 'campaigns' ? `📢 Chiến dịch${store.campaigns.length ? ` (${store.campaigns.length})` : ''}`
                : t === 'history' ? '📋 Lịch sử'
                : t}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* Navigate to Analytics / Reports */}
        <button
          onClick={() => navigateToAnalytics('overview')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-white hover:bg-gray-700/60 transition-colors"
          title="Xem báo cáo & phân tích"
        >
          📊
        </button>
        {/* Account selector */}
        <AccountSelectorDropdown
          options={accounts.map(a => ({ id: a.zalo_id, name: a.full_name, phone: a.phone, avatarUrl: a.avatar_url }))}
          activeId={activeAccountId}
          onSelect={setActiveAccount}
        />
      </div>

      {/* Content */}
      <div className="flex flex-1 overflow-hidden flex-col">
        <div className="flex flex-1 overflow-hidden">


          {/* ── Contacts tab ── */}
          {store.tab === 'contacts' && (
            <>
              <div className="flex-1 flex flex-col overflow-hidden">
                <CRMContactList
                  contacts={filteredContacts}
                  total={
                    (store.filterLabelIds.length === 0 && store.filterLocalLabelIds.length === 0
                      && !store.filterContactTypes.includes('has_phone') && !store.filterContactTypes.includes('has_notes')
                      && store.filterGender === 'all' && store.filterBirthday === 'all')
                      ? store.totalContacts
                      : filteredContacts.length
                  }
                  page={store.page}
                  pageSize={store.pageSize}
                  loading={store.contactsLoading}
                  selectedIds={store.selectedContactIds}
                  activeContactId={store.activeContactId}
                  allLabels={zaloLabels}
                  filterLabelIds={store.filterLabelIds}
                  filterLocalLabelIds={store.filterLocalLabelIds}
                  filterContactTypes={store.filterContactTypes}
                  filterGender={store.filterGender}
                  filterBirthday={store.filterBirthday}
                  searchText={store.searchText}
                  sortBy={store.sortBy}
                  sortDir={store.sortDir}
                  activeAccountId={activeAccountId || ''}
                  localLabels={localLabels}
                  localLabelThreadMap={localLabelThreadMap}
                  onSelectContact={store.toggleSelectContact}
                  onActivateContact={id => store.setActiveContact(store.activeContactId === id ? null : id)}
                  onSelectAll={() => store.selectAllContacts(filteredContacts.map(c => c.contact_id))}
                  onClearAll={store.clearSelection}
                  onSelectAllPages={handleSelectAllPages}
                  onExportAll={handleExportAll}
                  onFilterChange={store.setFilter}
                  onPageChange={p => store.setFilter({ page: p })}
                  onMessage={handleMessage}
                  onImportPhones={() => setShowPhoneImport(true)}
                />
              </div>
              {activeContact && (
                <CRMContactDetailPanel
                  contact={activeContact}
                  allLabels={zaloLabels}
                  localLabels={localLabels}
                  localLabelThreadMap={localLabelThreadMap}
                  onClose={() => store.setActiveContact(null)}
                  onMessage={handleMessage}
                />
              )}
            </>
          )}

          {/* ── Campaigns tab ── */}
          {store.tab === 'campaigns' && (
            <>
              <div className="w-72 flex-shrink-0 border-r border-gray-700 overflow-hidden flex flex-col">
                <CampaignList
                  campaigns={store.campaigns}
                  loading={store.campaignsLoading}
                  activeId={store.activeCampaignId}
                  onSelect={store.setActiveCampaign}
                  onCreate={() => setShowCreateCampaign(true)}
                  onDelete={handleDeleteCampaign}
                  onClone={id => { setCloneCampaignId(id); setShowCloneCampaign(true); }}
                  onUpdateStatus={handleUpdateCampaignStatus}
                />
              </div>
              <div className="flex-1 overflow-hidden flex flex-col">
                {activeCampaign ? (
                  <CampaignDetail
                    campaign={activeCampaign}
                    zaloId={activeAccountId || ''}
                    allLabels={zaloLabels}
                    localLabels={localLabels}
                    localLabelThreadMap={localLabelThreadMap}
                    onStatusChange={handleUpdateCampaignStatus}
                    onAddContacts={handleAddContactsToCampaign}
                    onUpdate={handleUpdateCampaign}
                  />
                ) : (
                  <div className="flex flex-col items-center justify-center h-full text-gray-500">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mb-3 opacity-30">
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                    </svg>
                    <p className="text-sm">Chọn chiến dịch để xem chi tiết</p>
                    <button onClick={() => setShowCreateCampaign(true)}
                      className="mt-3 text-xs text-blue-400 hover:text-blue-300">Tạo chiến dịch mới →</button>
                  </div>
                )}
              </div>
            </>
          )}

          {/* ── History tab ── */}
          {store.tab === 'history' && (
            <div className="flex-1 overflow-hidden">
              <SendHistoryLog campaigns={store.campaigns.map(c => ({ id: c.id, name: c.name }))} />
            </div>
          )}

          {/* ── Groups tab ── */}
          {store.tab === 'groups' && <GroupMembersTab />}

          {/* ── Search tab ── */}
          {store.tab === 'search' && (
            <div className="flex-1 overflow-hidden">
              <CRMSearchTab />
            </div>
          )}

          {/* ── Requests tab ── */}
          {store.tab === 'requests' && (
            <div className="flex-1 overflow-hidden">
              <CRMRequestsTab />
            </div>
          )}

        </div>

        <QueueStatusBar status={queueStatus} />
      </div>

      {/* Bulk action bar */}
      <BulkActionBar
        selectedCount={store.selectedContactIds.size}
        onClearSelection={store.clearSelection}
        onAddToCampaign={handleBulkAddToCampaign}
        onBulkTagLocal={handleBulkTagLocal}
        onBulkTagZalo={handleBulkTagZalo}
      />

      {/* ── Modals ── */}
      {showCreateCampaign && (
        <CampaignCreateModal zaloId={activeAccountId || ''} onClose={() => setShowCreateCampaign(false)} onSave={handleCreateCampaign} />
      )}

      {showCloneCampaign && cloneCampaignId !== null && (() => {
        const src = store.campaigns.find(c => c.id === cloneCampaignId);
        return src ? (
          <CampaignCloneModal
            campaignName={src.name}
            totalContacts={src.total_contacts}
            onClose={() => { setShowCloneCampaign(false); setCloneCampaignId(null); }}
            onConfirm={(includeContacts, newName) => handleCloneCampaign(includeContacts, newName)}
          />
        ) : null;
      })()}

      {/* Bulk local label modal (multi-select) */}
      {showBulkLocalModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowBulkLocalModal(false)}>
          <div className="bg-gray-800 border border-gray-600 rounded-2xl w-80 p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-white mb-1">💾 Gán Nhãn Local</h3>
            <p className="text-xs text-gray-400 mb-3">
              Áp dụng cho <span className="text-blue-400 font-medium">{store.selectedContactIds.size}</span> liên hệ đã chọn
              <span className="text-gray-500 ml-1">(chọn nhiều)</span>
            </p>
            {localLabels.length === 0 ? (
              <p className="text-xs text-gray-500 py-4 text-center">Chưa có Nhãn Local nào.</p>
            ) : (
              <LocalLabelSelector
                labels={localLabels}
                selectedIds={bulkLocalLabelIds}
                onChange={setBulkLocalLabelIds}
                placeholder="Chọn Nhãn Local..."
                emptyText="Chưa có Nhãn Local nào"
              />
            )}
            <div className="flex gap-2 mt-4">
              <button onClick={() => setShowBulkLocalModal(false)}
                className="flex-1 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600">
                Hủy
              </button>
              <button onClick={handleApplyBulkLocalLabel}
                disabled={bulkLocalLabelIds.length === 0 || applyingBulkLabel}
                className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                {applyingBulkLabel ? 'Đang gán...' : 'Áp dụng'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Zalo label modal (single-select) */}
      {showBulkZaloModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowBulkZaloModal(false)}>
          <div className="bg-gray-800 border border-gray-600 rounded-2xl w-80 p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-white mb-1">☁️ Gán nhãn Zalo</h3>
            <p className="text-xs text-gray-400 mb-3">
              Áp dụng cho <span className="text-blue-400 font-medium">{store.selectedContactIds.size}</span> liên hệ đã chọn
              <span className="text-gray-500 ml-1">(chỉ 1 nhãn / hội thoại)</span>
            </p>
            {zaloLabels.length === 0 ? (
              <p className="text-xs text-gray-500 py-4 text-center">Chưa có nhãn Zalo nào. Hãy đồng bộ nhãn từ header trước.</p>
            ) : (
              <ZaloLabelSelector
                allLabels={zaloLabels}
                selectedIds={bulkLabelIds}
                onChange={setBulkLabelIds}
                singleSelect
              />
            )}
            <div className="flex gap-2 mt-4">
              <button onClick={() => setShowBulkZaloModal(false)}
                className="flex-1 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600">
                Hủy
              </button>
              <button onClick={handleApplyBulkLabel}
                disabled={bulkLabelIds.length === 0 || applyingBulkLabel}
                className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                {applyingBulkLabel ? 'Đang gán...' : 'Áp dụng'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add to campaign modal */}
      {addToCampaignModal && !showCreateInAddModal && (() => {
        const availableCampaigns = store.campaigns.filter(c => c.status !== 'done');
        return (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
            onClick={() => setAddToCampaignModal(false)}>
            <div className="bg-gray-800 border border-gray-600 rounded-2xl w-80 p-5 shadow-2xl"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-white">Chọn chiến dịch</h3>
                <button
                  onClick={() => setShowCreateInAddModal(true)}
                  className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded-lg hover:bg-blue-500/10">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  Tạo mới
                </button>
              </div>

              {availableCampaigns.length === 0 ? (
                /* ── Empty state ── */
                <div className="flex flex-col items-center py-4 gap-3">
                  <div className="w-12 h-12 rounded-full bg-gray-700 flex items-center justify-center">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-gray-400">
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                    </svg>
                  </div>
                  <p className="text-sm text-gray-300 text-center font-medium">Chưa có chiến dịch phù hợp</p>
                  <p className="text-xs text-gray-500 text-center leading-relaxed">
                    Tất cả chiến dịch đã hoàn thành hoặc chưa có chiến dịch nào.
                  </p>
                  <button
                    onClick={() => setShowCreateInAddModal(true)}
                    className="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors flex items-center justify-center gap-1.5">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Tạo chiến dịch mới
                  </button>
                  <button onClick={() => setAddToCampaignModal(false)}
                    className="w-full py-1.5 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors">
                    Hủy
                  </button>
                </div>
              ) : (
                /* ── Campaign list ── */
                <>
                  <div className="space-y-2 max-h-48 overflow-y-auto">
                    {availableCampaigns.map(c => (
                      <button key={c.id} onClick={() => setSelectedCampaignForAdd(c.id)}
                        className={`w-full text-left px-3 py-2.5 rounded-xl border text-sm transition-colors
                          ${selectedCampaignForAdd === c.id
                            ? 'border-blue-500 bg-blue-500/20 text-white'
                            : 'border-gray-600 text-gray-300 hover:border-gray-500'}`}>
                        <span className="flex items-center gap-1.5">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            c.status === 'active' ? 'bg-green-400' : c.status === 'paused' ? 'bg-yellow-400' : 'bg-gray-500'
                          }`} />
                          {c.name}
                        </span>
                        <span className="block text-xs text-gray-500 mt-0.5 pl-3">{c.total_contacts} liên hệ</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-4">
                    <button onClick={() => setAddToCampaignModal(false)}
                      className="flex-1 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600">Hủy</button>
                    <button disabled={!selectedCampaignForAdd}
                      onClick={async () => {
                        if (!selectedCampaignForAdd || !activeAccountId) return;
                        const contacts = store.contacts
                          .filter(c => store.selectedContactIds.has(c.contact_id))
                          .map(c => ({ contactId: c.contact_id, displayName: c.alias || c.display_name, avatar: c.avatar }));
                        await handleAddContactsToCampaign(selectedCampaignForAdd, contacts);
                        store.clearSelection();
                        setAddToCampaignModal(false);
                      }}
                      className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                      Thêm {store.selectedContactIds.size} liên hệ
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {/* Inline create campaign from add-to-campaign modal */}
      {showCreateInAddModal && (
        <CampaignCreateModal
          zaloId={activeAccountId || ''}
          onClose={() => setShowCreateInAddModal(false)}
          onSave={async (data) => {
            await handleCreateCampaignInAddModal(data);
            setShowCreateInAddModal(false);
          }}
        />
      )}

      {/* ── Phone import modal (Add SĐT to contacts) ── */}
      {showPhoneImport && (
        <AddToContactsModal
          onClose={() => setShowPhoneImport(false)}
          onDone={() => {
            setShowPhoneImport(false);
            loadContacts();
          }}
        />
      )}
    </div>
  );
}

