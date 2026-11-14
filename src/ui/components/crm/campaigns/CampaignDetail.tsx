import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CRMCampaign } from '@/store/crm/crmStore';
import type { LabelData } from '@/store/app/appStore';
import { useAppStore } from '@/store/app/appStore';
import { useChatStore } from '@/store/chat/chatStore';
import DataAccessor from '@/lib/data/DataAccessor';
import ipc from '@/lib/ipc';
import { cn } from '@/lib/cn';
import { showConfirm } from '@/components/common/ConfirmDialog';
import { Badge, Button, EmptyState, Input, Tooltip } from '@/components/ui';
import {
  AlertIcon, CalendarIcon, ChartIcon, ClockIcon, DownloadIcon, EditIcon, PauseIcon, PlayIcon, PlusIcon,
  RefreshIcon, SearchIcon, TrashIcon, UsersIcon,
} from '@/components/common/icons';
import {
  CAMPAIGN_TYPE_LABEL,
  CONTACT_PARTIAL_META,
  CONTACT_STATUS_META,
  ENGAGEMENT_FILTER_LABEL,
  ENGAGEMENT_LEVEL_META,
  buildCampaignContactsCsv,
  engagementFilterCounts,
  engagementLevelOf,
  isEngagementFilter,
  campaignContactStats,
  campaignScheduledResumeAt,
  campaignDelayRange,
  campaignStatusMeta,
  campaignStatusOf,
  campaignSteps,
  campaignTypeOf,
  contactStatusOf,
  filterCampaignContacts,
  formatDay,
  formatDelayRange,
  formatSentAt,
  hasTextWithImages,
  isCampaignAutoStopped,
  partialFailureOf,
  readContentConfig,
  readMixedConfig,
  withSendOptions,
  type CampaignContactStats,
  type CampaignEngagementView,
  type ContactFilter,
  type EngagementLevel,
} from '@/lib/crm/campaignView';
import { engagementNotes, engagementPercents, formatRate } from '@/lib/analytics/engagementView';
import type { CampaignEngagementReport, EngagementFilter } from '../../../../shared/analytics/messageEngagement';
import TargetSelector from './TargetSelector';
import CampaignCreateModal from './CampaignCreateModal';
import {
  CampaignContentPreview, CampaignProgressBar, CampaignSendOptionsControl, CampaignTypeTile, ContactAvatar,
  type CampaignGroupRef,
} from './CampaignParts';
import type { CampaignSendOptions } from '../../../../shared/crm/campaignSendPlan';
import { stopAfterFailuresLabel } from '../../../../shared/crm/campaignAutoStop';
import type { Channel } from '../../../../configs/channels/channelConfig';
import { tr, appLocale } from '../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

interface LocalLabelItem {
  id: number;
  name: string;
  color: string;
  text_color?: string;
  emoji?: string;
}

interface CampaignDetailProps {
  campaign: CRMCampaign;
  zaloId: string;
  channel?: Channel;
  allLabels: LabelData[];
  localLabels?: LocalLabelItem[];
  localLabelThreadMap?: Record<string, number[]>;
  onStatusChange: (id: number, status: string) => void;
  onAddContacts: (campaignId: number, contacts: any[]) => Promise<void>;
  onUpdate?: (data: CampaignUpdateData) => Promise<void>;
  /** Creates a draft campaign (copies this campaign's content) with only the contacts being filtered → continue sending to people who have seen it… */
  onCreateFromContacts?: (sourceCampaignId: number, contactIds: string[], newName: string) => Promise<void>;
}

/** Everything saveCRMCampaign rewrites — a partial update would reset the missing fields. */
export interface CampaignUpdateData {
  name: string;
  template_message: string;
  friend_request_message: string;
  campaign_type: string;
  mixed_config?: string;
  delay_seconds: number;
  delay_min_seconds?: number;
  delay_max_seconds?: number;
  per_contact_delay_min_seconds?: number;
  per_contact_delay_max_seconds?: number;
  daily_send_limit?: number;
  daily_start_time?: string;
  stop_after_failures?: number;
  stop_strangers_only?: number;
  stop_resume_next_day?: number;
}

/** Rows rendered per "Xem thêm" (See more) step: campaigns can hold thousands of contacts. */
const CONTACT_PAGE = 200;

const CONTACT_FILTERS: Array<{ value: ContactFilter; label: string; count: (stats: CampaignContactStats) => number; optional?: boolean }> = [
  { value: 'all', label: tr('Tất cả'), count: s => s.total },
  { value: 'waiting', label: tr('Chờ gửi'), count: s => s.waiting },
  { value: 'sent', label: tr('Đã gửi'), count: s => s.sent },
  { value: 'failed', label: tr('Lỗi'), count: s => s.failed },
  // Mixed: sent, but with error actions: only shown when there are any
  { value: 'partial', label: tr('Lỗi một phần'), count: s => s.partial, optional: true },
];

