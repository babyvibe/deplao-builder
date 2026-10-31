/**
 * Shared pieces of the campaign screens (CampaignList + CampaignDetail):
 * type icon / status tile, stacked progress bar, avatar, and the read-only
 * "Nội dung gửi" preview (steps → message variants, friend request, groups).
 * Data parsing lives in `@/lib/crm/campaignView` (pure, unit-tested).
 */
import React, { useMemo, useState } from 'react';
import { cn } from '@/lib/cn';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { Badge, Checkbox } from '@/components/ui';
import { ChatIcon, ImageIcon, RepeatIcon, ShuffleIcon, UserPlusIcon, UsersIcon } from '@/components/common/icons';
import {
  TEMPLATE_VARIABLE_HINT,
  captionText,
  hasMarkupStyles,
  hasTextWithImages,
  isEmptyBlock,
  previewBlockPlan,
  tokenizeTemplate,
  type CampaignStatus,
  type CampaignStep,
  type CampaignType,
  type ContentBlock,
  type ContentConfig,
  type TemplateSegment,
} from '@/lib/crm/campaignView';
import { COMBINE_FALLBACK_LABEL, type CampaignSendOptions } from '../../../../shared/crm/campaignSendPlan';

// ── Type icon + status tile ──────────────────────────────────────────────────

const TYPE_ICON: Record<CampaignType, React.ComponentType<{ className?: string }>> = {
  message: ChatIcon,
  friend_request: UserPlusIcon,
  invite_to_group: UsersIcon,
  mixed: ShuffleIcon,
};

/** Tile colour follows the status, the icon follows the type. */
export const STATUS_TILE: Record<CampaignStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  active: 'bg-success/15 text-success',
  paused: 'bg-warning/15 text-warning',
  done: 'bg-primary/10 text-primary',
};

/** Text colour for an inline status label ("● Đang chạy"). */
export const STATUS_TEXT: Record<CampaignStatus, string> = {
  draft: 'text-muted-foreground',
  active: 'text-success',
  paused: 'text-warning',
  done: 'text-primary',
};

export function CampaignTypeTile({ type, status, className, iconClassName }: {
  type: CampaignType;
  status: CampaignStatus;
  className?: string;
  iconClassName?: string;
}) {
  const Icon = TYPE_ICON[type];
  return (
    <span className={cn('flex shrink-0 items-center justify-center', STATUS_TILE[status], className)} aria-hidden="true">
      <Icon className={iconClassName ?? 'h-4 w-4'} />
    </span>
  );
}

// ── Progress ─────────────────────────────────────────────────────────────────

