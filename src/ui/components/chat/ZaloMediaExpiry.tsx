/**
 * Media Zalo đã hết hạn.
 *
 * Zalo chỉ giữ ảnh/video trên CDN một thời gian: host CDN cũ bị gỡ khỏi DNS (vd `f24-zpc.zdn.vn` → ENOTFOUND)
 * hoặc CDN trả 404/410. Tin cũ (nhất là tin đồng bộ từ điện thoại) hay rơi vào trường hợp này. Main process
 * xác định hết hạn (`file:repairImage` / `file:checkMediaExpired`) và lưu cờ `messages.media_expired`;
 * renderer hiển thị "Ảnh/Video đã hết hạn" thay vì thử tải lại liên tục.
 */
import React from 'react';
import ipc from '@/lib/ipc';
import {useChatStore} from '@/store/chatStore';
import {isZalo} from '@/lib/channelHelper';

export type ExpiredMediaKind = 'image' | 'video';

/** Tin nhắn Zalo đã được đánh dấu hết hạn media. */
export function isMediaExpired(msg: any): boolean {
    return isZalo(msg?.channel) && Number(msg?.media_expired) === 1;
}

/** Cập nhật cờ hết hạn trong store để bubble của tin nhắn render lại ngay. */
export function setMediaExpiredInStore(msg: any, expired: boolean): void {
    if (!msg?.owner_zalo_id || !msg?.thread_id || !msg?.msg_id) return;
    useChatStore.getState().setMessageMediaExpired(
        String(msg.owner_zalo_id), String(msg.thread_id), String(msg.msg_id), expired,
    );
}

const checksInFlight = new Map<string, Promise<boolean>>();

/**
 * Hỏi main process media còn trên CDN Zalo không (GET 1 byte bằng session của tài khoản).
 * Trả true nếu đã hết hạn — cờ đã được lưu vào DB và store. Lỗi mạng / không xác định → false.
 * `force` = kiểm tra lại cả khi đã có cờ (nút "Thử tải lại"); còn dùng được → xoá cờ.
 */
export function checkZaloMediaExpired(msg: any, urls: string[], force = false): Promise<boolean> {
    if (!isZalo(msg?.channel) || !msg?.owner_zalo_id || !msg?.msg_id) return Promise.resolve(false);
    const key = `${msg.owner_zalo_id}:${msg.msg_id}:${force ? 'force' : ''}`;
    const pending = checksInFlight.get(key);
    if (pending) return pending;

    const run = (async () => {
        try {
            const res = await ipc.file?.checkMediaExpired({
                zaloId: String(msg.owner_zalo_id),
                msgId: String(msg.msg_id),
                urls: urls.filter(Boolean),
                force,
            });
            if (res?.expired) {
                setMediaExpiredInStore(msg, true);
                return true;
            }
            if (force && res?.success && !res.unknown) setMediaExpiredInStore(msg, false);
            return false;
        } catch {
            return false;
        }
    })();
    checksInFlight.set(key, run);
    void run.finally(() => checksInFlight.delete(key));
    return run;
}

function ExpiredIcon({kind, size}: { kind: ExpiredMediaKind; size: number }) {
    return (
        <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
             className="opacity-50">
            {kind === 'video' ? (
                <>
                    <polygon points="23 7 16 12 23 17 23 7"/>
                    <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                </>
            ) : (
                <>
                    <rect x="3" y="3" width="18" height="18" rx="2"/>
                    <circle cx="8.5" cy="8.5" r="1.5"/>
                    <polyline points="21 15 16 10 5 21"/>
                </>
            )}
            <line x1="2" y1="2" x2="22" y2="22"/>
        </svg>
    );
}

/** Khung thay cho ảnh/video Zalo đã hết hạn. `compact` = ô trong album ảnh. */
export function ExpiredMediaPlaceholder({kind, compact = false, onRetry, retrying = false, onClick, selected = false}: {
    kind: ExpiredMediaKind;
    compact?: boolean;
    onRetry?: () => void;
    retrying?: boolean;
    /** Ô trong album: click để chọn tin (chế độ chọn) hoặc kiểm tra lại. */
    onClick?: (e: React.MouseEvent) => void;
    /** Ô trong album đang được chọn (chế độ chọn nhiều tin). */
    selected?: boolean;
}) {
    const label = kind === 'video' ? 'Video đã hết hạn' : 'Ảnh đã hết hạn';
    const hint = 'Zalo không còn lưu file này';

    if (compact) {
        return (
            <div onClick={onClick} title={`${label} — ${hint}${onClick ? ' (bấm để kiểm tra lại)' : ''}`}
                 className={`h-40 flex-1 min-w-0 bg-muted/50 flex flex-col gap-1 items-center justify-center text-muted-foreground select-none px-1 text-center${onClick ? ' cursor-pointer' : ''}${selected ? ' ring-2 ring-blue-500' : ''}`}>
                <ExpiredIcon kind={kind} size={22}/>
                <span className="text-[10px] leading-tight opacity-70">{retrying ? 'Đang kiểm tra...' : label}</span>
            </div>
        );
    }

    return (
        <div title={hint}
             className="flex flex-col items-center justify-center gap-1 w-[17.5rem] max-w-xs h-32 rounded-xl bg-muted/40 text-muted-foreground select-none ring-1 ring-black/[0.12]">
            <ExpiredIcon kind={kind} size={28}/>
            <span className="text-xs font-medium opacity-80">{label}</span>
            <span className="text-[10px] opacity-50">{hint}</span>
            {onRetry && (
                <button type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            onRetry();
                        }}
                        disabled={retrying}
                        className="text-[11px] text-blue-400 hover:text-blue-300 hover:underline transition-colors disabled:opacity-50">
                    {retrying ? 'Đang kiểm tra...' : 'Thử tải lại'}
                </button>
            )}
        </div>
    );
}

