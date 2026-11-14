/**
 * News from a Zalo Official Account (OA) (msgType `chat.list.action`, MsgType 15 on mobile).
 *
 * content is an array of articles, e.g.:
 *   [{ type: 'l.a.header.only', title, href, thumb, description, childNumber },
 *    { type: 'l.a.child.full',  title, href, thumb, description }, ...]
 * The header item shows a large image + title + description, the child items are a list of titles + small images (like Zalo).
 * Clicking an item opens that article's link.
 *
 * Note on line-clamp: do NOT put padding on the clamped element itself. Overflow is cut at the padding edge, so a hidden line
 * would show half a line inside the padding area. Padding is always put on the outer wrapper.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import {BubbleTime} from '../../messages/MessageTime';
import { tr } from '../../../../../shared/i18n';

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

/** Article image: hidden on error (the OA's CDN images can also expire). */
function OaThumb({src, className}: { src: string; className: string }) {
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => setFailed(false), [src]);
    if (!src || failed) return null;
    return <img src={src} alt="" draggable={false} className={className} onError={() => setFailed(true)}/>;
}

/** Main description: collapsed to 4 lines, with "Xem thêm" (See more) when longer. */
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
                    {expanded ? tr('Thu gọn') : tr('Xem thêm')}
                </button>
            )}
        </div>
    );
}

/**
 * `timestamp`: the send time printed at the bottom of the card (ChatWindow does not wrap or print the time for card messages). Leave empty = not printed
 * (QuickChat uses the same component but does not print the time of each message).
 */
export default function OaListBubble({msg, timestamp}: { msg: any; timestamp?: number | string | null }) {
    const items = React.useMemo(() => parseOaListItems(msg?.content), [msg?.content]);
    if (!items.length) return <span className="text-xs opacity-60">{tr('[Bản tin Official Account]')}</span>;

    const headerIdx = Math.max(0, items.findIndex(item => item.type.startsWith('l.a.header')));
    const header = items[headerIdx];
    const children = items.filter((_, i) => i !== headerIdx);
    const headerDesc = header.description && header.description !== header.title ? header.description : '';

    // OA news is always an incoming message → the incoming bubble surface (white in the light theme)
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
