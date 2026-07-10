import Logger from '../../utils/Logger';

/**
 * AccountSendQueue - hàng đợi gửi tin tuần tự theo từng tài khoản (zaloId).
 *
 * Bài toán: khi nhiều khách nhắn cùng lúc vào cùng 1 tài khoản Zalo, workflow auto-reply
 * chạy song song và bắn hàng loạt api.sendMessage() gần như đồng thời → Zalo nghi spam → khóa.
 *
 * Giải pháp: mọi lời gọi gửi tin đi qua queue này. Các task CÙNG account nối đuôi nhau
 * (promise-chain), giữa 2 task chờ delay ngẫu nhiên min..max. Account khác nhau chạy song song.
 *
 * Chọn promise-chain thay vì token-bucket (như CRMQueueService) vì auto-reply là on-demand:
 * task đã nằm sẵn trong RAM, không cần dispatcher loop dò DB → ít code, không tốn CPU nền.
 */
class AccountSendQueue {
  private static instance: AccountSendQueue;
  /** Đuôi hàng đợi của mỗi account. Task mới nối vào sau promise này. */
  private tails: Map<string, Promise<unknown>> = new Map();

  public static getInstance(): AccountSendQueue {
    if (!AccountSendQueue.instance) AccountSendQueue.instance = new AccountSendQueue();
    return AccountSendQueue.instance;
  }

  /**
   * Xếp task vào hàng đợi của account. Trả về promise kết quả của task để caller await.
   * @param minMs/maxMs khoảng chờ NGẪU NHIÊN áp dụng SAU khi task xong, TRƯỚC khi nhả task kế.
   *                    <=0 cả hai → không chờ (backward compatible).
   */
  public enqueue<T>(accountId: string, task: () => Promise<T>, minMs = 0, maxMs = 0): Promise<T> {
    const key = accountId || '__default__';
    const prev = this.tails.get(key) ?? Promise.resolve();

    // Chờ lượt trước xong (nuốt lỗi lượt trước để 1 task fail không đứt cả hàng), rồi chạy task này.
    const result = prev.then(() => task(), () => task());

    // Đuôi mới: sau khi task này xong (dù thành/bại) thì chờ delay để giãn cách với task kế.
    const tail = result
      .catch(() => { /* lỗi task đã trả cho caller qua `result`; ở đây chỉ giữ chain sống */ })
      .then(() => this.wait(minMs, maxMs))
      .finally(() => {
        // Nếu không còn task nào nối thêm → dọn entry tránh Map phình vô hạn.
        if (this.tails.get(key) === tail) this.tails.delete(key);
      });

    this.tails.set(key, tail);
    return result;
  }

  private wait(minMs: number, maxMs: number): Promise<void> {
    const lo = Math.max(0, minMs);
    const hi = Math.max(lo, maxMs);
    if (hi <= 0) return Promise.resolve();
    const ms = lo + Math.random() * (hi - lo);
    Logger.log(`[AccountSendQueue] wait ${Math.round(ms)}ms before next send`);
    return new Promise(r => setTimeout(r, ms));
  }
}

export default AccountSendQueue;
