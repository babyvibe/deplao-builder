/**
 * Logger Service - Controlled Logging System
 * Dịch vụ Logger - Hệ thống ghi log có thể kiểm soát
 * Allows enable/disable logging via API or environment config
 * Cho phép bật/tắt logging thông qua API hoặc cấu hình môi trường
 */
export type LogLevel = 'log' | 'error' | 'warn' | 'info' | 'debug';
export interface LogEntry { ts: number; level: LogLevel; msg: string; }

const MAX_BUFFER = 2000; // giữ 2000 dòng gần nhất trong RAM

// Giữ tham chiếu console gốc để tránh đệ quy khi hook console toàn cục.
const rawConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
};

class Logger {
    private static instance: Logger;
    private isEnabled: boolean = false;
    private buffer: LogEntry[] = [];
    private listener: ((entry: LogEntry) => void) | null = null;
    private consoleHooked = false;

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

    private record(level: LogLevel, args: any[]): void {
        const msg = args.map(a => {
            if (typeof a === 'string') return a;
            try { return JSON.stringify(a); } catch { return String(a); }
        }).join(' ');
        const entry: LogEntry = { ts: Date.now(), level, msg };
        this.buffer.push(entry);
        if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
        try { this.listener?.(entry); } catch { /* listener lỗi không được làm sập log */ }
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
     * Ghi log lỗi (luôn hiển thị, ngay cả khi tắt)
     */
    public error(...args: any[]): void {
        this.record('error', args);
        rawConsole.error(...args);
    }

    /**
     * Log warning message (only if enabled)
     * Ghi log cảnh báo (chỉ khi được bật)
     */
    public warn(...args: any[]): void {
        this.record('warn', args);
        if (this.isEnabled) {
            rawConsole.warn(...args);
        }
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

