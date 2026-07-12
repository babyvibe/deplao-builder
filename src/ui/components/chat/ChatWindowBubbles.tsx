/**
 * ChatWindowBubbles.tsx - Các bubble components dùng trong ChatWindow
 * Tách ra từ ChatWindow.tsx để giảm kích thước file.
 * Các components này là phiên bản ChatWindow-specific (khác với MessageBubbles.tsx).
 */
import React, {useState,} from 'react';
import {useChatStore} from '@/store/chatStore';
import {useAccountStore} from '@/store/accountStore';
import {useAppStore} from '@/store/appStore';
import ipc from '@/lib/ipc';
import DataAccessor from '@/lib/data/DataAccessor';
import {toLocalMediaUrl} from '@/lib/localMedia';
import {formatPhone} from '@/utils/phoneUtils';
import PhoneDisplay from '../common/PhoneDisplay';
import {convertZaloEmojis} from '@/lib/chat/emojiUtils';
import {isMediaType} from '@/lib/chat/messageTypeUtils';

// ─── EmployeeAvatar ────────────────────────────────────────────────
// Hiển thị avatar của nhân viên trong bong bóng chat (bên phải).
// Nếu avatar load lỗi (404) → fallback sang chữ cái đầu của tên.
export function EmployeeAvatar({name, avatarUrl}: { name: string; avatarUrl?: string }) {
    const [imgError, setImgError] = useState(false);
    if (!avatarUrl || imgError) {
        return (
            <div
                className="w-6 h-6 rounded-full bg-purple-600/30 flex items-center justify-center text-purple-300 text-[10px] font-bold ring-1 ring-purple-500/40 flex-shrink-0 self-end mb-0.5"
                title={`Gửi bởi: ${name}`}>
                {(name || 'N').charAt(0).toUpperCase()}
            </div>
        );
    }
    return (
        <img src={avatarUrl} alt={name}
             className="w-6 h-6 rounded-full object-cover ring-1 ring-purple-500/40 flex-shrink-0 self-end mb-0.5"
             title={`Gửi bởi: ${name}`}
             onError={() => setImgError(true)}
        />
    );
}


// extractUrlFromObj, extractQuoteImage, extractMediaUrl, parseQuoteMsg: imported from @/lib/chat/messageParser

// Type detection helpers: imported from @/lib/chat/messageTypeUtils

