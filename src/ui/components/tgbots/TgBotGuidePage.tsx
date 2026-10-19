/**
 * TgBotGuidePage.tsx — Hướng dẫn sử dụng Telegram Bot Manager
 *
 * Trang hướng dẫn chi tiết, mở khi click vào tên "Telegram Bot Manager".
 */

import React from 'react';
import { CloseIcon, BotIcon, RocketIcon, SettingsIcon, ClockIcon, ChartIcon } from '@/components/common/icons';

interface Props {
  onClose: () => void;
}

export default function TgBotGuidePage({ onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-xl shadow-2xl w-full max-w-3xl mx-4 max-h-[85vh] flex flex-col border border-gray-700">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <div className="flex items-center gap-3">
            <BotIcon className="w-6 h-6 text-blue-400" />
            <h1 className="text-xl font-bold text-gray-100">Hướng dẫn sử dụng Telegram Bot Manager</h1>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-200">
            <CloseIcon className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-6 space-y-8">
          {/* Giới thiệu */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-3">📌 Giới thiệu</h2>
            <p className="text-gray-300 leading-relaxed">
              Telegram Bot Manager cho phép bạn tự động hóa Telegram bot mà không cần viết code.
              Bạn có thể tạo các quy tắc (rules) để bot tự động trả lời tin nhắn, gắn nhãn CRM,
              chuyển tiếp tin nhắn, hoặc gọi API bên ngoài.
            </p>
          </section>

          {/* Bắt đầu nhanh */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-3 flex items-center gap-2">
              <RocketIcon className="w-5 h-5 text-green-400" />
              Bắt đầu nhanh
            </h2>
            <div className="space-y-3 text-gray-300">
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-sm flex items-center justify-center font-bold">1</span>
                <p><strong className="text-gray-100">Thêm Bot:</strong> Vào Cài đặt → Thêm tài khoản Telegram Bot (nhập Bot Token từ @BotFather)</p>
              </div>
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-sm flex items-center justify-center font-bold">2</span>
                <p><strong className="text-gray-100">Tạo dự án:</strong> Click "Dự án mới" → Chọn bot → Đặt tên dự án</p>
              </div>
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-sm flex items-center justify-center font-bold">3</span>
                <p><strong className="text-gray-100">Tạo quy tắc:</strong> Click vào dự án → "Thêm quy tắc" → Cấu hình kích hoạt và hành động</p>
              </div>
              <div className="flex items-start gap-3">
                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-600 text-white text-sm flex items-center justify-center font-bold">4</span>
                <p><strong className="text-gray-100">Kích hoạt:</strong> Bật công tắc trên dự án để bot bắt đầu tự động hóa</p>
              </div>
            </div>
          </section>

          {/* Loại quy tắc */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-3">⚡ Loại kích hoạt (Trigger)</h2>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="font-medium text-gray-100 mb-2">💬 Tin nhắn</h3>
                <p className="text-sm text-gray-400">Kích hoạt khi bot nhận tin nhắn. Hỗ trợ:</p>
                <ul className="text-sm text-gray-400 mt-2 space-y-1">
                  <li>• Theo từ khóa (contains, exact, regex, fuzzy)</li>
                  <li>• Theo lệnh /command</li>
                  <li>• Theo loại media (ảnh, video, file)</li>
                  <li>• Theo độ dài tin nhắn</li>
                </ul>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="font-medium text-gray-100 mb-2">🚪 Thành viên mới</h3>
                <p className="text-sm text-gray-400">Kích hoạt khi có thành viên mới vào nhóm. Dùng để:</p>
                <ul className="text-sm text-gray-400 mt-2 space-y-1">
                  <li>• Chào mừng thành viên mới</li>
                  <li>• Gửi hướng dẫn nhóm</li>
                  <li>• Gắn nhãn CRM tự động</li>
                </ul>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="font-medium text-gray-100 mb-2">⏰ Lịch trình</h3>
                <p className="text-sm text-gray-400">Tự động đăng bài theo lịch. Hỗ trợ:</p>
                <ul className="text-sm text-gray-400 mt-2 space-y-1">
                  <li>• Cron expression (mỗi giờ, mỗi ngày, ...)</li>
                  <li>• Biến động: {'{date}'}, {'{time}'}, {'{day}'}</li>
                  <li>• Đăng nhiều kênh cùng lúc</li>
                </ul>
              </div>
            </div>
          </section>

          {/* Loại hành động */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-3">🎯 Loại hành động (Action)</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="font-medium text-gray-100 mb-2">💬 Trả lời</h3>
                <p className="text-sm text-gray-400">Gửi tin nhắn trả lời tự động. Biến: {'{user_name}'}, {'{user_id}'}, {'{text}'}, {'{chat_id}'}</p>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="font-medium text-gray-100 mb-2">🤖 Trả lời AI</h3>
                <p className="text-sm text-gray-400">Sử dụng AI assistant để trả lời. Liên kết với AI assistant có sẵn trong hệ thống.</p>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="font-medium text-gray-100 mb-2">🏷️ Gắn nhãn CRM</h3>
                <p className="text-sm text-gray-400">Tự động tạo contact và gắn nhãn CRM. Thông báo cho admin group.</p>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="font-medium text-gray-100 mb-2">↗️ Chuyển tiếp</h3>
                <p className="text-sm text-gray-400">Chuyển tiếp tin nhắn sang channel/group khác.</p>
              </div>
              <div className="bg-gray-700/50 rounded-lg p-4">
                <h3 className="font-medium text-gray-100 mb-2">🔗 Webhook</h3>
                <p className="text-sm text-gray-400">Gọi API bên ngoài. Nhận response và trả lời tự động.</p>
              </div>
            </div>
          </section>

          {/* Phương thức khớp */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-3">🔍 Phương thức khớp từ khóa</h2>
            <div className="bg-gray-700/50 rounded-lg p-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-600">
                    <th className="text-left py-2">Phương thức</th>
                    <th className="text-left py-2">Mô tả</th>
                    <th className="text-left py-2">Ví dụ</th>
                  </tr>
                </thead>
                <tbody className="text-gray-300">
                  <tr className="border-b border-gray-600/50">
                    <td className="py-2 font-medium">contains</td>
                    <td className="py-2">Tin nhắn chứa từ khóa</td>
                    <td className="py-2">"giá" khớp với "Cho mình xin giá"</td>
                  </tr>
                  <tr className="border-b border-gray-600/50">
                    <td className="py-2 font-medium">exact</td>
                    <td className="py-2">Tin nhắn trùng khớp chính xác</td>
                    <td className="py-2">"giá" chỉ khớp với "giá"</td>
                  </tr>
                  <tr className="border-b border-gray-600/50">
                    <td className="py-2 font-medium">regex</td>
                    <td className="py-2">Biểu thức chính tắc</td>
                    <td className="py-2">{'"\\d{3,}"'} khớp số có 3 chữ số</td>
                  </tr>
                  <tr className="border-b border-gray-600/50">
                    <td className="py-2 font-medium">fuzzy</td>
                    <td className="py-2">Khớp mờ (chống lỗi chính tả)</td>
                    <td className="py-2">"gia" khớp với "giá"</td>
                  </tr>
                  <tr>
                    <td className="py-2 font-medium">all_words</td>
                    <td className="py-2">Chứa TẤT CẢ từ khóa</td>
                    <td className="py-2">"giá tốt" cần cả 2 từ</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>

          {/* Cài đặt */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-3 flex items-center gap-2">
              <SettingsIcon className="w-5 h-5 text-yellow-400" />
              Cài đặt
            </h2>
            <div className="space-y-3 text-gray-300">
              <div>
                <h3 className="font-medium text-gray-100">Giới hạn tốc độ</h3>
                <ul className="text-sm text-gray-400 mt-1 space-y-1">
                  <li>• <strong>Tối đa/giờ:</strong> Số lần trả lời tối đa mỗi giờ (mặc định: 10)</li>
                  <li>• <strong>Tối đa/nhóm:</strong> Số lần trả lời tối đa trong mỗi nhóm (mặc định: 5)</li>
                  <li>• <strong>Đợi:</strong> Thời gian giữa các lần trả lời cùng user (mặc định: 5 giây)</li>
                </ul>
              </div>
              <div>
                <h3 className="font-medium text-gray-100">Giờ/ngày hoạt động</h3>
                <p className="text-sm text-gray-400">Chọn giờ và ngày bot được phép trả lời. Để trống nếu cho phép tất cả.</p>
              </div>
              <div>
                <h3 className="font-medium text-gray-100">Tổng quát</h3>
                <ul className="text-sm text-gray-400 mt-1 space-y-1">
                  <li>• <strong>Trả lời trong nhóm:</strong> Bot trả lời trong nhóm thay vì tin nhắn riêng</li>
                  <li>• <strong>Bỏ qua bot:</strong> Không phản hồi tin nhắn từ bot khác</li>
                  <li>• <strong>Bỏ qua chính mình:</strong> Không phản hồi tin nhắn của chính bot</li>
                </ul>
              </div>
            </div>
          </section>

          {/* Lịch đăng bài */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-3 flex items-center gap-2">
              <ClockIcon className="w-5 h-5 text-purple-400" />
              Lịch đăng bài
            </h2>
            <div className="space-y-3 text-gray-300">
              <p className="text-sm">Tự động đăng bài theo lịch với cron expression. Các preset có sẵn:</p>
              <div className="bg-gray-700/50 rounded-lg p-4 text-sm">
                <div className="grid grid-cols-2 gap-2">
                  <div>• Mỗi giờ: <code className="text-blue-400">0 * * * *</code></div>
                  <div>• Mỗi ngày 9:00: <code className="text-blue-400">0 9 * * *</code></div>
                  <div>• Mỗi ngày 18:00: <code className="text-blue-400">0 18 * * *</code></div>
                  <div>• Thứ 2 lúc 9:00: <code className="text-blue-400">0 9 * * 1</code></div>
                  <div>• Thứ 6 lúc 17:00: <code className="text-blue-400">0 17 * * 5</code></div>
                  <div>• Mỗi 6 giờ: <code className="text-blue-400">0 */6 * * *</code></div>
                </div>
              </div>
              <p className="text-sm text-gray-400">Biến động trong nội dung: {'{date}'}, {'{time}'}, {'{day}'}</p>
            </div>
          </section>

          {/* Báo cáo */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-3 flex items-center gap-2">
              <ChartIcon className="w-5 h-5 text-green-400" />
              Báo cáo
            </h2>
            <p className="text-gray-300 text-sm">
              Xem thống kê chi tiết: tổng hành động, tỷ lệ thành công, lỗi, và lịch sử hoạt động gần đây.
              Dữ liệu được cập nhật real-time.
            </p>
          </section>

          {/* Mẹo */}
          <section>
            <h2 className="text-lg font-semibold text-gray-100 mb-3">💡 Mẹo sử dụng</h2>
            <div className="bg-gray-700/50 rounded-lg p-4 space-y-2 text-sm text-gray-300">
              <p>• <strong>Ưu tiên quy tắc:</strong> Quy tắc có ưu tiên cao hơn được kiểm tra trước. Dùng ưu tiên cao cho các rule quan trọng.</p>
              <p>• <strong>Test trước khi bật:</strong> Tạo quy tắc ở trạng thái "Nháp" trước, test thủ công, rồi mới bật.</p>
              <p>• <strong>Giới hạn tốc độ:</strong> Không đặt quá cao để tránh bị Telegram giới hạn (FLOOD_WAIT).</p>
              <p>• <strong>Fuzzy matching:</strong> Dùng "fuzzy" cho FAQ để chống lỗi chính tả của user.</p>
              <p>• <strong>CRM integration:</strong> Kết hợp quy tắc "Gắn nhãn CRM" với hệ thống CRM để quản lý lead tự động.</p>
            </div>
          </section>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-6 py-4 border-t border-gray-700">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg transition-colors"
          >
            Đã hiểu
          </button>
        </div>
      </div>
    </div>
  );
}