function MetaItem({ icon, title, children }: { icon?: React.ReactNode; title?: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={title}>
      {icon && <span className="text-subtle-foreground">{icon}</span>}
      {children}
    </span>
  );
}

function StatTile({ label, value, tone, note }: { label: string; value: number; tone?: 'success' | 'destructive'; note?: string }) {
  return (
    <div className="rounded-lg bg-muted/60 px-3 py-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn(
        'mt-0.5 text-lg font-semibold leading-6 tabular-nums',
        tone === 'success' ? 'text-success' : tone === 'destructive' ? 'text-destructive' : 'text-foreground',
      )}>
        {value.toLocaleString(appLocale())}
        {note && <span className="ml-1.5 text-[11px] font-normal text-info">{note}</span>}
      </p>
    </div>
  );
}

/** One effectiveness metric: a large percentage, count / denominator, and a bar. */
function EngagementTile({ label, percent, count, base, barClass }: {
  label: string; percent: number | null; count: number; base: number; barClass: string;
}) {
  return (
    <div className="rounded-lg bg-muted/60 px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="text-[11px] tabular-nums text-subtle-foreground">
          {count.toLocaleString(appLocale())}/{base.toLocaleString(appLocale())}
        </p>
      </div>
      <p className="mt-0.5 text-lg font-semibold leading-6 tabular-nums text-foreground">{formatRate(percent)}</p>
      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-border/60">
        <div className={cn('h-full rounded-full transition-all', barClass)} style={{ width: `${Math.max(0, Math.min(100, percent ?? 0))}%` }} />
      </div>
    </div>
  );
}

