export default class ZaloAccount {
    // Các thuộc tính của class
    ZaloId: string;

    Imei: string = '';
    ZaloFullName: string = '';
    ZaloAvatarUrl: string = '';
    UserAgent: string = '';
    SecretKey: string = '';
    Cookies: string = '';

    // Constructor để khởi tạo giá trị
    constructor(
        ZaloId: string,
        Imei: string = '',
        ZaloFullName: string = '',
        ZaloAvatarUrl: string = '',
        UserAgent: string = '',
        SecretKey: string = '',
        Cookies: string = ''
    ) {
        this.ZaloId = ZaloId;
        this.Imei = Imei;
        this.ZaloFullName = ZaloFullName;
        this.ZaloAvatarUrl = ZaloAvatarUrl;
        this.UserAgent = UserAgent;
        this.SecretKey = SecretKey;
        this.Cookies = Cookies;
    }
}
  