/**
 * Upgrades the API layer of GramJS (the Telegram MTProto library).
 *
 * GramJS 2.26.22 (the newest on npm) talks to Telegram with layer 198 (early 2025). When a message uses a newer feature, the server sends the old
 * layer a `messageMediaUnsupported` with the TEXT left EMPTY: since 30/08/2026 tens of thousands of messages show only
 * "Loại tin nhắn Telegram chưa được hỗ trợ" (Telegram message type not supported yet), mostly rich-format messages (`message.rich_message`, layer 23x),
 * while Telegram Desktop (layer 232) shows them in full.
 *
 * GramJS builds the whole `Api.*` class set when its module loads, from the schema string in `telegram/tl/apiTl.js`, and sends
 * `invokeWithLayer(AllTLObjects.LAYER, …)` on connect. Deplao puts the new schema (telegramApiSchema.ts) into the Node module cache
 * BEFORE GramJS is first loaded, and changes LAYER: node_modules is not edited, and it works in the packaged app too.
 * It must be called before any `require('telegram')`: electron/bootstrap.ts calls it right after `app.setName`.
 *
 * To run with the old layer again (diagnosis): environment variable DEPLAO_TELEGRAM_LAYER=198.
 */
import Module = require('module');
import { TELEGRAM_API_LAYER, TELEGRAM_API_SCHEMA } from './telegramApiSchema';

/** Layer of the schema that ships with GramJS 2.26.22. */
export const GRAMJS_BUNDLED_LAYER = 198;

export interface TelegramApiLayerState {
  /** The layer GramJS will use when connecting. */
  layer: number;
  /** GramJS's schema has been replaced. */
  installed: boolean;
  /** Reason it was not replaced (env / GramJS already loaded / error). */
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

/** Replace GramJS's schema with the new layer. Calling it several times is harmless (only the first call has an effect). */
export function installTelegramApiLayer(env: NodeJS.ProcessEnv = process.env): TelegramApiLayerState {
  if (state) return state;
  if (String(env.DEPLAO_TELEGRAM_LAYER || '') === String(GRAMJS_BUNDLED_LAYER)) {
    state = { layer: GRAMJS_BUNDLED_LAYER, installed: false, reason: 'DEPLAO_TELEGRAM_LAYER' };
    return state;
  }
  try {
    const apiPath = require.resolve('telegram/tl/api.js');
    if (require.cache[apiPath]) {
      // The Api.* classes were already built from the old schema: changing LAYER now would send the new layer with the old encoder
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

/** State of the most recent install (null = not called yet). */
export function telegramApiLayerState(): TelegramApiLayerState | null {
  return state;
}
