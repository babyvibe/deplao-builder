/**
 * FacebookConnectionManager.ts
 * Tương tự ConnectionManager.ts cho Zalo
 * Single Source of Truth cho tất cả Facebook connections
 */

import { FacebookService } from '../services/facebook/FacebookService';
import Logger from './Logger';

class FacebookConnectionManager {
  private static connections = new Map<string, FacebookService>();

  /**
   * Lấy hoặc tạo FacebookService instance
   * Nếu đã có instance với accountId này → trả về instance cũ
   */
  public static getOrCreate(accountId: string, cookie: string): FacebookService {
    if (this.connections.has(accountId)) {
      return this.connections.get(accountId)!;
    }
    const service = FacebookService.getInstance(accountId, cookie);
    this.connections.set(accountId, service);
    return service;
  }

  /**
   * Lấy existing instance (không tạo mới)
   */
  public static get(accountId: string): FacebookService | null {
    return this.connections.get(accountId) || null;
  }

  /**
   * Ngắt kết nối 1 account
   */
  public static async disconnect(accountId: string): Promise<void> {
    const service = this.connections.get(accountId);
    if (service) {
      await service.disconnect();
      FacebookService.removeInstance(accountId);
      this.connections.delete(accountId);
      Logger.log(`[FacebookConnectionManager] Disconnected: ${accountId}`);
    }
  }

  /**
   * Ngắt tất cả connections
   */
  public static async disconnectAll(): Promise<void> {
    const ids = Array.from(this.connections.keys());
    await Promise.allSettled(ids.map(id => this.disconnect(id)));
    Logger.log(`[FacebookConnectionManager] All disconnected`);
  }

  /**
   * Lấy tất cả connected account IDs
   */
  public static getConnectedIds(): string[] {
    return Array.from(this.connections.entries())
      .filter(([, svc]) => svc.isConnected())
      .map(([id]) => id);
  }

  /**
   * Health check tất cả connections
   */
  public static async healthCheckAll(): Promise<Array<{
    accountId: string;
    alive: boolean;
    listenerConnected: boolean;
    reason?: string;
  }>> {
    const results = await Promise.allSettled(
      Array.from(this.connections.entries()).map(async ([id, svc]) => {
        const health = await svc.checkHealth();
        return { accountId: id, ...health };
      })
    );

    return results.map((r, i) => {
      const id = Array.from(this.connections.keys())[i];
      if (r.status === 'fulfilled') return r.value;
      return { accountId: id, alive: false, listenerConnected: false, reason: 'check_failed' };
    });
  }
}

export default FacebookConnectionManager;

