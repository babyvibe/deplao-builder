/**
 * Logger Service - Controlled Logging System
 * Logger service: a logging system that can be turned on and off
 * Allows enable/disable logging via API or environment config
 * Enables or disables logging through the API or the environment config
 *
 * Shared by the main process and the renderer:
 *  - Main: buffer of 2000 lines → Settings → Logs (log:getBuffer / log:entry).
 *  - Renderer: console is stripped in production (vite/terser + obfuscator), so warn/error/notice are
 *    sent to main through window.electronAPI.logs.append (IPC 'log:append') → main writes them to Logs with the
 *    prefix [renderer] (appendFromRenderer). Both sides mask tokens/passwords/cookies, limit to
 *    ≤ 20 lines/second, and merge duplicate lines within 2 s.
 */
export type LogLevel = 'log' | 'error' | 'warn' | 'info' | 'debug';
export interface LogEntry { ts: number; level: LogLevel; msg: string; }

const MAX_BUFFER = 2000; // keep the latest 2000 lines in RAM
const LOG_LEVELS: readonly LogLevel[] = ['log', 'error', 'warn', 'info', 'debug'];

/** Renderer → main logs: at most N lines/second, merge duplicate lines within DEDUPE_MS, cut overly long lines. */
export const RENDERER_LOG_MAX_PER_SEC = 20;
export const RENDERER_LOG_DEDUPE_MS = 2000;
export const RENDERER_LOG_MAX_LEN = 2000;
export const RENDERER_LOG_PREFIX = '[renderer]';

// Keep references to the original console to avoid recursion when the global console hook is installed.
const rawConsole = {
    log: console.log.bind(console),
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
};

// ── Mask secrets in logs ─────────────────────────────────────────────

const SECRET_RULES: Array<[RegExp, string]> = [
    // Cookie: mask up to the end of the line (cookie values contain ';' / '=')
    [/\b(set-cookie|cookies?)(["']?\s*[:=]\s*)[^\r\n]*/gi, '$1$2***'],
    // key=value, "key":"value", key: value: token / password / API key / Authorization header
    [/\b(authorization|x-api-key|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|jwt|password|passwd|pwd|secret|signature|sig|session[_-]?id|imei)(["']?\s*[:=]\s*)(?:(?:bearer|basic)\s+)?("[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi, '$1$2***'],
    // Bearer/Basic inside free text
    [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
    // Plain JWT
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '***'],
];

/** Mask tokens/passwords/cookies and cut overly long lines; used for logs sent through IPC from the renderer to main. */
export function sanitizeLogText(text: string, maxLen: number = RENDERER_LOG_MAX_LEN): string {
    let out = String(text ?? '');
    for (const [re, replacement] of SECRET_RULES) out = out.replace(re, replacement);
    if (out.length > maxLen) out = `${out.slice(0, maxLen)}… (+${out.length - maxLen} ký tự)`;
    return out;
}

/** Join log arguments into 1 line (Error → "Name: message" instead of "{}"). */
function formatLogArgs(args: any[]): string {
    return args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        try { return JSON.stringify(a); } catch { return String(a); }
    }).join(' ');
}

/**
 * Rate limit (≤ maxPerSec lines/second) + merge duplicate lines within the dedupeMs window.
 * Lines that differ only in duration ("35ms", "1.2s") count as duplicates.
 * The number of merged / dropped lines is reported on the next line that is written.
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

    /** Returns the lines that may be written (may include a summary line with the number of dropped lines); an empty array = blocked. */
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
        // Still too many different lines → drop the oldest one (a Map keeps insertion order)
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
    /** Renderer: limit for logs sent to main. */
    private readonly forwardLimiter = new LogRateLimiter();
    /** Main: limit for logs received from the renderer (IPC + console-message). */
    private readonly ingestLimiter = new LogRateLimiter();
    private forwarding = false;

    private constructor() {
        // The buffer always records (even in production) so the Logs tab can show it;
        // isEnabled only controls printing to the console.
        this.isEnabled = process.env.NODE_ENV !== 'production';
    }

    /**
     * Hooks the global console.* so that console calls made directly (not through Logger) also go into the buffer.
     * Called once in the main process. Uses rawConsole to print → no recursion.
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

    /** Register 1 listener (the main process forwards to the renderer). */
    public onEntry(cb: (entry: LogEntry) => void): void { this.listener = cb; }

    /** Get the whole current buffer (used when the tab is opened for the first time). */
    public getBuffer(): LogEntry[] { return this.buffer; }

    /** Clear the buffer. */
    public clearBuffer(): void { this.buffer = []; }

    private record(level: LogLevel, args: any[]): string {
        const msg = formatLogArgs(args);
        const entry: LogEntry = { ts: Date.now(), level, msg };
        this.buffer.push(entry);
        if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
        try { this.listener?.(entry); } catch { /* a failing listener must not crash the log */ }
        return msg;
    }

    /**
     * Renderer → main (Logs). Only runs when window.electronAPI.logs.append exists (renderer);
     * the main process has no electronAPI, so it is a no-op there.
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
        } catch { /* an IPC error must not crash the caller */ }
        finally { this.forwarding = false; }
    }

    /**
     * Main: writes 1 log line sent by the renderer into the buffer / Logs with the prefix [renderer]. Checks the type itself,
     * masks secrets, rate limits + merges duplicate lines.
     * source 'console' = an error Chromium reports by itself (webContents 'console-message'): it may contain data
     * (e.g. a JSON.parse error that echoes the input) → drops the "…" strings and long '…' strings, cut to 500 characters.
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
     * Turn logging on
     */
    public enable(): void {
        this.isEnabled = true;
        rawConsole.log(`[${new Date().toISOString()}] [Logger] ✅ Logging enabled`);
    }

    /**
     * Disable logging
     * Turn logging off
     */
    public disable(): void {
        rawConsole.log(`[${new Date().toISOString()}] [Logger] 🔇 Logging disabled`);
        this.isEnabled = false;
    }

    /**
     * Check if logging is enabled
     * Check whether logging is turned on
     */
    public isLoggingEnabled(): boolean {
        return this.isEnabled;
    }

    /**
     * Get status
     * Get the status
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
     * Write an info log (only when enabled)
     */
    public log(...args: any[]): void {
        this.record('log', args);
        if (this.isEnabled) {
            rawConsole.log(...args);
        }
    }

    /**
     * Log error message (always shown, even when disabled)
     * Log an error (always shown, even when disabled). In the renderer: forwarded to Logs (main).
     */
    public error(...args: any[]): void {
        const msg = this.record('error', args);
        rawConsole.error(...args);
        this.forwardToMain('error', msg);
    }

    /**
     * Log warning message (only if enabled)
     * Log a warning (only when enabled). In the renderer: forwarded to Logs (main).
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
     * Write an info log (only when enabled)
     */
    public info(...args: any[]): void {
        this.record('info', args);
        if (this.isEnabled) {
            rawConsole.info(...args);
        }
    }

    /**
     * An important info-level event (e.g. a connection state change): logged as info, and in the renderer
     * always forwarded to the main Logs (plain info/log calls are not).
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
     * Write a debug log (only when enabled)
     */
    public debug(...args: any[]): void {
        this.record('debug', args);
        if (this.isEnabled) {
            rawConsole.debug(...args);
        }
    }
}

export default Logger.getInstance();

