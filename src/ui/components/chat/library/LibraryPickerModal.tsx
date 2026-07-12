/**
 * LibraryPickerModal - Chọn file từ thư viện Media dùng chung.
 *
 * Layout:
 * ┌─────────────────────────────────────────────────────┐
 * │  Header: 📁 Thư viện Media                    ✕     │
 * ├──────────┬──────────────────────────────────────────┤
 * │          │  [🔍 Tìm kiếm...]                         │
 * │  Thư    │  Grid items (filtered by initialType)     │
 * │  mục    │                                           │
 * │  30%    │                                           │
 * ├──────────┴──────────────────────────────────────────┤
 * │  [📤 Upload] [💻 Máy tính]       [Gửi X file]      │
 * └─────────────────────────────────────────────────────┘
 *
 * - initialType quyết định hiển thị (image/video/file/all)
 * - Không có tabs chuyển loại (tránh mixed selection khó xử lý)
 * - Folder sidebar bên trái, file name editing khi hover
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import ipc from '../../../lib/ipc';
import * as channelIpc from '../../../lib/channelIpc';
import DataAccessor, { refreshLibraryCache } from '../../../lib/data/DataAccessor';
import { useChatStore } from '@/store/chatStore';
import { messageQueue, generateTempId, extractMsgIdFromResponse } from '@/lib/MessageQueue';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { CloseIcon, EditIcon, FolderIcon, ImageIcon, MonitorIcon, RefreshIcon, SendIcon, StarIcon, TrashIcon } from '@/components/common/icons';

interface LibraryItem {
  uuid: string;
  owner_zalo_id: string;
  type: 'image' | 'video' | 'file';
  name: string;
  mime_type: string;
  size: number;
  fileUrl: string;
  thumbUrl: string | null;
  is_favorite: number;
  folder_id: number | null;
  created_at: number;
  /** Local file path trên Boss (được inject bởi library IPC/handler, undefined ở employee mode) */
  _localPath?: string;
  /** Local thumbnail path trên Boss (được inject bởi library IPC/handler, undefined ở employee mode) */
  _thumbLocalPath?: string;
}

interface LibraryFolder {
  id: number;
  name: string;
  parent_id: number | null;
  color: string;
  item_count?: number;
}

type MediaType = 'image' | 'video' | 'file' | 'all';

interface Props {
  zaloId: string;
  threadId: string;
  threadType: number;
  initialType?: MediaType;
  onClose: () => void;
}

const TYPE_LABELS: Record<MediaType, string> = {
  all: 'Tất cả',
  image: 'Ảnh',
  video: 'Video',
  file: 'File',
};

