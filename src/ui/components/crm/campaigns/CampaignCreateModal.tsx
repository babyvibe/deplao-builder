import React, { useState, useEffect, useRef } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { Spinner } from '@/components/common/PageLoading';
import { AlertIcon, ChartIcon, ChatIcon, ClipboardListIcon, EditIcon, RocketIcon, SendIcon, ShuffleIcon, UserCheckIcon, UsersIcon } from '@/components/common/icons';
import { parseMarkup } from '../../../../services/crm/message-markup';

// ── Types ─────────────────────────────────────────────────────────────────────

type CampaignType = 'message' | 'friend_request' | 'mixed' | 'invite_to_group';
type MixedAction  = 'message' | 'friend_request' | 'invite_to_groups';
type SendMode     = 'random' | 'all';

export interface MixedConfig   { actions: MixedAction[]; group_ids?: string[]; }
export interface ContentBlock  { id: string; text: string; images: string[]; tagAll?: boolean; tagAllText?: string; }
export interface ContentConfig { mode: SendMode; blocks: ContentBlock[]; }

interface CampaignFormData {
  name: string;
  template_message: string;
  friend_request_message: string;
  campaign_type: CampaignType;
  mixed_config: string;
  delay_seconds: number;
  delay_min_seconds?: number;
  delay_max_seconds?: number;
  per_contact_delay_min_seconds?: number;
  per_contact_delay_max_seconds?: number;
  daily_send_limit: number;
  daily_start_time: string;
}

interface CampaignCreateModalProps {
  initialData?: Partial<CampaignFormData>;
  editMode?: boolean;
  zaloId?: string;
  onClose: () => void;
  onSave: (data: CampaignFormData) => Promise<void>;
}

