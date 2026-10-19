/**
 * uploadCoordinator — điều phối đường truyền tải lên R2 giữa các module Cloudflare.
 *
 * Bản gốc DB là một file lớn (vài trăm MB) cần lên trọn vẹn; nếu lưu media cùng lúc tải nhiều file thì cả hai tranh băng
 * thông, phần của bản gốc dễ hết thời gian chờ và phải gửi lại. Trong lúc đang tải bản gốc DB, lưu media chỉ chạy 1 file.
 */
let dbBaseUploads = 0;

/** Gọi khi bắt đầu tải bản gốc DB; trả hàm kết thúc (gọi nhiều lần cũng chỉ tính một). */
export function beginDbBaseUpload(): () => void {
    dbBaseUploads++;
    let ended = false;
    return () => {
        if (ended) return;
        ended = true;
        dbBaseUploads = Math.max(0, dbBaseUploads - 1);
    };
}

/** Đang có bản gốc DB tải lên R2. */
export function dbBaseUploadActive(): boolean {
    return dbBaseUploads > 0;
}