/** FileBubble - hiển thị tin nhắn file đính kèm (share.file) */
export function FileBubble({msg, isSent}: { msg: any; isSent: boolean }) {
    const [opening, setOpening] = React.useState(false);

    let fileTitle = '';
    let fileHref = '';
    let fileSize = '';
    let fileExt = '';
    try {
        const parsed = JSON.parse(msg.content || '{}');
        const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params || '{}') : (parsed.params || {});
        fileTitle = parsed.title || 'File';
        fileHref = parsed.href || '';
        fileSize = params.fileSize || '';
        fileExt = (params.fileExt || fileTitle.split('.').pop() || '').toLowerCase();
    } catch {
    }

    // Facebook: extract metadata from attachments column
    if (msg.channel === 'facebook' && (!fileTitle || fileTitle === 'File')) {
        try {
            const atts = JSON.parse(msg.attachments || '[]');
            if (atts.length > 0) {
                const a = atts[0];
                if (a.name) fileTitle = a.name;
                if (a.url && !fileHref) fileHref = a.url;
                if (a.fileSize != null && !fileSize) fileSize = String(a.fileSize);
                if (!fileExt && fileTitle) fileExt = fileTitle.split('.').pop()?.toLowerCase() || '';
            }
        } catch {
        }
        // Fallback: extract name from body text like "File: filename.ext"
        if (!fileTitle && msg.content) {
            const m = msg.content.match(/(?:📎|File:)\s*(.+)/);
            if (m) {
                fileTitle = m[1].trim();
                if (!fileExt) fileExt = fileTitle.split('.').pop()?.toLowerCase() || '';
            }
        }
    }

    let localFilePath = '';
    try {
        const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
        localFilePath = lp.file || lp.main || '';
    } catch {
    }

    // Facebook: also check localPath inside attachments (temp sending state)
    if (msg.channel === 'facebook' && !localFilePath) {
        try {
            const atts = JSON.parse(msg.attachments || '[]');
            if (atts.length > 0 && atts[0].localPath) localFilePath = atts[0].localPath;
        } catch {
        }
    }

    const handleOpen = async () => {
        if (opening) return;
        setOpening(true);
        try {
            if (localFilePath) await ipc.file?.openPath(localFilePath);
            else if (fileHref) ipc.shell?.openExternal(fileHref);
        } catch {
        } finally {
            setOpening(false);
        }
    };

    const handleOpenFolder = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!localFilePath) return;
        const parentDir = localFilePath.replace(/[/\\][^/\\]+$/, '');
        try {
            await ipc.file?.openPath(parentDir);
        } catch {
        }
    };

    const formatFileSize = (bytes: string | number): string => {
        const n = typeof bytes === 'string' ? parseInt(bytes) : bytes;
        if (!n || isNaN(n)) return '';
        if (n < 1024) return `${n} B`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(2)} KB`;
        return `${(n / 1024 / 1024).toFixed(2)} MB`;
    };

    const getFileIconAndColor = (ext: string): { icon: string; bg: string; text: string } => {
        const e = ext.toLowerCase();
        if (['pdf'].includes(e)) return {icon: 'PDF', bg: 'bg-red-600', text: 'text-white'};
        if (['doc', 'docx'].includes(e)) return {icon: 'DOC', bg: 'bg-blue-500', text: 'text-white'};
        if (['xls', 'xlsx', 'csv'].includes(e)) return {icon: 'XLS', bg: 'bg-green-600', text: 'text-white'};
        if (['ppt', 'pptx'].includes(e)) return {icon: 'PPT', bg: 'bg-orange-500', text: 'text-white'};
        if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) return {
            icon: 'ZIP',
            bg: 'bg-yellow-600',
            text: 'text-white'
        };
        if (['mp4', 'avi', 'mov', 'mkv', 'webm'].includes(e)) return {
            icon: 'VID',
            bg: 'bg-purple-600',
            text: 'text-white'
        };
        if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(e)) return {
            icon: 'AUD',
            bg: 'bg-pink-600',
            text: 'text-white'
        };
        if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(e)) return {
            icon: 'IMG',
            bg: 'bg-teal-600',
            text: 'text-white'
        };
        if (['txt', 'log'].includes(e)) return {icon: 'TXT', bg: 'bg-gray-500', text: 'text-white'};
        return {icon: e.toUpperCase().slice(0, 3) || '...', bg: 'bg-gray-500', text: 'text-white'};
    };

    const sizeText = formatFileSize(fileSize);
    const hasLocal = !!localFilePath;
    const canOpen = hasLocal || !!fileHref;
    const {icon, bg, text} = getFileIconAndColor(fileExt);

    return (
        <div className={`flex items-center gap-3 px-3 py-2.5 rounded-2xl min-w-[200px] max-w-xs ${
            isSent ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-200'
        }`}>
            {/* Colored file type icon box */}
            <button
                onClick={handleOpen}
                disabled={opening || !canOpen}
                className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 font-bold text-[11px] ${bg} ${text} ${canOpen ? 'hover:opacity-80 cursor-pointer' : 'cursor-default opacity-60'} transition-opacity`}
                title={canOpen ? 'Nhấn để mở' : ''}
            >
                {icon}
            </button>

            {/* File info */}
            <button
                onClick={handleOpen}
                disabled={opening || !canOpen}
                className="flex-1 min-w-0 text-left"
                title={canOpen ? 'Nhấn để mở' : ''}
            >
                <p className="text-sm font-medium truncate">{fileTitle}</p>
                <p className={`text-xs mt-0.5 flex items-center gap-1 ${isSent ? 'text-white-important' : 'text-gray-400'}`}>
                    {sizeText && <span>{sizeText}</span>}
                    {sizeText && hasLocal && <span>•</span>}
                    {opening ? <span>Đang mở...</span>
                        : hasLocal ? <>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2.5">
                                    <polyline points="20 6 9 17 4 12"/>
                                </svg>
                                <span>Đã có trên máy</span></>
                            : fileHref ? <span>Nhấn để tải</span>
                                : (msg.channel === 'facebook' && isSent) ? <span>✓ Đã gửi</span>
                                    : <span>Đang tải về...</span>}
                </p>
            </button>

            {/* Action buttons: folder + download */}
            <div className="flex items-center gap-1 flex-shrink-0">
                {hasLocal && (
                    <button onClick={handleOpenFolder} title="Mở thư mục"
                            className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors ${
                                isSent ? 'text-white-important hover:text-white hover:bg-blue-500' : 'text-gray-400 hover:text-white hover:bg-gray-600'
                            }`}>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2">
                            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                        </svg>
                    </button>
                )}
                <button onClick={handleOpen} disabled={opening || !canOpen} title={hasLocal ? 'Mở file' : 'Tải xuống'}
                        className={`w-7 h-7 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 ${
                            isSent ? 'text-white-important hover:text-white hover:bg-blue-500' : 'text-white-important hover:text-white hover:bg-gray-600'
                        }`}>
                    {hasLocal
                        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                               strokeWidth="2">
                            <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/>
                            <polyline points="15 3 21 3 21 9"/>
                            <line x1="10" y1="14" x2="21" y2="3"/>
                        </svg>
                        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                               strokeWidth="2">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                    }
                </button>
            </div>
        </div>
    );
}

/** Hiển thị bubble ảnh dùng React state - tự retry khi local_paths được cập nhật sau khi tải xong */
export function MediaBubble({msg, onView, isSent, allContacts, groupMembersList, onMentionClick}: {
    msg: any;
    onView: (src: string) => void;
    isSent?: boolean;
    allContacts?: any[];
    groupMembersList?: any[];
    onMentionClick?: (userId: string, e: React.MouseEvent) => void;
}) {
    // Remote-first: hiển thị CDN ngay lập tức, chuyển sang local sau khi tải xong
    // useLocal=true khi local_paths đã có → thử dùng file local (nhanh hơn, bền vững hơn)
    const [useLocal, setUseLocal] = React.useState(false);
    const [loadFailed, setLoadFailed] = React.useState(false);
    const [saving, setSaving] = React.useState(false);

    const localPathsStr = typeof msg.local_paths === 'string' ? msg.local_paths : JSON.stringify(msg.local_paths ?? '');
    React.useEffect(() => {
        setLoadFailed(false);
        // Chỉ dùng local khi local_paths thực sự có path (file đã tải về máy)
        try {
            const lp: Record<string, string> = JSON.parse(localPathsStr || '{}');
            const hasPath = !!(lp.main || lp.hd || (Object.values(lp)[0] as string));
            setUseLocal(hasPath);
        } catch {
            setUseLocal(false);
        }
    }, [localPathsStr]);

    // Parse local URL
    let localUrl = '';
    let localFilePath = '';
    try {
        const lp: Record<string, string> = typeof msg.local_paths === 'string'
            ? JSON.parse(msg.local_paths || '{}')
            : (msg.local_paths || {});
        localFilePath = lp.main || lp.hd || (Object.values(lp)[0] as string) || '';
        if (localFilePath) {
            localUrl = toLocalMediaUrl(localFilePath);
        }
    } catch {
    }

    // FB: use localPath from attachments for immediate preview
    let fbLocalUrls: string[] = [];
    if (msg.channel === 'facebook') {
        try {
            const atts = JSON.parse(msg.attachments || '[]');
            fbLocalUrls = atts.map((a: any) => a.localPath ? toLocalMediaUrl(a.localPath) : (a.url || '')).filter(Boolean);
            if (!localUrl && fbLocalUrls.length > 0) localUrl = fbLocalUrls[0];
        } catch {
        }
    }

    // Parse remote URL + caption
    let remoteUrl = '';
    let caption = '';
    try {
        const parsed = JSON.parse(msg.content || '{}');
        if (parsed && typeof parsed === 'object') {
            let paramsObj: any = parsed.params;
            if (typeof paramsObj === 'string') {
                try {
                    paramsObj = JSON.parse(paramsObj);
                } catch {
                    paramsObj = null;
                }
            }
            remoteUrl = paramsObj?.hd || paramsObj?.rawUrl || parsed.href || parsed.thumb || '';
            if (parsed.title && typeof parsed.title === 'string') {
                const t = parsed.title.trim();
                if (t && !t.startsWith('http')) caption = t;
            }
        }
    } catch {
    }
    if (!remoteUrl) {
        try {
            const attachments = JSON.parse(msg.attachments || '[]');
            remoteUrl = attachments[0]?.url || attachments[0]?.href || attachments[0]?.thumb || '';
        } catch {
        }
    }

    // Remote-first: CDN hiển thị ngay; chuyển local khi file đã tải xong
    // Nếu local lỗi (race condition file chưa kịp ghi) → tự fallback về CDN
    const displayUrl = useLocal ? (localUrl || remoteUrl) : (remoteUrl || localUrl);
    const viewUrl = remoteUrl || displayUrl;

    const handleImgError = () => {
        if (useLocal && remoteUrl) {
            setUseLocal(false); // local lỗi → fallback CDN ngay, không flash
        } else {
            setLoadFailed(true);
        }
    };

    const handleShowInFolder = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (localFilePath) await ipc.file?.showItemInFolder(localFilePath);
    };

    const handleSaveAs = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (saving) return;
        setSaving(true);
        try {
            const defaultName = localFilePath
                ? localFilePath.replace(/.*[/\\]/, '')
                : `img_${msg.msg_id || Date.now()}.jpg`;
            await ipc.file?.saveAs({
                localPath: localFilePath || undefined,
                remoteUrl: remoteUrl || undefined,
                defaultName,
            });
        } finally {
            setSaving(false);
        }
    };

    if (loadFailed) {
        return (
            <div
                className="flex flex-col items-center justify-center gap-1.5 max-w-xs w-full h-32 rounded-xl bg-gray-700/40 text-gray-400 select-none">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                     className="opacity-40">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                    <line x1="2" y1="2" x2="22" y2="22" strokeWidth="1.5"/>
                </svg>
                <span className="text-xs opacity-60">Không tải được ảnh</span>
                {remoteUrl && (
                    <button onClick={() => ipc.shell?.openExternal(remoteUrl)}
                            className="text-[11px] text-blue-400 hover:text-blue-300 hover:underline transition-colors">
                        Mở link Zalo
                    </button>
                )}
            </div>
        );
    }

    // Multi-image grid (FB batch send temp)
    if (fbLocalUrls.length > 1) {
        const cols = fbLocalUrls.length <= 2 ? 2 : fbLocalUrls.length <= 4 ? 2 : 3;
        return (
            <div className="grid gap-1 rounded-xl overflow-hidden"
                 style={{gridTemplateColumns: `repeat(${cols}, 1fr)`, maxWidth: 260}}>
                {fbLocalUrls.map((src, i) => (
                    <img key={i} src={src} alt="" onClick={() => onView(src)}
                         className="w-full aspect-square object-cover cursor-pointer hover:opacity-90 transition-opacity bg-gray-700/30"/>
                ))}
            </div>
        );
    }

    if (!displayUrl) {
        // Không có cả remote lẫn local - hiển thị placeholder tĩnh (không animation)
        return (
            <div
                className="flex items-center justify-center max-w-xs w-full h-32 rounded-xl bg-gray-700/40 text-gray-400 select-none">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                     className="opacity-30">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                </svg>
            </div>
        );
    }

    const imgNode = (
        <div className={`relative group/media max-w-xs overflow-hidden${caption ? ' rounded-t-xl' : ' rounded-xl'}`}>
            {/* aspect-ratio container giữ khung cố định trước khi ảnh load → không layout shift */}
            <div className="w-full aspect-[4/3] bg-gray-700/30">
                <img
                    src={displayUrl}
                    alt=""
                    className="w-full h-full object-contain cursor-pointer hover:opacity-90 transition-opacity"
                    onClick={() => onView(viewUrl)}
                    onError={handleImgError}
                />
            </div>
            {/* Viền mờ overlay - hiển thị rõ ở cả giao diện sáng lẫn tối */}
            <div
                className={`absolute inset-0 pointer-events-none ring-1 ring-inset ring-black/[0.12]${caption ? ' rounded-t-xl' : ' rounded-xl'}`}/>
            {/* Hover action buttons */}
            <div
                className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover/media:opacity-100 transition-opacity">
                {localFilePath && (
                    <button onClick={handleShowInFolder} title="Mở trong thư mục"
                            className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white-important transition-colors backdrop-blur-sm">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2">
                            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                        </svg>
                    </button>
                )}
                <button onClick={handleSaveAs} disabled={saving} title="Lưu về máy"
                        className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white-important transition-colors backdrop-blur-sm disabled:opacity-40">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                </button>
            </div>
        </div>
    );

    if (!caption) return imgNode;

    // With caption: wrap in bubble with bg matching sent/received style
    return (
        <div
            className={`flex flex-col rounded-2xl overflow-hidden ring-1 ring-black/[0.12]${isSent ? ' rounded-br-sm' : ' rounded-bl-sm'}`}>
            {imgNode}
            <div
                className={`px-3 py-2 text-sm break-words${isSent ? ' bg-blue-600 text-white' : ' bg-gray-700 text-gray-200'}`}>
                <TextWithMentions
                    text={caption}
                    allContacts={allContacts}
                    groupMembersList={groupMembersList}
                    onMentionClick={onMentionClick}
                />
            </div>
        </div>
    );
}

/** VideoBubble - hiển thị tin nhắn video với thumbnail và nút play */
export function VideoBubble({msg, isSent}: { msg: any; isSent: boolean }) {
    const [saving, setSaving] = React.useState(false);
    // local-first thumbnail; fallback remote khi local chưa tải hoặc lỗi
    const [thumbSrcMode, setThumbSrcMode] = React.useState<'local' | 'remote'>('local');

    const localPathsStr = typeof msg.local_paths === 'string' ? msg.local_paths : JSON.stringify(msg.local_paths ?? '');
    React.useEffect(() => {
        setThumbSrcMode('local');
    }, [localPathsStr]);

    // Parse local paths
    let thumbLocalPath = '';
    let videoLocalPath = '';
    try {
        const lp: Record<string, string> = typeof msg.local_paths === 'string'
            ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
        thumbLocalPath = lp.thumb || lp.main || '';
        videoLocalPath = lp.file || lp.video || '';
    } catch {
    }

    // Parse remote URLs từ content
    let remoteThumb = '';
    let remoteVideo = '';
    let duration = 0;
    let width = 0;
    let height = 0;
    try {
        const parsed = JSON.parse(msg.content || '{}');
        remoteThumb = parsed.thumb || '';
        remoteVideo = parsed.href || '';
        const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
        duration = params.duration ? Math.round(params.duration / 1000) : 0;
        width = params.video_width || 0;
        height = params.video_height || 0;
    } catch {
    }

    const localThumbUrl = thumbLocalPath ? toLocalMediaUrl(thumbLocalPath) : '';
    // Local-first: ưu tiên local; fallback remote khi local lỗi (file chưa tải xong)
    const thumbUrl = thumbSrcMode === 'remote'
        ? (remoteThumb || localThumbUrl)
        : (localThumbUrl || remoteThumb);

    const handlePlay = async (e: React.MouseEvent) => {
        e.stopPropagation();
        // Mở video local trước, nếu không có thì mở remote
        if (videoLocalPath) {
            await ipc.file?.openPath(videoLocalPath);
        } else if (remoteVideo) {
            ipc.shell?.openExternal(remoteVideo);
        }
    };

    const handleOpenFolder = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (videoLocalPath) {
            const parentDir = videoLocalPath.replace(/[/\\][^/\\]+$/, '');
            await ipc.file?.openPath(parentDir);
        }
    };

    const handleSaveAs = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (saving) return;
        setSaving(true);
        try {
            const defaultName = videoLocalPath
                ? videoLocalPath.replace(/.*[/\\]/, '')
                : `video_${msg.msg_id || Date.now()}.mp4`;
            await ipc.file?.saveAs({
                localPath: videoLocalPath || undefined,
                remoteUrl: remoteVideo || undefined,
                defaultName,
            });
        } finally {
            setSaving(false);
        }
    };

    const formatDuration = (s: number) => {
        if (!s) return '';
        const m = Math.floor(s / 60);
        const sec = s % 60;
        return `${m}:${sec.toString().padStart(2, '0')}`;
    };

    const isHD = width >= 720 || height >= 720;
    const aspectRatio = width && height ? width / height : 16 / 9;
    const displayHeight = Math.min(200, Math.round(280 / aspectRatio));

    return (
        <div
            className="relative group/video cursor-pointer rounded-xl overflow-hidden bg-black ring-1 ring-black/[0.12]"
            style={{width: '17.5rem', height: displayHeight || 160}}
            onClick={handlePlay}
        >
            {/* Thumbnail */}
            {thumbUrl ? (
                <img
                    src={thumbUrl}
                    alt=""
                    className="w-full h-full object-cover"
                    onError={(e) => {
                        if (thumbSrcMode === 'local' && remoteThumb && remoteThumb !== thumbUrl) {
                            setThumbSrcMode('remote'); // Local lỗi → thử remote Zalo CDN
                        } else {
                            (e.target as HTMLImageElement).style.display = 'none'; // Cả hai lỗi → ẩn
                        }
                    }}
                />
            ) : (
                <div className="w-full h-full bg-gray-800 flex items-center justify-center">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                         className="text-gray-400">
                        <polygon points="23 7 16 12 23 17 23 7"/>
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                    </svg>
                </div>
            )}

            {/* Overlay gradient */}
            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/50"/>

            {/* Play button ở giữa */}
            <div className="absolute inset-0 flex items-center justify-center">
                <div
                    className="w-14 h-14 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center group-hover/video:bg-black/80 transition-colors shadow-lg">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                </div>
            </div>

            {/* Duration + HD badge - bottom left */}
            <div className="absolute bottom-2 left-2 flex items-center gap-1.5">
                {duration > 0 && (
                    <span className="text-[11px] text-white font-medium bg-black/50 px-1.5 py-0.5 rounded">
            {formatDuration(duration)}
          </span>
                )}
                {isHD && (
                    <span className="text-[11px] text-white font-bold bg-blue-600/70 px-1.5 py-0.5 rounded">HD</span>
                )}
                {!videoLocalPath && (
                    <span className="text-[11px] text-yellow-300 bg-black/50 px-1.5 py-0.5 rounded">Đang tải...</span>
                )}
            </div>

            {/* Action buttons - top right, on hover */}
            <div
                className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover/video:opacity-100 transition-opacity">
                {videoLocalPath && (
                    <button onClick={handleOpenFolder} title="Mở thư mục"
                            className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white-important transition-colors">
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2">
                            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                        </svg>
                    </button>
                )}
                <button onClick={handleSaveAs} disabled={saving} title="Lưu về máy"
                        className="w-7 h-7 bg-black/60 hover:bg-black/80 rounded-lg flex items-center justify-center text-white-important transition-colors disabled:opacity-40">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                        <polyline points="7 10 12 15 17 10"/>
                        <line x1="12" y1="15" x2="12" y2="3"/>
                    </svg>
                </button>
            </div>
        </div>
    );
}

/** VoiceBubble - hiển thị tin nhắn ghi âm (chat.voice) */
export function VoiceBubble({msg, isSent}: { msg: any; isSent: boolean }) {
    const [isPlaying, setIsPlaying] = React.useState(false);
    const [progress, setProgress] = React.useState(0);
    const [currentTime, setCurrentTime] = React.useState(0);
    const [duration, setDuration] = React.useState(0);
    const audioRef = React.useRef<HTMLAudioElement | null>(null);
    const animRef = React.useRef<number>(0);

    // Parse voice URL + duration from Zalo message content (memo to avoid re-parse)
    const {voiceUrl, paramsDurationSec, localPath} = React.useMemo(() => {
        let _voiceUrl = '';
        let _paramsDur = 0;
        try {
            const parsed = JSON.parse(msg.content || '{}');
            _voiceUrl = parsed.href || '';
            const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params || '{}') : (parsed.params || {});
            if (!_voiceUrl) {
                _voiceUrl = params.m4a || params.url || '';
            }
            // Zalo lưu duration dạng ms (vd: 5000 = 5s) hoặc giây
            const rawDur = Number(params.duration || params.dur || 0);
            _paramsDur = rawDur > 300 ? rawDur / 1000 : rawDur;
        } catch {
        }

        let _localPath = '';
        try {
            const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
            _localPath = lp.file || lp.voice || lp.main || '';
        } catch {
        }

        return {voiceUrl: _voiceUrl, paramsDurationSec: _paramsDur, localPath: _localPath};
    }, [msg.content, msg.local_paths]);

    // Sync duration from params khi chưa có audio metadata
    React.useEffect(() => {
        if (paramsDurationSec > 0 && duration === 0) {
            setDuration(paramsDurationSec);
        }
    }, [paramsDurationSec]);

    const audioSrc = localPath ? toLocalMediaUrl(localPath) : voiceUrl;

    const formatDur = (s: number) => {
        if (!s || !isFinite(s)) return '0:00';
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${m}:${sec.toString().padStart(2, '0')}`;
    };

    const tick = React.useCallback(() => {
        const audio = audioRef.current;
        if (audio && isPlaying) {
            const ct = audio.currentTime;
            const dur = audio.duration || duration || 1;
            setCurrentTime(ct);
            setProgress(ct / dur);
            animRef.current = requestAnimationFrame(tick);
        }
    }, [isPlaying, duration]);

    React.useEffect(() => {
        if (isPlaying) {
            animRef.current = requestAnimationFrame(tick);
        }
        return () => cancelAnimationFrame(animRef.current);
    }, [isPlaying, tick]);

    const togglePlay = () => {
        const audio = audioRef.current;
        if (!audio) return;
        if (isPlaying) {
            audio.pause();
            setIsPlaying(false);
        } else {
            audio.play().then(() => setIsPlaying(true)).catch(() => {
            });
        }
    };

    const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
        const audio = audioRef.current;
        if (!audio || !audio.duration) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
        audio.currentTime = pct * audio.duration;
        setProgress(pct);
        setCurrentTime(audio.currentTime);
    };

    return (
        <div className={`flex items-center gap-2.5 px-3 py-2 rounded-2xl min-w-[200px] max-w-[280px] ${
            isSent ? 'bg-blue-600' : 'bg-gray-700'
        }`}>
            <audio
                ref={audioRef}
                src={audioSrc}
                preload="metadata"
                onLoadedMetadata={(e) => {
                    const audioDur = (e.target as HTMLAudioElement).duration;
                    if (audioDur && isFinite(audioDur)) setDuration(audioDur);
                }}
                onEnded={() => {
                    setIsPlaying(false);
                    setProgress(0);
                    setCurrentTime(0);
                }}
            />

            {/* Play/Pause button */}
            <button onClick={togglePlay}
                    className="w-9 h-9 rounded-full bg-white/20 hover:bg-white/30 flex items-center justify-center flex-shrink-0 transition-colors">
                {isPlaying ? (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                        <rect x="6" y="4" width="4" height="16" rx="1"/>
                        <rect x="14" y="4" width="4" height="16" rx="1"/>
                    </svg>
                ) : (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="white">
                        <polygon points="5 3 19 12 5 21 5 3"/>
                    </svg>
                )}
            </button>

            {/* Waveform / progress */}
            <div className="flex-1 flex flex-col gap-1">
                <div className="relative h-6 flex items-center cursor-pointer" onClick={handleSeek}>
                    <div className="flex items-center gap-[2px] w-full h-full">
                        {Array.from({length: 24}, (_, i) => {
                            const h = [3, 5, 8, 4, 10, 6, 12, 5, 9, 4, 11, 7, 6, 10, 5, 8, 4, 12, 6, 9, 5, 7, 4, 6][i] || 5;
                            const filled = i / 24 < progress;
                            return (
                                <div
                                    key={i}
                                    className={`rounded-full transition-colors duration-100 ${filled ? 'bg-white' : 'bg-white/30'}`}
                                    style={{width: '0.125rem', height: h * 1.5, minHeight: '0.1875rem'}}
                                />
                            );
                        })}
                    </div>
                </div>
                <span className="text-[10px] text-white/70 font-mono tabular-nums leading-none">
          {isPlaying ? formatDur(currentTime) : formatDur(duration)}
        </span>
            </div>

            {/* Mic icon */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 className="text-white/50 flex-shrink-0">
                <path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z"/>
                <path d="M19 10v2a7 7 0 01-14 0v-2"/>
            </svg>
        </div>
    );
}

