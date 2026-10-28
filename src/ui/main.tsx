import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import Logger from '../utils/Logger';

// Giao diện bận liền ≥ 1 s (long task: render lớn, xử lý loạt sự kiện…) → Nhật ký "[Hiệu năng] …". Cùng với
// "Luồng chính bị chặn" của main process cho biết app đứng do giao diện hay do main.
try {
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 1000) {
          Logger.warn(`[Hiệu năng] Giao diện bận ${(entry.duration / 1000).toFixed(1)} s (${Math.round(entry.startTime / 1000)} s sau khi tải giao diện)`);
        }
      }
    }).observe({ type: 'longtask', buffered: true });
  }
} catch { /* trình duyệt không hỗ trợ long task — bỏ qua */ }

// Kéo file / ảnh thả ra ngoài vùng nhận (khung chat, ô soạn tin, thư viện…): Chromium mặc định mở luôn file đó trong cửa
// sổ app (mất giao diện, dev còn tải lại trang). Vùng nhận tự preventDefault trong dragover; chỗ khác → từ chối thả.
window.addEventListener('dragover', (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', (event) => {
  if (!event.defaultPrevented) event.preventDefault();
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

