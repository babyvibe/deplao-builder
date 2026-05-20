"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
class ZaloAccount {
    // Constructor để khởi tạo giá trị
    constructor(ZaloId, Imei = '', ZaloFullName = '', ZaloAvatarUrl = '', UserAgent = '', SecretKey = '', Cookies = '') {
        this.Imei = '';
        this.ZaloFullName = '';
        this.ZaloAvatarUrl = '';
        this.UserAgent = '';
        this.SecretKey = '';
        this.Cookies = '';
        this.ZaloId = ZaloId;
        this.Imei = Imei;
        this.ZaloFullName = ZaloFullName;
        this.ZaloAvatarUrl = ZaloAvatarUrl;
        this.UserAgent = UserAgent;
        this.SecretKey = SecretKey;
        this.Cookies = Cookies;
    }
}
exports.default = ZaloAccount;
//# sourceMappingURL=ZaloAccount.js.map