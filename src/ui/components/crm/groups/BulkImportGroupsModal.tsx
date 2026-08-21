import React, { useState, useCallback, useRef } from 'react';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { useAccountStore } from '@/store/accountStore';
import { submitSharedGroup, scanGroupViaBackend, DEFAULT_CATEGORIES, type SharedGroupCategory } from '@/lib/backendService';

// ─── Icons ──────────────────────────────────────────────────────────────────

const SpinIcon = (
  <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
  </svg>
);

const CheckIcon = (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const UploadIcon = (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
    <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
  </svg>
);

const CloseIcon = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>
);

// ─── Category Mapping ────────────────────────────────────────────────────────

const CATEGORY_MAP: Record<string, number> = {
  // 3 nhóm mới
  'game sạch': 18, 'game bẩn': 18, 'game': 18,
  'crypto coin trade': 19, 'crypto': 19, 'coin': 19, 'trade': 19,
  'tạp hóa': 20,
  // Map vào category có sẵn
  'thời trang': 8, 'mẹ và bé': 11, 'bđs': 2, 'bất động sản': 2,
  'làm đẹp': 9, 'nước hoa': 9, 'gia dụng': 12, 'nội thất': 12,
  'đồ chơi': 99, 'maketing. mmo': 4, 'marketing': 4, 'mmo': 4,
  'ctv nhiệm vụ': 1, 'ctv': 1, 'nhiệm vụ': 1, 'chứng khoán': 1,
  'tmđt': 1, 'thương mại điện tử': 1, 'luật pháp lý': 99,
  'luật': 99, 'pháp lý': 99, 'cây cối': 99,
  'kinh doanh': 1, 'công nghệ': 4, 'giáo dục': 3, 'sức khỏe': 5,
  'du lịch': 6, 'ẩm thực': 7, 'thực phẩm chức năng': 10,
  'ô tô': 13, 'điện tử': 14, 'thể thao': 15, 'thú cưng': 16,
  'nhà hàng': 17, 'khách sạn': 17,
};

function resolveCategory(lineVuc: string): { categoryId: number; isNew: boolean } {
  if (!lineVuc || !lineVuc.trim()) return { categoryId: 99, isNew: false };
  const n = lineVuc.toLowerCase().trim().replace(/[.,;:!?]+$/, '').replace(/\s+/g, ' ');
  if (CATEGORY_MAP[n]) return { categoryId: CATEGORY_MAP[n], isNew: false };
  for (const [key, id] of Object.entries(CATEGORY_MAP)) {
    if (n.includes(key) || key.includes(n)) return { categoryId: id, isNew: false };
  }
  return { categoryId: 99, isNew: true };
}

// ─── CSV Parser ──────────────────────────────────────────────────────────────

function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current.trim()); current = ''; }
      else current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCSV(content: string): { headers: string[]; rows: Record<string, string>[] } {
  // Remove BOM (Byte Order Mark) if present - common in UTF-8 files from Google Sheets
  const cleanContent = content.replace(/^﻿/, '');
  const lines = cleanContent.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = parseCSVLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = values[idx] || ''; });
    rows.push(row);
  }
  return { headers, rows };
}