// Preview substitution - replaces variables with dummy values
function substitutePreview(text: string): string {
  return (text || '')
    .replace(/\{name\}/g, 'Nguyễn Văn A')
    .replace(/\{userId\}/g, '0987654321');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const genId = () => Math.random().toString(36).slice(2, 9);

function parseContentConfig(raw?: string): ContentConfig {
  if (!raw) return { mode: 'random', blocks: [{ id: genId(), text: '', images: [] }] };
  try {
    const p = JSON.parse(raw);
    if (p?.blocks && Array.isArray(p.blocks)) return p as ContentConfig;
  } catch {}
  return { mode: 'random', blocks: [{ id: genId(), text: raw, images: [] }] };
}

function parseMixedConfig(raw?: string): MixedConfig {
  if (!raw) return { actions: ['message', 'friend_request'] };
  try {
    const p = JSON.parse(raw);
    if (p && Array.isArray(p.actions)) return p as MixedConfig;
    if (p && Array.isArray(p.group_ids)) return { actions: [], group_ids: p.group_ids };
  } catch {}
  return { actions: ['message', 'friend_request'] };
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TEMPLATE_VARS = ['{name}', '{userId}'];

/** Format delay range for display */
function fmtDelayRange(min: number, max: number): string {
  const fmt = (s: number) => {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  };
  return `${fmt(min)}-${fmt(max)}`;
}

/** Preset delay ranges giữa các liên hệ */
const DELAY_PRESETS = [
  { label: '2-3m',   min: 120, max: 180 },
  { label: '3-5m',   min: 180, max: 300 },
  { label: '5-10m',  min: 300, max: 600 },
  { label: '10-15m', min: 600, max: 900 },
];

/** Preset delay ranges giữa các tin nhắn */
const PC_DELAY_PRESETS = [
  { label: 'Không',   min: 0,   max: 0   },
  { label: '5-15s',   min: 5,   max: 15  },
  { label: '15-30s',  min: 15,  max: 30  },
  { label: '30-60s',  min: 30,  max: 60  },
  { label: '1-2m',    min: 60,  max: 120 },
];

const TYPE_OPTIONS: { value: CampaignType; icon: React.ReactNode; label: string }[] = [
  { value: 'message',         icon: <ChatIcon className="w-4 h-4" />, label: 'Tin nhắn'   },
  { value: 'friend_request',  icon: <UserCheckIcon className="w-4 h-4" />, label: 'Kết bạn'    },
  { value: 'invite_to_group', icon: <UsersIcon className="w-4 h-4" />, label: 'Mời nhóm'   },
  { value: 'mixed',           icon: <ShuffleIcon className="w-4 h-4" />, label: 'Hỗn hợp'    },
];

const INVITE_ERROR_LABELS: Record<number, string> = {
  269: 'Chưa là bạn bè', 178: 'Đã là thành viên', 263: 'Đã gửi lời mời',
  262: 'Đã có lời mời',  177: 'Nhóm đầy',          166: 'Không có quyền',
  245: 'Người lạ',       122: 'Bị chặn',            247: 'Bị bỏ qua nhóm',
};

// ── Live Preview Component ─────────────────────────────────────────────────────

function LivePreview({
  blocks, activeIdx, mode, type, friendMsg,
  onTabChange,
}: {
  blocks: ContentBlock[];
  activeIdx: number;
  mode: SendMode;
  type: CampaignType;
  friendMsg: string;
  onTabChange: (i: number) => void;
}) {
  const block = blocks[activeIdx] ?? blocks[0];

  const previewText = type === 'friend_request'
    ? substitutePreview(friendMsg)
    : substitutePreview(block?.text ?? '');

  const hasImages = (block?.images?.length ?? 0) > 0;
  const isFR      = type === 'friend_request';

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider">Xem trước</span>
        {!isFR && blocks.length > 1 && (
          <span className="text-[10px] text-gray-400">
            {mode === 'random' ? '🎲 Random' : '📨 Tất cả'}
          </span>
        )}
      </div>

      {/* Block tabs (when multiple blocks) */}
      {!isFR && blocks.length > 1 && (
        <div className="flex gap-1 mb-2 flex-wrap flex-shrink-0">
          {blocks.map((b, i) => (
            <button key={b.id} onClick={() => onTabChange(i)}
              className={`px-2.5 py-1 rounded-lg text-[11px] font-medium transition-colors border ${
                i === activeIdx
                  ? 'bg-blue-600 text-white border-blue-500'
                  : 'border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-500'
              }`}>
              Nội dung {i + 1}
            </button>
          ))}
        </div>
      )}

      {/* Phone-style preview */}
      <div className="flex-1 min-h-0 flex flex-col border border-gray-600 rounded-xl overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-700 border-b border-gray-600 flex-shrink-0">
          <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">Z</div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-gray-200 truncate">Nguyễn Văn A</p>
            <p className="text-[9px] text-gray-400">Zalo</p>
          </div>
        </div>

        {/* Chat area */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-gray-800">
          {/* Timestamp */}
          <div className="flex justify-center">
            <span className="text-[9px] text-gray-400 bg-gray-700 px-2 py-0.5 rounded-full">Hôm nay 12:00</span>
          </div>

          {(previewText || hasImages) ? (
            <div className="flex justify-end">
              <div className="flex flex-col items-end gap-1.5 max-w-[85%]">
                {/* Text bubble */}
                {previewText && (
                  <div className="bg-blue-600 text-white rounded-2xl rounded-br-sm px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
                    {previewText}
                  </div>
                )}
                {/* Image thumbnails */}
                {hasImages && !isFR && (
                  <div className={`grid gap-1 rounded-xl overflow-hidden ${
                    block.images.length === 1 ? 'grid-cols-1'
                    : block.images.length <= 4 ? 'grid-cols-2'
                    : 'grid-cols-3'
                  }`} style={{ maxWidth: '11.25rem' }}>
                    {block.images.map((p, i) => (
                      <div key={i} className="aspect-square overflow-hidden rounded">
                        <img src={toLocalMediaUrl(p)} alt="" className="w-full h-full object-cover"
                          onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                      </div>
                    ))}
                  </div>
                )}
                {/* Status tick */}
                <span className="text-[9px] text-gray-400">✓✓ Đã gửi</span>
              </div>
            </div>
          ) : (
            <div className="flex justify-center py-4">
              <p className="text-[11px] text-gray-400 italic">
                {isFR ? 'Soạn lời nhắn kết bạn...' : 'Soạn nội dung tin nhắn...'}
              </p>
            </div>
          )}

          {/* Friend request chip */}
          {isFR && previewText && (
            <div className="flex justify-center">
              <div className="border border-blue-500/40 rounded-xl px-3 py-2 text-[11px] text-blue-400 text-center max-w-[90%]"><UserCheckIcon className="w-4 h-4 inline" /> Lời mời kết bạn gửi kèm nội dung trên
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Mode explanation */}
      {!isFR && blocks.length > 1 && (
        <div className="mt-2 px-2 text-[10px] text-gray-400 flex-shrink-0">
          {mode === 'random'
            ? `🎲 Mỗi người nhận ngẫu nhiên 1 trong ${blocks.length} nội dung`
            : `📨 Mỗi người nhận cả ${blocks.length} nội dung lần lượt`}
        </div>
      )}
    </div>
  );
}

// ── Group Picker ──────────────────────────────────────────────────────────────

function GroupPicker({
  zaloId, inviteGroupIds, onToggle,
}: {
  zaloId?: string;
  inviteGroupIds: string[];
  onToggle: (id: string) => void;
}) {
  const [groups, setGroups] = useState<{ contact_id: string; display_name: string; avatar_url?: string }[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (loaded || !zaloId) return;
    DataAccessor.getConversations(zaloId).then(res => {
      const contacts: any[] = (res as any)?.items || (res as any)?.contacts || [];
      setGroups(contacts.filter((c: any) => c.contact_type === 'group').map((c: any) => ({
        contact_id: c.contact_id,
        display_name: c.display_name || c.contact_id,
        avatar_url: c.avatar_url || '',
      })));
      setLoaded(true);
    });
  }, [zaloId, loaded]);

  const visible = groups.filter(g => !search.trim() || g.display_name.toLowerCase().includes(search.toLowerCase()));

  return (
    <div className="flex flex-col h-full min-h-0">
      <p className="text-[11px] text-yellow-500 bg-yellow-500/10 border border-yellow-500/20 rounded-lg px-2.5 py-1.5 mb-2 flex-shrink-0">
        <AlertIcon className="w-4 h-4 inline" /> Chỉ mời được bạn bè - Không mời được người lạ
      </p>
      {!zaloId ? (
        <p className="text-xs text-gray-400 py-4 text-center">Mở modal từ tab Chiến dịch để xem danh sách nhóm</p>
      ) : !loaded ? (
        <div className="flex items-center gap-2 text-xs text-gray-400 py-3">
          <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke="currentColor" strokeWidth="2.5"/></svg>
          Đang tải nhóm...
        </div>
      ) : (
        <>
          {/* Search + select all */}
          <div className="flex items-center gap-2 border border-gray-600 rounded-lg px-2.5 py-1.5 mb-2 flex-shrink-0">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-gray-400 flex-shrink-0">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Tìm nhóm..." className="flex-1 text-xs text-gray-200 bg-transparent focus:outline-none placeholder-gray-500" />
            {(() => {
              const allSel = visible.length > 0 && visible.every(g => inviteGroupIds.includes(g.contact_id));
              return visible.length > 1 ? (
                <button onClick={() => visible.forEach(g => {
                  if (allSel ? inviteGroupIds.includes(g.contact_id) : !inviteGroupIds.includes(g.contact_id))
                    onToggle(g.contact_id);
                })} className="text-[10px] text-blue-400 hover:text-blue-300 flex-shrink-0">
                  {allSel ? 'Bỏ tất cả' : 'Chọn tất cả'}
                </button>
              ) : null;
            })()}
          </div>

          {inviteGroupIds.length > 0 && (
            <p className="text-[11px] text-blue-400 mb-1.5 flex-shrink-0">✓ {inviteGroupIds.length} nhóm đã chọn</p>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto border border-gray-600 rounded-lg divide-y divide-gray-700/50">
            {visible.map(g => {
              const checked = inviteGroupIds.includes(g.contact_id);
              return (
                <label key={g.contact_id}
                  className={`flex items-center gap-2 px-2.5 py-2 cursor-pointer transition-colors ${checked ? 'bg-blue-500/10' : 'hover:bg-gray-700/40'}`}>
                  <div onClick={() => onToggle(g.contact_id)}
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                      checked ? 'bg-blue-500 border-blue-500' : 'border-gray-500 hover:border-blue-400'
                    }`}>
                    {checked && <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                  {g.avatar_url
                    ? <img src={g.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                    : <div className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">{(g.display_name||'?').charAt(0).toUpperCase()}</div>
                  }
                  <span className={`flex-1 text-xs truncate ${checked ? 'text-white font-medium' : 'text-gray-300'}`}>{g.display_name}</span>
                </label>
              );
            })}
            {visible.length === 0 && (
              <p className="text-xs text-gray-400 text-center py-4">{groups.length === 0 ? 'Chưa có nhóm nào. Đồng bộ nhóm trước.' : 'Không tìm thấy'}</p>
            )}
          </div>

          <details className="mt-2 flex-shrink-0">
            <summary className="text-[10px] text-gray-400 cursor-pointer hover:text-gray-400 select-none"><ClipboardListIcon className="w-4 h-4 inline" /> Mã lỗi thường gặp</summary>
            <div className="mt-1 flex flex-wrap gap-1">
              {Object.entries(INVITE_ERROR_LABELS).map(([c, l]) => (
                <span key={c} className="text-[9px] text-gray-400 bg-gray-700 px-1.5 py-0.5 rounded">{c}: {l}</span>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

// ── Markup Preview ────────────────────────────────────────────────────────────

// Render text có markup thành các <span> có style, khớp với cách zca-js hiển thị.
const STYLE_CSS: Record<string, React.CSSProperties> = {
  b: { fontWeight: 700 },
  i: { fontStyle: 'italic' },
  u: { textDecoration: 'underline' },
  s: { textDecoration: 'line-through' },
  c_db342e: { color: '#db342e' },
  c_f27806: { color: '#f27806' },
  c_f7b503: { color: '#f7b503' },
  c_15a85f: { color: '#15a85f' },
  f_18: { fontSize: '1.15em' },
  f_13: { fontSize: '0.85em' },
};

function MarkupPreview({ text }: { text: string }) {
  const { text: clean, styles } = parseMarkup(text);
  if (!styles.length) return <span className="text-gray-300">{clean}</span>;
  // Gộp style theo từng ký tự rồi cắt thành đoạn liên tiếp cùng style.
  const css: React.CSSProperties[] = Array.from({ length: clean.length }, () => ({}));
  for (const s of styles) {
    const props = STYLE_CSS[s.st] || {};
    for (let i = s.start; i < s.start + s.len && i < clean.length; i++) {
      Object.assign(css[i], props);
    }
  }
  const spans: React.ReactNode[] = [];
  let i = 0;
  while (i < clean.length) {
    let j = i + 1;
    const key = JSON.stringify(css[i]);
    while (j < clean.length && JSON.stringify(css[j]) === key) j++;
    spans.push(<span key={i} style={css[i]}>{clean.slice(i, j)}</span>);
    i = j;
  }
  return <span className="text-gray-300">{spans}</span>;
}

// ── Block Editor ──────────────────────────────────────────────────────────────

function BlockEditor({
  block, onUpdate,
}: {
  block: ContentBlock;
  onUpdate: (u: Partial<ContentBlock>) => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  const insertVar = (v: string) => {
    const ta = taRef.current;
    if (!ta) { onUpdate({ text: block.text + v }); return; }
    const s = ta.selectionStart ?? block.text.length;
    const e = ta.selectionEnd ?? block.text.length;
    onUpdate({ text: block.text.slice(0, s) + v + block.text.slice(e) });
    setTimeout(() => { ta.focus(); ta.setSelectionRange(s + v.length, s + v.length); }, 0);
  };

  // Bọc đoạn đang bôi đen bằng cặp thẻ markup ([b]…[/b], [red]…[/red]…).
  // Không bôi đen thì chèn cặp thẻ rỗng và đặt con trỏ vào giữa.
  const wrapSelection = (tag: string) => {
    const ta = taRef.current;
    const open = `[${tag}]`, close = `[/${tag}]`;
    if (!ta) { onUpdate({ text: `${block.text}${open}${close}` }); return; }
    const s = ta.selectionStart ?? block.text.length;
    const e = ta.selectionEnd ?? block.text.length;
    const sel = block.text.slice(s, e);
    onUpdate({ text: block.text.slice(0, s) + open + sel + close + block.text.slice(e) });
    const caret = s + open.length + sel.length;
    setTimeout(() => { ta.focus(); ta.setSelectionRange(caret, caret); }, 0);
  };

  const pickImages = async () => {
    const r = await ipc.file?.openDialog({
      filters: [{ name: 'Hình ảnh', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r?.filePaths?.length) onUpdate({ images: [...block.images, ...r.filePaths] });
  };

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      {/* Variable chips */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="text-[10px] text-gray-400">Chèn biến:</span>
        {TEMPLATE_VARS.map(v => (
          <button key={v} type="button" onClick={() => insertVar(v)}
            className="text-[11px] px-2 py-0.5 rounded-full border border-blue-500/30 text-blue-400 hover:bg-blue-500/15 font-mono transition-colors">
            {v}
          </button>
        ))}
      </div>

      {/* Toolbar định dạng */}
      <div className="flex items-center gap-1 flex-wrap flex-shrink-0">
        <button type="button" onClick={() => wrapSelection('b')} title="In đậm"
          className="text-[12px] font-bold w-6 h-6 rounded border border-gray-600 text-gray-300 hover:bg-gray-700 transition-colors">B</button>
        <button type="button" onClick={() => wrapSelection('i')} title="In nghiêng"
          className="text-[12px] italic w-6 h-6 rounded border border-gray-600 text-gray-300 hover:bg-gray-700 transition-colors">I</button>
        <button type="button" onClick={() => wrapSelection('u')} title="Gạch chân"
          className="text-[12px] underline w-6 h-6 rounded border border-gray-600 text-gray-300 hover:bg-gray-700 transition-colors">U</button>
        <button type="button" onClick={() => wrapSelection('s')} title="Gạch ngang"
          className="text-[12px] line-through w-6 h-6 rounded border border-gray-600 text-gray-300 hover:bg-gray-700 transition-colors">S</button>
        <span className="w-px h-4 bg-gray-600 mx-0.5" />
        {([['red','#db342e'],['orange','#f27806'],['yellow','#f7b503'],['green','#15a85f']] as const).map(([tag, hex]) => (
          <button key={tag} type="button" onClick={() => wrapSelection(tag)} title={`Màu ${tag}`}
            className="w-5 h-5 rounded-full border border-gray-500 hover:scale-110 transition-transform" style={{ background: hex }} />
        ))}
        <span className="w-px h-4 bg-gray-600 mx-0.5" />
        <button type="button" onClick={() => wrapSelection('big')} title="Cỡ lớn"
          className="text-[13px] font-semibold px-1.5 h-6 rounded border border-gray-600 text-gray-300 hover:bg-gray-700 transition-colors">A+</button>
        <button type="button" onClick={() => wrapSelection('small')} title="Cỡ nhỏ"
          className="text-[10px] px-1.5 h-6 rounded border border-gray-600 text-gray-300 hover:bg-gray-700 transition-colors">A-</button>
      </div>

      {/* Textarea - takes most space */}
      <textarea
        ref={taRef}
        value={block.text}
        onChange={e => onUpdate({ text: e.target.value })}
        placeholder={'Soạn nội dung tin nhắn...\nDùng {name} để chèn tên người nhận'}
        className="flex-1 min-h-0 w-full bg-gray-800 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none transition-colors"
      />

      {/* Xem trước định dạng */}
      {block.text.includes('[') && (
        <div className="flex-shrink-0 bg-gray-800/50 border border-gray-700 rounded-lg px-3 py-2">
          <div className="text-[10px] text-gray-500 mb-1">Xem trước</div>
          <div className="text-sm whitespace-pre-wrap break-words"><MarkupPreview text={block.text} /></div>
        </div>
      )}

      {/* Tag @all khi gửi nhóm */}
      <label className="flex items-center gap-2 flex-shrink-0 cursor-pointer text-xs text-gray-400 select-none flex-wrap">
        <input type="checkbox" checked={!!block.tagAll} onChange={e => onUpdate({ tagAll: e.target.checked })}
          className="accent-blue-500 w-3.5 h-3.5" />
        Tag toàn nhóm khi gửi vào nhóm
        {block.tagAll && (
          <span className="flex items-center gap-1" onClick={e => e.preventDefault()}>
            <span className="font-mono text-blue-400">@</span>
            <input type="text" value={block.tagAllText ?? 'all'}
              onChange={e => onUpdate({ tagAllText: e.target.value })}
              placeholder="all"
              className="w-28 bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 font-mono text-blue-400 text-xs focus:outline-none focus:border-blue-500" />
          </span>
        )}
        <span className="text-gray-500">(bỏ qua với chat cá nhân)</span>
      </label>

      {/* Images */}
      <div className="flex-shrink-0">
        {block.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {block.images.map((p, i) => (
              <div key={i} className="relative group/img w-14 h-14 rounded-lg overflow-hidden border border-gray-600 flex-shrink-0">
                <img src={toLocalMediaUrl(p)} alt="" className="w-full h-full object-cover"
                  onError={e => { (e.target as HTMLImageElement).style.opacity = '0.3'; }} />
                <button type="button"
                  onClick={() => onUpdate({ images: block.images.filter((_, j) => j !== i) })}
                  className="absolute inset-0 bg-black/60 opacity-0 group-hover/img:opacity-100 flex items-center justify-center text-red-400 transition-opacity">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
        <button type="button" onClick={pickImages}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs text-gray-400 hover:text-blue-400 border border-dashed border-gray-600 hover:border-blue-500/50 rounded-lg transition-colors">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          {block.images.length > 0 ? `${block.images.length} ảnh · thêm tiếp` : 'Đính kèm ảnh (tuỳ chọn)'}
        </button>
      </div>
    </div>
  );
}

// ── Main Modal ────────────────────────────────────────────────────────────────

export default function CampaignCreateModal({
  initialData, editMode = false, zaloId, onClose, onSave,
}: CampaignCreateModalProps) {
  const [name,          setName]         = useState(initialData?.name ?? '');
  const [type,          setType]         = useState<CampaignType>(initialData?.campaign_type ?? 'message');
  const [saving,        setSaving]       = useState(false);
  const [friendReqMsg,  setFriendReqMsg] = useState(initialData?.friend_request_message ?? '');
  const [activeBlock,   setActiveBlock]  = useState(0);
  const [dailyLimit,    setDailyLimit]   = useState(initialData?.daily_send_limit ?? 0);
  const [dailyStartTime, setDailyStartTime] = useState(initialData?.daily_start_time ?? '08:00');

  // ── Delay range (min/max thay thế fixed + jitter) ────────────────────────
  const getInitMinMax = (): [number, number] => {
    const d = initialData;
    if (!d) return [110, 130];
    const dm = (d as any).delay_min_seconds;
    const dx = (d as any).delay_max_seconds;
    if (dm != null && dx != null) return [dm, dx];
    const fallback = d.delay_seconds || 120;
    return [Math.max(30, fallback - 10), fallback + 10];
  };
  const initRange = getInitMinMax();
  const [delayMin, setDelayMin] = useState(initRange[0]);
  const [delayMax, setDelayMax] = useState(initRange[1]);
  const [customDelayMode, setCustomDelayMode] = useState(false);

  // ── Per-contact delay range (delay giữa các tin trong 1 liên hệ) ────────
  const getInitPc = (): [number, number] => {
    const d = initialData;
    if (!d) return [0, 0];
    return [
      (d as any).per_contact_delay_min_seconds ?? 0,
      (d as any).per_contact_delay_max_seconds ?? 0,
    ];
  };
  const initPcRange = getInitPc();
  const [pcDelayMin, setPcDelayMin] = useState(initPcRange[0]);
  const [pcDelayMax, setPcDelayMax] = useState(initPcRange[1]);
  const [customPcDelayMode, setCustomPcDelayMode] = useState(false);
  const friendReqRef = useRef<HTMLTextAreaElement>(null);

  const [contentConfig, setContentConfig] = useState<ContentConfig>(() =>
    parseContentConfig(initialData?.template_message)
  );

  const initMixed = parseMixedConfig(initialData?.mixed_config);
  const [mixedActions,   setMixedActions]   = useState<MixedAction[]>(initMixed.actions);
  const [inviteGroupIds, setInviteGroupIds] = useState<string[]>(initMixed.group_ids ?? []);

  const hasMsg    = type === 'message' || (type === 'mixed' && mixedActions.includes('message'));
  const hasFR     = type === 'friend_request' || (type === 'mixed' && mixedActions.includes('friend_request'));
  const hasInvite = type === 'invite_to_group' || (type === 'mixed' && mixedActions.includes('invite_to_groups'));

  // Clamp activeBlock when blocks change
  useEffect(() => {
    setActiveBlock(i => Math.min(i, contentConfig.blocks.length - 1));
  }, [contentConfig.blocks.length]);

  const addBlock = () => {
    setContentConfig(prev => {
      const next = { ...prev, blocks: [...prev.blocks, { id: genId(), text: '', images: [] }] };
      setActiveBlock(next.blocks.length - 1);
      return next;
    });
  };

  const removeBlock = (id: string) => {
    setContentConfig(prev => {
      const next = { ...prev, blocks: prev.blocks.filter(b => b.id !== id) };
      setActiveBlock(i => Math.min(i, Math.max(0, next.blocks.length - 1)));
      return next;
    });
  };

  const updateBlock = (id: string, u: Partial<ContentBlock>) =>
    setContentConfig(prev => ({ ...prev, blocks: prev.blocks.map(b => b.id === id ? { ...b, ...u } : b) }));

  const toggleMixedAction = (a: MixedAction) =>
    setMixedActions(prev => prev.includes(a) ? prev.filter(x => x !== a) : [...prev, a]);

  const toggleGroupId = (id: string) =>
    setInviteGroupIds(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id]);

  const buildMixedConfig = (): string => {
    if (type === 'invite_to_group') return JSON.stringify({ group_ids: inviteGroupIds });
    if (type !== 'mixed') return '{}';
    const cfg: MixedConfig = { actions: mixedActions };
    if (mixedActions.includes('invite_to_groups') && inviteGroupIds.length > 0) cfg.group_ids = inviteGroupIds;
    return JSON.stringify(cfg);
  };

  const isValid = (): boolean => {
    if (!name.trim()) return false;
    if (type === 'invite_to_group') return inviteGroupIds.length > 0;
    if (type === 'mixed') {
      if (!mixedActions.length) return false;
      if (mixedActions.includes('message') && !contentConfig.blocks.some(b => b.text.trim() || b.images.length)) return false;
      if (mixedActions.includes('friend_request') && !friendReqMsg.trim()) return false;
      if (mixedActions.includes('invite_to_groups') && !inviteGroupIds.length) return false;
    } else {
      if (hasMsg && !contentConfig.blocks.some(b => b.text.trim() || b.images.length)) return false;
      if (hasFR && !friendReqMsg.trim()) return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!isValid()) return;
    setSaving(true);
    const finalDelaySec = Math.round((delayMin + delayMax) / 2);
    await onSave({
      name: name.trim(),
      template_message: hasMsg ? JSON.stringify(contentConfig) : '',
      friend_request_message: friendReqMsg.trim(),
      campaign_type: type,
      mixed_config: buildMixedConfig(),
      delay_seconds: finalDelaySec,
      delay_min_seconds: delayMin,
      delay_max_seconds: delayMax,
      per_contact_delay_min_seconds: pcDelayMin,
      per_contact_delay_max_seconds: pcDelayMax,
      daily_send_limit: dailyLimit,
      daily_start_time: dailyStartTime,
    });
    setSaving(false);
    onClose();
  };

  const insertFRVar = (v: string) => {
    const ta = friendReqRef.current;
    if (!ta) { setFriendReqMsg(t => t + v); return; }
    const s = ta.selectionStart ?? friendReqMsg.length;
    const e = ta.selectionEnd ?? friendReqMsg.length;
    setFriendReqMsg(friendReqMsg.slice(0, s) + v + friendReqMsg.slice(e));
    setTimeout(() => { ta.focus(); ta.setSelectionRange(s + v.length, s + v.length); }, 0);
  };

  // Current block reference
  const currentBlock = contentConfig.blocks[activeBlock] ?? contentConfig.blocks[0];

  // Whether the campaign can send multiple items per contact (show per-contact delay section)
  const hasMultiSend = (hasMsg && contentConfig.mode === 'all' && contentConfig.blocks.length > 1)
    || (type === 'mixed' && mixedActions.length > 1)
    || (hasMsg && hasFR);

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-[1060px] shadow-2xl flex flex-col"
        style={{ height: 'min(92vh, 42.5rem)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Topbar ── */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-700 flex-shrink-0">
          <div>
            <h3 className="font-bold text-gray-100 text-[15px]">
              {editMode ? <><EditIcon className="w-4 h-4 inline" /> Chỉnh sửa chiến dịch</> : <><RocketIcon className="w-4 h-4 inline" /> Tạo chiến dịch mới</>}
            </h3>
            <p className="text-[11px] text-gray-400 mt-0.5">Cấu hình nội dung và phương thức gửi</p>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-100 hover:bg-gray-700 transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* ── 3-column body ── */}
        <div className="flex-1 min-h-0 flex overflow-hidden">

          {/* ── LEFT: Settings ── */}
          <div className="w-52 flex-shrink-0 border-r border-gray-700 flex flex-col overflow-y-auto p-4 gap-5">
            {/* Campaign name */}
            <div>
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1.5">Tên chiến dịch *</label>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder="Nhập tên..."
                className="w-full bg-gray-900 border border-gray-600 rounded-lg px-2.5 py-2 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors" />
            </div>

            {/* Type */}
            <div>
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1.5">Loại *</label>
              <div className="space-y-1">
                {TYPE_OPTIONS.map(opt => (
                  <button key={opt.value} type="button" onClick={() => setType(opt.value)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors ${
                      type === opt.value
                        ? 'border-blue-500 bg-blue-500/10 text-gray-100'
                        : 'border-transparent text-gray-400 hover:text-gray-200 hover:bg-gray-700/50'
                    }`}>
                    <span className={`text-base leading-none ${type === opt.value ? '' : 'grayscale opacity-60'}`}>{opt.icon}</span>
                    <span className="text-xs font-medium">{opt.label}</span>
                    {type === opt.value && (
                      <span className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400 flex-shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            </div>

            {/* Mixed actions */}
            {type === 'mixed' && (
              <div>
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1.5">Hành động</label>
                <div className="space-y-1">
                  {([
                    { action: 'message' as MixedAction,         icon: <ChatIcon className="w-4 h-4" />, label: 'Tin nhắn' },
                    { action: 'friend_request' as MixedAction,  icon: <UserCheckIcon className="w-4 h-4" />, label: 'Kết bạn' },
                    { action: 'invite_to_groups' as MixedAction, icon: <UsersIcon className="w-4 h-4" />, label: 'Mời nhóm' },
                  ]).map(({ action, icon, label }) => {
                    const checked = mixedActions.includes(action);
                    return (
                      <label key={action}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${checked ? 'bg-blue-500/10' : 'hover:bg-gray-700/40'}`}>
                        <div onClick={() => toggleMixedAction(action)}
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                            checked ? 'bg-blue-500 border-blue-500' : 'border-gray-500 hover:border-blue-400'
                          }`}>
                          {checked && <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                        </div>
                        <span className="text-base leading-none">{icon}</span>
                        <span className="text-xs text-gray-300">{label}</span>
                      </label>
                    );
                  })}
                  {!mixedActions.length && <p className="text-[10px] text-red-400 px-1">Chọn ít nhất 1 hành động</p>}
                </div>
              </div>
            )}

            {/* ⏱ Delay giữa các liên hệ */}
            <div>
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1.5">⏱ Delay giữa các liên hệ</label>
              <div className="grid grid-cols-2 gap-1">
                {DELAY_PRESETS.map(p => {
                  const active = !customDelayMode && delayMin === p.min && delayMax === p.max;
                  return (
                    <button key={p.label} type="button" onClick={() => { setDelayMin(p.min); setDelayMax(p.max); setCustomDelayMode(false); }}
                      className={`py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${
                        active ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                          : 'border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-300'
                      }`}>
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <button type="button" onClick={() => setCustomDelayMode(!customDelayMode)}
                className={`flex items-center gap-1 mt-1.5 text-[11px] px-2 py-1 rounded-lg border transition-colors w-full ${
                  customDelayMode ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                    : 'border-gray-600 text-gray-400 hover:text-gray-300 hover:border-gray-500'
                }`}>
                <span>{customDelayMode ? '▾' : '▸'}</span> Tùy chỉnh khoảng
              </button>
              {customDelayMode && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  <input type="number" min={5} value={delayMin || ''}
                    onChange={e => setDelayMin(Math.max(5, parseInt(e.target.value) || 0))}
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-2 py-1.5 text-[11px] text-gray-200 focus:outline-none focus:border-blue-500"
                    placeholder="Tối thiểu (s)" />
                  <span className="text-gray-400 text-xs">→</span>
                  <input type="number" min={delayMin} value={delayMax || ''}
                    onChange={e => setDelayMax(Math.max(delayMin || 5, parseInt(e.target.value) || 0))}
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-2 py-1.5 text-[11px] text-gray-200 focus:outline-none focus:border-blue-500"
                    placeholder="Tối đa (s)" />
                  <span className="text-gray-400 text-[10px] flex-shrink-0">giây</span>
                </div>
              )}
              <p className="text-[10px] text-gray-400 mt-1">
                ⏱ Ngẫu nhiên <span className="text-gray-400 font-medium">{fmtDelayRange(delayMin, delayMax)}</span> giữa các liên hệ
              </p>
            </div>

            {/* ⏱ Delay giữa các tin nhắn (chỉ khi gửi nhiều tin/liên hệ) */}
            {hasMultiSend && (
              <div>
                <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1.5">⏱ Delay giữa các tin nhắn</label>
                <div className="grid grid-cols-2 gap-1">
                  {PC_DELAY_PRESETS.map(p => {
                    const active = !customPcDelayMode && pcDelayMin === p.min && pcDelayMax === p.max;
                    return (
                      <button key={p.label} type="button" onClick={() => { setPcDelayMin(p.min); setPcDelayMax(p.max); setCustomPcDelayMode(false); }}
                        className={`py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${
                          active ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                            : 'border-gray-600 text-gray-400 hover:border-gray-500 hover:text-gray-300'
                        }`}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <button type="button" onClick={() => setCustomPcDelayMode(!customPcDelayMode)}
                  className={`flex items-center gap-1 mt-1.5 text-[11px] px-2 py-1 rounded-lg border transition-colors w-full ${
                    customPcDelayMode ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                      : 'border-gray-600 text-gray-400 hover:text-gray-300 hover:border-gray-500'
                  }`}>
                  <span>{customPcDelayMode ? '▾' : '▸'}</span> Tùy chỉnh
                </button>
                {customPcDelayMode && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <input type="number" min={0} value={pcDelayMin ?? ''}
                      onChange={e => setPcDelayMin(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-full bg-gray-900 border border-gray-600 rounded-lg px-2 py-1.5 text-[11px] text-gray-200 focus:outline-none focus:border-blue-500"
                      placeholder="Min (s)" />
                    <span className="text-gray-400 text-xs">→</span>
                    <input type="number" min={pcDelayMin} value={pcDelayMax ?? ''}
                      onChange={e => setPcDelayMax(Math.max(pcDelayMin || 0, parseInt(e.target.value) || 0))}
                      className="w-full bg-gray-900 border border-gray-600 rounded-lg px-2 py-1.5 text-[11px] text-gray-200 focus:outline-none focus:border-blue-500"
                      placeholder="Max (s)" />
                    <span className="text-gray-400 text-[10px] flex-shrink-0">giây</span>
                  </div>
                )}
                <p className="text-[10px] text-gray-400 mt-1">
                  {pcDelayMin > 0 || pcDelayMax > 0
                    ? `⏱ Ngẫu nhiên ${fmtDelayRange(pcDelayMin, pcDelayMax)} giữa các tin nhắn`
                    : '⏱ Gửi liên tiếp (mặc định ~1s)'}
                </p>
              </div>
            )}

            {/* Daily Send Limit */}
            <div>
              <label className="text-[10px] font-semibold text-gray-400 uppercase tracking-wider block mb-1.5"><ChartIcon className="w-4 h-4 inline" /> Giới hạn/ngày</label>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={10}
                    value={dailyLimit || ''}
                    onChange={e => setDailyLimit(Math.max(0, parseInt(e.target.value) || 0))}
                    placeholder="Không giới hạn"
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-2.5 py-2 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                  <span className="text-[10px] text-gray-400 flex-shrink-0">liên hệ</span>
                </div>
                <div>
                  <label className="text-[10px] text-gray-400 block mb-1">Giờ bắt đầu chạy</label>
                  <input
                    type="time"
                    value={dailyStartTime}
                    onChange={e => setDailyStartTime(e.target.value || '08:00')}
                    className="w-full bg-gray-900 border border-gray-600 rounded-lg px-2.5 py-2 text-xs text-gray-200 focus:outline-none focus:border-blue-500 transition-colors"
                  />
                  <p className="text-[10px] text-gray-400 mt-0.5">Nếu giờ này đã qua hôm nay, chiến dịch chạy ngay</p>
                </div>
              </div>
              <p className="text-[10px] text-gray-400 mt-1">
                {dailyLimit > 0
                  ? `Gửi tối đa ${dailyLimit}/ngày từ ${dailyStartTime}`
                  : 'Gửi không giới hạn (theo token bucket)'}
              </p>
            </div>

            {/* Warning */}
            <div className="border border-yellow-500/20 rounded-lg p-2.5 mt-auto">
              <p className="text-[10px] text-yellow-400 font-semibold mb-1"><AlertIcon className="w-3.5 h-3.5 inline" /> Cảnh báo</p>
              <p className="text-[9px] text-yellow-300/60 leading-relaxed">
                Hành động càng nhiều, nội dung càng dài, và delay càng ngắn sẽ làm tăng nguy cơ bị Zalo đánh spam. Hãy cân nhắc kỹ lưỡng khi cấu hình chiến dịch, và luôn tuân thủ nguyên tắc cộng đồng của Zalo.
              </p>
            </div>
          </div>

          {/* ── CENTER: Editor ── */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden border-r border-gray-700">
            {/* Center topbar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-700 flex-shrink-0 min-h-[44px]">
              {hasMsg && !hasInvite ? (
                <>
                  {/* Block tabs */}
                  <div className="flex items-center gap-1 overflow-x-auto">
                    {contentConfig.blocks.map((b, i) => (
                      <button key={b.id} type="button"
                        onClick={() => setActiveBlock(i)}
                        className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors flex-shrink-0 border ${
                          i === activeBlock
                            ? 'bg-blue-600 border-blue-500 text-white'
                            : 'border-gray-600 text-gray-400 hover:text-gray-200 hover:border-gray-500'
                        }`}>
                        <span className="w-4 h-4 rounded-full bg-current/20 flex items-center justify-center text-[9px] font-bold leading-none">
                          {i + 1}
                        </span>
                        Nội dung {i + 1}
                        {contentConfig.blocks.length > 1 && (
                          <span
                            onClick={e => { e.stopPropagation(); removeBlock(b.id); }}
                            className="ml-0.5 opacity-50 hover:opacity-100 cursor-pointer">×</span>
                        )}
                      </button>
                    ))}
                    <button type="button" onClick={addBlock}
                      title="Thêm biến thể nội dung"
                      className="flex-shrink-0 w-7 h-7 rounded-lg border border-dashed border-gray-600 text-gray-400 hover:text-blue-400 hover:border-blue-500/50 flex items-center justify-center transition-colors text-lg leading-none">
                      +
                    </button>
                  </div>
                  {/* Mode toggle (only when multiple blocks) */}
                  {contentConfig.blocks.length > 1 && (
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      {([
                        { value: 'random' as SendMode, icon: <ShuffleIcon className="w-4 h-4" />, label: 'Random' },
                        { value: 'all' as SendMode,    icon: <SendIcon className="w-4 h-4" />, label: 'Tất cả' },
                      ]).map(opt => (
                        <button key={opt.value} type="button"
                          onClick={() => setContentConfig(prev => ({ ...prev, mode: opt.value }))}
                          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors border ${
                            contentConfig.mode === opt.value
                              ? 'bg-blue-600 border-blue-500 text-white'
                              : 'border-gray-600 text-gray-400 hover:text-gray-200'
                          }`}>
                          <span>{opt.icon}</span> {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : hasFR && !hasMsg ? (
                <>
                  <span className="text-xs font-medium text-gray-300"><UserCheckIcon className="w-4 h-4 inline" /> Lời nhắn kết bạn</span>
                  <div className="flex gap-1">
                    {TEMPLATE_VARS.map(v => (
                      <button key={v} type="button" onClick={() => insertFRVar(v)}
                        className="text-[11px] px-2 py-0.5 rounded-full border border-blue-500/30 text-blue-400 hover:bg-blue-500/15 font-mono transition-colors">
                        {v}
                      </button>
                    ))}
                  </div>
                </>
              ) : hasInvite && !hasMsg ? (
                <span className="text-xs font-medium text-gray-300"><UsersIcon className="w-4 h-4 inline" /> Chọn nhóm để mời</span>
              ) : (
                <span className="text-xs text-gray-400">Editor</span>
              )}
            </div>

            {/* Center content area */}
            <div className="flex-1 min-h-0 p-4 overflow-y-auto flex flex-col gap-3">
              {/* Message block editor */}
              {hasMsg && currentBlock && (
                <div className="flex-1 min-h-0 flex flex-col">
                  <BlockEditor
                    block={currentBlock}
                    onUpdate={u => updateBlock(currentBlock.id, u)}
                  />
                </div>
              )}

              {/* Friend request - inline in center when mixed */}
              {hasFR && hasMsg && (
                <div className="flex-shrink-0 border-t border-gray-700 pt-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-medium text-gray-400"><UserCheckIcon className="w-4 h-4 inline" /> Lời nhắn kết bạn</span>
                    <div className="flex gap-1">
                      {TEMPLATE_VARS.map(v => (
                        <button key={v} type="button" onClick={() => insertFRVar(v)}
                          className="text-[10px] px-1.5 py-0.5 rounded-full border border-blue-500/30 text-blue-400 hover:bg-blue-500/15 font-mono transition-colors">
                          {v}
                        </button>
                      ))}
                    </div>
                  </div>
                  <textarea ref={friendReqRef} value={friendReqMsg} onChange={e => setFriendReqMsg(e.target.value)}
                    rows={2} placeholder="Xin chào {name}, tôi muốn kết nối với bạn!"
                    className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none transition-colors" />
                </div>
              )}

              {/* Standalone friend request */}
              {hasFR && !hasMsg && (
                <div className="flex-1 min-h-0 flex flex-col gap-2">
                  <textarea ref={friendReqRef} value={friendReqMsg} onChange={e => setFriendReqMsg(e.target.value)}
                    placeholder="Xin chào {name}, tôi muốn kết nối với bạn!"
                    className="flex-1 min-h-0 w-full bg-gray-800 border border-gray-600 rounded-xl px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none transition-colors" />
                  <p className="text-[10px] text-gray-400 text-right flex-shrink-0">{friendReqMsg.length}/200 ký tự</p>
                </div>
              )}

              {/* Invite to groups */}
              {hasInvite && !hasMsg && (
                <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                  <GroupPicker zaloId={zaloId} inviteGroupIds={inviteGroupIds} onToggle={toggleGroupId} />
                </div>
              )}

              {/* Mixed: invite groups at bottom */}
              {hasInvite && hasMsg && (
                <div className="flex-shrink-0 border-t border-gray-700 pt-3">
                  <p className="text-[11px] font-medium text-gray-400 mb-2"><UsersIcon className="w-4 h-4 inline" /> Nhóm mời</p>
                  <GroupPicker zaloId={zaloId} inviteGroupIds={inviteGroupIds} onToggle={toggleGroupId} />
                </div>
              )}
            </div>
          </div>

          {/* ── RIGHT: Preview ── */}
          <div className="w-60 flex-shrink-0 p-4 overflow-hidden flex flex-col">
            <LivePreview
              blocks={contentConfig.blocks}
              activeIdx={activeBlock}
              mode={contentConfig.mode}
              type={type}
              friendMsg={friendReqMsg}
              onTabChange={setActiveBlock}
            />
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-gray-700 flex-shrink-0">
          <div className="flex-1 text-[11px] text-gray-400">
            {hasMsg && contentConfig.blocks.length > 1 && (
              <span>{contentConfig.blocks.length} biến thể · {contentConfig.mode === 'random' ? '🎲 random' : '📨 gửi tất cả'}</span>
            )}
          </div>
          <button onClick={onClose}
            className="px-4 py-2 rounded-xl bg-gray-700 text-gray-300 text-sm hover:bg-gray-600 transition-colors font-medium">
            Hủy
          </button>
          <button onClick={handleSave} disabled={saving || !isValid()}
            className="px-6 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-semibold flex items-center gap-2">
            {saving && <Spinner size={3} />}
            {saving ? (editMode ? 'Đang lưu...' : 'Đang tạo...') : (editMode ? 'Lưu thay đổi' : 'Tạo chiến dịch')}
          </button>
        </div>
      </div>
    </div>
  );
}
