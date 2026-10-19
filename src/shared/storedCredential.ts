/**
 * Phiên đăng nhập lưu trong accounts.cookies (cookie Zalo, phiên GramJS, token bot Telegram) được mã hoá bằng Electron
 * safeStorage — DatabaseService.saveAccount / encryptStoredCredentials. Đọc qua getAccounts() là đã giải mã; giá trị vẫn
 * còn dạng mã hoá nghĩa là máy / tài khoản Windows này không giải mã được (thư mục dữ liệu chép từ máy khác, mất file
 * "Local State" của userData…) → cần đăng nhập lại, đừng kết nối bằng chuỗi đó (Telegram sẽ thử lại mãi).
 */

/** safeStorage (Chromium os_crypt) ghi tiền tố "v10" / "v11" → base64 "djEw" / "djEx"; "U2Fsd" = blob CryptoJS ("Salted__") cũ. */
const UNDECRYPTED_PREFIXES = ['djEw', 'djEx', 'U2Fsd'];

export function isUndecryptedCredential(value: string | null | undefined): boolean {
  const text = String(value || '').trimStart();
  return UNDECRYPTED_PREFIXES.some(prefix => text.startsWith(prefix));
}

/** Token bot Telegram dạng "<id bot>:<khoá>" (BotFather). */
export function isTelegramBotToken(value: string | null | undefined): boolean {
  return /^\d+:[A-Za-z0-9_-]+$/.test(String(value || '').trim());
}
