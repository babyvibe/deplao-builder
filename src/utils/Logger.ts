/**
 * Logger Service - Controlled Logging System
 * Dịch vụ Logger - Hệ thống ghi log có thể kiểm soát
 * Allows enable/disable logging via API or environment config
 * Cho phép bật/tắt logging thông qua API hoặc cấu hình môi trường
 */
class Logger {
    private static instance: Logger;
    private isEnabled: boolean = false;

    private constructor() {
        // Default: Enable in development, disable in production
        // Mặc định: Bật trong development, tắt trong production
        this.isEnabled = process.env.NODE_ENV !== 'production';
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
        console.log(`[${new Date().toISOString()}] [Logger] ✅ Logging enabled`);
    }

    /**
     * Disable logging
     * Tắt logging
     */
    public disable(): void {
        console.log(`[${new Date().toISOString()}] [Logger] 🔇 Logging disabled`);
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
        if (this.isEnabled) {
            console.log(...args);
        }
    }

    /**
     * Log error message (always shown, even when disabled)
     * Ghi log lỗi (luôn hiển thị, ngay cả khi tắt)
     */
    public error(...args: any[]): void {
        console.error(...args);
    }

    /**
     * Log warning message (only if enabled)
     * Ghi log cảnh báo (chỉ khi được bật)
     */
    public warn(...args: any[]): void {
        if (this.isEnabled) {
            console.warn(...args);
        }
    }

    /**
     * Log info message (only if enabled)
     * Ghi log thông tin (chỉ khi được bật)
     */
    public info(...args: any[]): void {
        if (this.isEnabled) {
            console.info(...args);
        }
    }

    /**
     * Log debug message (only if enabled)
     * Ghi log debug (chỉ khi được bật)
     */
    public debug(...args: any[]): void {
        if (this.isEnabled) {
            console.debug(...args);
        }
    }
}

export default Logger.getInstance();

