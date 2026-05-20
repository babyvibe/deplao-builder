"use strict";
// ─────────────────────────────────────────────────────────────────────────────
// Build configuration — committed to repository (open-source safe).
// Works in both Electron (Node.js) and Vite renderer (browser) contexts.
// In renderer, Vite replaces process.env.* at build time via define in vite.config.ts.
// ─────────────────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.BUILD_TARGET = exports.SHOW_DEV_TOOLS = exports.IS_DEV_BUILD = void 0;
// Safe access: process exists in Node/Electron; Vite inlines the values for browser.
const _nodeEnv = (typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined) ?? 'production';
const _buildTarget = (typeof process !== 'undefined' ? (process.env?.BUILD_TARGET ?? process.env?.NODE_ENV) : undefined) ?? 'production';
/** true only in development builds — DevTools open */
exports.IS_DEV_BUILD = _nodeEnv !== 'production';
/** Allow DevTools to open — only in development */
exports.SHOW_DEV_TOOLS = _nodeEnv !== 'production';
/** Build target: 'development' | 'staging' | 'production' */
exports.BUILD_TARGET = _buildTarget;
//# sourceMappingURL=BuildConfig.js.map