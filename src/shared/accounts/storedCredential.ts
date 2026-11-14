/**
 * Login session stored in accounts.cookies (Zalo cookies, GramJS session, Telegram bot token) is encrypted with Electron
 * safeStorage (DatabaseService.saveAccount / encryptStoredCredentials). Reading through getAccounts() decrypts it. A value that is still
 * encrypted means this machine / Windows account cannot decrypt it (the data folder was copied from another machine, or the "Local State" file of userData was lost…), so
 * the user must log in again. Do not connect with that string (Telegram would retry forever).
 */

/** safeStorage (Chromium os_crypt) writes the prefix "v10" / "v11" → base64 "djEw" / "djEx"; "U2Fsd" = an old CryptoJS blob ("Salted__"). */
const UNDECRYPTED_PREFIXES = ['djEw', 'djEx', 'U2Fsd'];

export function isUndecryptedCredential(value: string | null | undefined): boolean {
  const text = String(value || '').trimStart();
  return UNDECRYPTED_PREFIXES.some(prefix => text.startsWith(prefix));
}

/** Telegram bot token in the form "<bot id>:<key>" (BotFather). */
export function isTelegramBotToken(value: string | null | undefined): boolean {
  return /^\d+:[A-Za-z0-9_-]+$/.test(String(value || '').trim());
}
