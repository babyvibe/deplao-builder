"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const ZaloLoginHelper_1 = __importDefault(require("../utils/ZaloLoginHelper"));
class LoginService {
    constructor() {
        this.loginHelper = new ZaloLoginHelper_1.default();
    }
    async loginQR(tempId) {
        return await this.loginHelper.loginQR(tempId);
    }
    async connectUser(auth) {
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Connection timeout after 30s')), 30000);
        });
        try {
            return await Promise.race([
                this.loginHelper.connectZaloUser(auth),
                timeoutPromise
            ]);
        }
        catch (error) {
            console.error(`[LoginService] connectUser Failed:`, error.message);
            throw error;
        }
    }
    async loginCookies(imei, cookies, userAgent) {
        return await this.loginHelper.loginCookies(imei, cookies, userAgent);
    }
    async requestOldMessages(auth) {
        return await this.loginHelper.requestOldMessages(auth);
    }
    async disconnectUser(zaloId) {
        return await this.loginHelper.disconnectUser(zaloId);
    }
}
exports.default = LoginService;
//# sourceMappingURL=LoginService.js.map