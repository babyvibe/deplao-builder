/**
 * Zalo login with a QR code (zca-js loginQR): classifies how the QR attempt ended + the message shown to the user.
 *
 * "Operation aborted" (ZaloApiLoginQRAborted) is not an error that Zalo returns: zca-js only throws when the app itself calls
 * actions.abort(). Deplao calls it when the Add account window closes, the tab changes, the user goes back, or they click Refresh QR.
 */

/** QR attempt cancelled by the app (window closed / Refresh). */
import { tr } from '../i18n';

export function isQrLoginCancelled(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === 'ZaloApiLoginQRAborted';
}

/** Message shown when QR login fails; the original error (in English, may include Zalo's JSON) is written to the Log. */
export function qrLoginErrorText(err: unknown): string {
  const msg = String((err as { message?: unknown } | null)?.message ?? err ?? '');
  if (/generate QRCode|login version/i.test(msg)) return tr('Không tạo được mã QR. Kiểm tra mạng hoặc proxy.');
  if (/scan result|confirm result|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket|network|fetch failed|proxy/i.test(msg)) {
    return tr('Mất kết nối tới Zalo. Kiểm tra mạng hoặc proxy.');
  }
  if (/session|account info|Can't login/i.test(msg)) return tr('Zalo đã xác nhận nhưng chưa lấy được phiên. Thử lại.');
  return tr('Đăng nhập không thành công. Thử lại.');
}