const ContactRow = React.memo(function ContactRow({ contact, engagementLevel, removable, disabled, onRemove }: {
  contact: any;
  /** Sent contacts: the highest effectiveness level (replied / seen / received) instead of the "Đã gửi" (Sent) label. */
  engagementLevel?: EngagementLevel | null;
  removable: boolean;
  disabled: boolean;
  onRemove: (contactId: string) => void;
}) {
  const status = contactStatusOf(contact.status);
  const partialError = partialFailureOf(contact);
  const meta = status === 'sent' && engagementLevel
    ? ENGAGEMENT_LEVEL_META[engagementLevel]
    : partialError ? CONTACT_PARTIAL_META : CONTACT_STATUS_META[status];
  const name = contact.display_name || contact.contact_id || '?';
  const secondary = contact.phone || (contact.contact_id && contact.contact_id !== contact.display_name ? contact.contact_id : '');
  return (
    <li className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/50">
      <ContactAvatar src={contact.avatar} name={name} className="h-8 w-8" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-foreground">{name}</p>
        {secondary && <p className="truncate font-mono text-[11px] text-subtle-foreground">{secondary}</p>}
        {status === 'failed' && contact.error && (
          <p className="mt-0.5 line-clamp-2 text-[11px] text-destructive" title={contact.error}>{contact.error}</p>
        )}
        {partialError && (
          <p className="mt-0.5 line-clamp-2 text-[11px] text-warning" title={partialError}>{partialError}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <Badge size="sm" variant={meta.tone} dot className={status === 'sending' ? 'animate-pulse' : undefined}>{meta.label}</Badge>
        {contact.sent_at > 0 && <span className="text-[11px] tabular-nums text-subtle-foreground">{formatSentAt(contact.sent_at)}</span>}
      </div>
      {removable && (
        <button type="button" onClick={() => onRemove(contact.contact_id)} disabled={disabled}
          aria-label={tr('Xoá khỏi chiến dịch')} title={tr('Xoá khỏi chiến dịch')}
          className="shrink-0 rounded-md p-1.5 text-subtle-foreground opacity-0 transition hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100 disabled:pointer-events-none">
          <TrashIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </li>
  );
});

export default function CampaignDetail({ campaign, zaloId, channel, allLabels, localLabels, localLabelThreadMap, onStatusChange, onAddContacts, onUpdate, onCreateFromContacts }: CampaignDetailProps) {
  const [contacts, setContacts] = useState<any[]>([]);
  /** Campaign the `contacts` array belongs to (avoids showing the previous campaign's rows while switching). */
  const [contactsFor, setContactsFor] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [showTargetSelector, setShowTargetSelector] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ContactFilter>('all');
  const [visibleCount, setVisibleCount] = useState(CONTACT_PAGE);
  const [savingSendOptions, setSavingSendOptions] = useState(false);
  const [creatingFromFilter, setCreatingFromFilter] = useState(false);
  const requestSeq = useRef(0);
  // Effectiveness (received / seen / replied) of sent contacts: read separately, lightweight, refreshed with the "Cập nhật" (Refresh) button
  const [engagement, setEngagement] = useState<CampaignEngagementReport | null>(null);
  const [engagementFor, setEngagementFor] = useState<number | null>(null);
  const [engagementLoading, setEngagementLoading] = useState(false);
  const engagementSeq = useRef(0);

  const loadContacts = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const res = await DataAccessor.getCampaignContacts({ campaignId: campaign.id });
      if (seq !== requestSeq.current) return;
      if (res?.success) {
        setContacts(res.contacts);
        setContactsFor(campaign.id);
        setLoadError(false);
      } else {
        setLoadError(true);
      }
    } catch {
      if (seq === requestSeq.current) setLoadError(true);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [campaign.id]);

  const loadEngagement = useCallback(async () => {
    const seq = ++engagementSeq.current;
    setEngagementLoading(true);
    try {
      const res = await DataAccessor.getCampaignEngagement({ campaignId: campaign.id });
      if (seq !== engagementSeq.current) return;
      if (res?.success) {
        const { success: _ok, ...report } = res;
        setEngagement(report);
        setEngagementFor(campaign.id);
      }
    } catch { /* keep the old figures, retry with the "Cập nhật" (Refresh) button */ } finally {
      if (seq === engagementSeq.current) setEngagementLoading(false);
    }
  }, [campaign.id]);

  // Re-load contacts when campaign object changes (e.g. after adding contacts from parent)
  useEffect(() => { loadContacts(); }, [loadContacts, campaign]);
  // Only sent contacts have effectiveness to read
  const hasSent = (campaign.sent_count || 0) > 0;
  useEffect(() => { if (hasSent) void loadEngagement(); }, [loadEngagement, hasSent, campaign]);

  useEffect(() => { setQuery(''); setFilter('all'); }, [campaign.id]);
  useEffect(() => { setVisibleCount(CONTACT_PAGE); }, [campaign.id, query, filter]);

  // ── Real-time updates from the queue ────────────────────────────────────────────
  useEffect(() => {
    const unsubUpdate = ipc.on?.('crm:queueUpdate', (data: any) => {
      if (data.campaignId !== campaign.id) return;
      setContacts(prev => prev.map(c =>
        c.contact_id === data.contactId
          ? { ...c, status: data.status, sent_at: data.status === 'sent' ? Date.now() : c.sent_at, error: data.error || '' }
          : c
      ));
    });
    const unsubDone = ipc.on?.('crm:campaignDone', (data: any) => {
      if (data.campaignId === campaign.id) { loadContacts(); void loadEngagement(); }
    });
    return () => { unsubUpdate?.(); unsubDone?.(); };
  }, [campaign.id, loadContacts, loadEngagement]);

  const contactsReady = contactsFor === campaign.id;
  const status = campaignStatusOf(campaign.status);
  const type = campaignTypeOf(campaign.campaign_type);
  const editable = status === 'draft' || status === 'paused';
  // Auto-stopped by consecutive errors: the "Tự dừng" (Auto-stopped) label + the reason under the title until Continue is clicked
  const autoStopped = isCampaignAutoStopped(campaign);
  const autoResumeAt = campaignScheduledResumeAt(campaign);
  const statusMeta = campaignStatusMeta(campaign);

  // Live counts from the rows (queue events update them); campaign counters until the rows arrive.
  const stats = useMemo<CampaignContactStats>(() => {
    if (contactsReady) return campaignContactStats(contacts);
    const total = campaign.total_contacts || 0;
    const sent = campaign.sent_count || 0;
    const failed = campaign.failed_count || 0;
    return {
      total, sent, failed,
      partial: 0,
      waiting: Math.max(0, total - sent - failed),
      sending: 0,
      sentToday: campaign.sent_today_count || 0,
      processedPercent: total > 0 ? Math.round(((sent + failed) / total) * 100) : 0,
    };
  }, [contactsReady, contacts, campaign.total_contacts, campaign.sent_count, campaign.failed_count, campaign.sent_today_count]);

  const engagementReady = engagementFor === campaign.id && !!engagement;
  const engagementView = useMemo<CampaignEngagementView | null>(() => {
    if (!engagementReady || !engagement) return null;
    return { byContact: new Map(engagement.items.map(item => [item.contactId, item])), support: engagement.support };
  }, [engagementReady, engagement]);
  const engagementCounts = useMemo(() => engagementFilterCounts(contacts, engagementView), [contacts, engagementView]);
  // The effectiveness filter only means something for campaigns: friend-request / group-invite campaigns only → only "Đã phản hồi" (Replied)
  const engagementFilters = useMemo<EngagementFilter[]>(() => {
    if (!engagementView || stats.sent === 0) return [];
    if (!engagement?.sendsMessage) return ['replied'];
    const list: EngagementFilter[] = ['replied', 'seen_no_reply', 'not_seen'];
    if (engagementView.support.delivered) list.push('not_delivered');
    return list;
  }, [engagementView, engagement?.sendsMessage, stats.sent]);
  // The selected effectiveness filter is no longer usable (campaign changed / not loaded yet) → back to "Tất cả" (All)
  useEffect(() => {
    if (isEngagementFilter(filter) && engagementReady && !engagementFilters.includes(filter)) setFilter('all');
  }, [filter, engagementReady, engagementFilters]);

  const filtered = useMemo(
    () => (contactsReady ? filterCampaignContacts(contacts, filter, query, engagementView) : []),
    [contactsReady, contacts, filter, query, engagementView],
  );
  const visible = filtered.length > visibleCount ? filtered.slice(0, visibleCount) : filtered;

  // Build dedup set: include both contact_id and phone: prefix for phone imports
  // This prevents duplicates when a phone number was previously added as unresolved (phone:...)
  // and later resolved to an actual UID (or vice versa)
  const existingIds = useMemo(() => new Set(contacts.flatMap((c: any) => {
    const ids: string[] = [c.contact_id];
    if (c.phone) ids.push(`phone:${c.phone}`);
    return ids;
  })), [contacts]);

  // ── Content ("Nội dung gửi" (Content sent)) ──────────────────────────────────────────────
  const steps = useMemo(() => campaignSteps(campaign.campaign_type, campaign.mixed_config), [campaign.campaign_type, campaign.mixed_config]);
  const content = useMemo(() => readContentConfig(campaign.template_message), [campaign.template_message]);
  const groupIds = useMemo(() => readMixedConfig(campaign.mixed_config).groupIds, [campaign.mixed_config]);
  // Only subscribe to the account's conversations when there are groups to name.
  const accountContacts = useChatStore(s => (groupIds.length > 0 ? s.contacts[zaloId] : undefined));
  const groups = useMemo<CampaignGroupRef[]>(() => {
    if (groupIds.length === 0) return [];
    const byId = new Map((accountContacts || []).map(c => [c.contact_id, c]));
    return groupIds.map(id => {
      const group = byId.get(id);
      return { id, name: group?.alias || group?.display_name || tr('Nhóm {{id}}', { id }), avatar: group?.avatar_url || '' };
    });
  }, [groupIds, accountContacts]);
  const formatting = !channel || channel === 'zalo';
  const perMessageDelay = useMemo(() => {
    const min = campaign.per_contact_delay_min_seconds || 0;
    const max = campaign.per_contact_delay_max_seconds || 0;
    return min > 0 ? formatDelayRange(min, max > 0 ? max : min) : tr('1 giây');
  }, [campaign.per_contact_delay_min_seconds, campaign.per_contact_delay_max_seconds]);
  const actionSteps = steps.filter(step => !step.fallback).length;
  // Photo + text: order / merge only have an effect when there is a send step and a block with both text and photos.
  const showSendOptions = !!onUpdate && steps.some(step => step.kind === 'message') && hasTextWithImages(content);

  const [delayMin, delayMax] = campaignDelayRange(campaign);
  const dailyLimit = campaign.daily_send_limit || 0;
  const startTime = campaign.daily_start_time || '08:00';
  const dailyLimitReached = status === 'active' && dailyLimit > 0 && stats.sentToday >= dailyLimit;

  // ── Actions ───────────────────────────────────────────────────────────────
  const handleDeleteContact = useCallback(async (contactId: string) => {
    const ok = await showConfirm({
      title: tr('Xoá liên hệ khỏi chiến dịch?'),
      message: tr('Liên hệ này sẽ không nhận tin của chiến dịch nữa.'),
      variant: 'danger',
      confirmText: tr('Xoá'),
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await DataAccessor.deleteCampaignContacts({ campaignId: campaign.id, contactIds: [contactId] });
      await loadContacts();
    } finally {
      setDeleting(false);
    }
  }, [campaign.id, loadContacts]);

  const handleDeleteAllContacts = useCallback(async () => {
    const ok = await showConfirm({
      title: tr('Xoá tất cả {{count}} liên hệ?', { count: contacts.length }),
      message: tr('Toàn bộ danh sách liên hệ của chiến dịch sẽ bị xoá. Hành động này không thể hoàn tác.'),
      variant: 'danger',
      confirmText: tr('Xoá tất cả'),
    });
    if (!ok) return;
    setDeleting(true);
    try {
      await DataAccessor.deleteAllCampaignContacts({ campaignId: campaign.id });
      await loadContacts();
    } finally {
      setDeleting(false);
    }
  }, [campaign.id, contacts.length, loadContacts]);

  const handleExport = useCallback(() => {
    if (contacts.length === 0) return;
    const blob = new Blob(['﻿' + buildCampaignContactsCsv(contacts, engagementView)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lien_he_chien_dich_${campaign.name}_${new Date().toISOString().split('T')[0]}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    useAppStore.getState().showNotification(tr('Đã xuất {{count}} liên hệ ra file CSV', { count: contacts.length }), 'success');
  }, [contacts, campaign.name, engagementView]);

  // Continue sending to the same group of customers (e.g. seen but not replied): new draft campaign, content copied, only the contacts being filtered
  const handleCreateFromFilter = useCallback(async () => {
    if (!onCreateFromContacts || !isEngagementFilter(filter) || filtered.length === 0 || creatingFromFilter) return;
    const label = ENGAGEMENT_FILTER_LABEL[filter];
    const ok = await showConfirm({
      title: tr('Tạo chiến dịch cho {{v1}} liên hệ?', { v1: filtered.length.toLocaleString(appLocale()) }),
      message: tr('Chiến dịch nháp mới chép nội dung chiến dịch này, chỉ gồm các liên hệ "{{label}}". Sửa nội dung rồi bấm Bắt đầu.', { label }),
      confirmText: tr('Tạo chiến dịch'),
      variant: 'info',
    });
    if (!ok) return;
    setCreatingFromFilter(true);
    try {
      await onCreateFromContacts(campaign.id, filtered.map(c => String(c.contact_id)), `${campaign.name} · ${label}`);
    } finally {
      setCreatingFromFilter(false);
    }
  }, [onCreateFromContacts, filter, filtered, creatingFromFilter, campaign.id, campaign.name]);

  const handleSendOptionsChange = async (patch: Partial<CampaignSendOptions>) => {
    if (!onUpdate || !editable || savingSendOptions) return;
    setSavingSendOptions(true);
    try {
      await onUpdate({
        name: campaign.name,
        template_message: withSendOptions(campaign.template_message, patch),
        friend_request_message: campaign.friend_request_message,
        campaign_type: campaign.campaign_type,
        mixed_config: campaign.mixed_config || '{}',
        delay_seconds: campaign.delay_seconds,
        delay_min_seconds: campaign.delay_min_seconds,
        delay_max_seconds: campaign.delay_max_seconds,
        per_contact_delay_min_seconds: campaign.per_contact_delay_min_seconds,
        per_contact_delay_max_seconds: campaign.per_contact_delay_max_seconds,
        daily_send_limit: campaign.daily_send_limit,
        daily_start_time: campaign.daily_start_time,
        stop_after_failures: campaign.stop_after_failures,
        stop_strangers_only: campaign.stop_strangers_only,
        stop_resume_next_day: campaign.stop_resume_next_day,
      });
    } finally {
      setSavingSendOptions(false);
    }
  };

  const handleConfirmTargets = async (selected: any[]) => {
    const toAdd = selected.map(c => ({ contactId: c.contact_id, displayName: c.alias || c.display_name, avatar: c.avatar, phone: c.phone || '' }));
    await onAddContacts(campaign.id, toAdd);
    await loadContacts();
  };

  // ── Render ────────────────────────────────────────────────────────────────
  const renderContactList = () => {
    if (!contactsReady) {
      if (loadError && !loading) {
        return (
          <EmptyState compact icon={<AlertIcon className="h-6 w-6" />} title={tr('Không tải được danh sách liên hệ')}
            action={<Button variant="outline" size="sm" leftIcon={<RefreshIcon className="h-4 w-4" />} onClick={() => loadContacts()}>{tr('Thử lại')}</Button>} />
        );
      }
      return (
        <div className="space-y-1 p-4">
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="flex items-center gap-3 py-1.5">
              <div className="h-8 w-8 shrink-0 animate-pulse rounded-full bg-muted" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
                <div className="h-2.5 w-1/4 animate-pulse rounded bg-muted" />
              </div>
              <div className="h-5 w-14 animate-pulse rounded-md bg-muted" />
            </div>
          ))}
        </div>
      );
    }
    if (contacts.length === 0) {
      return (
        <EmptyState icon={<UsersIcon className="h-6 w-6" />} title={tr('Chưa có liên hệ nào')}
          description={editable ? tr('Thêm liên hệ từ CRM, nhãn hoặc danh sách số điện thoại để chiến dịch có người nhận.') : undefined}
          action={editable ? <Button size="sm" leftIcon={<PlusIcon className="h-4 w-4" />} disabled={!contactsReady || loadError} title={!contactsReady || loadError ? tr('Chưa tải được danh sách liên hệ của chiến dịch — thử lại trước khi thêm') : undefined} onClick={() => setShowTargetSelector(true)}>{tr('Thêm liên hệ')}</Button> : undefined} />
      );
    }
    if (filtered.length === 0) {
      return <EmptyState compact icon={<SearchIcon className="h-6 w-6" />} title={tr('Không có liên hệ phù hợp')} description={tr('Thử từ khoá hoặc bộ lọc khác.')} />;
    }
    return (
      <>
        <ul className="divide-y divide-border/60">
          {visible.map(c => (
            <ContactRow key={c.id ?? c.contact_id} contact={c} removable={editable} disabled={deleting} onRemove={handleDeleteContact}
              engagementLevel={engagementView ? engagementLevelOf(engagementView.byContact.get(String(c.contact_id))) : null} />
          ))}
        </ul>
        {filtered.length > visible.length && (
          <div className="flex justify-center border-t border-border/60 py-3">
            <Button variant="ghost" size="sm" onClick={() => setVisibleCount(n => n + CONTACT_PAGE)}>
              {trx('Xem thêm {{v1}} liên hệ<0>({{v2}}/{{v3}})</0>', { v1: Math.min(CONTACT_PAGE, filtered.length - visible.length).toLocaleString(appLocale()), 0: <span className="text-subtle-foreground" />, v2: visible.length.toLocaleString(appLocale()), v3: filtered.length.toLocaleString(appLocale()) })}
            </Button>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-background">
      {/* ── Header: name, settings, actions, progress ── */}
      <div className="flex-shrink-0 border-b border-border bg-card px-5 py-4">
        <div className="flex items-start gap-3">
          <CampaignTypeTile type={type} status={status} className="h-10 w-10 rounded-xl" iconClassName="h-5 w-5" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="min-w-0 truncate text-base font-semibold text-foreground" title={campaign.name}>{campaign.name}</h3>
              <Badge size="sm" variant={statusMeta.tone} dot>{statusMeta.label}</Badge>
              <Badge size="sm" variant="outline" className="font-normal text-muted-foreground">{CAMPAIGN_TYPE_LABEL[type]}</Badge>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
              <MetaItem icon={<ClockIcon className="h-3.5 w-3.5" />} title={tr('Thời gian chờ ngẫu nhiên giữa hai liên hệ')}>
                {trx('Giãn cách {{v1}}', { v1: formatDelayRange(delayMin, delayMax) })}
              </MetaItem>
              <MetaItem icon={<CalendarIcon className="h-3.5 w-3.5" />}>{trx('Chạy từ {{startTime}} mỗi ngày', { startTime })}</MetaItem>
              <MetaItem icon={<ChartIcon className="h-3.5 w-3.5" />}>
                {dailyLimit > 0 ? tr('Tối đa {{v1}} liên hệ/ngày', { v1: dailyLimit.toLocaleString(appLocale()) }) : tr('Không giới hạn/ngày')}
              </MetaItem>
              <MetaItem icon={<PauseIcon className="h-3.5 w-3.5" />} title={tr('Tạm dừng chiến dịch khi nhiều liên hệ lỗi liên tiếp (tài khoản bị chặn, giới hạn…)')}>
                {stopAfterFailuresLabel(campaign.stop_after_failures, {
                  strangersOnly: formatting && campaign.stop_strangers_only, resumeNextDay: campaign.stop_resume_next_day,
                })}
              </MetaItem>
              {campaign.created_at > 0 && <span className="text-subtle-foreground">{trx('Tạo {{v1}}', { v1: formatDay(campaign.created_at) })}</span>}
            </div>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            {editable && onUpdate && (
              <Button variant="outline" size="sm" leftIcon={<EditIcon className="h-4 w-4" />} onClick={() => setShowEdit(true)}>{tr('Sửa')}</Button>
            )}
            {status === 'draft' && (
              <Button size="sm" leftIcon={<PlayIcon className="h-4 w-4" />} onClick={() => onStatusChange(campaign.id, 'active')}>{tr('Bắt đầu')}</Button>
            )}
            {status === 'active' && (
              <Button variant="secondary" size="sm" leftIcon={<PauseIcon className="h-4 w-4" />} onClick={() => onStatusChange(campaign.id, 'paused')}>{tr('Tạm dừng')}</Button>
            )}
            {status === 'paused' && (
              <Button size="sm" leftIcon={<PlayIcon className="h-4 w-4" />} onClick={() => onStatusChange(campaign.id, 'active')}>{tr('Tiếp tục')}</Button>
            )}
          </div>
        </div>

        {autoStopped && (
          <div role="status" className="mt-3 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertIcon className="mt-px h-4 w-4 shrink-0" />
            <p className="min-w-0 leading-relaxed">
              {trx('<0>Đã tự dừng{{v1}}:</0> {{auto_stop_reason}}. ', { 0: <span className="font-semibold" />, v1: campaign.auto_stopped_at ? tr(' lúc {{v1}}', { v1: formatSentAt(campaign.auto_stopped_at) }) : '', auto_stop_reason: campaign.auto_stop_reason })}
              {autoResumeAt > 0
                ? tr('Tự gửi tiếp lúc {{v1}}, hoặc bấm Tiếp tục để gửi ngay.', { v1: formatSentAt(autoResumeAt) })
                : tr('Kiểm tra tài khoản rồi bấm Tiếp tục.')}
            </p>
          </div>
        )}

        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4">
          <StatTile label={tr('Tổng liên hệ')} value={stats.total} />
          <StatTile label={tr('Đã gửi')} value={stats.sent} tone={stats.sent > 0 ? 'success' : undefined}
            note={stats.partial > 0 ? tr('{{partial}} lỗi một phần', { partial: stats.partial }) : undefined} />
          <StatTile label={tr('Đang chờ')} value={stats.waiting} note={stats.sending > 0 ? tr('{{sending}} đang gửi', { sending: stats.sending }) : undefined} />
          <StatTile label={tr('Lỗi')} value={stats.failed} tone={stats.failed > 0 ? 'destructive' : undefined} />
        </div>

        {stats.total > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span className="min-w-0 truncate">
                {trx('Đã xử lý {{v1}}/{{v2}} liên hệ', { v1: (stats.sent + stats.failed).toLocaleString(appLocale()), v2: stats.total.toLocaleString(appLocale()) })}
                {dailyLimit > 0 && <> {trx('· Hôm nay {{sentToday}}/{{dailyLimit}}', { sentToday: stats.sentToday, dailyLimit })}</>}
                {dailyLimitReached && <span className="text-warning"> {trx('· Đủ giới hạn hôm nay, chạy tiếp lúc {{startTime}} ngày mai', { startTime })}</span>}
              </span>
              <span className="shrink-0 font-semibold tabular-nums text-foreground">{stats.processedPercent}%</span>
            </div>
            <CampaignProgressBar total={stats.total} sent={stats.sent} failed={stats.failed} className="h-2" />
          </div>
        )}

        {engagementReady && engagement && engagement.counts.sent > 0 && (() => {
          const counts = engagement.counts;
          const percents = engagementPercents(counts);
          return (
            <div className="mt-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">{tr('Hiệu quả tin đã gửi')}</p>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" disabled={engagementLoading}
                  leftIcon={<RefreshIcon className={cn('h-3.5 w-3.5', engagementLoading && 'animate-spin')} />}
                  onClick={() => { void loadEngagement(); }}>
                  {tr('Cập nhật')}
                </Button>
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                {engagement.sendsMessage && engagement.support.delivered && (
                  <EngagementTile label={tr('Đã nhận')} percent={percents.delivered} count={counts.delivered} base={counts.deliveredBase} barClass="bg-primary" />
                )}
                {engagement.sendsMessage && (
                  <EngagementTile label={tr('Đã xem')} percent={percents.seen} count={counts.seen} base={counts.sent} barClass="bg-info" />
                )}
                <EngagementTile label={tr('Đã phản hồi')} percent={percents.replied} count={counts.replied} base={counts.sent} barClass="bg-success" />
              </div>
              <p className="text-[11px] leading-relaxed text-subtle-foreground">
                {engagementNotes([engagement.channel], { sendsMessage: engagement.sendsMessage }).join(' ')}
              </p>
            </div>
          );
        })()}
      </div>

      {/* ── Body: content preview + contacts (side by side from xl, stacked + scrollable below) ── */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 xl:flex-row xl:overflow-hidden">
        <section className="flex max-h-72 flex-shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-card xl:max-h-none xl:min-h-0 xl:w-80">
          <header className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
            <h4 className="text-sm font-semibold text-foreground">{tr('Nội dung gửi')}</h4>
            {actionSteps > 1 && <span className="text-[11px] text-muted-foreground">{trx('{{actionSteps}} bước cho mỗi liên hệ', { actionSteps })}</span>}
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <CampaignContentPreview
              steps={steps}
              content={content}
              friendMessage={campaign.friend_request_message || ''}
              groups={groups}
              formatting={formatting}
              channel={channel || 'zalo'}
              perMessageDelay={perMessageDelay}
            />
          </div>
          {showSendOptions && (
            <div className="flex-shrink-0 space-y-2 border-t border-border px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">{tr('Ảnh kèm chữ')}</p>
                {savingSendOptions && <span className="text-[11px] text-muted-foreground">{tr('Đang lưu…')}</span>}
              </div>
              <CampaignSendOptionsControl
                value={content}
                channel={channel || 'zalo'}
                disabled={!editable || savingSendOptions}
                onChange={patch => { void handleSendOptionsChange(patch); }}
              />
              {!editable && <p className="text-[11px] text-subtle-foreground">{tr('Tạm dừng chiến dịch để thay đổi')}</p>}
            </div>
          )}
        </section>

        <section className="flex min-h-[24rem] min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border bg-card xl:min-h-0">
          <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <h4 className="truncate text-sm font-semibold text-foreground">{tr('Danh sách liên hệ')}</h4>
            <Badge size="sm" className="shrink-0">{(contactsReady ? contacts.length : stats.total).toLocaleString(appLocale())}</Badge>
            <div className="flex flex-1 items-center justify-end gap-1">
              {contactsReady && contacts.length > 0 && (
                <Tooltip content={tr('Xuất danh sách ra file CSV')}>
                  <Button variant="ghost" size="icon" aria-label={tr('Xuất danh sách ra file CSV')} onClick={handleExport}
                    className="h-8 w-8 text-muted-foreground hover:text-foreground">
                    <DownloadIcon className="h-4 w-4" />
                  </Button>
                </Tooltip>
              )}
              {editable && contactsReady && contacts.length > 0 && (
                <Tooltip content={tr('Xoá tất cả liên hệ')}>
                  <Button variant="ghost" size="icon" aria-label={tr('Xoá tất cả liên hệ')} disabled={deleting} onClick={handleDeleteAllContacts}
                    className="h-8 w-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
                    <TrashIcon className="h-4 w-4" />
                  </Button>
                </Tooltip>
              )}
              {editable && (
                <Button variant="secondary" size="sm" leftIcon={<PlusIcon className="h-4 w-4" />} disabled={!contactsReady || loadError} title={!contactsReady || loadError ? tr('Chưa tải được danh sách liên hệ của chiến dịch — thử lại trước khi thêm') : undefined} onClick={() => setShowTargetSelector(true)}
                  className="ml-1 shrink-0">
                  {tr('Thêm liên hệ')}
                </Button>
              )}
            </div>
          </header>

          {contactsReady && contacts.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
              <div className="relative w-full sm:w-60">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground" />
                <Input value={query} onChange={e => setQuery(e.target.value)} placeholder={tr('Tìm tên, UID, số điện thoại...')}
                  className="h-8 pl-8 text-[13px]" />
              </div>
              <div className="flex flex-wrap items-center gap-1">
                {CONTACT_FILTERS.filter(option => !option.optional || option.count(stats) > 0 || filter === option.value).map(option => {
                  const active = filter === option.value;
                  return (
                    <button key={option.value} type="button" onClick={() => setFilter(option.value)} aria-pressed={active}
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}>
                      {option.label}
                      <span className={cn('tabular-nums', active ? 'text-primary/80' : 'text-subtle-foreground')}>
                        {option.count(stats).toLocaleString(appLocale())}
                      </span>
                    </button>
                  );
                })}
                {engagementFilters.length > 0 && <span className="mx-1 h-4 w-px bg-border" aria-hidden="true" />}
                {engagementFilters.map(value => {
                  const active = filter === value;
                  return (
                    <button key={value} type="button" onClick={() => setFilter(value)} aria-pressed={active}
                      className={cn(
                        'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors',
                        active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                      )}>
                      {ENGAGEMENT_FILTER_LABEL[value]}
                      <span className={cn('tabular-nums', active ? 'text-primary/80' : 'text-subtle-foreground')}>
                        {engagementCounts[value].toLocaleString(appLocale())}
                      </span>
                    </button>
                  );
                })}
              </div>
              {onCreateFromContacts && isEngagementFilter(filter) && filtered.length > 0 && (
                <Button variant="outline" size="sm" className="ml-auto h-7 text-xs" loading={creatingFromFilter}
                  leftIcon={<PlusIcon className="h-3.5 w-3.5" />} onClick={() => { void handleCreateFromFilter(); }}>
                  {trx('Tạo chiến dịch từ {{v1}} liên hệ', { v1: filtered.length.toLocaleString(appLocale()) })}
                </Button>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto">{renderContactList()}</div>
        </section>
      </div>

      {/* TargetSelector modal */}
      {showTargetSelector && (
        <TargetSelector
          zaloId={zaloId}
          channel={channel}
          allLabels={allLabels}
          localLabels={localLabels}
          localLabelThreadMap={localLabelThreadMap}
          existingContactIds={existingIds}
          onConfirm={handleConfirmTargets}
          onClose={() => setShowTargetSelector(false)}
        />
      )}

      {/* Edit modal */}
      {showEdit && (
        <CampaignCreateModal
          editMode
          zaloId={zaloId}
          channel={channel}
          initialData={{
            name: campaign.name,
            template_message: campaign.template_message,
            friend_request_message: campaign.friend_request_message,
            campaign_type: campaign.campaign_type,
            mixed_config: campaign.mixed_config || '{}',
            delay_seconds: campaign.delay_seconds,
            delay_min_seconds: campaign.delay_min_seconds,
            delay_max_seconds: campaign.delay_max_seconds,
            per_contact_delay_min_seconds: campaign.per_contact_delay_min_seconds,
            per_contact_delay_max_seconds: campaign.per_contact_delay_max_seconds,
            daily_send_limit: campaign.daily_send_limit,
            daily_start_time: campaign.daily_start_time,
            stop_after_failures: campaign.stop_after_failures,
            stop_strangers_only: campaign.stop_strangers_only,
            stop_resume_next_day: campaign.stop_resume_next_day,
          }}
          onClose={() => setShowEdit(false)}
          onSave={async (data) => {
            await onUpdate?.(data);
            setShowEdit(false);
          }}
        />
      )}
    </div>
  );
}
