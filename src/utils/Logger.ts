/**
 * Logger Service - Controlled Logging System
 * Dịch vụ Logger - Hệ thống ghi log có thể kiểm soát
 * Allows enable/disable logging via API or environment config
 * Cho phép bật/tắt logging thông qua API hoặc cấu hình môi trường
 *
 * Dùng chung cho main process và renderer:
 *  - Main: buffer 2000 dòng → Settings → Nhật ký (log:getBuffer / log:entry).
 *  - Renderer: console bị strip ở production (vite/terser + obfuscator), nên warn/error/notice được
 *    chuyển về main qua window.electronAPI.logs.append (IPC 'log:append') → main ghi vào Nhật ký với
 *    prefix [renderer] (appendFromRenderer). Cả hai phía đều che token/mật khẩu/cookie, giới hạn
 *    ≤ 20 dòng/giây và gộp dòng trùng trong 2 s.
 */
export type LogLevel = 'log' | 'error' | 'warn' | 'info' | 'debug';
export interface LogEntry { ts: number; level: LogLevel; msg: string; }

const MAX_BUFFER = 2000; // giữ 2000 dòng gần nhất trong RAM
const LOG_LEVELS: readonly LogLevel[] = ['log', 'error', 'warn', 'info', 'debug'];

/** Log renderer → main: tối đa N dòng/giây, gộp dòng trùng trong DEDUPE_MS, cắt dòng quá dài. */
export const RENDERER_LOG_MAX_PER_SEC = 20;
export const RENDERER_LOG_DEDUPE_MS = 2000;
export const RENDERER_LOG_MAX_LEN = 2000;
export const RENDERER_LOG_PREFIX = '[renderer]';

// Giữ tham chiếu console gốc để tránh đệ quy khi hook console toàn cục.
const rawConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
};

// ── Che bí mật trong log ─────────────────────────────────────────────

