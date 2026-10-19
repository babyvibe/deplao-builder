/**
 * Tham gia nhóm bằng link (Zalo zalo.me/g/…, Telegram t.me/… / @tên). Dán link → tự nhận kênh,
 * tự chọn tài khoản cùng kênh, xem trước nhóm rồi mới tham gia.
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { AccountInfo } from '@/store/accountStore';
import ipc, { buildZaloAuth } from '@/lib/ipc';
import { toLocalMediaUrl } from '@/lib/localMedia';
import { classifyZaloJoinResult } from '@/lib/zaloJoinGroupResult';
import {
  Badge, Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Input,
} from '@/components/ui';
import { UsersIcon } from '@/components/common/icons';
import { groupLinkAccountChannels, parseGroupLink, type GroupLinkTarget } from '../../../../shared/groupLinks';
import { QuickAccountPicker } from './QuickAccountPicker';
import {
  accountChannel, pickAccountForLink, type OpenQuickConversation, type QuickAccountEntry,
} from './quickActions';

interface LinkPreview {
  title: string;
  avatar?: string;
  membersCount?: number;
  about?: string;
  isChannel?: boolean;
  alreadyMember?: boolean;
  requestNeeded?: boolean;
  /** Nhóm đã biết id (Zalo luôn có; Telegram khi nhóm công khai / đã thấy). */
  threadId?: string;
}

type JoinResult =
  | { status: 'joined' | 'already'; message: string; threadId?: string; title?: string }
  | { status: 'pending' | 'error'; message: string };

async function previewLink(account: AccountInfo, target: GroupLinkTarget, link: string): Promise<{ preview?: LinkPreview; error?: string }> {
  if (target.channel === 'zalo') {
    const res: any = await ipc.zalo?.getGroupLinkInfo({ auth: buildZaloAuth(account, account.zalo_id), link: target.link, memberPage: 1 });
    const data = res?.response;
    if (!res?.success || !data?.groupId) return { error: res?.error || 'Không đọc được thông tin nhóm từ link này' };
    return {
      preview: {
        title: data.name || 'Nhóm Zalo',
        avatar: data.fullAvt || data.avt || '',
        membersCount: Number(data.totalMember || data.currentMems?.length || 0) || undefined,
        about: data.desc || undefined,
        threadId: String(data.groupId),
      },
    };
  }
  if (target.channel === 'telegram') {
    const res = await ipc.telegramUser?.previewJoinLink({ accountId: account.zalo_id, link });
    if (!res?.success) return { error: res?.error || 'Không đọc được thông tin nhóm từ link này' };
    return {
      preview: {
        title: res.title || 'Nhóm Telegram', membersCount: res.membersCount, about: res.about, isChannel: res.isChannel,
        alreadyMember: res.alreadyMember, requestNeeded: res.requestNeeded, threadId: res.chatId,
      },
    };
  }
  return { error: 'Facebook chưa hỗ trợ tham gia nhóm bằng link' };
}

async function joinLink(account: AccountInfo, target: GroupLinkTarget, link: string, preview: LinkPreview | null): Promise<JoinResult> {
  if (target.channel === 'zalo') {
    const res: any = await ipc.zalo?.joinGroupLink({ auth: buildZaloAuth(account, account.zalo_id), link: target.link });
    // Chờ duyệt (240) nằm trong `response` → trước đây báo "Đã tham gia nhóm" (lib/zaloJoinGroupResult)
    const join = classifyZaloJoinResult(res);
    let threadId = preview?.threadId;
    if (!threadId) threadId = (await previewLink(account, target, link)).preview?.threadId;
    if (join.outcome === 'already') return { status: 'already', message: 'Bạn đã là thành viên của nhóm này', threadId, title: preview?.title };
    if (join.outcome === 'full') return { status: 'error', message: 'Nhóm đã đủ số thành viên tối đa' };
    if (join.outcome === 'pending') {
      return { status: 'pending', message: 'Nhóm bật duyệt thành viên — đã gửi yêu cầu, chờ quản trị viên duyệt' };
    }
    if (join.outcome === 'error') return { status: 'error', message: join.error || `Không tham gia được nhóm${join.code ? ` (mã ${join.code})` : ''}` };
    return { status: 'joined', message: 'Đã tham gia nhóm', threadId, title: preview?.title };
  }
  if (target.channel === 'telegram') {
    const res = await ipc.telegramUser?.joinByLink({ accountId: account.zalo_id, link });
    if (!res?.success) return { status: 'error', message: res?.error || 'Không tham gia được nhóm' };
    if (res.requested) return { status: 'pending', message: 'Nhóm cần quản trị viên duyệt — đã gửi yêu cầu tham gia' };
    return {
      status: res.already ? 'already' : 'joined',
      message: res.already ? 'Bạn đã là thành viên của nhóm này' : 'Đã tham gia nhóm',
      threadId: res.chatId, title: res.title || preview?.title,
    };
  }
  return { status: 'error', message: 'Facebook chưa hỗ trợ tham gia nhóm bằng link' };
}