export default function LibraryPickerModal({
  zaloId, threadId, threadType, initialType = 'all', onClose,
}: Props) {
  const [items, setItems] = useState<LibraryItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [uploading, setUploading] = useState(false);

  // Folders
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [activeFolderId, setActiveFolderId] = useState<number | null>(undefined as any);
  const [showFolderMenu, setShowFolderMenu] = useState<number | null>(null);

  // Editing file name
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState('');

  // Folder creation / rename inline
  const [folderInput, setFolderInput] = useState<{ mode: 'create' | 'rename'; id?: number; value: string } | null>(null);

  // Context menu (⋯) cho item actions — dùng fixed position để tránh overflow clipping
  const [menuTarget, setMenuTarget] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  // Folder picker dropdown (sub-view của menu)
  const [moveFolderTarget, setMoveFolderTarget] = useState<string | null>(null);
  const [folderPos, setFolderPos] = useState<{ top: number; left: number } | null>(null);

  const closeMenus = useCallback(() => {
    setMenuTarget(null); setMenuPos(null);
    setMoveFolderTarget(null); setFolderPos(null);
  }, []);

  const handleMenuClick = useCallback((e: React.MouseEvent, uuid: string) => {
    e.stopPropagation();
    if (menuTarget === uuid) { closeMenus(); return; }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setMenuPos({ top: rect.bottom + 4, left: rect.right - 192 }); // 192 = w-48
    setMenuTarget(uuid);
    setMoveFolderTarget(null);
  }, [menuTarget, closeMenus]);

  // Drag & drop upload
  const [isDragOver, setIsDragOver] = useState(false);

  const gridRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const directInputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);

  // ── Load folders (lọc theo type) ───────────────────────────

  const loadFolders = useCallback(async () => {
    try {
      const result = await DataAccessor.getLibraryFolders({ zaloId, type: initialType === 'all' ? undefined : initialType });
      if (result.success) {
        setFolders(result.items || []);
      }
    } catch {}
  }, [zaloId, initialType]);

  useEffect(() => { loadFolders(); }, [loadFolders]);

  // ── Load items ──────────────────────────────────────────────

  const loadItems = useCallback(async (pageNum = 1, append = false) => {
    setLoading(true);
    try {
      const result = await DataAccessor.getLibraryItems({
        zaloId,
        type: initialType === 'all' ? '' : initialType,
        page: pageNum,
        limit: 50,
        search: search || undefined,
        folderId: activeFolderId === -1 ? undefined : activeFolderId,
      });
      if (result.success) {
        const newItems = result.items || [];
        if (newItems.length > 0) {
          console.log('[Library] loadItems sample:', {
            firstItem: { ...newItems[0], file_path: undefined, thumb_path: undefined },
            thumbUrl: newItems[0]?.thumbUrl?.slice(0, 80),
            hasLocalPath: !!(newItems[0] as any)._localPath,
          });
        }
        // Nếu activeFolderId === -1 (Yêu thích), filter
        const filtered = activeFolderId === -1
          ? newItems.filter((i: LibraryItem) => i.is_favorite)
          : newItems;
        setItems(prev => append ? [...prev, ...filtered] : filtered);
        setHasMore(newItems.length >= 50);
        setTotal(result.total || 0);
      }
    } catch {}
    setLoading(false);
  }, [zaloId, initialType, search, activeFolderId]);

  useEffect(() => {
    setPage(1);
    loadItems(1);
  }, [search, activeFolderId]);

  const handleLoadMore = () => {
    const next = page + 1;
    setPage(next);
    loadItems(next, true);
  };

  // ── Scroll infinite ─────────────────────────────────────────

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 300 && hasMore && !loading) {
      handleLoadMore();
    }
  }, [hasMore, loading]);

  // ── Select ──────────────────────────────────────────────────

  const toggleSelect = (uuid: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  // ── Rename file ─────────────────────────────────────────────

  const startRename = (uuid: string, currentName: string) => {
    setEditingName(uuid);
    setEditingValue(currentName);
    setTimeout(() => editInputRef.current?.select(), 50);
  };

  const submitRename = async (uuid: string) => {
    const name = editingValue.trim();
    if (!name || name === items.find(i => i.uuid === uuid)?.name) {
      setEditingName(null);
      return;
    }
    console.log('[Library] submitRename:', uuid, name);
    const res = await DataAccessor.updateLibraryItem(uuid, { name });
    console.log('[Library] submitRename result:', res);
    if (res.success) {
      setItems(prev => prev.map(i => i.uuid === uuid ? { ...i, name } : i));
    }
    setEditingName(null);
  };

  // ── Folder CRUD ─────────────────────────────────────────────

  const handleCreateFolder = (parentId?: number) => {
    setFolderInput({ mode: 'create', value: '', id: parentId });
  };

  const handleAddChildFolder = (parentId: number) => {
    setFolderInput({ mode: 'create', value: '', id: parentId });
    setShowFolderMenu(null);
  };

  const handleRenameFolder = (id: number) => {
    const folder = folders.find(f => f.id === id);
    setFolderInput({ mode: 'rename', id, value: folder?.name || '' });
    setShowFolderMenu(null);
  };

  const submitFolderInput = async () => {
    if (!folderInput || !folderInput.value.trim()) { setFolderInput(null); return; }
    const name = folderInput.value.trim();
    try {
      let res;
      if (folderInput.mode === 'create') {
        const parentId = folderInput.id ?? activeFolderId ?? null;
        const folderType = initialType === 'all' ? undefined : initialType;
        res = await DataAccessor.createLibraryFolder({ zaloId, name, parentId, color: '#6366f1', type: folderType });
      } else if (folderInput.mode === 'rename' && folderInput.id) {
        res = await DataAccessor.renameLibraryFolder(folderInput.id, name);
      }
      if (res?.success !== false) loadFolders();
      else console.warn('[Library] submitFolderInput failed:', res);
    } catch (err) {
      console.warn('[Library] submitFolderInput error:', err);
    }
    setFolderInput(null);
  };

  const handleDeleteFolder = async (id: number) => {
    // Dùng confirm dialog của Electron (window.confirm có sẵn)
    const ok = window.confirm?.('Xoá thư mục này? File trong thư mục sẽ không bị xoá.') ?? true;
    if (!ok) return;
    try {
      await DataAccessor.deleteLibraryFolder(id);
      if (activeFolderId === id) setActiveFolderId(undefined as any);
      loadFolders();
    } catch {}
    setShowFolderMenu(null);
  };

  // ── Toggle favorite ─────────────────────────────────────────

  const handleToggleFavorite = async (uuid: string, current: number) => {
    console.log('[Library] toggleFavorite:', uuid, 'current:', current, 'new:', current ? 0 : 1);
    const res = await DataAccessor.updateLibraryItem(uuid, { isFavorite: current ? 0 : 1 });
    console.log('[Library] toggleFavorite result:', res);
    if (res.success) {
      setItems(prev => prev.map(i => i.uuid === uuid ? { ...i, is_favorite: current ? 0 : 1 } : i));
    }
  };

  // ── Move item to folder ─────────────────────────────────────

  const handleMoveToFolder = async (itemUuid: string, newFolderId: number | null) => {
    const res = await DataAccessor.updateLibraryItem(itemUuid, { folderId: newFolderId });
    if (res.success) {
      setItems(prev => {
        // Nếu đang xem folder cụ thể và move ra ngoài → remove khỏi list ngay
        if (activeFolderId !== undefined && activeFolderId !== null && activeFolderId > 0 && newFolderId !== activeFolderId) {
          return prev.filter(i => i.uuid !== itemUuid);
        }
        return prev.map(i => i.uuid === itemUuid ? { ...i, folder_id: newFolderId } : i);
      });
      loadFolders();
    }
    closeMenus();
  };

  // ── Drag & drop upload ──────────────────────────────────────

  /** Xoá item vĩnh viễn */
  const handleDeleteItem = async (uuid: string) => {
    const ok = window.confirm?.('Xoá file này khỏi thư viện? Hành động này không thể hoàn tác.') ?? true;
    if (!ok) return;
    const res = await DataAccessor.deleteLibraryItem(uuid);
    if (res.success) {
      setItems(prev => prev.filter(i => i.uuid !== uuid));
      setSelected(prev => { const next = new Set(prev); next.delete(uuid); return next; });
      loadFolders();
    }
    closeMenus();
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const file = e.dataTransfer.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const base64 = await fileToBase64(file);
      const result = await DataAccessor.uploadToLibrary({
        zaloId, fileName: file.name, mimeType: file.type, base64,
      });
      if (result.success && result.data) {
        setSelected(prev => new Set(prev).add(result.data.uuid));
        setPage(1);
        loadItems(1);
        loadFolders();
      }
    } catch (err) {
      console.warn('[Library] drop upload error:', err);
    }
    setUploading(false);
  }, [zaloId, loadItems, loadFolders]);

  // ── Send ────────────────────────────────────────────────────

  /** Lấy auth object từ account hiện tại */
  const getAuthForZaloId = async (): Promise<any> => {
    try {
      const res = await ipc.login?.getAccounts();
      if (res?.success && res.accounts) {
        const acc = res.accounts.find((a: any) => a.zalo_id === zaloId);
        if (acc?.cookies) return { cookies: acc.cookies, imei: acc.imei || '', userAgent: acc.user_agent || '' };
      }
    } catch {}
    // Fallback: thử qua employeeStore
    try {
      const { useEmployeeStore } = require('../../../store/employeeStore');
      const mode = useEmployeeStore.getState().mode;
      if (mode === 'employee') return {}; // employee mode: proxy action tự inject auth
    } catch {}
    return null;
  };

  const sendItem = async (item: any) => {
    console.log('[Library] sendItem:', { uuid: item.uuid, type: item.type, hasLocalPath: !!item._localPath, localPath: item._localPath, fileUrl: item.fileUrl, zaloId, threadId });
    const auth = await getAuthForZaloId();
    console.log('[Library] sendItem auth:', auth ? 'found' : 'null');
    try {
      if (item.type === "video") {
        // Video: cần 3-step upload (uploadVideoThumb → uploadVideoFile → sendVideo)
        if (item._localPath) {
          // Boss mode: dùng channelIpc.sendVideo với local file path
          const metaRes: any = await ipc.file?.getVideoMeta?.({ filePath: item._localPath }).catch(() => ({})) || {};
          await channelIpc.sendVideo('zalo', {
            auth,
            accountId: zaloId,
            threadId,
            threadType,
            filePath: item._localPath,
            thumbPath: metaRes.thumbPath || '',
            duration: metaRes.duration || 0,
            width: metaRes.width || 0,
            height: metaRes.height || 0,
          });
        } else {
          // Employee mode: boss proxy sẽ xử lý upload chain qua _libraryUuid
          const res = await ipc.zalo.sendVideo({
            auth: auth || {},
            zaloId,
            threadId,
            threadType,
            fileUrl: item.fileUrl,
            _libraryUuid: item.uuid,
          });
          console.log('[Library] sendVideo result:', res);
        }
      } else {
        // Image hoặc File
        const opts: any = { auth: auth || {}, zaloId, threadId, threadType };
        // Employee: fileUrl là full HTTP URL → dùng _libraryUuid để boss resolve path từ DB
        // Boss: fileUrl là relative path → dùng _localPath trực tiếp
        if (item.fileUrl && item.fileUrl.startsWith('http') && item.uuid) {
          console.log('[Library] sendItem: EMPLOYEE path, fileUrl+uuid');
          opts.fileUrl = item.fileUrl;
          opts._libraryUuid = item.uuid;
        } else if (item._localPath) {
          console.log('[Library] sendItem: BOSS path, _localPath');
          opts.filePath = item._localPath;
        } else if (item.fileUrl && item.uuid) {
          console.log('[Library] sendItem: FALLBACK path, fileUrl+uuid');
          opts.fileUrl = item.fileUrl;
          opts._libraryUuid = item.uuid;
        }
        console.log('[Library] sendItem opts:', { keys: Object.keys(opts), hasFilePath: !!opts.filePath, hasFileUrl: !!opts.fileUrl, hasLibraryUuid: !!opts._libraryUuid, threadId: opts.threadId });
        if (item.type === "image") {
          const res = await ipc.zalo.sendImage(opts);
          console.log('[Library] sendImage result:', res);
        } else {
          const res = await ipc.zalo.sendFile(opts);
          console.log('[Library] sendFile result:', res);
        }
      }
    } catch (err: any) {
      console.error('[Library] sendItem error:', err);
    }
  };

  const handleSendSelected = async () => {
    const selectedItems = items.filter(i => selected.has(i.uuid));
    if (selectedItems.length === 0) { onClose(); return; }
    const addMessage = useChatStore.getState().addMessage;
    const removeMessage = useChatStore.getState().removeMessage;
    const imageItems = selectedItems.filter(i => i.type === 'image');
    const videoItems = selectedItems.filter(i => i.type === 'video');
    const fileItems = selectedItems.filter(i => i.type === 'file');

    // ── Batch images ──
    if (imageItems.length > 0) {
      const batchTempId = generateTempId();
      const previewPaths = imageItems.map(i => i._localPath || i.fileUrl || '').filter(Boolean);
      addMessage(zaloId, threadId, {
        msg_id: batchTempId, owner_zalo_id: zaloId, thread_id: threadId,
        thread_type: threadType, sender_id: zaloId, content: '',
        msg_type: 'image', timestamp: Date.now(), is_sent: 1, status: 'sending',
        send_status: 'sending', temp_id: batchTempId, media_type: 'image',
        attachments: JSON.stringify(previewPaths.map(fp => ({ type: 'image', localPath: fp }))),
        local_paths: JSON.stringify(previewPaths.reduce((acc, fp, i) => ({ ...acc, [`img${i}`]: fp }), {})),
      });
      const auth = await getAuthForZaloId();
      const hasLocalPath = imageItems.every(i => i._localPath);
      messageQueue.enqueue({
        tempId: batchTempId, zaloId, threadId, threadType, channel: 'zalo',
        sendFn: async () => {
          try {
            if (imageItems.length === 1) {
              const item = imageItems[0];
              const opts: any = { auth: auth || {}, zaloId, threadId, threadType };
              if (item._localPath) opts.filePath = item._localPath;
              else { opts.fileUrl = item.fileUrl; opts._libraryUuid = item.uuid; }
              const res = await ipc.zalo.sendImage(opts);
              return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
            } else {
              const opts: any = { auth: auth || {}, zaloId, threadId, threadType, type: threadType };
              if (hasLocalPath) opts.filePaths = imageItems.map(i => i._localPath);
              else { opts.filePaths = imageItems.map(i => i.fileUrl); opts._libraryUuids = imageItems.map(i => i.uuid); }
              const res = await ipc.zalo.sendImages(opts);
              return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
            }
          } catch (err: any) { return { success: false, error: err?.message || String(err) }; }
        },
        onSuccess: () => {
          if (imageItems.length > 1) {
            messageQueue.registerImageBatch(batchTempId, zaloId, threadId, imageItems.length,
              () => { removeMessage(zaloId, threadId, batchTempId); });
          } else {
            removeMessage(zaloId, threadId, batchTempId);
          }
        },
      });
    }

    // ── Videos & Files (gửi lẻ qua queue) ──
    for (const item of [...videoItems, ...fileItems]) {
      const tempId = generateTempId();
      const previewPath = item._localPath || item.fileUrl || '';
      addMessage(zaloId, threadId, {
        msg_id: tempId, owner_zalo_id: zaloId, thread_id: threadId,
        thread_type: threadType, sender_id: zaloId, content: '',
        msg_type: item.type, timestamp: Date.now(), is_sent: 1, status: 'sending',
        send_status: 'pending', temp_id: tempId, media_type: item.type as any,
        attachments: JSON.stringify([{ type: item.type, localPath: previewPath }]),
      });
      messageQueue.enqueue({
        tempId, zaloId, threadId, threadType, channel: 'zalo',
        sendFn: async () => {
          try {
            const auth = await getAuthForZaloId();
            if (item.type === 'video') {
              if (item._localPath) {
                const metaRes: any = await ipc.file?.getVideoMeta?.({ filePath: item._localPath }).catch(() => ({})) || {};
                const res = await channelIpc.sendVideo('zalo', {
                  auth, accountId: zaloId, threadId, threadType, filePath: item._localPath,
                  thumbPath: metaRes.thumbPath || '', duration: metaRes.duration || 0,
                  width: metaRes.width || 0, height: metaRes.height || 0,
                });
                return { success: true, ...(res as any) };
              } else {
                const res = await ipc.zalo.sendVideo({ auth: auth || {}, zaloId, threadId, threadType, fileUrl: item.fileUrl, _libraryUuid: item.uuid });
                return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
              }
            } else {
              const opts: any = { auth: auth || {}, zaloId, threadId, threadType };
              if (item._localPath) opts.filePath = item._localPath;
              else { opts.fileUrl = item.fileUrl; opts._libraryUuid = item.uuid; }
              const res = await ipc.zalo.sendFile(opts);
              return { success: true, ...extractMsgIdFromResponse(res, 'zalo') };
            }
          } catch (err: any) { return { success: false, error: err?.message || String(err) }; }
        },
      });
    }

    // Scroll xuống cuối sau khi gửi
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('chat:scrollToBottom'));
    }, 100);
    onClose();
  };

  // ── Upload / Direct ─────────────────────────────────────────

  const handleUploadAndSend = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const base64 = await fileToBase64(file);
        const result = await DataAccessor.uploadToLibrary({
          zaloId, fileName: file.name, mimeType: file.type, base64,
        });
        if (result.success && result.data) {
          setSelected(prev => new Set(prev).add(result.data.uuid));
        }
      }
      setPage(1);
      loadItems(1);
      loadFolders();
    } catch {}
    setUploading(false);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleDirectFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      const auth = await getAuthForZaloId();
      const imagePaths: string[] = [];
      const videoPromises: Promise<void>[] = [];
      const filePromises: Promise<void>[] = [];

      // Phase 1: save all files as temp blobs and classify by type
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const base64 = await fileToBase64(file);
        const ext = file.name.split('.').pop() || file.type.split('/')[1] || 'bin';
        const saveRes = await ipc.file?.saveTempBlob?.({ base64, ext, filename: file.name });
        if (!saveRes?.success || !saveRes?.filePath) {
          console.error('[Library] saveTempBlob failed for', file.name);
          continue;
        }
        const filePath = saveRes.filePath;

        if (file.type.startsWith('image/')) {
          imagePaths.push(filePath);
        } else if (file.type.startsWith('video/')) {
          videoPromises.push((async () => {
            const metaRes: any = await ipc.file?.getVideoMeta?.({ filePath }) || {};
            await channelIpc.sendVideo('zalo', {
              auth: auth || {},
              accountId: zaloId, threadId, threadType, filePath,
              thumbPath: metaRes.thumbPath || '',
              duration: metaRes.duration || 0,
              width: metaRes.width || 0,
              height: metaRes.height || 0,
            });
          })());
        } else {
          filePromises.push(ipc.zalo.sendFile({ auth: auth || {}, zaloId, threadId, threadType, filePath }));
        }
      }

      // Phase 2: send images in batch
      if (imagePaths.length > 0) {
        if (imagePaths.length === 1) {
          await ipc.zalo.sendImage({ auth: auth || {}, zaloId, threadId, threadType, filePath: imagePaths[0] });
        } else {
          await ipc.zalo.sendImages({ auth: auth || {}, zaloId, threadId, type: threadType, filePaths: imagePaths });
        }
      }

      // Phase 3: send videos and files concurrently (each is independent)
      await Promise.all([...videoPromises, ...filePromises]);
    } catch {}
    setUploading(false);
    if (directInputRef.current) directInputRef.current.value = '';
    onClose();
  };

  const selectedItems = items.filter(i => selected.has(i.uuid));
  const typeLabel = TYPE_LABELS[initialType] || '📁 Media';

  // ── Build folder tree ───────────────────────────────────────

  // Hiển thị tất cả folder, item_count cho biết số lượng item theo type hiện tại
  // Folder trống (0 item) hiển thị ở mọi type, khi có item thì tự lọc theo type
  const rootFolders = folders.filter(f => !f.parent_id);
  const childFolders = (parentId: number) => folders.filter(f => f.parent_id === parentId);

  const renderFolderItem = (folder: LibraryFolder, depth = 0) => {
    const isRenaming = folderInput?.mode === 'rename' && folderInput.id === folder.id;
    return (
    <div key={folder.id}>
      {isRenaming ? (
        <div className="px-2 py-1" style={{ paddingLeft: `${12 + depth * 16}px` }}>
          <input autoFocus
            value={folderInput.value}
            onChange={e => setFolderInput({ ...folderInput, value: e.target.value })}
            onKeyDown={e => { if (e.key === 'Enter') submitFolderInput(); if (e.key === 'Escape') setFolderInput(null); }}
            onBlur={() => setTimeout(() => submitFolderInput(), 200)}
            className="w-full px-2 py-1 text-xs bg-gray-700 border border-blue-500 rounded-lg text-gray-200 outline-none"
          />
        </div>
      ) : (
      <div
        onContextMenu={(e) => { e.preventDefault(); setShowFolderMenu(showFolderMenu === folder.id ? null : folder.id); }}
        className={`flex items-center gap-1 px-3 py-1.5 rounded-lg cursor-pointer text-sm transition-all group relative ${
          activeFolderId === folder.id
            ? 'bg-blue-600/30 text-blue-300'
            : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'
        }`}
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        <span onClick={() => setActiveFolderId(activeFolderId === folder.id ? undefined as any : folder.id)} className="flex items-center gap-2 flex-1 min-w-0">
          <span><FolderIcon className="w-4 h-4" /></span>
          <span className="truncate">{folder.name}</span>
          <span className="text-[10px] mb-2">{folder.item_count || 0}</span>
        </span>

        {/* ⋯ menu button */}
        <div className="relative">
          <button onClick={(e) => { e.stopPropagation(); setShowFolderMenu(showFolderMenu === folder.id ? null : folder.id); }}
            className="p-1 rounded-md text-gray-400 hover:text-gray-200 opacity-0 group-hover:opacity-100 transition-all text-sm">⋯</button>

          {showFolderMenu === folder.id && (
            <div className="absolute right-0 top-full mt-1 bg-gray-700 border border-gray-600 rounded-xl shadow-2xl z-50 py-1 w-40"
              onClick={e => e.stopPropagation()}>
              <button onClick={() => handleAddChildFolder(folder.id)}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-600 flex items-center gap-2"><FolderIcon className="w-4 h-4 inline" /> Thêm thư mục con</button>
              <button onClick={() => { handleRenameFolder(folder.id); }}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-600 flex items-center gap-2"><EditIcon className="w-3.5 h-3.5" /> Đổi tên</button>
              <button onClick={() => handleDeleteFolder(folder.id)}
                className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-gray-600 flex items-center gap-2"><TrashIcon className="w-4 h-4 inline" /> Xoá</button>
            </div>
          )}
        </div>
      </div>
      )}
      {childFolders(folder.id).map(child => renderFolderItem(child, depth + 1))}
    </div>
    );
  };

  /** Render item in folder picker dropdown (flat tree) */
  const renderFolderPickerItem = (folder: LibraryFolder, itemUuid: string, depth = 0): React.ReactNode => {
    const children = childFolders(folder.id);
    return (
      <React.Fragment key={folder.id}>
        <button onClick={() => handleMoveToFolder(itemUuid, folder.id)}
          className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex items-center gap-2 truncate"
          style={{ paddingLeft: `${12 + depth * 16}px` }}>
          <span><FolderIcon className="w-4 h-4" /></span>
          <span className="truncate">{folder.name}</span>
          {folder.item_count ? <span className="ml-auto text-[10px] text-gray-400">{folder.item_count}</span> : null}
        </button>
        {children.map(child => renderFolderPickerItem(child, itemUuid, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-5xl h-[85vh] bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700/50">
          <h2 className="text-lg font-semibold text-white">{typeLabel}</h2>
          <span className="text-xs text-gray-400">{total} file</span>
          <button onClick={() => { refreshLibraryCache(); loadItems(1); loadFolders(); }} className="p-1.5 text-gray-400 hover:text-white transition-colors" title="Làm mới"><RefreshIcon className="w-4 h-4" /></button>
          <button onClick={onClose} className="p-1.5 text-gray-400 hover:text-white transition-colors ml-auto">✕</button>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* ─── Left sidebar: folders (30%) ─── */}
          <div className="w-1/4 border-r border-gray-700/50 flex flex-col">
            <div className="flex items-center justify-between px-4 py-2 border-b border-gray-700/50">
              <span className="text-xs font-medium text-gray-400 uppercase tracking-wide">Thư mục</span>
              <button onClick={() => handleCreateFolder()}
                className="w-7 h-7 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-lg font-bold flex items-center justify-center transition-colors shadow-md"
                title="Tạo thư mục mới"
              >＋</button>
            </div>
            <div className="flex-1 overflow-y-auto py-2 px-2 space-y-0.5">
              <div onClick={() => setActiveFolderId(undefined as any)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer text-sm transition-all ${
                  activeFolderId === undefined ? 'bg-blue-600/30 text-blue-300' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'
                }`}>
                <span>📂</span>
                <span className="flex-1">Tất cả</span>
              </div>
              <div onClick={() => setActiveFolderId(-1)}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg cursor-pointer text-sm transition-all ${
                  activeFolderId === -1 ? 'bg-blue-600/30 text-blue-300' : 'text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'
                }`}>
                <StarIcon className="w-4 h-4 text-yellow-400" />
                <span className="flex-1">Yêu thích</span>
              </div>
              <div className="h-px bg-gray-700/50 my-2" />
              {folderInput?.mode === 'create' && (
                <div className="px-2 py-1">
                  <input autoFocus
                    value={folderInput.value}
                    onChange={e => setFolderInput({ ...folderInput, value: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Enter') submitFolderInput(); if (e.key === 'Escape') setFolderInput(null); }}
                    onBlur={() => setTimeout(() => submitFolderInput(), 200)}
                    placeholder="Tên thư mục..."
                    className="w-full px-2 py-1 text-xs bg-gray-700 border border-gray-500 rounded-lg text-gray-200 placeholder-gray-500 outline-none"
                  />
                </div>
              )}
              {rootFolders.map(f => renderFolderItem(f))}
              {rootFolders.length === 0 && !folderInput && (
                <p className="text-xs text-gray-400 text-center py-4">Chưa có thư mục</p>
              )}
            </div>
          </div>

          {/* ─── Right content (70%) ─── */}
          <div className="w-3/4 flex flex-col">
            <div className="px-4 py-2 border-b border-gray-700/50">
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Tìm trong thư viện..."
                className="w-full px-3 py-1.5 bg-gray-700 border border-gray-600 rounded-lg text-sm text-gray-200 placeholder-gray-500"
              />
            </div>

            {/* Grid (có drag & drop upload) */}
            <div ref={gridRef} onScroll={handleScroll}
              onDragOver={handleDragOver}
              onDragEnter={handleDragEnter}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`flex-1 overflow-y-auto p-4 transition-all ${isDragOver ? 'bg-blue-900/20 border-2 border-dashed border-blue-500/50 rounded-lg' : ''}`}>
              {items.length === 0 && !loading && (
                <div className="flex flex-col items-center justify-center h-full text-gray-400">
                  <span className="text-4xl mb-2">📂</span>
                  <p className="text-sm">Thư viện trống</p>
                  <p className="text-xs mt-1">Nhấn "Upload vào thư viện" để thêm file</p>
                </div>
              )}

              {/* Images */}
              {(initialType === 'image' || initialType === 'all') && (
                <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-5 gap-3 mb-4">
                  {items.filter(i => i.type === 'image').map(item => (
                    <div key={item.uuid} className="relative group">
                      {/*** Thumbnail (overflow-hidden removed — dropdowns render here without being clipped) ***/}
                      <div onClick={() => toggleSelect(item.uuid)}
                        className={`relative aspect-square rounded-xl cursor-pointer border-2 transition-all ${
                          selected.has(item.uuid) ? 'border-blue-500 ring-2 ring-blue-500/40' : 'border-transparent hover:border-gray-500'
                        }`}>
                        {/*** Chỉ clip riêng ảnh, không clip dropdown ***/}
                        <div className="absolute inset-0 overflow-hidden rounded-xl pointer-events-none">
                          <ImagePreview item={item} />
                        </div>

                        {/*** Star favorite (top-left) ***/}
                        <div className={`absolute top-1 left-1 z-10 ${!item.is_favorite ? 'opacity-0 group-hover:opacity-100' : ''} transition-opacity`}>
                          <div className="bg-white backdrop-blur-sm rounded-lg p-1 shadow-lg">
                            <button onClick={(e) => { e.stopPropagation(); handleToggleFavorite(item.uuid, item.is_favorite); }}
                              className="text-[11px] leading-none block" title={item.is_favorite ? 'Bỏ yêu thích' : 'Yêu thích'}>
                              {item.is_favorite ? <StarIcon className="w-4 h-4 text-yellow-400" /> : <StarIcon className="w-4 h-4 text-gray-400" />}
                            </button>
                          </div>
                        </div>

                        {/*** ⋮ button (top-right, hover) — menu ở modal level fixed ***/}
                        <div className="absolute top-1 right-1 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={(e) => handleMenuClick(e, item.uuid)}
                            className="bg-white backdrop-blur-sm rounded-lg p-2 shadow-lg text-gray-200 hover:text-white text-sm leading-none">⋮</button>
                        </div>

                        {selected.has(item.uuid) && (
                          <>
                            <div className="absolute bottom-1 right-1 w-6 h-6 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs shadow-lg">✓</div>
                            <div className="absolute inset-0 bg-blue-500/20 rounded-xl" />
                          </>
                        )}
                      </div>
                      {/*** File name (rename inline khi editing) ***/}
                      <div className="mt-0.5 px-0.5">
                        {editingName === item.uuid ? (
                          <div className="flex items-center gap-1">
                            <input ref={editInputRef} value={editingValue}
                              onChange={e => setEditingValue(e.target.value)}
                              onBlur={() => submitRename(item.uuid)}
                              onKeyDown={e => { if (e.key === 'Enter') submitRename(item.uuid); if (e.key === 'Escape') setEditingName(null); }}
                              className="flex-1 text-[10px] bg-gray-700 border border-gray-500 rounded px-1 py-0.5 text-gray-200 outline-none"
                            />
                            <button onClick={() => submitRename(item.uuid)}
                              className="text-green-400 hover:text-green-300 text-xs">✓</button>
                          </div>
                        ) : (
                          <span className="block text-[10px] text-gray-400 truncate">{item.name}</span>
                        )}
                      </div>

                    </div>
                  ))}
                </div>
              )}

              {/* Videos */}
              {(initialType === 'video' || initialType === 'all') && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-4">
                  {items.filter(i => i.type === 'video').map(item => (
                    <div key={item.uuid} className="relative group">
                      {/*** Thumbnail (overflow-hidden removed for dropdown) ***/}
                      <div onClick={() => toggleSelect(item.uuid)}
                        className={`relative aspect-video rounded-xl cursor-pointer border-2 transition-all ${
                          selected.has(item.uuid) ? 'border-blue-500' : 'border-transparent hover:border-gray-500'
                        }`}>
                        {/*** Clip riêng video icon ***/}
                        <div className="absolute inset-0 overflow-hidden rounded-xl pointer-events-none">
                          <div className="w-full h-full bg-gray-700 flex items-center justify-center text-3xl">🎬</div>
                        </div>

                        {/*** Star favorite (top-left) ***/}
                        <div className={`absolute top-1 left-1 z-10 ${!item.is_favorite ? 'opacity-0 group-hover:opacity-100' : ''} transition-opacity`}>
                          <div className="bg-black/50 backdrop-blur-sm rounded-lg p-1 shadow-lg">
                            <button onClick={(e) => { e.stopPropagation(); handleToggleFavorite(item.uuid, item.is_favorite); }}
                              className="text-[11px] leading-none block" title={item.is_favorite ? 'Bỏ yêu thích' : 'Yêu thích'}>
                              {item.is_favorite ? <StarIcon className="w-4 h-4 text-yellow-400" /> : <StarIcon className="w-4 h-4 text-gray-400" />}
                            </button>
                          </div>
                        </div>

                        {/*** ⋮ button ***/}
                        <div className="absolute top-1 right-1 z-20 opacity-0 group-hover:opacity-100 transition-opacity">
                          <button onClick={(e) => handleMenuClick(e, item.uuid)}
                            className="bg-black/50 backdrop-blur-sm rounded-lg p-1 shadow-lg text-gray-200 hover:text-white text-sm leading-none">⋮</button>
                        </div>

                        <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 p-1.5 pointer-events-none">
                          {editingName === item.uuid ? (
                            <div className="flex items-center gap-1 w-full pointer-events-auto">
                              <input ref={editInputRef} value={editingValue}
                                onChange={e => setEditingValue(e.target.value)}
                                onBlur={() => submitRename(item.uuid)}
                                onKeyDown={e => { if (e.key === 'Enter') submitRename(item.uuid); if (e.key === 'Escape') setEditingName(null); }}
                                className="flex-1 text-xs bg-gray-900/80 border border-gray-500 rounded px-1 py-0.5 text-gray-200 outline-none"
                              />
                              <button onClick={() => submitRename(item.uuid)}
                                className="text-green-400 hover:text-green-300 text-xs">✓</button>
                            </div>
                          ) : (
                            <span className="block text-xs text-white truncate">{item.name}</span>
                          )}
                        </div>

                        {selected.has(item.uuid) && (
                          <><div className="absolute bottom-1 right-1 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center text-white text-xs shadow-lg">✓</div>
                          <div className="absolute inset-0 bg-blue-500/20 rounded-xl" /></>
                        )}
                      </div>

                    </div>
                  ))}
                </div>
              )}

              {/* Files */}
              {(initialType === 'file' || initialType === 'all') && (
                <div className="space-y-2">
                  {items.filter(i => i.type === 'file').map(item => (
                    <div key={item.uuid} onClick={() => toggleSelect(item.uuid)}
                      className={`flex items-center gap-3 px-4 py-3 rounded-xl cursor-pointer border transition-all group ${
                        selected.has(item.uuid) ? 'border-blue-500 bg-blue-500/10' : 'border-gray-700/50 hover:border-gray-500 bg-gray-800/50'
                      }`}>
                      <span className="text-2xl">{getFileIcon(item.name)}</span>
                      <div className="flex-1 min-w-0">
                        {editingName === item.uuid ? (
                          <div className="flex items-center gap-1">
                            <input ref={editInputRef} value={editingValue}
                              onChange={e => setEditingValue(e.target.value)}
                              onBlur={() => submitRename(item.uuid)}
                              onKeyDown={e => { if (e.key === 'Enter') submitRename(item.uuid); if (e.key === 'Escape') setEditingName(null); }}
                              className="flex-1 text-sm bg-gray-700 border border-gray-500 rounded px-2 py-1 text-gray-200 outline-none"
                              onClick={e => e.stopPropagation()}
                            />
                            <button onClick={(e) => { e.stopPropagation(); submitRename(item.uuid); }}
                              className="text-green-400 hover:text-green-300 text-sm px-1">✓</button>
                          </div>
                        ) : (
                          <>
                            <p className="text-sm text-gray-200 truncate">{item.name}</p>
                            <p className="text-xs text-gray-400">{(item.size / 1024).toFixed(1)} KB</p>
                          </>
                        )}
                      </div>
                      {/*** ⋮ Menu button ***/}
                      <div className="relative opacity-0 group-hover:opacity-100 transition-opacity">
                        <button onClick={(e) => handleMenuClick(e, item.uuid)}
                          className="bg-black/40 hover:bg-black/60 rounded-lg px-1.5 py-1 text-sm text-gray-300 hover:text-white">⋮</button>
                      </div>
                      {selected.has(item.uuid) && <span className="text-blue-400 ml-1">✓</span>}
                    </div>
                  ))}
                </div>
              )}

              {loading && <div className="flex justify-center py-4"><span className="text-gray-400 animate-pulse">⏳ Đang tải...</span></div>}
              {hasMore && !loading && (
                <button onClick={handleLoadMore} className="w-full py-3 text-sm text-gray-400 hover:text-white transition-colors">Tải thêm...</button>
              )}
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-gray-700/50">
          <input ref={fileInputRef} type="file" multiple accept={getAcceptType(initialType)} onChange={handleUploadAndSend} className="hidden" />
          <input ref={directInputRef} type="file" multiple accept={getAcceptType(initialType)} onChange={handleDirectFile} className="hidden" />
          <button onClick={() => fileInputRef.current?.click()} disabled={uploading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-indigo-700/80 hover:bg-indigo-600 text-white-important text-xs rounded-lg transition-colors disabled:opacity-50"><SendIcon className="w-4 h-4 inline" /> {uploading ? 'Đang tải...' : 'Upload vào thư viện'}
          </button>
          <button onClick={() => directInputRef.current?.click()}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs rounded-lg transition-colors"><MonitorIcon className="w-4 h-4 inline" /> Chọn từ Máy tính
          </button>
          <div className="flex-1" />
          <span className="text-xs text-gray-400">{selectedItems.length} file</span>
          <button onClick={handleSendSelected} disabled={selectedItems.length === 0}
            className={`px-5 py-1.5 text-sm rounded-lg transition-colors ${
              selectedItems.length > 0
                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                : 'bg-gray-700 text-gray-400 cursor-not-allowed'
            }`}>
            Gửi {selectedItems.length ? `${selectedItems.length} file` : ''}
          </button>
        </div>
      </div>

      {/*** Dropdown menu — fixed positioning để không bị overflow clipping ***/}
      {(() => {
        const item = menuTarget ? items.find(i => i.uuid === menuTarget) : null;
        if (!item || !menuPos) return null;
        return (
          <>
            <div className="fixed inset-0 z-[99]" onClick={closeMenus} />
            <div className="fixed z-[100] bg-gray-800 border border-gray-600 rounded-xl shadow-2xl py-1 w-48"
              style={{ top: menuPos.top, left: menuPos.left }} onClick={e => e.stopPropagation()}>
              <button onClick={() => { handleToggleFavorite(item.uuid, item.is_favorite); closeMenus(); }}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex items-center gap-2">
                {item.is_favorite ? <><StarIcon className="w-3.5 h-3.5 inline" /> Bỏ yêu thích</> : '☆ Yêu thích'}
              </button>
              <button onClick={() => { setMoveFolderTarget(item.uuid); setFolderPos(menuPos); setMenuTarget(null); setMenuPos(null); }}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex items-center gap-2"><FolderIcon className="w-4 h-4 inline" /> Chuyển đến thư mục →
              </button>
              <button onClick={() => { startRename(item.uuid, item.name); closeMenus(); }}
                className="w-full text-left px-3 py-1.5 text-xs text-gray-200 hover:bg-gray-700 flex items-center gap-2">
                <EditIcon className="w-3.5 h-3.5 inline" /> Đổi tên
              </button>
              {item.folder_id !== null && (
                <>
                  <div className="h-px bg-gray-600 mx-2" />
                  <button onClick={() => handleMoveToFolder(item.uuid, null)}
                    className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 flex items-center gap-2"><TrashIcon className="w-4 h-4 inline" /> Bỏ khỏi thư mục
                  </button>
                </>
              )}
              <div className="h-px bg-gray-600 mx-2" />
              <button onClick={() => handleDeleteItem(item.uuid)}
                className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-gray-700 flex items-center gap-2">
                <CloseIcon className="w-4 h-4" /> Xoá
              </button>
            </div>
          </>
        );
      })()}

      {/*** Folder picker dropdown — fixed positioning ***/}
      {(() => {
        const item = moveFolderTarget ? items.find(i => i.uuid === moveFolderTarget) : null;
        if (!item || !folderPos) return null;
        return (
          <>
            <div className="fixed inset-0 z-[99]" onClick={closeMenus} />
            <div className="fixed z-[100] bg-gray-800 border border-gray-600 rounded-xl shadow-2xl py-1 min-w-[180px] max-h-[260px] overflow-y-auto"
              style={{ top: folderPos.top, left: folderPos.left }} onClick={e => e.stopPropagation()}>
              <div className="px-3 py-1.5 text-[10px] text-gray-400 uppercase tracking-wider">Chuyển đến</div>
              {rootFolders.length === 0 && (
                <p className="px-3 py-2 text-xs text-gray-400">Chưa có thư mục</p>
              )}
              {rootFolders.map(f => renderFolderPickerItem(f, item.uuid))}
              {item.folder_id !== null && (
                <><div className="h-px bg-gray-600 mx-2" />
                <button onClick={() => handleMoveToFolder(item.uuid, null)}
                  className="w-full text-left px-3 py-1.5 text-xs text-gray-400 hover:bg-gray-700 flex items-center gap-2">✕ Bỏ khỏi thư mục</button></>
              )}
            </div>
          </>
        );
      })()}
    </div>
  );
}

// ── ImagePreview component ─────────────────────────────────────

/** Hiển thị ảnh với fallback: _thumbLocalPath/_localPath (boss) → thumbUrl → fileUrl (employee) → placeholder */
function ImagePreview({ item }: { item: any }) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    // Boss: ưu tiên local path (file nằm trên máy Boss)
    if (item._thumbLocalPath) {
      url = toLocalMediaUrl(item._thumbLocalPath);
    } else if (item._localPath) {
      url = toLocalMediaUrl(item._localPath);
    }
    // Employee: dùng HTTP URL (không có local path)
    if (!url && item.thumbUrl) {
      url = item.thumbUrl;
    }
    if (!url && item.fileUrl && item.fileUrl.startsWith('http')) {
      url = item.fileUrl;
    }
    // Fallback
    if (!url && item.fileUrl) {
      url = item.fileUrl;
    }
    setSrc(url);
    setErr(false);
  }, [item.thumbUrl, item._localPath, item._thumbLocalPath, item.fileUrl]);

  if (!src || err) return <div className="w-full h-full bg-gray-700 flex items-center justify-center text-2xl"><ImageIcon className="w-4 h-4" /></div>;
  return (
    <img
      src={src}
      alt={item.name}
      className="w-full h-full object-cover"
      loading="lazy"
      onError={() => setErr(true)}
    />
  );
}

// ── Helpers ─────────────────────────────────────────────────

function getAcceptType(type: MediaType): string {
  if (type === "image") return "image/*";
  if (type === "video") return "video/*";
  if (type === "file") return ".pdf,.doc,.docx,.xls,.xlsx,.zip,.rar,.txt,.csv,.ppt,.pptx";
  return "*/*";
}

function getFileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  if (['pdf'].includes(ext)) return 'PDF';
  if (['doc', 'docx'].includes(ext)) return 'DOC';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'XLS';
  if (['zip', 'rar', '7z'].includes(ext)) return 'ZIP';
  if (['ppt', 'pptx'].includes(ext)) return 'PPT';
  if (['txt'].includes(ext)) return 'TXT';
  return 'FILE';
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
