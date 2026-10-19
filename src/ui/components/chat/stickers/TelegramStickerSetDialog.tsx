/**
 * Popup bộ sticker Telegram (bấm sticker trong chat, "⋯" ở bảng sticker, kết quả tìm bộ) — như Telegram: xem cả bộ,
 * "Thêm N sticker" vào tài khoản (hiện ở bảng sticker mọi app Telegram) hoặc gỡ; bấm 1 sticker = gửi vào hội thoại
 * đang mở. `TelegramStickerSetHost` đặt 1 lần trong khung chat, mở bằng openTelegramStickerSet().
 */
import React from 'react';
import { Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui';
import { LinkIcon } from '@/components/common/icons';
import { useAppStore } from '@/store/appStore';
import {
  closeTelegramStickerSet,
  getLoadedStickerSet,
  loadStickerSet,
  loadStickerSetOfMessage,
  sendTelegramStickerItem,
  setStickerSetInstalled,
  useTelegramStickerData,
  useTelegramStickerSetModal,
  type LoadedStickerSet,
  type StickerSetModalRequest,
  type TelegramStickerItem,
} from '@/lib/chat/telegramStickerStore';
import { InViewRootContext } from '@/lib/media/inView';
import { TelegramStickerTile } from './TelegramStickerTile';
import { PanelMessage } from './TelegramStickerPanel';

export function TelegramStickerSetHost() {
  const request = useTelegramStickerSetModal();
  if (!request) return null;
  return <TelegramStickerSetDialog request={request} onClose={closeTelegramStickerSet} />;
}

function TelegramStickerSetDialog({ request, onClose }: { request: StickerSetModalRequest; onClose: () => void }) {
  useTelegramStickerData();
  const [setId, setSetId] = React.useState<string>('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [sending, setSending] = React.useState('');
  // Khung cuộn của lưới: ô sticker đo "đang hiện" theo khung này (bộ 120 sticker chỉ tải phần đang thấy)
  const [bodyEl, setBodyEl] = React.useState<HTMLDivElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setSetId('');
    setError('');
    (async () => {
      let result: LoadedStickerSet | { error: string } | null = null;
      if (request.ref) result = await loadStickerSet(request.accountId, request.ref);
      // Tin cũ / thông tin bộ hết hạn → hỏi lại Telegram theo tin
      if ((!result || 'error' in result) && request.message) {
        result = await loadStickerSetOfMessage(request.accountId, request.message.chatId, request.message.messageId);
      }
      if (cancelled) return;
      if (!result) setError('Không có thông tin bộ sticker');
      else if ('error' in result) setError(result.error);
      else setSetId(result.set.id);
    })();
    return () => { cancelled = true; };
  }, [request]);

  const loaded = setId ? getLoadedStickerSet(request.accountId, { id: setId }) : undefined;
  const set = loaded?.set;
  const count = loaded?.stickers.length ?? 0;

  const toggleInstalled = async () => {
    if (!set) return;
    setBusy(true);
    const res = await setStickerSetInstalled(request.accountId, set, !set.installed);
    setBusy(false);
    if (!res.success) {
      useAppStore.getState().showNotification(`${set.installed ? 'Không gỡ được' : 'Không thêm được'} bộ sticker: ${res.error}`, 'error');
      return;
    }
    useAppStore.getState().showNotification(set.installed ? `Đã gỡ bộ "${set.title}"` : `Đã thêm ${count} sticker "${set.title}"`, 'success');
  };

  const send = async (item: TelegramStickerItem) => {
    if (!request.target || sending) return;
    setSending(item.id);
    const ok = await sendTelegramStickerItem(item, request.target);
    setSending('');
    if (ok) onClose();
  };

  const copyLink = async () => {
    if (!set?.shortName) return;
    try {
      await navigator.clipboard.writeText(`https://t.me/addstickers/${set.shortName}`);
      useAppStore.getState().showNotification('Đã sao chép link bộ sticker', 'success');
    } catch {
      useAppStore.getState().showNotification('Không sao chép được link', 'error');
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }} size="sm" className="max-w-[400px]">
      <DialogHeader className="pb-2">
        <div className="min-w-0">
          <DialogTitle className="truncate">{set?.title || 'Bộ sticker'}</DialogTitle>
          <DialogDescription className="mt-0.5 text-xs">
            {set ? `${count} sticker${request.target ? ' · bấm để gửi' : ''}` : error ? 'Không mở được bộ sticker' : 'Đang tải…'}
          </DialogDescription>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {set?.shortName && (
            <button
              type="button"
              onClick={() => void copyLink()}
              title="Sao chép link bộ sticker"
              aria-label="Sao chép link bộ sticker"
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <LinkIcon className="h-4 w-4" />
            </button>
          )}
          <DialogClose />
        </div>
      </DialogHeader>
      <DialogBody ref={setBodyEl} className="max-h-[56vh] px-3 py-1">
        {loaded && bodyEl ? (
          <InViewRootContext.Provider value={bodyEl}>
            <div className="grid grid-cols-5 justify-items-center gap-1 pb-1">
              {loaded.stickers.map((item) => (
                <TelegramStickerTile
                  key={item.id}
                  accountId={request.accountId}
                  item={item}
                  size={64}
                  onClick={request.target ? (picked) => void send(picked) : undefined}
                  title={request.target ? `Gửi ${item.emoji || 'sticker'}` : item.emoji}
                  className={sending === item.id ? 'opacity-50' : undefined}
                />
              ))}
            </div>
          </InViewRootContext.Provider>
        ) : error ? (
          <PanelMessage>{error}</PanelMessage>
        ) : (
          <PanelMessage loading>Đang tải bộ sticker…</PanelMessage>
        )}
      </DialogBody>
      <DialogFooter className="pt-2">
        {set && (
          set.installed ? (
            <Button variant="outline" className="w-full text-destructive hover:text-destructive" loading={busy} onClick={() => void toggleInstalled()}>
              Gỡ {count} sticker
            </Button>
          ) : (
            <Button className="w-full" loading={busy} onClick={() => void toggleInstalled()}>
              Thêm {count} sticker
            </Button>
          )
        )}
        {!set && <Button variant="outline" className="w-full" onClick={onClose}>Đóng</Button>}
      </DialogFooter>
    </Dialog>
  );
}