function parseVideoContent(content: any): { href: string; thumb: string; durationSec: number } {
    try {
        const parsed = typeof content === 'string' ? JSON.parse(content || '{}') : (content || {});
        const params = typeof parsed?.params === 'string' ? JSON.parse(parsed.params || '{}') : (parsed?.params || {});
        return {
            href: typeof parsed?.href === 'string' ? parsed.href : '',
            thumb: typeof parsed?.thumb === 'string' ? parsed.thumb : '',
            durationSec: params?.duration ? Math.round(Number(params.duration) / 1000) : 0,
        };
    } catch {
        return {href: '', thumb: '', durationSec: 0};
    }
}

function formatDuration(totalSec: number): string {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Video Zalo chưa có file local (vd tin đồng bộ từ điện thoại): hiện thumbnail từ CDN, bấm để phát từ CDN.
 * Kiểm tra hết hạn trước khi phát và khi thumbnail lỗi → hết hạn thì hiện "Video đã hết hạn".
 */
export function ZaloRemoteVideoThumb({msg, onPlay}: { msg: any; onPlay: () => void }) {
    const {href, thumb, durationSec} = React.useMemo(() => parseVideoContent(msg?.content), [msg?.content]);
    const [thumbFailed, setThumbFailed] = React.useState(false);
    const [checking, setChecking] = React.useState(false);

    React.useEffect(() => {
        setThumbFailed(false);
    }, [thumb]);

    const check = React.useCallback(async (force: boolean) => {
        setChecking(true);
        try {
            return await checkZaloMediaExpired(msg, [href, thumb], force);
        } finally {
            setChecking(false);
        }
    }, [msg, href, thumb]);

    if (isMediaExpired(msg)) {
        return <ExpiredMediaPlaceholder kind="video" onRetry={() => void check(true)} retrying={checking}/>;
    }

    const handlePlay = async (e: React.MouseEvent) => {
        e.stopPropagation();
        if (checking || !href) return;
        // Hết hạn → store đánh dấu, bubble tự chuyển sang "Video đã hết hạn"
        if (await check(false)) return;
        onPlay();
    };

    return (
        <div
            onClick={handlePlay}
            title={href ? 'Phát video' : 'Không có đường dẫn video'}
            className="relative group/video cursor-pointer rounded-xl overflow-hidden bg-black ring-1 ring-black/[0.12] select-none"
            style={{width: '17.5rem', height: '10rem'}}
        >
            {thumb && !thumbFailed ? (
                <img src={thumb} alt="video thumb" className="w-full h-full object-cover"
                     onError={() => {
                         setThumbFailed(true);
                         void check(false);
                     }}/>
            ) : (
                <div className="w-full h-full bg-card flex items-center justify-center">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"
                         className="text-muted-foreground">
                        <polygon points="23 7 16 12 23 17 23 7"/>
                        <rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>
                    </svg>
                </div>
            )}

            <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-black/50"/>

            <div className="absolute inset-0 flex items-center justify-center">
                <div
                    className="w-14 h-14 bg-black/60 backdrop-blur-sm rounded-full flex items-center justify-center group-hover/video:bg-black/80 transition-colors shadow-lg">
                    {checking ? (
                        <div className="w-6 h-6 rounded-full border-2 border-white/30 border-t-white animate-spin"/>
                    ) : (
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="white">
                            <polygon points="5 3 19 12 5 21 5 3"/>
                        </svg>
                    )}
                </div>
            </div>

            {durationSec > 0 && (
                <span className="absolute bottom-2 right-2 text-[11px] text-white-important bg-black/60 rounded px-1.5 py-0.5">
                    {formatDuration(durationSec)}
                </span>
            )}
        </div>
    );
}
