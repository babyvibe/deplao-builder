import React, { useMemo, useState } from 'react';
import type { CRMCampaign } from '@/store/crmStore';
import { cn } from '@/lib/cn';
import { showConfirm } from '@/components/common/ConfirmDialog';
import PageLoading from '@/components/common/PageLoading';
import { Button, DropdownMenu, DropdownMenuItem, DropdownMenuSeparator, EmptyState, Input, Select } from '@/components/ui';
import { CampaignIcon, CopyIcon, PauseIcon, PlayIcon, PlusIcon, SearchIcon, TrashIcon } from '@/components/common/icons';
import {
  CAMPAIGN_STATUS_META,
  CAMPAIGN_TYPE_LABEL,
  campaignStatusOf,
  campaignTypeOf,
  formatDay,
  type CampaignStatus,
} from '@/lib/crm/campaignView';
import { CampaignProgressBar, CampaignTypeTile, STATUS_TEXT } from './CampaignParts';

interface CampaignListProps {
  campaigns: CRMCampaign[];
  loading: boolean;
  activeId: number | null;
  onSelect: (id: number) => void;
  onCreate: () => void;
  onDelete: (id: number) => void;
  onClone: (id: number) => void;
  onUpdateStatus: (id: number, status: string) => void;
}

type StatusFilter = 'all' | CampaignStatus;

const STATUS_FILTERS: StatusFilter[] = ['all', 'draft', 'active', 'paused', 'done'];

const PAGE_SIZE = 20;

function MoreDotsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

