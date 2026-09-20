/**
 * FacebookE2EEStateStore.ts
 * Secure persistence for E2EE device state via Electron safeStorage.
 *
 * Phase 3: Replaces e2eeMemoryOnly=true with encrypted secure storage,
 * so E2EE session/identity survives app restarts without bootstrap loop.
 */

import { secureDelete, secureGet, secureSetRequired } from '../secure/SecureSettingsService';
import Logger from '../../utils/Logger';
import { metricInc } from './FacebookMetrics';

/** Key namespace for E2EE device state in secure storage */
function e2eeStateKey(accountId: string): string {
  return `facebook:e2ee-device-state:${accountId}`;
}

/** Max state size — 5 MiB (generous for device state with identities/sessions/prekeys) */
const MAX_STATE_SIZE = 5 * 1024 * 1024;

export class FacebookE2EEStateStore {
  private accountId: string;
  /** Debounce timer for writes — coalesce rapid updates */
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Latest pending state to write */
  private pendingState: string | null = null;
  /** Serial counter — only the latest snapshot wins */
  private writeSerial = 0;

  constructor(accountId: string) {
    this.accountId = accountId;
  }

  /**
   * Load serialized E2EE device state from secure storage.
   * Returns undefined if no state exists or state is invalid.
   */
  async load(): Promise<string | undefined> {
    try {
      const key = e2eeStateKey(this.accountId);
      const raw = secureGet(key);
      if (!raw) return undefined;

      // Validate size
      if (raw.length > MAX_STATE_SIZE) {
        Logger.warn(`[E2EEStateStore:${this.accountId}] State too large (${raw.length} > ${MAX_STATE_SIZE}) - discarding`);
        await this.clear();
        return undefined;
      }

      // Validate it's valid JSON (basic check)
      try {
        JSON.parse(raw);
      } catch {
        Logger.warn(`[E2EEStateStore:${this.accountId}] State is not valid JSON - discarding`);
        await this.clear();
        return undefined;
      }

      Logger.log(`[E2EEStateStore:${this.accountId}] Loaded state (${raw.length} bytes)`);
      return raw;
    } catch (err: any) {
      Logger.warn(`[E2EEStateStore:${this.accountId}] Load failed: ${err.message}`);
      return undefined;
    }
  }

  /**
   * Save serialized E2EE device state to secure storage.
   * Debounced — coalesces rapid updates (300ms window), only latest wins.
   */
  save(serializedState: string): void {
    if (!serializedState || serializedState.length > MAX_STATE_SIZE) {
      Logger.warn(`[E2EEStateStore:${this.accountId}] Save rejected: invalid size`);
      return;
    }

    this.pendingState = serializedState;
    const serial = ++this.writeSerial;

    // Debounce: clear previous timer, schedule new write
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
    }

    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      // Only write if this is still the latest snapshot
      if (serial !== this.writeSerial) return;
      this.flushWrite();
    }, 400);
  }

  /**
   * Force flush pending state immediately (called on disconnect/logout).
   */
  async flushPending(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (this.pendingState !== null) {
      await this.flushWrite();
    }
  }

  /**
   * Clear E2EE device state from secure storage.
   * Called on logout/account removal.
   */
  async clear(): Promise<void> {
    try {
      if (this.writeTimer) {
        clearTimeout(this.writeTimer);
        this.writeTimer = null;
      }
      this.pendingState = null;
      secureDelete(e2eeStateKey(this.accountId));
      Logger.log(`[E2EEStateStore:${this.accountId}] Cleared state`);
    } catch (err: any) {
      Logger.warn(`[E2EEStateStore:${this.accountId}] Clear failed: ${err.message}`);
    }
  }

  static async clearForAccount(accountId: string): Promise<void> {
    secureDelete(e2eeStateKey(accountId));
  }

  private flushWrite(): void {
    if (this.pendingState === null) return;
    const state = this.pendingState;
    this.pendingState = null;

    try {
      const key = e2eeStateKey(this.accountId);
      // Phase 3: Use secureSetRequired — fail loudly if encryption unavailable
      secureSetRequired(key, state);
      Logger.log(`[E2EEStateStore:${this.accountId}] Saved state (${state.length} bytes)`);
    } catch (err: any) {
      metricInc('fb_e2ee_state_save_failure', this.accountId);
      Logger.warn(`[E2EEStateStore:${this.accountId}] Write failed: ${err.message}`);
      // Non-fatal: bridge still runs this session, state just won't persist
    }
  }
}

export default FacebookE2EEStateStore;
