/**
 * Máy có đang rảnh để chạy việc nặng (chép + nén cả DB, quét cả thư mục media…) không. Như bảo trì của Windows,
 * OneDrive, Time Machine: không chạy ngay sau khi máy thức dậy / mở khoá / mở app (Windows đang nạp lại bộ nhớ từ ổ đĩa,
 * các kênh đang đồng bộ bù), chờ người dùng không chạm máy một lúc và máy đang cắm sạc; chờ quá lâu thì vẫn chạy.
 *
 * main.ts báo sự kiện powerMonitor qua noteSystemPower(); module khác nghe bằng onSystemPower(). Ngoài Electron (test)
 * systemIdleInfo() = null → idleWaitReason() không bắt chờ (chạy như trước).
 */

export type SystemPowerEvent = 'suspend' | 'resume' | 'unlock';

export interface SystemIdleInfo {
    /** Thời gian người dùng không chạm bàn phím / chuột (ms; null = không biết). */
    idleMs: number | null;
    onBattery: boolean;
}

export type IdleWaitReason = 'wake' | 'battery' | 'active';

/** Sau khi máy thức dậy / mở khoá / mở app: chưa chạy việc nặng. */
export const WAKE_QUIET_MS = 15 * 60_000;
/** Người dùng không chạm máy từng này mới coi là rảnh. */
export const IDLE_MIN_MS = 10 * 60_000;

export const IDLE_WAIT_LABEL: Record<IdleWaitReason, string> = {
    wake: 'máy vừa thức dậy / mở app',
    battery: 'đang chạy pin',
    active: 'đang có người dùng máy',
};

/**
 * Hẹn giờ / nhịp chạy trễ hơn mức này = tiến trình vừa bị đóng băng (máy ngủ / Modern Standby, app treo): coi như máy
 * vừa thức dậy (máy đang nạp lại bộ nhớ từ ổ đĩa, mạng chưa sẵn sàng).
 */
export const TIME_JUMP_MS = 2 * 60_000;
const WAKE_WATCH_INTERVAL_MS = 30_000;

const PROCESS_STARTED_AT = Date.now() - Math.round(process.uptime() * 1000);
let lastWakeAt = 0;
const listeners = new Set<(ev: SystemPowerEvent, at: number) => void>();

/** powerMonitor (main.ts): máy sắp ngủ / vừa thức dậy / vừa mở khoá. */
export function noteSystemPower(ev: SystemPowerEvent, at = Date.now()): void {
    if (ev !== 'suspend') lastWakeAt = Math.max(lastWakeAt, at);
    for (const fn of [...listeners]) {
        try { fn(ev, at); } catch { /* một nơi nghe lỗi không ảnh hưởng nơi khác */ }
    }
}

export function onSystemPower(fn: (ev: SystemPowerEvent, at: number) => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

let wakeWatch: ReturnType<typeof setInterval> | null = null;

/**
 * main.ts: nhịp 30 giây phát hiện máy vừa ngủ dậy khi powerMonitor không báo (hai nhịp cách nhau quá TIME_JUMP_MS)
 * → noteSystemPower('resume'). Chỉ báo cho các việc nặng chờ máy rảnh, không thay cho xử lý resume của từng kênh.
 */
export function startWakeWatch(): void {
    if (wakeWatch) return;
    let last = Date.now();
    wakeWatch = setInterval(() => {
        const now = Date.now();
        if (now - last > TIME_JUMP_MS) noteSystemPower('resume', now);
        last = now;
    }, WAKE_WATCH_INTERVAL_MS);
    (wakeWatch as any)?.unref?.();
}

/** Mốc máy thức dậy / mở khoá gần nhất (0 = chưa có từ lúc mở app). */
export function lastSystemWakeAt(): number {
    return lastWakeAt;
}

/** Mốc mở app / máy thức dậy / mở khoá gần nhất. */
export function lastWakeOrStartAt(): number {
    return Math.max(PROCESS_STARTED_AT, lastWakeAt);
}

/** Người dùng có đang dùng máy / máy chạy pin không. Ngoài Electron (test) = null. */
export function systemIdleInfo(): SystemIdleInfo | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { powerMonitor } = require('electron');
        if (!powerMonitor || typeof powerMonitor.getSystemIdleTime !== 'function') return null;
        return { idleMs: powerMonitor.getSystemIdleTime() * 1000, onBattery: !!powerMonitor.isOnBatteryPower?.() };
    } catch {
        return null;
    }
}

/**
 * null = được chạy việc nặng ngay; còn lại = lý do phải chờ. info null (không biết) = không chờ. Vừa thức dậy thì chờ
 * cả khi đã chờ quá maxWaitMs (tính từ dueSince; dueSince 0 = không giới hạn).
 */
export function idleWaitReason(p: {
    now: number;
    /** Mốc mở app / thức dậy / mở khoá gần nhất. */
    wakeAt: number;
    /** Lúc việc nặng bắt đầu đến hạn (0 = không tính mức chờ tối đa). */
    dueSince: number;
    maxWaitMs: number;
    info: SystemIdleInfo | null;
}): IdleWaitReason | null {
    if (!p.info) return null;
    if (p.now - p.wakeAt < WAKE_QUIET_MS) return 'wake';
    if (p.dueSince > 0 && p.now - p.dueSince >= p.maxWaitMs) return null;
    if (p.info.onBattery) return 'battery';
    if ((p.info.idleMs ?? 0) >= IDLE_MIN_MS) return null;
    return 'active';
}