/** Preview sticker nhỏ dùng trong khung trích dẫn (quote) - tải URL từ DB cache hoặc API */
export function QuotedStickerPreview({content}: { content: string }) {
    const [stickerUrl, setStickerUrl] = React.useState<string | null>(null);

    React.useEffect(() => {
        let cancelled = false;

        // Try direct URL from content first (params.staticIcon / params.icon)
        try {
            const c = JSON.parse(content || '{}');
            const params = typeof c.params === 'string' ? JSON.parse(c.params) : (c.params || {});
            const directUrl = params?.staticIcon || params?.icon || c?.stickerUrl || c?.icon || '';
            if (directUrl) {
                setStickerUrl(directUrl);
                return;
            }
        } catch {
        }

        const load = async () => {
            let stickerId: number | null = null;
            try {
                const parsed = JSON.parse(content || '{}');
                stickerId = parsed?.id ?? parsed?.sticker_id ?? null;
            } catch {
            }
            if (!stickerId) return;

            // DB cache lookup
            try {
                const res = await DataAccessor.getStickerById(stickerId);
                if (res?.sticker?.stickerUrl && !res.sticker._unsupported) {
                    if (!cancelled) setStickerUrl(res.sticker.stickerUrl);
                    return;
                }
            } catch {
            }

            // Fallback: fetch from API
            try {
                const accountsRes = await ipc.login?.getAccounts();
                const accounts: any[] = accountsRes?.accounts || [];
                const active = accounts.find((a: any) => a.is_active) || accounts[0];
                if (!active) return;
                const auth = {cookies: active.cookies, imei: active.imei, userAgent: active.user_agent};
                const detailRes = await ipc.zalo?.getStickersDetail({auth, stickerIds: [stickerId]});
                const stickers: any[] = detailRes?.response || [];
                if (stickers.length && stickers[0]?.stickerUrl) {
                    if (!cancelled) setStickerUrl(stickers[0].stickerUrl);
                    DataAccessor.saveStickers({stickers}).catch(() => {
                    });
                }
            } catch {
            }
        };
        load();
        return () => {
            cancelled = true;
        };
    }, [content]);

    if (!stickerUrl) {
        return (
            <div
                className="w-12 h-12 rounded-lg bg-gray-700/50 flex items-center justify-center animate-pulse flex-shrink-0">
                <span className="text-lg">🎭</span>
            </div>
        );
    }
    return <img src={stickerUrl} alt="sticker" className="w-12 h-12 object-contain rounded-lg flex-shrink-0"/>;
}

