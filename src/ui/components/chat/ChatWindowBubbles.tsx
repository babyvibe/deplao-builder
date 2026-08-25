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
import { getFileMetadata, getLocalMediaPath, getStatusDisplay, extractAttachments, getTelegramStickerMedia } from '@/lib/mediaResolver';
import { isFacebook, isTelegram, isTelegramUser, isNonZalo, isZalo } from '@/lib/channelHelper';
import DataAccessor from '@/lib/data/DataAccessor';
import {toLocalMediaUrl} from '@/lib/localMedia';
import {formatPhone} from '@/utils/phoneUtils';
import PhoneDisplay from '../common/PhoneDisplay';
import {convertZaloEmojis} from '@/lib/chat/emojiUtils';
import {getTelegramMentionRanges, linkifyText, type TelegramMentionRange} from '@/lib/chat/messageParser';
import {isMediaType} from '@/lib/chat/messageTypeUtils';
import {TgsBubble} from './MessageBubbles';

type TelegramMediaRepairResult = {
    success: boolean;
    localPaths?: Record<string, string>;
    attachments?: any[];
    msgType?: string;
    error?: string;
};

const telegramMediaRepairInFlight = new Map<string, Promise<TelegramMediaRepairResult>>();

/** Lazy-hydrate old Telegram media rows without replaying unread/UI events. */
function useTelegramMediaRepair(msg: any, shouldAutoRepair: boolean) {
    const [repairing, setRepairing] = React.useState(false);
    const attemptedKeyRef = React.useRef('');
    const accountId = String(msg?.owner_zalo_id || msg?.zaloId || '');
    const threadId = String(msg?.thread_id || msg?.threadId || '');
    const messageId = String(msg?.msg_id || msg?.id || '');
    const repairKey = `${accountId}:${threadId}:${messageId}`;
    const attachmentsValue = typeof msg?.attachments === 'string'
        ? msg.attachments
        : JSON.stringify(msg?.attachments || []);
    const localPathsValue = typeof msg?.local_paths === 'string'
        ? msg.local_paths
        : JSON.stringify(msg?.local_paths || {});

    React.useEffect(() => {
        attemptedKeyRef.current = '';
    }, [repairKey]);

    const requestRepair = React.useCallback(async (
        reason: 'missing_source' | 'image_load_error' | 'manual_retry',
        force = false,
    ) => {
        if (!isTelegramUser(msg?.channel) || !accountId || !threadId || !messageId) return;
        if (!force && attemptedKeyRef.current === repairKey) return;
        attemptedKeyRef.current = repairKey;

        let attachmentTypes: string[] = [];
        let localPathState = 'empty';
        try {
            const parsedAttachments = JSON.parse(attachmentsValue || '[]');
            attachmentTypes = Array.isArray(parsedAttachments)
                ? parsedAttachments.map((attachment: any) => String(attachment?.type || '-'))
                : [];
        } catch {
            attachmentTypes = ['invalid_json'];
        }
        try {
            const parsedPaths = JSON.parse(localPathsValue || '{}');
            localPathState = Object.values(parsedPaths || {}).some(Boolean) ? 'present' : 'empty';
        } catch {
            localPathState = 'invalid_json';
        }

        // Log chi tiết để debug tại sao ảnh không load
        let lpDetail = 'none';
        try {
            const lp = JSON.parse(msg?.local_paths || '{}');
            const keys = Object.keys(lp);
            if (keys.length > 0) {
                lpDetail = keys.map(k => `${k}=${lp[k] || 'empty'}`).join(', ');
            }
        } catch {}
        let attDetail = 'none';
        try {
            const atts = JSON.parse(msg?.attachments || '[]');
            if (atts.length > 0) {
                const a = atts[0];
                attDetail = `type=${a.type} url=${a.url?.slice(0,80) || 'none'} localPath=${a.localPath?.slice(0,80) || 'none'} mime=${a.mime_type || 'none'} file_id=${a.file_id ? String(a.file_id).slice(0,30) : 'none'}`;
            }
        } catch {}
        console.warn(`[TelegramMedia] PHOTO_UNAVAILABLE msgId=${messageId} reason=${reason} msgType=${msg?.msg_type}\n    lp: ${lpDetail}\n    att: ${attDetail}`);

        setRepairing(true);
        try {
            let request = telegramMediaRepairInFlight.get(repairKey);
            if (!request) {
                request = ipc.telegramUser.repairMessageMedia({accountId, chatId: threadId, messageId})
                    .finally(() => telegramMediaRepairInFlight.delete(repairKey));
                telegramMediaRepairInFlight.set(repairKey, request);
            }
            const result = await request;
            if (result?.success && result.localPaths) {
                useChatStore.getState().updateMessageLocalPath(accountId, threadId, messageId, result.localPaths);
                console.info('[TelegramMedia] PHOTO_REPAIRED', {
                    accountId,
                    threadId,
                    messageId,
                    msgType: result.msgType || msg?.msg_type || '-',
                });
            } else {
                console.warn('[TelegramMedia] PHOTO_REPAIR_FAILED', {
                    accountId,
                    threadId,
                    messageId,
                    reason: result?.error || 'unknown',
                });
            }
        } catch (error: any) {
            console.warn('[TelegramMedia] PHOTO_REPAIR_FAILED', {
                accountId,
                threadId,
                messageId,
                reason: error?.message || String(error),
            });
        } finally {
            setRepairing(false);
        }
    }, [accountId, attachmentsValue, localPathsValue, messageId, msg?.channel, msg?.msg_type, repairKey, threadId]);

    React.useEffect(() => {
        if (shouldAutoRepair) void requestRepair('missing_source');
    }, [requestRepair, shouldAutoRepair]);

    return {repairing, requestRepair};
}

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
    const repairAttemptedRef = React.useRef(false);

    // Auto-repair: tải file từ Telegram nếu chưa có local_paths
    React.useEffect(() => {
        if (repairAttemptedRef.current) return;
        if (!isTelegramUser(msg?.channel)) return;
        const lp = typeof msg?.local_paths === 'string' ? (() => { try { return JSON.parse(msg.local_paths); } catch { return {}; } })() : (msg?.local_paths || {});
        if (lp.file || lp.main) return; // đã có file
        repairAttemptedRef.current = true;
        const accountId = msg.owner_zalo_id;
        const chatId = msg.thread_id;
        const messageId = msg.msg_id;
        if (!accountId || !chatId || !messageId) return;
        ipc.telegramUser?.repairMessageMedia({ accountId, chatId, messageId })
            .then((result: any) => {
                if (result?.success && result.localPaths) {
                    useChatStore.getState().updateMessageLocalPath(accountId, chatId, messageId, result.localPaths);
                }
            })
            .catch(() => {});
    }, [msg?.msg_id, msg?.local_paths]);

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

    // Facebook: extract metadata from attachments via MediaResolver
    if (isFacebook(msg.channel) && (!fileTitle || fileTitle === 'File')) {
        const fbMeta = getFileMetadata(msg);
        if (fbMeta.title && fbMeta.title !== 'File') fileTitle = fbMeta.title;
        if (fbMeta.href && !fileHref) fileHref = fbMeta.href;
        if (fbMeta.fileSize && !fileSize) fileSize = String(fbMeta.fileSize);
        if (fbMeta.ext && !fileExt) fileExt = fbMeta.ext;
    }

    // Telegram: lấy tên file từ attachments
    if (isTelegramUser(msg.channel) && (!fileTitle || fileTitle === 'File')) {
        try {
            const atts = typeof msg.attachments === 'string' ? JSON.parse(msg.attachments || '[]') : (msg.attachments || []);
            const fileAtt = Array.isArray(atts) ? atts.find((a: any) => a?.type === 'file') : null;
            if (fileAtt) {
                if (fileAtt.file_name || fileAtt.name) fileTitle = fileAtt.file_name || fileAtt.name;
                if (fileAtt.file_size || fileAtt.fileSize) fileSize = String(fileAtt.file_size || fileAtt.fileSize);
                if (fileAtt.mime_type) {
                    const ext = fileAtt.mime_type.split('/').pop();
                    if (ext && !fileExt) fileExt = ext;
                }
            }
        } catch {}
    }

    let localFilePath = '';
    try {
        const lp = typeof msg.local_paths === 'string' ? JSON.parse(msg.local_paths || '{}') : (msg.local_paths || {});
        localFilePath = lp.file || lp.main || '';
    } catch {
    }

    // Facebook: also check localPath inside attachments via MediaResolver
    if (isFacebook(msg.channel) && !localFilePath) {
        localFilePath = getLocalMediaPath(msg, 'file');
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
                                : (isFacebook(msg.channel) && isSent) ? <span>{getStatusDisplay(msg, true).text}</span>
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

    // FB/Telegram: use localPath from attachments for immediate preview via MediaResolver
    let fbLocalUrls: string[] = [];
    if (isNonZalo(msg.channel)) {
        const atts = extractAttachments(msg);
        fbLocalUrls = atts.map(a => a.localPath ? toLocalMediaUrl(a.localPath) : (a.url || '')).filter(Boolean);
        if (!localUrl && fbLocalUrls.length > 0) localUrl = fbLocalUrls[0];
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
        // Not JSON (Telegram/Facebook) — content is plain text caption
        const rawContent = (msg.content || '').trim();
        // Only use as caption if it's not a media placeholder emoji
        if (rawContent && !rawContent.startsWith('🖼️') && !rawContent.startsWith('🎬') && !rawContent.startsWith('🎞️') && !rawContent.startsWith('🎨') && !rawContent.startsWith('📎')) {
            caption = rawContent;
        }
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
    const telegramRepair = useTelegramMediaRepair(msg, !displayUrl);

    const retryCountRef = React.useRef(0);
    const handleImgError = () => {
        if (useLocal && remoteUrl) {
            setUseLocal(false); // local lỗi → fallback CDN ngay, không flash
        } else {
            // Auto-retry repair nếu lần đầu fail (tối đa 3 lần, delay 2s)
            if (retryCountRef.current < 3) {
                retryCountRef.current++;
                console.log(`[TelegramMedia] image_load_error msgId=${msg?.msg_id} retry=${retryCountRef.current}/3`);
                setTimeout(() => {
                    void telegramRepair.requestRepair('image_load_error', true);
                }, 2000 * retryCountRef.current);
            } else {
                setLoadFailed(true);
            }
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
            <button
                type="button"
                onClick={() => void telegramRepair.requestRepair('manual_retry', true)}
                disabled={!isTelegramUser(msg.channel) || telegramRepair.repairing}
                title={isTelegramUser(msg.channel) ? 'Tải lại ảnh Telegram này' : undefined}
                className="flex flex-col gap-1 items-center justify-center max-w-xs w-full h-32 rounded-xl bg-gray-700/40 text-gray-400 select-none disabled:cursor-default">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                     className="opacity-30">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                </svg>
                {telegramRepair.repairing && <span className="text-[10px] opacity-60">Đang tải lại...</span>}
            </button>
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
                className={`px-3 py-2 text-sm break-words${isSent ? ' bg-blue-400/40 text-white' : ' bg-gray-700 text-gray-200'}`}>
                <TextWithMentions
                    text={caption}
                    channel={msg.channel}
                    allContacts={allContacts}
                    groupMembersList={groupMembersList}
                    mentionRanges={getTelegramMentionRanges(msg.attachments)}
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
    if (!isMediaType(msg.msg_type, msg.content, msg.attachments)) return null;
    if (isTelegram(msg.channel)) {
        // Telegram's grouped_id is authoritative for a mixed media album.
        // A post can contain photos and videos in the same album, therefore a
        // video must not be split into a separate bubble merely because it
        // needs a different tile renderer.
        const mediaType = String(msg.msg_type || '').toLowerCase();
        const isAlbumMedia = mediaType === 'photo' || mediaType === 'image'
            || mediaType === 'chat.photo' || mediaType === 'video'
            || mediaType === 'chat.video.msg' || mediaType === 'gif';
        if (!isAlbumMedia) return null;
        try {
            const attachments = typeof msg.attachments === 'string'
                ? JSON.parse(msg.attachments || '[]')
                : (msg.attachments || []);
            const grouped = (Array.isArray(attachments) ? attachments : [attachments]).find((item: any) =>
                (item?.type === 'telegram_grouped_media' || item?.type === 'telegram_post') && item?.grouped_id
            );
            if (grouped?.grouped_id) return `tg:${String(grouped.grouped_id)}`;
        } catch {}
    }
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
                                     isSent,
                                     isSelecting: isSelectingProp,
                                     selectedMsgIds: selectedMsgIdsProp,
                                     onToggleSelect,
                                     onVideoPlay,
                                     allContacts,
                                     groupMembersList,
                                     onMentionClick,
                                 }: {
    msgs: any[]; onView: (src: string) => void; isSent?: boolean;
    isSelecting?: boolean; selectedMsgIds?: Set<string>; onToggleSelect?: (msgId: string) => void;
    /** Called when user clicks play on a video tile in the group */
    onVideoPlay?: (msg: any) => void;
    allContacts?: any[]; groupMembersList?: any[];
    onMentionClick?: (userId: string, e: React.MouseEvent) => void;
}) {
    const sorted = React.useMemo(() => {
        return [...groupMsgs].sort((a, b) => {
            if (isTelegram(a.channel) || isTelegram(b.channel)) {
                return Number(a.timestamp || 0) - Number(b.timestamp || 0)
                    || Number(a.msg_id || 0) - Number(b.msg_id || 0);
            }
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
    const telegramCaptionMessage = React.useMemo(() => {
        return sorted.find((message) => {
            if (!isTelegram(message.channel)) return false;
            const text = String(message.content || '').trim();
            return text && !/^(?:🖼️\s*)?(?:Hình ảnh|Image)$/i.test(text);
        });
    }, [sorted]);

    // Chia thành hàng, mỗi hàng tối đa 4 ảnh
    const rows: any[][] = [];
    for (let i = 0; i < sorted.length; i += 4) rows.push(sorted.slice(i, i + 4));

    return (
        <div className="flex flex-col overflow-hidden rounded-xl max-w-xs ring-1 ring-black/[0.12] bg-[#242f3d]">
            <div className="flex flex-col gap-0.5">
                {rows.map((row, ri) => (
                    <div key={ri} className="flex gap-0.5">
                        {row.map((m) => (
                            <SingleImageInGroup key={m.msg_id} msg={m} onView={onView} isSent={isSent} isSelecting={isSelectingProp}
                                                isSelected={selectedMsgIdsProp?.has(m.msg_id)}
                                                onToggleSelect={onToggleSelect}
                                                onVideoPlay={onVideoPlay}/>
                        ))}
                    </div>
                ))}
            </div>
            {telegramCaptionMessage && (
                <div className="px-3 py-2 text-sm whitespace-pre-wrap break-words bg-gray-700 text-gray-200"
                     style={{fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif'}}>
                    <TextWithMentions
                        text={String(telegramCaptionMessage.content || '').trim()}
                        channel={telegramCaptionMessage.channel}
                        allContacts={allContacts}
                        groupMembersList={groupMembersList}
                        mentionRanges={getTelegramMentionRanges(telegramCaptionMessage.attachments)}
                        onMentionClick={onMentionClick}
                    />
                </div>
            )}
        </div>
    );
}

/** Ảnh đơn bên trong MediaGroupBubble - chiều cao cố định h-40 */
export function SingleImageInGroup({msg, onView, isSent, isSelecting: isSelectingProp, isSelected, onToggleSelect, onVideoPlay}: {
    msg: any; onView: (src: string) => void; isSent?: boolean;
    isSelecting?: boolean; isSelected?: boolean; onToggleSelect?: (msgId: string) => void;
    /** Called when user clicks play on a video tile. If provided, opens inline player. */
    onVideoPlay?: (msg: any) => void;
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

    // FB/Telegram: use localPath from attachments for immediate preview via MediaResolver
    let fbLocalUrls: string[] = [];
    if (isNonZalo(msg.channel)) {
        const atts = extractAttachments(msg);
        fbLocalUrls = atts.map(a => a.localPath ? toLocalMediaUrl(a.localPath) : (a.url || '')).filter(Boolean);
        if (!localUrl && fbLocalUrls.length > 0) localUrl = fbLocalUrls[0];
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
    // FB fallback: lấy URL từ attachments via MediaResolver
    if (!remoteUrl && isFacebook(msg.channel)) {
        const att = extractAttachments(msg)[0];
        remoteUrl = att?.url || att?.href || att?.thumb || '';
    }

    // Remote-first: CDN hiển thị ngay; chuyển local khi file đã tải xong
    const displayUrl = useLocal ? (localUrl || remoteUrl) : (remoteUrl || localUrl);
    const viewUrl = remoteUrl || displayUrl;

    const telegramRepair = useTelegramMediaRepair(msg, !displayUrl);
    const handleImgError = () => {
        if (useLocal && remoteUrl) {
            setUseLocal(false); // local lỗi → fallback CDN ngay
        } else {
            setLoadFailed(true);
            void telegramRepair.requestRepair('image_load_error');
        }
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
            <button
                type="button"
                onClick={() => void telegramRepair.requestRepair('manual_retry', true)}
                disabled={!isTelegramUser(msg.channel) || telegramRepair.repairing}
                title={isTelegramUser(msg.channel) ? 'Tải lại ảnh Telegram này' : undefined}
                className="h-40 flex-1 min-w-0 bg-gray-700/50 flex flex-col gap-1 items-center justify-center text-gray-400 select-none disabled:cursor-default">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                     className="opacity-30">
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                    {loadFailed && <line x1="2" y1="2" x2="22" y2="22"/>}
                </svg>
                {telegramRepair.repairing && <span className="text-[10px] opacity-60">Đang tải lại...</span>}
            </button>
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

    const isVideoTile = ['video', 'chat.video.msg', 'gif'].includes(String(msg.msg_type || '').toLowerCase());
    if (isVideoTile && displayUrl) {
        const openVideo = (e: React.MouseEvent) => {
            if (isSelectingProp) {
                e.stopPropagation();
                onToggleSelect?.(msg.msg_id);
            } else {
                e.stopPropagation();
                // Use inline player callback if provided, otherwise fallback to external app
                if (onVideoPlay) {
                    onVideoPlay(msg);
                } else if (localFilePath) {
                    void ipc.file?.openPath(localFilePath);
                }
            }
        };
        // Extract caption from content (Telegram video + text)
        let videoCaption = '';
        try {
            const parsed = JSON.parse(msg.content || '{}');
            videoCaption = typeof parsed === 'string' ? parsed : (parsed.title || parsed.text || parsed.caption || '');
        } catch { videoCaption = ''; }
        if (!videoCaption && msg.content && !msg.content.startsWith('{')) videoCaption = msg.content;

        const videoNode = (
            <div
                className={`relative flex-1 min-w-0 group/singleimg cursor-pointer bg-black${isSelected ? ' ring-2 ring-blue-500' : ''}`}
                onClick={openVideo}
                title={localFilePath ? 'Mở video' : 'Video đang được tải'}
            >
                <video
                    src={displayUrl}
                    muted
                    playsInline
                    preload="metadata"
                    className="h-40 w-full object-cover bg-black"
                    onError={handleImgError}
                />
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <span className="w-9 h-9 rounded-full bg-black/60 border border-white/30 flex items-center justify-center text-white text-base pl-0.5">▶</span>
                </div>
                <div className="absolute inset-0 pointer-events-none ring-1 ring-inset ring-black/[0.18]"/>
                {isSelectingProp && isSelected && (
                    <div className="absolute inset-0 bg-blue-500/30 flex items-center justify-center pointer-events-none">
                        <div className="w-7 h-7 rounded-full bg-blue-500 flex items-center justify-center">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3">
                                <polyline points="20 6 9 17 4 12"/>
                            </svg>
                        </div>
                    </div>
                )}
            </div>
        );

        if (videoCaption) {
            return (
                <div className="flex flex-col max-w-xs">
                    {videoNode}
                    <div className={`px-3 py-2 text-sm break-words rounded-b-2xl ${isSent ? 'bg-blue-400/40 text-white' : 'bg-gray-700 text-gray-200'}`}>
                        {videoCaption}
                    </div>
                </div>
            );
        }
        return videoNode;
    }

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
    // Force re-render counter when event:localPath updates this message
    const [localPathVersion, setLocalPathVersion] = React.useState(0);

    // Listen for event:localPath to re-render when sticker is downloaded
    React.useEffect(() => {
        if (!isTelegram(msg.channel)) return;
        const handleLocalPath = (data: any) => {
            if (data?.msgId === msg.msg_id || String(data?.msgId) === String(msg.msg_id)) {
                setLocalPathVersion(v => v + 1);
            }
        };
        const unsub = ipc.on?.('event:localPath', handleLocalPath);
        return () => { unsub?.(); };
    }, [msg.channel, msg.msg_id]);

    React.useEffect(() => {
        let cancelled = false;
        setStickerUrl(null);
        setFailed(false);
        setUnsupported(false);

        // Telegram media is already persisted by the main-process listener.
        // Never fall through to Zalo's numeric sticker-id parser.
        if (isTelegram(msg.channel)) {
            const media = getTelegramStickerMedia(msg);
            if (media?.localPath) {
                if (media.format === 'tgs') {
                    if (!cancelled) setStickerUrl(`tgs:${media.localPath}`);
                    return;
                }
                const localUrl = toLocalMediaUrl(media.localPath);
                if (localUrl) {
                    if (!cancelled) setStickerUrl(localUrl);
                    return;
                }
            }
            if (media?.remoteUrl) {
                if (!cancelled) setStickerUrl(media.remoteUrl);
                return;
            }

            try {
                const paths: Record<string, string> = typeof msg.local_paths === 'string'
                    ? JSON.parse(msg.local_paths || '{}')
                    : (msg.local_paths || {});
                const localFile = paths.sticker || paths.file || paths.main || paths.video || '';
                if (localFile) {
                    if (localFile.toLowerCase().endsWith('.tgs')) {
                        if (!cancelled) setStickerUrl(`tgs:${localFile}`);
                    } else {
                        const localUrl = toLocalMediaUrl(localFile);
                        if (!cancelled && localUrl) setStickerUrl(localUrl);
                    }
                    return;
                }
            } catch {}

            // A recognized sticker may still be waiting for event:localPath.
            if (!media && !cancelled) setFailed(true);
            return;
        }

        // ── Facebook sticker ────────────────────────────────────────────────
        if (isFacebook(msg.channel)) {
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
            const atts = extractAttachments(msg);
            const hasDirectPath = atts[0]?.directPath;
            if (!hasDirectPath && !atts[0]?.url) {
                if (!cancelled) setUnsupported(true);
                return;
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
    }, [msg.content, msg.local_paths, msg.attachments, localPathVersion]);

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

    if (stickerUrl.startsWith('tgs:')) {
        return <TgsBubble filePath={stickerUrl.slice(4)}/>;
    }

    const telegramSticker = getTelegramStickerMedia(msg);
    if (isTelegram(msg.channel) && (telegramSticker?.format === 'mp4' || telegramSticker?.format === 'webm')) {
        return (
            <video
                src={stickerUrl}
                autoPlay
                loop
                muted
                playsInline
                aria-label="Telegram animated sticker"
                className="w-28 h-28 object-contain rounded-xl"
                onError={() => setFailed(true)}
            />
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
                        <p className="text-white font-semibold text-sm leading-snug">{linkifyText(title)}</p>
                    )}
                    {description && (
                        <p className="text-gray-400 text-xs leading-relaxed">{linkifyText(description)}</p>
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
        const account = getActiveAccount();
        if (!account) return;
        // Only supported for Zalo
        if (isNonZalo(account.channel)) {
            useAppStore.getState().showNotification('Tính năng chưa hỗ trợ cho kênh này', 'error');
            return;
        }
        setSendingReq(true);
        try {
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
        const chunk = linkifyText(convertZaloEmojis(text.slice(i, j)));
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

    return <span className="whitespace-pre-wrap select-text break-words" style={{ overflowWrap: 'break-word', wordBreak: 'normal' }}>{nodes}</span>;
}

/** Render normal text, highlighting @mentions in blue, with optional click-to-profile */
export function TextWithMentions({
                                     text,
                                     channel,
                                     allContacts,
                                     groupMembersList,
                                     mentionRanges,
                                     onMentionClick,
                                     highlight,
                                 }: {
    text: string;
    channel?: string;
    allContacts?: any[];
    groupMembersList?: any[];
    mentionRanges?: TelegramMentionRange[];
    onMentionClick?: (userId: string, e: React.MouseEvent) => void;
    highlight?: string;
}) {
    if (!text) return null;
    // Telegram already sends Unicode (including a fallback glyph for custom
    // emoji entities). Zalo's text-code converter must not rewrite it.
    const converted = isTelegram(channel) ? text : convertZaloEmojis(text);
    const emojiFontStyle: React.CSSProperties = isTelegram(channel)
        ? { fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif' }
        : {};

    // Helper: wrap text segment with search highlight marks + URL detection
    const applyHighlight = (str: string, key: string | number, detectMentions = true): React.ReactNode => {
        if (!highlight || !highlight.trim()) return <span key={key}>{linkifyText(str, {detectMentions})}</span>;
        const q = highlight.toLowerCase();
        const lower = str.toLowerCase();
        const parts: React.ReactNode[] = [];
        let last = 0;
        let hi = lower.indexOf(q, 0);
        while (hi !== -1) {
            if (hi > last) parts.push(<span key={`${key}_t${hi}`}>{linkifyText(str.slice(last, hi), {detectMentions})}</span>);
            parts.push(
                <mark key={`${key}_h${hi}`} className="bg-yellow-400/40 text-yellow-200 rounded-sm px-0.5">
                    {str.slice(hi, hi + highlight.length)}
                </mark>
            );
            last = hi + highlight.length;
            hi = lower.indexOf(q, last);
        }
        if (last < str.length) parts.push(<span key={`${key}_e${last}`}>{linkifyText(str.slice(last), {detectMentions})}</span>);
        return parts.length ? <React.Fragment key={key}>{parts}</React.Fragment> : <span key={key}>{linkifyText(str, {detectMentions})}</span>;
    };

    // Telegram gives the exact UTF-16 ranges for real mentions. They are
    // authoritative: when present, do not infer further mentions from raw @.
    const nativeMentionRanges = isTelegram(channel)
        ? (mentionRanges || []).filter((range) =>
            range.offset >= 0
            && range.length > 0
            && range.offset + range.length <= converted.length
        )
        : [];
    if (nativeMentionRanges.length > 0) {
        const segments: React.ReactNode[] = [];
        let cursor = 0;
        for (const range of nativeMentionRanges) {
            if (range.offset < cursor) continue;
            if (range.offset > cursor) {
                segments.push(applyHighlight(converted.slice(cursor, range.offset), `native-text-${cursor}`, false));
            }
            const mentionText = converted.slice(range.offset, range.offset + range.length);
            const userId = range.userId || '';
            segments.push(
                <span
                    key={`native-mention-${range.offset}`}
                    className={`font-semibold${userId && onMentionClick ? ' cursor-pointer hover:underline' : ''}`}
                    style={{color: '#5398f3'}}
                    onClick={userId && onMentionClick ? (e) => {
                        e.stopPropagation();
                        onMentionClick(userId, e);
                    } : undefined}
                >{mentionText}</span>
            );
            cursor = range.offset + range.length;
        }
        if (cursor < converted.length) {
            segments.push(applyHighlight(converted.slice(cursor), `native-text-${cursor}`, false));
        }
        return <span className="whitespace-pre-wrap select-text break-words" style={{ overflowWrap: 'break-word', wordBreak: 'normal', ...emojiFontStyle }}>{segments}</span>;
    }

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

        const beforeAt = atIdx > 0 ? converted[atIdx - 1] : '';
        const nextChar = converted[atIdx + 1] || '';
        // Keep @@, email-like strings, and a bare @ as ordinary text. This
        // fallback is only for historical rows without native TG entities.
        if (beforeAt === '@' || /[a-zA-Z0-9_]/.test(beforeAt) || !/[a-zA-Z0-9_]/.test(nextChar)) {
            segments.push(applyHighlight(converted.slice(atIdx, atIdx + 1), atIdx, false));
            i = atIdx + 1;
            continue;
        }

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
                const username = person.username || '';
                if (!name && !username) continue;
                // Match @displayName OR @username
                const expectedName = name ? '@' + name : '';
                const expectedUsername = username ? '@' + username : '';
                const matchedExpected = [expectedName, expectedUsername].find((candidate) =>
                    candidate
                    && converted.startsWith(candidate, atIdx)
                    && !/[a-zA-Z0-9_]/.test(converted[atIdx + candidate.length] || '')
                ) || '';
                if (matchedExpected) {
                    const uid = person.contact_id || person.userId || '';
                    const mentionText = matchedExpected;
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
            // No name match - only accept a complete username token. The old
            // logic consumed every character through whitespace, so @@ and
            // punctuation-only strings were rendered as clickable mentions.
            const usernameMatch = converted.slice(atIdx).match(/^@[a-zA-Z0-9_]+/);
            const mentionText = usernameMatch?.[0] || '@';
            const end = atIdx + mentionText.length;
            const username = mentionText.slice(1); // strip @
            segments.push(
                <span key={atIdx} className="font-semibold cursor-pointer hover:underline"
                    style={{color: '#79b4fd'}}
                    onClick={async (e) => {
                        e.stopPropagation();
                        if (!onMentionClick) return;
                        // Resolve username → peerId từ DB (telegram_peers table)
                        try {
                            const accId = useAccountStore.getState().activeAccountId || '';
                            const peersRes = await ipc.telegramUser?.getPeers?.({ accountId: accId });
                            const peer = peersRes?.peers?.find((p: any) => p.username === username);
                            onMentionClick(peer?.peer_id || username, e);
                        } catch {
                            onMentionClick(username, e);
                        }
                    }}
                >{mentionText}</span>
            );
            i = end;
        }
    }

    if (segments.length === 0) return <span className="whitespace-pre-wrap select-text break-words" style={{ overflowWrap: 'break-word', wordBreak: 'normal', ...emojiFontStyle }}>{converted}</span>;
    return <span className="whitespace-pre-wrap select-text break-words" style={{ overflowWrap: 'break-word', wordBreak: 'normal', ...emojiFontStyle }}>{segments}</span>;
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
