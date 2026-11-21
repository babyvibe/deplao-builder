import React, { useState, useEffect, useRef } from 'react';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { Spinner } from '@/components/common/PageLoading';
import { AlertIcon, ChartIcon, ChatIcon, ClipboardListIcon, EditIcon, PauseIcon, RocketIcon, SendIcon, ShuffleIcon, TagIcon, UserCheckIcon, UsersIcon } from '@/components/common/icons';
import { parseMarkup } from '../../../../services/crm/message-markup';
import { type Channel } from '../../../../configs/channels/channelConfig';
import { COMBINE_FALLBACK_LABEL, planBlockSend, type CampaignSendOptions } from '../../../../shared/crm/campaignSendPlan';
import { CAMPAIGN_PREVIEW_VARS, CAMPAIGN_TEMPLATE_VARS, substituteCampaignVars } from '../../../../shared/crm/campaignVars';
import { CAMPAIGN_MIN_CONTACT_DELAY_SECONDS, effectiveContactDelayRange } from '../../../../shared/crm/campaignDelay';
import { CAMPAIGN_STOP_AFTER_FAILURES_CHOICES, campaignFlag, normalizeStopAfterFailures } from '../../../../shared/crm/campaignAutoStop';
import { CampaignSendOptionsControl } from './CampaignParts';
import TemplateVarHelp from './TemplateVarHelp';
import SuccessLabelPicker from './SuccessLabelPicker';
import { useAppStore, type LabelData } from '@/store/app/appStore';
import { tr } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

// ── Types ─────────────────────────────────────────────────────────────────────

type CampaignType = 'message' | 'friend_request' | 'mixed' | 'invite_to_group';
type MixedAction  = 'message' | 'friend_request' | 'invite_to_groups';
type SendMode     = 'random' | 'all';

export interface MixedConfig   { actions: MixedAction[]; group_ids?: string[]; }
export interface ContentBlock  {
  id: string;
  text: string;
  images: string[];
  /** Videos sent after the text/images part (one message per file). */
  videos: string[];
  /** Documents / arbitrary files sent after the videos (one message per file). */
  files: string[];
  tagAll?: boolean;
  tagAllText?: string;
}
/** `order` / `combine`: photos with text (order, merge into 1 message); see shared/crm/campaignSendPlan. */
export interface ContentConfig { mode: SendMode; blocks: ContentBlock[]; order?: CampaignSendOptions['order']; combine?: boolean; }

interface CampaignFormData {
  name: string;
  /** Channel snapshot: the queue resolves the send path from it (a Facebook account is not listed in `accounts`). */
  channel?: Channel;
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
  /** Stops automatically after N contacts fail in a row; 0 = never stop */
  stop_after_failures?: number;
  /** Auto-stop: only counts strangers (Zalo) / send tomorrow: 0 / 1 */
  stop_strangers_only?: number;
  stop_resume_next_day?: number;
  /** "Gắn nhãn khi gửi thành công": JSON arrays of local / Zalo label ids */
  success_local_labels?: string;
  success_zalo_labels?: string;
}

interface CampaignCreateModalProps {
  initialData?: Partial<CampaignFormData>;
  editMode?: boolean;
  zaloId?: string;
  channel?: Channel;
  onClose: () => void;
  onSave: (data: CampaignFormData) => Promise<void>;
}

// Preview substitution - replaces variables with dummy values
function substitutePreview(text: string): string {
  return substituteCampaignVars(text || '', CAMPAIGN_PREVIEW_VARS);
}

/** Last segment of a path (the renderer has no node:path). */
function basename(filePath: string): string {
  const parts = String(filePath ?? '').split(/[\\/]/);
  return parts[parts.length - 1] || String(filePath ?? '');
}