/** Hiển thị nhiều sticker liền nhau từ cùng người gửi trong 30 phút - mỗi sticker có thể right-click riêng */
export function StickerGroupBubble({
                                       msgs: groupMsgs,
                                       onContextMenu,
                                   }: {
    msgs: any[];
    onContextMenu: (e: React.MouseEvent, msg: any) => void;
}) {
    // w-28 = 112px × 3 + gap-1.5 (6px) × 2 = 348px → maxWidth 22rem = 352px đủ để hiện 3/dòng
    return (
        <div className="flex flex-wrap gap-1.5" style={{maxWidth: '22rem'}}>
            {groupMsgs.map((stickerMsg) => (
                <div
                    key={stickerMsg.msg_id}
                    onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        onContextMenu(e, stickerMsg);
                    }}
                    className="cursor-default select-none"
                >
                    <StickerBubble msg={stickerMsg}/>
                </div>
            ))}
        </div>
    );
}

/** Trích xuất groupLayoutId từ tin nhắn ảnh gửi theo nhóm (is_group_layout=1) */
export function getGroupLayoutId(msg: any): string | null {
    if (!isMediaType(msg.msg_type, msg.content)) return null;
    try {
        const parsed = JSON.parse(msg.content || '{}');
        const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
        if (params.is_group_layout && params.group_layout_id) return String(params.group_layout_id);
    } catch {
    }
    return null;
}

/** Hiển thị nhóm ảnh gửi cùng 1 batch - tối đa 4 ảnh/hàng, chiều cao cố định */
export function MediaGroupBubble({
                                     msgs: groupMsgs,
                                     onView,
                                     isSelecting: isSelectingProp,
                                     selectedMsgIds: selectedMsgIdsProp,
                                     onToggleSelect
                                 }: {
    msgs: any[]; onView: (src: string) => void;
    isSelecting?: boolean; selectedMsgIds?: Set<string>; onToggleSelect?: (msgId: string) => void;
}) {
    const sorted = React.useMemo(() => {
        return [...groupMsgs].sort((a, b) => {
            try {
                const pa = JSON.parse(a.content || '{}');
                const ppa = typeof pa.params === 'string' ? JSON.parse(pa.params) : (pa.params || {});
                const pb = JSON.parse(b.content || '{}');
                const ppb = typeof pb.params === 'string' ? JSON.parse(pb.params) : (pb.params || {});
                return (ppa.id_in_group || 0) - (ppb.id_in_group || 0);
            } catch {
                return 0;
            }
        });
    }, [groupMsgs]);

    // Chia thành hàng, mỗi hàng tối đa 4 ảnh
    const rows: any[][] = [];
    for (let i = 0; i < sorted.length; i += 4) rows.push(sorted.slice(i, i + 4));

    return (
        <div className="flex flex-col gap-0.5 overflow-hidden rounded-xl max-w-xs ring-1 ring-black/[0.12]">
            {rows.map((row, ri) => (
                <div key={ri} className="flex gap-0.5">
                    {row.map((m) => (
                        <SingleImageInGroup key={m.msg_id} msg={m} onView={onView} isSelecting={isSelectingProp}
                                            isSelected={selectedMsgIdsProp?.has(m.msg_id)}
                                            onToggleSelect={onToggleSelect}/>
                    ))}
                </div>
            ))}
        </div>
    );
}

/** Ảnh đơn bên trong MediaGroupBubble - chiều cao cố định h-40 */
export function SingleImageInGroup({msg, onView, isSelecting: isSelectingProp, isSelected, onToggleSelect}: {
    msg: any; onView: (src: string) => void;
    isSelecting?: boolean; isSelected?: boolean; onToggleSelect?: (msgId: string) => void;
}) {
    // Remote-first: hiển thị CDN ngay; chuyển local khi file đã tải xong
    const [useLocal, setUseLocal] = React.useState(false);
    const [loadFailed, setLoadFailed] = React.useState(false);
    const [saving, setSaving] = React.useState(false);

    const localPathsStr = typeof msg.local_paths === 'string' ? msg.local_paths : JSON.stringify(msg.local_paths ?? '');
    React.useEffect(() => {
        setLoadFailed(false);
        try {
            const lp: Record<string, string> = JSON.parse(localPathsStr || '{}');
            const hasPath = !!(lp.main || lp.hd || (Object.values(lp)[0] as string));
            setUseLocal(hasPath);
        } catch {
            setUseLocal(false);
        }
    }, [localPathsStr]);

    let localUrl = '';
    let localFilePath = '';
    try {
        const lp: Record<string, string> = typeof msg.local_paths === 'string'
            ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
        localFilePath = lp.main || lp.hd || (Object.values(lp)[0] as string) || '';
        if (localFilePath) localUrl = toLocalMediaUrl(localFilePath);
    } catch {
    }

    // FB: use localPath from attachments for immediate preview
    let fbLocalUrls: string[] = [];
    if (msg.channel === 'facebook') {
        try {
            const atts = JSON.parse(msg.attachments || '[]');
            fbLocalUrls = atts.map((a: any) => a.localPath ? toLocalMediaUrl(a.localPath) : (a.url || '')).filter(Boolean);
            if (!localUrl && fbLocalUrls.length > 0) localUrl = fbLocalUrls[0];
        } catch {
        }
    }

    let remoteUrl = '';
    try {
        const parsed = JSON.parse(msg.content || '{}');
        if (parsed && typeof parsed === 'object') {
            const params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
            remoteUrl = params.hd || params.rawUrl || parsed.href || parsed.thumb || '';
        }
    } catch {
    }
    // FB fallback: lấy URL từ attachments
    if (!remoteUrl && msg.channel === 'facebook') {
        try {
            const attachments = JSON.parse(msg.attachments || '[]');
            remoteUrl = attachments[0]?.url || attachments[0]?.href || attachments[0]?.thumb || '';
        } catch {
        }
    }

    // Remote-first: CDN hiển thị ngay; chuyển local khi file đã tải xong
    const displayUrl = useLocal ? (localUrl || remoteUrl) : (remoteUrl || localUrl);
    const viewUrl = remoteUrl || displayUrl;

    const handleImgError = () => {
        if (useLocal && remoteUrl) {
            setUseLocal(false); // local lỗi → fallback CDN ngay
        } else setLoadFailed(true);
    };

    const handleSaveAs = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (saving) return;
        setSaving(true);
        try {
            const defaultName = localFilePath
                ? localFilePath.replace(/.*[/\\]/, '')
                : `img_${msg.msg_id || Date.now()}.jpg`;
            await ipc.file?.saveAs({
                localPath: localFilePath || undefined,
                remoteUrl: remoteUrl || undefined,
                defaultName
            });
        } finally {
            setSaving(false);
        }
    };

    if (loadFailed || !displayUrl) {
        return (
            <div
                className="h-40 flex-1 min-w-0 bg-gray-700/50 flex items-center justify-center text-gray-400 select-none">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                     className="opacity-30">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                    {loadFailed && <line x1="2" y1="2" x2="22" y2="22"/>}
                </svg>
            </div>
        );
    }
    const handleClick = (e: React.MouseEvent) => {
        if (isSelectingProp) {
            e.stopPropagation();
            onToggleSelect?.(msg.msg_id);
        } else {
            onView(viewUrl);
        }
    };

    return (
        <div
            className={`relative flex-1 min-w-0 group/singleimg cursor-pointer${isSelected ? ' ring-2 ring-blue-500' : ''}`}
            onClick={handleClick}
        >
            <img
                src={displayUrl}
                alt=""
                className={`h-40 w-full object-cover transition-opacity bg-gray-700/30${isSelectingProp ? '' : ' hover:opacity-90'}`}
                onError={handleImgError}
            />
            {/* Selection overlay */}
            {isSelectingProp && isSelected && (
                <div className="absolute inset-0 bg-blue-500/30 flex items-center justify-center pointer-events-none">
                    <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                            <polyline points="20 6 9 17 4 12"/>
                        </svg>
                    </div>
                </div>
            )}
            {/* Viền overlay - hiển thị ở cả giao diện sáng lẫn tối */}
            <div className="absolute inset-0 pointer-events-none ring-1 ring-inset ring-black/[0.12]"/>
            {/* Hover action buttons - hidden in selection mode */}
            {!isSelectingProp && (
                <div
                    className="absolute top-1 right-1 flex gap-0.5 opacity-0 group-hover/singleimg:opacity-100 transition-opacity">
                    {localFilePath && (
                        <button onClick={(e) => {
                            e.stopPropagation();
                            ipc.file?.showItemInFolder(localFilePath);
                        }}
                                title="Mở trong thư mục"
                                className="w-6 h-6 bg-black/60 hover:bg-black/80 rounded-md flex items-center justify-center text-white-important transition-colors">
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                 strokeWidth="2">
                                <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                            </svg>
                        </button>
                    )}
                    <button onClick={handleSaveAs} disabled={saving} title="Lưu về máy"
                            className="w-6 h-6 bg-black/60 hover:bg-black/80 rounded-md flex items-center justify-center text-white-important transition-colors disabled:opacity-40">
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2">
                            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                    </button>
                </div>
            )}
        </div>
    );
}