function extractGroupId(link: string): string {
  if (!link) return '';
  const match = link.match(/zalo\.me\/g\/([a-zA-Z0-9]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9]+$/.test(link.trim())) return link.trim();
  return '';
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Types ──────────────────────────────────────────────────────────────────

interface BulkImportGroupsModalProps {
  pageId: string;
  onClose: () => void;
  onImported: () => void;
}

type ImportStep = 'upload' | 'preview' | 'importing' | 'result';

interface GroupItem {
  link: string;
  groupId: string;
  csvName: string;
  lineVuc: string;
  // Resolved from Zalo API
  resolvedName?: string;
  avatar?: string;
  memberCount?: number;
  // Status
  status: 'pending' | 'success' | 'error' | 'skipped';
  error?: string;
  categoryId?: number;
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function BulkImportGroupsModal({ pageId, onClose, onImported }: BulkImportGroupsModalProps) {
  const [step, setStep] = useState<ImportStep>('upload');
  const [csvText, setCsvText] = useState('');
  const [groups, setGroups] = useState<GroupItem[]>([]);
  const [minMembers, setMinMembers] = useState(100);
  const [importing, setImporting] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, phase: '' });
  const [result, setResult] = useState({ success: 0, error: 0, skipped: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ── Handle file upload ───────────────────────────────────────────────────
  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setCsvText(text);
      parseAndPreview(text);
    };
    reader.readAsText(file);
  }, []);

  const parseAndPreview = useCallback((text: string) => {
    const { headers, rows } = parseCSV(text);
    // Find columns
    const findCol = (...names: string[]) =>
      headers.find(h => names.some(n => h.toLowerCase().includes(n.toLowerCase()))) || null;

    const colLink = findCol('link nhóm zalo', 'link nhóm', 'link');
    const colTen = findCol('tên nhóm zalo', 'tên nhóm', 'tên');
    const colLinhVuc = findCol('lĩnh vực', 'linh vuc');

    if (!colLink) {
      alert('Không tìm thấy cột "Link Nhóm Zalo" trong CSV');
      return;
    }

    const parsed: GroupItem[] = rows.map(row => {
      const link = row[colLink] || '';
      const groupId = extractGroupId(link);
      return {
        link,
        groupId,
        csvName: colTen ? row[colTen] || '' : '',
        lineVuc: colLinhVuc ? row[colLinhVuc] || '' : '',
        status: (groupId ? 'pending' : 'skipped') as 'pending' | 'skipped',
        error: groupId ? undefined : 'Link không hợp lệ',
      };
    }).filter(g => g.groupId); // Only keep valid groups

    setGroups(parsed);
    setStep('preview');
  }, []);

  // ── Start import ─────────────────────────────────────────────────────────
  const handleStartImport = useCallback(async () => {
    const acc = useAccountStore.getState().getActiveAccount();
    if (!acc) {
      alert('Không tìm thấy tài khoản Zalo đang đăng nhập');
      return;
    }

    setStep('importing');
    setImporting(true);
    const auth = buildZaloAuth(acc, pageId);

    let successCount = 0;
    let errorCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      setProgress({ current: i + 1, total: groups.length, phase: `Đang tra cứu: ${group.csvName || group.groupId}` });

      // Flow: Join nhóm → Scan backend → Lấy số TV → Submit
      try {
        const linkUrl = group.link.startsWith('http') ? group.link : `https://zalo.me/g/${group.groupId}`;

        // Step 1: Join nhóm (để có quyền truy cập)
        setProgress({ current: i + 1, total: groups.length, phase: `Đang tham gia: ${group.csvName || group.groupId}` });
        let joinedGroupId = '';

        try {
          const joinRes: any = await ipc.zalo?.joinGroupLink({ auth, link: linkUrl });
          if (joinRes?.success && joinRes?.response) {
            joinedGroupId = joinRes.response.groupId || '';
            group.resolvedName = joinRes.response.name || group.csvName;
            group.avatar = joinRes.response.fullAvt || joinRes.response.avt || '';
          }
        } catch (joinErr: any) {
          // Có thể đã là thành viên hoặc nhóm không tồn tại → tiếp tục
          console.log(`[BulkImport] Join error for ${group.groupId}:`, joinErr.message);
        }

        // Step 2: Scan backend để lấy số thành viên
        setProgress({ current: i + 1, total: groups.length, phase: `Đang quét: ${group.csvName || group.groupId}` });

        // Backend cần numeric groupId, thử dùng joinedGroupId hoặc gọi getGroupLinkInfo 1 lần
        let numericGroupId = joinedGroupId;

        if (!numericGroupId || !/^\d+$/.test(numericGroupId)) {
          // Gọi getGroupLinkInfo để lấy numeric ID (chậm hơn để tránh rate limit)
          try {
            const linkInfoRes: any = await ipc.zalo?.getGroupLinkInfo({ auth, link: linkUrl, memberPage: 1 });
            if (linkInfoRes?.success && linkInfoRes?.response) {
              numericGroupId = linkInfoRes.response.groupId || '';
              if (!group.resolvedName) group.resolvedName = linkInfoRes.response.name || group.csvName;
              if (!group.avatar) group.avatar = linkInfoRes.response.fullAvt || linkInfoRes.response.avt || '';
            }
          } catch (linkErr: any) {
            console.log(`[BulkImport] getGroupLinkInfo error for ${group.groupId}:`, linkErr.message);
          }
        }

        // Scan backend nếu có numeric ID
        let memberCount = 0;
        if (numericGroupId && /^\d+$/.test(numericGroupId)) {
          try {
            const scanRes = await scanGroupViaBackend({
              pageId,
              cookie: acc.cookies,
              imei: acc.imei,
              groupId: numericGroupId,
            });

            if (scanRes?.success) {
              memberCount = scanRes.totalMembers || scanRes.members?.length || 0;
            }
          } catch (scanErr: any) {
            console.log(`[BulkImport] scanGroupViaBackend error for ${numericGroupId}:`, scanErr.message);
          }
        }

        const resolvedName = group.resolvedName || group.csvName;
        const avatar = group.avatar || '';
        const { categoryId } = resolveCategory(group.lineVuc);
        const finalGroupId = numericGroupId || group.groupId;

        // Update group info
        group.resolvedName = resolvedName;
        group.avatar = avatar;
        group.memberCount = memberCount;
        group.categoryId = categoryId;

        // Filter by min members
        if (memberCount < minMembers) {
          group.status = 'skipped';
          group.error = memberCount > 0 ? `Chỉ có ${memberCount} thành viên (< ${minMembers})` : 'Không lấy được số thành viên';
          skippedCount++;
        } else {
          // Submit to backend
          try {
            if (!/^\d+$/.test(finalGroupId)) {
              group.status = 'error';
              group.error = `group_id "${finalGroupId}" không hợp lệ (phải là số)`;
              errorCount++;
            } else {
              const submitRes = await submitSharedGroup({
                pageId,
                groupId: finalGroupId,
                groupName: resolvedName,
                groupAvatar: avatar,
                groupLink: linkUrl,
                memberCount,
                categoryId,
                note: `[Bulk import] Lĩnh vực: ${group.lineVuc || 'N/A'}`,
              });

              if (submitRes.success) {
                group.status = 'success';
                successCount++;
              } else {
                group.status = 'error';
                group.error = submitRes.message || 'Lỗi submit';
                errorCount++;
              }
            }
          } catch (err: any) {
            group.status = 'error';
            group.error = err.message;
            errorCount++;
          }
        }
      } catch (err: any) {
        group.status = 'error';
        group.error = err.message;
        errorCount++;
      }

      // Update state for re-render
      setGroups([...groups]);
      await sleep(30000); // Rate limit 30s giữa mỗi nhóm để tránh bị chặn
    }

    setResult({ success: successCount, error: errorCount, skipped: skippedCount });
    setImporting(false);
    setStep('result');
    if (successCount > 0) onImported();
  }, [groups, minMembers, pageId, onImported]);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-gray-800 border border-gray-600 rounded-2xl w-full max-w-[640px] max-h-[85vh] shadow-2xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-4 border-b border-gray-700 flex-shrink-0">
          <div className="w-10 h-10 rounded-xl bg-blue-500/15 border border-blue-500/30 flex items-center justify-center flex-shrink-0">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="font-semibold text-white text-sm">Nhập hàng loạt nhóm Zalo</h3>
            <p className="text-xs text-gray-400 mt-0.5">
              {step === 'upload' && 'Chọn file CSV chứa danh sách nhóm'}
              {step === 'preview' && `${groups.length} nhóm hợp lệ sẽ được xử lý`}
              {step === 'importing' && `Đang xử lý ${progress.current}/${progress.total}...`}
              {step === 'result' && 'Hoàn tất'}
            </p>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors p-1">
            {CloseIcon}
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5">

          {/* ── Step 1: Upload ─────────────────────────────────────────── */}
          {step === 'upload' && (
            <div className="space-y-4">
              <div
                onClick={() => fileInputRef.current?.click()}
                className="border-2 border-dashed border-gray-600 hover:border-blue-500 rounded-xl p-8 text-center cursor-pointer transition-colors"
              >
                <div className="text-gray-400 mb-3">{UploadIcon}</div>
                <p className="text-sm text-gray-300 font-medium">Chọn file CSV</p>
                <p className="text-xs text-gray-500 mt-1">hoặc kéo thả file vào đây</p>
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                onChange={handleFileUpload}
                className="hidden"
              />

              <div className="text-xs text-gray-500 space-y-1">
                <p className="font-medium text-gray-400">CSV cần có cột:</p>
                <p>• <span className="text-gray-300">Link Nhóm Zalo</span> (bắt buộc) — https://zalo.me/g/xxx</p>
                <p>• <span className="text-gray-300">Tên Nhóm Zalo</span> (tùy chọn)</p>
                <p>• <span className="text-gray-300">Lĩnh Vực</span> (tùy chọn) — để map category</p>
              </div>
            </div>
          )}

          {/* ── Step 2: Preview ────────────────────────────────────────── */}
          {step === 'preview' && (
            <div className="space-y-4">
              {/* Stats */}
              <div className="flex gap-3 text-xs">
                <div className="flex-1 bg-gray-700/50 rounded-lg p-3 text-center">
                  <p className="text-lg font-bold text-white">{groups.length}</p>
                  <p className="text-gray-400">Nhóm hợp lệ</p>
                </div>
                <div className="flex-1 bg-gray-700/50 rounded-lg p-3 text-center">
                  <p className="text-lg font-bold text-gray-500">{minMembers}</p>
                  <p className="text-gray-400">Tối thiểu TV</p>
                </div>
              </div>

              {/* Min members input */}
              <div className="flex items-center gap-2">
                <label className="text-xs text-gray-400 whitespace-nowrap">Tối thiểu thành viên:</label>
                <input
                  type="number"
                  value={minMembers}
                  onChange={e => setMinMembers(parseInt(e.target.value) || 0)}
                  className="w-20 bg-gray-700 border border-gray-600 rounded-lg px-2 py-1.5 text-xs text-white text-center focus:outline-none focus:border-blue-500"
                />
              </div>

              {/* Group list preview */}
              <div className="max-h-[300px] overflow-y-auto border border-gray-700 rounded-xl">
                {groups.slice(0, 20).map((g, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-2 border-b border-gray-700/50 last:border-0">
                    <span className="text-xs text-gray-500 w-6 text-right">{i + 1}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-white truncate">{g.csvName || g.groupId}</p>
                      <p className="text-[10px] text-gray-500 truncate">{g.link}</p>
                    </div>
                    {g.lineVuc && (
                      <span className="text-[10px] bg-gray-700 text-gray-400 px-1.5 py-0.5 rounded flex-shrink-0">
                        {g.lineVuc}
                      </span>
                    )}
                  </div>
                ))}
                {groups.length > 20 && (
                  <div className="px-3 py-2 text-center text-xs text-gray-500">
                    ... và {groups.length - 20} nhóm nữa
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Step 3: Importing ──────────────────────────────────────── */}
          {step === 'importing' && (
            <div className="space-y-4">
              {/* Progress bar */}
              <div className="w-full bg-gray-700 rounded-full h-2.5">
                <div
                  className="bg-blue-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${(progress.current / progress.total) * 100}%` }}
                />
              </div>

              <div className="text-center">
                <p className="text-sm text-white font-medium">
                  {progress.current}/{progress.total}
                </p>
                <p className="text-xs text-gray-400 mt-1">{progress.phase}</p>
              </div>

              {/* Live results */}
              <div className="max-h-[250px] overflow-y-auto space-y-1">
                {groups.filter(g => g.status !== 'pending').map((g, i) => (
                  <div key={i} className="flex items-center gap-2 px-3 py-1.5 text-xs">
                    {g.status === 'success' && <span className="text-green-400">✅</span>}
                    {g.status === 'error' && <span className="text-red-400">❌</span>}
                    {g.status === 'skipped' && <span className="text-yellow-400">⏭️</span>}
                    <span className="text-gray-300 truncate flex-1">
                      {g.resolvedName || g.csvName || g.groupId}
                    </span>
                    {g.memberCount !== undefined && (
                      <span className="text-gray-500">{g.memberCount.toLocaleString('vi-VN')} TV</span>
                    )}
                    {g.error && <span className="text-gray-500 text-[10px] truncate max-w-[150px]">{g.error}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Step 4: Result ─────────────────────────────────────────── */}
          {step === 'result' && (
            <div className="space-y-4">
              <div className="bg-green-500/10 border border-green-500/20 rounded-xl p-5 text-center space-y-3">
                <div className="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center mx-auto text-green-400">
                  {CheckIcon}
                </div>
                <div>
                  <p className="text-sm text-green-400 font-semibold">Hoàn tất!</p>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 text-center text-xs">
                <div className="bg-green-500/10 rounded-lg p-3">
                  <p className="text-lg font-bold text-green-400">{result.success}</p>
                  <p className="text-gray-400">Thành công</p>
                </div>
                <div className="bg-red-500/10 rounded-lg p-3">
                  <p className="text-lg font-bold text-red-400">{result.error}</p>
                  <p className="text-gray-400">Lỗi</p>
                </div>
                <div className="bg-yellow-500/10 rounded-lg p-3">
                  <p className="text-lg font-bold text-yellow-400">{result.skipped}</p>
                  <p className="text-gray-400">Bỏ qua</p>
                </div>
              </div>

              <p className="text-xs text-gray-400 text-center">
                Nhóm đã import sẽ có trạng thái "chờ duyệt" trên admin.
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2 px-6 py-4 border-t border-gray-700 flex-shrink-0">
          <button onClick={onClose}
            className="flex-1 py-2.5 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors">
            {step === 'result' ? 'Đóng' : 'Hủy'}
          </button>
          {step === 'preview' && (
            <button onClick={handleStartImport}
              className="flex-1 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold transition-colors flex items-center justify-center gap-2">
              🚀 Bắt đầu nhập ({groups.length} nhóm)
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