/** Stacked bar: sent (success) then failed (destructive) over the total. */
export function CampaignProgressBar({ total, sent, failed, className }: {
  total: number;
  sent: number;
  failed: number;
  className?: string;
}) {
  const width = (count: number) => `${total > 0 ? Math.min(100, (count / total) * 100) : 0}%`;
  return (
    <div
      className={cn('flex overflow-hidden rounded-full bg-muted', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={sent + failed}
    >
      <div className="h-full bg-success transition-[width] duration-500" style={{ width: width(sent) }} />
      <div className="h-full bg-destructive transition-[width] duration-500" style={{ width: width(failed) }} />
    </div>
  );
}

// ── Avatar ───────────────────────────────────────────────────────────────────

export function ContactAvatar({ src, name, className }: { src?: string; name: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  const initial = (name || '?').trim().charAt(0).toUpperCase() || '?';
  if (src && !failed) {
    return (
      <img src={src} alt="" loading="lazy" onError={() => setFailed(true)}
        className={cn('shrink-0 rounded-full object-cover', className)} />
    );
  }
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-full bg-accent text-xs font-semibold text-foreground/80', className)}>
      {initial}
    </span>
  );
}

// ── Template text ────────────────────────────────────────────────────────────

function segmentStyle(segment: TemplateSegment): React.CSSProperties | undefined {
  const style: React.CSSProperties = {};
  if (segment.bold) style.fontWeight = 700;
  if (segment.italic) style.fontStyle = 'italic';
  const decoration = [segment.underline && 'underline', segment.strike && 'line-through'].filter(Boolean).join(' ');
  if (decoration) style.textDecoration = decoration;
  if (segment.color) style.color = segment.color;
  if (segment.size === 'big') style.fontSize = '1.15em';
  if (segment.size === 'small') style.fontSize = '0.85em';
  return Object.keys(style).length > 0 ? style : undefined;
}

/** Template with Zalo markup applied (when `formatting`) and `{name}` / `{userId}` as chips. */
export function TemplateText({ text, formatting, className }: { text: string; formatting: boolean; className?: string }) {
  const segments = useMemo(() => tokenizeTemplate(text, { formatting }), [text, formatting]);
  if (segments.length === 0) return null;
  return (
    <span className={cn('whitespace-pre-wrap break-words', className)}>
      {segments.map((segment, index) => (segment.variable ? (
        <span key={index} title={`${TEMPLATE_VARIABLE_HINT[segment.variable]} — thay khi gửi`}
          className="mx-px rounded bg-primary/15 px-1 font-medium text-primary" style={segmentStyle(segment)}>
          {segment.text}
        </span>
      ) : (
        <span key={index} style={segmentStyle(segment)}>{segment.text}</span>
      )))}
    </span>
  );
}

// ── Content preview ──────────────────────────────────────────────────────────

function ImageThumb({ path }: { path: string }) {
  const [failed, setFailed] = useState(false);
  const fileName = path.split(/[\\/]/).pop() || path;
  return (
    <div title={fileName} className="h-14 w-14 shrink-0 overflow-hidden rounded-md border border-border bg-muted">
      {failed ? (
        <div className="flex h-full w-full items-center justify-center text-subtle-foreground">
          <ImageIcon className="h-5 w-5" />
        </div>
      ) : (
        <img src={toLocalMediaUrl(path)} alt="" loading="lazy" onError={() => setFailed(true)} className="h-full w-full object-cover" />
      )}
    </div>
  );
}

/** One block in the order the queue sends it (chữ / ảnh, or ảnh + chữ in one message). */
function MessageBlock({ block, formatting, channel, options }: {
  block: ContentBlock;
  formatting: boolean;
  channel: string;
  options: CampaignSendOptions;
}) {
  if (isEmptyBlock(block)) {
    return (
      <div className="rounded-lg border border-dashed border-warning/50 px-3 py-2 text-xs text-warning">
        Nội dung trống — liên hệ nhận biến thể này sẽ không có gì để gửi
      </div>
    );
  }
  const plan = previewBlockPlan(block, channel, options);
  const combined = plan.steps.some(step => step.kind === 'captioned');
  return (
    <div className="space-y-1.5">
      {plan.steps.map((step, index) => {
        if (step.kind === 'text') {
          return (
            <div key={`text-${index}`} className="rounded-lg border border-bubble-out-border bg-bubble-out px-3 py-2 text-[13px] leading-relaxed text-foreground">
              <TemplateText text={block.text} formatting={formatting} />
            </div>
          );
        }
        if (step.kind === 'images') {
          return (
            <div key={`images-${index}`} className="flex flex-wrap gap-1.5">
              {step.images.map((path, i) => <ImageThumb key={`${path}-${i}`} path={path} />)}
            </div>
          );
        }
        return (
          <div key={`captioned-${index}`} className="overflow-hidden rounded-lg border border-bubble-out-border bg-bubble-out">
            <div className="flex flex-wrap gap-1 p-1.5 pb-0">
              {step.images.map((path, i) => <ImageThumb key={`${path}-${i}`} path={path} />)}
            </div>
            <div className="px-3 py-2 text-[13px] leading-relaxed text-foreground">
              {/* Chú thích ảnh: Zalo bỏ định dạng, Telegram gửi nguyên văn */}
              <TemplateText text={captionText(block.text, channel)} formatting={false} />
            </div>
          </div>
        );
      })}
      {combined && channel === 'zalo' && hasMarkupStyles(block.text) && (
        <p className="text-[11px] text-subtle-foreground">Mô tả ảnh trên Zalo không giữ định dạng (đậm, màu…)</p>
      )}
      {plan.fallback && <p className="text-[11px] text-warning">{COMBINE_FALLBACK_LABEL[plan.fallback]}</p>}
      {block.tagAll && (
        <Badge size="sm" variant="outline" className="font-normal text-muted-foreground">
          Tag @{block.tagAllText || 'all'} khi gửi vào nhóm
        </Badge>
      )}
    </div>
  );
}

function MessageVariants({ content, formatting, channel, perMessageDelay }: {
  content: ContentConfig;
  formatting: boolean;
  channel: string;
  perMessageDelay?: string;
}) {
  const { blocks, mode } = content;
  if (blocks.length === 0) return <p className="text-xs italic text-subtle-foreground">Chưa có nội dung</p>;
  if (blocks.length === 1) return <MessageBlock block={blocks[0]} formatting={formatting} channel={channel} options={content} />;
  return (
    <div className="space-y-3">
      <p className="flex items-start gap-1.5 text-[11px] leading-4 text-muted-foreground">
        {mode === 'random'
          ? <ShuffleIcon className="mt-px h-3.5 w-3.5 shrink-0" />
          : <RepeatIcon className="mt-px h-3.5 w-3.5 shrink-0" />}
        {mode === 'random'
          ? `Mỗi liên hệ nhận ngẫu nhiên 1 trong ${blocks.length} biến thể`
          : `Mỗi liên hệ nhận lần lượt cả ${blocks.length} tin${perMessageDelay ? `, cách nhau ${perMessageDelay}` : ''}`}
      </p>
      {blocks.map((block, index) => (
        <div key={`${block.id}-${index}`}>
          <p className="mb-1 text-[11px] font-medium text-subtle-foreground">
            {mode === 'random' ? `Biến thể ${index + 1}` : `Tin ${index + 1}`}
          </p>
          <MessageBlock block={block} formatting={formatting} channel={channel} options={content} />
        </div>
      ))}
    </div>
  );
}

// ── Image options (thứ tự chữ / ảnh, gộp ảnh + chữ) ─────────────────────────

const ORDER_OPTIONS: Array<{ value: CampaignSendOptions['order']; label: string }> = [
  { value: 'text_first', label: 'Chữ trước' },
  { value: 'images_first', label: 'Ảnh trước' },
];

/** Checkbox options of a campaign: order of text / images and "gộp ảnh + chữ thành 1 tin". */
export function CampaignSendOptionsControl({ value, channel = 'zalo', disabled, onChange }: {
  value: CampaignSendOptions;
  channel?: string;
  disabled?: boolean;
  onChange: (patch: Partial<CampaignSendOptions>) => void;
}) {
  const telegram = channel === 'telegram_user' || channel === 'telegram_bot';
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-muted-foreground">Gửi trước</span>
        <div className="inline-flex rounded-md bg-muted p-0.5" role="radiogroup" aria-label="Gửi chữ hay ảnh trước">
          {ORDER_OPTIONS.map(option => {
            const active = value.order === option.value;
            return (
              <button key={option.value} type="button" role="radio" aria-checked={active} disabled={disabled}
                onClick={() => { if (!active) onChange({ order: option.value }); }}
                className={cn(
                  'h-7 rounded px-2.5 text-xs font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
                  active ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                )}>
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
      <Checkbox
        checked={value.combine}
        disabled={disabled}
        onCheckedChange={combine => onChange({ combine })}
        label={<span className="text-xs font-medium">Gộp ảnh + chữ thành 1 tin</span>}
        description={(
          <span className="text-[11px] leading-4">
            {telegram
              ? 'Chữ thành chú thích của ảnh; nhiều ảnh gửi thành album. Chữ dài quá 1024 ký tự thì gửi riêng.'
              : 'Chữ thành mô tả của ảnh. Zalo chỉ hỗ trợ khi có 1 ảnh (jpg, png, webp) và không giữ định dạng chữ.'}
            {value.combine && ' Không gộp được thì gửi riêng theo thứ tự ở trên.'}
          </span>
        )}
      />
    </div>
  );
}

export interface CampaignGroupRef { id: string; name: string; avatar?: string; }

function InviteGroups({ groups }: { groups: CampaignGroupRef[] }) {
  if (groups.length === 0) {
    return <p className="text-xs text-warning">Chưa chọn nhóm — bước này sẽ bị bỏ qua</p>;
  }
  const shown = groups.slice(0, 12);
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        {shown.map(group => (
          <span key={group.id} title={group.id}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-muted/50 py-0.5 pl-0.5 pr-2.5 text-xs text-foreground">
            <ContactAvatar src={group.avatar} name={group.name} className="h-5 w-5 text-[10px]" />
            <span className="truncate">{group.name}</span>
          </span>
        ))}
        {groups.length > shown.length && (
          <span className="self-center text-xs text-muted-foreground">+{groups.length - shown.length} nhóm</span>
        )}
      </div>
      <p className="text-[11px] text-subtle-foreground">Chỉ mời được người đã là bạn bè</p>
    </div>
  );
}

function FriendRequestNote({ text }: { text: string }) {
  if (!text.trim()) return <p className="text-xs italic text-subtle-foreground">Không có lời nhắn kèm</p>;
  return (
    <div className="rounded-lg border border-dashed border-border-strong bg-muted/40 px-3 py-2 text-[13px] leading-relaxed text-foreground">
      {/* The queue sends the friend-request note as plain text (no Zalo markup). */}
      <TemplateText text={text} formatting={false} />
    </div>
  );
}

const STEP_META: Record<CampaignStep['kind'], { icon: React.ComponentType<{ className?: string }>; title: string }> = {
  message: { icon: ChatIcon, title: 'Gửi tin nhắn' },
  friend_request: { icon: UserPlusIcon, title: 'Gửi lời mời kết bạn' },
  invite: { icon: UsersIcon, title: 'Mời vào nhóm' },
};

export interface CampaignContentPreviewProps {
  steps: CampaignStep[];
  content: ContentConfig;
  friendMessage: string;
  groups: CampaignGroupRef[];
  /** Zalo markup is rendered only for Zalo campaigns (Telegram sends brackets literally). */
  formatting: boolean;
  /** 'zalo' | 'telegram_user' | 'telegram_bot' — decides how text + images are combined. */
  channel?: string;
  /** Formatted delay between the messages sent to one contact. */
  perMessageDelay?: string;
}

/** Read-only "what each contact receives", one timeline entry per queue step. */
export function CampaignContentPreview({ steps, content, friendMessage, groups, formatting, channel = 'zalo', perMessageDelay }: CampaignContentPreviewProps) {
  const multiStep = steps.length > 1;
  const imageOptionsApply = hasTextWithImages(content);
  let stepNumber = 0;
  return (
    <ol className="space-y-5">
      {steps.map((step, index) => {
        const meta = STEP_META[step.kind];
        const Icon = meta.icon;
        if (!step.fallback) stepNumber += 1;
        const isLast = index === steps.length - 1;
        return (
          <li key={`${step.kind}-${index}`} className="relative pl-10">
            {!isLast && <span aria-hidden="true" className="absolute bottom-[-1.25rem] left-[0.9rem] top-8 w-px bg-border" />}
            <span className={cn(
              'absolute left-0 top-0 flex h-7 w-7 items-center justify-center rounded-full',
              step.fallback ? 'border border-dashed border-border-strong bg-card text-muted-foreground' : 'bg-primary/10 text-primary',
            )}>
              <Icon className="h-3.5 w-3.5" />
            </span>
            <div className="mb-2 min-h-7">
              {(multiStep || step.fallback) && (
                <p className="text-[10px] font-semibold uppercase tracking-wide text-subtle-foreground">
                  {step.fallback ? 'Dự phòng' : `Bước ${stepNumber}`}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className={cn('text-[13px] font-semibold text-foreground', !(multiStep || step.fallback) && 'leading-7')}>
                  {meta.title}
                  {step.kind === 'invite' && groups.length > 0 ? ` (${groups.length} nhóm)` : ''}
                </p>
                {step.kind === 'message' && content.blocks.length > 1 && (
                  <Badge size="sm" variant="primary">
                    {content.mode === 'random' ? `${content.blocks.length} biến thể` : `${content.blocks.length} tin`}
                  </Badge>
                )}
                {step.kind === 'message' && imageOptionsApply && content.combine && (
                  <Badge size="sm" variant="info">Gộp ảnh + chữ</Badge>
                )}
                {step.kind === 'message' && imageOptionsApply && content.order === 'images_first' && (
                  <Badge size="sm">Ảnh trước</Badge>
                )}
              </div>
              {step.fallback && (
                <p className="mt-0.5 text-[11px] text-muted-foreground">Chỉ gửi khi người nhận chặn tin nhắn từ người lạ</p>
              )}
            </div>
            {step.kind === 'message' && (
              <MessageVariants content={content} formatting={formatting} channel={channel} perMessageDelay={perMessageDelay} />
            )}
            {step.kind === 'friend_request' && <FriendRequestNote text={friendMessage} />}
            {step.kind === 'invite' && <InviteGroups groups={groups} />}
          </li>
        );
      })}
    </ol>
  );
}