/** StickerBubble - hiển thị sticker với lazy load từ DB cache hoặc API */
export function StickerBubble({msg}: { msg: any }) {
    const [stickerUrl, setStickerUrl] = React.useState<string | null>(null);
    const [failed, setFailed] = React.useState(false);
    const [unsupported, setUnsupported] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;

        // ── Facebook sticker ────────────────────────────────────────────────
        if (msg.channel === 'facebook') {
            // Check local file trước (đã được download từ main process)
            try {
                const lp: Record<string, string> = typeof msg.local_paths === 'string'
                    ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
                const localFile = lp.main || (Object.values(lp)[0] as string) || '';
                if (localFile) {
                    const localUrl = toLocalMediaUrl(localFile);
                    if (localUrl) {
                        // Reset failed trước đó (set ở lần effect chạy đầu khi chưa có local_paths)
                        setFailed(false);
                        setStickerUrl(localUrl);
                        return;
                    }
                }
            } catch {
            }

            // E2EE sticker không có directPath → unsupported (bridge không cung cấp)
            try {
                const atts = JSON.parse(msg.attachments || '[]');
                const hasDirectPath = atts[0]?.directPath;
                if (!hasDirectPath && !atts[0]?.url) {
                    if (!cancelled) setUnsupported(true);
                    return;
                }
            } catch {
            }

            // Có directPath nhưng chưa có local file → đang download, giữ loading
            if (!cancelled && !stickerUrl) setFailed(true);
            return;
        }

        // ── Zalo sticker ────────────────────────────────────────────────────
        const load = async () => {
            let stickerId: number | null = null;
            try {
                const parsed = JSON.parse(msg.content || '{}');
                stickerId = parsed?.id ?? parsed?.sticker_id ?? null;
            } catch {
            }
            if (!stickerId) {
                if (!cancelled) setFailed(true);
                return;
            }

            // 1. Check DB cache first (includes unsupported flag)
            try {
                const res = await DataAccessor.getStickerById(stickerId);
                if (res?.sticker) {
                    if (res.sticker._unsupported) {
                        if (!cancelled) setUnsupported(true);
                        return;
                    }
                    if (res.sticker.stickerUrl) {
                        if (!cancelled) setStickerUrl(res.sticker.stickerUrl);
                        return;
                    }
                }
            } catch {
            }

            // 2. Fetch from API using the active account session
            try {
                const accountsRes = await ipc.login?.getAccounts();
                const accounts: any[] = accountsRes?.accounts || [];
                const active = accounts.find((a: any) => a.is_active) || accounts[0];
                if (!active) {
                    if (!cancelled) setFailed(true);
                    return;
                }
                const auth = {cookies: active.cookies, imei: active.imei, userAgent: active.user_agent};
                const detailRes = await ipc.zalo?.getStickersDetail({auth, stickerIds: [stickerId]});
                if (!detailRes?.success) {
                    ipc.db?.markStickerUnsupported({stickerId}).catch(() => {
                    });
                    if (!cancelled) setUnsupported(true);
                    return;
                }
                const stickers: any[] = detailRes?.response || [];
                if (stickers.length && stickers[0]?.stickerUrl) {
                    if (!cancelled) setStickerUrl(stickers[0].stickerUrl);
                    DataAccessor.saveStickers({stickers}).catch(() => {
                    });
                } else {
                    ipc.db?.markStickerUnsupported({stickerId}).catch(() => {
                    });
                    if (!cancelled) setUnsupported(true);
                }
            } catch {
                ipc.db?.markStickerUnsupported({stickerId: stickerId!}).catch(() => {
                });
                if (!cancelled) setUnsupported(true);
            }
        };
        load();
        return () => {
            cancelled = true;
        };
    }, [msg.content, msg.local_paths, msg.attachments]);

    if (unsupported) {
        return (
            <div
                className="w-28 h-28 rounded-xl bg-gray-700/30 border border-gray-600/30 flex flex-col items-center justify-center gap-1">
                <span className="text-2xl opacity-40">🎭</span>
                <span className="text-[10px] text-gray-400 text-center px-1 leading-tight">Sticker chưa hỗ trợ</span>
            </div>
        );
    }

    if (failed) return <span className="text-xs text-gray-400 px-2 py-1">[Sticker]</span>;

    if (!stickerUrl) {
        return (
            <div className="w-28 h-28 rounded-xl bg-gray-700/50 flex items-center justify-center animate-pulse">
                <span className="text-2xl">🎭</span>
            </div>
        );
    }

    return (
        <img
            src={stickerUrl}
            alt="sticker"
            className="w-28 h-28 object-contain rounded-xl"
            onError={() => setFailed(true)}
        />
    );
}

// parseContent, formatMsgTime: imported from @/lib/chat/messageParser

// ─── MsgActionBtn ────────────────────────────────────────────────────────────
export function MsgActionBtn({title, onClick, children}: {
    title: string;
    onClick: ((e: React.MouseEvent) => void) | (() => void);
    children: React.ReactNode;
}) {
    return (
        <button
            title={title}
            onClick={onClick as React.MouseEventHandler}
            className="w-7 h-7 flex items-center justify-center rounded-full text-gray-400 hover:text-white hover:bg-gray-600 transition-colors flex-shrink-0"
        >
            {children}
        </button>
    );
}

