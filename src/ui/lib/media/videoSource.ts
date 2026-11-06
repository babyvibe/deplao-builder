/**
 * Nguồn của một thẻ <video> gắn / gỡ trong effect (không qua prop `src`): gỡ khi bỏ để trả trình phát của Chromium cho
 * video khác (mỗi trang có giới hạn trình phát), gắn lại mỗi lần effect chạy.
 *
 * StrictMode (bản dev) chạy dọn rồi chạy lại effect trên CÙNG thẻ <video>. Khi `src` đi qua prop, lượt dọn gỡ `src` mà
 * React không gắn lại (prop không đổi) → video trống: sticker động Telegram chỉ còn giờ gửi, không có hình.
 */
export function attachVideoSource(video: HTMLVideoElement, src: string): () => void {
  if (src && video.getAttribute('src') !== src) video.setAttribute('src', src);
  return () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}