export default function QuickJoinLinkDialog({ entries, initialAccountId, disabledReason, onClose, onOpenConversation }: {
  entries: QuickAccountEntry<AccountInfo>[];
  initialAccountId: string | null;
  disabledReason: (account: AccountInfo) => string | null;
  onClose: () => void;
  onOpenConversation: OpenQuickConversation;
}) {
  const [link, setLink] = useState('');
  const [accountId, setAccountId] = useState<string | null>(initialAccountId);
  const [preview, setPreview] = useState<LinkPreview | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [joining, setJoining] = useState(false);
  const [result, setResult] = useState<JoinResult | null>(null);
  const previewSeq = useRef(0);

  const target = useMemo(() => parseGroupLink(link), [link]);
  const eligible = useMemo(() => entries.filter(entry => !disabledReason(entry.account)), [entries, disabledReason]);
  const linkChannels = groupLinkAccountChannels(target);
  // Có link: chỉ cho chọn tài khoản cùng kênh với link.
  const pickerEntries = useMemo(
    () => (linkChannels.length ? entries.filter(entry => linkChannels.includes(accountChannel(entry.account))) : entries),
    [entries, linkChannels.join(',')],
  );
  const account = entries.find(entry => entry.account.zalo_id === accountId)?.account || null;
  const accountMatches = !!account && linkChannels.includes(accountChannel(account)) && !disabledReason(account);

  // Đổi link sang kênh khác → tự chọn tài khoản cùng kênh (giữ tài khoản đang chọn nếu hợp).
  useEffect(() => {
    if (!target) return;
    const picked = pickAccountForLink(target, eligible.map(entry => entry.account), accountId);
    if (picked && picked.zalo_id !== accountId) setAccountId(picked.zalo_id);
  }, [target?.channel]);

  // Xem trước (chờ người dùng dán xong).
  useEffect(() => {
    setPreview(null);
    setPreviewError('');
    setResult(null);
    if (!target || !account || !accountMatches) return undefined;
    const seq = ++previewSeq.current;
    const timer = window.setTimeout(async () => {
      setPreviewing(true);
      try {
        const res = await previewLink(account, target, link.trim());
        if (seq !== previewSeq.current) return;
        if (res.preview) setPreview(res.preview);
        else setPreviewError(res.error || '');
      } catch (err: any) {
        if (seq === previewSeq.current) setPreviewError(err?.message || 'Không xem trước được link');
      } finally {
        if (seq === previewSeq.current) setPreviewing(false);
      }
    }, 400);
    return () => window.clearTimeout(timer);
  }, [link, account?.zalo_id, accountMatches]);

  const join = async () => {
    if (!target || !account || !accountMatches || joining) return;
    setJoining(true);
    try {
      setResult(await joinLink(account, target, link.trim(), preview));
    } catch (err: any) {
      setResult({ status: 'error', message: err?.message || 'Không tham gia được nhóm' });
    } finally {
      setJoining(false);
    }
  };

  const openThreadId = result && (result.status === 'joined' || result.status === 'already')
    ? result.threadId
    : preview?.alreadyMember ? preview.threadId : undefined;
  const openGroup = () => {
    if (!account || !openThreadId) return;
    onOpenConversation(account.zalo_id, openThreadId, 1, {
      display_name: (result && 'title' in result && result.title) || preview?.title,
      avatar_url: preview?.avatar,
      channel: accountChannel(account),
    });
    onClose();
  };

  const linkHint = !link.trim()
    ? 'Hỗ trợ link nhóm Zalo (zalo.me/g/…) và Telegram (t.me/…, @tên_nhóm)'
    : !target
      ? 'Không nhận ra link — dán link nhóm Zalo hoặc Telegram'
      : target.channel === 'facebook'
        ? 'Facebook chưa hỗ trợ tham gia nhóm bằng link'
        : '';

  return (
    <Dialog open onOpenChange={next => { if (!next && !joining) onClose(); }} size="md">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle>Tham gia nhóm bằng link</DialogTitle>
          <DialogDescription>Dán link mời, xem trước nhóm rồi tham gia</DialogDescription>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-3">
        <div className="space-y-1.5">
          <label htmlFor="quick-join-link" className="text-xs font-medium text-muted-foreground">Link nhóm</label>
          <Input id="quick-join-link" autoFocus value={link} onChange={e => setLink(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void join(); }}
            placeholder="https://zalo.me/g/… · https://t.me/… · @ten_nhom" invalid={!!link.trim() && (!target || target.channel === 'facebook')} />
          {linkHint && <p className={!link.trim() ? 'text-[11px] text-subtle-foreground' : 'text-[11px] text-destructive'}>{linkHint}</p>}
        </div>

        {target && target.channel !== 'facebook' && (
          pickerEntries.length === 0 ? (
            <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
              Chưa có tài khoản {target.channel === 'zalo' ? 'Zalo' : 'Telegram'} nào để tham gia nhóm này
            </p>
          ) : (
            <QuickAccountPicker entries={pickerEntries} value={accountId} disabledReason={disabledReason}
              onChange={next => setAccountId(next.zalo_id)} label="Tham gia bằng tài khoản" />
          )
        )}

        {previewing && <p className="text-xs text-muted-foreground">Đang đọc thông tin nhóm…</p>}
        {previewError && !previewing && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{previewError}</p>}
        {preview && !previewing && (
          <div className="flex gap-3 rounded-xl border border-border bg-muted/30 p-3">
            {preview.avatar
              ? <img src={toLocalMediaUrl(preview.avatar)} alt="" className="h-12 w-12 shrink-0 rounded-full object-cover" />
              : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><UsersIcon className="h-5 w-5" /></span>}
            <div className="min-w-0 flex-1 space-y-1">
              <p className="truncate text-sm font-semibold text-foreground">{preview.title}</p>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                {preview.membersCount ? <span>{preview.membersCount.toLocaleString('vi-VN')} thành viên</span> : null}
                {preview.isChannel && <Badge size="sm">Kênh</Badge>}
                {preview.requestNeeded && <Badge size="sm" variant="warning">Cần duyệt</Badge>}
                {preview.alreadyMember && <Badge size="sm" variant="success" dot>Đã tham gia</Badge>}
              </div>
              {preview.about && <p className="line-clamp-3 whitespace-pre-wrap text-xs text-muted-foreground">{preview.about}</p>}
            </div>
          </div>
        )}

        {result && (
          <p role="status" className={
            result.status === 'error' ? 'rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive'
              : result.status === 'pending' ? 'rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning'
                : 'rounded-lg bg-success/10 px-3 py-2 text-xs text-success'
          }>
            {result.message}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={joining}>Đóng</Button>
        {openThreadId ? (
          <Button onClick={openGroup}>Mở nhóm</Button>
        ) : (
          <Button onClick={() => void join()} loading={joining}
            disabled={!target || !accountMatches || result?.status === 'pending' || joining}>
            {preview?.requestNeeded ? 'Gửi yêu cầu tham gia' : 'Tham gia'}
          </Button>
        )}
      </DialogFooter>
    </Dialog>
  );
}
