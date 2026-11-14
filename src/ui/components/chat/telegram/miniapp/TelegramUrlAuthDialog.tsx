/**
 * Bot "log in with Telegram" button (keyboardButtonUrlAuth), as in Telegram (https://core.telegram.org/api/url-authorization):
 *  - messages.requestUrlAuth: Telegram says the page needs login → asks "Mở {trang}?" (Open {page}?) with a "Đăng nhập bằng tài khoản Telegram" (Log in with Telegram account) option (on by default),
 *    and "Cho bot nhắn tin" (Allow the bot to message) / "Chia sẻ số điện thoại" (Share phone number) if the page asks for them (off by default).
 *  - Open with login: messages.acceptUrlAuth, then open the Telegram link returned (it includes the login signature) in the machine's browser.
 *    Login unchecked: open the button's original link. If Telegram logs in directly (no need to ask) or does not support it: open right away.
 */
import React from 'react';
import {
  Button, Checkbox, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui';
import ipc from '@/lib/ipc';
import type { UrlAuthRequest } from '@/lib/chat/telegram/telegramMiniApp';
import { openExternalLink } from '@/lib/chat/links/externalLink';
import type { UrlAuthInfo } from '../../../../../shared/telegram/telegramMiniApp';
import { tr } from '../../../../../shared/i18n';
import { trx } from '@/lib/i18n/trx';

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
        else openAndClose(url); // urlAuthResultDefault / error: open the original link, as Telegram does
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
        setError(res?.error ? tr('Không đăng nhập được: {{error}}', { error: res.error }) : tr('Không đăng nhập được'));
        return;
      }
      const target = res.url || url;
      if (target) openExternalLink(target);
      onClose();
    } catch (err: any) {
      setError(tr('Không đăng nhập được: {{v1}}', { v1: err?.message || err }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => { if (!next) onClose(); }} size="sm" className="max-w-[420px]">
      <DialogHeader>
        <div className="min-w-0">
          <DialogTitle className="truncate">{trx('Mở {{domain}}?', { domain: info.domain })}</DialogTitle>
          {url && <DialogDescription className="mt-0.5 truncate text-xs" title={url}>{url}</DialogDescription>}
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="flex flex-col gap-3">
        <Checkbox
          checked={login}
          onCheckedChange={setLogin}
          label={tr('Đăng nhập {{domain}} bằng tài khoản Telegram', { domain: info.domain })}
          description={tr('Trang nhận tên, ảnh đại diện và tên người dùng Telegram của bạn.')}
        />
        {info.requestWriteAccess && (
          <Checkbox
            checked={login && allowWrite}
            onCheckedChange={setAllowWrite}
            disabled={!login}
            label={tr('Cho {{botName}} nhắn tin cho bạn', { botName: info.botName })}
          />
        )}
        {info.requestPhoneNumber && (
          <Checkbox
            checked={login && sharePhone}
            onCheckedChange={setSharePhone}
            disabled={!login}
            label={tr('Chia sẻ số điện thoại với {{domain}}', { domain: info.domain })}
          />
        )}
        {error && <p className="text-xs text-destructive">{error}</p>}
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose} disabled={busy}>{tr('Huỷ')}</Button>
        <Button onClick={() => void open()} loading={busy}>{tr('Mở')}</Button>
      </DialogFooter>
    </Dialog>
  );
}
