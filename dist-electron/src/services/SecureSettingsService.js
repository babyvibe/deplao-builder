"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.secureSet = secureSet;
exports.secureGet = secureGet;
exports.secureDelete = secureDelete;
/**
 * SecureSettingsService.ts
 * Wrapper quanh electron.safeStorage để mã hóa data nhạy cảm trong SQLite.
 * Data được mã hóa bởi OS (Windows Credential Manager / macOS Keychain).
 * Chỉ app này trên đúng máy này mới giải mã được.
 */
const electron_1 = require("electron");
const DatabaseService_1 = __importDefault(require("./DatabaseService"));
const Logger_1 = __importDefault(require("../utils/Logger"));
const ENC_PREFIX = 'enc:';
/**
 * Lưu value được mã hóa bởi safeStorage vào SQLite settings.
 */
function secureSet(key, value) {
    if (!value && value !== '') {
        DatabaseService_1.default.getInstance().setSetting(key, '');
        return;
    }
    if (!electron_1.safeStorage.isEncryptionAvailable()) {
        // Fallback: lưu plaintext với warning (hiếm gặp — OS không hỗ trợ keychain)
        Logger_1.default.warn(`[SecureSettings] safeStorage unavailable — storing "${key}" as plaintext`);
        DatabaseService_1.default.getInstance().setSetting(key, value);
        return;
    }
    try {
        const encrypted = electron_1.safeStorage.encryptString(value).toString('base64');
        DatabaseService_1.default.getInstance().setSetting(key, `${ENC_PREFIX}${encrypted}`);
    }
    catch (err) {
        Logger_1.default.error(`[SecureSettings] Encrypt failed for "${key}": ${err.message}`);
        // Fallback to plaintext rather than losing data
        DatabaseService_1.default.getInstance().setSetting(key, value);
    }
}
/**
 * Đọc và giải mã value từ SQLite settings.
 * Trả về null nếu không tồn tại hoặc không giải mã được.
 */
function secureGet(key) {
    const raw = DatabaseService_1.default.getInstance().getSetting(key);
    if (!raw)
        return null;
    if (raw.startsWith(ENC_PREFIX)) {
        try {
            const buf = Buffer.from(raw.slice(ENC_PREFIX.length), 'base64');
            return electron_1.safeStorage.decryptString(buf);
        }
        catch (err) {
            Logger_1.default.warn(`[SecureSettings] Decrypt failed for "${key}" — may be from different machine: ${err.message}`);
            return null;
        }
    }
    // Plaintext cũ (chưa migrate) — trả về nguyên
    return raw;
}
/**
 * Xóa secure setting.
 */
function secureDelete(key) {
    DatabaseService_1.default.getInstance().setSetting(key, '');
}
//# sourceMappingURL=SecureSettingsService.js.map