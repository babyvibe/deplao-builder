/**
 * Nút "đăng nhập bằng Telegram" của bot (keyboardButtonUrlAuth), như Telegram (https://core.telegram.org/api/url-authorization):
 *  - messages.requestUrlAuth: Telegram cho biết trang cần đăng nhập → hỏi "Mở {trang}?" với ô "Đăng nhập bằng tài khoản
 *    Telegram" (bật sẵn), "Cho bot nhắn tin" / "Chia sẻ số điện thoại" nếu trang xin (tắt sẵn).
 *  - Mở có đăng nhập: messages.acceptUrlAuth, mở link Telegram trả về (đã kèm chữ ký đăng nhập) bằng trình duyệt của máy.
 *    Bỏ chọn đăng nhập: mở link gốc của nút. Telegram tự đăng nhập luôn (không cần hỏi) hoặc không hỗ trợ: mở ngay.
 */
import React from 'react';
import {
  Button, Checkbox, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui';
import ipc from '@/lib/ipc';
import type { UrlAuthRequest } from '@/lib/chat/telegram/telegramMiniApp';
import { openExternalLink } from '@/lib/chat/links/externalLink';
import type { UrlAuthInfo } from '../../../../../shared/telegram/telegramMiniApp';

type LoginRequest = Extract<UrlAuthInfo, { kind: 'request' }>;

export default function TelegramUrlAuthDialog({ request, onClose }: { request: UrlAuthRequest; onClose: () => void }) {
  const [info, setInfo] = React.useState<LoginRequest | null>(null);
  const [login, setLogin] = React.useState(true);
  const [allowWrite, setAllowWrite] = React.useState(false);
  const [sharePhone, setSharePhone] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const { accountId, peerId, msgId, buttonId, url } = request;

  React.useEffect(() => {
    let cancelled = false;
    const openAndClose = (target: string | null | undefined) => {
      if (target) openExternalLink(target);
      onClose();
    };
    ipc.telegramUser?.requestUrlAuth?.({ accountId, peerId, msgId, buttonId })
      .then((res) => {
        if (cancelled) return;
        const result = res?.success ? res.info : undefined;
        if (result?.kind === 'request') setInfo(result);
        else if (result?.kind === 'accepted') openAndClose(result.url || url);
        else openAndClose(url); // urlAuthResultDefault / lỗi: mở link gốc như Telegram
      })
      .catch(() => { if (!cancelled) openAndClose(url); });
    return () => { cancelled = true; };
  }, [accountId, peerId, msgId, buttonId, url, onClose]);

  if (!info) return null;

  const open = async () => {
    if (!login) {
      if (url) openExternalLink(url);
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await ipc.telegramUser?.acceptUrlAuth?.({
        accountId, peerId, msgId, buttonId,
        writeAllowed: info.requestWriteAccess && allowWrite,
        sharePhone: info.requestPhoneNumber && sharePhone,
      });
      if (!res?.success) {
        setError(res?.error ? `Không đăng nhập được: ${res.error}` : 'Không đăng nhập được');
        return;
      }
      const target = res.url || url;
      if (target) openExternalLink(target);
      onClose();
    } catch (err: any) {
      setError(`Không đăng nhập được: ${err?.message || err}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} size="sm" className="max-w-[420px]">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle className="truncate">Mở {info.domain}?</DialogTitle>
          {url && <DialogDescription className="mt-0.5 truncate text-xs" title={url}>{url}</DialogDescription>}
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <Checkbox
          checked={login}
          onCheckedChange={setLogin}
          label={`Đăng nhập ${info.domain} bằng tài khoản Telegram`}
          description="Trang nhận tên, ảnh đại diện và tên người dùng Telegram của bạn."
        />
        {info.requestWriteAccess && (
          <Checkbox
            checked={login && allowWrite}
            onCheckedChange={setAllowWrite}
            disabled={!login}
            label={`Cho ${info.botName} nhắn tin cho bạn`}
          />
        )}
        {info.requestPhoneNumber && (
          <Checkbox
            checked={login && sharePhone}
            onCheckedChange={setSharePhone}
            disabled={!login}
            label={`Chia sẻ số điện thoại với ${info.domain}`}
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Huỷ</Button>
        <Button onClick={() => void open()} loading={busy}>Mở</Button>
      </DialogFooter>
    </Dialog>
  );
}