// ─── CardBubble - dispatches to LinkBubble, CallBubble or ContactCardBubble ───
// ─── EcardBubble - thông báo hệ thống dạng thẻ (vd: trở thành phó nhóm, nhắc hẹn) ─────
export function EcardBubble({msg, onManage}: { msg: any; onManage?: () => void }) {
    let parsed: any = {};
    try {
        parsed = JSON.parse(msg.content || '{}');
    } catch {
    }

    const title: string = parsed.title || '';
    const description: string = parsed.description || '';
    const imageHref: string = parsed.href || '';
    let params: any = {};
    try {
        params = typeof parsed.params === 'string' ? JSON.parse(parsed.params) : (parsed.params || {});
    } catch {
    }

    // ── Detect reminder card (action.open.reminder) ──
    const isReminderCard = (params.actions || []).some(
        (a: any) => a.actionId === 'action.open.reminder'
    );

    if (isReminderCard) {
        // Parse reminder details from action data
        let reminderData: any = {};
        const reminderAction = (params.actions || []).find((a: any) => a.actionId === 'action.open.reminder');
        try {
            if (reminderAction?.data) {
                const outerData = typeof reminderAction.data === 'string' ? JSON.parse(reminderAction.data) : reminderAction.data;
                if (outerData?.data) {
                    reminderData = typeof outerData.data === 'string' ? JSON.parse(outerData.data) : outerData.data;
                }
            }
        } catch {
        }

        const startTime = Number(reminderData.startTime || 0);
        const repeat: number = Number(reminderData.repeat ?? 0);
        const repeatText = repeat === 1 ? 'Nhắc theo ngày' : repeat === 2 ? 'Nhắc theo tuần' : repeat === 3 ? 'Nhắc theo tháng' : '';
        const emoji = reminderData.emoji || '⏰';

        const formatReminderDateFull = (ts: number) => {
            if (!ts) return description || '';
            const d = new Date(ts);
            const pad = (n: number) => n.toString().padStart(2, '0');
            const weekDays = ['Chủ Nhật', 'Thứ Hai', 'Thứ Ba', 'Thứ Tư', 'Thứ Năm', 'Thứ Sáu', 'Thứ Bảy'];
            const months = ['tháng 1', 'tháng 2', 'tháng 3', 'tháng 4', 'tháng 5', 'tháng 6', 'tháng 7', 'tháng 8', 'tháng 9', 'tháng 10', 'tháng 11', 'tháng 12'];
            return `${weekDays[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]} lúc ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        };

        const formatDayNum = (ts: number) => ts ? new Date(ts).getDate() : '';
        const formatMonth = (ts: number) => {
            if (!ts) return '';
            const d = new Date(ts);
            const months = ['THÁNG 1', 'THÁNG 2', 'THÁNG 3', 'THÁNG 4', 'THÁNG 5', 'THÁNG 6', 'THÁNG 7', 'THÁNG 8', 'THÁNG 9', 'THÁNG 10', 'THÁNG 11', 'THÁNG 12'];
            return months[d.getMonth()];
        };
        const formatWeekDay = (ts: number) => {
            if (!ts) return '';
            const days = ['CHỦ NHẬT', 'THỨ HAI', 'THỨ BA', 'THỨ TƯ', 'THỨ NĂM', 'THỨ SÁU', 'THỨ BẢY'];
            return days[new Date(ts).getDay()];
        };

        // Extract reminder title from params.notifyTxt or card title
        const reminderTitle = (params.notifyTxt || title || '').replace(/^(?:[⏰📅🔔⭐📌💡🎯🎉]|Clock:|Calendar:|Bell:|Star:|Pin:|Lightbulb:|Target:)\s*/i, '');

        return (
            <div className="flex justify-center w-full my-1">
                <div
                    className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden max-w-[300px] w-full shadow-lg">
                    {/* Reminder card body */}
                    <div className="flex gap-3 p-4">
                        {/* Calendar icon */}
                        {startTime > 0 && (
                            <div
                                className="flex-shrink-0 w-14 rounded-xl overflow-hidden border border-gray-600 bg-gray-750 flex flex-col items-center">
                                <div
                                    className="w-full bg-blue-600 py-0.5 text-center text-white text-[11px] font-bold tracking-wide">
                                    {formatWeekDay(startTime)}
                                </div>
                                <div className="flex-1 flex flex-col items-center justify-center py-1">
                                    <span
                                        className="text-white text-2xl font-bold leading-none">{formatDayNum(startTime)}</span>
                                    <span className="text-gray-400 text-[11px] mt-0.5">{formatMonth(startTime)}</span>
                                </div>
                            </div>
                        )}
                        {/* Info */}
                        <div className="flex-1 min-w-0">
                            <p className="text-white font-semibold text-sm truncate">{emoji} {reminderTitle}</p>
                            {/* Time */}
                            <div className="flex items-center gap-1 mt-1 text-xs text-gray-400">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2">
                                    <circle cx="12" cy="12" r="10"/>
                                    <polyline points="12 6 12 12 16 14"/>
                                </svg>
                                <span>{startTime ? formatReminderDateFull(startTime) : description}</span>
                            </div>
                            {/* Repeat */}
                            {repeatText && (
                                <div className="flex items-center gap-1 mt-0.5 text-xs text-orange-400">
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                         strokeWidth="2.5">
                                        <path d="M17 1l4 4-4 4"/>
                                        <path d="M3 11V9a4 4 0 014-4h14"/>
                                        <path d="M7 23l-4-4 4-4"/>
                                        <path d="M21 13v2a4 4 0 01-4 4H3"/>
                                    </svg>
                                    <span>{repeatText}</span>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    // ── Standard ecard (group events etc.) ──
    const actions: any[] = (params.actions || []).filter(
        (a: any) => a.actionId === 'action.group.open.admintool'
    );

    return (
        <div className="flex justify-center w-full my-1">
            <div
                className="bg-gray-800 border border-gray-700 rounded-2xl overflow-hidden max-w-[280px] w-full shadow-lg">
                {/* Ảnh header */}
                {imageHref && (
                    <div className="w-full h-28 overflow-hidden bg-gray-700">
                        <img
                            src={imageHref}
                            alt={title}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                            }}
                        />
                    </div>
                )}
                {/* Nội dung */}
                <div className="px-4 py-3 space-y-1">
                    {title && (
                        <p className="text-white font-semibold text-sm leading-snug">{title}</p>
                    )}
                    {description && (
                        <p className="text-gray-400 text-xs leading-relaxed">{description}</p>
                    )}
                </div>
                {/* Actions - chỉ nút Quản lý nhóm */}
                {actions.length > 0 && onManage && (
                    <div className="border-t border-gray-700">
                        {actions.map((a: any, i: number) => (
                            <button
                                key={i}
                                onClick={onManage}
                                className="w-full px-4 py-2.5 text-sm text-blue-400 hover:bg-gray-700 hover:text-blue-300 transition-colors font-medium text-center"
                            >
                                {a.name || 'Quản lý nhóm'}
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export function CardBubble({msg, isSent, onOpenProfile}: {
    msg: any;
    isSent: boolean;
    onOpenProfile?: (userId: string, e: React.MouseEvent) => void
}) {
    let parsed: any = {};
    try {
        parsed = JSON.parse(msg.content || '{}');
    } catch {
    }
    const action = String(parsed.action || '');
    if (action === 'recommened.link') return <LinkBubble parsed={parsed} isSent={isSent}/>;
    // recommened.calltime = cuộc gọi có thời gian, recommened.misscall = cuộc gọi nhỡ
    if (action === 'recommened.calltime' || action === 'recommened.misscall') return <CallBubble parsed={parsed}
                                                                                                 isSent={isSent}/>;
    return <ContactCardBubble parsed={parsed} isSent={isSent} onOpenProfile={onOpenProfile}/>;
}

// ─── LinkBubble - hiển thị tin nhắn link preview như Zalo ────────────────────
export function LinkBubble({parsed, isSent}: { parsed: any; isSent: boolean }) {
    const href = String(parsed.href || parsed.title || '');
    const params = (() => {
        try {
            const p = parsed.params;
            return typeof p === 'string' ? JSON.parse(p) : (p || {});
        } catch {
            return {};
        }
    })();
    const rawTitle = String(parsed.title || '').trim();
    const mediaTitle = String(params.mediaTitle || '').trim();
    const domain = String(params.src || '').trim();
    const description = String(parsed.description || '').trim();
    const thumb = String(parsed.thumb || '');

    // chat.recommended có thể chứa "text + url" trong title.
    // Ưu tiên tách phần text user nhập để hiển thị đúng ý nghĩa tin nhắn.
    const stripKnownLinks = (txt: string): string => {
        let out = txt;
        if (href) out = out.split(href).join(' ');
        if (mediaTitle) out = out.split(mediaTitle).join(' ');
        out = out.replace(/https?:\/\/\S+/gi, ' ');
        return out.replace(/\s+/g, ' ').trim();
    };

    const userCaption = stripKnownLinks(rawTitle);
    const displayTitle = userCaption || rawTitle || mediaTitle || href;
    const primaryUrl = (href || mediaTitle || description).trim();
    const urlLine = primaryUrl && primaryUrl !== displayTitle ? primaryUrl : '';
    const derivedDomain = (() => {
        if (domain) return domain;
        if (!primaryUrl) return '';
        try {
            return new URL(primaryUrl).hostname || '';
        } catch {
            return '';
        }
    })();

    // Shorten description if too long
    const descriptionIsDuplicate =
        !!description &&
        (description === href || description === mediaTitle || description === displayTitle);
    const displayDesc = descriptionIsDuplicate ? '' : description;
    const shortDesc = displayDesc.length > 100 ? displayDesc.substring(0, 100) + '...' : displayDesc;
    const previewTitle = mediaTitle && mediaTitle !== displayTitle ? mediaTitle : (derivedDomain || href);

    return (
        <div
            className={`flex flex-col overflow-hidden rounded-2xl min-w-[260px] max-w-sm text-left shadow-lg ${isSent ? 'bg-gray-750' : 'bg-gray-800'} border ${isSent ? 'border-gray-700' : 'border-gray-700'}`}
        >
            {/* Message content: text + link - hiển thị bình thường, không bấm mở link */}
            <div className="px-3 py-2.5 space-y-1.5 select-text cursor-text">
                {displayTitle && (
                    <p className="text-sm text-white leading-snug">
                        {displayTitle}
                    </p>
                )}

                {urlLine && (
                    <p className="text-xs text-blue-500 leading-relaxed line-clamp-2 break-word">
                        {urlLine}
                    </p>
                )}

                {/* Description */}
                {shortDesc && (
                    <p className="text-xs text-gray-400 leading-relaxed line-clamp-2">
                        {shortDesc}
                    </p>
                )}
            </div>

            {/* Preview section - CHỈ bấm vào đây mới mở link */}
            <button
                onClick={() => href && ipc.shell?.openExternal(href)}
                className="mx-2 mb-2 border border-gray-700/80 rounded-xl overflow-hidden bg-gray-900/60 text-left cursor-pointer hover:opacity-90 active:scale-[0.98] transition-all"
                title={href}
            >
                {thumb && (
                    <div className="w-full h-36 overflow-hidden bg-gray-900 flex-shrink-0">
                        <img
                            src={thumb}
                            alt={previewTitle}
                            className="w-full h-full object-cover"
                            onError={(e) => {
                                (e.target as HTMLImageElement).style.display = 'none';
                                (e.target as HTMLImageElement).parentElement!.style.display = 'none';
                            }}
                        />
                    </div>
                )}
                <div className="px-2.5 py-2 space-y-1">
                    {previewTitle && (
                        <p className="text-xs text-white leading-snug line-clamp-2">{previewTitle}</p>
                    )}
                    {derivedDomain && (
                        <p className="text-[11px] text-gray-400 truncate">{derivedDomain}</p>
                    )}
                </div>
            </button>
        </div>
    );
}

// ─── CallBubble - hiển thị tin nhắn cuộc gọi ─────────────────────────────────
export function CallBubble({parsed, isSent}: { parsed: any; isSent: boolean }) {
    const params = (() => {
        try {
            const p = parsed.params;
            return typeof p === 'string' ? JSON.parse(p) : (p || {});
        } catch {
            return {};
        }
    })();
    const duration: number = params.duration || 0;
    const reason: number = params.reason || 0;
    const isCaller: boolean = params.isCaller === 1;
    const isVideo: boolean = params.calltype === 1;
    const callTypeLabel = isVideo ? 'Cuộc gọi video' : 'Cuộc gọi thoại';
    const action = String(parsed.action || '');
    const isMissed = action === 'recommened.misscall';

    let statusLabel = 'Cuộc gọi nhỡ';
    let statusRed = true;
    if (!isMissed && duration > 0) {
        const m = Math.floor(duration / 60), s = duration % 60;
        statusLabel = `Đã kết thúc · ${m > 0 ? `${m}p ` : ''}${s}s`;
        statusRed = false;
    } else if (!isMissed && duration === 0) {
        // calltime nhưng duration=0 → cuộc gọi rất ngắn / vừa kết thúc
        statusLabel = 'Đã kết thúc';
        statusRed = false;
    } else if (reason === 4 && isCaller) {
        statusLabel = 'Bạn đã hủy';
        statusRed = false;
    } else if (reason === 2) {
        statusLabel = isCaller ? 'Đã từ chối' : 'Bạn đã từ chối';
    }

    return (
        <div
            className={`flex flex-col px-3 py-2.5 rounded-2xl min-w-[200px] max-w-xs ${isSent ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-200'}`}>
            <div className="flex items-center gap-3">
                <div
                    className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${isSent ? 'bg-blue-500' : 'bg-gray-600'}`}>
                    {isVideo ? (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2">
                            <polygon points="23 7 16 12 23 17 23 7"/>
                            <rect x="1" y="5" width="15" height="14" rx="2"/>
                        </svg>
                    ) : (
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2">
                            <path
                                d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.07 9.63 19.79 19.79 0 01.01 1a2 2 0 012-2h3a2 2 0 012 1.72 12.84 12.84 0 00.7 2.81 2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45 12.84 12.84 0 002.81.7A2 2 0 0122 16.92z"/>
                        </svg>
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <p className={`text-sm font-semibold ${statusRed ? 'text-red-400' : isSent ? 'text-white' : 'text-gray-200'}`}>{statusLabel}</p>
                    <p className={`text-xs mt-0.5`}>{callTypeLabel}</p>
                </div>
            </div>
        </div>
    );
}

// ─── ContactCardBubble - hiển thị danh thiếp Zalo ────────────────────────────
export function ContactCardBubble({parsed, isSent, onOpenProfile}: {
    parsed: any;
    isSent: boolean;
    onOpenProfile?: (userId: string, e: React.MouseEvent) => void
}) {
    const title = parsed.title || '';
    const thumbUrl = parsed.thumb || '';
    const desc = typeof parsed.description === 'string'
        ? (() => {
            try {
                return JSON.parse(parsed.description);
            } catch {
                return {};
            }
        })()
        : (parsed.description || {});
    let phone = formatPhone(String(desc.phone || ''));
    const qrCodeUrl = String(desc.qrCodeUrl || '');
    const {contacts} = useChatStore();
    const {activeAccountId, getActiveAccount} = useAccountStore();
    const contactList = activeAccountId ? (contacts[activeAccountId] || []) : [];

    const directUid = String(
        desc.uid ||
        desc.userId ||
        desc.id ||
        parsed.userId ||
        parsed.uid ||
        parsed.id ||
        ''
    ).trim();
    const paramsUid = typeof parsed.params === 'string' ? parsed.params.trim() : '';
    const gUid = String(desc.gUid || parsed.gUid || '').trim();

    const normalizePhoneDigits = (v: string): string => String(v || '').replace(/\D/g, '');
    const targetPhoneDigits = normalizePhoneDigits(String(desc.phone || ''));

    const byDirectId = directUid
        ? contactList.find(c => String(c.contact_id || '') === directUid)
        : undefined;
    const byParamsId = paramsUid && paramsUid !== '0'
        ? contactList.find(c => String(c.contact_id || '') === paramsUid)
        : undefined;
    const byPhone = targetPhoneDigits
        ? contactList.find(c => {
            const cp = normalizePhoneDigits(String(c.phone || ''));
            if (!cp) return false;
            return cp === targetPhoneDigits || cp.endsWith(targetPhoneDigits) || targetPhoneDigits.endsWith(cp);
        })
        : undefined;

    const resolvedUserId = String(
        byDirectId?.contact_id ||
        byParamsId?.contact_id ||
        byPhone?.contact_id ||
        directUid ||
        (paramsUid && paramsUid !== '0' ? paramsUid : '') ||
        gUid ||
        ''
    ).trim();

    // Check friend status
    const matchedContact = byDirectId || byParamsId || byPhone;
    const isFriend = matchedContact ? (matchedContact.isFr === 1 || matchedContact.is_friend === 1) : false;

    const [sendingReq, setSendingReq] = React.useState(false);

    const handleOpenCardChat = (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!resolvedUserId) return;
        const activeZaloId = useAccountStore.getState().activeAccountId || undefined;
        useAppStore.getState().openQuickChat({
            zaloId: activeZaloId,
            target: {
                userId: resolvedUserId,
                displayName: title || resolvedUserId,
                avatarUrl: thumbUrl || undefined,
                threadType: 0,
                phone: phone || undefined,
            },
        });
    };

    const handleOpenProfile = (e: React.MouseEvent) => {
        if (!resolvedUserId || !onOpenProfile) return;
        // Chỉ mở profile khi click vào avatar, không block select text ở tên/SĐT
        const target = e.target as HTMLElement;
        if (target.closest('.card-avatar-area')) {
            onOpenProfile(resolvedUserId, e);
        }
    };

    const handleAddFriend = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (!resolvedUserId || sendingReq) return;
        setSendingReq(true);
        try {
            const account = getActiveAccount();
            if (!account) return;
            const auth = {cookies: account.cookies, imei: account.imei, userAgent: account.user_agent};
            const res = await ipc.zalo?.sendFriendRequest({
                auth,
                userId: resolvedUserId,
                msg: 'Làm quen qua danh thiếp Zalo'
            });
            if (res?.success || res?.response?.success) {
                useAppStore.getState().showNotification('Đã gửi lời mời kết bạn', 'success');
            } else {
                useAppStore.getState().showNotification(res?.error || 'Gửi lời mời thất bại', 'error');
            }
        } catch (err: any) {
            useAppStore.getState().showNotification('Gửi lời mời thất bại: ' + err.message, 'error');
        } finally {
            setSendingReq(false);
        }
    };

    return (
        <div
            className={`rounded-2xl max-w-[340px] ${isSent ? 'bg-blue-600/70 text-white' : 'bg-gray-700 text-gray-200'}`}
        >
            <div className="flex items-center gap-3.5 px-4 py-3.5 select-text">
                {/* Avatar - click mở profile */}
                <div
                    className={`card-avatar-area w-14 h-14 rounded-full overflow-hidden flex-shrink-0 bg-gray-600 ${resolvedUserId && onOpenProfile ? 'cursor-pointer hover:opacity-85 transition-opacity' : ''}`}
                    onClick={handleOpenProfile}
                >
                    {thumbUrl ? (
                        <img src={thumbUrl} alt={title} className="w-full h-full object-cover" onError={e => {
                            (e.target as HTMLImageElement).style.display = 'none';
                        }}/>
                    ) : (
                        <div
                            className="w-full h-full flex items-center justify-center text-white text-xl font-bold">{(title || 'U').charAt(0).toUpperCase()}</div>
                    )}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-base font-semibold truncate select-text cursor-text">{title || 'Danh thiếp'}</p>
                    {phone && <PhoneDisplay phone={phone}
                                            className={`text-sm ${isSent ? 'text-blue-100' : 'text-gray-300'}`}/>}
                    <p className={`text-xs mt-1 ${isSent ? 'text-blue-200' : 'text-gray-400'}`}>Danh thiếp Zalo</p>
                </div>
                {qrCodeUrl && (
                    <div className="w-12 h-12 flex-shrink-0">
                        <img src={qrCodeUrl} alt="QR" className="w-full h-full object-contain rounded" onError={e => {
                            (e.target as HTMLImageElement).style.display = 'none';
                        }}/>
                    </div>
                )}
            </div>

            {resolvedUserId && (
                <div
                    className={`px-4 pb-3.5 ${isSent ? 'bg-blue-700/40' : 'bg-gray-800/50'} border-t ${isSent ? 'border-blue-400/25' : 'border-gray-600/70'}`}>
                    <button
                        onClick={handleOpenCardChat}
                        className={`mt-2 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors ${
                            isSent
                                ? 'bg-blue-600 hover:bg-blue-500 text-white'
                                : 'bg-blue-600 hover:bg-blue-700 text-white'
                        }`}
                        title="Gửi tin nhắn"
                    >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                             strokeWidth="2.2">
                            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                        </svg>
                        Gửi tin nhắn
                    </button>
                    {/* Nút kết bạn - chỉ hiện nếu chưa là bạn bè */}
                    {!isFriend && !isSent && (
                        <button
                            onClick={handleAddFriend}
                            disabled={sendingReq}
                            className={`mt-1.5 w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors border border-dashed ${
                                sendingReq
                                    ? 'opacity-50 cursor-not-allowed'
                                    : 'hover:bg-white/10'
                            } ${isSent ? 'border-blue-400/30 text-blue-200' : 'border-gray-500/40 text-gray-300'}`}
                            title="Gửi lời mời kết bạn"
                        >
                            {sendingReq ? (
                                <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3"
                                            strokeDasharray="31.4 31.4" strokeLinecap="round"/>
                                </svg>
                            ) : (
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                                     strokeWidth="2">
                                    <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
                                    <circle cx="9" cy="7" r="4"/>
                                    <line x1="19" y1="8" x2="19" y2="14"/>
                                    <line x1="22" y1="11" x2="16" y2="11"/>
                                </svg>
                            )}
                            {sendingReq ? 'Đang gửi...' : 'Kết bạn'}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── BankCardBubble - imported from MessageBubbles (shared component) ────────

// ─── RtfBubble - webchat + action=rtf (rich text formatting) ────────────────
// Zalo TextStyle: b=bold, i=italic, u=underline, s=strikethrough
// Colors: c_db342e=red, c_f27806=orange, c_f7b503=yellow, c_15a85f=green
// Size: f_13=small, f_18=big
// List: lst_1=unordered, lst_2=ordered, ind_X=indent

const RTF_COLOR_MAP: Record<string, string> = {
    'c_db342e': '#db342e',
    'c_f27806': '#f27806',
    'c_f7b503': '#f7b503',
    'c_15a85f': '#15a85f',
};

export interface RtfStyle {
    start: number;
    len: number;
    st: string;
    indentSize?: number;
}

export interface RtfMention {
    pos: number;
    len: number;
    uid: string;
}

export function applyRtfStyles(text: string, styles: RtfStyle[], mentions?: RtfMention[], onMentionClick?: (uid: string, e: React.MouseEvent) => void): React.ReactNode {
    if (!text) return null;

    // Build character-level style map
    type CharStyle = {
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        strike?: boolean;
        color?: string;
        small?: boolean;
        big?: boolean;
        mentionUid?: string
    };
    const charStyles: CharStyle[] = Array.from({length: text.length}, () => ({}));

    // Apply RTF styles (st can be comma-separated like "b,c_db342e")
    for (const style of (styles || [])) {
        const {start, len} = style;
        const parts = String(style.st || '').split(',').map(s => s.trim()).filter(Boolean);
        for (let i = start; i < Math.min(start + len, text.length); i++) {
            const cs = charStyles[i];
            for (const st of parts) {
                if (st === 'b') cs.bold = true;
                else if (st === 'i') cs.italic = true;
                else if (st === 'u') cs.underline = true;
                else if (st === 's') cs.strike = true;
                else if (st === 'f_13') cs.small = true;
                else if (st === 'f_18') cs.big = true;
                else if (st in RTF_COLOR_MAP) cs.color = RTF_COLOR_MAP[st];
            }
        }
    }

    // Apply mention highlights with uid tracking
    for (const mention of (mentions || [])) {
        for (let i = mention.pos; i < Math.min(mention.pos + mention.len, text.length); i++) {
            charStyles[i].mentionUid = mention.uid || 'unknown';
        }
    }

    // Merge consecutive chars with same style into spans
    const nodes: React.ReactNode[] = [];
    let i = 0;
    while (i < text.length) {
        const cs = charStyles[i];
        let j = i + 1;
        while (j < text.length && JSON.stringify(charStyles[j]) === JSON.stringify(cs)) j++;
        const chunk = convertZaloEmojis(text.slice(i, j));
        const inlineStyle: React.CSSProperties = {};
        const cls: string[] = [];
        if (cs.bold) cls.push('font-bold');
        if (cs.italic) cls.push('italic');
        if (cs.underline) cls.push('underline');
        if (cs.strike) cls.push('line-through');
        if (cs.small) cls.push('text-xs');
        if (cs.big) cls.push('text-base font-medium');
        if (cs.mentionUid) {
            cls.push('font-semibold');
            if (onMentionClick && cs.mentionUid !== 'unknown') cls.push('cursor-pointer hover:underline');
            inlineStyle.color = '#5398f3';
        } else if (cs.color) {
            inlineStyle.color = cs.color;
        }
        const uid = cs.mentionUid;
        nodes.push(
            <span
                key={i}
                className={cls.join(' ')}
                style={Object.keys(inlineStyle).length ? inlineStyle : undefined}
                onClick={uid && uid !== 'unknown' && onMentionClick ? (e) => {
                    e.stopPropagation();
                    onMentionClick(uid, e);
                } : undefined}
            >{chunk}</span>
        );
        i = j;
    }

    return <span className="whitespace-pre-wrap select-text break-word">{nodes}</span>;
}

/** Render normal text, highlighting @mentions in blue, with optional click-to-profile */
export function TextWithMentions({
                                     text,
                                     allContacts,
                                     groupMembersList,
                                     onMentionClick,
                                     highlight,
                                 }: {
    text: string;
    allContacts?: any[];
    groupMembersList?: any[];
    onMentionClick?: (userId: string, e: React.MouseEvent) => void;
    highlight?: string;
}) {
    if (!text) return null;
    const converted = convertZaloEmojis(text);

    // Helper: wrap text segment with search highlight marks
    const applyHighlight = (str: string, key: string | number): React.ReactNode => {
        if (!highlight || !highlight.trim()) return <span key={key}>{str}</span>;
        const q = highlight.toLowerCase();
        const lower = str.toLowerCase();
        const parts: React.ReactNode[] = [];
        let last = 0;
        let hi = lower.indexOf(q, 0);
        while (hi !== -1) {
            if (hi > last) parts.push(<span key={`${key}_t${hi}`}>{str.slice(last, hi)}</span>);
            parts.push(
                <mark key={`${key}_h${hi}`} className="bg-yellow-400/40 text-yellow-200 rounded-sm px-0.5">
                    {str.slice(hi, hi + highlight.length)}
                </mark>
            );
            last = hi + highlight.length;
            hi = lower.indexOf(q, last);
        }
        if (last < str.length) parts.push(<span key={`${key}_e${last}`}>{str.slice(last)}</span>);
        return parts.length ? <React.Fragment key={key}>{parts}</React.Fragment> : <span key={key}>{str}</span>;
    };

    // Match @Name: greedy - capture everything after @ until a newline or double-space
    // We try to find the longest matching display name from contacts/members
    const allPeople = [...(allContacts || []), ...(groupMembersList || [])];

    // Build segments by scanning for @ then greedily matching known display names
    const segments: React.ReactNode[] = [];
    let i = 0;
    while (i < converted.length) {
        const atIdx = converted.indexOf('@', i);
        if (atIdx === -1) {
            segments.push(applyHighlight(converted.slice(i), i));
            break;
        }
        // Text before @
        if (atIdx > i) segments.push(applyHighlight(converted.slice(i, atIdx), i));

        // Try to match a known display name after @
        let matched = false;
        if (allPeople.length > 0) {
            // Sort longest name first for greedy match
            const sorted = [...allPeople].sort((a, b) => {
                const na = (a.display_name || a.displayName || '').length;
                const nb = (b.display_name || b.displayName || '').length;
                return nb - na;
            });
            for (const person of sorted) {
                const name = person.display_name || person.displayName || '';
                if (!name) continue;
                const expected = '@' + name;
                if (converted.startsWith(expected, atIdx)) {
                    const uid = person.contact_id || person.userId || '';
                    const mentionText = expected;
                    segments.push(
                        <span
                            key={atIdx}
                            className={`font-semibold${uid && onMentionClick ? ' cursor-pointer hover:underline' : ''}`}
                            style={{color: '#5398f3'}}
                            onClick={uid && onMentionClick ? (e) => {
                                e.stopPropagation();
                                onMentionClick(uid, e);
                            } : undefined}
                        >{mentionText}</span>
                    );
                    i = atIdx + mentionText.length;
                    matched = true;
                    break;
                }
            }
        }
        if (!matched) {
            // No name match - grab @word (stop at whitespace)
            const restStr = converted.slice(atIdx + 1);
            const spaceIdx = restStr.search(/[\s,!?;:\n]/);
            const end = spaceIdx === -1 ? converted.length : atIdx + 1 + spaceIdx;
            const mentionText = converted.slice(atIdx, end);
            segments.push(
                <span key={atIdx} className="font-semibold" style={{color: '#79b4fd'}}>{mentionText}</span>
            );
            i = end;
        }
    }

    if (segments.length === 0) return <span className="whitespace-pre-wrap select-text break-word">{converted}</span>;
    return <span className="whitespace-pre-wrap select-text break-word">{segments}</span>;
}

export function RtfBubble({
                              msg,
                              allContacts,
                              groupMembersList,
                              onMentionClick,
                          }: {
    msg: any;
    allContacts?: any[];
    groupMembersList?: any[];
    onMentionClick?: (userId: string, e: React.MouseEvent) => void;
}) {
    let title = '';
    let styles: RtfStyle[] = [];
    let mentions: RtfMention[] = [];

    try {
        const parsed = JSON.parse(msg.content || '{}');
        title = parsed.title || '';
        const paramsRaw = parsed.params;
        const params = typeof paramsRaw === 'string' ? JSON.parse(paramsRaw) : (paramsRaw || {});
        styles = params.styles || [];
        mentions = params.mentions || [];
    } catch {
    }

    if (!title) return <span className="text-xs opacity-60">[Tin nhắn định dạng]</span>;

    return (
        <span>{applyRtfStyles(title, styles, mentions, onMentionClick)}</span>
    );
}

export function ActionRow({icon, label, onClick, textColor = 'text-gray-300'}: {
    icon: React.ReactNode; label: string; onClick: () => void; textColor?: string;
}) {
    return (
        <button onClick={onClick}
                className={`w-full flex items-center gap-3 px-4 py-2.5 hover:bg-gray-700/50 transition-colors text-left ${textColor}`}>
            <span className="flex-shrink-0 text-gray-400">{icon}</span>
            <span className="text-sm">{label}</span>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                 className="ml-auto text-gray-400 flex-shrink-0">
                <polyline points="9 18 15 12 9 6"/>
            </svg>
        </button>
    );
}