export default function CampaignList({ campaigns, loading, activeId, onSelect, onCreate, onDelete, onClone, onUpdateStatus }: CampaignListProps) {
  const [search, setSearch] = useState('');
  const [filterStatus, setFilterStatus] = useState<StatusFilter>('all');
  const [page, setPage] = useState(0);

  const counts = useMemo(() => {
    const result: Record<StatusFilter, number> = { all: campaigns.length, draft: 0, active: 0, paused: 0, done: 0 };
    for (const c of campaigns) result[campaignStatusOf(c.status)]++;
    return result;
  }, [campaigns]);

  const filtered = useMemo(() => {
    let list = campaigns;
    if (filterStatus !== 'all') list = list.filter(c => campaignStatusOf(c.status) === filterStatus);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(q));
    }
    return list;
  }, [campaigns, search, filterStatus]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  // Deleting the last campaigns of the last page must not leave an empty page.
  const currentPage = Math.min(page, Math.max(0, totalPages - 1));
  const paged = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  const resetPage = () => setPage(0);

  const confirmDelete = async (c: CRMCampaign) => {
    const ok = await showConfirm({
      title: 'Xóa chiến dịch?',
      message: `"${c.name}" sẽ bị xóa vĩnh viễn cùng toàn bộ dữ liệu gửi. Hành động này không thể hoàn tác.`,
      variant: 'danger',
      confirmText: 'Xóa',
    });
    if (ok) onDelete(c.id);
  };

  return (
    <div className="flex h-full flex-col bg-card">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center justify-between gap-2 px-4 pb-3 pt-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Chiến dịch</h2>
          <p className="text-xs text-muted-foreground">
            {campaigns.length} chiến dịch{counts.active > 0 ? ` · ${counts.active} đang chạy` : ''}
          </p>
        </div>
        <Button size="sm" leftIcon={<PlusIcon className="h-4 w-4" />} onClick={onCreate}>Tạo mới</Button>
      </div>

      {/* Filters */}
      <div className="flex flex-shrink-0 gap-2 border-b border-border px-4 pb-3">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground" />
          <Input value={search} onChange={e => { setSearch(e.target.value); resetPage(); }}
            placeholder="Tìm chiến dịch..." className="h-8 pl-8 text-[13px]" />
        </div>
        <Select value={filterStatus} aria-label="Lọc theo trạng thái"
          onChange={e => { setFilterStatus(e.target.value as StatusFilter); resetPage(); }}
          wrapperClassName="w-32 shrink-0" className={cn('h-8 pl-2.5 pr-8 text-[13px]', filterStatus !== 'all' && 'border-primary/60 text-primary')}>
          {STATUS_FILTERS.map(s => (
            <option key={s} value={s}>{s === 'all' ? 'Tất cả' : CAMPAIGN_STATUS_META[s].label} ({counts[s]})</option>
          ))}
        </Select>
      </div>

      {/* List */}
      <div className="flex-1 space-y-2 overflow-y-auto p-3">
        {loading && <PageLoading variant="skeleton" skeletonVariant="cards" />}

        {!loading && filtered.length === 0 && (
          search || filterStatus !== 'all' ? (
            <EmptyState compact icon={<SearchIcon className="h-6 w-6" />} title="Không tìm thấy chiến dịch" />
          ) : (
            <EmptyState icon={<CampaignIcon className="h-6 w-6" />} title="Chưa có chiến dịch nào"
              description="Gửi tin nhắn, kết bạn hoặc mời vào nhóm hàng loạt, có giãn cách và giới hạn mỗi ngày."
              action={<Button size="sm" leftIcon={<PlusIcon className="h-4 w-4" />} onClick={onCreate}>Tạo chiến dịch đầu tiên</Button>} />
          )
        )}

        {!loading && paged.map(c => {
          const status = campaignStatusOf(c.status);
          const type = campaignTypeOf(c.campaign_type);
          const active = activeId === c.id;
          return (
            <div key={c.id} role="button" tabIndex={0} aria-current={active ? 'true' : undefined}
              onClick={() => onSelect(c.id)}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(c.id); } }}
              className={cn(
                'group flex cursor-pointer gap-3 rounded-xl border p-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                active ? 'border-primary/40 bg-selected' : 'border-border hover:border-border-strong hover:bg-muted',
              )}>
              <CampaignTypeTile type={type} status={status} className="mt-0.5 h-9 w-9 rounded-lg" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-1">
                  <p className="min-w-0 flex-1 truncate pt-0.5 text-[13px] font-medium text-foreground"
                    title={c.created_at ? `${c.name} · tạo ${formatDay(c.created_at)}` : c.name}>
                    {c.name}
                  </p>
                  {/* Stop row selection for the menu trigger and its (portaled) items. */}
                  <div className="-mr-1 shrink-0" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
                    <DropdownMenu align="end" trigger={
                      <button type="button" aria-label="Thao tác chiến dịch"
                        className={cn(
                          'flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition hover:bg-accent hover:text-foreground focus-visible:opacity-100',
                          active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                        )}>
                        <MoreDotsIcon className="h-4 w-4" />
                      </button>
                    }>
                      {status === 'draft' && (
                        <DropdownMenuItem icon={<PlayIcon className="h-4 w-4" />} onSelect={() => onUpdateStatus(c.id, 'active')}>Bắt đầu</DropdownMenuItem>
                      )}
                      {status === 'active' && (
                        <DropdownMenuItem icon={<PauseIcon className="h-4 w-4" />} onSelect={() => onUpdateStatus(c.id, 'paused')}>Tạm dừng</DropdownMenuItem>
                      )}
                      {status === 'paused' && (
                        <DropdownMenuItem icon={<PlayIcon className="h-4 w-4" />} onSelect={() => onUpdateStatus(c.id, 'active')}>Tiếp tục</DropdownMenuItem>
                      )}
                      <DropdownMenuItem icon={<CopyIcon className="h-4 w-4" />} onSelect={() => onClone(c.id)}>Nhân bản</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem destructive icon={<TrashIcon className="h-4 w-4" />} onSelect={() => { void confirmDelete(c); }}>
                        Xóa chiến dịch
                      </DropdownMenuItem>
                    </DropdownMenu>
                  </div>
                </div>
                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className={cn('inline-flex shrink-0 items-center gap-1 font-medium', STATUS_TEXT[status])}>
                    <span className={cn('h-1.5 w-1.5 rounded-full bg-current', status === 'active' && 'animate-pulse')} />
                    {CAMPAIGN_STATUS_META[status].label}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{CAMPAIGN_TYPE_LABEL[type]}</span>
                  <span aria-hidden="true">·</span>
                  <span className="shrink-0 tabular-nums">{c.total_contacts} liên hệ</span>
                </p>
                {c.total_contacts > 0 && (
                  <div className="mt-2 flex items-center gap-2">
                    <CampaignProgressBar total={c.total_contacts} sent={c.sent_count} failed={c.failed_count} className="h-1 flex-1" />
                    <span className="shrink-0 text-[10px] tabular-nums text-subtle-foreground">
                      {c.sent_count}/{c.total_contacts}
                      {c.failed_count > 0 && <span className="text-destructive"> · {c.failed_count} lỗi</span>}
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex flex-shrink-0 items-center justify-between border-t border-border px-3 py-2">
          <Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)} aria-label="Trang trước">‹ Trước</Button>
          <span className="text-xs tabular-nums text-muted-foreground">{currentPage + 1} / {totalPages}</span>
          <Button variant="ghost" size="sm" disabled={currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)} aria-label="Trang sau">Sau ›</Button>
        </div>
      )}
    </div>
  );
}