const SECRET_RULES: Array<[RegExp, string]> = [
    // Cookie: che tới hết dòng (giá trị cookie chứa ';' / '=')
    [/\b(set-cookie|cookies?)(["']?\s*[:=]\s*)[^\r\n]*/gi, '$1$2***'],
    // key=value, "key":"value", key: value — token / mật khẩu / khoá API / header Authorization
    [/\b(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|jwt|password|passwd|pwd|secret|signature|sig|session[_-]?id|imei)(["']?\s*[:=]\s*)(?:(?:bearer|basic)\s+)?("[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi, '$1$2***'],
    // Bearer/Basic trong chuỗi tự do
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
    // JWT trơn
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '***'],
];

/** Che token/mật khẩu/cookie và cắt dòng quá dài — dùng cho log đi qua IPC renderer → main. */
export function sanitizeLogText(text: string, maxLen: number = RENDERER_LOG_MAX_LEN): string {
    let out = String(text ?? '');
    for (const [re, replacement] of SECRET_RULES) out = out.replace(re, replacement);
    if (out.length > maxLen) out = `${out.slice(0, maxLen)}… (+${out.length - maxLen} ký tự)`;
    return out;
}

/** Ghép tham số log thành 1 dòng (Error → "Name: message" thay vì "{}"). */
function formatLogArgs(args: any[]): string {
    return args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
}

/**
 * Giới hạn tốc độ (≤ maxPerSec dòng/giây) + gộp dòng trùng trong cửa sổ dedupeMs.
 * Dòng chỉ khác nhau ở thời lượng ("35ms", "1.2s") được coi là trùng.
 * Số dòng bị gộp / bị bỏ được báo kèm ở dòng được ghi kế tiếp.
 */
export class LogRateLimiter {
    private windowStart = 0;
    private sentInWindow = 0;
    private dropped = 0;
    private readonly recent = new Map<string, { ts: number; repeats: number }>();

    constructor(
        private readonly maxPerSec: number = RENDERER_LOG_MAX_PER_SEC,
        private readonly dedupeMs: number = RENDERER_LOG_DEDUPE_MS,
    ) {}

    /** Trả về các dòng được phép ghi (có thể kèm dòng tổng kết số dòng bị bỏ); mảng rỗng = chặn. */
    public admit(level: LogLevel, msg: string, now: number = Date.now()): Array<{ level: LogLevel; msg: string }> {
        const key = `${level}|${msg.replace(/\d+(?:\.\d+)?\s?(?:ms|s)\b/g, '#')}`;
        const seen = this.recent.get(key);
        if (seen && now - seen.ts < this.dedupeMs) {
            seen.repeats++;
            return [];
        }
        if (now - this.windowStart >= 1000) {
            this.windowStart = now;
            this.sentInWindow = 0;
        }
        if (this.sentInWindow >= this.maxPerSec) {
            this.dropped++;
            return [];
        }
        const out: Array<{ level: LogLevel; msg: string }> = [];
        if (this.dropped > 0 && this.sentInWindow + 1 < this.maxPerSec) {
            out.push({ level: 'warn', msg: `… bỏ qua ${this.dropped} dòng log (vượt giới hạn ${this.maxPerSec} dòng/giây)` });
            this.sentInWindow++;
            this.dropped = 0;
        }
        const repeated = seen && seen.repeats > 0
            ? ` (lặp lại ${seen.repeats} lần trong ${Math.round(this.dedupeMs / 1000)}s trước)`
            : '';
        this.recent.delete(key);
        this.recent.set(key, { ts: now, repeats: 0 });
        if (this.recent.size > 300) this.prune(now);
        out.push({ level, msg: msg + repeated });
        this.sentInWindow++;
        return out;
    }

    private prune(now: number): void {
        for (const [k, v] of this.recent) {
            if (now - v.ts >= this.dedupeMs) this.recent.delete(k);
        }
        // Vẫn quá nhiều dòng khác nhau → bỏ dòng cũ nhất (Map giữ thứ tự chèn)
        while (this.recent.size > 300) {
            const oldest = this.recent.keys().next().value;
            if (oldest === undefined) break;
            this.recent.delete(oldest);
        }
    }
}

class Logger {
    private static instance: Logger;
    private isEnabled: boolean = false;
    private buffer: LogEntry[] = [];
    private listener: ((entry: LogEntry) => void) | null = null;
    private consoleHooked = false;
    /** Renderer: giới hạn log gửi sang main. */
    private readonly forwardLimiter = new LogRateLimiter();
    /** Main: giới hạn log nhận từ renderer (IPC + console-message). */
    private readonly ingestLimiter = new LogRateLimiter();
    private forwarding = false;

    private constructor() {
        // Buffer luôn ghi (kể cả production) để tab Nhật ký xem được;
        // isEnabled chỉ điều khiển việc in ra console.
        this.isEnabled = process.env.NODE_ENV !== 'production';
    }

    /**
     * Hook console.* toàn cục để mọi console thẳng (không qua Logger) cũng vào buffer.
     * Gọi 1 lần ở main process. Dùng rawConsole để in ra → không đệ quy.
     */
    public installConsoleHook(): void {
        if (this.consoleHooked) return;
        this.consoleHooked = true;
        const levels: LogLevel[] = ['log', 'error', 'warn', 'info', 'debug'];
        for (const level of levels) {
            (console as any)[level] = (...args: any[]) => {
                this.record(level, args);
                rawConsole[level](...args);
            };
        }
    }

    /** Đăng ký 1 listener (main process forward sang renderer). */
    public onEntry(cb: (entry: LogEntry) => void): void { this.listener = cb; }

    /** Lấy toàn bộ buffer hiện có (dùng khi mở tab lần đầu). */
    public getBuffer(): LogEntry[] { return this.buffer; }

    /** Xóa buffer. */
    public clearBuffer(): void { this.buffer = []; }

    private record(level: LogLevel, args: any[]): string {
        const msg = formatLogArgs(args);
        const entry: LogEntry = { ts: Date.now(), level, msg };
        this.buffer.push(entry);
        if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
        try { this.listener?.(entry); } catch { /* listener lỗi không được làm sập log */ }
        return msg;
    }

    /**
     * Renderer → main (Nhật ký). Chỉ chạy khi có window.electronAPI.logs.append (renderer);
     * ở main process không có electronAPI nên là no-op.
     */
    private forwardToMain(level: LogLevel, msg: string): void {
        if (this.forwarding) return;
        let append: any;
        try { append = (globalThis as any).electronAPI?.logs?.append; } catch { return; }
        if (typeof append !== 'function') return;
        this.forwarding = true;
        try {
            for (const line of this.forwardLimiter.admit(level, sanitizeLogText(msg))) {
                append(line.level, line.msg);
            }
        } catch { /* IPC lỗi không được làm sập caller */ }
        finally { this.forwarding = false; }
    }

    /**
     * Main: ghi 1 dòng log do renderer gửi vào buffer/Nhật ký với prefix [renderer]. Tự kiểm tra kiểu,
     * che bí mật, giới hạn tốc độ + gộp dòng trùng.
     * source 'console' = lỗi Chromium tự báo (webContents 'console-message'): có thể trích dữ liệu
     * (vd JSON.parse lỗi in lại input) → bỏ chuỗi trong "…" và chuỗi '…' dài, cắt còn 500 ký tự.
     */
    public appendFromRenderer(level: unknown, msg: unknown, source: 'ipc' | 'console' = 'ipc'): void {
        if (typeof msg !== 'string') return;
        const lv: LogLevel = typeof level === 'string' && (LOG_LEVELS as readonly string[]).includes(level)
            ? level as LogLevel
            : 'log';
        let raw = msg;
        let maxLen = RENDERER_LOG_MAX_LEN;
        let prefix = '';
        if (source === 'console') {
            raw = raw.replace(/"[^"\r\n]{4,}"/g, '"…"').replace(/'[^'\r\n]{32,}'/g, "'…'");
            maxLen = 500;
            prefix = '[console] ';
        }
        const text = sanitizeLogText(raw, maxLen).trim();
        if (!text) return;
        for (const line of this.ingestLimiter.admit(lv, prefix + text)) {
            const out = `${RENDERER_LOG_PREFIX} ${line.msg}`;
            this.record(line.level, [out]);
            if (this.isEnabled || line.level === 'error') rawConsole[line.level](out);
        }
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    /**
     * Enable logging
     * Bật logging
     */
    public enable(): void {
        this.isEnabled = true;
        rawConsole.log(`[${new Date().toISOString()}] [Logger] ✅ Logging enabled`);
    }

    /**
     * Disable logging
     * Tắt logging
     */
    public disable(): void {
        rawConsole.log(`[${new Date().toISOString()}] [Logger] 🔇 Logging disabled`);
        this.isEnabled = false;
    }

    /**
     * Check if logging is enabled
     * Kiểm tra xem logging có được bật không
     */
    public isLoggingEnabled(): boolean {
        return this.isEnabled;
    }

    /**
     * Get status
     * Lấy trạng thái
     */
    public getStatus(): {
        enabled: boolean;
        environment: string;
    } {
        return {
            enabled: this.isEnabled,
            environment: process.env.NODE_ENV || 'development'
        };
    }

    /**
     * Log info message (only if enabled)
     * Ghi log thông tin (chỉ khi được bật)
     */
    public log(...args: any[]): void {
        this.record('log', args);
        if (this.isEnabled) {
            rawConsole.log(...args);
        }
    }

    /**
     * Log error message (always shown, even when disabled)
     * Ghi log lỗi (luôn hiển thị, ngay cả khi tắt). Ở renderer: chuyển về Nhật ký (main).
     */
    public error(...args: any[]): void {
        const msg = this.record('error', args);
        rawConsole.error(...args);
        this.forwardToMain('error', msg);
    }

    /**
     * Log warning message (only if enabled)
     * Ghi log cảnh báo (chỉ khi được bật). Ở renderer: chuyển về Nhật ký (main).
     */
    public warn(...args: any[]): void {
        const msg = this.record('warn', args);
        if (this.isEnabled) {
            rawConsole.warn(...args);
        }
        this.forwardToMain('warn', msg);
    }

    /**
     * Log info message (only if enabled)
     * Ghi log thông tin (chỉ khi được bật)
     */
    public info(...args: any[]): void {
        this.record('info', args);
        if (this.isEnabled) {
            rawConsole.info(...args);
        }
    }

    /**
     * Sự kiện quan trọng mức info (vd chuyển trạng thái kết nối): ghi như info và — ở renderer —
     * luôn chuyển về Nhật ký của main (info/log thường thì không).
     */
    public notice(...args: any[]): void {
        const msg = this.record('info', args);
        if (this.isEnabled) {
            rawConsole.info(...args);
        }
        this.forwardToMain('info', msg);
    }

    /**
     * Log debug message (only if enabled)
     * Ghi log debug (chỉ khi được bật)
     */
    public debug(...args: any[]): void {
        this.record('debug', args);
        if (this.isEnabled) {
            rawConsole.debug(...args);
        }
    }
}

export default Logger.getInstance();

