import React, { useState } from 'react';

interface VersionEntry {
  version: string;
  date: string;
  type: 'major' | 'minor' | 'patch' | 'hotfix';
  highlights?: string[];
  changes: {
    category: 'new' | 'improved' | 'fixed' | 'removed' | 'security';
    items: string[];
  }[];
}

// ─── Changelog data — thêm entry mới vào ĐẦU mảng khi có bản cập nhật ────────
const CHANGELOG: VersionEntry[] = [
  {
    version: '26.4.5',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '🔒 khoá màn hình — bảo vệ ứng dụng bằng mật khẩu, sinh trắc học và recovery key',
      '☑️ Chọn nhiều tin nhắn — chọn và chuyển tiếp/sao chép nhiều tin cùng lúc',
      '🖼️ Tự động sửa ảnh lỗi — ảnh hỏng được tải lại ngầm, không cần thao tác',
      '📞 CRM nhập SĐT nhanh hơn — không cần chờ tra cứu, tự động xử lý khi gửi',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Khoá màn hình: đặt mật khẩu bảo vệ ứng dụng, phím tắt Ctrl+Shift+L để khoá nhanh, nút khoá trên thanh tiêu đề',
          'Chọn nhiều tin nhắn: nhấn chuột phải → "Chọn tin nhắn" để chọn nhiều tin, sau đó sao chép hoặc chuyển tiếp hàng loạt',
          'Chuyển tiếp nhiều tin cùng lúc: chọn nhiều tin nhắn và nhiều người nhận, gửi lần lượt tự động',
          'Tự động phát hiện và sửa ảnh bị lỗi (ảnh trắng, 0 byte, nội dung HTML) khi mở cuộc trò chuyện',
          'Hiển thị thông báo khi ẩn ứng dụng xuống tray — cho biết app vẫn chạy ngầm và nhận tin nhắn',
        ],
      },
      {
        category: 'improved',
        items: [
          'Chiến dịch CRM: nhập số điện thoại nhanh hơn — không cần chờ tra cứu Zalo, tự động tìm người dùng khi gửi chiến dịch',
          'Chiến dịch CRM: gửi nhiều nội dung báo lỗi chính xác hơn — biết block nào gửi thành công, block nào thất bại',
          'Cài đặt bảo mật: Cài mật khẩu, Recovery Key, Tắt khoá',
          'Khi lưu ảnh về máy mà file bị lỗi, tự động tải lại từ url gốc để đảm bảo file lưu ra không bị hỏng',
          'Nhấp vào thông báo desktop mở đúng cuộc trò chuyện ổn định hơn',
          'Ngữ cảnh AI: tăng giới hạn lên 1000 tin nhắn thay vì 100',
          'Workflow: hỗ trợ biến thời gian (HH:MM) trong điều kiện so sánh lớn hơn / nhỏ hơn',
          'Workflow: import/template tự động cập nhật liên kết giữa các node',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi ảnh hiển thị trắng hoặc xoay mãi khi zoom do file ảnh bị hỏng',
          'Sửa lỗi lưu ảnh về máy (Save As) không khắc phục được file đã lỗi',
          'Sửa lỗi nhấp thông báo tin nhắn đôi khi không mở được cuộc trò chuyện',
          'Sửa lỗi biến workflow không đúng khi dùng node AI trợ lý',
          'Sửa lỗi Cloudflare Tunnel và ffmpeg không hoạt động trên bản cài đặt (asar)',
        ],
      },
    ],
  },
  {
    version: '26.4.4',
    date: '06/2026',
    type: 'minor',
    highlights: [
      '💬 Nâng cấp chuyển tiếp tin nhắn — hỗ trợ mọi loại, thêm soạn text kèm',
      '📊 Chiến dịch CRM thông minh hơn — auto load thông tin từ tệp số điện thoại',
      '🤖 Bổ sung Gemini 3.5 & DeepSeek V4, AI template trực quan hơn',
    ],
    changes: [
      {
        category: 'improved',
        items: [
          'Chuyển tiếp tin nhắn: hỗ trợ toàn bộ loại tin nhắn (text, ảnh, file, video) thay vì chỉ text như trước, thêm ô soạn text kèm khi chuyển tiếp',
          'Chiến dịch CRM: tự động tra cứu và load thông tin khách hàng khi chọn tệp số điện thoại',
          'Log lịch sử gửi tin CRM: bổ sung cột số điện thoại bên cạnh tên khách hàng',
          'Thẻ AI trả lời: thiết kế lại giao diện cài đặt trực quan, dễ thao tác hơn',
          'Cập nhật danh sách model AI: thêm Gemini 3.5 Flash và DeepSeek V4',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi chuyển tiếp tin nhắn không hoạt động với file, ảnh, video',
          'Sửa lỗi không duyệt được thành viên nhóm Zalo',
          'Sửa lỗi copy ảnh vào clipboard không hoạt động với ảnh remote',
        ],
      },
    ],
  },
  {
    version: '26.4.3',
    date: '05/2026',
    type: 'minor',
    highlights: [
      '🌐 Kết nối nhân viên qua WAN — boss và nhân viên giờ có thể làm việc từ bất kỳ đâu, không chỉ cùng mạng LAN',
      '🔒 Nâng cấp quản lý Proxy — chọn proxy riêng cho từng tài khoản trước khi đăng nhập',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Hỗ trợ kết nối nhân viên qua WAN: Boss bật Cloudflare Tunnel — app tự tạo URL công khai an toàn, nhân viên nhập URL đó để kết nối từ xa mà không cần cùng mạng nội bộ',
          'Thêm nút "Bật Tunnel WAN" trong Cài đặt → Nhân viên → Relay Server — một click để tạo địa chỉ truy cập từ xa',
          'Thêm màn hình cài đặt Proxy trước khi đăng nhập tài khoản Zalo — hỗ trợ HTTP, HTTPS và SOCKS5',
          'Mỗi tài khoản Zalo có thể gán proxy độc lập — không ảnh hưởng đến các tài khoản khác trong cùng app, một proxy có thể gắn nhiều tài khoản.',
        ],
      },
    ],
  },
  {
    version: '26.4.2',
    date: '05/2026',
    type: 'patch',
    highlights: [
      '👥 Nâng cấp CRM: rời nhiều nhóm cùng lúc và tham gia nhóm từ link mời',
      '🐛 Sửa lỗi quét thành viên nhóm và thống kê tin nhắn theo giờ',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Thêm hành động rời nhiều nhóm hàng loạt trong tab Liên hệ CRM',
          'Thêm nút tham gia nhóm trực tiếp từ kết quả quét link nhóm',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi phân trang khi quét thành viên từ link nhóm — giờ quét đủ toàn bộ thành viên thay vì chỉ dừng ở 100',
          'Sửa lỗi biểu đồ Tin nhắn theo giờ trong Báo cáo không hiển thị số liệu',
        ],
      },
    ],
  },
  {
    version: '26.4.1',
    date: '05/2026',
    type: 'patch',
    highlights: [
      '🚀 Chiến dịch gửi tin hàng loạt nâng cấp: hỗ trợ soạn ảnh, gửi nhiều tin trong một lần và random nội dung',
      '🐛 Sửa một số lỗi liên quan đến chat và xem ảnh',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Chiến dịch gửi tin hàng loạt hỗ trợ soạn thêm tin nhắn kèm ảnh',
          'Gửi nhiều tin nhắn trong một lượt chiến dịch',
          'Tính năng random nội dung giúp tin nhắn tự nhiên hơn, giảm trùng lặp',
        ],
      },
      {
        category: 'fixed',
        items: [
          'Sửa lỗi thanh gợi ý sticker khi chat — cuộn chuột trên thanh sticker giờ trượt ngang tự nhiên',
          'Sửa lỗi hiển thị ảnh trong tin nhắn — giảm hiện tượng giật/nháy khi tải ảnh',
          'Sửa lỗi trình xem ảnh — không còn nháy khi mở, kéo ảnh để zoom không còn tự đóng hộp thoại',
        ],
      },
    ],
  },
  {
    version: '26.4.0',
    date: '04/2026',
    type: 'major',
    highlights: [
      '🚀 Ra mắt Deplao — nền tảng desktop vận hành bán hàng và chăm sóc khách hàng trên Zalo trong một ứng dụng duy nhất',
      '👤 Quản lý đa tài khoản Zalo, gộp nhiều tài khoản vào một hộp thư tập trung để xử lý hội thoại nhanh hơn',
      '👥 Tích hợp CRM, Campaign, Workflow, AI, Báo cáo và Tích hợp ngoài để vận hành khép kín ngay trên desktop',
      '🗂️ Bổ sung ERP nội bộ, quản lý nhân viên & workspace để boss và team phối hợp ngay trong cùng hệ thống',
      '🔒 Kiến trúc lưu dữ liệu cục bộ, đăng nhập bằng QR, ưu tiên bảo mật và quyền kiểm soát dữ liệu cho người dùng',
    ],
    changes: [
      {
        category: 'new',
        items: [
          'Ra mắt Dashboard quản lý tài khoản: theo dõi trạng thái online/offline, listener, reconnect nhanh, tìm kiếm và sắp xếp tài khoản ngay trên màn hình chính',
          'Hỗ trợ đăng nhập và quản lý nhiều tài khoản Zalo bằng QR Code trong cùng một app, lưu phiên cục bộ an toàn và chuyển đổi tài khoản tức thì',
          'Thêm chế độ Gộp tài khoản để xem và xử lý hội thoại từ nhiều Zalo trong một inbox hợp nhất, kèm bộ lọc, tìm kiếm và nhận diện tài khoản sở hữu từng hội thoại',
          'Ra mắt hộp thư tập trung với bộ lọc Tất cả / Chưa đọc / Chưa trả lời / Khác / Theo nhãn, hỗ trợ tìm kiếm theo tên, biệt danh và số điện thoại',
          'Trang chat hỗ trợ đầy đủ thao tác quan trọng: định dạng văn bản, emoji, sticker, gửi ảnh/video/file, reply, tag thành viên, tạo poll, ghi chú nhóm, nhắc nhở và gửi danh thiếp',
          'Thêm Quick Messages không giới hạn để lưu mẫu tin nhắn, gọi nhanh bằng từ khóa và dùng được cho các tình huống tư vấn lặp lại hàng ngày',
          'Hỗ trợ ghim không giới hạn tin nhắn trong hội thoại, Group Board tổng hợp ghim / ghi chú / bình chọn và panel quản lý media, video, file đính kèm',
          'Ra mắt CRM đồng bộ bạn bè Zalo, thành viên nhóm, hồ sơ liên hệ, số điện thoại, giới tính, ngày sinh, nhãn và ghi chú nội bộ trong cùng một nơi',
          'Cho phép quản lý nhãn Zalo hai chiều: tạo, đổi tên, xóa, gán/gỡ nhãn, lọc theo nhiều nhãn và dùng nhãn làm điều kiện cho workflow',
          'Bổ sung quét thành viên nhóm nâng cao, quét nhóm lớn / nhóm ẩn / nhóm chưa tham gia từ link mời để phục vụ CRM và chiến dịch',
          'Ra mắt Campaign gửi tin hàng loạt với nhiều loại hành động như gửi tin, kết bạn, mời vào nhóm, chạy hỗn hợp; có delay, tiến độ realtime, tạm dừng/tiếp tục và log chi tiết',
          'Ra mắt Workflow Engine kéo-thả không cần code với mô hình Trigger → Node → Action, hỗ trợ chạy nền 24/7 và xem lịch sử chạy để debug',
          'Workflow hỗ trợ nhiều trigger và action quan trọng: tin nhắn mới, lời mời kết bạn, sự kiện nhóm, react, cron, gửi tin, gửi ảnh/file, tìm user, lấy profile, quản lý nhóm, mute, forward, recall, poll và đọc lịch sử chat',
          'Tích hợp node Logic, Google Sheets, AI, Telegram, Discord, Email, Notion và HTTP Request để tự động hóa quy trình bán hàng, chăm sóc khách hàng và vận hành nội bộ',
          'Ra mắt hub Tích hợp với POS, vận chuyển và AI: hỗ trợ KiotViet, Haravan, Sapo, Nhanh.vn, Pancake POS, GHN, GHTK và các trợ lý AI dùng ngay trong chat hoặc workflow',
          'Bổ sung Báo cáo & Phân tích với nhiều tab: Tổng quan, Tin nhắn, Liên hệ, Nhãn, Chiến dịch, Workflow, AI và Nhân viên để theo dõi hiệu suất vận hành theo thời gian thực',
          'Ra mắt ERP nội bộ gồm Task, Calendar, Notes và phân quyền ERP để quản lý giao việc, lịch, tài liệu nội bộ và phối hợp vận hành ngay trong Deplao',
          'Ra mắt mô hình Workspace boss ↔ nhân viên với Relay Server, phân quyền module chi tiết, cấp tài khoản nhân viên và theo dõi báo cáo hiệu suất từng người',
        ],
      },
      {
        category: 'improved',
        items: [
          'Tập trung toàn bộ chat, CRM, workflow, AI, báo cáo và ERP trong một desktop app duy nhất để giảm việc chuyển đổi qua nhiều công cụ khác nhau',
          'Tối ưu quy trình xử lý hội thoại đa tài khoản bằng sidebar chuyển nhanh, bộ lọc tập trung và cơ chế tự chuyển sang đúng tài khoản khi mở từng hội thoại',
          'Tăng khả năng chăm sóc khách hàng bằng bộ lọc CRM theo loại liên hệ, nhãn, giới tính, ngày sinh, tương tác cuối và trạng thái chiến dịch',
          'Nâng cao khả năng phối hợp đội nhóm với mô hình boss quản trị tập trung, nhân viên thao tác trên máy riêng nhưng dữ liệu vẫn đồng bộ về workspace chính',
          'Tạo nền tảng mở rộng cho bán hàng đa kênh và tự động hóa dài hạn nhờ hệ thống tích hợp, workflow và báo cáo có thể kết hợp linh hoạt theo từng mô hình kinh doanh',
        ],
      },
      {
        category: 'security',
        items: [
          'Áp dụng kiến trúc dữ liệu lưu cục bộ trên máy người dùng: tin nhắn, danh bạ, CRM, cài đặt và media không đi qua server trung gian của hệ thống',
          'Đăng nhập bằng QR Code, không yêu cầu lưu mật khẩu Zalo; phiên đăng nhập và credential tích hợp được lưu theo cơ chế bảo mật trên máy',
          'Cho phép đổi thư mục lưu trữ dữ liệu, sao chép dữ liệu tự động khi migrate và chủ động sao lưu để kiểm soát an toàn dữ liệu lâu dài',
        ],
      },
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
const TYPE_STYLES: Record<VersionEntry['type'], { label: string; cls: string }> = {
  major:  { label: 'Major',  cls: 'bg-purple-600/30 text-purple-500 border border-purple-500/30' },
  minor:  { label: 'Minor',  cls: 'bg-blue-600/30 text-blue-500 border border-blue-500/30' },
  patch:  { label: 'Patch',  cls: 'bg-gray-600/40 text-gray-500 border border-gray-500/30' },
  hotfix: { label: 'Hotfix', cls: 'bg-red-600/30 text-red-500 border border-red-500/30' },
};

const CATEGORY_STYLES: Record<string, { icon: string; label: string; cls: string }> = {
  new:      { icon: '✨', label: 'Tính năng mới',   cls: 'text-green-400' },
  improved: { icon: '⚡', label: 'Cải thiện',        cls: 'text-blue-400' },
  fixed:    { icon: '🐛', label: 'Sửa lỗi',          cls: 'text-amber-400' },
  removed:  { icon: '🗑️', label: 'Đã xóa',           cls: 'text-red-400' },
  security: { icon: '🔒', label: 'Bảo mật',          cls: 'text-purple-400' },
};

// ─── Main component ───────────────────────────────────────────────────────────
export default function ChangelogSettings() {
  const [expandedVersions, setExpandedVersions] = useState<Set<string>>(
    new Set([CHANGELOG[0]?.version]) // expand latest by default
  );

  const toggle = (version: string) => {
    setExpandedVersions(prev => {
      const next = new Set(prev);
      if (next.has(version)) next.delete(version);
      else next.add(version);
      return next;
    });
  };

  const expandAll = () => setExpandedVersions(new Set(CHANGELOG.map(v => v.version)));
  const collapseAll = () => setExpandedVersions(new Set());

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">📋 Log phiên bản</h2>
        <div className="flex gap-2">
          <button onClick={expandAll}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-2 py-1 rounded-lg hover:bg-gray-700">
            Mở rộng tất cả
          </button>
          <button onClick={collapseAll}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors px-2 py-1 rounded-lg hover:bg-gray-700">
            Thu gọn
          </button>
        </div>
      </div>

      {/* Latest badge */}
      <div className="bg-green-900/20 border border-green-700/40 rounded-xl px-4 py-2.5 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse flex-shrink-0" />
        <span className="text-green-300 text-xs font-medium">
          Phiên bản hiện tại: <strong>v{CHANGELOG[0]?.version}</strong> — {CHANGELOG[0]?.date}
        </span>
      </div>

      {/* Entries */}
      <div className="space-y-3">
        {CHANGELOG.map((entry, idx) => {
          const isExpanded = expandedVersions.has(entry.version);
          const typeStyle = TYPE_STYLES[entry.type];
          const isLatest = idx === 0;

          return (
            <div key={entry.version}
              className={`border rounded-xl overflow-hidden transition-colors ${
                isLatest ? 'border-blue-700/50 bg-blue-900/10' : 'border-gray-700 bg-gray-800/40'
              }`}>
              {/* Header */}
              <button
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-white/5 transition-colors"
                onClick={() => toggle(entry.version)}
              >
                <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${typeStyle.cls}`}>
                  {typeStyle.label}
                </span>
                <span className="text-white font-bold text-sm flex-1">
                  v{entry.version}
                  {isLatest && (
                    <span className="ml-2 text-[11px] bg-green-600/30 text-green-400 border border-green-500/30 px-1.5 py-0.5 rounded-full font-normal align-middle">
                      Mới nhất
                    </span>
                  )}
                </span>
                <span className="text-gray-500 text-xs mr-2">{entry.date}</span>
                <svg
                  width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                  className={`text-gray-500 flex-shrink-0 transition-transform ${isExpanded ? 'rotate-180' : ''}`}>
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>

              {/* Body */}
              {isExpanded && (
                <div className="px-4 pb-4 space-y-3 border-t border-gray-700/50 pt-3">
                  {/* Highlights */}
                  {entry.highlights && entry.highlights.length > 0 && (
                    <div className="bg-gray-700/30 rounded-lg px-3 py-2.5 space-y-1">
                      {entry.highlights.map((h, i) => (
                        <p key={i} className="text-gray-200 text-xs font-medium">{h}</p>
                      ))}
                    </div>
                  )}

                  {/* Change categories */}
                  {entry.changes.map((group, gi) => {
                    const style = CATEGORY_STYLES[group.category];
                    return (
                      <div key={gi} className="space-y-1.5">
                        <p className={`text-xs font-semibold flex items-center gap-1.5 ${style.cls}`}>
                          <span>{style.icon}</span>
                          {style.label}
                        </p>
                        <ul className="space-y-1 pl-1">
                          {group.items.map((item, ii) => (
                            <li key={ii} className="flex items-start gap-2 text-gray-400 text-xs">
                              <span className="text-gray-600 mt-0.5 flex-shrink-0">—</span>
                              {item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
