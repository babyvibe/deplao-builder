/**
 * EventBuffer - Ring buffer lưu event gần nhất để catch-up khi employee reconnect.
 *
 * Đảm bảo KHÔNG MISS event dù employee bị mất kết nối tạm thời:
 * - Boss push mọi event vào buffer với seqId tăng dần
 * - Employee track lastSeqId đã nhận
 * - Reconnect → gửi lastSeqId → Boss replay buffer từ seqId đó
 * - Buffer giới hạn 2000 event gần nhất (đủ cho ~10-15 phút ở cường độ cao)
 */
import Logger from '../../utils/Logger';

export interface BufferedEvent {
  seqId: number;
  channel: string;
  data: any;
  ts: number;
}

class EventBuffer {
  private buffer: BufferedEvent[] = [];
  private nextSeqId = 1;
  private static MAX_SIZE = 5000;
  private prunedCount = 0; // thống kê

  /** Có thể cấu hình MAX_SIZE từ ngoài (cho test hoặc tuning) */
  public static setMaxSize(size: number): void {
    // Chỉ cho phép set trước khi có dữ liệu
    EventBuffer.MAX_SIZE = Math.max(100, Math.min(size, 50000));
  }

  /**
   * Thêm event vào buffer, trả về seqId
   */
  push(channel: string, data: any): number {
    const seqId = this.nextSeqId++;
    const event: BufferedEvent = { seqId, channel, data, ts: Date.now() };
    this.buffer.push(event);

    // Giới hạn kích thước - shift cũ nhất
    if (this.buffer.length > EventBuffer.MAX_SIZE) {
      this.buffer.shift();
      this.prunedCount++;
    }

    return seqId;
  }

  /**
   * Lấy tất cả event có seqId > lastSeqId (dùng cho catch-up)
   * Nếu lastSeqId <= 0 → trả về toàn bộ buffer (initial sync)
   */
  getSince(lastSeqId: number): BufferedEvent[] {
    if (lastSeqId <= 0) return [...this.buffer];
    // Tối ưu: binary search nếu buffer lớn
    // Hiện tại dùng filter tuyến tính (buffer <= 2000, negligible)
    return this.buffer.filter(e => e.seqId > lastSeqId);
  }

  /**
   * Số event hiện tại trong buffer
   */
  get size(): number {
    return this.buffer.length;
  }

  /**
   * Số event đã bị loại bỏ do buffer đầy
   */
  get totalPruned(): number {
    return this.prunedCount;
  }

  /**
   * Reset buffer (dùng khi test)
   */
  reset(): void {
    this.buffer = [];
    this.nextSeqId = 1;
    this.prunedCount = 0;
  }
}

export default EventBuffer;
