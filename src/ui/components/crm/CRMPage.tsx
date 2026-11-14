import React, { useEffect, useCallback, useRef, useState } from 'react';
import { useCRMStore, CRMContact } from '@/store/crm/crmStore';
import { useAccountStore } from '@/store/accounts/accountStore';
import { useAppStore, LabelData } from '@/store/app/appStore';
import DataAccessor, { isReadFailure } from '@/lib/data/DataAccessor';
import { useEmployeeResync } from '@/hooks/accounts/useEmployeeResync';
import { relayEventAccount, THREAD_LABELS_CHANGED_EVENT } from '@/lib/chat/realtime/relayUiEvents';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { refreshStaleContacts } from '@/lib/contacts/contactRefresh';
import CRMContactList from './contacts/CRMContactList';
import CRMContactDetailPanel from './contacts/CRMContactDetailPanel';
import BulkActionBar from './contacts/BulkActionBar';
import CampaignList from './campaigns/CampaignList';
import CampaignDetail from './campaigns/CampaignDetail';
import CampaignCreateModal from './campaigns/CampaignCreateModal';
import CampaignCloneModal, { type CampaignCloneOptions } from './campaigns/CampaignCloneModal';
import TargetSelector from './campaigns/TargetSelector';
import ZaloLabelSelector from './tags/ZaloLabelSelector';
import LocalLabelSelector from '@/components/common/inputs/LocalLabelSelector';
import QueueStatusBar from './queue/QueueStatusBar';
import SendHistoryLog from './queue/SendHistoryLog';
import GroupMembersTab from './groups/GroupMembersTab';
import CRMSearchTab from './search/CRMSearchTab';
import CRMRequestsTab from './search/CRMRequestsTab';
import AddToContactsModal from './contacts/AddToContactsModal';
import AccountSelectorDropdown from '@/components/common/accounts/AccountSelectorDropdown';
import { getCapability, resolveAccountChannel, type Channel } from '../../../configs/channels/channelConfig';
import { buildCRMContactFilters } from '../../../shared/crm/crmContactFilters';
import { campaignInvitesToGroups } from '../../../shared/crm/campaignCopy';
import ScanPanel from './scan/ScanPanel';
import ScanHistoryTab from './scan/ScanHistoryTab';
import ScanStatsTab from './scan/ScanStatsTab';
import { Spinner } from '@/components/common/PageLoading';
import { CHANNEL } from '@/lib/channels/channelHelper';
import {
  CampaignIcon, ChartIcon, ClipboardListIcon, CloudIcon, HardDriveIcon, PlusIcon, SearchIcon, SendIcon, UserIcon,
  UserPlusIcon, UsersIcon, WifiIcon
} from '@/components/common/icons';
import { Button, EmptyState } from '@/components/ui';
import { tr, appLocale } from '../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';


/**
 * The account that owns the contact list / campaigns currently in useCRMStore (the store outlives CRMPage).
 * A failed load only keeps the old list when it belongs to the account being viewed.
 */
let crmContactsOwner: string | null = null;
let crmCampaignsOwner: string | null = null;

/** Fixed empty array: `labels[id] || []` creates a new array on every render, which makes the contact query run again and again. */
const NO_LABELS: LabelData[] = [];

/** Short load-error notice above the list: the old data (if any) is still shown, not replaced by "trống" (empty). */
function LoadFailedBanner({ text, onRetry, busy }: { text: string; onRetry: () => void; busy?: boolean }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 px-4 py-2 text-xs text-muted-foreground bg-muted/50 border-b border-border">
      <span>{text}</span>
      <Button variant="link" size="sm" className="text-xs" onClick={onRetry} disabled={busy}>{tr('Thử lại')}</Button>
    </div>
  );
}

