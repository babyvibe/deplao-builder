// ─────────────────────────────────────────────────────────────────────────────
// Build configuration — committed to repository (open-source safe).
// Works in both Electron (Node.js) and Vite renderer (browser) contexts.
// In renderer, Vite replaces process.env.* at build time via define in vite.config.ts.
// ─────────────────────────────────────────────────────────────────────────────

// Safe access: process exists in Node/Electron; Vite inlines the values for browser.
const _nodeEnv: string =
  (typeof process !== 'undefined' ? process.env?.NODE_ENV : undefined) ?? 'production';

const _buildTarget: string =
  (typeof process !== 'undefined' ? (process.env?.BUILD_TARGET ?? process.env?.NODE_ENV) : undefined) ?? 'production';

/** true only in development builds — DevTools open */
export const IS_DEV_BUILD: boolean   = _nodeEnv !== 'production';

/** Allow DevTools to open — only in development */
export const SHOW_DEV_TOOLS: boolean = _nodeEnv !== 'production';

/** Build target: 'development' | 'staging' | 'production' */
export const BUILD_TARGET: string    = _buildTarget;
