/**
 * Nâng API layer của GramJS (thư viện Telegram MTProto).
 *
 * GramJS 2.26.22 — bản mới nhất trên npm — nói chuyện với Telegram bằng layer 198 (đầu 2025). Tin dùng tính năng mới hơn
 * thì server gửi cho layer cũ thành `messageMediaUnsupported` và để TRỐNG phần chữ: từ 30/08/2026 hàng chục nghìn tin chỉ
 * còn "Loại tin nhắn Telegram chưa được hỗ trợ" (chủ yếu tin định dạng phong phú — `message.rich_message`, layer 23x),
 * trong khi Telegram Desktop (layer 232) hiện đủ.
 *
 * GramJS dựng toàn bộ lớp `Api.*` lúc nạp module, từ chuỗi schema trong `telegram/tl/apiTl.js`, và gửi
 * `invokeWithLayer(AllTLObjects.LAYER, …)` khi kết nối. Deplao đặt schema mới (telegramApiSchema.ts) vào bộ nhớ đệm
 * module của Node TRƯỚC khi GramJS được nạp lần đầu và đổi LAYER — không sửa node_modules, dùng được cả khi đóng gói.
 * Phải gọi trước mọi `require('telegram')`: electron/bootstrap.ts gọi ngay sau `app.setName`.
 *
 * Chạy lại bằng layer cũ (chẩn đoán): biến môi trường DEPLAO_TELEGRAM_LAYER=198.
 */
import Module = require('module');
import { TELEGRAM_API_LAYER, TELEGRAM_API_SCHEMA } from './telegramApiSchema';

/** Layer của schema đi kèm GramJS 2.26.22. */
export const GRAMJS_BUNDLED_LAYER = 198;

export interface TelegramApiLayerState {
  /** Layer GramJS sẽ dùng khi kết nối. */
  layer: number;
  /** Đã thay schema của GramJS. */
  installed: boolean;
  /** Lý do không thay (env / GramJS đã nạp trước / lỗi). */
  reason?: string;
}

let state: TelegramApiLayerState | null = null;

function loadedLayer(): number {
  try {
    return Number(require('telegram/tl/AllTLObjects').LAYER) || GRAMJS_BUNDLED_LAYER;
  } catch {
    return GRAMJS_BUNDLED_LAYER;
  }
}

/** Thay schema của GramJS bằng layer mới. Gọi nhiều lần không sao (chỉ lần đầu có tác dụng). */
export function installTelegramApiLayer(env: NodeJS.ProcessEnv = process.env): TelegramApiLayerState {
  if (state) return state;
  if (String(env.DEPLAO_TELEGRAM_LAYER || '') === String(GRAMJS_BUNDLED_LAYER)) {
    state = { layer: GRAMJS_BUNDLED_LAYER, installed: false, reason: 'DEPLAO_TELEGRAM_LAYER' };
    return state;
  }
  try {
    const apiPath = require.resolve('telegram/tl/api.js');
    if (require.cache[apiPath]) {
      // Api.* đã dựng từ schema cũ — đổi LAYER lúc này sẽ gửi layer mới với bộ mã hoá cũ
      state = { layer: loadedLayer(), installed: false, reason: 'GramJS đã được nạp trước' };
      return state;
    }
    const schemaPath = require.resolve('telegram/tl/apiTl.js');
    const injected = new Module(schemaPath);
    injected.filename = schemaPath;
    injected.loaded = true;
    injected.exports = TELEGRAM_API_SCHEMA;
    require.cache[schemaPath] = injected;
    const allObjects = require('telegram/tl/AllTLObjects');
    allObjects.LAYER = TELEGRAM_API_LAYER;
    state = { layer: TELEGRAM_API_LAYER, installed: true };
  } catch (err: any) {
    state = { layer: loadedLayer(), installed: false, reason: err?.message || String(err) };
  }
  return state;
}

/** Trạng thái lần cài gần nhất (null = chưa gọi). */
export function telegramApiLayerState(): TelegramApiLayerState | null {
  return state;
}