// ── Wizard Step Indicator ────────────────────────────────────────────────
function WizardStepIndicator({ currentStep }: { currentStep: number }) {
  const steps = [
    { num: 1, label: tr('Tạo chiến dịch') },
    { num: 2, label: tr('Thêm liên hệ') },
  ];
  return (
    <div className="flex items-center justify-center gap-2 py-3">
      {steps.map((s, i) => (
        <React.Fragment key={s.num}>
          <div className="flex items-center gap-2">
            <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold ${
              s.num < currentStep
                ? 'bg-blue-600 text-white'
                : s.num === currentStep
                  ? 'bg-blue-600/20 text-blue-400 border-2 border-blue-500'
                  : 'bg-muted text-muted-foreground'
            }`}>
              {s.num < currentStep ? '✓' : s.num}
            </div>
            <span className={`text-xs font-medium ${
              s.num <= currentStep ? 'text-foreground' : 'text-muted-foreground'
            }`}>{s.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`w-8 h-0.5 ${
              s.num < currentStep ? 'bg-blue-500' : 'bg-muted'
            }`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

export default function CRMPage() {
  const { activeAccountId, accounts, setActiveAccount } = useAccountStore();
  const { showNotification, openQuickChat, labels, setLabels, navigateToAnalytics, crmRequestUnseenByAccount, clearCRMRequestUnseen } = useAppStore();
  const store = useCRMStore();
  const hasUnreadRequestDot = !!(activeAccountId && crmRequestUnseenByAccount[activeAccountId]);

  // Red dot on the Groups tab → Member scan (not seen yet)
  const [hasScanNewDot, setHasScanNewDot] = useState(() => {
    try { return localStorage.getItem('scanTabSeen') !== 'true'; } catch { return false; }
  });

  const activeAccount = accounts.find(a => a.zalo_id === activeAccountId);
  const channelCap = getCapability((activeAccount?.channel || CHANNEL.ZALO) as Channel);

  const zaloLabels: LabelData[] = (activeAccountId && labels[activeAccountId]) || NO_LABELS;
  // The conversation list of a Zalo label only affects the query when filtering by a Zalo label
  const labelsForFilter = store.filterLabelIds.length > 0 ? zaloLabels : NO_LABELS;

  const [showCreateCampaign, setShowCreateCampaign] = useState(false);
  const [showCloneCampaign, setShowCloneCampaign] = useState(false);
  const [cloneCampaignId, setCloneCampaignId] = useState<number | null>(null);
  const [showBulkLocalModal, setShowBulkLocalModal] = useState(false);
  const [showBulkZaloModal, setShowBulkZaloModal] = useState(false);
  const [bulkLabelIds, setBulkLabelIds] = useState<number[]>([]);
  const [bulkLocalLabelIds, setBulkLocalLabelIds] = useState<number[]>([]);
  const [applyingBulkLabel, setApplyingBulkLabel] = useState(false);
  const [showLeaveGroupConfirm, setShowLeaveGroupConfirm] = useState(false);
  const [leavingGroups, setLeavingGroups] = useState(false);
  const [addToCampaignModal, setAddToCampaignModal] = useState(false);
  const [selectedCampaignForAdd, setSelectedCampaignForAdd] = useState<number | null>(null);
  const [showCreateInAddModal, setShowCreateInAddModal] = useState(false);
  const [showPhoneImport, setShowPhoneImport] = useState(false);

  // ── Campaign creation wizard state ──────────────────────────────────
  const [wizardActive, setWizardActive] = useState(false);
  const [wizardStep, setWizardStep] = useState(0); // 0=off, 2=add contacts
  const [wizardCampaignId, setWizardCampaignId] = useState<number | null>(null);


  // ── Local labels state ──────────────────────────────────────────────────
  const [localLabels, setLocalLabels] = useState<Array<{ id: number; name: string; color: string; text_color?: string; emoji?: string }>>([]);
  const [localLabelThreadMap, setLocalLabelThreadMap] = useState<Record<string, number[]>>({});

  // The last load failed (employee: lost connection to BOSS): the list on screen is old data / empty because of the error
  const [contactsLoadFailed, setContactsLoadFailed] = useState(false);
  const [campaignsLoadFailed, setCampaignsLoadFailed] = useState(false);

  // The account of the Local label on screen: keep the old data on error only if it belongs to the account being viewed
  const labelsOwnerRef = useRef<string | null>(null);

  const loadLocalLabels = useCallback(async () => {
    if (!activeAccountId) return;
    const accountId = activeAccountId;
    try {
      const [labelsRes, threadsRes] = await Promise.all([
        DataAccessor.getLocalLabels({ zaloId: accountId }),
        DataAccessor.getLocalLabelThreads({ zaloId: accountId }),
      ]);
      const labelsFailed = isReadFailure(labelsRes);
      const threadsFailed = isReadFailure(threadsRes);
      if ((labelsFailed || threadsFailed) && labelsOwnerRef.current !== accountId) {
        // Error right after changing the account: do not let the previous account's labels show (and be filtered / assigned) for this account
        setLocalLabels([]);
        setLocalLabelThreadMap({});
      }
      labelsOwnerRef.current = accountId;
      // Error → keep the labels / label assignments of the account (they used to be replaced with empty)
      if (!labelsFailed) setLocalLabels(labelsRes?.labels || []);
      if (threadsFailed) return;
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

  // Listen for local-labels-changed to refresh local labels: both assigning and removing labels on the open account, made by Boss or another
  // employee (relay db:localLabelThreadChanged → 'ui:threadLabelsChanged'; before this the CRM list did not know about it)
  useEffect(() => {
    // Filtering by Local Label (filtered in the DB) → reload the whole contact list
    const reloadLabels = () => {
      loadLocalLabels();
      if (useCRMStore.getState().filterLocalLabelIds.length > 0) loadContactsRef.current();
    };
    const handler = () => { reloadLabels(); };
    const handleThreadLabels = (e: Event) => {
      const owner = relayEventAccount((e as CustomEvent).detail);
      if (!owner || owner === activeAccountId) reloadLabels();
    };
    window.addEventListener('local-labels-changed', handler);
    window.addEventListener(THREAD_LABELS_CHANGED_EVENT, handleThreadLabels);
    return () => {
      window.removeEventListener('local-labels-changed', handler);
      window.removeEventListener(THREAD_LABELS_CHANGED_EVENT, handleThreadLabels);
    };
  }, [loadLocalLabels, activeAccountId]);

  // ── Load data ────────────────────────────────────────────────────────────
  /**
   * Query options for the selected filters, shared by the list (1 page) and the CSV export (everything).
   * Label / Has phone / Has note / Gender / Birthday are filtered in the DB before the page is cut: before, they only filtered the page
   * being loaded (contacts on other pages never matched, and paging broke) and the CSV export ignored them.
   */
  const contactQuery = useCallback((range: { limit: number; offset: number }) => {
    const backendContactTypes = store.filterContactTypes.filter(t => t !== 'has_phone' && t !== 'has_notes');
    return {
      search: store.searchText,
      contactTypes: backendContactTypes.length > 0 ? backendContactTypes : undefined,
      contactType: backendContactTypes.length === 0 ? 'all' : undefined,
      sortBy: store.sortBy,
      sortDir: store.sortDir,
      filters: buildCRMContactFilters({
        filterLabelIds: store.filterLabelIds,
        filterLocalLabelIds: store.filterLocalLabelIds,
        filterContactTypes: store.filterContactTypes,
        filterGender: store.filterGender,
        filterBirthday: store.filterBirthday,
      }, labelsForFilter),
      ...range,
    };
  }, [store.searchText, store.filterContactTypes, store.sortBy, store.sortDir, store.filterLabelIds,
    store.filterLocalLabelIds, store.filterGender, store.filterBirthday, labelsForFilter]);

  // Filters changed continuously → several loads overlapping: only accept the result of the latest one
  const contactsSeqRef = useRef(0);
  const loadContacts = useCallback(async () => {
    if (!activeAccountId) return;
    const seq = ++contactsSeqRef.current;
    store.setContactsLoading(true);
    const res = await DataAccessor.getCRMContacts({
      zaloId: activeAccountId,
      opts: contactQuery({ limit: store.pageSize, offset: store.page * store.pageSize }),
    });
    if (seq !== contactsSeqRef.current) return;
    store.setContactsLoading(false);
    // Error → KEEP the account's current list (do not replace it with empty) + show "Không tải được - Thử lại" (Failed to load - Retry)
    const failed = isReadFailure(res);
    setContactsLoadFailed(failed);
    if (res?.success) {
      crmContactsOwner = activeAccountId;
      store.setContacts(res.contacts, res.total);
      // Refresh the names / avatars of old contacts in the background (fire-and-forget; skipped in employee mode and for channels other than Zalo)
      refreshStaleContacts(activeAccountId, res.contacts).catch(() => {});
    } else if (failed && crmContactsOwner !== activeAccountId) {
      // The list on screen belongs to another account: do not keep it (bulk actions would hit the wrong contacts)
      crmContactsOwner = activeAccountId;
      store.setContacts([], 0);
    }
  }, [activeAccountId, contactQuery, store.page, store.pageSize]);
  const loadContactsRef = useRef(loadContacts);
  loadContactsRef.current = loadContacts;

  const loadCampaigns = useCallback(async () => {
    if (!activeAccountId) return;
    store.setCampaignsLoading(true);
    const res = await DataAccessor.getCRMCampaigns({ zaloId: activeAccountId });
    store.setCampaignsLoading(false);
    const failed = isReadFailure(res);
    setCampaignsLoadFailed(failed);
    if (res?.success) {
      crmCampaignsOwner = activeAccountId;
      store.setCampaigns(res.campaigns);
    } else if (failed && crmCampaignsOwner !== activeAccountId) {
      // The campaign on screen belongs to another account: do not keep it
      crmCampaignsOwner = activeAccountId;
      store.setCampaigns([]);
    }
  }, [activeAccountId]);

  // Load group count from DB eagerly so the tab badge shows before entering the groups page
  const loadGroupCount = useCallback(async () => {
    if (!activeAccountId) return;
    const res = await DataAccessor.getConversations(activeAccountId, 999, 0);
    if (isReadFailure(res)) return; // read error ≠ 0 groups: keep the number on screen
    const allContacts = res?.items || [];
    const count = (allContacts || []).filter((c: any) =>
      c.contact_type === 'group' && !(String(c.channel || '').startsWith('telegram') && c.telegram_peer_type === 'channel')
    ).length;
    store.setGroupCount(count);
  }, [activeAccountId]);

  // Load request count from DB eagerly so the tab badge shows before entering the requests page
  const loadRequestCount = useCallback(async () => {
    if (!activeAccountId) return;
    try {
      const recRes = await DataAccessor.getFriendRequests({ zaloId: activeAccountId, direction: 'received' });
      if (isReadFailure(recRes)) return; // read error ≠ 0 requests: keep the number + red dot on screen
      const count = recRes?.requests?.length ?? 0;
      store.setRequestCount(count);
      if (count === 0) clearCRMRequestUnseen(activeAccountId);
    } catch {}
  }, [activeAccountId, clearCRMRequestUnseen]);

  useEffect(() => {
    const disabledTabs: Record<string, boolean> = {
      search: !channelCap.supportsCRMSearch,
      requests: !channelCap.supportsFriendRequest,
      campaigns: !channelCap.supportsCampaigns,
      history: !channelCap.supportsCRMHistory,
      groups: !channelCap.supportsCRMGroups,
      scan: !channelCap.supportsScanData,
      scan_history: !channelCap.supportsScanData,
      scan_stats: !channelCap.supportsScanData,
    };
    if (disabledTabs[store.tab]) store.setTab('contacts');
    // Do not leave a filter that only makes sense on Zalo hanging when switching accounts.
    // If kept, the UI has hidden the filter but the Telegram query would still return empty.
    if (!channelCap.supportsLabel) {
      store.setFilter({ filterLabelIds: [] });
    }
    if ((activeAccount?.channel || CHANNEL.ZALO) !== CHANNEL.ZALO) {
      store.setFilter({
        filterContactTypes: store.filterContactTypes.filter(t => t !== 'friend' && t !== 'non_friend'),
        filterGender: 'all',
        filterBirthday: 'all',
      });
    }
    loadContacts(); loadCampaigns(); loadGroupCount(); loadRequestCount();
  }, [activeAccountId]);
  // contactQuery changes on search / sort / any filter (including the conversations of the Zalo label being filtered) change
  useEffect(() => { loadContacts(); }, [contactQuery, store.page, store.pageSize]);

  // Listen for crm-contacts-changed to refresh contacts list (e.g. after AddToContactsModal)
  useEffect(() => {
    const handler = () => { loadContacts(); };
    window.addEventListener('crm-contacts-changed', handler);
    return () => window.removeEventListener('crm-contacts-changed', handler);
  }, [loadContacts]);

  useEffect(() => {
    if (activeAccountId && store.tab === 'requests') {
      clearCRMRequestUnseen(activeAccountId);
    }
  }, [activeAccountId, store.tab, clearCRMRequestUnseen]);

  // ── Employee mode: BOSS connection restored → reload the CRM data on screen ──
  // (the failed load while the connection was lost kept the old data; now refresh). The sub-tabs load themselves when reopened.
  useEmployeeResync(() => Promise.allSettled([
    loadContacts(), loadCampaigns(), loadGroupCount(), loadRequestCount(), loadLocalLabels(),
  ]));

  // ── Load initial queue status when account changes ────────────────────────
  useEffect(() => {
    if (!activeAccountId) return;
    DataAccessor.getQueueStatus({ zaloId: activeAccountId }).then(res => {
      if (res?.success && res.status) {
        store.updateQueueStatus(activeAccountId, {
          running: res.status.running,
          tokens: res.status.tokens,
          maxTokens: res.status.maxTokens ?? 60,
          lastSentAt: res.status.lastSentAt,
          dailyPaused: res.status.dailyPaused,
        });
      }
    });
  }, [activeAccountId]);

  // ── Real-time queue events ────────────────────────────────────────────────
  useEffect(() => {
    // Each campaign message sent = 1 crm:queueUpdate; the catch-up after an employee reconnects replays the whole batch → merged
    // into the campaign list reloads (before, each event made one call to BOSS)
    let reloadTimer: ReturnType<typeof setTimeout> | null = null;
    const reloadCampaignsSoon = () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { reloadTimer = null; loadCampaigns(); }, 400);
    };
    const unsubUpdate = ipc.on?.('crm:queueUpdate', (data: any) => {
      if (data?.zaloId !== activeAccountId) return;
      store.updateQueueStatus(data.zaloId, {
        running: true,
        tokens: data.tokens,
        maxTokens: data.maxTokens ?? 60,
        lastSentAt: data.lastSentAt,
        dailyPaused: false,
      });
      reloadCampaignsSoon();
    });
    // Rate-limited / status-only broadcasts (no send happened)
    const unsubStatus = ipc.on?.('crm:queueStatus', (data: any) => {
      if (data.zaloId !== activeAccountId) return;
      store.updateQueueStatus(data.zaloId, {
        running: data.running ?? true,   // false when the queue has fully stopped
        tokens: data.tokens,
        maxTokens: data.maxTokens ?? 60,
        lastSentAt: data.lastSentAt,
        dailyPaused: data.dailyPaused,
      });
    });
    const unsubDone = ipc.on?.('crm:campaignDone', (data: any) => {
      if (data.zaloId !== activeAccountId) return;
      showNotification(tr('Chiến dịch đã hoàn thành!'), 'success');
      loadCampaigns();
      // The queue may have stopped → refresh the state to hide the status bar if needed
      DataAccessor.getQueueStatus({ zaloId: activeAccountId }).then(res => {
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
    // Remote campaign changes (boss/employee sync)
    const handleCampaignChange = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.ownerZaloId || detail.ownerZaloId === activeAccountId) {
        reloadCampaignsSoon();
      }
    };
    window.addEventListener('ui:campaignChanged', handleCampaignChange);
    return () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      unsubUpdate?.(); unsubStatus?.(); unsubDone?.();
      window.removeEventListener('ui:campaignChanged', handleCampaignChange);
    };
  }, [activeAccountId]);

  // ── Campaign actions ─────────────────────────────────────────────────────
  const handleCreateCampaign = async (data: any) => {
    // activeAccountId can still be null if you click right at startup (the account has not finished auto-selecting yet).
    // Fall back to the first account in the store so the create action is not lost.
    const acctId = activeAccountId || accounts?.[0]?.zalo_id;
    if (!acctId) return;
    if (!activeAccountId) setActiveAccount(acctId);
    const res = await DataAccessor.saveCRMCampaign({ zaloId: acctId, campaign: data });
    if (res?.success) {
      await loadCampaigns();
      store.setActiveCampaign(res.id);
      showNotification(tr('Đã tạo chiến dịch'), 'success');
      // Wizard flow: advance to step 2 (add contacts) after saving
      if (wizardActive) {
        setWizardCampaignId(res.id);
        setShowCreateCampaign(false);
        setWizardStep(2);
      }
    }
  };

  const handleUpdateCampaignStatus = async (id: number, status: string) => {
    const res = await DataAccessor.updateCampaignStatus({ campaignId: id, status });
    await loadCampaigns();
    // Refused (e.g. a copy for another account with no invite group picked yet): say why instead of "đang chạy"
    if (res && res.success === false) {
      showNotification(res.error || tr('Không đổi được trạng thái chiến dịch'), 'error');
      return;
    }
    showNotification(
      status === 'active' ? tr('▶ Chiến dịch đang chạy')
        : status === 'paused' ? tr('⏸ Đã tạm dừng')
        : tr('Đã cập nhật'),
      'info'
    );
  };

  const handleDeleteCampaign = async (id: number) => {
    if (!activeAccountId) return;
    await DataAccessor.deleteCRMCampaign({ zaloId: activeAccountId, campaignId: id });
    if (store.activeCampaignId === id) store.setActiveCampaign(null);
    await loadCampaigns();
  };

  const handleCloneCampaign = async ({ includeContacts, newName, targetIds }: CampaignCloneOptions) => {
    if (!activeAccountId || cloneCampaignId === null) return;
    const res = await DataAccessor.cloneCampaign({
      zaloId: activeAccountId, campaignId: cloneCampaignId, includeContacts, newName, targetZaloIds: targetIds,
    });
    if (!res?.success) {
      showNotification(tr('Lỗi nhân bản: {{v1}}', { v1: (res?.error || tr('Không rõ')) }), 'error');
      return;
    }
    // An older Boss answers with the owner's copy id only
    const copies = Array.isArray(res.copies) ? res.copies : (res.id ? [{ zaloId: activeAccountId, id: res.id, contacts: 0, inviteGroupsCleared: false }] : []);
    const failed = Array.isArray(res.failed) ? res.failed : [];
    // The list shows this account's campaigns: open its copy; copies in other accounts show under those accounts
    const ownCopy = copies.find(copy => copy.zaloId === activeAccountId);
    if (ownCopy) {
      await loadCampaigns();
      store.setActiveCampaign(ownCopy.id);
    }
    const otherCopy = copies.find(copy => copy.zaloId !== activeAccountId);
    if (failed.length > 0) {
      showNotification(tr('Đã nhân bản sang {{done}}/{{total}} tài khoản. Lỗi: {{v1}}', {
        done: copies.length, total: copies.length + failed.length, v1: failed[0].error,
      }), 'warning');
    } else if (!otherCopy) {
      showNotification(tr('Đã nhân bản chiến dịch'), 'success');
    } else if (includeContacts) {
      // Other accounts only get the recipients they can find by phone number (shared/crm/campaignCopy)
      showNotification(tr('Đã nhân bản sang {{count}} tài khoản, tài khoản khác nhận {{v1}} người nhận có SĐT', {
        count: copies.length, v1: otherCopy.contacts.toLocaleString(appLocale()),
      }), 'success');
    } else {
      showNotification(tr('Đã nhân bản sang {{count}} tài khoản', { count: copies.length }), 'success');
    }
  };

  // From the campaign screen → filter by result (e.g. "Đã xem, chưa phản hồi" (Seen, not replied yet)) → the new draft campaign only includes those contacts
  const handleCreateCampaignFromContacts = async (sourceCampaignId: number, contactIds: string[], newName: string) => {
    if (!activeAccountId || contactIds.length === 0) return;
    const res: { success: boolean; id?: number; error?: string } | undefined = await (DataAccessor.cloneCampaign({
      zaloId: activeAccountId, campaignId: sourceCampaignId, includeContacts: true, newName, contactIds,
    }) as any);
    if (res?.success) {
      await loadCampaigns();
      if (res.id) store.setActiveCampaign(res.id);
      showNotification(tr('Đã tạo chiến dịch nháp với {{v1}} liên hệ', { v1: contactIds.length.toLocaleString(appLocale()) }), 'success');
    } else {
      showNotification(tr('Không tạo được chiến dịch: {{v1}}', { v1: (res?.error || tr('Không rõ')) }), 'error');
    }
  };

  const handleAddContactsToCampaign = async (campaignId: number, contacts: any[]): Promise<boolean> => {
    if (!activeAccountId) return false;
    let res: any;
    try {
      res = await DataAccessor.addCampaignContacts({ zaloId: activeAccountId, campaignId, contacts });
    } catch (err: any) {
      res = { success: false, error: err?.message };
    }
    await loadCampaigns();
    if (!res?.success) {
      showNotification(tr('Không thêm được liên hệ vào chiến dịch: {{v1}}', { v1: (res?.error || tr('lỗi không rõ')) }), 'error');
      return false;
    }
    showNotification(tr('Đã thêm {{count}} liên hệ vào chiến dịch', { count: contacts.length }), 'success');
    return true;
  };

  const handleUpdateCampaign = async (data: any) => {
    if (!activeAccountId || !store.activeCampaignId) return;
    const currentCampaign = store.campaigns.find(c => c.id === store.activeCampaignId);
    const res = await DataAccessor.saveCRMCampaign({
      zaloId: activeAccountId,
      campaign: {
        ...data,
        id: store.activeCampaignId,
        status: currentCampaign?.status ?? 'draft',  // keep the current state
      },
    });
    if (res?.success) {
      await loadCampaigns();
      showNotification(tr('Đã cập nhật chiến dịch'), 'success');
    } else {
      showNotification(tr('Lỗi: Không thể lưu'), 'error');
    }
  };

  const handleCreateCampaignInAddModal = async (data: any) => {
    if (!activeAccountId) return;
    const res = await DataAccessor.saveCRMCampaign({ zaloId: activeAccountId, campaign: data });
    if (res?.success) {
      await loadCampaigns();
      if (res.id) setSelectedCampaignForAdd(res.id);
      showNotification(tr('Đã tạo chiến dịch'), 'success');
    }
  };

  // ── Wizard handlers ─────────────────────────────────────────────────────
  const handleWizardConfirmTargets = async (contacts: any[]) => {
    if (!wizardCampaignId || !activeAccountId) return;
    const toAdd = contacts.map(c => ({
      contactId: c.contact_id,
      displayName: c.alias || c.display_name,
      avatar: c.avatar,
      phone: c.phone || '',
    }));
    const added = await handleAddContactsToCampaign(wizardCampaignId, toAdd);
    if (!added) return; // keep the wizard open so the user can retry
    // Wizard complete
    setWizardActive(false);
    setWizardStep(0);
    setWizardCampaignId(null);
  };

  const handleWizardDismiss = () => {
    setWizardActive(false);
    setWizardStep(0);
    setWizardCampaignId(null);
  };

  const handleWizardCreateClose = () => {
    // On close in wizard mode = advance to step 2
    setShowCreateCampaign(false);
    setWizardStep(2);
  };

  const startWizard = () => {
    setWizardActive(true);
    setWizardStep(0);
    setWizardCampaignId(null);
    setShowCreateCampaign(true);
  };

  // ── Bulk actions ─────────────────────────────────────────────────────────
  const handleBulkAddToCampaign = async () => {
    if (store.campaigns.length === 0) {
      showNotification(tr('Hãy tạo chiến dịch trước'), 'info');
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
      const auth = buildZaloAuth(acc, activeAccountId);

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
        showNotification(tr('Đã gán nhãn Zalo cho {{count}} liên hệ', { count: store.selectedContactIds.size }), 'success');
        setShowBulkZaloModal(false);
        setBulkLabelIds([]);
        store.clearSelection();
      } else {
        throw new Error(res?.error || tr('Không thể gán nhãn'));
      }
    } catch (err: any) {
      showNotification(tr('Lỗi: {{v1}}', { v1: (err?.message || tr('Không rõ')) }), 'error');
    }
    setApplyingBulkLabel(false);
  };

  /** Bulk-assign local labels to all selected contacts via DB */
  const handleApplyBulkLocalLabel = async () => {
    if (!activeAccountId || bulkLocalLabelIds.length === 0) return;
    setApplyingBulkLabel(true);
    try {
      const selectedContactIds = [...store.selectedContactIds];
      // Single bulk call with a transaction, instead of thousands of separate IPC calls
      const res = await DataAccessor.bulkAssignLocalLabelToThread({
        zaloId: activeAccountId,
        labelIds: bulkLocalLabelIds,
        threadIds: selectedContactIds,
      });
      const count = res?.count ?? (bulkLocalLabelIds.length * selectedContactIds.length);
      showNotification(tr('Đã gán Nhãn Local cho {{count}} liên hệ ({{count1}} assignments)', { count: selectedContactIds.length, count1: count }), 'success');
      setShowBulkLocalModal(false);
      setBulkLocalLabelIds([]);
      store.clearSelection();
      window.dispatchEvent(new CustomEvent('local-labels-changed', { detail: { zaloId: activeAccountId } }));
      loadLocalLabels();
    } catch (err: any) {
      showNotification(tr('Lỗi: {{v1}}', { v1: (err?.message || tr('Không rõ')) }), 'error');
    }
    setApplyingBulkLabel(false);
  };

  /** Bulk leave groups: leave all the selected groups */
  const handleBulkLeaveGroup = () => setShowLeaveGroupConfirm(true);

  const handleConfirmLeaveGroups = async () => {
    if (!activeAccountId) return;
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) return;
    const auth = buildZaloAuth(acc, activeAccountId);

    setLeavingGroups(true);
    const groupIds = store.contacts
      .filter(c => store.selectedContactIds.has(c.contact_id) && c.contact_type === 'group')
      .map(c => c.contact_id);

    let ok = 0, fail = 0;
    for (const groupId of groupIds) {
      try {
        const res = await ipc.zalo?.leaveGroup({ auth, groupId });
        if (res?.success) ok++;
        else fail++;
      } catch {
        fail++;
      }
      // polite delay
      if (groupIds.indexOf(groupId) < groupIds.length - 1) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
    setLeavingGroups(false);
    setShowLeaveGroupConfirm(false);
    store.clearSelection();
    if (ok > 0) {
      showNotification(tr('Đã rời {{ok}} nhóm{{v1}}', { ok, v1: fail > 0 ? tr(', thất bại {{fail}}', { fail }) : '' }), fail > 0 ? 'info' : 'success');
      await loadContacts();
    } else {
      showNotification(tr('Không thể rời nhóm ({{fail}} lỗi)', { fail }), 'error');
    }
  };

  /** Fetch all contacts for the current filter (no paging) for CSV export: same filter as the list */
  const handleExportAll = useCallback(async (): Promise<any[]> => {
    if (!activeAccountId) return [];
    const res = await DataAccessor.getCRMContacts({
      zaloId: activeAccountId,
      opts: contactQuery({ limit: 100000, offset: 0 }),
    });
    return res?.success ? res.contacts : [];
  }, [activeAccountId, contactQuery]);

  const handleMessage = (contact: CRMContact) => {    openQuickChat({
      target: { userId: contact.contact_id, displayName: contact.alias || contact.display_name, avatarUrl: contact.avatar, threadType: 0 },
      zaloId: activeAccountId ?? undefined,
    });
  };

  const queueStatus = store.queueStatus[activeAccountId || ''];
  const activeCampaign = store.campaigns.find(c => c.id === store.activeCampaignId) || null;
  const activeContact = store.contacts.find(c => c.contact_id === store.activeContactId) || null;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Top bar */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border flex-shrink-0 bg-card">
        <div className="flex bg-muted rounded-lg p-0.5">
          {(['search', 'contacts', 'groups', 'requests', 'campaigns', 'history', 'scan', 'scan_history', 'scan_stats'] as const).filter(t => {
            if (t === 'search') return channelCap.supportsCRMSearch;
            if (t === 'requests') return channelCap.supportsFriendRequest;
            if (t === 'campaigns') return channelCap.supportsCampaigns;
            if (t === 'history') return channelCap.supportsCRMHistory;
            if (t === 'groups') return channelCap.supportsCRMGroups;
            if (t === 'scan' || t === 'scan_history' || t === 'scan_stats') return channelCap.supportsScanData;
            return true; // contacts always shown
          }).map(t => (
            <button key={t} onClick={() => {
              store.setTab(t);
              if (t === 'groups' && hasScanNewDot) {
                setHasScanNewDot(false);
                try { localStorage.setItem('scanTabSeen', 'true'); } catch {}
              }
            }}
              className={`px-4 py-1.5 rounded-md text-xs font-medium flex transition-colors ${store.tab === t ? 'bg-blue-600 text-white' : 'text-muted-foreground hover:text-foreground'}`}>
              {t === 'search' ? <>{trx('<0/> Tìm kiếm', { 0: <SearchIcon className="w-4 h-4 mr-2" /> })}</>
                : t === 'contacts' ? <>{trx('<0/> Liên hệ{{v1}}', { 0: <UserIcon className="w-4 h-4 mr-2" />, v1: store.totalContacts ? ` (${store.totalContacts})` : '' })}</>
                : t === 'groups' ? (
                  <span className="relative inline-flex items-center gap-1.5">
                    <span className="flex">{trx('<0/> Nhóm{{v1}}', { 0: <UsersIcon className="w-4 h-4 mr-2" />, v1: store.groupCount ? ` (${store.groupCount})` : '' })}</span>
                    {hasScanNewDot && (
                      <span className="w-2 h-2 bg-red-500 rounded-full border border-border flex-shrink-0 animate-pulse" />
                    )}
                  </span>
                )
                : t === 'requests' ? (
                  <span className="relative inline-flex items-center gap-1.5">
                    <span className="flex">{trx('<0/> Lời mời{{v1}}', { 0: <UserPlusIcon className="w-4 h-4 mr-2" />, v1: store.requestCount ? ` (${store.requestCount})` : '' })}</span>
                    {hasUnreadRequestDot && (
                      <span className="w-2 h-2 bg-red-500 rounded-full border border-border flex-shrink-0" />
                    )}
                  </span>
                )
                : t === 'campaigns' ? <>{trx('<0/> Chiến dịch{{v1}}', { 0: <CampaignIcon className="w-4 h-4 mr-2" />, v1: store.campaigns.length ? ` (${store.campaigns.length})` : '' })}</>
                : t === 'history' ? <>{trx('<0/> Lịch sử', { 0: <ClipboardListIcon className="w-4 h-4 mr-2" /> })}</>
                : t === 'scan' ? <>{trx('<0/> Quét dữ liệu', { 0: <SearchIcon className="w-4 h-4 mr-2" /> })}</>
                : t === 'scan_history' ? <>{trx('<0/> Lịch sử quét', { 0: <ClipboardListIcon className="w-4 h-4 mr-2" /> })}</>
                : t === 'scan_stats' ? <>{trx('<0/> Thống kê', { 0: <ChartIcon className="w-4 h-4 mr-2" /> })}</>
                : t}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        {/* Navigate to Analytics / Reports */}
        <button
          onClick={() => navigateToAnalytics('overview')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors"
          title={tr('Xem báo cáo & phân tích')}
        ><ChartIcon className="w-4 h-4 inline" /> </button>
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
                {contactsLoadFailed && !store.contactsLoading && (
                  <LoadFailedBanner
                    text={store.contacts.length > 0 ? tr('Không tải được danh sách liên hệ mới nhất — đang hiện dữ liệu cũ') : tr('Không tải được danh sách liên hệ')}
                    onRetry={loadContacts}
                  />
                )}
                <CRMContactList
                  contacts={store.contacts}
                  total={store.totalContacts}
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
                  channel={(activeAccount?.channel || CHANNEL.ZALO) as Channel}
                  localLabels={localLabels}
                  localLabelThreadMap={localLabelThreadMap}
                  onSelectContact={store.toggleSelectContact}
                  onActivateContact={id => store.setActiveContact(store.activeContactId === id ? null : id)}
                  onSelectAll={() => store.selectAllContacts(store.contacts.map(c => c.contact_id))}
                  onClearAll={store.clearSelection}
                  onExportAll={handleExportAll}
                  onFilterChange={store.setFilter}
                  onPageChange={p => store.setFilter({ page: p })}
                  onPageSizeChange={size => store.setFilter({ pageSize: size, page: 0 })}
                  onMessage={handleMessage}
                  onImportPhones={channelCap.supportsCRMPhoneImport ? () => setShowPhoneImport(true) : undefined}
                />
              </div>
              {activeContact && (
                <CRMContactDetailPanel
                  contact={activeContact}
                  channel={(activeAccount?.channel || CHANNEL.ZALO) as Channel}
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
              <div className="w-80 flex-shrink-0 border-r border-border overflow-hidden flex flex-col">
                {campaignsLoadFailed && !store.campaignsLoading && (
                  <LoadFailedBanner
                    text={store.campaigns.length > 0 ? tr('Không tải được chiến dịch mới nhất') : tr('Không tải được danh sách chiến dịch')}
                    onRetry={loadCampaigns}
                  />
                )}
                <CampaignList
                  campaigns={store.campaigns}
                  loading={store.campaignsLoading}
                  activeId={store.activeCampaignId}
                  onSelect={store.setActiveCampaign}
                  onCreate={startWizard}
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
                    channel={(activeAccount?.channel || CHANNEL.ZALO) as Channel}
                    allLabels={zaloLabels}
                    localLabels={localLabels}
                    localLabelThreadMap={localLabelThreadMap}
                    onStatusChange={handleUpdateCampaignStatus}
                    onAddContacts={async (campaignId, contacts) => { await handleAddContactsToCampaign(campaignId, contacts); }}
                    onUpdate={handleUpdateCampaign}
                    onCreateFromContacts={handleCreateCampaignFromContacts}
                  />
                ) : (
                  <EmptyState
                    className="h-full"
                    icon={<CampaignIcon className="h-6 w-6" />}
                    title={tr('Chọn chiến dịch để xem chi tiết')}
                    description={tr('Tiến độ gửi, nội dung và danh sách liên hệ của chiến dịch sẽ hiện ở đây.')}
                    action={<Button variant="outline" size="sm" leftIcon={<PlusIcon className="h-4 w-4" />} onClick={startWizard}>{tr('Tạo chiến dịch mới')}</Button>}
                  />
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

          {/* ── Scan Data tab ── */}
          {store.tab === 'scan' && (
            <div className="flex-1 overflow-hidden">
              <ScanPanel accountId={activeAccountId || ''} />
            </div>
          )}

          {/* ── Scan History tab ── */}
          {store.tab === 'scan_history' && (
            <div className="flex-1 overflow-hidden">
              <ScanHistoryTab accountId={activeAccountId || ''} />
            </div>
          )}

          {/* ── Scan Stats tab ── */}
          {store.tab === 'scan_stats' && (
            <div className="flex-1 overflow-hidden">
              <ScanStatsTab accountId={activeAccountId || ''} />
            </div>
          )}

        </div>

        <QueueStatusBar status={queueStatus} />
      </div>

      {/* Bulk action bar */}
      <BulkActionBar
        channel={activeAccount?.channel || CHANNEL.ZALO}
        selectedCount={store.selectedContactIds.size}
        hasGroupSelected={store.contacts.some(c => store.selectedContactIds.has(c.contact_id) && c.contact_type === 'group')}
        onClearSelection={store.clearSelection}
        onAddToCampaign={handleBulkAddToCampaign}
        onBulkTagLocal={handleBulkTagLocal}
        onBulkTagZalo={handleBulkTagZalo}
        // Bulk leave is still implemented through Zalo IPC only. Hide it on
        // Telegram until its channel-specific confirmation flow is added.
        onBulkLeaveGroup={activeAccount?.channel === CHANNEL.ZALO ? handleBulkLeaveGroup : undefined}
      />

      {/* ── Modals ── */}
      {showCreateCampaign && (
        <CampaignCreateModal
          zaloId={activeAccountId || ''}
          channel={(activeAccount?.channel || CHANNEL.ZALO) as Channel}
          onClose={wizardActive ? handleWizardCreateClose : () => setShowCreateCampaign(false)}
          onSave={handleCreateCampaign}
        />
      )}

      {/* Wizard: Step 2 - Add contacts */}
      {wizardActive && wizardStep === 2 && wizardCampaignId !== null && (
        <TargetSelector
          zaloId={activeAccountId || ''}
          channel={(activeAccount?.channel || CHANNEL.ZALO) as Channel}
          allLabels={zaloLabels}
          localLabels={localLabels}
          localLabelThreadMap={localLabelThreadMap}
          existingContactIds={new Set()}
          onConfirm={handleWizardConfirmTargets}
          onClose={handleWizardDismiss}
          headerContent={<WizardStepIndicator currentStep={2} />}
        />
      )}

      {showCloneCampaign && cloneCampaignId !== null && activeAccountId && (() => {
        const src = store.campaigns.find(c => c.id === cloneCampaignId);
        // A copy can go to any account of the same channel (employees: the accounts assigned to them)
        const sourceChannel = resolveAccountChannel(activeAccount || {});
        return src ? (
          <CampaignCloneModal
            campaignName={src.name}
            totalContacts={src.total_contacts}
            sourceAccountId={activeAccountId}
            accounts={accounts.filter(account => resolveAccountChannel(account) === sourceChannel)}
            canCopyPhoneRecipients={channelCap.supportsCRMPhoneImport}
            invitesToGroups={campaignInvitesToGroups(src)}
            onClose={() => { setShowCloneCampaign(false); setCloneCampaignId(null); }}
            onConfirm={handleCloneCampaign}
          />
        ) : null;
      })()}

      {/* Bulk local label modal (multi-select) */}
      {showBulkLocalModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowBulkLocalModal(false)}>
          <div className="bg-card border border-input rounded-2xl w-80 p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-foreground mb-1">{trx('<0/> Gán Nhãn Local', { 0: <HardDriveIcon className="w-4 h-4 inline" /> })}</h3>
            <p className="text-xs text-muted-foreground mb-3">
              {trx('Áp dụng cho <0>{{count}}</0> liên hệ đã chọn<1>(chọn nhiều)</1>', { 0: <span className="text-blue-400 font-medium" />, count: store.selectedContactIds.size, 1: <span className="text-muted-foreground ml-1" /> })}
            </p>
            {localLabels.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">{tr('Chưa có Nhãn Local nào.')}</p>
            ) : (
              <LocalLabelSelector
                labels={localLabels}
                selectedIds={bulkLocalLabelIds}
                onChange={setBulkLocalLabelIds}
                placeholder={tr('Chọn Nhãn Local...')}
                emptyText={tr('Chưa có Nhãn Local nào')}
              />
            )}
            <div className="flex gap-2 mt-4">
              <button onClick={() => setShowBulkLocalModal(false)}
                className="flex-1 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent">
                {tr('Hủy')}
              </button>
              <button onClick={handleApplyBulkLocalLabel}
                disabled={bulkLocalLabelIds.length === 0 || applyingBulkLabel}
                className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                {applyingBulkLabel ? tr('Đang gán...') : tr('Áp dụng')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Zalo label modal (single-select) */}
      {showBulkZaloModal && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50"
          onClick={() => setShowBulkZaloModal(false)}>
          <div className="bg-card border border-input rounded-2xl w-80 p-5 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <h3 className="font-semibold text-foreground mb-1">{trx('<0/> Gán nhãn Zalo', { 0: <CloudIcon className="w-4 h-4 inline" /> })}</h3>
            <p className="text-xs text-muted-foreground mb-3">
              {trx('Áp dụng cho <0>{{count}}</0> liên hệ đã chọn<1>(chỉ 1 nhãn / hội thoại)</1>', { 0: <span className="text-blue-400 font-medium" />, count: store.selectedContactIds.size, 1: <span className="text-muted-foreground ml-1" /> })}
            </p>
            {zaloLabels.length === 0 ? (
              <p className="text-xs text-muted-foreground py-4 text-center">{tr('Chưa có nhãn Zalo nào. Hãy đồng bộ nhãn từ header trước.')}</p>
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
                className="flex-1 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent">
                {tr('Hủy')}
              </button>
              <button onClick={handleApplyBulkLabel}
                disabled={bulkLabelIds.length === 0 || applyingBulkLabel}
                className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                {applyingBulkLabel ? tr('Đang gán...') : tr('Áp dụng')}
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
            <div className="bg-card border border-input rounded-2xl w-80 p-5 shadow-2xl"
              onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-foreground">{tr('Chọn chiến dịch')}</h3>
                <button
                  onClick={() => setShowCreateInAddModal(true)}
                  className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors px-2 py-1 rounded-lg hover:bg-blue-500/10">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                  {tr('Tạo mới')}
                </button>
              </div>

              {availableCampaigns.length === 0 ? (
                /* ── Empty state ── */
                <div className="flex flex-col items-center py-4 gap-3">
                  <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-muted-foreground">
                      <path d="M22 12h-4l-3 9L9 3l-3 9H2"/>
                    </svg>
                  </div>
                  <p className="text-sm text-foreground/80 text-center font-medium">{tr('Chưa có chiến dịch phù hợp')}</p>
                  <p className="text-xs text-muted-foreground text-center leading-relaxed">
                    {tr('Tất cả chiến dịch đã hoàn thành hoặc chưa có chiến dịch nào.')}
                  </p>
                  <button
                    onClick={() => setShowCreateInAddModal(true)}
                    className="w-full py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm transition-colors flex items-center justify-center gap-1.5">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                      <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    {tr('Tạo chiến dịch mới')}
                  </button>
                  <button onClick={() => setAddToCampaignModal(false)}
                    className="w-full py-1.5 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent transition-colors">
                    {tr('Hủy')}
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
                            ? 'border-blue-500 bg-blue-500/20 text-foreground'
                            : 'border-input text-foreground/80 hover:border-border-strong'}`}>
                        <span className="flex items-center gap-1.5">
                          <span className={`inline-block w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                            c.status === 'active' ? 'bg-green-400' : c.status === 'paused' ? 'bg-yellow-400' : 'bg-accent'
                          }`} />
                          {c.name}
                        </span>
                        <span className="block text-xs text-muted-foreground mt-0.5 pl-3">{trx('{{total_contacts}} liên hệ', { total_contacts: c.total_contacts })}</span>
                      </button>
                    ))}
                  </div>
                  <div className="flex gap-2 mt-4">
                    <button onClick={() => setAddToCampaignModal(false)}
                      className="flex-1 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent">{tr('Hủy')}</button>
                    <button disabled={!selectedCampaignForAdd}
                      onClick={async () => {
                        if (!selectedCampaignForAdd || !activeAccountId) return;
                        const contacts = store.contacts
                          .filter(c => store.selectedContactIds.has(c.contact_id))
                          .map(c => ({ contactId: c.contact_id, displayName: c.alias || c.display_name, avatar: c.avatar }));
                        const added = await handleAddContactsToCampaign(selectedCampaignForAdd, contacts);
                        if (!added) return; // keep the selection so the user can retry
                        store.clearSelection();
                        setAddToCampaignModal(false);
                      }}
                      className="flex-1 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40">
                      {trx('Thêm {{count}} liên hệ', { count: store.selectedContactIds.size })}
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
          channel={(activeAccount?.channel || CHANNEL.ZALO) as Channel}
          onClose={() => setShowCreateInAddModal(false)}
          onSave={async (data) => {
            await handleCreateCampaignInAddModal(data);
            setShowCreateInAddModal(false);
          }}
        />
      )}

      {/* ── Phone import modal (Add phone numbers to contacts) ── */}
      {showPhoneImport && (
        <AddToContactsModal
          onClose={() => setShowPhoneImport(false)}
          onDone={() => {
            setShowPhoneImport(false);
            loadContacts();
          }}
        />
      )}

      {/* ── Confirm leave groups modal ── */}
      {showLeaveGroupConfirm && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50"
          onClick={() => { if (!leavingGroups) setShowLeaveGroupConfirm(false); }}>
          <div className="bg-card border border-input rounded-2xl w-[380px] p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-3 mb-3">
              <div className="w-9 h-9 rounded-xl bg-red-500/15 border border-red-500/30 flex items-center justify-center flex-shrink-0">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2.5">
                  <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                  <polyline points="16 17 21 12 16 7"/>
                  <line x1="21" y1="12" x2="9" y2="12"/>
                </svg>
              </div>
              <div>
                <h3 className="font-semibold text-foreground text-sm">{tr('Rời nhóm đã chọn')}</h3>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {tr('Hành động này không thể hoàn tác')}
                </p>
              </div>
            </div>
            <p className="text-xs text-foreground/80 mb-5 leading-relaxed">
              {tr('Bạn sắp rời')} <span className="text-red-300 font-semibold">
                {store.contacts.filter(c => store.selectedContactIds.has(c.contact_id) && c.contact_type === 'group').length} {tr('nhóm')}
              </span>{tr('. Sau khi rời, tài khoản sẽ không còn trong nhóm đó nữa.')}
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => setShowLeaveGroupConfirm(false)}
                disabled={leavingGroups}
                className="flex-1 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent disabled:opacity-40 transition-colors">
                {tr('Hủy')}
              </button>
              <button
                onClick={handleConfirmLeaveGroups}
                disabled={leavingGroups}
                className="flex-1 py-2 rounded-xl bg-red-600 text-white text-sm hover:bg-red-700 disabled:opacity-50 transition-colors flex items-center justify-center gap-1.5">
                {leavingGroups
                  ? <>{trx('<0/>Đang rời...', { 0: <Spinner size={3} /> })}</>
                  : tr('Xác nhận rời nhóm')
                }
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

