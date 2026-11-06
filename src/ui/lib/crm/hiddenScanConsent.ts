/**
 * Đồng ý "Quét thành viên nhóm ẩn qua máy chủ Deplao" (Zalo). Lưu theo máy (localStorage), MẶC ĐỊNH TẮT từ 26.11.0.
 *
 * Vì sao cần đồng ý: cách quét nhóm ẩn thành viên chạy trên máy chủ deplaoapp.com (giữ kín, không đưa vào mã nguồn mở
 * của app), nên app phải gửi PHIÊN ĐĂNG NHẬP ZALO (cookie + IMEI) của tài khoản đang quét lên máy chủ
 * (`scanGroupViaBackend`, lib/crm/backendService.ts). Ai có cookie đó dùng được tài khoản Zalo, nên chỉ gửi khi người
 * dùng đã đồng ý rõ ràng:
 *   - Chưa đồng ý: mọi chỗ quét hỏi bằng hộp thoại (components/crm/groups/HiddenScanConsentDialog.tsx) TRƯỚC khi gửi;
 *     "Không đồng ý" = không gửi gì, các tính năng khác vẫn chạy (làm mới nhóm bằng API Zalo trên máy vẫn được).
 *     Chỗ quét: CRM → Nhóm → Quét thành viên (nút Quét), CRM → Nhóm → Thành viên nhóm (Tải thông tin thành viên),
 *     panel thành viên nhóm trong hội thoại (nút "Quét đủ thành viên"; nút tải lại chỉ quét khi đã đồng ý),
 *     nhập nhóm hàng loạt vào kho nhóm chung (đếm thành viên).
 *   - Đồng ý (ở hộp thoại hoặc công tắc CRM → Nhóm → Quét thành viên) được nhớ trên máy này; tắt lại lúc nào cũng được,
 *     tắt là ngừng gửi ngay.
 *   - `scanGroupViaBackend` tự kiểm tra lại `hasHiddenScanConsent()`: chưa đồng ý thì trả lỗi, không gọi mạng. Chỗ gọi
 *     mới quên hỏi cũng không làm lộ cookie.
 * Máy chủ chỉ dùng cookie trong lần quét đó, không lưu; nhật ký máy chủ chỉ có ID tài khoản, ID nhóm, IP, user agent,
 * thời gian, mã kết quả (dep-lao-backend-payment: scan.controller.ts, middleware/publicApiLogger.ts).
 */
import { useSyncExternalStore } from 'react';

const STORAGE_KEY = 'deplao.crm.hiddenScanConsent';

export interface HiddenScanConsent {
  granted: boolean;
  /** Lúc đồng ý (ms); null khi chưa đồng ý / đã tắt. */
  at: number | null;
}

const OFF: HiddenScanConsent = { granted: false, at: null };
let cached: HiddenScanConsent | null = null;
const listeners = new Set<() => void>();

function readStored(): HiddenScanConsent {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return OFF;
    const parsed = JSON.parse(raw) as Partial<HiddenScanConsent> | null;
    return parsed?.granted === true ? { granted: true, at: Number(parsed.at) || null } : OFF;
  } catch {
    return OFF;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

export function getHiddenScanConsent(): HiddenScanConsent {
  if (!cached) cached = readStored();
  return cached;
}

/** Đã đồng ý gửi phiên đăng nhập Zalo lên máy chủ Deplao để quét nhóm ẩn (trên máy này). */
export function hasHiddenScanConsent(): boolean {
  return getHiddenScanConsent().granted;
}

/** Bật (người dùng vừa đồng ý) / tắt (rút lại đồng ý, ngừng gửi ngay). */
export function setHiddenScanConsent(granted: boolean, now: number = Date.now()): void {
  cached = granted ? { granted: true, at: now } : OFF;
  try {
    if (granted) globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(cached));
    else globalThis.localStorage?.removeItem(STORAGE_KEY);
  } catch { /* localStorage hỏng: vẫn áp dụng trong phiên này */ }
  notify();
}

export function subscribeHiddenScanConsent(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Cửa sổ khác của app đổi lựa chọn → đọc lại
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    cached = readStored();
    notify();
  });
}

export function useHiddenScanConsent(): HiddenScanConsent {
  return useSyncExternalStore(subscribeHiddenScanConsent, getHiddenScanConsent, () => OFF);
}

/** Chỉ cho test: quên giá trị đã đọc. */
export function resetHiddenScanConsentCache(): void {
  cached = null;
}
