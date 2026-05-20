"use strict";
/**
 * FacebookConnectionManager.ts
 * Tương tự ConnectionManager.ts cho Zalo
 * Single Source of Truth cho tất cả Facebook connections
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const FacebookService_1 = require("../services/facebook/FacebookService");
const Logger_1 = __importDefault(require("./Logger"));
class FacebookConnectionManager {
    /**
     * Lấy hoặc tạo FacebookService instance
     * Nếu đã có instance với accountId này → trả về instance cũ
     */
    static getOrCreate(accountId, cookie) {
        if (this.connections.has(accountId)) {
            return this.connections.get(accountId);
        }
        const service = FacebookService_1.FacebookService.getInstance(accountId, cookie);
        this.connections.set(accountId, service);
        return service;
    }
    /**
     * Lấy existing instance (không tạo mới)
     */
    static get(accountId) {
        return this.connections.get(accountId) || null;
    }
    /**
     * Ngắt kết nối 1 account
     */
    static async disconnect(accountId) {
        const service = this.connections.get(accountId);
        if (service) {
            await service.disconnect();
            FacebookService_1.FacebookService.removeInstance(accountId);
            this.connections.delete(accountId);
            Logger_1.default.log(`[FacebookConnectionManager] Disconnected: ${accountId}`);
        }
    }
    /**
     * Ngắt tất cả connections
     */
    static async disconnectAll() {
        const ids = Array.from(this.connections.keys());
        await Promise.allSettled(ids.map(id => this.disconnect(id)));
        Logger_1.default.log(`[FacebookConnectionManager] All disconnected`);
    }
    /**
     * Lấy tất cả connected account IDs
     */
    static getConnectedIds() {
        return Array.from(this.connections.entries())
            .filter(([, svc]) => svc.isConnected())
            .map(([id]) => id);
    }
    /**
     * Health check tất cả connections
     */
    static async healthCheckAll() {
        const results = await Promise.allSettled(Array.from(this.connections.entries()).map(async ([id, svc]) => {
            const health = await svc.checkHealth();
            return { accountId: id, ...health };
        }));
        return results.map((r, i) => {
            const id = Array.from(this.connections.keys())[i];
            if (r.status === 'fulfilled')
                return r.value;
            return { accountId: id, alive: false, listenerConnected: false, reason: 'check_failed' };
        });
    }
}
FacebookConnectionManager.connections = new Map();
exports.default = FacebookConnectionManager;
//# sourceMappingURL=FacebookConnectionManager.js.map