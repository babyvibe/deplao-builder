/**
 * Tin zinstant của Zalo Official Account (`chat.webcontent` / `chat.webcontent.v2`): bản tin, thông báo, khuyến mãi —
 * thẻ ảnh + tiêu đề + nội dung + nút, dựng từ dữ liệu có trong tin (shared/zaloZinstant). Bản v2 nén gzip → giải nén
 * một lần / nội dung (cache). Trước đây bản tin hiện "[Đính kèm]", bản v2 hiện nguyên chuỗi JSON.
 */
import React, { useEffect, useMemo, useState } from 'react';
import ipc from '@/lib/ipc';
import { gunzipToText } from '@/lib/media/tgs';
import { BubbleTime } from './MessageTime';
import { applyZinstantData, parseZinstantCard, type ZinstantButton, type ZinstantCard } from '../../../shared/zaloZinstant';

const MAX_UNPACKED = 200;
const unpacked = new Map<string, Promise<any | null>>();

function unpack(packed: string): Promise<any | null> {
  let task = unpacked.get(packed);
  if (!task) {
    task = (async () => {
      try {
        const binary = atob(packed);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        return JSON.parse(await gunzipToText(bytes.buffer));
      } catch {
        return null;
      }
    })();
    unpacked.set(packed, task);
    if (unpacked.size > MAX_UNPACKED) unpacked.delete(unpacked.keys().next().value as string);
  }
  return task;
}

function openUrl(url?: string): void {
  if (url && /^https?:\/\//i.test(url)) ipc.shell?.openExternal(url);
}

function OaImage({ src, onClick }: { src: string; onClick?: () => void }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const img = <img src={src} alt="" draggable={false} loading="lazy" className="block w-full max-h-80 object-cover" onError={() => setFailed(true)} />;
  return onClick
    ? <button type="button" onClick={onClick} className="block w-full bg-foreground/5 cursor-pointer hover:opacity-95 transition-opacity">{img}</button>
    : <div className="w-full bg-foreground/5">{img}</div>;
}

function Buttons({ buttons }: { buttons: ZinstantButton[] }) {
  return (
    <div className="flex flex-col divide-y divide-foreground/10 border-t border-foreground/10">
      {buttons.map((button, index) => (
        <button
          key={`${index}_${button.text}`}
          type="button"
          disabled={!button.url}
          title={button.url || button.text}
          onClick={(e) => { e.stopPropagation(); openUrl(button.url); }}
          className={`px-3 py-2 text-[13px] transition-colors truncate ${button.url ? 'text-primary hover:bg-foreground/5 cursor-pointer' : 'text-muted-foreground cursor-default'} ${button.primary ? 'font-semibold' : 'font-medium'}`}
        >
          {button.text}
        </button>
      ))}
    </div>
  );
}

export default function ZaloOaCard({ msg, isSent }: { msg: any; isSent: boolean }) {
  const base = useMemo(() => parseZinstantCard(msg?.content, msg?.msg_type), [msg?.content, msg?.msg_type]);
  const [full, setFull] = useState<ZinstantCard | null>(null);

  useEffect(() => {
    setFull(null);
    const packed = base?.packedData;
    if (!base || !packed) return;
    let alive = true;
    void unpack(packed).then((data) => {
      if (alive && data) setFull(applyZinstantData({ ...base, paragraphs: [...base.paragraphs], buttons: [...base.buttons] }, data));
    });
    return () => { alive = false; };
  }, [base]);

  const card = full || base;
  if (!card) return null;
  const tone = isSent ? 'bg-bubble-out border-bubble-out-border' : 'bg-bubble-in border-bubble-in-border';
  const hasBody = !!(card.title || card.description || card.paragraphs.length);

  return (
    <div className={`flex flex-col overflow-hidden rounded-lg w-[320px] max-w-full border text-left text-foreground ${tone}`} data-zalo-oa-card="1">
      {card.imageUrl && <OaImage src={card.imageUrl} onClick={card.url ? () => openUrl(card.url) : undefined} />}
      <div className="px-3 pt-2.5 pb-2 flex flex-col gap-1 select-text">
        {card.title && <p className="text-sm font-semibold leading-snug break-words whitespace-pre-line">{card.title}</p>}
        {card.description && <p className="text-[13px] leading-snug text-muted-foreground break-words whitespace-pre-line">{card.description}</p>}
        {card.paragraphs.map((paragraph, index) => (
          <p key={index} className="text-[13px] leading-snug break-words whitespace-pre-line">{paragraph}</p>
        ))}
        {!hasBody && <p className="text-[13px] leading-snug break-words whitespace-pre-line">{card.text || 'Tin từ Official Account'}</p>}
      </div>
      {card.buttons.length > 0 && <Buttons buttons={card.buttons} />}
      <BubbleTime timestamp={msg?.timestamp} className="px-3 pb-2" />
    </div>
  );
}
