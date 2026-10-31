/**
 * Ô soạn tin (MessageInput) gửi vào một chỗ KHÁC hội thoại đang mở — hiện dùng cho phần bình luận bài đăng kênh Telegram:
 * gửi vào NHÓM THẢO LUẬN, chuỗi bình luận = chủ đề (tin gốc trong nhóm), như gửi vào một chủ đề forum.
 *
 * Có context → MessageInput lấy tài khoản / hội thoại / chủ đề / liên hệ từ đây thay vì hội thoại đang mở, gửi đầy đủ
 * như khung chat (chữ, ảnh, video, tệp, ghi âm, sticker, GIF, @nhắc tên, tin nhắn nhanh, dán / kéo thả ảnh, trả lời
 * bình luận) và tắt phần thuộc về hội thoại (nhãn, gợi ý AI, nhắc hẹn, ghi chú, bình chọn, phím tắt chuyển hội thoại,
 * đang gõ). Chỉ một MessageInput được gắn tại một thời điểm (App bỏ ô của kênh khi đang mở phần bình luận) nên trích dẫn,
 * dán, kéo thả vẫn dùng chung trạng thái như cũ.
 */
import React from 'react';

export interface ComposerTarget {
  kind: 'telegramComments';
  accountId: string;
  /** Nhóm thảo luận */
  threadId: string;
  threadType: number;
  /** Tin gốc của chuỗi bình luận trong nhóm thảo luận */
  topicId: string;
  /** Liên hệ của nhóm (khi nhóm chưa có trong danh sách hội thoại — chưa tham gia) */
  contact: { contact_id: string; channel: string; contact_type?: string; display_name?: string; [key: string]: unknown };
  placeholder?: string;
}

export const ComposerTargetContext = React.createContext<ComposerTarget | null>(null);
