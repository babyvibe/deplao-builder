/**
 * Tin mẫu của Page Facebook (msg_type `fb.template`): thẻ ảnh + tiêu đề + mô tả + nút, carousel nhiều thẻ — như
 * Messenger. Dữ liệu thẻ nằm trong cột `attachments` (shared/facebook/facebookTemplate.ts).
 *
 * Nút: link → mở trình duyệt; số điện thoại → sao chép; postback → gửi tên nút cho Page (giống Messenger hiện trong
 * khung chat; LightSpeed không có lệnh postback nên Page không nhận mã ẩn của nút → kèm "Mở trên Messenger").
 */
import React, { useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import { sendFacebookText } from '@/lib/chat/facebook/sendFacebookText';
import { BubbleTime } from '../messages/MessageTime';
import {
  fbTemplateFromAttachments,
  fbTemplateHasPostback,
  isFbUnavailableTemplate,
  messengerThreadUrl,
  type FbTemplate,
  type FbTemplateButton,
  type FbTemplateItem,
} from '../../../../shared/facebook/facebookTemplate';

function openUrl(url?: string): void {
  if (url && /^https?:\/\//i.test(url)) ipc.shell?.openExternal(url);
}

function CardImage({ src, onClick, className }: { src: string; onClick?: () => void; className: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const img = <img src={src} alt="" draggable={false} loading="lazy" className="w-full h-full object-cover" onError={() => setFailed(true)} />;
  return onClick
    ? <button type="button" onClick={onClick} className={`block w-full bg-foreground/5 cursor-pointer hover:opacity-95 transition-opacity ${className}`}>{img}</button>
    : <div className={`w-full bg-foreground/5 ${className}`}>{img}</div>;
}

function ButtonGlyph({ kind }: { kind: FbTemplateButton['kind'] }) {
  const common = { width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  if (kind === 'url') {
    return <svg {...common}><path d="M14 4h6v6" /><path d="M10 14 20 4" /><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" /></svg>;
  }
  if (kind === 'phone') {
    return <svg {...common}><path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" /></svg>;
  }
  return <svg {...common}><path d="M9 17 4 12l5-5" /><path d="M20 18v-2a4 4 0 0 0-4-4H4" /></svg>;
}

function buttonHint(button: FbTemplateButton, isSent: boolean): string {
  if (button.kind === 'url') return button.url || button.title;
  if (button.kind === 'phone') return `Sao chép số ${button.phone}`;
  return isSent ? 'Nút trên tin của bạn' : `Gửi “${button.title}” cho Trang`;
}

function ButtonList({ buttons, isSent, sending, onPress }: {
  buttons: FbTemplateButton[]; isSent: boolean; sending: string | null; onPress: (b: FbTemplateButton) => void;
}) {
  return (
    <div className="flex flex-col divide-y divide-foreground/10 border-t border-foreground/10">
      {buttons.map((button, index) => {
        const inactive = button.kind === 'postback' && isSent;
        return (
          <button
            key={`${index}_${button.title}`}
            type="button"
            title={buttonHint(button, isSent)}
            disabled={inactive || sending === button.title}
            onClick={(e) => { e.stopPropagation(); onPress(button); }}
            className={`flex items-center justify-center gap-1.5 px-3 py-2 text-[13px] font-medium transition-colors ${
              inactive ? 'text-muted-foreground cursor-default' : 'text-primary hover:bg-foreground/5 cursor-pointer'
            } disabled:opacity-70`}
          >
            <ButtonGlyph kind={button.kind} />
            <span className="truncate">{sending === button.title ? 'Đang gửi…' : button.title}</span>
          </button>
        );
      })}
    </div>
  );
}

function CardTexts({ template }: { template: Pick<FbTemplate, 'header' | 'title' | 'subtitle' | 'body' | 'footer' | 'source'> }) {
  if (!template.header && !template.title && !template.subtitle && !template.body && !template.footer && !template.source) return null;
  return (
    <div className="px-3 pt-2.5 pb-2 flex flex-col gap-0.5 select-text">
      {template.source && <p className="text-[11px] uppercase tracking-wide text-muted-foreground truncate">{template.source}</p>}
      {template.header && <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{template.header}</p>}
      {template.title && <p className="text-sm font-semibold leading-snug text-foreground whitespace-pre-line break-words">{template.title}</p>}
      {template.subtitle && <p className="text-[13px] leading-snug text-muted-foreground whitespace-pre-line break-words">{template.subtitle}</p>}
      {template.body && (
        // Tin "chữ + nút" (không tiêu đề): chữ cỡ như tin thường, như Messenger
        <p className={`${template.title || template.subtitle || template.header ? 'text-[13px] leading-snug' : 'text-sm leading-relaxed'} text-foreground whitespace-pre-line break-words`}>
          {template.body}
        </p>
      )}
      {template.footer && <p className="text-[11px] text-subtle-foreground whitespace-pre-line">{template.footer}</p>}
    </div>
  );
}

function ItemCard({ item, isSent, sending, onPress }: {
  item: FbTemplateItem; isSent: boolean; sending: string | null; onPress: (b: FbTemplateButton) => void;
}) {
  return (
    <div className="w-[220px] flex-shrink-0 snap-start flex flex-col overflow-hidden rounded-lg border border-foreground/10 bg-background/40">
      {item.imageUrl && <CardImage src={item.imageUrl} className="aspect-[1.91/1]" onClick={item.url ? () => openUrl(item.url) : undefined} />}
      <CardTexts template={{ title: item.title, subtitle: item.subtitle }} />
      <div className="flex-1" />
      {item.buttons?.length ? <ButtonList buttons={item.buttons} isSent={isSent} sending={sending} onPress={onPress} /> : null}
    </div>
  );
}

export default function FacebookTemplateCard({ msg, isSent }: { msg: any; isSent: boolean }) {
  const template = useMemo(() => fbTemplateFromAttachments(msg?.attachments), [msg?.attachments]);
  const [sending, setSending] = useState<string | null>(null);

  if (!template) {
    // Thẻ hỏng / thiếu dữ liệu: vẫn hiện chữ đã lưu thay vì bong bóng rỗng
    return (
      <div className={`rounded-lg px-3 py-2 border ${isSent ? 'bg-bubble-out border-bubble-out-border' : 'bg-bubble-in border-bubble-in-border'}`}>
        <p className="text-sm whitespace-pre-line break-words">{msg?.content || '[Tin nhắn mẫu]'}</p>
        <BubbleTime timestamp={msg?.timestamp} />
      </div>
    );
  }

  if (isFbUnavailableTemplate(template)) {
    // Facebook chỉ gửi thẻ thay thế "File đính kèm không hiển thị" (thường là tin có nút của Trang mà bridge chưa nhận được
    // bản đầy đủ): báo chưa hiển thị được + mở trên Messenger, không hiện chữ "có thể đã bị gỡ" gây hiểu nhầm
    return (
      <div
        data-fb-template="unavailable"
        className={`rounded-lg px-3 py-2 border ${isSent ? 'bg-bubble-out border-bubble-out-border' : 'bg-bubble-in border-bubble-in-border'}`}
      >
        <FacebookEmptyMessage msg={msg} />
        <BubbleTime timestamp={msg?.timestamp} />
      </div>
    );
  }

  const press = (button: FbTemplateButton) => {
    if (button.kind === 'url') {
      openUrl(button.url);
      return;
    }
    if (button.kind === 'phone') {
      const phone = button.phone || '';
      navigator.clipboard?.writeText(phone)
        .then(() => useAppStore.getState().showNotification(`Đã sao chép số ${phone}`, 'success'))
        .catch(() => useAppStore.getState().showNotification(`Số điện thoại: ${phone}`, 'info'));
      return;
    }
    if (isSent) return;
    const sent = sendFacebookText({
      accountId: String(msg.owner_zalo_id || ''),
      threadId: String(msg.thread_id || ''),
      threadType: msg.thread_type,
      text: button.title,
    });
    if (!sent) {
      useAppStore.getState().showNotification('Không gửi được — hãy mở hội thoại trên Messenger', 'error');
      return;
    }
    setSending(button.title);
    window.setTimeout(() => setSending(current => (current === button.title ? null : current)), 1500);
  };

  const hasMainCard = !!(template.imageUrl || template.title || template.subtitle || template.body || template.header
    || template.footer || template.buttons?.length);
  const tone = isSent ? 'bg-bubble-out border-bubble-out-border' : 'bg-bubble-in border-bubble-in-border';

  return (
    <div className="flex flex-col gap-1.5 max-w-full" data-fb-template="1">
      {hasMainCard && (
        <div className={`flex flex-col overflow-hidden rounded-lg w-[300px] max-w-full border text-left text-foreground ${tone}`}>
          {template.imageUrl && (
            <CardImage src={template.imageUrl} className="aspect-[1.91/1]" onClick={template.url ? () => openUrl(template.url) : undefined} />
          )}
          {template.url && !template.imageUrl ? (
            <button type="button" onClick={() => openUrl(template.url)} title={template.url} className="block w-full text-left hover:bg-foreground/5 transition-colors">
              <CardTexts template={template} />
            </button>
          ) : (
            <CardTexts template={template} />
          )}
          {template.buttons?.length ? <ButtonList buttons={template.buttons} isSent={isSent} sending={sending} onPress={press} /> : null}
          <BubbleTime timestamp={msg?.timestamp} className="px-3 pb-2" />
        </div>
      )}
      {template.items?.length ? (
        <div className="flex gap-2 overflow-x-auto snap-x snap-mandatory pb-1 max-w-[min(100%,680px)]">
          {template.items.map((item, index) => (
            <ItemCard key={`${index}_${item.title || ''}`} item={item} isSent={isSent} sending={sending} onPress={press} />
          ))}
        </div>
      ) : null}
      {!hasMainCard && <BubbleTime timestamp={msg?.timestamp} className="px-1" />}
      {fbTemplateHasPostback(template) && !isSent && (
        <button
          type="button"
          onClick={() => openUrl(messengerThreadUrl(msg?.thread_id))}
          title="Nút của Trang chỉ gửi đúng dữ liệu ẩn khi bấm trên Messenger; ở đây Trang nhận tên nút như một tin nhắn"
          className="self-start px-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
        >
          Mở trên Messenger
        </button>
      )}
    </div>
  );
}

/** Tin Facebook cũ lưu rỗng (bản trước chưa đọc được tin mẫu / đính kèm): chữ thay thế + mở trên Messenger. */
export function FacebookEmptyMessage({ msg }: { msg: any }) {
  return (
    <span className="text-[13px] italic text-muted-foreground">
      Tin nhắn chưa hiển thị được.{' '}
      <button
        type="button"
        className="not-italic text-primary hover:underline"
        title="Đồng bộ lại tin nhắn để tải nội dung, hoặc xem trên Messenger"
        onClick={(e) => { e.stopPropagation(); openUrl(messengerThreadUrl(msg?.thread_id)); }}
      >
        Mở trên Messenger
      </button>
    </span>
  );
}
