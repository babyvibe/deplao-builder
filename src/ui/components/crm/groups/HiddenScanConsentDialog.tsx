/**
 * Hỏi đồng ý trước khi gửi phiên đăng nhập Zalo (cookie + IMEI) lên máy chủ Deplao để quét thành viên nhóm ẩn, và công
 * tắc bật / tắt ở CRM → Nhóm → Quét thành viên. Hộp thoại nói rõ: gửi gì, vì sao qua máy chủ, máy chủ giữ gì, rủi ro,
 * quyền không đồng ý và chỗ tắt. Quy tắc + chỗ lưu lựa chọn: lib/crm/hiddenScanConsent.ts.
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

type DialogMode = 'ask' | 'info';

export function HiddenScanConsentDialog({ accountName, mode = 'ask', confirmLabel = 'Đồng ý và quét', onAnswer }: {
  accountName?: string;
  /** info = chỉ xem lại (đã bật), một nút Đóng. */
  mode?: DialogMode;
  confirmLabel?: string;
  onAnswer: (agreed: boolean) => void;
}) {
  const who = accountName ? `tài khoản ${accountName}` : 'tài khoản đang quét';
  const points: Array<[string, string]> = [
    ['Gửi gì', `Phiên đăng nhập Zalo (cookie + IMEI) của ${who} và ID nhóm, gửi lên deplaoapp.com qua HTTPS.`],
    ['Vì sao', 'Cách quét nhóm ẩn thành viên chạy trên máy chủ để giữ kín, không nằm trong mã nguồn mở của app.'],
    ['Máy chủ giữ gì', 'Chỉ dùng phiên này gọi Zalo lấy danh sách thành viên rồi trả về máy bạn, không lưu cookie. Nhật ký chỉ có ID tài khoản, ID nhóm, IP, thời gian.'],
    ['Rủi ro', 'Ai có cookie có thể dùng tài khoản Zalo đó. Chỉ đồng ý nếu bạn tin Deplao.'],
  ];
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onAnswer(false); }} size="md">
      <DialogHeader>
        <div className="flex min-w-0 items-start gap-2.5">
          <ShieldIcon className="mt-0.5 h-5 w-5 flex-shrink-0 text-warning" />
          <div className="min-w-0">
            <DialogTitle>{mode === 'info' ? 'Quét qua máy chủ Deplao' : 'Quét thành viên qua máy chủ Deplao?'}</DialogTitle>
            <DialogDescription>
              {mode === 'info' ? 'Những gì được gửi đi khi bật quét qua máy chủ.' : 'Cần bạn đồng ý trước khi phiên đăng nhập Zalo rời khỏi máy.'}
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
          Bạn có quyền không đồng ý: không quét nhóm ẩn, mọi tính năng khác vẫn dùng bình thường. Bật / tắt lúc nào cũng
          được ở CRM → Nhóm → Quét thành viên.
        </p>
      </DialogBody>
      <DialogFooter>
        {mode === 'info' ? (
          <Button onClick={() => onAnswer(false)}>Đóng</Button>
        ) : (
          <>
            <Button variant="outline" onClick={() => onAnswer(false)}>Không đồng ý</Button>
            <Button onClick={() => onAnswer(true)}>{confirmLabel}</Button>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}

/** Mở hộp thoại ngoài cây React hiện tại (như showConfirm); trả lời true = đồng ý. Không tự lưu lựa chọn. */
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
      // Gỡ sau lượt sự kiện hiện tại (đang ở trong handler của chính root này)
      setTimeout(() => { root.unmount(); container.remove(); }, 0);
    };
    root.render(<HiddenScanConsentDialog {...options} onAnswer={answer} />);
  });
}

/**
 * Gọi NGAY TRƯỚC mỗi lần quét qua máy chủ: đã đồng ý → true; chưa → hỏi, đồng ý thì nhớ (bật công tắc) rồi true;
 * không đồng ý → false (chỗ gọi không được gửi gì).
 */
export async function ensureHiddenScanConsent(options: { accountName?: string } = {}): Promise<boolean> {
  if (hasHiddenScanConsent()) return true;
  const agreed = await askHiddenScanConsent(options);
  if (agreed) setHiddenScanConsent(true);
  return agreed;
}

function formatAt(at: number | null): string {
  if (!at) return '';
  return new Date(at).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Công tắc "Quét qua máy chủ Deplao" (CRM → Nhóm → Quét thành viên). Bật = phải qua hộp thoại đồng ý; tắt = ngay. */
export function HiddenScanConsentSwitch({ className }: { className?: string }) {
  const consent = useHiddenScanConsent();
  const showNotification = useAppStore((s) => s.showNotification);
  const [asking, setAsking] = useState(false);

  const change = async (on: boolean) => {
    if (!on) {
      setHiddenScanConsent(false);
      showNotification('Đã tắt quét qua máy chủ. Deplao không gửi cookie Zalo ra khỏi máy nữa.', 'info');
      return;
    }
    setAsking(true);
    try {
      if (await askHiddenScanConsent({ confirmLabel: 'Đồng ý' })) setHiddenScanConsent(true);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className={cn('flex items-start gap-3 rounded-xl border bg-card p-4', consent.granted ? 'border-warning/40' : 'border-border', className)}>
      <ShieldIcon className={cn('mt-0.5 h-5 w-5 flex-shrink-0', consent.granted ? 'text-warning' : 'text-muted-foreground')} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">Quét qua máy chủ Deplao</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {consent.granted
            ? `Đang bật${consent.at ? ` (đồng ý lúc ${formatAt(consent.at)})` : ''}: mỗi lần quét, phiên đăng nhập Zalo (cookie) được gửi lên deplaoapp.com.`
            : 'Đang tắt: Deplao không gửi cookie Zalo ra khỏi máy. Bấm Quét sẽ hỏi bạn trước.'}
        </p>
        <Button variant="link" size="sm" className="mt-1 h-auto p-0 text-xs"
          onClick={() => { void askHiddenScanConsent({ mode: 'info' }); }}>
          Gửi gì, vì sao?
        </Button>
      </div>
      <Switch checked={consent.granted} disabled={asking} onCheckedChange={(on) => { void change(on); }}
        aria-label="Quét qua máy chủ Deplao" />
    </div>
  );
}
