/**
 * Asks for consent before sending the Zalo login session (cookie + IMEI) to the Deplao server to scan hidden group members, and the
 * on / off switch in CRM → Groups → Scan members. The dialog states what is sent, why it goes via the server, what the server keeps, the risks,
 * the right to decline, and where to turn it off. Rules + where the choice is saved: lib/crm/hiddenScanConsent.ts.
 */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Button, Dialog, DialogBody, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Switch,
} from '@/components/ui';
import { ShieldIcon } from '@/components/common/icons';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/app/appStore';
import {
  hasHiddenScanConsent, setHiddenScanConsent, useHiddenScanConsent,
} from '@/lib/crm/hiddenScanConsent';
import { tr, appLocale } from '../../../../shared/i18n';

type DialogMode = 'ask' | 'info';

export function HiddenScanConsentDialog({ accountName, mode = 'ask', confirmLabel = tr('Đồng ý và quét'), onAnswer }: {
  accountName?: string;
  /** info = view only (already enabled), with a single Close button. */
  mode?: DialogMode;
  confirmLabel?: string;
  onAnswer: (agreed: boolean) => void;
}) {
  const who = accountName ? tr('tài khoản {{accountName}}', { accountName }) : tr('tài khoản đang quét');
  const points: Array<[string, string]> = [
    [tr('Gửi gì'), tr('Phiên đăng nhập Zalo (cookie + IMEI) của {{who}} và ID nhóm, gửi lên deplaoapp.com qua HTTPS.', { who })],
    [tr('Vì sao'), tr('Cách quét nhóm ẩn thành viên chạy trên máy chủ để giữ kín, không nằm trong mã nguồn mở của app.')],
    [tr('Máy chủ giữ gì'), tr('Chỉ dùng phiên này gọi Zalo lấy danh sách thành viên rồi trả về máy bạn, không lưu cookie. Nhật ký chỉ có ID tài khoản, ID nhóm, IP, thời gian.')],
    [tr('Rủi ro'), tr('Ai có cookie có thể dùng tài khoản Zalo đó. Chỉ đồng ý nếu bạn tin Deplao.')],
  ];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onAnswer(false); }} size="md">
      <DialogHeader>
        <div className="flex min-w-0 items-start gap-2.5">
          <ShieldIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning" />
          <div className="min-w-0">
            <DialogTitle>{mode === 'info' ? tr('Quét qua máy chủ Deplao') : tr('Quét thành viên qua máy chủ Deplao?')}</DialogTitle>
            <DialogDescription>
              {mode === 'info' ? tr('Những gì được gửi đi khi bật quét qua máy chủ.') : tr('Cần bạn đồng ý trước khi phiên đăng nhập Zalo rời khỏi máy.')}
            </DialogDescription>
          </div>
        </div>
        <DialogClose />
      </DialogHeader>
      <DialogBody className="space-y-3">
        <dl className="space-y-2.5">
          {points.map(([label, text]) => (
            <div key={label} className="grid grid-cols-[7.5rem_1fr] gap-2 text-sm">
              <dt className="font-medium text-foreground">{label}</dt>
              <dd className="text-muted-foreground">{text}</dd>
            </div>
          ))}
        </dl>
        <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-relaxed text-foreground/90">
          {tr('Bạn có quyền không đồng ý: không quét nhóm ẩn, mọi tính năng khác vẫn dùng bình thường. Bật / tắt lúc nào cũng được ở CRM → Nhóm → Quét thành viên.')}
        </p>
      </DialogBody>
      <DialogFooter>
        {mode === 'info' ? (
          <Button onClick={() => onAnswer(false)}>{tr('Đóng')}</Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => onAnswer(false)}>{tr('Không đồng ý')}</Button>
            <Button onClick={() => onAnswer(true)}>{confirmLabel}</Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/** Opens the dialog outside the current React tree (like showConfirm); answering true = agreed. Does not save the choice by itself. */
export function askHiddenScanConsent(options: { accountName?: string; mode?: DialogMode; confirmLabel?: string } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    let answered = false;
    const answer = (agreed: boolean) => {
      if (answered) return;
      answered = true;
      resolve(agreed);
      // Unmount after the current event tick (we are inside this root's own handler)
      setTimeout(() => { root.unmount(); container.remove(); }, 0);
    };
    root.render(<HiddenScanConsentDialog {...options} onAnswer={answer} />);
  });
}

/**
 * Call RIGHT BEFORE each scan through the server: already agreed → true; not yet → ask; if agreed, remember it (turn on the switch) and return true;
 * declined → false (the caller must not send anything).
 */
export async function ensureHiddenScanConsent(options: { accountName?: string } = {}): Promise<boolean> {
  if (hasHiddenScanConsent()) return true;
  const agreed = await askHiddenScanConsent(options);
  if (agreed) setHiddenScanConsent(true);
  return agreed;
}

function formatAt(at: number | null): string {
  if (!at) return '';
  return new Date(at).toLocaleString(appLocale(), { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Toggle "Quét qua máy chủ Deplao" (CRM → Groups → Scan members). On = must go through the consent dialog; Off = applies immediately. */
export function HiddenScanConsentSwitch({ className }: { className?: string }) {
  const consent = useHiddenScanConsent();
  const showNotification = useAppStore((s) => s.showNotification);
  const [asking, setAsking] = useState(false);

  const change = async (on: boolean) => {
    if (!on) {
      setHiddenScanConsent(false);
      showNotification(tr('Đã tắt quét qua máy chủ. Deplao không gửi cookie Zalo ra khỏi máy nữa.'), 'info');
      return;
    }
    setAsking(true);
    try {
      if (await askHiddenScanConsent({ confirmLabel: tr('Đồng ý') })) setHiddenScanConsent(true);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className={cn('flex items-start gap-3 rounded-xl border bg-card p-4', consent.granted ? 'border-warning/40' : 'border-border', className)}>
      <ShieldIcon className={cn('mt-0.5 h-5 w-5 flex-shrink-0', consent.granted ? 'text-warning' : 'text-muted-foreground')} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">{tr('Quét qua máy chủ Deplao')}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {consent.granted
            ? tr('Đang bật{{v1}}: mỗi lần quét, phiên đăng nhập Zalo (cookie) được gửi lên deplaoapp.com.', { v1: consent.at ? tr(' (đồng ý lúc {{v1}})', { v1: formatAt(consent.at) }) : '' })
            : tr('Đang tắt: Deplao không gửi cookie Zalo ra khỏi máy. Bấm Quét sẽ hỏi bạn trước.')}
        </p>
        <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-xs"
          onClick={() => { void askHiddenScanConsent({ mode: 'info' }); }}>
          {tr('Gửi gì, vì sao?')}
        </Button>
      </div>
      <Switch checked={consent.granted} disabled={asking} onCheckedChange={(on) => { void change(on); }}
        aria-label={tr('Quét qua máy chủ Deplao')} />
    </div>
  );
}
