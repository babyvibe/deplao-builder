import React, { useState, useCallback, useRef, useEffect } from 'react';
import ipc from '@/lib/ipc';
import { SCAN_CONFIGS, type ScanType } from '../../../../services/facebook/FacebookScanTypes';
import { createScanTab, DEFAULT_FILTERS, SCAN_TAB_LABELS, type ScanTabData, type ScanFilters } from './ScanSessionTypes';
import ScanResultTable from './ScanResultTable';
import ScanFiltersPanel from './ScanFiltersPanel';
import { SCAN_INPUT_CONFIG } from './ScanSessionTypes';
import ScanHistoryPanel from './ScanHistoryPanel';
import { Spinner } from '@/components/common/PageLoading';
import { ClipboardListIcon, HardDriveIcon, SearchIcon } from '@/components/common/icons';
import { showConfirm } from '../../common/ConfirmDialog';

const SCAN_WARNING_KEY = 'fb_scan_warning_dismissed';

interface Props {
  accountId: string;
}

export default function ScanPanel({ accountId }: Props) {
  const [tabs, setTabs] = useState<ScanTabData[]>([]);
  const [activeTabId, setActiveTabId] = useState<string>('');
  const [showNewTabMenu, setShowNewTabMenu] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showArchive, setShowArchive] = useState(false);
  const [archivedTabs, setArchivedTabs] = useState<any[]>([]);
  const [loadingTabs, setLoadingTabs] = useState(true);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingLabel, setEditingLabel] = useState('');
  const [openMenuTabId, setOpenMenuTabId] = useState<string | null>(null);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [archiveSearch, setArchiveSearch] = useState('');
  const [showOverflowTabs, setShowOverflowTabs] = useState(false);
  const overflowRef = useRef<HTMLButtonElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const newTabMenuRef = useRef<HTMLDivElement>(null);
  const tabMenuRef = useRef<Record<string, HTMLButtonElement | null>>({});
  const stopScanRef = useRef<Record<string, boolean>>({}); // Abort signal cho auto-pagination
  const [showWarning, setShowWarning] = useState(() => {
    try { return localStorage.getItem(SCAN_WARNING_KEY) !== '1'; } catch { return true; }
  });

  const activeTab = tabs.find(t => t.id === activeTabId);

  // Wrap setActiveTabId để đồng thời cập nhật updated_at trên DB
  const handleSetActiveTab = useCallback((tabId: string) => {
    setActiveTabId(tabId);
    ipc.fb?.scanTouchTab({ id: tabId }).catch(() => {});
  }, []);

  // ─── Load tabs from DB on mount ──────────────────────────────
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    (async () => {
      try {
        setLoadingTabs(true);
        const [activeRes, archivedRes] = await Promise.all([
          ipc.fb?.scanGetTabs({ accountId, status: 'active', limit: 100 }),
          ipc.fb?.scanGetTabs({ accountId, status: 'archived', limit: 100 }),
        ]);
        if (cancelled) return;
        if (activeRes?.success && activeRes.tabs?.length > 0) {
          // Load saved data for each tab (items + pageInfo từ lần scan trước)
          const loaded = await Promise.all(activeRes.tabs.map(async (t: any) => {
            let config: any = {};
            try { config = JSON.parse(t.config || '{}'); } catch {}
            // Try to restore saved scan data
            let savedItems: any[] = [];
            let savedPageInfo = { endCursor: null as string | null, hasNextPage: false };
            try {
              const dataRes = await ipc.fb?.scanGetTabData({ tabId: t.id });
              if (dataRes?.success && !cancelled) {
                savedItems = dataRes.items || [];
                savedPageInfo = dataRes.pageInfo || { endCursor: null, hasNextPage: false };
              }
            } catch {}
            return {
              id: t.id,
              label: t.name,
              scanType: config.scanType || t.scan_type || 'group_members',
              url: config.url || '',
              keyword: config.keyword || '',
              filters: { ...DEFAULT_FILTERS, ...(config.filters || {}) },
              items: savedItems,
              pageInfo: savedPageInfo,
              cursor: savedPageInfo.endCursor,
              scanning: false,
              error: '',
              progress: savedItems.length > 0 ? `Đã có ${savedItems.length} kết quả` : '',
              batchMode: config.batchMode || false,
              batchInput: config.batchInput || '',
              threadCount: config.threadCount || 1,
              batchProgress: { done: 0, total: 0, current: '' },
              _nextBsid: config._nextBsid || '',
              _nextTsid: config._nextTsid || '',
            } as ScanTabData;
          }));
          if (cancelled) return;
          setTabs(loaded);
          setActiveTabId(loaded[0].id);
        } else {
          if (cancelled) return;
          // First time: create default tab
          const defaultTab = createScanTab('group_members');
          setTabs([defaultTab]);
          setActiveTabId(defaultTab.id);
          saveTabConfig(defaultTab); // 💾 Lưu ngay
        }
        if (archivedRes?.success) setArchivedTabs(archivedRes.tabs || []);
      } catch {}
      if (!cancelled) setLoadingTabs(false);
    })();
    return () => { cancelled = true; };
  }, [accountId]);

  // ─── Save tabs to DB whenever they change ─────────────────────
  const saveTabConfig = useCallback(async (tab: ScanTabData) => {
    if (!accountId) return;
    const config = JSON.stringify({
      scanType: tab.scanType, url: tab.url, keyword: tab.keyword,
      filters: tab.filters, batchMode: tab.batchMode, batchInput: tab.batchInput,
      threadCount: tab.threadCount, _nextBsid: tab._nextBsid || '', _nextTsid: tab._nextTsid || '',
    });
    try { await ipc.fb?.scanSaveTab({ id: tab.id, accountId, name: tab.label, scanType: tab.scanType, config, status: 'active', itemsCount: tab.items.length }); } catch {}
  }, [accountId]);

  const saveTabsToDb = useCallback(async (currentTabs: ScanTabData[]) => {
    if (!accountId) return;
    for (const tab of currentTabs) {
      const config = JSON.stringify({
        scanType: tab.scanType, url: tab.url, keyword: tab.keyword,
        filters: tab.filters, batchMode: tab.batchMode, batchInput: tab.batchInput,
        threadCount: tab.threadCount, _nextBsid: tab._nextBsid || '', _nextTsid: tab._nextTsid || '',
      });
      try {
        await ipc.fb?.scanSaveTab({
          id: tab.id,
          accountId,
          name: tab.label,
          scanType: tab.scanType,
          config,
          status: 'active',
          itemsCount: tab.items.length,
        });
      } catch {}
    }
  }, [accountId]);

  // Debounce save: chỉ lưu khi tabs dừng thay đổi 2s
  const saveTimerRef = useRef<any>(null);
  useEffect(() => {
    if (tabs.length === 0 || !accountId) return;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveTabsToDb(tabs);
    }, 2000);
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };
  }, [tabs, accountId, saveTabsToDb]);

  // ─── Save scan log + tab data + request log ──────────────────
  const saveScanLog = useCallback(async (tab: ScanTabData, status: 'success' | 'error', error?: string, itemsCount?: number) => {
    if (!accountId) return;
    try {
      const input = tab.batchMode ? tab.batchInput : (tab.url || tab.keyword);
      // Save to scan history
      await ipc.fb?.saveScanLog({
        accountId,
        tabId: tab.id,
        tabName: tab.label,
        scanType: tab.scanType,
        input: input || '',
        status,
        itemsCount: itemsCount || tab.items.length,
        error: error || '',
        requestPayload: tab._lastPayload || '{}',
        responsePreview: tab._lastResponse || '',
        requestHeaders: tab._lastRequestHeaders || '',
        responseHeaders: tab._lastResponseHeaders || '',
        docId: tab._lastDocId || '',
        threadCount: tab.threadCount,
      });
      // Save per-tab request log
      await ipc.fb?.scanSaveRequestLog({
        tabId: tab.id,
        requestPayload: tab._lastPayload || '{}',
        responsePreview: tab._lastResponse || '',
        requestHeaders: tab._lastRequestHeaders || '',
        responseHeaders: tab._lastResponseHeaders || '',
        status,
        error: error || '',
        itemsCount: itemsCount || tab.items.length,
      });
      // Save tab data
      if (tab.items.length > 0) {
        await ipc.fb?.scanSaveTabData({
          tabId: tab.id,
          items: tab.items,
          pageInfo: tab.pageInfo,
        });
      }
    } catch {}
  }, [accountId]);

  // Auto save log when scan finishes
  const prevScanningRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const tab of tabs) {
      const prev = prevScanningRef.current[tab.id];
      if (prev === true && tab.scanning === false) {
        const error = tab.error || undefined;
        saveScanLog(tab, error ? 'error' : 'success', error);
      }
      prevScanningRef.current[tab.id] = tab.scanning;
    }
  }, [tabs, saveScanLog]);

  // 💾 Save all tabs to DB when unmounting (đổi module)
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const saveTabsToDbRef = useRef(saveTabsToDb);
  saveTabsToDbRef.current = saveTabsToDb;
  useEffect(() => {
    return () => {
      const currentTabs = tabsRef.current;
      if (currentTabs.length > 0 && accountId) {
        // Save ngay, không đợi debounce
        for (const tab of currentTabs) {
          const config = JSON.stringify({
            scanType: tab.scanType, url: tab.url, keyword: tab.keyword,
            filters: tab.filters, batchMode: tab.batchMode, batchInput: tab.batchInput,
            threadCount: tab.threadCount, _nextBsid: tab._nextBsid || '', _nextTsid: tab._nextTsid || '',
          });
          ipc.fb?.scanSaveTab({
            id: tab.id, accountId, name: tab.label, scanType: tab.scanType,
            config, status: 'active', itemsCount: tab.items.length,
          });
          if (tab.items.length > 0) {
            ipc.fb?.scanSaveTabData({
              tabId: tab.id, items: tab.items, pageInfo: tab.pageInfo,
            });
          }
        }
      }
    };
  }, [accountId]);

  // ─── Tab management ─────────────────────────────────────────────

  const openNewTab = useCallback((scanType: ScanType) => {
    const tab = createScanTab(scanType);
    const sameTypeCount = tabs.filter(t => t.scanType === scanType).length;
    if (sameTypeCount > 0) {
      tab.label = `[${sameTypeCount + 1}] ${SCAN_TAB_LABELS[scanType].label}`;
    }
    setTabs(prev => [tab, ...prev]);
    setActiveTabId(tab.id);
    setShowNewTabMenu(false);
    // 💾 Lưu tab config ngay lập tức (không đợi debounce)
    saveTabConfig(tab);
  }, [tabs, accountId, saveTabConfig]);

  // ─── Tab rename ────────────────────────────────────────────────
  const startRename = useCallback((tabId: string, currentLabel: string) => {
    setEditingTabId(tabId);
    setEditingLabel(currentLabel);
    setShowRenameDialog(true);
  }, []);

  const commitRename = useCallback(() => {
    if (editingTabId && editingLabel.trim()) {
      setTabs(prev => prev.map(t => t.id === editingTabId ? { ...t, label: editingLabel.trim() } : t));
    }
    setEditingTabId(null);
    setEditingLabel('');
    setShowRenameDialog(false);
  }, [editingTabId, editingLabel]);

  const cancelRename = useCallback(() => {
    setEditingTabId(null);
    setEditingLabel('');
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') commitRename();
    else if (e.key === 'Escape') cancelRename();
  }, [commitRename, cancelRename]);

  // ─── Archive / Restore / Delete ────────────────────────────────

  const archiveTab = useCallback(async (tabId: string) => {
    // Archive in DB
    try { await ipc.fb?.scanUpdateTabStatus({ id: tabId, status: 'archived' }); } catch {}
    setTabs(prev => {
      const idx = prev.findIndex(t => t.id === tabId);
      const filtered = prev.filter(t => t.id !== tabId);
      if (filtered.length === 0) {
        const newTab = createScanTab('group_members');
        setActiveTabId(newTab.id);
        return [newTab];
      }
      if (tabId === activeTabId) {
        const newIdx = Math.min(idx, filtered.length - 1);
        setActiveTabId(filtered[newIdx].id);
      }
      return filtered;
    });
    // Reload archived list
    loadArchivedTabs();
  }, [activeTabId]);

  const loadArchivedTabs = useCallback(async () => {
    if (!accountId) return;
    try {
      const res = await ipc.fb?.scanGetTabs({ accountId, status: 'archived', limit: 100 });
      if (res?.success) setArchivedTabs(res.tabs || []);
    } catch {}
  }, [accountId]);

  const restoreTab = useCallback(async (tabId: string) => {
    try {
      await ipc.fb?.scanUpdateTabStatus({ id: tabId, status: 'active' });
      // Reload active tabs
      const res = await ipc.fb?.scanGetTabs({ accountId, status: 'active', limit: 100 });
      if (res?.success && res.tabs?.length > 0) {
        const loaded = res.tabs.map((t: any) => {
          let config: any = {};
          try { config = JSON.parse(t.config || '{}'); } catch {}
          return {
            id: t.id, label: t.name,
            scanType: config.scanType || t.scan_type || 'group_members',
            url: config.url || '', keyword: config.keyword || '',
            filters: { ...DEFAULT_FILTERS, ...(config.filters || {}) },
            items: [], pageInfo: { endCursor: null, hasNextPage: false },
            cursor: null, scanning: false, error: '', progress: '',
            batchMode: config.batchMode || false,
            batchInput: config.batchInput || '',
            threadCount: config.threadCount || 1,
            batchProgress: { done: 0, total: 0, current: '' },
            _nextBsid: '',
            _nextTsid: '',
          } as ScanTabData;
        });
        setTabs(loaded);
        setActiveTabId(loaded[0]?.id || '');
      }
      setArchivedTabs(prev => prev.filter((t: any) => t.id !== tabId));
    } catch {}
  }, [accountId]);

  const permanentlyDeleteTab = useCallback(async (tabId: string) => {
    const ok = await showConfirm({
      title: 'Xoá tab vĩnh viễn?',
      message: 'Toàn bộ dữ liệu liên quan sẽ bị xoá và không thể khôi phục!',
      confirmText: 'Xoá vĩnh viễn',
      variant: 'danger',
    });
    if (!ok) return;
    try {
      await ipc.fb?.scanDeleteTab({ id: tabId });
      setArchivedTabs(prev => prev.filter((t: any) => t.id !== tabId));
      // Nếu tab đang active, xoá khỏi danh sách active
      setTabs(prev => {
        const filtered = prev.filter(t => t.id !== tabId);
        if (filtered.length === 0) {
          const newTab = createScanTab('group_members');
          setActiveTabId(newTab.id);
          return [newTab];
        }
        if (tabId === activeTabId) setActiveTabId(filtered[0].id);
        return filtered;
      });
    } catch {}
  }, [activeTabId]);

  const duplicateTab = useCallback((tab: ScanTabData) => {
    const newTab: ScanTabData = {
      ...JSON.parse(JSON.stringify(tab)),
      id: `${tab.scanType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      label: tab.label + ' (copy)',
      items: [],
      pageInfo: { endCursor: null, hasNextPage: false },
      cursor: null,
      scanning: false,
      error: '',
      progress: '',
    };
    setTabs(prev => [newTab, ...prev]);
    setActiveTabId(newTab.id);
  }, []);

  const updateTab = useCallback((tabId: string, patch: Partial<ScanTabData>) => {
    setTabs(prev => prev.map(t => t.id === tabId ? { ...t, ...patch } : t));
  }, []);

  // ─── Extract ID from URL ────────────────────────────────────────

  const extractIdFromUrl = useCallback((inputUrl: string): string => {
    const urlTrim = inputUrl.trim();
    const groupMatch = urlTrim.match(/(?:facebook\.com|fb\.com)\/groups\/(\d+)/i);
    if (groupMatch) return groupMatch[1];
    const postMatch = urlTrim.match(/(?:facebook\.com|fb\.com)\/.+?\/(?:posts|photos|videos)\/(\d+)/i);
    if (postMatch) return postMatch[1];
    const pageMatch = urlTrim.match(/(?:facebook\.com|fb\.com)\/([^/?]+)/i);
    if (pageMatch && !['groups', 'pages'].includes(pageMatch[1].toLowerCase())) return pageMatch[1];
    if (/^\d+$/.test(urlTrim)) return urlTrim;
    return urlTrim;
  }, []);

  // ─── Scan one page (dùng chung cho start & loadMore) ────────────

  const scanOnePage = useCallback(async (tabId: string, cursorVal: string | null): Promise<any> => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !accountId) return null;

    const id = extractIdFromUrl(tab.url);
    const scanType = tab.scanType;
    const filterArgs = buildFilterArgs(scanType, tab.filters);

    switch (scanType) {
      case 'group_members':
        return await ipc.fb?.scanGroupMembers({ accountId, groupId: id, cursor: cursorVal });
      case 'group_keyword':
        return await ipc.fb?.scanGroupKeyword({ accountId, keyword: tab.keyword.trim(), cursor: cursorVal, filters: filterArgs, bsid: tab._nextBsid, tsid: tab._nextTsid });
      case 'fanpage_keyword':
        return await ipc.fb?.scanFanpageKeyword({ accountId, keyword: tab.keyword.trim(), cursor: cursorVal, filters: filterArgs, bsid: tab._nextBsid, tsid: tab._nextTsid });
      case 'post_comments':
        return await ipc.fb?.scanPostComments({ accountId, postId: id, cursor: cursorVal });
      case 'post_keyword':
        return await ipc.fb?.scanPostKeyword({ accountId, keyword: tab.keyword.trim(), cursor: cursorVal, filters: filterArgs, bsid: tab._nextBsid, tsid: tab._nextTsid });
      default: return null;
    }
  }, [accountId, tabs, extractIdFromUrl]);

  // ─── Apply one page result vào tab (merge + dedup + save) ──────

  const applyPageResult = useCallback((tabId: string, baseItems: any[], result: any, prevCursor: string | null): {
    mergedItems: any[]; shouldContinue: boolean; nextCursor: string | null; nextBsid: string; nextTsid: string;
  } => {
    const newItems = result.items || [];

    const existingIds = new Set(baseItems.map((i: any) => i.uid || i.postId || i.commentId || ''));
    const dedupedItems = newItems.filter((i: any) => {
      const itemId = i.uid || i.postId || i.commentId || '';
      return itemId && !existingIds.has(itemId);
    });

    const hasNewData = dedupedItems.length > 0;
    const cursorChanged = result.pageInfo?.endCursor && result.pageInfo.endCursor !== prevCursor;
    const shouldContinue = hasNewData && cursorChanged;
    const mergedItems = [...baseItems, ...dedupedItems];

    return {
      mergedItems,
      shouldContinue,
      nextCursor: shouldContinue ? (result.pageInfo?.endCursor || null) : null,
      nextBsid: result._nextBsid || '',
      nextTsid: result._nextTsid || '',
    };
  }, []);

  // ─── Start scan (with auto-pagination) ──────────────────────────

  const handleStartScan = useCallback(async (tabId: string, mode?: 'reset' | 'continue') => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !accountId || tab.scanning) return;

    // Nếu đã có items và chưa chọn mode → hỏi người dùng
    if (tab.items.length > 0 && !mode) {
      const ok = await showConfirm({
        title: 'Bắt đầu quét mới?',
        message: `Tab "${tab.label}" đã có ${tab.items.length} kết quả.\n\nBạn muốn làm mới (xoá dữ liệu cũ) hay tiếp tục quét thêm?`,
        confirmText: 'Làm mới',
        cancelText: 'Tiếp tục',
        variant: 'warning',
      });
      handleStartScan(tabId, ok ? 'reset' : 'continue');
      return;
    }

    const isBatch = tab.batchMode && tab.batchInput.trim();
    const scanType = tab.scanType;
    const filterArgs = buildFilterArgs(scanType, tab.filters);
    const targetCount = tab.filters.maxResults || 100;

    // Abort scan trước đó của tab này (nếu có)
    stopScanRef.current[tabId] = false;
    // 💾 Đảm bảo tab config đã được lưu trước khi bắt đầu quét
    saveTabConfig(tab);

    if (isBatch) {
      // ── BATCH MODE: quét nhiều ID cùng lúc với thread pool ──
      const lines = tab.batchInput.trim().split('\n').filter(Boolean).map(l => l.trim());
      if (lines.length === 0) {
        updateTab(tabId, { error: 'Vui lòng nhập ít nhất 1 ID', scanning: false });
        return;
      }

      const threadCount = Math.min(tab.threadCount, lines.length);
      updateTab(tabId, {
        scanning: true, error: '', items: [], cursor: null,
        pageInfo: { endCursor: null, hasNextPage: false },
        batchProgress: { done: 0, total: lines.length, current: 'Đang khởi tạo...' },
        progress: '',
      });

      // ── Gọi batch IPC handlers để backend xử lý thread pool ──
      updateTab(tabId, { batchProgress: { done: 0, total: lines.length, current: 'Đang xử lý...' } });

      let batchResult: any = null;
      const ids = lines.map(l => extractIdFromUrl(l)).filter(Boolean);

      try {
        switch (scanType) {
          case 'group_members':
            batchResult = await ipc.fb?.scanGroupMembersBatch({ accountId, groupIds: ids, threadCount });
            break;
          case 'post_comments':
            batchResult = await ipc.fb?.scanPostCommentsBatch({ accountId, postIds: ids, threadCount });
            break;
          default:
            // Fallback: xử lý từng ID bằng single calls + thread pool trên UI
            batchResult = await fallbackBatchScan(accountId, scanType, lines, extractIdFromUrl, filterArgs, threadCount, (done, total, current) => {
              updateTab(tabId, { batchProgress: { done, total, current } });
            });
            break;
        }
      } catch (err: any) {
        batchResult = { success: false, items: [], errors: [err.message] };
      }

      if (batchResult) {
        const items = (batchResult.items || []).map((item: any, i: number) => ({
          ...item,
          _batchIndex: i,
        }));

        updateTab(tabId, {
          items,
          pageInfo: { endCursor: null, hasNextPage: false },
          cursor: null,
          batchProgress: { done: lines.length, total: lines.length, current: '' },
          progress: '',
          scanning: false,
          error: batchResult.errors?.length ? `${batchResult.errors.length} dòng lỗi` : '',
        });
      }
    } else {
      // ── SINGLE MODE: quét 1 URL/keyword với auto-pagination ──
      const isContinue = mode === 'continue';
      const baseItems: any[] = isContinue ? [...tab.items] : [];
      const startCursor: string | null = isContinue ? (tab.cursor || null) : null;

      updateTab(tabId, {
        scanning: true, error: '', progress: `Đang quét... (mục tiêu: ${targetCount})`,
        items: isContinue ? tab.items : [],
        cursor: isContinue ? tab.cursor : null,
        pageInfo: isContinue ? tab.pageInfo : { endCursor: null, hasNextPage: false },
      });

      let allItems = baseItems;
      let currentCursor: string | null = startCursor;
      let currentBsid = tab._nextBsid || '';
      let currentTsid = tab._nextTsid || '';
      let pageCount = 0;

      try {
        while (allItems.length < targetCount && !stopScanRef.current[tabId]) {
          // Cập nhật progress
          if (pageCount > 0) {
            updateTab(tabId, { progress: `Đang tải trang ${pageCount + 1}... (đã có ${allItems.length}/${targetCount})` });
          }

          const result = await scanOnePage(tabId, currentCursor);
          pageCount++;

          if (!result?.success) {
            updateTab(tabId, {
              error: result?.error || 'Không thể quét dữ liệu.',
              progress: '', scanning: false,
              _lastPayload: result?._lastPayload || tab._lastPayload || '',
              _lastResponse: result?._lastResponse || tab._lastResponse || '',
              _lastDocId: result?._lastDocId || tab._lastDocId || '',
              _lastRequestHeaders: result?._lastRequestHeaders || tab._lastRequestHeaders || '',
              _lastResponseHeaders: result?._lastResponseHeaders || tab._lastResponseHeaders || '',
            });
            return;
          }

          const applied = applyPageResult(tabId, allItems, result, currentCursor);
          allItems = applied.mergedItems;
          currentCursor = applied.nextCursor;
          currentBsid = applied.nextBsid || currentBsid;
          currentTsid = applied.nextTsid || currentTsid;

          // Cập nhật UI sau mỗi trang
          updateTab(tabId, {
            items: allItems,
            pageInfo: { endCursor: currentCursor, hasNextPage: applied.shouldContinue },
            cursor: currentCursor,
            progress: `Đã thu thập ${allItems.length}/${targetCount} kết quả`,
            _nextBsid: currentBsid,
            _nextTsid: currentTsid,
            _lastPayload: result._lastPayload || tab._lastPayload || '',
            _lastResponse: result._lastResponse || tab._lastResponse || '',
            _lastDocId: result._lastDocId || tab._lastDocId || '',
            _lastRequestHeaders: result._lastRequestHeaders || tab._lastRequestHeaders || '',
            _lastResponseHeaders: result._lastResponseHeaders || tab._lastResponseHeaders || '',
          });

          // Lưu data sau mỗi trang (await để tránh race với saveScanLog)
          if (allItems.length > 0) {
            try {
              await ipc.fb?.scanSaveTabData({
                tabId,
                items: allItems,
                pageInfo: { endCursor: currentCursor, hasNextPage: applied.shouldContinue },
              });
            } catch {}
          }

          // Điều kiện dừng
          if (!applied.shouldContinue) {
            // 💾 Lưu data lần cuối trước khi kết thúc
            if (allItems.length > 0) {
              try {
                await ipc.fb?.scanSaveTabData({
                  tabId,
                  items: allItems,
                  pageInfo: { endCursor: currentCursor, hasNextPage: false },
                });
              } catch {}
            }
            updateTab(tabId, {
              progress: `Hoàn tất: ${allItems.length} kết quả (không còn dữ liệu)`,
              scanning: false,
            });
            return;
          }

          // Delay giữa các trang để tránh rate limit
          await new Promise(r => setTimeout(r, 800 + Math.random() * 700));
        }

        // Kết thúc: đủ số lượng hoặc bị dừng
        // 💾 Lưu data lần cuối trước khi báo hoàn tất
        if (allItems.length > 0) {
          try {
            await ipc.fb?.scanSaveTabData({
              tabId,
              items: allItems,
              pageInfo: { endCursor: currentCursor, hasNextPage: currentCursor ? true : false },
            });
          } catch {}
        }
        updateTab(tabId, {
          progress: allItems.length >= targetCount
            ? `Hoàn tất: ${allItems.length}/${targetCount} kết quả`
            : `Đã dừng: ${allItems.length} kết quả`,
          scanning: false,
          pageInfo: { endCursor: currentCursor, hasNextPage: currentCursor ? true : false },
          cursor: currentCursor,
        });
      } catch (err: any) {
        updateTab(tabId, { error: err?.message || 'Lỗi không xác định', progress: '', scanning: false });
      }
    }
  }, [accountId, tabs, extractIdFromUrl, updateTab, scanOnePage, applyPageResult, saveTabConfig]);

  // ─── Stop scan ──────────────────────────────────────────────────

  const handleStopScan = useCallback((tabId: string) => {
    stopScanRef.current[tabId] = true;
    updateTab(tabId, { scanning: false, progress: 'Đã dừng quét' });
  }, [updateTab]);

  // ─── Load more (manual pagination button) ───────────────────────

  const handleLoadMore = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || !accountId || !tab.cursor) return;

    updateTab(tabId, { scanning: true, progress: 'Đang tải thêm...' });

    try {
      const result = await scanOnePage(tabId, tab.cursor);

      if (result?.success) {
        const applied = applyPageResult(tabId, tab.items, result, tab.cursor);
        updateTab(tabId, {
          items: applied.mergedItems,
          pageInfo: { endCursor: applied.nextCursor, hasNextPage: applied.shouldContinue },
          cursor: applied.nextCursor,
          progress: applied.mergedItems.length > tab.items.length
            ? `Đã thu thập ${applied.mergedItems.length} kết quả`
            : `Đã thu thập ${tab.items.length} kết quả (không còn dữ liệu mới)`,
          scanning: false,
          _nextBsid: applied.nextBsid || tab._nextBsid || '',
          _nextTsid: applied.nextTsid || tab._nextTsid || '',
        });

        if (applied.mergedItems.length > 0) {
          try {
            await ipc.fb?.scanSaveTabData({
              tabId,
              items: applied.mergedItems,
              pageInfo: { endCursor: applied.nextCursor, hasNextPage: applied.shouldContinue },
            });
          } catch {}
        }
      }
    } catch (err: any) {
      updateTab(tabId, { error: err?.message || 'Lỗi khi tải thêm', scanning: false });
    }
  }, [accountId, tabs, scanOnePage, applyPageResult]);

  // ─── Export Excel ───────────────────────────────────────────────

  const handleExportExcel = useCallback(async (tabId: string) => {
    const tab = tabs.find(t => t.id === tabId);
    if (!tab || tab.items.length === 0) return;

    try {
      const scanTypeLabel = SCAN_TAB_LABELS[tab.scanType]?.label || tab.scanType;
      const XLSX = await import('xlsx');
      const { SCAN_EXCEL_COLUMNS } = await import('../../../../services/facebook/FacebookScanTypes');

      const columns = SCAN_EXCEL_COLUMNS[tab.scanType] || [];
      const data = tab.items.map((item: any, idx: number) => {
        const row: Record<string, any> = { index: idx + 1 };
        for (const col of columns) {
          if (col.key === 'index') continue;
          row[col.label] = item[col.key] ?? '';
        }
        return row;
      });

      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, scanTypeLabel);
      ws['!cols'] = columns.map((col: any) => ({ wch: col.width || 20 }));

      const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const blob = new Blob([wbout], { type: 'application/octet-stream' });
      const fileName = `Facebook_${tab.scanType}_${Date.now()}.xlsx`;

      const url2 = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url2;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url2);

      const { useAppStore } = await import('@/store/appStore');
      useAppStore.getState().showNotification?.('Đã xuất Excel thành công!', 'success');
    } catch (err: any) {
      const { useAppStore } = await import('@/store/appStore');

      useAppStore.getState().showNotification?.('Lỗi xuất Excel: ' + err.message, 'error');
    }
  }, [tabs]);

  // ─── Render ─────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* ⚠️ Warning: tài khoản phụ */}
      {showWarning && (
        <div className="flex-shrink-0 flex items-start gap-2.5 px-4 py-2.5 bg-red-100 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800/30">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-red-500 flex-shrink-0 mt-0.5">
            <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <p className="flex-1 text-[12px] text-red-700 dark:text-red-300 leading-relaxed">
            Quét dữ liệu nên dùng <strong className="text-red-800 dark:text-red-200">tài khoản phụ</strong> - chức năng có thể bị phát hiện bởi Facebook. Tài khoản chính sẽ gặp rủi ro: dễ bị đăng xuất, checkpoint, mất ổn định.
          </p>
          <button
            onClick={() => {
              setShowWarning(false);
              try { localStorage.setItem(SCAN_WARNING_KEY, '1'); } catch {}
            }}
            className="flex-shrink-0 p-0.5 rounded hover:bg-red-200 dark:hover:bg-red-800/40 text-red-400 hover:text-red-600 dark:hover:text-red-300 transition-colors"
            title="Đóng, không hiển thị lại"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      )}

      {/* ── Tab bar ────────────────────────────────────────────── */}
      <div className="flex-shrink-0 bg-gray-900 border-b border-gray-700/60">
        <div className="flex items-center">
          {/* Tabs - Max 5 hiển thị, còn lại trong menu "..." */}
          <div className="flex items-center flex-1 min-w-0 pl-1">
            {(() => {
              const MAX_VISIBLE = 5;
              const hasOverflow = tabs.length > MAX_VISIBLE;
              const visibleTabs = hasOverflow ? tabs.slice(0, MAX_VISIBLE) : tabs;
              return (
                <>
                  {visibleTabs.map(tab => {
                    const info = SCAN_TAB_LABELS[tab.scanType] || { icon: <ClipboardListIcon className="w-4 h-4" />, label: tab.scanType };
                    const isActive = tab.id === activeTabId;
                    return (
                <div
                  key={tab.id}
                  onClick={() => { handleSetActiveTab(tab.id); setOpenMenuTabId(null); }}
                  onDoubleClick={() => startRename(tab.id, tab.label)}
                  title={tab.label}
                  className={`group flex items-center gap-1 px-2.5 py-2 text-xs cursor-pointer select-none transition-all duration-150 border-b-2 flex-shrink min-w-[60px] max-w-[220px] ${
                    isActive
                      ? 'bg-gray-850 text-gray-100 border-blue-500 flex-shrink-0'
                      : 'text-gray-400 hover:text-gray-300 hover:bg-gray-800/40 border-transparent'
                  }`}
                >
                  <span className="flex-shrink-0">{info.icon}</span>
                  <span className={`truncate flex-1 min-w-0 ${isActive ? 'font-medium' : ''}`} title={tab.label}>{tab.label}</span>
                  {tab.scanning && (
                    <Spinner size={3} className="flex-shrink-0" />
                  )}
                  {tab.items.length > 0 && !tab.scanning && (
                    <span className="text-[10px] font-mono bg-gray-700/60 text-gray-400 rounded-full px-1.5 py-0.5 leading-none flex-shrink-0">{tab.items.length}</span>
                  )}
                  {editingTabId !== tab.id && (
                    <div className="relative flex-shrink-0">
                      <button
                        ref={(el) => { tabMenuRef.current[tab.id] = el; }}
                        onClick={(e) => { e.stopPropagation(); setOpenMenuTabId(openMenuTabId === tab.id ? null : tab.id); }}
                        className="p-0.5 rounded hover:bg-gray-600/40 opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 hover:text-gray-300"
                        title="Tuỳ chọn"
                      >
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
                        </svg>
                      </button>
                      {openMenuTabId === tab.id && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setOpenMenuTabId(null); }} />
                          <div className="fixed z-20 bg-gray-800 border border-gray-600/50 rounded-xl shadow-2xl py-1 w-36"
                            style={{
                              top: (tabMenuRef.current[tab.id]?.getBoundingClientRect().bottom ?? 60) + 4,
                              left: (tabMenuRef.current[tab.id]?.getBoundingClientRect().left ?? 100),
                            }}>
                            <button
                              onClick={(e) => { e.stopPropagation(); setOpenMenuTabId(null); startRename(tab.id, tab.label); }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700/60 hover:text-white transition-colors"
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
                              Đổi tên
                            </button>
                            <div className="border-t border-gray-700/50 my-0.5" />
                            <button
                              onClick={(e) => { e.stopPropagation(); setOpenMenuTabId(null); archiveTab(tab.id); }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700/60 hover:text-white transition-colors"
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 8v13H3V8M1 3h22v5H1z"/></svg>
                              Lưu trữ
                            </button>
                            <button
                              onClick={(e) => { e.stopPropagation(); setOpenMenuTabId(null); permanentlyDeleteTab(tab.id); }}
                              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 transition-colors"
                            >
                              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>
                              Xoá tab
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
                  {/* Overflow menu - tabs ẩn nếu > MAX_VISIBLE */}
                  {hasOverflow && (
                    <div className="relative flex-shrink-0">
                      <button
                        ref={overflowRef}
                        onClick={(e) => { e.stopPropagation(); setShowOverflowTabs(v => !v); }}
                        className="flex items-center gap-1 px-2.5 py-2 text-xs text-gray-400 hover:text-gray-300 hover:bg-gray-800/40 border-b-2 border-transparent"
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                          <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
                        </svg>
                        <span className="text-[10px] text-gray-400">+{tabs.length - MAX_VISIBLE}</span>
                      </button>
                      {showOverflowTabs && (
                        <>
                          <div className="fixed inset-0 z-10" onClick={(e) => { e.stopPropagation(); setShowOverflowTabs(false); }} />
                          <div className="fixed z-20 bg-gray-800 border border-gray-600/50 rounded-xl shadow-2xl py-1 w-56"
                            style={{
                              top: (overflowRef.current?.getBoundingClientRect().bottom ?? 60) + 4,
                              left: (overflowRef.current?.getBoundingClientRect().left ?? 100),
                            }}>
                            {tabs.slice(MAX_VISIBLE).map(tab => {
                              const info = SCAN_TAB_LABELS[tab.scanType] || { icon: <ClipboardListIcon className="w-4 h-4" />, label: tab.scanType };
                              const isActive = tab.id === activeTabId;
                              return (
                                <button
                                  key={tab.id}
                                  onClick={(e) => { e.stopPropagation(); handleSetActiveTab(tab.id); setShowOverflowTabs(false); }}
                                  className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors ${isActive ? 'bg-blue-500/10 text-blue-300' : 'text-gray-300 hover:bg-gray-700/60 hover:text-white'}`}
                                >
                                  <span>{info.icon}</span>
                                  <span className="truncate flex-1">{tab.label}</span>
                                  {tab.items.length > 0 && <span className="text-[10px] text-gray-400">{tab.items.length}</span>}
                                </button>
                              );
                            })}
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-0.5 pr-2 flex-shrink-0">
            {/* Archive + History */}
            <div className="relative">
              <div className="flex items-center gap-0">
                <button onClick={() => setShowArchive(v => !v)}
                  className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 8v13H3V8M1 3h22v5H1z"/></svg>
                  {archivedTabs.length > 0 && (<span className="text-[10px] bg-amber-600/30 text-amber-300 rounded-full px-1.5 py-0.5 leading-none">{archivedTabs.length}</span>)}
                </button>
                <button onClick={() => setShowHistory(true)}
                  className="p-1.5 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors" title="Lịch sử quét"
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </button>
              </div>
              {showArchive && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => { setShowArchive(false); setArchiveSearch(''); }} />
                  <div className="absolute z-20 right-0 top-full mt-1 bg-gray-800 border border-gray-600/50 rounded-xl shadow-2xl py-2 w-[340px] max-h-[420px] flex flex-col">
                    <div className="px-3 pb-2 flex items-center gap-2 flex-shrink-0">
                      <span className="text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Đã lưu trữ</span>
                      <span className="text-[10px] text-gray-400">({archivedTabs.length})</span>
                      <button onClick={loadArchivedTabs} className="p-0.5 hover:text-white ml-auto" title="Làm mới">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                          <path d="M21 2v6h-6M3 12a9 9 0 0115.36-6.36L21 8M3 22v-6h6M21 12a9 9 0 01-15.36 6.36L3 16"/>
                        </svg>
                      </button>
                    </div>
                    <div className="px-3 pb-2 flex-shrink-0">
                      <input type="text" value={archiveSearch} onChange={(e) => setArchiveSearch(e.target.value)}
                        placeholder="🔍 Tìm theo tên..."
                        className="w-full bg-gray-700/50 text-gray-200 text-[11px] rounded-lg px-2.5 py-1.5 border border-gray-600/30 focus:outline-none focus:border-blue-500 placeholder-gray-500" />
                    </div>
                    <div className="flex-1 overflow-y-auto">
                      {(() => {
                        const filtered = archivedTabs
                          .filter((t: any) => !archiveSearch || t.name?.toLowerCase().includes(archiveSearch.toLowerCase()))
                          .sort((a: any, b: any) => (b.createdAt || b.created_at || 0) - (a.createdAt || a.created_at || 0));
                        if (filtered.length === 0) {
                          return <div className="px-3 py-4 text-xs text-gray-400 text-center">{archiveSearch ? 'Không tìm thấy' : 'Không có tab nào được lưu trữ'}</div>;
                        }
                        return filtered.map((t: any) => (
                          <div key={t.id} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-700/60 group">
                            <div className="flex-1 min-w-0">
                              <div className="text-xs text-gray-300 truncate">{t.name}</div>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-[10px] text-gray-400">{t.items_count ?? t.itemsCount ?? 0} items</span>
                                <span className="text-[10px] text-gray-700">·</span>
                                <span className="text-[10px] text-gray-400">{formatArchivedDate(t.createdAt || t.created_at)}</span>
                              </div>
                            </div>
                            <button onClick={() => restoreTab(t.id)}
                              className="text-[10px] px-2 py-0.5 rounded bg-blue-700/40 text-blue-300 hover:bg-blue-700/60 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">Khôi phục</button>
                            <button onClick={() => permanentlyDeleteTab(t.id)}
                              className="text-[10px] px-2 py-0.5 rounded bg-red-800/40 text-red-400 hover:bg-red-800/60 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">Xoá</button>
                          </div>
                        ));
                      })()}
                    </div>
                  </div>
                </>
              )}
            </div>

            {/* New tab */}
            <div className="relative" ref={newTabMenuRef}>
              <button
                onClick={() => setShowNewTabMenu(v => !v)}
                className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-600 text-white-important hover:bg-emerald-500 transition-colors shadow-sm"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
                </svg>
                <span className="hidden sm:inline">Tab mới</span>
              </button>
              {showNewTabMenu && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setShowNewTabMenu(false)} />
                  <div className="fixed z-20 bg-gray-800 border border-gray-600/50 rounded-xl shadow-2xl py-1.5 w-[280px]"
                    style={{
                      top: newTabMenuRef.current ? newTabMenuRef.current.getBoundingClientRect().bottom + 4 : 0,
                      right: newTabMenuRef.current ? document.documentElement.clientWidth - newTabMenuRef.current.getBoundingClientRect().right : 0,
                    }}
                  >
                    <div className="px-3 py-1.5 text-[10px] text-gray-400 uppercase tracking-wider font-semibold">Loại quét</div>
                    <div className="max-h-[320px] overflow-y-auto">
                      {SCAN_CONFIGS.map(cfg => (
                        <button key={cfg.scanType}
                          onClick={() => !cfg.comingSoon && openNewTab(cfg.scanType)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-xs text-left transition-colors ${cfg.comingSoon ? 'text-gray-400 cursor-not-allowed' : 'text-gray-300 hover:bg-gray-700/60 hover:text-white'}`}
                        >
                          <span className="text-base">{cfg.icon}</span>
                          <div className="flex flex-col flex-1 min-w-0">
                            <span className="font-medium">{cfg.label}</span>
                            <span className="text-[10px] text-gray-400">{cfg.description}</span>
                          </div>
                          {cfg.comingSoon && (
                            <span className="flex-shrink-0 text-[9px] px-1.5 py-0.5 rounded bg-yellow-500/15 text-yellow-500 font-medium">Đang phát triển</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* ── Rename dialog ─────────────────────────────────────── */}
      {showRenameDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-gray-800 border border-gray-600/50 rounded-2xl shadow-2xl p-6 w-[360px]">
            <h3 className="text-sm font-semibold text-white mb-4">Đổi tên tab</h3>
            <input
              ref={editInputRef}
              type="text" value={editingLabel}
              onChange={(e) => setEditingLabel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); else if (e.key === 'Escape') { setShowRenameDialog(false); setEditingTabId(null); } }}
              className="w-full bg-gray-700 text-gray-100 text-sm rounded-xl px-4 py-2.5 border border-gray-600/30 focus:outline-none focus:border-blue-500 mb-4"
              autoFocus
            />
            <div className="flex items-center gap-2 justify-end">
              <button onClick={() => { setShowRenameDialog(false); setEditingTabId(null); }}
                className="px-4 py-2 rounded-lg text-xs text-gray-400 hover:text-white hover:bg-gray-700 transition-colors">
                Huỷ
              </button>
              <button onClick={commitRename}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors">
                Lưu
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── History panel overlay ── */}
      {showHistory && (
        <div className="fixed inset-0 z-50 flex">
          <div className="w-[420px] h-full border-r border-gray-700 bg-gray-900 shadow-2xl">
            <ScanHistoryPanel
              accountId={accountId}
              tabId={activeTab?.id}
              tabName={activeTab?.label}
              onClose={() => setShowHistory(false)}
              onRestoreInput={(log) => {
                // Khôi phục input từ log
                if (activeTab) {
                  const patch: any = {};
                  if (log.input) {
                    if (log.input.includes('\n')) {
                      patch.batchMode = true;
                      patch.batchInput = log.input;
                    } else if (log.input.startsWith('http')) {
                      patch.url = log.input;
                    } else {
                      patch.keyword = log.input;
                    }
                  }
                  updateTab(activeTab.id, { ...patch, items: [], cursor: null, pageInfo: { endCursor: null, hasNextPage: false } });
                }
                setShowHistory(false);
              }}
            />
          </div>
          <div className="flex-1 bg-black/40" onClick={() => setShowHistory(false)} />
        </div>
      )}

      {/* ── Active tab content ──────────────────────────────────── */}
      {activeTab ? (
        <ActiveTabContent
          key={activeTab.id}
          tab={activeTab}
          accountId={accountId}
          onUpdate={(patch) => updateTab(activeTab.id, patch)}
          onStart={() => handleStartScan(activeTab.id)}
          onStop={() => handleStopScan(activeTab.id)}
          onLoadMore={() => handleLoadMore(activeTab.id)}
          onExportExcel={() => handleExportExcel(activeTab.id)}
          onDuplicate={() => duplicateTab(activeTab)}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
          Chọn hoặc mở tab mới để bắt đầu quét
        </div>
      )}
    </div>
  );
}

// ─── Helper: build filter args for keyword searches ─────────────────

function buildFilterArgs(scanType: ScanType, filters: ScanFilters): string[] | undefined {
  const args: string[] = [];

  // Group: public groups filter - giống original {"name":"public_groups","args":""}
  if (filters.public && scanType === 'group_keyword') {
    args.push('{"name":"public_groups","args":""}');
  }

  // Post: recent posts filter - giống original {"name":"recent_posts","args":""}
  if (filters.recent && scanType === 'post_keyword') {
    args.push('{"name":"recent_posts","args":""}');
  }

  // Year filter (cho post_keyword)
  if (filters.year && scanType === 'post_keyword') {
    const year = filters.year;
    args.push(`{"name":"creation_time","args":"{\\"start_year\\":\\"${year}\\",\\"start_month\\":\\"${year}-1\\",\\"end_year\\":\\"${year}\\",\\"end_month\\":\\"${year}-12\\",\\"start_day\\":\\"${year}-1-1\\",\\"end_day\\":\\"${year}-12-31\\"}"}`);
  }

  return args.length > 0 ? args : undefined;
}

// ─── Active Tab Content Component ───────────────────────────────────

function ActiveTabContent({
  tab,
  accountId,
  onUpdate,
  onStart,
  onStop,
  onLoadMore,
  onExportExcel,
  onDuplicate,
}: {
  tab: ScanTabData;
  accountId: string;
  onUpdate: (patch: Partial<ScanTabData>) => void;
  onStart: () => void;
  onStop: () => void;
  onLoadMore: () => void;
  onExportExcel: () => void;
  onDuplicate: () => void;
}) {
  const config = SCAN_CONFIGS.find(c => c.scanType === tab.scanType) || SCAN_CONFIGS[0];
  const info = SCAN_TAB_LABELS[tab.scanType] || { icon: <ClipboardListIcon className="w-4 h-4" />, label: tab.scanType };
  const inputConfig = SCAN_INPUT_CONFIG[tab.scanType] || { modes: ['single_url'], defaultMode: 'single_url' };

  // ── Client-side filters ──────────────────────────────────────
  const filteredItems = React.useMemo(() => {
    let result = tab.items;

    // Lọc bình luận theo từ khóa
    if (tab.scanType === 'post_comments' && tab.filters.commentKeyword?.trim()) {
      const kw = tab.filters.commentKeyword.trim().toLowerCase();
      result = result.filter(item =>
        (item.body || '').toLowerCase().includes(kw) ||
        (item.authorName || '').toLowerCase().includes(kw)
      );
    }

    // Lọc bình luận có chứa SĐT Việt Nam
    if (tab.scanType === 'post_comments' && tab.filters.detectPhone) {
      result = result.filter(item => hasVietnamesePhone(item.body || ''));
    }

    return result;
  }, [tab.items, tab.scanType, tab.filters.commentKeyword, tab.filters.detectPhone]);

  const { batchMode, batchInput, threadCount, batchProgress } = tab;
  const progressPct = tab.filters.maxResults > 0 ? Math.min(100, Math.round((tab.items.length / tab.filters.maxResults) * 100)) : 0;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* ── Toolbar ────────────────────────────────────────────── */}
      <div className="flex-shrink-0 px-4 py-3 bg-gray-850 border-b border-gray-700/50 space-y-2.5">
        {/* Row 1: Search input + type badge */}
        <div className="flex items-center gap-2.5">
          {/* Type badge */}
          <span className="flex-shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-blue-500/10 text-blue-400 border border-blue-500/20">
            {info.icon} {info.label}
          </span>

          {/* Main input */}
          {!batchMode && config.requiresUrl && (
            <input type="text" value={tab.url}
              onChange={(e) => onUpdate({ url: e.target.value })}
              placeholder={config.urlPlaceholder}
              className="flex-1 bg-gray-700/80 text-gray-100 text-sm rounded-xl px-4 py-2 border border-gray-600/30 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 placeholder-gray-500 transition-all"
              onKeyDown={(e) => e.key === 'Enter' && onStart()} />
          )}
          {!batchMode && config.showKeywordInput && (
            <input type="text" value={tab.keyword}
              onChange={(e) => onUpdate({ keyword: e.target.value })}
              placeholder={config.keywordPlaceholder || 'Nhập từ khóa...'}
              className="flex-1 bg-gray-700/80 text-gray-100 text-sm rounded-xl px-4 py-2 border border-gray-600/30 focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500/30 placeholder-gray-500 transition-all"
              onKeyDown={(e) => e.key === 'Enter' && onStart()} />
          )}
        </div>

        {/* Row 2: Settings + Actions */}
        <div className="flex items-center gap-2 flex-wrap justify-end">
          {/* Batch toggle */}
          {inputConfig.modes.includes('batch_url') && (
            <button
              onClick={() => onUpdate({ batchMode: !batchMode, batchInput: '', items: [], cursor: null, pageInfo: { endCursor: null, hasNextPage: false }, progress: '', error: '' })}
              className={`flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                batchMode
                  ? 'bg-purple-600/20 text-purple-300 border border-purple-500/30'
                  : 'bg-gray-700/50 text-gray-400 hover:text-gray-200 border border-transparent hover:border-gray-600/30'
              }`}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/>
              </svg>
              {batchMode ? 'Batch' : 'Đơn'}
            </button>
          )}

          {/* Threads (batch only) */}
          {batchMode && (
            <div className="flex items-center gap-1">
              <span className="text-[10px] text-gray-400">Luồng:</span>
              <select value={threadCount} onChange={(e) => onUpdate({ threadCount: Number(e.target.value) })}
                className="bg-gray-700/50 text-gray-300 text-[11px] rounded-lg px-2 py-1.5 border border-gray-600/30 focus:outline-none focus:border-blue-500">
                <option value={1}>1</option><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option>
              </select>
            </div>
          )}

          {/* Target count */}
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-gray-400">Mục tiêu:</span>
            <select value={tab.filters.maxResults} onChange={(e) => onUpdate({ filters: { ...tab.filters, maxResults: Number(e.target.value) } })}
              className="bg-gray-700/50 text-gray-300 text-[11px] rounded-lg px-2 py-1.5 border border-gray-600/30 focus:outline-none focus:border-blue-500">
              <option value={10}>10</option><option value={20}>20</option><option value={50}>50</option>
              <option value={100}>100</option><option value={200}>200</option><option value={500}>500</option>
              <option value={1000}>1K</option><option value={5000}>5K</option><option value={10000}>10K</option>
              <option value={20000}>20K</option><option value={50000}>50K</option>
            </select>
          </div>

          {/* Filters - inline with settings */}
          {!batchMode && (
            <ScanFiltersPanel scanType={tab.scanType} filters={tab.filters} onChange={(f) => onUpdate({ filters: f })} />
          )}

          {/* Separator */}
          <div className="w-px h-5 bg-gray-700/50 mx-0.5" />

          {/* Action buttons */}
          {tab.scanning ? (
            <button onClick={onStop}
              className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg text-xs font-semibold bg-red-600 text-white hover:bg-red-500 transition-colors shadow-sm">
              <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>
              Dừng quét
            </button>
          ) : (
            <button onClick={onStart} disabled={!accountId}
              className="flex items-center gap-1.5 px-5 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-blue-600 to-blue-500 text-white-important hover:from-blue-500 hover:to-blue-400 transition-all shadow-sm disabled:opacity-40 disabled:cursor-not-allowed">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
              Bắt đầu quét
            </button>
          )}

          <button onClick={onDuplicate}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-300 hover:bg-gray-700/60 transition-colors" title="Nhân bản tab">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
            </svg>
          </button>
        </div>

        {/* Batch textarea */}
        {batchMode && (
          <textarea value={batchInput} onChange={(e) => onUpdate({ batchInput: e.target.value })}
            placeholder="Mỗi dòng 1 URL hoặc ID Facebook..."
            className="w-full bg-gray-700/60 text-gray-200 text-xs rounded-xl px-4 py-2.5 border border-gray-600/30 focus:outline-none focus:border-purple-500 placeholder-gray-500 resize-none"
            rows={3} />
        )}

        {/* ── Progress & Status bar ───────────────────────────── */}
        {(tab.scanning || tab.progress || tab.error || tab.items.length > 0) && (
          <div className="space-y-1.5">
            {/* Progress bar */}
            {tab.scanning && tab.filters.maxResults > 0 && (
              <div className="flex items-center gap-3">
                <div className="flex-1 h-2 bg-gray-700/50 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-blue-500 to-cyan-400 rounded-full transition-all duration-500"
                    style={{ width: `${progressPct}%` }} />
                </div>
                <span className="text-[11px] text-gray-400 font-medium tabular-nums whitespace-nowrap">
                  {tab.items.length}/{tab.filters.maxResults}
                </span>
              </div>
            )}

            {/* Progress text */}
            {tab.progress && (
              <div className="flex items-center gap-1.5 text-xs">
                {tab.scanning && (
                  <Spinner size={3} className="flex-shrink-0" />
                )}
                {/* <span className={tab.scanning ? 'text-blue-300' : 'text-emerald-400'}>{tab.progress}</span> */}
              </div>
            )}

            {/* Batch progress */}
            {tab.scanning && batchMode && batchProgress.total > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-blue-400">Batch:</span>
                <span className="text-gray-300 font-medium">{batchProgress.done}/{batchProgress.total}</span>
                <div className="flex-1 h-1.5 bg-gray-700/50 rounded-full overflow-hidden max-w-[200px]">
                  <div className="h-full bg-gradient-to-r from-purple-500 to-pink-400 rounded-full transition-all duration-300"
                    style={{ width: `${(batchProgress.done / batchProgress.total) * 100}%` }} />
                </div>
                <span className="text-gray-400 text-[10px] truncate">{batchProgress.current}</span>
              </div>
            )}

            {/* Error */}
            {tab.error && (
              <div className="flex items-start gap-1.5 text-xs text-red-400 bg-red-500/5 rounded-lg px-3 py-1.5">
                <svg className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
                </svg>
                <span className="leading-relaxed">{tab.error}</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Results table */}
      <div className="flex-1 overflow-hidden">
        <ScanResultTable
          scanType={tab.scanType}
          items={filteredItems}
          totalItems={tab.items.length}
          loading={tab.scanning}
          hasMore={tab.pageInfo.hasNextPage}
          onLoadMore={onLoadMore}
          onExportExcel={onExportExcel}
        />
      </div>
    </div>
  );
}

// ─── Fallback: xử lý batch UI-side cho scan types chưa có backend batch ──

async function fallbackBatchScan(
  accountId: string,
  scanType: string,
  lines: string[],
  extractIdFromUrl: (url: string) => string,
  filterArgs: string[] | undefined,
  threadCount: number,
  onProgress: (done: number, total: number, current: string) => void,
): Promise<{ success: boolean; items: any[]; errors: string[] }> {
  const allItems: any[] = [];
  const errors: string[] = [];
  let done = 0;
  const total = lines.length;

  const scanOne = async (input: string, idx: number) => {
    const id = extractIdFromUrl(input);
    if (!id) {
      errors.push(`${input}: ID không hợp lệ`);
      return;
    }

    try {
      let res: any;
      switch (scanType) {
        case 'group_keyword':
          res = await ipc.fb?.scanGroupKeyword({ accountId, keyword: id, filters: filterArgs });
          break;
        case 'fanpage_keyword':
          res = await ipc.fb?.scanFanpageKeyword({ accountId, keyword: id, filters: filterArgs });
          break;
        case 'post_keyword':
          res = await ipc.fb?.scanPostKeyword({ accountId, keyword: id, filters: filterArgs });
          break;
        default:
          errors.push(`${input}: Không hỗ trợ batch cho loại này`);
          return;
      }

      if (res?.success && res.items) {
        allItems.push(...res.items.map((item: any) => ({ ...item, _batchSource: id, _batchIndex: idx })));
      } else {
        errors.push(`${id}: ${res?.error || 'Không có dữ liệu'}`);
      }
    } catch (err: any) {
      errors.push(`${id}: ${err.message}`);
    }
  };

  // Thread pool
  const queue = lines.map((line, i) => ({ line, i }));
  let index = 0;

  const worker = async () => {
    while (index < queue.length) {
      const task = queue[index++];
      const shortId = task.line.length > 30 ? task.line.slice(0, 27) + '...' : task.line;
      onProgress(done, total, shortId);
      await scanOne(task.line, task.i);
      done++;
      onProgress(done, total, '');
    }
  };

  const workers = Array.from({ length: Math.min(threadCount, total) }, () => worker());
  await Promise.all(workers);

  allItems.sort((a, b) => (a._batchIndex || 0) - (b._batchIndex || 0));
  return { success: errors.length < total, items: allItems, errors };
}

// ─── Phone detection helper ────────────────────────────────────────

const VN_PHONE_REGEX = /(?:0[35789]\d{8}|(?:\+84|84)[35789]\d{8}|01[2-9]\d{8})/;

function hasVietnamesePhone(text: string): boolean {
  if (!text) return false;
  // Strip spaces, dots, dashes before testing
  const cleaned = text.replace(/[\s.\-()]/g, '');
  return VN_PHONE_REGEX.test(cleaned);
}

function formatArchivedDate(ts: number | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60_000) return 'Vừa xong';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} phút trước`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} giờ trước`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)} ngày trước`;
  return d.toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