/** Label ids stored on the campaign as a JSON array ([] on a new campaign / broken value). */
function readLabelIds(raw?: string): number[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? [...new Set(parsed.map((id: unknown) => Number(id)).filter((id: number) => Number.isInteger(id) && id > 0))]
      : [];
  } catch {
    return [];
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const genId = () => Math.random().toString(36).slice(2, 9);

/** One stored block → the editor shape; older templates have no videos/files. */
function normalizeBlock(block: any): ContentBlock {
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((path): path is string => typeof path === 'string' && path.length > 0) : [];
  return {
    ...block,
    id: String(block?.id ?? genId()),
    text: typeof block?.text === 'string' ? block.text : '',
    images: list(block?.images),
    videos: list(block?.videos),
    files: list(block?.files),
  };
}

function parseContentConfig(raw?: string): ContentConfig {
  if (!raw) return { mode: 'random', blocks: [{ id: genId(), text: '', images: [], videos: [], files: [] }] };
  try {
    const p = JSON.parse(raw);
    if (p?.blocks && Array.isArray(p.blocks)) {
      return { ...p, blocks: (p.blocks as any[]).map(normalizeBlock) } as ContentConfig;
    }
  } catch {}
  return { mode: 'random', blocks: [{ id: genId(), text: raw, images: [], videos: [], files: [] }] };
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

const TEMPLATE_VARS = CAMPAIGN_TEMPLATE_VARS;

/** Format delay range for display */
function fmtDelayRange(min: number, max: number): string {
  const fmt = (s: number) => {
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    return `${Math.round(s / 3600)}h`;
  };
  return `${fmt(min)}-${fmt(max)}`;
}

/** Preset delay ranges between contacts */
const DELAY_PRESETS = [
  { label: '2-3m',   min: 120, max: 180 },
  { label: '3-5m',   min: 180, max: 300 },
  { label: '5-10m',  min: 300, max: 600 },
  { label: '10-15m', min: 600, max: 900 },
];

/** Preset delay ranges between messages */
const PC_DELAY_PRESETS = [
  { label: tr('Không'),   min: 0,   max: 0   },
  { label: '5-15s',   min: 5,   max: 15  },
  { label: '15-30s',  min: 15,  max: 30  },
  { label: '30-60s',  min: 30,  max: 60  },
  { label: '1-2m',    min: 60,  max: 120 },
];

const TYPE_OPTIONS: { value: CampaignType; icon: React.ReactNode; label: string }[] = [
  { value: 'message',         icon: <ChatIcon className="w-4 h-4" />, label: tr('Tin nhắn')   },
  { value: 'friend_request',  icon: <UserCheckIcon className="w-4 h-4" />, label: tr('Kết bạn')    },
  { value: 'invite_to_group', icon: <UsersIcon className="w-4 h-4" />, label: tr('Mời nhóm')   },
  { value: 'mixed',           icon: <ShuffleIcon className="w-4 h-4" />, label: tr('Hỗn hợp')    },
];

const INVITE_ERROR_LABELS: Record<number, string> = {
  269: tr('Chưa là bạn bè'), 178: tr('Đã là thành viên'), 263: tr('Đã gửi lời mời'),
  262: tr('Đã có lời mời'),  177: tr('Nhóm đầy'),          166: tr('Không có quyền'),
  245: tr('Người lạ'),       122: tr('Bị chặn'),            247: tr('Bị bỏ qua nhóm'),
};

// ── Live Preview Component ─────────────────────────────────────────────────────

function LivePreview({
  blocks, activeIdx, mode, type, friendMsg,
  onTabChange, supportsFormatting, sendOptions, channel,
}: {
  blocks: ContentBlock[];
  activeIdx: number;
  mode: SendMode;
  type: CampaignType;
  friendMsg: string;
  onTabChange: (i: number) => void;
  supportsFormatting: boolean;
  sendOptions: CampaignSendOptions;
  channel: string;
}) {
  const block = blocks[activeIdx] ?? blocks[0];

  const previewText = type === 'friend_request'
    ? substitutePreview(friendMsg)
    : substitutePreview(block?.text ?? '');

  const hasImages = (block?.images?.length ?? 0) > 0;
  const hasVideos = (block?.videos?.length ?? 0) > 0;
  const hasFiles  = (block?.files?.length ?? 0) > 0;
  const hasAttachments = hasImages || hasVideos || hasFiles;
  const isFR      = type === 'friend_request';
  // Same decision as the queue: text first / photos first / photos + text in 1 message.
  const captionPreview = supportsFormatting ? parseMarkup(previewText).text : previewText;
  const plan = !isFR && block
    ? planBlockSend({
        text: captionPreview,
        images: block.images ?? [],
        videos: block.videos ?? [],
        files: block.files ?? [],
        channel,
        options: sendOptions,
      })
    : null;

  const textBubble = (
    <div className="bg-blue-600 text-white rounded-2xl rounded-br-sm px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap">
      {supportsFormatting ? <MarkupPreview text={previewText} className="text-white" /> : previewText}
    </div>
  );
  const imageGrid = (images: string[], inBubble = false) => (
    <div className={`grid gap-1 overflow-hidden ${inBubble ? '' : 'rounded-xl'} ${
      images.length === 1 ? 'grid-cols-1'
      : images.length <= 4 ? 'grid-cols-2'
      : 'grid-cols-3'
    }`} style={inBubble ? undefined : { maxWidth: '11.25rem' }}>
      {images.map((p, i) => (
        <div key={i} className="aspect-square overflow-hidden rounded">
          <img src={toLocalMediaUrl(p)} alt="" className="w-full h-full object-cover"
            onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }} />
        </div>
      ))}
    </div>
  );
  // Videos / files in the preview: an attachment row each (the real bubble shows a player / document icon)
  const attachmentRows = (paths: string[], kind: 'video' | 'file') => (
    <div className="flex flex-col gap-1" style={{ maxWidth: '11.25rem' }}>
      {paths.map((p, i) => (
        <div key={`${kind}-${i}`} className="flex items-center gap-1.5 bg-muted border border-input rounded-xl px-2 py-1.5">
          <span className={`w-6 h-6 rounded-md flex items-center justify-center text-[10px] flex-shrink-0 ${
            kind === 'video' ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'bg-slate-500/20 text-slate-300'
          }`}>{kind === 'video' ? '▶' : '📄'}</span>
          <span className="text-[10px] text-foreground/80 truncate">{basename(p)}</span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between mb-3 flex-shrink-0">
        <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">{tr('Xem trước')}</span>
        {!isFR && blocks.length > 1 && (
          <span className="text-[10px] text-muted-foreground">
            {mode === 'random' ? tr('🎲 Random') : tr('📨 Tất cả')}
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
                  : 'border-input text-muted-foreground hover:text-foreground hover:border-border-strong'
              }`}>
              {trx('Nội dung {{v1}}', { v1: i + 1 })}
            </button>
          ))}
        </div>
      )}

      {/* Phone-style preview */}
      <div className="flex-1 min-h-0 flex flex-col border border-input rounded-xl overflow-hidden">
        {/* Top bar */}
        <div className="flex items-center gap-2 px-3 py-2 bg-muted border-b border-input flex-shrink-0">
          <div className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-white text-[10px] font-bold flex-shrink-0">{supportsFormatting ? 'Z' : 'T'}</div>
          <div className="flex-1 min-w-0">
            <p className="text-[11px] font-semibold text-foreground truncate">{tr('Nguyễn Văn A')}</p>
            <p className="text-[9px] text-muted-foreground">{supportsFormatting ? 'Zalo' : 'Telegram'}</p>
          </div>
        </div>

        {/* Chat area */}
        <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-card">
          {/* Timestamp */}
          <div className="flex justify-center">
            <span className="text-[9px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{tr('Hôm nay 12:00')}</span>
          </div>

          {(previewText || hasAttachments) ? (
            <div className="flex justify-end">
              <div className="flex flex-col items-end gap-1.5 max-w-[85%]">
                {isFR ? (previewText ? textBubble : null) : plan?.steps.map((step, i) => (
                  <React.Fragment key={`${step.kind}-${i}`}>
                    {step.kind === 'text' && textBubble}
                    {step.kind === 'images' && imageGrid(step.images)}
                    {step.kind === 'videos' && attachmentRows(step.videos, 'video')}
                    {step.kind === 'files' && attachmentRows(step.files, 'file')}
                    {step.kind === 'captioned' && (
                      // Photo + text = 1 message: the text is the caption (Zalo does not keep formatting)
                      <div className="bg-blue-600 rounded-2xl rounded-br-sm overflow-hidden" style={{ maxWidth: '11.25rem' }}>
                        {imageGrid(step.images, true)}
                        <div className="px-3 py-2 text-xs leading-relaxed break-words whitespace-pre-wrap text-white">{captionPreview}</div>
                      </div>
                    )}
                  </React.Fragment>
                ))}
                {plan?.fallback && (
                  <span className="text-[9px] text-warning text-right" style={{ maxWidth: '11.25rem' }}>{COMBINE_FALLBACK_LABEL[plan.fallback]}</span>
                )}
                {/* Status tick */}
                <span className="text-[9px] text-muted-foreground">{tr('✓✓ Đã gửi')}</span>
              </div>
            </div>
          ) : (
            <div className="flex justify-center py-4">
              <p className="text-[11px] text-muted-foreground italic">
                {isFR ? tr('Soạn lời nhắn kết bạn...') : tr('Soạn nội dung tin nhắn...')}
              </p>
            </div>
          )}

          {/* Friend request chip */}
          {isFR && previewText && (
            <div className="flex justify-center">
              <div className="border border-blue-500/40 rounded-xl px-3 py-2 text-[11px] text-blue-400 text-center max-w-[90%]">{trx('<0/> Lời mời kết bạn gửi kèm nội dung trên', { 0: <UserCheckIcon className="w-4 h-4 inline" /> })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Mode explanation */}
      {!isFR && blocks.length > 1 && (
        <div className="mt-2 px-2 text-[10px] text-muted-foreground flex-shrink-0">
          {mode === 'random'
            ? tr('🎲 Mỗi người nhận ngẫu nhiên 1 trong {{count}} nội dung', { count: blocks.length })
            : tr('📨 Mỗi người nhận cả {{count}} nội dung lần lượt', { count: blocks.length })}
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
        {trx('<0/> Chỉ mời được bạn bè - Không mời được người lạ', { 0: <AlertIcon className="w-4 h-4 inline" /> })}
      </p>
      {!zaloId ? (
        <p className="text-xs text-muted-foreground py-4 text-center">{tr('Mở modal từ tab Chiến dịch để xem danh sách nhóm')}</p>
      ) : !loaded ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
          <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke="currentColor" strokeWidth="2.5"/></svg>
          {tr('Đang tải nhóm...')}
        </div>
      ) : (
        <>
          {/* Search + select all */}
          <div className="flex items-center gap-2 border border-input rounded-lg px-2.5 py-1.5 mb-2 flex-shrink-0">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-muted-foreground flex-shrink-0">
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder={tr('Tìm nhóm...')} className="flex-1 text-xs text-foreground bg-transparent focus:outline-none placeholder-subtle-foreground" />
            {(() => {
              const allSel = visible.length > 0 && visible.every(g => inviteGroupIds.includes(g.contact_id));
              return visible.length > 1 ? (
                <button onClick={() => visible.forEach(g => {
                  if (allSel ? inviteGroupIds.includes(g.contact_id) : !inviteGroupIds.includes(g.contact_id))
                    onToggle(g.contact_id);
                })} className="text-[10px] text-blue-400 hover:text-blue-300 flex-shrink-0">
                  {allSel ? tr('Bỏ tất cả') : tr('Chọn tất cả')}
                </button>
              ) : null;
            })()}
          </div>

          {inviteGroupIds.length > 0 && (
            <p className="text-[11px] text-blue-400 mb-1.5 flex-shrink-0">{trx('✓ {{count}} nhóm đã chọn', { count: inviteGroupIds.length })}</p>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto border border-input rounded-lg divide-y divide-border/50">
            {visible.map(g => {
              const checked = inviteGroupIds.includes(g.contact_id);
              return (
                <label key={g.contact_id}
                  className={`flex items-center gap-2 px-2.5 py-2 cursor-pointer transition-colors ${checked ? 'bg-blue-500/10' : 'hover:bg-muted/40'}`}>
                  <div onClick={() => onToggle(g.contact_id)}
                    className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                      checked ? 'bg-blue-500 border-blue-500' : 'border-border-strong hover:border-blue-400'
                    }`}>
                    {checked && <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                  </div>
                  {g.avatar_url
                    ? <img src={g.avatar_url} alt="" className="w-6 h-6 rounded-full object-cover flex-shrink-0" />
                    : <div className="w-6 h-6 rounded-full bg-blue-700 flex items-center justify-center text-white text-[9px] font-bold flex-shrink-0">{(g.display_name||'?').charAt(0).toUpperCase()}</div>
                  }
                  <span className={`flex-1 text-xs truncate ${checked ? 'text-foreground font-medium' : 'text-foreground/80'}`}>{g.display_name}</span>
                </label>
              );
            })}
            {visible.length === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">{groups.length === 0 ? tr('Chưa có nhóm nào. Đồng bộ nhóm trước.') : tr('Không tìm thấy')}</p>
            )}
          </div>

          <details className="mt-2 flex-shrink-0">
            <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-muted-foreground select-none">{trx('<0/> Mã lỗi thường gặp', { 0: <ClipboardListIcon className="w-4 h-4 inline" /> })}</summary>
            <div className="mt-1 flex flex-wrap gap-1">
              {Object.entries(INVITE_ERROR_LABELS).map(([c, l]) => (
                <span key={c} className="text-[9px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">{c}: {l}</span>
              ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}

// ── Markup Preview ────────────────────────────────────────────────────────────

// Render text with markup as styled <span>s, matching how zca-js displays it.
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

function MarkupPreview({ text, className = 'text-foreground/80' }: { text: string; className?: string }) {
  const { text: clean, styles } = parseMarkup(text);
  if (!styles.length) return <span className={className}>{clean}</span>;
  // Merge the style per character, then cut into consecutive runs with the same style.
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
  return <span className={className}>{spans}</span>;
}

// ── Block Editor ──────────────────────────────────────────────────────────────

function BlockEditor({
  block, onUpdate, channel, supportsTagAll = true, supportsFormatting = true,
}: {
  block: ContentBlock;
  onUpdate: (u: Partial<ContentBlock>) => void;
  /** Channel of the campaign: drives the per-channel notes of the variable help. */
  channel: string;
  supportsTagAll?: boolean;
  supportsFormatting?: boolean;
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

  // Wrap the selected text in a pair of markup tags ([b]…[/b], [red]…[/red]…).
  // With no selection, insert an empty pair of tags and put the cursor in the middle.
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
      filters: [{ name: tr('Hình ảnh'), extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r?.filePaths?.length) onUpdate({ images: [...block.images, ...r.filePaths] });
  };

  const pickVideos = async () => {
    const r = await ipc.file?.openDialog({
      filters: [{ name: tr('Video'), extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', '3gp'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r?.filePaths?.length) onUpdate({ videos: [...(block.videos ?? []), ...r.filePaths] });
  };

  const pickFiles = async () => {
    const r = await ipc.file?.openDialog({
      // Any file: "Tất cả tệp" only, so a document the OS does not know still shows up
      filters: [{ name: tr('Tất cả tệp'), extensions: ['*'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r?.filePaths?.length) onUpdate({ files: [...(block.files ?? []), ...r.filePaths] });
  };

  /** One attachment row (video / file) with its remove button. */
  const attachmentChip = (kind: 'video' | 'file', filePath: string, index: number) => (
    <div key={`${kind}-${index}`} className="flex items-center gap-1.5 bg-card border border-input rounded-lg px-2 py-1 max-w-full">
      <span className={`w-5 h-5 rounded flex items-center justify-center text-[9px] flex-shrink-0 ${
        kind === 'video' ? 'bg-fuchsia-500/20 text-fuchsia-300' : 'bg-slate-500/20 text-slate-300'
      }`}>{kind === 'video' ? '▶' : '📄'}</span>
      <span className="text-[10px] text-foreground/80 truncate max-w-[7.5rem]" title={filePath}>{basename(filePath)}</span>
      <button type="button"
        onClick={() => onUpdate(kind === 'video'
          ? { videos: (block.videos ?? []).filter((_, j) => j !== index) }
          : { files: (block.files ?? []).filter((_, j) => j !== index) })}
        className="text-muted-foreground hover:text-red-400 flex-shrink-0" title={tr('Bỏ đính kèm')}>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      {/* Variable chips */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="text-[10px] text-muted-foreground">{tr('Chèn biến:')}</span>
        {TEMPLATE_VARS.map(v => (
          <button key={v} type="button" onClick={() => insertVar(v)}
            className="text-[11px] px-2 py-0.5 rounded-full border border-blue-500/30 text-blue-400 hover:bg-blue-500/15 font-mono transition-colors">
            {v}
          </button>
        ))}
        <TemplateVarHelp channel={channel} />
      </div>

      {/* Formatting toolbar */}
      {supportsFormatting && <div className="flex items-center gap-1 flex-wrap flex-shrink-0">
        <button type="button" onClick={() => wrapSelection('b')} title={tr('In đậm')}
          className="text-[12px] font-bold w-6 h-6 rounded border border-input text-foreground/80 hover:bg-muted transition-colors">B</button>
        <button type="button" onClick={() => wrapSelection('i')} title={tr('In nghiêng')}
          className="text-[12px] italic w-6 h-6 rounded border border-input text-foreground/80 hover:bg-muted transition-colors">I</button>
        <button type="button" onClick={() => wrapSelection('u')} title={tr('Gạch chân')}
          className="text-[12px] underline w-6 h-6 rounded border border-input text-foreground/80 hover:bg-muted transition-colors">U</button>
        <button type="button" onClick={() => wrapSelection('s')} title={tr('Gạch ngang')}
          className="text-[12px] line-through w-6 h-6 rounded border border-input text-foreground/80 hover:bg-muted transition-colors">S</button>
        <span className="w-px h-4 bg-accent mx-0.5" />
        {([['red','#db342e'],['orange','#f27806'],['yellow','#f7b503'],['green','#15a85f']] as const).map(([tag, hex]) => (
          <button key={tag} type="button" onClick={() => wrapSelection(tag)} title={tr('Màu {{tag}}', { tag })}
            className="w-5 h-5 rounded-full border border-border-strong hover:scale-110 transition-transform" style={{ background: hex }} />
        ))}
        <span className="w-px h-4 bg-accent mx-0.5" />
        <button type="button" onClick={() => wrapSelection('big')} title={tr('Cỡ lớn')}
          className="text-[13px] font-semibold px-1.5 h-6 rounded border border-input text-foreground/80 hover:bg-muted transition-colors">A+</button>
        <button type="button" onClick={() => wrapSelection('small')} title={tr('Cỡ nhỏ')}
          className="text-[10px] px-1.5 h-6 rounded border border-input text-foreground/80 hover:bg-muted transition-colors">A-</button>
      </div>}

      {/* Textarea - takes most space */}
      <textarea
        ref={taRef}
        value={block.text}
        onChange={e => onUpdate({ text: e.target.value })}
        placeholder={tr('Soạn nội dung tin nhắn...\nDùng {name} để chèn tên người nhận')}
        className="flex-1 min-h-0 w-full bg-card border border-input rounded-xl px-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 resize-none transition-colors"
      />

      {/* @all tag when sending to a group */}
      {supportsTagAll && <label className="flex items-center gap-2 flex-shrink-0 cursor-pointer text-xs text-muted-foreground select-none flex-wrap">
        <input type="checkbox" checked={!!block.tagAll} onChange={e => onUpdate({ tagAll: e.target.checked })}
          className="accent-blue-500 w-3.5 h-3.5" />
        {tr('Tag toàn nhóm khi gửi vào nhóm')}
        {block.tagAll && (
          <span className="flex items-center gap-1" onClick={e => e.preventDefault()}>
            <span className="font-mono text-blue-400">@</span>
            <input type="text" value={block.tagAllText ?? 'all'}
              onChange={e => onUpdate({ tagAllText: e.target.value })}
              placeholder={tr('all')}
              className="w-28 bg-card border border-border rounded px-1.5 py-0.5 font-mono text-blue-400 text-xs focus:outline-none focus:border-blue-500" />
          </span>
        )}
        <span className="text-subtle-foreground">{tr('(bỏ qua với chat cá nhân)')}</span>
      </label>}

      {/* Images */}
      <div className="flex-shrink-0">
        {block.images.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {block.images.map((p, i) => (
              <div key={i} className="relative group/img w-14 h-14 rounded-lg overflow-hidden border border-input flex-shrink-0">
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
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs text-muted-foreground hover:text-blue-400 border border-dashed border-input hover:border-blue-500/50 rounded-lg transition-colors">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/>
            <polyline points="21 15 16 10 5 21"/>
          </svg>
          {block.images.length > 0 ? tr('{{count}} ảnh · thêm tiếp', { count: block.images.length }) : tr('Đính kèm ảnh (tuỳ chọn)')}
        </button>
      </div>

      {/* Videos + files: sent after the text/images part, one message per file */}
      <div className="flex-shrink-0 flex flex-col gap-2">
        {(block.videos?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(block.videos ?? []).map((p, i) => attachmentChip('video', p, i))}
          </div>
        )}
        <button type="button" onClick={pickVideos}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs text-muted-foreground hover:text-fuchsia-400 border border-dashed border-input hover:border-fuchsia-500/50 rounded-lg transition-colors">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <rect x="2" y="4" width="20" height="16" rx="2"/><polygon points="10 9 15 12 10 15"/>
          </svg>
          {(block.videos?.length ?? 0) > 0 ? tr('{{count}} video · thêm tiếp', { count: block.videos!.length }) : tr('Đính kèm video (tuỳ chọn)')}
        </button>
        {(block.files?.length ?? 0) > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(block.files ?? []).map((p, i) => attachmentChip('file', p, i))}
          </div>
        )}
        <button type="button" onClick={pickFiles}
          className="w-full flex items-center justify-center gap-1.5 py-1.5 text-xs text-muted-foreground hover:text-emerald-400 border border-dashed border-input hover:border-emerald-500/50 rounded-lg transition-colors">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>
          </svg>
          {(block.files?.length ?? 0) > 0 ? tr('{{count}} tệp · thêm tiếp', { count: block.files!.length }) : tr('Đính kèm tệp (tuỳ chọn)')}
        </button>
      </div>
    </div>
  );
}

// ── Main Modal ────────────────────────────────────────────────────────────────

export default function CampaignCreateModal({
  initialData, editMode = false, zaloId, channel = 'zalo', onClose, onSave,
}: CampaignCreateModalProps) {
  const [name,          setName]         = useState(initialData?.name ?? '');
  const [type,          setType]         = useState<CampaignType>(initialData?.campaign_type ?? 'message');
  // Telegram and Facebook run message campaigns only (CRMChannelCapabilityService); Zalo keeps every type.
  const messageOnlyCampaign = channel === 'telegram_user' || channel === 'telegram_bot' || channel === 'facebook';
  const zaloCampaign = channel === 'zalo';
  const availableTypes = messageOnlyCampaign ? TYPE_OPTIONS.filter(opt => opt.value === 'message') : TYPE_OPTIONS;
  const [saving,        setSaving]       = useState(false);
  const [friendReqMsg,  setFriendReqMsg] = useState(initialData?.friend_request_message ?? '');
  const [activeBlock,   setActiveBlock]  = useState(0);
  const [dailyLimit,    setDailyLimit]   = useState(initialData?.daily_send_limit ?? 0);
  const [dailyStartTime, setDailyStartTime] = useState(initialData?.daily_start_time ?? '08:00');
  // Does not auto-stop by default; values outside these steps (saved via the API) are still shown so they are not lost when saving again
  const [stopAfterFailures, setStopAfterFailures] = useState(() => normalizeStopAfterFailures(initialData?.stop_after_failures));
  const stopChoices = CAMPAIGN_STOP_AFTER_FAILURES_CHOICES.includes(stopAfterFailures)
    ? CAMPAIGN_STOP_AFTER_FAILURES_CHOICES
    : [...CAMPAIGN_STOP_AFTER_FAILURES_CHOICES, stopAfterFailures].sort((a, b) => a - b);
  // Zalo limits spam per message to strangers (messaging friends / groups is still allowed) and usually reopens the next day. Other channels do not have it
  // friends list → there is no "Chỉ tính người lạ" (Count strangers only) option.
  const strangersOption = channel === 'zalo';
  const [stopStrangersOnly, setStopStrangersOnly] = useState(() => campaignFlag(initialData?.stop_strangers_only) === 1);
  const [stopResumeNextDay, setStopResumeNextDay] = useState(() => campaignFlag(initialData?.stop_resume_next_day) === 1);
  const countStrangersOnly = strangersOption && stopStrangersOnly;

  // ── Delay range (min/max replaces fixed + jitter) ────────────────────────
  const getInitMinMax = (): [number, number] => {
    const d = initialData;
    if (!d) return [110, 130];
    const dm = (d as any).delay_min_seconds;
    const dx = (d as any).delay_max_seconds;
    // A saved range below the minimum (old versions allowed picking from 5 seconds) → show the range the queue actually uses
    if (dm != null && dx != null) return effectiveContactDelayRange(dm, dx);
    const fallback = d.delay_seconds || 120;
    return effectiveContactDelayRange(fallback - 10, fallback + 10);
  };
  const initRange = getInitMinMax();
  const [delayMin, setDelayMin] = useState(initRange[0]);
  const [delayMax, setDelayMax] = useState(initRange[1]);
  const [customDelayMode, setCustomDelayMode] = useState(false);

  // ── Per-contact delay range (delay between messages to 1 contact) ────────
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

  // ── "Gắn nhãn khi gửi thành công": local labels + Zalo server labels (Zalo channel only) ──
  const [successLocalLabelIds, setSuccessLocalLabelIds] = useState<number[]>(() => readLabelIds(initialData?.success_local_labels));
  const [successZaloLabelIds, setSuccessZaloLabelIds] = useState<number[]>(() => readLabelIds(initialData?.success_zalo_labels));
  const [localLabels, setLocalLabels] = useState<Array<{ id: number; name: string; color?: string; emoji?: string }>>([]);
  const zaloLabels: LabelData[] = useAppStore(s => (zaloId ? s.labels[zaloId] : undefined)) ?? [];
  const supportsZaloLabels = channel === 'zalo';

  useEffect(() => {
    if (!zaloId) { setLocalLabels([]); return; }
    let cancelled = false;
    DataAccessor.getLocalLabels({ zaloId })
      .then((res: any) => { if (!cancelled) setLocalLabels(Array.isArray(res?.labels) ? res.labels : []); })
      .catch(() => { if (!cancelled) setLocalLabels([]); });
    return () => { cancelled = true; };
  }, [zaloId]);

  const initMixed = parseMixedConfig(initialData?.mixed_config);
  const [mixedActions,   setMixedActions]   = useState<MixedAction[]>(initMixed.actions);
  const [inviteGroupIds, setInviteGroupIds] = useState<string[]>(initMixed.group_ids ?? []);

  const hasMsg    = type === 'message' || (type === 'mixed' && mixedActions.includes('message'));
  const hasFR     = type === 'friend_request' || (type === 'mixed' && mixedActions.includes('friend_request'));
  const hasInvite = type === 'invite_to_group' || (type === 'mixed' && mixedActions.includes('invite_to_groups'));

  useEffect(() => {
    if (messageOnlyCampaign && type !== 'message') setType('message');
  }, [messageOnlyCampaign, type]);

  // Clamp activeBlock when blocks change
  useEffect(() => {
    setActiveBlock(i => Math.min(i, contentConfig.blocks.length - 1));
  }, [contentConfig.blocks.length]);

  const addBlock = () => {
    setContentConfig(prev => {
      const next = { ...prev, blocks: [...prev.blocks, { id: genId(), text: '', images: [], videos: [], files: [] }] };
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

  /** A block counts as content when it has text or any attachment (image / video / file). */
  const blockHasContent = (b: ContentBlock): boolean =>
    !!b.text.trim() || b.images.length > 0 || (b.videos?.length ?? 0) > 0 || (b.files?.length ?? 0) > 0;

  const isValid = (): boolean => {
    if (!name.trim()) return false;
    if (type === 'invite_to_group') return inviteGroupIds.length > 0;
    if (type === 'mixed') {
      if (!mixedActions.length) return false;
      if (mixedActions.includes('message') && !contentConfig.blocks.some(blockHasContent)) return false;
      if (mixedActions.includes('friend_request') && !friendReqMsg.trim()) return false;
      if (mixedActions.includes('invite_to_groups') && !inviteGroupIds.length) return false;
    } else {
      if (hasMsg && !contentConfig.blocks.some(blockHasContent)) return false;
      if (hasFR && !friendReqMsg.trim()) return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!isValid()) return;
    setSaving(true);
    // The custom input is only clamped when leaving the field → clamp again in case Save is pressed while still typing
    const [saveDelayMin, saveDelayMax] = effectiveContactDelayRange(delayMin, delayMax);
    const finalDelaySec = Math.round((saveDelayMin + saveDelayMax) / 2);
    await onSave({
      name: name.trim(),
      channel,
      template_message: hasMsg ? JSON.stringify(contentConfig) : '',
      friend_request_message: friendReqMsg.trim(),
      campaign_type: type,
      mixed_config: buildMixedConfig(),
      delay_seconds: finalDelaySec,
      delay_min_seconds: saveDelayMin,
      delay_max_seconds: saveDelayMax,
      per_contact_delay_min_seconds: pcDelayMin,
      per_contact_delay_max_seconds: pcDelayMax,
      daily_send_limit: dailyLimit,
      daily_start_time: dailyStartTime,
      stop_after_failures: stopAfterFailures,
      stop_strangers_only: countStrangersOnly ? 1 : 0,
      stop_resume_next_day: stopResumeNextDay ? 1 : 0,
      success_local_labels: JSON.stringify(successLocalLabelIds),
      // Zalo keeps one label per conversation → store at most one, so the screen and the queue agree
      success_zalo_labels: JSON.stringify(supportsZaloLabels ? successZaloLabelIds.slice(0, 1) : []),
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
        className="bg-card border border-border rounded-2xl w-full max-w-[1060px] shadow-2xl flex flex-col"
        style={{ height: 'min(92vh, 42.5rem)' }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Topbar ── */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border flex-shrink-0">
          <div>
            <h3 className="font-bold text-foreground text-[15px]">
              {editMode ? <>{trx('<0/> Chỉnh sửa chiến dịch', { 0: <EditIcon className="w-4 h-4 inline" /> })}</> : <>{trx('<0/> Tạo chiến dịch mới', { 0: <RocketIcon className="w-4 h-4 inline" /> })}</>}
            </h3>
            <p className="text-[11px] text-muted-foreground mt-0.5">{tr('Cấu hình nội dung và phương thức gửi')}</p>
          </div>
          <button onClick={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>

        {/* ── 3-column body ── */}
        <div className="flex-1 min-h-0 flex overflow-hidden">

          {/* ── LEFT: Settings ── */}
          <div className="w-52 flex-shrink-0 border-r border-border flex flex-col overflow-y-auto p-4 gap-5">
            {/* Campaign name */}
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">{tr('Tên chiến dịch *')}</label>
              <input value={name} onChange={e => setName(e.target.value)}
                placeholder={tr('Nhập tên...')}
                className="w-full bg-card border border-input rounded-lg px-2.5 py-2 text-xs text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 transition-colors" />
            </div>

            {/* Type */}
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">{tr('Loại *')}</label>
              <div className="space-y-1">
                {availableTypes.map(opt => (
                  <button key={opt.value} type="button" onClick={() => setType(opt.value)}
                    className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border text-left transition-colors ${
                      type === opt.value
                        ? 'border-blue-500 bg-blue-500/10 text-foreground'
                        : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/50'
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
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">{tr('Hành động')}</label>
                <div className="space-y-1">
                  {([
                    { action: 'message' as MixedAction,         icon: <ChatIcon className="w-4 h-4" />, label: tr('Tin nhắn') },
                    { action: 'friend_request' as MixedAction,  icon: <UserCheckIcon className="w-4 h-4" />, label: tr('Kết bạn') },
                    { action: 'invite_to_groups' as MixedAction, icon: <UsersIcon className="w-4 h-4" />, label: tr('Mời nhóm') },
                  ]).map(({ action, icon, label }) => {
                    const checked = mixedActions.includes(action);
                    return (
                      <label key={action}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer transition-colors ${checked ? 'bg-blue-500/10' : 'hover:bg-muted/40'}`}>
                        <div onClick={() => toggleMixedAction(action)}
                          className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 transition-all ${
                            checked ? 'bg-blue-500 border-blue-500' : 'border-border-strong hover:border-blue-400'
                          }`}>
                          {checked && <svg width="8" height="6" viewBox="0 0 8 6" fill="none"><path d="M1 3L3 5L7 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                        </div>
                        <span className="text-base leading-none">{icon}</span>
                        <span className="text-xs text-foreground/80">{label}</span>
                      </label>
                    );
                  })}
                  {!mixedActions.length && <p className="text-[10px] text-red-400 px-1">{tr('Chọn ít nhất 1 hành động')}</p>}
                </div>
              </div>
            )}

            {/* ⏱ Delay between contacts */}
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">{tr('⏱ Delay giữa các liên hệ')}</label>
              <div className="grid grid-cols-2 gap-1">
                {DELAY_PRESETS.map(p => {
                  const active = !customDelayMode && delayMin === p.min && delayMax === p.max;
                  return (
                    <button key={p.label} type="button" onClick={() => { setDelayMin(p.min); setDelayMax(p.max); setCustomDelayMode(false); }}
                      className={`py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${
                        active ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                          : 'border-input text-muted-foreground hover:border-border-strong hover:text-foreground/80'
                      }`}>
                      {p.label}
                    </button>
                  );
                })}
              </div>
              <button type="button" onClick={() => setCustomDelayMode(!customDelayMode)}
                className={`flex items-center gap-1 mt-1.5 text-[11px] px-2 py-1 rounded-lg border transition-colors w-full ${
                  customDelayMode ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                    : 'border-input text-muted-foreground hover:text-foreground/80 hover:border-border-strong'
                }`}>
                {trx('<0>{{v1}}</0> Tùy chỉnh khoảng', { 0: <span />, v1: customDelayMode ? '▾' : '▸' })}
              </button>
              {customDelayMode && (
                <div className="flex items-center gap-1.5 mt-1.5">
                  {/* Clamped when leaving the field (clamping each key would turn "45" into "305"); the queue never sends faster than 30 seconds / contact */}
                  <input type="number" min={CAMPAIGN_MIN_CONTACT_DELAY_SECONDS} value={delayMin || ''}
                    onChange={e => setDelayMin(parseInt(e.target.value) || 0)}
                    onBlur={() => {
                      const [min, max] = effectiveContactDelayRange(delayMin, delayMax);
                      setDelayMin(min); setDelayMax(max);
                    }}
                    className="w-full bg-card border border-input rounded-lg px-2 py-1.5 text-[11px] text-foreground focus:outline-none focus:border-blue-500"
                    placeholder={tr('Tối thiểu (≥ {{CAMPAIGN_MIN_CONTACT_DELAY_SECONDS}}s)', { CAMPAIGN_MIN_CONTACT_DELAY_SECONDS })} />
                  <span className="text-muted-foreground text-xs">→</span>
                  <input type="number" min={Math.max(CAMPAIGN_MIN_CONTACT_DELAY_SECONDS, delayMin)} value={delayMax || ''}
                    onChange={e => setDelayMax(parseInt(e.target.value) || 0)}
                    onBlur={() => setDelayMax(effectiveContactDelayRange(delayMin, delayMax)[1])}
                    className="w-full bg-card border border-input rounded-lg px-2 py-1.5 text-[11px] text-foreground focus:outline-none focus:border-blue-500"
                    placeholder={tr('Tối đa (s)')} />
                  <span className="text-muted-foreground text-[10px] flex-shrink-0">{tr('giây')}</span>
                </div>
              )}
              <p className="text-[10px] text-muted-foreground mt-1">
                {trx('⏱ Ngẫu nhiên <0>{{v1}}</0> giữa các liên hệ', { 0: <span className="text-muted-foreground font-medium" />, v1: fmtDelayRange(...effectiveContactDelayRange(delayMin, delayMax)) })}
                {customDelayMode && <> {trx('· tối thiểu {{CAMPAIGN_MIN_CONTACT_DELAY_SECONDS}} giây', { CAMPAIGN_MIN_CONTACT_DELAY_SECONDS })}</>}
              </p>
            </div>

            {/* ⏱ Delay between messages (only when sending several messages / contact) */}
            {hasMultiSend && (
              <div>
                <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">{tr('⏱ Delay giữa các tin nhắn')}</label>
                <div className="grid grid-cols-2 gap-1">
                  {PC_DELAY_PRESETS.map(p => {
                    const active = !customPcDelayMode && pcDelayMin === p.min && pcDelayMax === p.max;
                    return (
                      <button key={p.label} type="button" onClick={() => { setPcDelayMin(p.min); setPcDelayMax(p.max); setCustomPcDelayMode(false); }}
                        className={`py-1.5 rounded-lg border text-[11px] font-medium transition-colors ${
                          active ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                            : 'border-input text-muted-foreground hover:border-border-strong hover:text-foreground/80'
                        }`}>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
                <button type="button" onClick={() => setCustomPcDelayMode(!customPcDelayMode)}
                  className={`flex items-center gap-1 mt-1.5 text-[11px] px-2 py-1 rounded-lg border transition-colors w-full ${
                    customPcDelayMode ? 'border-blue-500 bg-blue-500/10 text-blue-300'
                      : 'border-input text-muted-foreground hover:text-foreground/80 hover:border-border-strong'
                  }`}>
                  {trx('<0>{{v1}}</0> Tùy chỉnh', { 0: <span />, v1: customPcDelayMode ? '▾' : '▸' })}
                </button>
                {customPcDelayMode && (
                  <div className="flex items-center gap-1.5 mt-1.5">
                    <input type="number" min={0} value={pcDelayMin ?? ''}
                      onChange={e => setPcDelayMin(Math.max(0, parseInt(e.target.value) || 0))}
                      className="w-full bg-card border border-input rounded-lg px-2 py-1.5 text-[11px] text-foreground focus:outline-none focus:border-blue-500"
                      placeholder={tr('Min (s)')} />
                    <span className="text-muted-foreground text-xs">→</span>
                    <input type="number" min={pcDelayMin} value={pcDelayMax ?? ''}
                      onChange={e => setPcDelayMax(Math.max(pcDelayMin || 0, parseInt(e.target.value) || 0))}
                      className="w-full bg-card border border-input rounded-lg px-2 py-1.5 text-[11px] text-foreground focus:outline-none focus:border-blue-500"
                      placeholder={tr('Max (s)')} />
                    <span className="text-muted-foreground text-[10px] flex-shrink-0">{tr('giây')}</span>
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground mt-1">
                  {pcDelayMin > 0 || pcDelayMax > 0
                    ? tr('⏱ Ngẫu nhiên {{v1}} giữa các tin nhắn', { v1: fmtDelayRange(pcDelayMin, pcDelayMax) })
                    : tr('⏱ Gửi liên tiếp (mặc định ~1s)')}
                </p>
              </div>
            )}

            {/* Daily Send Limit */}
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">{trx('<0/> Giới hạn/ngày', { 0: <ChartIcon className="w-4 h-4 inline" /> })}</label>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={0}
                    step={10}
                    value={dailyLimit || ''}
                    onChange={e => setDailyLimit(Math.max(0, parseInt(e.target.value) || 0))}
                    placeholder={tr('Không giới hạn')}
                    className="w-full bg-card border border-input rounded-lg px-2.5 py-2 text-xs text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 transition-colors"
                  />
                  <span className="text-[10px] text-muted-foreground flex-shrink-0">{tr('liên hệ')}</span>
                </div>
                <div>
                  <label className="text-[10px] text-muted-foreground block mb-1">{tr('Giờ bắt đầu chạy')}</label>
                  <input
                    type="time"
                    value={dailyStartTime}
                    onChange={e => setDailyStartTime(e.target.value || '08:00')}
                    className="w-full bg-card border border-input rounded-lg px-2.5 py-2 text-xs text-foreground focus:outline-none focus:border-blue-500 transition-colors"
                  />
                  <p className="text-[10px] text-muted-foreground mt-0.5">{tr('Nếu giờ này đã qua hôm nay, chiến dịch chạy ngay')}</p>
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                {dailyLimit > 0
                  ? tr('Gửi tối đa {{dailyLimit}}/ngày từ {{dailyStartTime}}', { dailyLimit, dailyStartTime })
                  : tr('Không giới hạn/ngày · chạy từ {{dailyStartTime}}, hạn mức 60 lượt/giờ mỗi tài khoản', { dailyStartTime })}
              </p>
            </div>

            {/* Auto-stops after consecutive errors: a blocked / limited account does not keep sending forever (shared/crm/campaignAutoStop) */}
            <div>
              <label className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider block mb-1.5">{trx('<0/> Tự dừng khi lỗi', { 0: <PauseIcon className="w-4 h-4 inline" /> })}</label>
              <div className="grid grid-cols-5 gap-1">
                {stopChoices.map(n => (
                  <button key={n} type="button" onClick={() => setStopAfterFailures(n)}
                    title={n > 0 ? tr('Dừng khi {{n}} liên hệ lỗi liên tiếp', { n }) : tr('Không tự dừng')}
                    className={`py-1.5 rounded-lg border text-[11px] font-medium tabular-nums transition-colors ${
                      stopAfterFailures === n ? 'border-blue-500 bg-blue-500/15 text-blue-300'
                        : 'border-input text-muted-foreground hover:border-border-strong hover:text-foreground/80'
                    }`}>
                    {n > 0 ? n : tr('Tắt')}
                  </button>
                ))}
              </div>
              {stopAfterFailures > 0 && (
                <div className="mt-1.5 space-y-1">
                  {strangersOption && (
                    <label className="flex items-center gap-2 cursor-pointer text-[11px] text-muted-foreground select-none"
                      title={tr('Zalo chặn spam theo tin nhắn cho người lạ: bạn bè, nhóm gửi được hay lỗi đều không tính')}>
                      <input type="checkbox" checked={stopStrangersOnly} onChange={e => setStopStrangersOnly(e.target.checked)}
                        className="accent-blue-500 w-3.5 h-3.5" />
                      {tr('Chỉ tính người lạ')}
                    </label>
                  )}
                  <label className="flex items-center gap-2 cursor-pointer text-[11px] text-muted-foreground select-none"
                    title={tr('Dừng tới {{dailyStartTime}} hôm sau rồi tự gửi tiếp (bị chặn spam thường mở lại sau một ngày)', { dailyStartTime })}>
                    <input type="checkbox" checked={stopResumeNextDay} onChange={e => setStopResumeNextDay(e.target.checked)}
                      className="accent-blue-500 w-3.5 h-3.5" />
                    {tr('Mai gửi tiếp')}
                  </label>
                </div>
              )}
              <p className="text-[10px] text-muted-foreground mt-1">
                {stopAfterFailures > 0
                  ? tr('Dừng khi {{stopAfterFailures}} {{v1}} lỗi liên tiếp{{v2}}', { stopAfterFailures, v1: countStrangersOnly ? tr('người lạ') : tr('liên hệ'), v2: stopResumeNextDay ? tr(', {{dailyStartTime}} hôm sau gửi tiếp', { dailyStartTime }) : '' })
                  : tr('Gửi hết danh sách dù lỗi')}
              </p>
            </div>

            {/* Warning */}
            <div className="border border-yellow-500/20 rounded-lg p-2.5 mt-auto">
              <p className="text-[10px] text-yellow-400 font-semibold mb-1">{trx('<0/> Cảnh báo', { 0: <AlertIcon className="w-3.5 h-3.5 inline" /> })}</p>
              <p className="text-[9px] text-yellow-300/60 leading-relaxed">
                {tr('Hành động càng nhiều, nội dung càng dài, và delay càng ngắn sẽ làm tăng nguy cơ bị đánh spam. Hãy cân nhắc kỹ lưỡng khi cấu hình chiến dịch, và luôn tuân thủ nguyên tắc cộng đồng của nền tảng.')}
              </p>
            </div>
          </div>

          {/* ── CENTER: Editor ── */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden border-r border-border">
            {/* Center topbar */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0 min-h-[44px]">
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
                            : 'border-input text-muted-foreground hover:text-foreground hover:border-border-strong'
                        }`}>
                        {trx('<0>{{v1}}</0>Nội dung {{v1}}', { 0: <span className="w-4 h-4 rounded-full bg-current/20 flex items-center justify-center text-[9px] font-bold leading-none" />, v1: i + 1 })}
                        {contentConfig.blocks.length > 1 && (
                          <span
                            onClick={e => { e.stopPropagation(); removeBlock(b.id); }}
                            className="ml-0.5 opacity-50 hover:opacity-100 cursor-pointer">×</span>
                        )}
                      </button>
                    ))}
                    <button type="button" onClick={addBlock}
                      title={tr('Thêm biến thể nội dung')}
                      className="flex-shrink-0 w-7 h-7 rounded-lg border border-dashed border-input text-muted-foreground hover:text-blue-400 hover:border-blue-500/50 flex items-center justify-center transition-colors text-lg leading-none">
                      +
                    </button>
                  </div>
                  {/* Mode toggle (only when multiple blocks) */}
                  {contentConfig.blocks.length > 1 && (
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      {([
                        { value: 'random' as SendMode, icon: <ShuffleIcon className="w-4 h-4" />, label: tr('Random') },
                        { value: 'all' as SendMode,    icon: <SendIcon className="w-4 h-4" />, label: tr('Tất cả') },
                      ]).map(opt => (
                        <button key={opt.value} type="button"
                          onClick={() => setContentConfig(prev => ({ ...prev, mode: opt.value }))}
                          className={`flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-colors border ${
                            contentConfig.mode === opt.value
                              ? 'bg-blue-600 border-blue-500 text-white'
                              : 'border-input text-muted-foreground hover:text-foreground'
                          }`}>
                          <span>{opt.icon}</span> {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : hasFR && !hasMsg ? (
                <>
                  <span className="text-xs font-medium text-foreground/80">{trx('<0/> Lời nhắn kết bạn', { 0: <UserCheckIcon className="w-4 h-4 inline" /> })}</span>
                  <div className="flex items-center gap-1">
                    {TEMPLATE_VARS.map(v => (
                      <button key={v} type="button" onClick={() => insertFRVar(v)}
                        className="text-[11px] px-2 py-0.5 rounded-full border border-blue-500/30 text-blue-400 hover:bg-blue-500/15 font-mono transition-colors">
                        {v}
                      </button>
                    ))}
                    <TemplateVarHelp channel={channel} />
                  </div>
                </>
              ) : hasInvite && !hasMsg ? (
                <span className="text-xs font-medium text-foreground/80">{trx('<0/> Chọn nhóm để mời', { 0: <UsersIcon className="w-4 h-4 inline" /> })}</span>
              ) : (
                <span className="text-xs text-muted-foreground">{tr('Editor')}</span>
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
                    channel={channel}
                    supportsTagAll={zaloCampaign}
                    supportsFormatting={zaloCampaign}
                  />
                </div>
              )}

              {/* Photo with text: order + merged into 1 message (applies to any content with both text and photos) */}
              {hasMsg && contentConfig.blocks.some(b => b.images.length > 0) && (
                <div className="flex-shrink-0 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
                  <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{tr('Ảnh kèm chữ')}</p>
                  <CampaignSendOptionsControl
                    value={{ order: contentConfig.order ?? 'text_first', combine: !!contentConfig.combine }}
                    channel={channel}
                    onChange={patch => setContentConfig(prev => ({ ...prev, ...patch }))}
                  />
                </div>
              )}

              {/* Friend request - inline in center when mixed */}
              {hasFR && hasMsg && (
                <div className="flex-shrink-0 border-t border-border pt-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-[11px] font-medium text-muted-foreground">{trx('<0/> Lời nhắn kết bạn', { 0: <UserCheckIcon className="w-4 h-4 inline" /> })}</span>
                    <div className="flex items-center gap-1">
                      {TEMPLATE_VARS.map(v => (
                        <button key={v} type="button" onClick={() => insertFRVar(v)}
                          className="text-[10px] px-1.5 py-0.5 rounded-full border border-blue-500/30 text-blue-400 hover:bg-blue-500/15 font-mono transition-colors">
                          {v}
                        </button>
                      ))}
                      <TemplateVarHelp channel={channel} />
                    </div>
                  </div>
                  <textarea ref={friendReqRef} value={friendReqMsg} onChange={e => setFriendReqMsg(e.target.value)}
                    rows={2} placeholder={tr('Xin chào {name}, tôi muốn kết nối với bạn!')}
                    className="w-full bg-card border border-input rounded-lg px-3 py-2 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 resize-none transition-colors" />
                </div>
              )}

              {/* Standalone friend request */}
              {hasFR && !hasMsg && (
                <div className="flex-1 min-h-0 flex flex-col gap-2">
                  <textarea ref={friendReqRef} value={friendReqMsg} onChange={e => setFriendReqMsg(e.target.value)}
                    placeholder={tr('Xin chào {name}, tôi muốn kết nối với bạn!')}
                    className="flex-1 min-h-0 w-full bg-card border border-input rounded-xl px-3 py-2.5 text-sm text-foreground placeholder-subtle-foreground focus:outline-none focus:border-blue-500 resize-none transition-colors" />
                  <p className="text-[10px] text-muted-foreground text-right flex-shrink-0">{trx('{{count}}/200 ký tự', { count: friendReqMsg.length })}</p>
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
                <div className="flex-shrink-0 border-t border-border pt-3">
                  <p className="text-[11px] font-medium text-muted-foreground mb-2">{trx('<0/> Nhóm mời', { 0: <UsersIcon className="w-4 h-4 inline" /> })}</p>
                  <GroupPicker zaloId={zaloId} inviteGroupIds={inviteGroupIds} onToggle={toggleGroupId} />
                </div>
              )}

              {/* Gắn nhãn khi gửi xong: một dòng gọn, bấm vào mở popup tích nhãn.
                  Chỉ nhãn đã chọn mới hiện ra (dạng pill) để tiết kiệm diện tích.
                  Zalo: chọn được nhãn Local và/hoặc 1 nhãn Zalo — nhãn Zalo sẽ đè nhãn cũ theo chính sách Zalo. */}
              <div className="flex-shrink-0 rounded-xl border border-border bg-muted/30 px-3 py-2">
                <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1">
                  <TagIcon className="w-3.5 h-3.5" /> {tr('Gắn nhãn khi gửi xong')}
                </p>
                <SuccessLabelPicker
                  localLabels={localLabels}
                  zaloLabels={zaloLabels}
                  supportsZalo={supportsZaloLabels}
                  localIds={successLocalLabelIds}
                  zaloIds={successZaloLabelIds}
                  onLocalChange={setSuccessLocalLabelIds}
                  onZaloChange={setSuccessZaloLabelIds}
                />
              </div>
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
              supportsFormatting={zaloCampaign}
              sendOptions={{ order: contentConfig.order ?? 'text_first', combine: !!contentConfig.combine }}
              channel={channel}
            />
          </div>
        </div>

        {/* ── Footer ── */}
        <div className="flex items-center gap-3 px-5 py-3 border-t border-border flex-shrink-0">
          <div className="flex-1 text-[11px] text-muted-foreground">
            {hasMsg && contentConfig.blocks.length > 1 && (
              <span>{trx('{{count}} biến thể · {{v1}}', { count: contentConfig.blocks.length, v1: contentConfig.mode === 'random' ? '🎲 random' : tr('📨 gửi tất cả') })}</span>
            )}
          </div>
          <button onClick={onClose}
            className="px-4 py-2 rounded-xl bg-muted text-foreground/80 text-sm hover:bg-accent transition-colors font-medium">
            {tr('Hủy')}
          </button>
          <button onClick={handleSave} disabled={saving || !isValid()}
            className="px-6 py-2 rounded-xl bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors font-semibold flex items-center gap-2">
            {saving && <Spinner size={3} />}
            {saving ? (editMode ? tr('Đang lưu...') : tr('Đang tạo...')) : (editMode ? tr('Lưu thay đổi') : tr('Tạo chiến dịch'))}
          </button>
        </div>
      </div>
    </div>
  );
}
