/**
 * Bản tin của Official Account Zalo (msgType `chat.list.action`, MsgType 15 trên mobile).
 *
 * content là mảng bài viết, vd:
 *   [{ type: 'l.a.header.only', title, href, thumb, description, childNumber },
 *    { type: 'l.a.child.full',  title, href, thumb, description }, ...]
 * Mục header hiển thị ảnh lớn + tiêu đề + mô tả, các mục con là danh sách tiêu đề + ảnh nhỏ (giống Zalo).
 * Bấm vào mục nào thì mở link bài viết đó.
 *
 * Lưu ý line-clamp: KHÔNG đặt padding lên chính phần tử bị clamp — overflow cắt theo mép padding nên dòng
 * bị ẩn sẽ lộ nửa dòng trong vùng padding. Padding luôn đặt ở thẻ bọc ngoài.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import {BubbleTime} from '../../messages/MessageTime';

export interface OaListItem {
    type: string;
    title: string;
    href: string;
    thumb: string;
    description: string;
}

export function parseOaListItems(content: any): OaListItem[] {
    let parsed = content;
    if (typeof parsed === 'string') {
        try {
            parsed = JSON.parse(parsed || '[]');
        } catch {
            return [];
        }
    }
    const raw: any[] = Array.isArray(parsed) ? parsed : (parsed && typeof parsed === 'object' ? [parsed] : []);
    return raw
        .filter(item => item && typeof item === 'object')
        .map(item => ({
            type: String(item.type || ''),
            title: String(item.title || '').trim(),
            href: String(item.href || ''),
            thumb: String(item.thumb || ''),
            description: String(item.description || '').trim(),
        }))
        .filter(item => item.title || item.thumb || item.href);
}

function openLink(href: string) {
    if (/^https?:\/\//i.test(href)) void ipc.shell?.openExternal(href);
}

/** Ảnh bài viết — ẩn khi lỗi (ảnh CDN của OA cũng có thể hết hạn). */
function OaThumb({src, className}: { src: string; className: string }) {
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => setFailed(false), [src]);
    if (!src || failed) return null;
    return <img src={src} alt="" draggable={false} className={className} onError={() => setFailed(true)}/>;
}

/** Mô tả bài chính: thu gọn 4 dòng, có "Xem thêm" khi dài hơn. */
function OaDescription({text}: { text: string }) {
    const ref = React.useRef<HTMLParagraphElement>(null);
    const [expanded, setExpanded] = React.useState(false);
    const [overflowing, setOverflowing] = React.useState(false);

    React.useLayoutEffect(() => {
        const el = ref.current;
        if (!el || expanded) return;
        setOverflowing(el.scrollHeight - el.clientHeight > 1);
    }, [text, expanded]);

    return (
        <div className="px-3 pt-2 pb-2.5">
            <p ref={ref}
               className={`text-xs text-muted-foreground leading-relaxed whitespace-pre-line break-words select-text${expanded ? '' : ' line-clamp-4'}`}>
                {text}
            </p>
            {(overflowing || expanded) && (
                <button type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            setExpanded(v => !v);
                        }}
                        className="mt-1 text-[11px] font-medium text-blue-400 hover:text-blue-300 hover:underline transition-colors">
                    {expanded ? 'Thu gọn' : 'Xem thêm'}
                </button>
            )}
        </div>
    );
}

/**
 * `timestamp`: giờ gửi in ở cuối thẻ (ChatWindow không bọc / không in giờ cho tin thẻ). Bỏ trống = không in
 * (QuickChat dùng chung component nhưng không in giờ từng tin).
 */
export default function OaListBubble({msg, timestamp}: { msg: any; timestamp?: number | string | null }) {
    const items = React.useMemo(() => parseOaListItems(msg?.content), [msg?.content]);
    if (!items.length) return <span className="text-xs opacity-60">[Bản tin Official Account]</span>;

    const headerIdx = Math.max(0, items.findIndex(item => item.type.startsWith('l.a.header')));
    const header = items[headerIdx];
    const children = items.filter((_, i) => i !== headerIdx);
    const headerDesc = header.description && header.description !== header.title ? header.description : '';

    // Bản tin OA luôn là tin nhận → bề mặt bong bóng nhận (trắng ở theme sáng)
    return (
        <div className="flex flex-col overflow-hidden rounded-lg w-[300px] max-w-full bg-bubble-in text-foreground border border-bubble-in-border text-left">
            <button type="button" onClick={() => openLink(header.href)} title={header.href || header.title}
                    className="block w-full text-left cursor-pointer hover:opacity-95 transition-opacity">
                {header.thumb ? (
                    <div className="relative w-full aspect-[16/9] bg-foreground/5">
                        <OaThumb src={header.thumb} className="w-full h-full object-cover"/>
                        <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent"/>
                        {header.title && (
                            <div className="absolute bottom-0 left-0 right-0 px-3 pb-2.5">
                                <p className="text-sm font-semibold leading-snug text-white-important line-clamp-3">
                                    {header.title}
                                </p>
                            </div>
                        )}
                    </div>
                ) : header.title ? (
                    <div className={`px-3 pt-3${headerDesc ? '' : ' pb-3'}`}>
                        <p className="text-sm font-semibold text-foreground leading-snug line-clamp-3">{header.title}</p>
                    </div>
                ) : null}
            </button>

            {headerDesc && <OaDescription text={headerDesc}/>}

            {children.length > 0 && (
                <div className="flex flex-col divide-y divide-foreground/10 border-t border-foreground/10">
                    {children.map((item, i) => (
                        <button key={`${i}_${item.href}`} type="button" onClick={() => openLink(item.href)}
                                title={item.href || item.title}
                                className="flex items-center gap-2.5 px-3 py-2 text-left cursor-pointer hover:bg-foreground/5 transition-colors">
                            <p className="flex-1 min-w-0 text-[13px] text-foreground leading-snug line-clamp-2">
                                {item.title || item.description}
                            </p>
                            {item.thumb && (
                                <OaThumb src={item.thumb}
                                         className="w-12 h-12 rounded-md object-cover flex-shrink-0 bg-foreground/5"/>
                            )}
                        </button>
                    ))}
                </div>
            )}
            <BubbleTime timestamp={timestamp} className="px-3 pb-2"/>
        </div>
    );
}
