import ZaloLoginHelper from "../../utils/zalo/ZaloLoginHelper";

export default class LoginService {
    private loginHelper: ZaloLoginHelper;

    constructor() {
        this.loginHelper = new ZaloLoginHelper();
    }

    public async loginQR(tempId: string, proxyId?: number | null) {
        return await this.loginHelper.loginQR(tempId, proxyId);
    }

    public async connectUser(auth: any): Promise<boolean> {
        const timeoutPromise = new Promise<boolean>((_, reject) => {
            setTimeout(() => reject(new Error('Connection timeout after 30s')), 30000);
        });

        try {
            return await Promise.race([
                this.loginHelper.connectZaloUser(auth),
                timeoutPromise
            ]);
        } catch (error: any) {
            console.error(`[LoginService] connectUser Failed:`, error.message);
            throw error;
        }
    }

    public async loginCookies(imei: any, cookies: any, userAgent: any, proxyId?: number | null) {
        return await this.loginHelper.loginCookies(imei, cookies, userAgent, proxyId);
    }

    public async disconnectUser(zaloId: string): Promise<void> {
        return await this.loginHelper.disconnectUser(zaloId);
    }
}
