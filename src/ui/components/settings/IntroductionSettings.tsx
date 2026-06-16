import React, { useState, useEffect } from 'react';
import ipc from '@/lib/ipc';
import qrCodeImg from '../../../assets/donate/qr.png';

type FeatureId =
  | 'overview'
  | 'dashboard'
  | 'multiAccount'
  | 'messaging'
  | 'crm'
  | 'workflow'
  | 'integration-pos'
  | 'integration-payment'
  | 'integration-shipping'
  | 'ai-assistant'
  | 'analytics'
  | 'erp'
  | 'employees'
  | 'security'
  | 'policy'
  | 'bugreport'
  | 'donate';

interface Feature {
  id: FeatureId;
  icon: string;
  label: string;
}

const FEATURES: Feature[] = [
  { id: 'overview',     icon: '🏠', label: 'Tổng quan' },
  { id: 'dashboard',    icon: '📊', label: 'Dashboard' },
  { id: 'multiAccount', icon: '👤', label: 'Đa tài khoản' },
  { id: 'messaging',    icon: '💬', label: 'Quản lý tin nhắn' },
  { id: 'crm',          icon: '👥', label: 'CRM & Khách hàng' },
  { id: 'workflow',     icon: '⚙️', label: 'Workflow tự động' },
  { id: 'integration-pos', icon: '🛒', label: 'Tích hợp POS' },
  { id: 'integration-payment', icon: '💳', label: 'Tích hợp thanh toán' },
  { id: 'integration-shipping', icon: '📦', label: 'Tích hợp vận chuyển' },
  { id: 'ai-assistant', icon: '🤖', label: 'Trợ lý AI' },
  { id: 'analytics',    icon: '📈', label: 'Báo cáo & Phân tích' },
  { id: 'erp',          icon: '🗂️', label: 'ERP quản trị nội bộ' },
  { id: 'employees',    icon: '🧑‍💼', label: 'Cài đặt nhân viên & workspace' },
  { id: 'security',     icon: '🔒', label: 'Bảo mật & Dữ liệu' },
  { id: 'policy',       icon: '📜', label: 'Chính sách pháp lý' },
  { id: 'bugreport',    icon: '🐛', label: 'Hướng dẫn báo lỗi' },
  { id: 'donate',       icon: '☕', label: 'Donate & Ủng hộ' },
];

function Badge({ text, color }: { text: string; color: string }) {
  return (
    <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full ${color}`}>{text}</span>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="text-white font-semibold text-sm mb-2">{children}</p>;
}

function Paragraph({ children }: { children: React.ReactNode }) {
  return <p className="text-gray-400 text-xs leading-relaxed">{children}</p>;
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex items-start gap-2 text-gray-400 text-xs">
          <span className="text-blue-400 mt-0.5 flex-shrink-0">•</span>
          <span dangerouslySetInnerHTML={{ __html: item }} />
        </li>
      ))}
    </ul>
  );
}

function StepList({ steps }: { steps: { title: string; desc: string }[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3">
          <span className="w-6 h-6 rounded-full bg-blue-600/30 text-blue-400 text-[11px] font-bold flex items-center justify-center flex-shrink-0 mt-0.5">
            {i + 1}
          </span>
          <div>
            <p className="text-gray-300 text-xs font-semibold">{s.title}</p>
            <p className="text-gray-500 text-xs mt-0.5" dangerouslySetInnerHTML={{ __html: s.desc }} />
          </div>
        </li>
      ))}
    </ol>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-gray-800/60 border border-gray-700/50 rounded-xl p-4 space-y-3">
      {children}
    </div>
  );
}

// ─── Feature content panels ───────────────────────────────────────────────────

function OverviewPanel() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-4xl leading-none">🤖</span>
        <div>
          <h3 className="text-white font-bold text-base">Deplao</h3>
          <p className="text-gray-400 text-xs mt-0.5">Phần mềm desktop quản lý Zalo & Facebook cá nhân Đa tài khoản tích hợp CRM, ERP, POS, Workflow và AI Assistant giúp đội nhóm bán hàng, chăm sóc khách hàng và marketing trên Zalo và Facebook vận hành tập trung trong một ứng dụng duy nhất.</p>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            <Badge text="Desktop App" color="bg-blue-600/30 text-blue-300" />
          </div>
        </div>
      </div>

      <Card>
        <SectionTitle>🎯 Ứng dụng được xây dựng cho ai?</SectionTitle>
        <div className="space-y-2">
          {([
            ['🏢', 'Doanh nghiệp vừa và nhỏ (SME)', 'Quản lý nhiều tài khoản Zalo/Facebook cùng lúc, phân công nhân viên chăm sóc từng kênh, theo dõi hiệu suất qua báo cáo tập trung.'],
            ['📣', 'Marketing Agency / Freelancer Marketing', 'Chạy chiến dịch gửi tin hàng loạt, quản lý danh sách khách hàng của nhiều client, tự động hóa nuture lead qua Zalo & Facebook.'],
            ['🛒', 'Shop online / Kinh doanh thương mại điện tử', 'Nhận đơn, CSKH, gửi thông báo đơn hàng và tương tác với khách qua Zalo & Facebook — kết nối trực tiếp với POS, GHN, VNPay.'],
            ['📞', 'Sales & Telesales', 'Quản lý pipeline khách hàng trên Zalo & Facebook, tự động gửi follow-up, lọc khách theo trạng thái chiến dịch và tương tác gần nhất.'],
            ['🎓', 'Trung tâm đào tạo / Giáo dục', 'Gửi thông báo lịch học, nhắc học viên, chăm sóc phụ huynh hàng loạt, phân nhóm theo lớp/khóa học.'],
            ['🏥', 'Phòng khám / Spa / Làm đẹp', 'Nhắc lịch hẹn tự động, gửi chăm sóc sau dịch vụ, chúc mừng sinh nhật khách hàng đúng ngày để tạo thiện cảm và kéo khách quay lại.'],
            ['🍜', 'F&B / Nhà hàng / Quán ăn', 'Gửi ưu đãi theo ngày đặc biệt, xây dựng nhóm khách hàng thân thiết, kết nối POS để tự động hóa thông báo đơn hàng.'],
            ['🤝', 'Team/Đội nhóm bán hàng nhiều người', 'Boss cấp tài khoản nhân viên, phân quyền từng người được xem/làm gì, theo dõi hiệu suất làm việc qua báo cáo nhân viên.'],
            ['💼', 'Đại lý / Nhà phân phối', 'Quản lý mạng lưới đại lý qua Zalo, tự động cập nhật giá/sản phẩm mới, phân nhóm đại lý theo khu vực bằng nhãn và workflow.'],
            ['📱', 'Content Creator / KOC / KOL', 'Quản lý tin nhắn từ follower, tự động trả lời câu hỏi thường gặp bằng AI, nuture audience thành khách hàng mua hàng.'],
          ] as [string,string,string][]).map(([icon, title, desc], i) => (
            <div key={i} className="flex gap-2.5 bg-gray-700/30 rounded-lg p-2.5">
              <span className="text-base flex-shrink-0 mt-0.5">{icon}</span>
              <div>
                <p className="text-gray-200 text-[11px] font-semibold">{title}</p>
                <p className="text-gray-500 text-[11px] mt-0.5 leading-relaxed">{desc}</p>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>✨ Tính năng nổi bật</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: '👤', text: 'Đa tài khoản Zalo & FB' },
            { icon: '💬', text: 'Quản lý hội thoại tập trung' },
            { icon: '👥', text: 'CRM khách hàng' },
            { icon: '⚙️', text: 'Workflow tự động hoá' },
            { icon: '🤖', text: 'Trợ lý AI' },
            { icon: '🏪', text: 'Kết nối POS, thanh toán, vận chuyển' },
            { icon: '🗂️', text: 'ERP quản trị nội bộ' },
            { icon: '🧑‍💼', text: 'Cài đặt nhân viên & workspace' },
            { icon: '📊', text: 'Báo cáo thống kê' },
          ].map((f, i) => (
            <div key={i} className="flex items-center gap-2 bg-gray-700/40 rounded-lg px-3 py-2">
              <span className="text-sm">{f.icon}</span>
              <span className="text-gray-300 text-xs">{f.text}</span>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>💡 Yêu cầu hệ thống</SectionTitle>
        <BulletList items={[
          'Windows 10/11 (64-bit) hoặc MacOS — đề xuất chạy trên PC/máy chủ ổn định',
          'RAM tối thiểu: <strong class="text-gray-200">4 GB</strong> (đề xuất 8 GB trở lên)',
          'Kết nối Internet ổn định để đồng bộ tin nhắn Zalo theo thời gian thực',
          'Chạy <strong class="text-gray-200">24/7</strong> để nhận tin nhắn, workflow và Tự động hoá hoạt động liên tục',
        ]} />
      </Card>
    </div>
  );
}

function MultiAccountPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>👤 Đăng nhập nhiều tài khoản Zalo & Facebook</SectionTitle>
        <Paragraph>
          Deplao cho phép bạn đăng nhập và quản lý <strong className="text-white font-semibold">không giới hạn tài khoản Zalo và Facebook</strong> trong một giao diện duy nhất.
          Mỗi tài khoản hoạt động độc lập, an toàn và không ảnh hưởng lẫn nhau.
        </Paragraph>
        <StepList steps={[
          { title: 'Thêm tài khoản Zalo', desc: 'Nhấn nút "Thêm tài khoản" ở sidebar → quét QR Code bằng ứng dụng Zalo trên điện thoại.' },
          { title: 'Thêm tài khoản Facebook', desc: 'Nhấn nút "Thêm tài khoản" → chọn Facebook → dán cookie Facebook (hướng dẫn trong app).' },
          { title: 'Phiên đăng nhập được duy trì', desc: 'Sau khi đăng nhập, phiên được lưu bảo mật trên máy cục bộ, không cần xác thực lại lần sau.' },
          { title: 'Chuyển đổi tức thì', desc: 'Nhấp vào avatar tài khoản ở sidebar để chuyển đổi giữa các tài khoản không cần đăng xuất.' },
          { title: 'Giám sát trạng thái', desc: 'Dashboard hiển thị trạng thái Online/Offline, listener sống/chết của từng tài khoản theo thời gian thực.' },
          { title: 'Kết nối lại tự động', desc: 'Khi listener bị ngắt (mất mạng, restart...), app tự động thử kết nối lại tối đa 5 lần với backoff tăng dần.' },
        ]} />
      </Card>

      <Card>
        <SectionTitle>🔒 Proxy — Chọn proxy trước khi đăng nhập</SectionTitle>
        <div className="flex items-center gap-3 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-2 mb-2">
          <span className="text-blue-400 text-sm flex-shrink-0">✨</span>
          <p className="text-blue-300 text-xs font-medium">Mỗi tài khoản Zalo có thể dùng proxy riêng — không ảnh hưởng lẫn nhau</p>
        </div>
        <Paragraph>
          Deplao hỗ trợ cấu hình proxy trước khi đăng nhập tài khoản Zalo. Hữu ích khi cần tách biệt IP cho từng tài khoản,
          sử dụng proxy doanh nghiệp, hoặc đăng nhập tài khoản từ vùng địa lý khác.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-gray-200">Hỗ trợ giao thức:</strong> HTTP · HTTPS · SOCKS5',
          '<strong class="text-gray-200">Cấu hình:</strong> Nhấn nút Proxy trên màn hình đăng nhập QR → nhập địa chỉ proxy (host:port) và thông tin xác thực nếu có',
          '<strong class="text-gray-200">Gán theo tài khoản:</strong> Mỗi tài khoản Zalo lưu proxy riêng — đổi tài khoản là đổi proxy tự động',
          '<strong class="text-gray-200">Kiểm tra proxy:</strong> Nhấn "Test" để xác nhận proxy hoạt động trước khi quét QR đăng nhập',
          '<strong class="text-gray-200">Bỏ proxy:</strong> Để trống địa chỉ proxy và lưu lại — tài khoản đó sẽ kết nối trực tiếp không qua proxy',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🔀 Chế độ Gộp trang</SectionTitle>
        <div className="flex items-center gap-3 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-2 mb-2">
          <span className="text-blue-400 text-sm flex-shrink-0">✨</span>
          <p className="text-blue-300 text-xs font-medium">Tính năng độc quyền — quản lý nhiều Zalo chỉ trong một hộp thư duy nhất</p>
        </div>
        <Paragraph>
          Chế độ Gộp trang cho phép bạn xem và trả lời hội thoại từ <strong className="text-green-500">tất cả tài khoản Zalo</strong> trong một danh sách
          hội thoại hợp nhất, sắp xếp theo thời gian thực — không cần chuyển tab qua lại từng tài khoản.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-gray-200">Kích hoạt:</strong> Vào Dashboard → nhấn nút <em>"Gộp tài khoản"</em> → chọn các tài khoản muốn gộp → Xác nhận',
          '<strong class="text-gray-200">Sidebar hiển thị bộ lọc nhanh:</strong> Icon "tất cả tài khoản" + avatar từng tài khoản → nhấn để lọc chỉ xem hội thoại của tài khoản đó',
          '<strong class="text-gray-200">Badge tài khoản:</strong> Mỗi hội thoại trong danh sách hiển thị avatar nhỏ của tài khoản sở hữu để dễ nhận biết',
          '<strong class="text-gray-200">Tự động chuyển tài khoản:</strong> Khi click vào hội thoại, app tự động chuyển sang đúng tài khoản chủ sở hữu trước khi hiển thị chat',
          '<strong class="text-gray-200">Bộ lọc đầy đủ:</strong> Tất cả · Chưa đọc · Phân loại nhãn · Khác — tất cả hoạt động xuyên suốt mọi tài khoản được gộp',
          '<strong class="text-gray-200">Nhãn gộp thông minh:</strong> Nhãn cùng tên từ nhiều tài khoản được hợp nhất thành một nhãn duy nhất trong bộ lọc',
          '<strong class="text-gray-200">Tìm kiếm tên:</strong> Tìm kiếm theo tên/biệt danh hoạt động trực tiếp trên toàn bộ hội thoại đã gộp',
          '<strong class="text-gray-200">Tìm kiếm số điện thoại:</strong> Khi nhập SĐT, app yêu cầu chọn tài khoản để tra cứu (vì mỗi tài khoản Zalo tra cứu độc lập)',
          '<strong class="text-gray-200">Thoát chế độ gộp:</strong> Nhấn nút "Đang Gộp tài khoản" trên Dashboard hoặc nhấn X trên sidebar',
        ]} />
      </Card>

      <Card>
        <SectionTitle>⚠️ Lưu ý quan trọng</SectionTitle>
        <BulletList items={[
          'Tài khoản Zalo phải là tài khoản <strong class="text-gray-200">cá nhân hoặc tài khoản doanh nghiệp</strong> hợp lệ',
          'App không hỗ trợ tài khoản đã bị Zalo khóa hoặc giới hạn tính năng',
          'Đăng nhập thông qua QR Code — ứng dụng không lưu mật khẩu Zalo',
          'Tài khoản đã bị ngắt kết nối (cookie hết hạn) sẽ không tự động gọi lên Zalo — cần kết nối lại thủ công hoặc quét QR mới',
          'Với chế độ Gộp trang: chỉ gộp các tài khoản <strong class="text-gray-200">đang online</strong> để đảm bảo nhận tin nhắn đầy đủ',
        ]} />
      </Card>
    </div>
  );
}

function MessagingPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>💬 Hộp thư tập trung — Danh sách hội thoại</SectionTitle>
        <Paragraph>
          Toàn bộ hội thoại từ tất cả tài khoản Zalo cá nhân & Facebook cá nhân (beta) hiển thị trong một màn hình duy nhất.
          Hệ thống bộ lọc giúp bạn tập trung vào đúng hội thoại cần xử lý ngay lập tức.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-gray-200">Bộ lọc hội thoại:</strong> Tất cả · Chưa đọc · Chưa trả lời · Khác · Theo nhãn',
          '<strong class="text-gray-200">Tìm kiếm thông minh:</strong> Tìm theo tên, biệt danh, hoặc nhập số điện thoại để tra cứu và tìm người dùng Zalo',
          '<strong class="text-gray-200">Ghim hội thoại:</strong> Ghim các hội thoại quan trọng lên đầu danh sách',
          '<strong class="text-gray-200">Tắt thông báo (Mute):</strong> Tắt trong 1 giờ · 4 giờ · Đến 8:00 AM · Cho đến khi mở lại',
          '<strong class="text-gray-200">Menu chuột phải:</strong> Gán nhãn nhanh, ghim, mute, mời vào nhóm, xóa hội thoại',
          '<strong class="text-gray-200">Tạo nhóm mới:</strong> Tạo nhóm Zalo trực tiếp từ thanh hộp thư',
          '<strong class="text-gray-200">Đồng bộ nhãn:</strong> Nhấn sync để đồng bộ nhãn mới nhất từ Zalo về app',
        ]} />
      </Card>

      <Card>
        <SectionTitle>✏️ Soạn tin nhắn — Đầy đủ tính năng Zalo</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: '📝', feat: 'Định dạng văn bản', desc: 'In đậm, in nghiêng, gạch chân, gạch ngang' },
            { icon: '😊', feat: 'Emoji & Sticker', desc: 'Bộ emoji đầy đủ + sticker Zalo' },
            { icon: '🖼', feat: 'Gửi ảnh & video', desc: 'Từ file hoặc dán từ clipboard' },
            { icon: '📎', feat: 'Gửi file đính kèm', desc: 'Mọi định dạng file' },
            { icon: '↩️', feat: 'Trả lời (Reply)', desc: 'Reply trực tiếp vào tin nhắn cụ thể' },
            { icon: '@', feat: 'Tag thành viên', desc: 'Gõ @ để tag trong nhóm (gợi ý tự động)' },
            { icon: '📊', feat: 'Tạo bình chọn', desc: 'Tạo poll trong nhóm Zalo' },
            { icon: '📝', feat: 'Ghi chú nhóm', desc: 'Tạo & xem note được ghim trong nhóm' },
            { icon: '⏰', feat: 'Nhắc nhở', desc: 'Đặt reminder ngay trong hội thoại' },
            { icon: '📇', feat: 'Gửi danh thiếp', desc: 'Share thông tin liên hệ qua card' },
          ].map((f, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg px-2.5 py-2">
              <p className="text-gray-200 text-[11px] font-medium">{f.icon} {f.feat}</p>
              <p className="text-gray-500 text-[11px] mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>⚡ Tin nhắn nhanh (Quick Messages)</SectionTitle>
        <Paragraph>
          Lưu sẵn các mẫu tin nhắn thường dùng, gõ <code style={{color:'#86efac',background:'#1f2937',padding:'0.0625rem 0.3125rem',borderRadius:'0.1875rem'}}>/từ_khóa</code> để gợi ý và gửi ngay — tiết kiệm thời gian soạn tin lặp lại mỗi ngày.
        </Paragraph>
        <div className="flex items-center gap-3 bg-green-900/20 border border-green-700/40 rounded-lg px-3 py-2 mb-1">
          <span className="text-green-400 text-sm flex-shrink-0">🏆</span>
          <p className="text-green-300 text-xs"><strong>Không giới hạn</strong> số lượng mẫu tin — Zalo gốc chỉ cho lưu <strong>1 tin nhắn nhanh</strong></p>
        </div>
        <BulletList items={[
          '<strong class="text-gray-200">2 chế độ:</strong> Tin nhắn nhanh đồng bộ từ Zalo (dùng được trên điện thoại) và Tin nhắn nhanh cục bộ chỉ trong app',
          'Mỗi mẫu có từ khóa gợi nhớ, tiêu đề và có thể đính kèm ảnh/media',
          'Gõ <code style="color:#86efac;background:#1f2937;padding:1px 5px;border-radius:3px">/</code> trong ô soạn tin → dropdown gợi ý xuất hiện ngay, lọc theo từ khóa',
          'Quản lý (thêm/sửa/xóa) tất cả mẫu tin trong phần Quick Message Manager',
        ]} />
      </Card>

      <Card>
        <SectionTitle>📌 Tin nhắn ghim & Ghi chú nhóm</SectionTitle>
        <div className="flex items-center gap-3 bg-green-900/20 border border-green-700/40 rounded-lg px-3 py-2 mb-1">
          <span className="text-green-400 text-sm flex-shrink-0">🏆</span>
          <p className="text-green-300 text-xs"><strong>Ghim không giới hạn</strong> số tin nhắn — Zalo gốc chỉ cho ghim tối đa <strong>3 tin</strong> mỗi hội thoại</p>
        </div>
        <BulletList items={[
          'Ghim bất kỳ tin nhắn nào lên thanh ghim ở đầu cửa sổ chat',
          'Click vào thanh ghim để nhảy đến tin nhắn gốc trong lịch sử',
          'Nhóm hỗ trợ ghim nhiều tin nhắn cùng lúc (xem tất cả trong danh sách)',
          '<strong class="text-gray-200">Bảng nhóm (Group Board):</strong> Tổng hợp tất cả ghim · ghi chú · bình chọn trong nhóm, lọc theo tab',
          'Ghi chú nhóm đồng bộ với tất cả thành viên nhóm trên Zalo',
        ]} />
      </Card>

      <Card>
        <SectionTitle>⏰ Nhắc nhở trong hội thoại (Reminders)</SectionTitle>
        <BulletList items={[
          'Đặt nhắc nhở trực tiếp trong bất kỳ hội thoại nào (cá nhân hoặc nhóm)',
          'Chọn thời gian cụ thể, emoji và màu sắc cho nhắc nhở',
          '<strong class="text-gray-200">Chế độ lặp:</strong> Không lặp · Hàng ngày · Hàng tuần · Hàng tháng',
          'Nhắc nhở hiển thị popup thông báo đúng giờ ngay trong app',
        ]} />
      </Card>

      <Card>
        <SectionTitle>📁 Kho media & File đính kèm</SectionTitle>
        <BulletList items={[
          'Panel thông tin hội thoại (bên phải) tổng hợp toàn bộ ảnh, video, file đã chia sẻ',
          'Lọc theo loại media: Ảnh · Video · File',
          'Xem trước ảnh/video trực tiếp trong app không cần mở ứng dụng ngoài',
          'Tải về file từ lịch sử chat bất kỳ lúc nào',
        ]} />
      </Card>

      <Card>
        <SectionTitle>⚙️ Menu tin nhắn & Hành động nhanh</SectionTitle>
        <Paragraph>
          Chuột phải (hoặc hover) vào bất kỳ tin nhắn nào để mở menu hành động:
        </Paragraph>
        <BulletList items={[
          '😀 React bằng emoji (36 emoji nhanh có sẵn)',
          '↩️ Trả lời tin nhắn cụ thể (Reply)',
          '↪️ Chuyển tiếp (Forward) sang hội thoại khác',
          '📌 Ghim / Bỏ ghim tin nhắn',
          '📋 Sao chép nội dung tin nhắn',
          '🗑️ Thu hồi (Recall) hoặc xóa tin nhắn',
        ]} />
      </Card>

      <Card>
        <SectionTitle>👤 Panel thông tin liên hệ & Nhóm</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Biệt danh:</strong> Đặt biệt danh riêng cho từng liên hệ (chỉ hiển thị trong app)',
          '<strong class="text-gray-200">Nhóm chung:</strong> Xem danh sách nhóm mà bạn và liên hệ đều là thành viên',
          '<strong class="text-gray-200">Chặn / Bỏ chặn:</strong> Chặn tin nhắn và cuộc gọi từ người dùng',
          '<strong class="text-gray-200">Báo xấu:</strong> Report người dùng hoặc nhóm vi phạm',
          '<strong class="text-gray-200">Xóa lịch sử:</strong> Xóa toàn bộ tin nhắn cục bộ của hội thoại',
          '<strong class="text-gray-200">Quản lý nhóm:</strong> Xem/quản lý thành viên, phân quyền admin, đổi tên nhóm, rời nhóm',
        ]} />
      </Card>

      <Card>
        <SectionTitle>⚠️ Hạn chế cần lưu ý</SectionTitle>
        <div className="flex items-start gap-3 bg-yellow-900/20 border border-yellow-700/40 rounded-lg px-3 py-2.5">
          <span className="text-yellow-400 text-sm flex-shrink-0 mt-0.5">⚠️</span>
          <div className="space-y-1">
            <p className="text-yellow-300 text-xs font-semibold">Không hỗ trợ nghe & gọi (thoại / video call)</p>
            <p className="text-gray-400 text-xs leading-relaxed">
              Deplao tập trung vào nhắn tin và Tự động hoá. Các cuộc gọi thoại và video call qua Zalo
              không được hỗ trợ trong phiên bản hiện tại. Để thực hiện cuộc gọi, bạn cần dùng
              ứng dụng Zalo trên điện thoại hoặc Zalo PC chính thức.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ErpPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-start gap-3">
          <span className="text-3xl leading-none">🗂️</span>
          <div>
            <SectionTitle>ERP quản trị nội bộ — giao việc, lịch, note, nhân sự</SectionTitle>
            <Paragraph>
              Module ERP giúp đội nhóm quản lý công việc nội bộ ngay trong Deplao: từ giao task, theo dõi deadline,
              quản lý lịch, ghi chú nghiệp vụ đến phân quyền nhân sự giữa boss và nhân viên.
            </Paragraph>
          </div>
        </div>
        <div className="flex gap-1.5 flex-wrap">
          <Badge text="Task" color="bg-blue-600/20 text-blue-300" />
          <Badge text="Calendar" color="bg-violet-600/20 text-violet-300" />
          <Badge text="Notes" color="bg-emerald-600/20 text-emerald-300" />
          <Badge text="HRM" color="bg-amber-600/20 text-amber-300" />
        </div>
      </Card>

      <Card>
        <SectionTitle>✅ Task & giao việc nội bộ</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Kanban / Danh sách / Của tôi:</strong> theo dõi công việc theo trạng thái, deadline và người phụ trách',
          '<strong class="text-gray-200">Task detail đầy đủ:</strong> mô tả rich text, checklist, bình luận, người thực hiện, người theo dõi, file đính kèm',
          '<strong class="text-gray-200">Inbox cá nhân:</strong> gom các việc cần làm hôm nay, tuần này, quá hạn và việc sắp tới',
          '<strong class="text-gray-200">Boss ↔ nhân viên:</strong> giao việc và cập nhật tiến độ theo thời gian thực trong cùng workspace',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🗓️ Lịch làm việc & nhắc việc</SectionTitle>
        <BulletList items={[
          'Tạo lịch cá nhân hoặc sự kiện làm việc nội bộ ngay trong app',
          'Mở nhanh chi tiết sự kiện để xem, sửa hoặc xóa giống trải nghiệm lịch chính',
          'Nhắc việc và cập nhật thay đổi theo thời gian thực giữa boss và nhân viên được cấp quyền',
          'Phù hợp để quản lý lịch hẹn khách, lịch họp nội bộ và deadline công việc',
        ]} />
      </Card>

      <Card>
        <SectionTitle>📝 Notes nghiệp vụ & tài liệu nội bộ</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Ghi chú theo thư mục:</strong> lưu SOP, mẫu câu, quy trình và tài liệu vận hành',
          '<strong class="text-gray-200">Riêng tư theo workspace:</strong> note mặc định là dữ liệu riêng, chỉ chia sẻ khi người tạo chủ động chia sẻ',
          '<strong class="text-gray-200">Lịch sử phiên bản:</strong> hỗ trợ xem phiên bản và khôi phục khi cần',
          '<strong class="text-gray-200">Tìm lại nhanh:</strong> lọc theo thư mục, tag và nội dung đang làm việc',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🧑‍💼 Quản lý nhân sự & quyền truy cập ERP</SectionTitle>
        <BulletList items={[
          'Quản lý vai trò ERP giữa owner / admin / manager / member / guest',
          'Phân quyền để nhân viên chỉ thấy đúng module và dữ liệu được cấp phép',
          'Hỗ trợ hồ sơ nhân sự mở rộng, dữ liệu đồng bộ theo boss ↔ employee workspace',
          'Làm nền tảng cho attendance, leave request và các báo cáo vận hành nội bộ',
        ]} />
      </Card>

      <Card>
        <SectionTitle>💡 Khi nào nên dùng ERP trong Deplao?</SectionTitle>
        <BulletList items={[
          'Khi bạn muốn <strong class="text-gray-200">giao việc từ ngay sau hội thoại khách hàng</strong> mà không cần chuyển sang app khác',
          'Khi boss cần nhìn được <strong class="text-gray-200">ai đang làm gì, ai theo dõi việc gì, việc nào sắp quá hạn</strong>',
          'Khi team cần dùng chung một nơi để quản lý task, lịch, note và phối hợp nội bộ',
          'Khi muốn vận hành gọn trên một desktop app duy nhất: chat + CRM + workflow + ERP',
        ]} />
      </Card>
    </div>
  );
}

function CrmPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>👥 Danh sách liên hệ & Tìm kiếm nâng cao</SectionTitle>
        <Paragraph>
          Toàn bộ <strong className="text-gray-200">bạn bè cá nhân</strong> và <strong className="text-gray-200">thành viên các nhóm Zalo</strong> bạn đang tham gia
          đều được đồng bộ tự động vào CRM. Mỗi liên hệ có thể lưu đầy đủ hồ sơ bao gồm ảnh đại diện, tên, số điện thoại,
          <strong className="text-gray-200"> giới tính</strong> và <strong className="text-gray-200">ngày sinh</strong> — đồng bộ từ profile Zalo thực tế.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-gray-200">Nguồn dữ liệu:</strong> Bạn bè Zalo + thành viên tất cả các nhóm bạn đang tham gia — không bỏ sót ai',
          '<strong class="text-gray-200">Phân loại liên hệ:</strong> Bạn bè cá nhân · Nhóm Zalo · Người lạ chưa kết bạn',
          '<strong class="text-gray-200">Thông tin hồ sơ:</strong> Tên · SĐT · Giới tính (Nam/Nữ) · Ngày sinh (ngày/tháng/năm)',
          '<strong class="text-gray-200">Tìm kiếm:</strong> Theo tên, số điện thoại, Zalo ID, nội dung ghi chú',
          '<strong class="text-gray-200">Sắp xếp:</strong> Theo tên A–Z, ngày thêm, lần nhắn cuối, số tin nhắn',
          '<strong class="text-gray-200">Bộ lọc kết hợp:</strong> Loại liên hệ + nhãn Zalo + giới tính + ngày sinh + trạng thái chiến dịch',
          '<strong class="text-gray-200">Chọn hàng loạt:</strong> Tick chọn nhiều liên hệ để thêm vào chiến dịch, gán nhãn, hoặc xuất danh sách',
        ]} />
      </Card>

      <Card>
        <SectionTitle>👥 Quản lý thành viên nhóm Zalo</SectionTitle>
        <BulletList items={[
          'Xem danh sách toàn bộ thành viên trong từng nhóm Zalo',
          'Tìm kiếm thành viên theo tên trong nhóm',
          'Chọn thành viên để thêm nhanh vào chiến dịch',
        ]} />
        <div className="mt-3 space-y-2">
          <p className="text-white font-semibold text-xs">🔍 Quét thành viên nhóm nâng cao</p>
          <BulletList items={[
            '<strong class="text-gray-200">Quét thành viên nhóm ẩn:</strong> Với các nhóm lớn, Zalo chỉ trả về một phần thành viên trong danh sách thông thường. Tính năng quét nâng cao gửi thêm request để lấy toàn bộ thành viên thực tế — bao gồm cả những thành viên bị ẩn do giới hạn API.',
            '<strong class="text-gray-200">Quét nhóm chưa tham gia:</strong> Nhập Link nhóm Zalo (link mời) để quét danh sách thành viên của nhóm mà tài khoản <em>chưa là thành viên</em> — không cần tham gia nhóm vẫn lấy được danh sách.',
            '<strong class="text-gray-200">Xuất danh sách:</strong> Sau khi quét xong, có thể thêm toàn bộ hoặc chọn lọc thành viên vào chiến dịch CRM hoặc danh sách gửi tin.',
          ]} />
          <div className="bg-yellow-900/20 border border-yellow-700/40 rounded-lg px-3 py-2 mt-1">
            <p className="text-yellow-300 text-[11px] font-semibold mb-1">⚠️ Lưu ý khi quét</p>
            <BulletList items={[
              'Quét nhóm lớn (hàng nghìn thành viên) mất nhiều thời gian — không đóng cửa sổ trong khi quét.',
              'Quét nhóm chưa tham gia yêu cầu link mời còn hiệu lực và nhóm không đặt chế độ phê duyệt kín hoàn toàn.',
              'Sử dụng ở mức độ hợp lý để tránh tài khoản Zalo bị giới hạn do gọi API quá nhiều.',
            ]} />
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>🏷️ Nhãn Zalo (Label) — Phân nhóm thông minh</SectionTitle>
        <Paragraph>
          Nhãn được đồng bộ trực tiếp từ tính năng nhãn chính thức của Zalo.
          Khi bạn gán nhãn trong app, nhãn sẽ hiển thị luôn trên ứng dụng Zalo điện thoại.
        </Paragraph>
        <BulletList items={[
          'Tạo, đổi tên, xóa nhãn ngay trong app',
          'Gán/gỡ nhãn cho từng liên hệ hoặc hàng loạt',
          'Lọc danh sách liên hệ theo một hoặc nhiều nhãn',
          'Nhãn hiển thị đồng bộ trên app Zalo điện thoại thời gian thực',
          'Dùng nhãn làm điều kiện Trigger hoặc Action trong Workflow',
        ]} />
      </Card>

      <Card>
        <SectionTitle>📝 Ghi chú nội bộ (Notes)</SectionTitle>
        <BulletList items={[
          'Thêm ghi chú riêng cho từng liên hệ (khách hàng không thấy)',
          'Chỉnh sửa hoặc xóa ghi chú bất kỳ lúc nào',
          'Xem lại toàn bộ ghi chú theo dòng thời gian trong panel chi tiết liên hệ',
          'Dùng để lưu: nhu cầu, lịch hẹn, lịch sử deal, thông tin hợp đồng',
        ]} />
      </Card>


      <Card>
        <SectionTitle>🎂 Chăm sóc khách hàng theo Giới tính & Ngày sinh & Tương tác cuối</SectionTitle>
        <Paragraph>
          Dữ liệu giới tính và ngày sinh trong hồ sơ liên hệ mở ra khả năng <strong className="text-gray-200">cá nhân hoá chiến dịch</strong> —
          gửi đúng người, đúng thời điểm để tăng tỷ lệ phản hồi và giữ chân khách hàng cũ.
        </Paragraph>
        <div className="space-y-2">
          <p className="text-xs text-gray-300 font-semibold">💡 Gợi ý chiến dịch chăm sóc:</p>
          <div className="space-y-1.5">
            {([
              ['🎂', 'Chúc mừng sinh nhật theo ngày', 'Lọc liên hệ có ngày sinh = hôm nay (hoặc trong tuần) → tạo campaign gửi lời chúc + ưu đãi cá nhân hoá. Tỷ lệ mở và phản hồi sinh nhật thường cao nhất trong năm.'],
              ['📅', 'Chiến dịch theo tháng sinh', 'Mỗi đầu tháng, lọc toàn bộ khách sinh trong tháng → gửi ưu đãi tháng sinh. Ví dụ: "Tháng 5 — Tặng quà khách sinh nhật tháng 5"'],
              ['♀️♂️', 'Ưu đãi theo giới tính', 'Ngày 8/3 → chiến dịch riêng cho khách nữ. Ngày 20/10 tương tự. Ngày 14/2, 22/12 → khách nam. Lọc theo giới tính và bắn chiến dịch chỉ định.'],
              ['🔁', 'Kéo lại khách cũ đúng dịp', 'Kết hợp: khách cũ chưa nhắn tin lại > 30 ngày + sinh nhật trong tháng này → ưu tiên liên hệ lại nhóm này trước.'],
            ] as [string,string,string][]).map(([icon, title, desc], i) => (
                <div key={i} className="flex gap-2.5 bg-gray-700/30 rounded-lg p-2.5">
                  <span className="text-base flex-shrink-0 mt-0.5">{icon}</span>
                  <div>
                    <p className="text-gray-200 text-[11px] font-semibold">{title}</p>
                    <p className="text-gray-500 text-[11px] mt-0.5 leading-relaxed">{desc}</p>
                  </div>
                </div>
            ))}
          </div>
        </div>
        <div className="mt-2 bg-blue-700/60 border border-blue-700/30 rounded-lg px-3 py-2">
          <p className="text-gray-300 text-[11px] leading-relaxed">
            📌 <strong>Cách dùng:</strong> CRM → Danh sách liên hệ → Bộ lọc → chọn <em>"Sinh nhật hôm nay / tuần này / tháng này"</em> hoặc <em>"Giới tính"</em>
            → Chọn hết → Thêm vào chiến dịch → Soạn nội dung cá nhân hoá → Gửi.
          </p>
        </div>
      </Card>

      <Card>
        <SectionTitle>🚀 Chiến dịch gửi tin (Campaign)</SectionTitle>
        <Paragraph>
          Campaign là công cụ gửi tin / thực hiện hành động Zalo hàng loạt có kiểm soát,
          với delay cấu hình được để tránh bị Zalo giới hạn.
        </Paragraph>
        <div className="grid grid-cols-2 gap-2 my-1">
          {[
            { icon: '💬', type: 'Gửi tin nhắn', desc: 'Text, ảnh, file tới danh sách liên hệ' },
            { icon: '🤝', type: 'Kết bạn', desc: 'Gửi lời mời kết bạn hàng loạt' },
            { icon: '👥', type: 'Mời vào nhóm', desc: 'Thêm danh sách liên hệ vào nhóm Zalo' },
            { icon: '🔀', type: 'Hỗn hợp', desc: 'Kết hợp nhiều loại hành động' },
          ].map((c, i) => (
            <div key={i} className="bg-gray-700/40 rounded-lg p-2.5">
              <p className="text-xs text-gray-200 font-semibold">{c.icon} {c.type}</p>
              <p className="text-[11px] text-gray-500 mt-0.5">{c.desc}</p>
            </div>
          ))}
        </div>
        <BulletList items={[
          'Cài delay giữa các lần gửi (giây) để tránh spam detection',
          'Theo dõi tiến độ realtime: đã gửi / thất bại / đang chờ / đã phản hồi',
          'Tạm dừng / tiếp tục / nhân bản chiến dịch bất kỳ lúc nào',
          'Lọc chiến dịch theo trạng thái: Nháp · Đang chạy · Tạm dừng · Hoàn thành',
          'Log lịch sử gửi chi tiết cho từng liên hệ trong chiến dịch',
        ]} />
      </Card>
    </div>
  );
}

function WorkflowPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>⚙️ Workflow Engine — Tự động hoá không cần code</SectionTitle>
        <Paragraph>
          Workflow là hệ thống Tự động hoá dạng kéo-thả theo mô hình <strong className="text-white font-semibold">Trigger → Node → Action</strong>.
          Mỗi workflow chạy nền liên tục 24/7, xử lý sự kiện và thực hiện hành động theo logic bạn thiết lập.
        </Paragraph>
        <StepList steps={[
          { title: 'Tạo Workflow mới', desc: 'Vào menu Workflow → Tạo mới → Đặt tên → Chọn Trigger để bắt đầu.' },
          { title: 'Kéo thêm các Node', desc: 'Từ bảng Node bên trái, kéo thả vào canvas: Zalo Action, Logic, AI, Google Sheets...' },
          { title: 'Kết nối & cấu hình', desc: 'Nối các node bằng đường dây → Click vào node để điền tham số cụ thể.' },
          { title: 'Bật và giám sát', desc: 'Nhấn Bật → Workflow tự chạy nền. Xem kết quả trong tab Lịch sử chạy.' },
        ]} />
      </Card>

      <Card>
        <SectionTitle>🟣 Triggers — Sự kiện kích hoạt</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Tin nhắn mới</strong> — kích hoạt khi nhận tin, lọc theo từ khóa, loại hội thoại (cá nhân/nhóm)',
          '<strong class="text-gray-200">Lời mời kết bạn</strong> — khi có người gửi friend request đến tài khoản',
          '<strong class="text-gray-200">Sự kiện nhóm</strong> — khi ai đó tham gia, rời nhóm, hoặc thay đổi quyền admin',
          '<strong class="text-gray-200">Cảm xúc (React)</strong> — khi ai đó react vào tin nhắn bất kỳ',
          '<strong class="text-gray-200">Gán / Gỡ nhãn</strong> — khi một hội thoại được gán hoặc gỡ nhãn Zalo',
          '<strong class="text-gray-200">Lịch trình (Cron)</strong> — chạy theo lịch cố định: mỗi X phút, mỗi ngày lúc HH:MM, hàng tuần...',
          '<strong class="text-gray-200">Chạy thủ công</strong> — nhấn nút Test trong UI để chạy ngay một lần',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🔵 Zalo Actions — Hành động trực tiếp trên Zalo</SectionTitle>
        <div className="grid grid-cols-2 gap-1.5">
          {[
            ['💬 Gửi tin nhắn', 'Text với biến động, template'],
            ['⌨️ Gửi đang gõ + delay', 'Giả lập typing trước khi gửi'],
            ['🖼 Gửi ảnh', 'Từ file cục bộ hoặc URL'],
            ['📎 Gửi file', 'File đính kèm bất kỳ định dạng'],
            ['🔍 Tìm user theo SĐT', 'Tra cứu Zalo UID từ số điện thoại'],
            ['👤 Lấy thông tin user', 'Profile, tên, avatar của bất kỳ UID'],
            ['✅ Chấp nhận kết bạn', 'Auto-accept friend request'],
            ['❌ Từ chối kết bạn', 'Auto-reject friend request'],
            ['➕ Gửi lời mời kết bạn', 'Gửi FR đến UID hoặc SĐT'],
            ['👥 Thêm vào nhóm', 'Thêm UID vào nhóm Zalo'],
            ['🚫 Xóa khỏi nhóm', 'Kick thành viên ra khỏi nhóm'],
            ['🔇 Tắt thông báo', 'Mute/unmute một hội thoại'],
            ['↩️ Chuyển tiếp tin', 'Forward tin nhắn sang hội thoại khác'],
            ['↩ Thu hồi tin nhắn', 'Undo/unsend tin vừa gửi'],
            ['📊 Tạo bình chọn', 'Tạo poll trong nhóm Zalo'],
            ['📜 Lấy lịch sử chat', 'Đọc N tin nhắn gần nhất'],
            ['😀 Thêm cảm xúc', 'React emoji vào tin nhắn'],
          ].map(([action, desc], i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg px-2.5 py-1.5">
              <p className="text-gray-200 text-[11px] font-medium">{action}</p>
              <p className="text-gray-500 text-[11px]">{desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>🟡 Logic — Điều kiện & Điều khiển luồng</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">IF điều kiện</strong> — rẽ nhánh True/False dựa trên giá trị biến, nội dung tin nhắn',
          '<strong class="text-gray-200">Switch nhiều nhánh</strong> — xử lý nhiều case khác nhau trong một node',
          '<strong class="text-gray-200">Chờ N giây (Delay)</strong> — dừng workflow trong khoảng thời gian cấu hình',
          '<strong class="text-gray-200">Lưu biến</strong> — lưu dữ liệu vào biến để dùng ở các bước sau',
          '<strong class="text-gray-200">Dừng nếu (Stop If)</strong> — kết thúc workflow khi thỏa điều kiện nhất định',
          '<strong class="text-gray-200">Vòng lặp forEach</strong> — lặp qua danh sách và xử lý từng phần tử',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🟢 Tích hợp Google Sheets</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Ghi thêm dòng</strong> — Append dữ liệu mới vào cuối sheet (lưu lead, đơn hàng...)',
          '<strong class="text-gray-200">Đọc dữ liệu</strong> — Đọc giá trị các ô để dùng làm điều kiện hoặc nội dung tin',
          '<strong class="text-gray-200">Cập nhật ô</strong> — Ghi đè giá trị vào ô cụ thể trong sheet',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🟣 AI</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Tạo nội dung AI</strong> — Sinh câu trả lời, tóm tắt, viết lại nội dung bằng GPT với prompt tùy chỉnh',
          '<strong class="text-gray-200">Phân loại văn bản</strong> — Phân tích ý định hoặc cảm xúc của tin nhắn (mua hàng / hỏi giá / khiếu nại...)',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🟠 Thông báo & Tích hợp ngoài</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Gửi Telegram Bot</strong> — Nhận cảnh báo hoặc báo cáo ngay trên Telegram',
          '<strong class="text-gray-200">Gửi Discord</strong> — Đẩy thông báo vào kênh Discord của nhóm',
          '<strong class="text-gray-200">Gửi Email (SMTP)</strong> — Gửi email tự động qua tài khoản SMTP cấu hình sẵn',
          '<strong class="text-gray-200">Ghi vào Notion DB</strong> — Tạo record mới trong Notion Database',
          '<strong class="text-gray-200">HTTP Request</strong> — Gọi bất kỳ API ngoài (webhook, REST API, n8n...)',
        ]} />
      </Card>

      <Card>
        <SectionTitle>⚠️ Lưu ý khi dùng Workflow</SectionTitle>
        <BulletList items={[
          'Workflow chạy hoàn toàn cục bộ — app phải đang chạy thì workflow mới hoạt động',
          'Dùng node <strong class="text-gray-200">Chờ N giây</strong> giữa các tin nhắn để tránh Zalo rate-limit',
          'Tab <strong class="text-gray-200">Lịch sử chạy</strong> ghi lại toàn bộ log thực thi để debug dễ dàng',
          'Có thể test workflow bằng Trigger thủ công trước khi bật chính thức',
        ]} />
      </Card>
    </div>
  );
}

function IntegrationPOSPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>🛒 Tích hợp POS / Bán hàng</SectionTitle>
        <Paragraph>
          Kết nối Deplao với phần mềm quản lý bán hàng (POS) cho phép tra cứu đơn hàng, khách hàng, sản phẩm
          ngay trong khung chat Zalo — không cần chuyển qua lại giữa các ứng dụng.
          Bạn cũng có thể tạo đơn hàng trực tiếp từ hội thoại hoặc tự động hoá qua Workflow.
        </Paragraph>
        <div className="flex items-center gap-3 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-2">
          <span className="text-blue-400 text-sm flex-shrink-0">💡</span>
          <p className="text-blue-300 text-xs font-medium">Sau khi kết nối, các nút tra cứu nhanh sẽ xuất hiện trong Quick Panel bên phải khung chat.</p>
        </div>
      </Card>

      <Card>
        <SectionTitle>📋 Các nền tảng POS hỗ trợ</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: '🛒', name: 'KiotViet', desc: 'Tra cứu đơn hàng, khách hàng, sản phẩm. Tạo đơn hàng từ chat hoặc workflow.', setup: 'Cần Client ID, Client Secret, Retailer Name từ KiotViet Admin.' },
            { icon: '🏪', name: 'Haravan', desc: 'Quản lý đơn hàng, kho, khách hàng TMĐT. Tra cứu theo SĐT ngay trong chat.', setup: 'Dùng API Token từ Haravan Custom App hoặc API Key legacy.' },
            { icon: '🟢', name: 'Sapo', desc: 'Bán hàng đa kênh. Tra cứu đơn, khách hàng, sản phẩm Sapo.', setup: 'Cần API Key + Secret Key + Store Domain từ Sapo.' },
            { icon: '⚡', name: 'Nhanh.vn', desc: 'Quản lý đơn hàng, kho, khách hàng đa kênh.', setup: 'Cần App ID, Business ID, Access Token v3.' },
            { icon: '🥞', name: 'Pancake POS', desc: 'Quản lý đơn hàng, tra cứu và tạo đơn trong chat.', setup: 'Cần API Key và Shop ID từ Pancake.' },
          ].map((p, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg p-2.5">
              <p className="text-gray-200 text-[11px] font-medium">{p.icon} {p.name}</p>
              <p className="text-gray-500 text-[11px] mt-0.5 leading-relaxed">{p.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>🔧 Hướng dẫn kết nối POS</SectionTitle>
        <StepList steps={[
          { title: 'Mở Công cụ → Tích hợp', desc: 'Vào sidebar chọn <strong class="text-gray-200">Công cụ → Tích hợp</strong>, chọn tab <strong class="text-gray-200">POS / Bán hàng</strong>.' },
          { title: 'Chọn nền tảng POS', desc: 'Nhấn vào nền tảng bạn đang dùng (KiotViet, Haravan, Sapo...).' },
          { title: 'Nhập thông tin xác thực', desc: 'Điền API Key, Token hoặc các thông tin được yêu cầu. Có thể lấy từ trang quản trị của nền tảng đó.' },
          { title: 'Test kết nối', desc: 'Nhấn <strong class="text-gray-200">"Test kết nối"</strong> để kiểm tra thông tin có hợp lệ không.' },
          { title: 'Bật tích hợp', desc: 'Bật trạng thái tích hợp. Ngay lập tức có thể dùng trong chat hoặc Workflow.' },
        ]} />
      </Card>

      <Card>
        <SectionTitle>⚡ Tính năng sau khi kết nối POS</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: '🔍', name: 'Tra cứu đơn hàng', desc: 'Nhập mã đơn hoặc SĐT khách → thông tin đơn hàng hiện ra ngay trong chat.' },
            { icon: '👤', name: 'Tra cứu khách hàng', desc: 'Xem lịch sử mua hàng, tổng chi tiêu, công nợ của khách.' },
            { icon: '📦', name: 'Tra cứu sản phẩm', desc: 'Tìm sản phẩm theo tên/mã — hiển thị giá, tồn kho, hình ảnh.' },
            { icon: '➕', name: 'Tạo đơn hàng', desc: 'Tạo đơn hàng mới cho khách ngay trong hội thoại Zalo.' },
            { icon: '⚙️', name: 'Tích hợp Workflow', desc: 'Workflow tự động tra cứu thông tin khi nhận tin nhắn từ khách.' },
            { icon: '📊', name: 'Đồng bộ dữ liệu', desc: 'Dữ liệu đơn hàng, khách hàng đồng bộ realtime từ POS.' },
          ].map((f, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg p-2.5">
              <p className="text-gray-200 text-[11px] font-medium">{f.icon} {f.name}</p>
              <p className="text-gray-500 text-[11px] mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>🔁 Ví dụ: Workflow với POS</SectionTitle>
        <div className="bg-gray-900/60 rounded-lg border border-gray-700/50 p-3 space-y-1.5">
          <p className="text-gray-200 text-[11px] font-semibold">📌 Khi khách nhắn "Kiểm tra đơn hàng"</p>
          <BulletList items={[
            '<strong class="text-gray-200">Trigger:</strong> Tin nhắn mới chứa từ khóa "đơn hàng"',
            '<strong class="text-gray-200">Action 1:</strong> Tra cứu đơn hàng POS theo SĐT khách',
            '<strong class="text-gray-200">Action 2:</strong> Gửi tin nhắn kết quả (mã đơn, trạng thái, ngày giao)',
            '<strong class="text-gray-200">Action 3 (tuỳ chọn):</strong> Ghi log vào Google Sheets',
          ]} />
        </div>
      </Card>

      <Card>
        <SectionTitle>⚠️ Lưu ý</SectionTitle>
        <BulletList items={[
          'API Key và credential cần lấy từ trang quản trị của nền tảng POS tương ứng',
          'Mỗi nền tảng có giới hạn rate-limit riêng — không gọi API quá nhiều lần trong thời gian ngắn',
          'Nếu kết nối thất bại, kiểm tra lại credential và thử "Test kết nối" trước khi bật',
        ]} />
      </Card>
    </div>
  );
}

function IntegrationPaymentPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>💳 Tích hợp Thanh toán — Tự động xác nhận chuyển khoản</SectionTitle>
        <Paragraph>
          Kết nối Deplao với các cổng thanh toán để nhận thông báo ngay khi có giao dịch chuyển khoản vào tài khoản ngân hàng.
          Kết hợp Workflow để tự động xác nhận đơn hàng, gửi tin cảm ơn và kích hoạt các bước chăm sóc tiếp theo —
          không cần ngồi kiểm tra sao kê thủ công.
        </Paragraph>
        <div className="flex items-center gap-3 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-2">
          <span className="text-blue-400 text-sm flex-shrink-0">💡</span>
          <p className="text-blue-300 text-xs font-medium">Kết hợp Tunnel công khai để nhận webhook thanh toán từ bên ngoài mà không cần VPS.</p>
        </div>
      </Card>

      <Card>
        <SectionTitle>📋 Các nền tảng thanh toán hỗ trợ</SectionTitle>
        <div className="space-y-2">
          {[
            { icon: '💳', name: 'Casso', desc: 'Nền tảng tổng hợp giao dịch VietQR hàng đầu. Nhận webhook realtime khi có chuyển khoản vào bất kỳ ngân hàng nào.', setup: 'Casso API Key (lấy từ Casso Dashboard). Webhook Secret (tuỳ chọn).' },
            { icon: '💰', name: 'SePay', desc: 'Giải pháp webhook thanh toán. Tự động phát hiện giao dịch chuyển khoản và gửi thông báo.', setup: 'SePay API Key + Webhook Secret Key.' },
          ].map((p, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg p-3">
              <div className="flex items-start gap-3">
                <span className="text-lg flex-shrink-0">{p.icon}</span>
                <div>
                  <p className="text-gray-200 text-[11px] font-medium">{p.name}</p>
                  <p className="text-gray-500 text-[11px] mt-0.5 leading-relaxed">{p.desc}</p>
                  <div className="bg-gray-800/60 rounded px-2 py-1 mt-1.5">
                    <p className="text-gray-400 text-[10px]">
                      <strong className="text-gray-300">Cấu hình:</strong> {p.setup}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>🔧 Hướng dẫn kết nối thanh toán</SectionTitle>
        <StepList steps={[
          { title: 'Lấy API Key từ nền tảng', desc: 'Vào Casso Dashboard hoặc SePay Dashboard → Tạo API Key mới. Copy key vào clipboard.' },
          { title: 'Mở Công cụ → Tích hợp', desc: 'Chọn tab <strong class="text-gray-200">Thanh toán</strong> → Nhấn vào Casso hoặc SePay.' },
          { title: 'Dán API Key', desc: 'Dán API Key vào trường tương ứng. Nhấn <strong class="text-gray-200">"Lưu"</strong>.' },
          { title: '(Quan trọng) Bật Tunnel', desc: 'Webhook cần URL công khai. Trong màn hình tích hợp, nhấn <strong class="text-gray-200">"Mở Tunnel"</strong> để tạo URL dạng https://xxx.trycloudflare.com.' },
          { title: 'Cấu hình Webhook', desc: 'Copy URL tunnel + path webhook (VD: https://xxx.trycloudflare.com/webhook/casso) → dán vào Casso/SePay Webhook URL.' },
          { title: 'Test thử', desc: 'Chuyển khoản 1.000đ vào tài khoản để kiểm tra. Nếu thấy thông báo trong app → thành công.' },
        ]} />
      </Card>

      <Card>
        <SectionTitle>🔁 Ví dụ: Workflow với thanh toán</SectionTitle>
        <div className="bg-gray-900/60 rounded-lg border border-gray-700/50 p-3 space-y-1.5">
          <p className="text-gray-200 text-[11px] font-semibold">📌 Khi nhận được chuyển khoản</p>
          <BulletList items={[
            '<strong class="text-gray-200">Trigger:</strong> Webhook thanh toán (Casso/SePay)',
            '<strong class="text-gray-200">Action 1:</strong> Tra cứu đơn hàng POS theo nội dung chuyển khoản',
            '<strong class="text-gray-200">Action 2:</strong> Cập nhật trạng thái đơn → "Đã thanh toán"',
            '<strong class="text-gray-200">Action 3:</strong> Gửi tin nhắn xác nhận + cảm ơn khách hàng',
            '<strong class="text-gray-200">Action 4:</strong> Tạo đơn vận chuyển (GHN/GHTK) nếu khách yêu cầu giao hàng',
          ]} />
        </div>
      </Card>

      <Card>
        <SectionTitle>🌐 Tunnel là gì và tại sao cần?</SectionTitle>
        <Paragraph>
          Deplao chạy webhook server trên máy tính cá nhân (cục bộ). Để Casso/SePay có thể gửi webhook đến máy bạn,
          máy cần có một địa chỉ công khai trên Internet. Tunnel (Cloudflare Quick Tunnel) tạo một URL công khai
          tạm thời trỏ về máy bạn — <strong className="text-white font-semibold">không cần VPS, không cần cấu hình router</strong>.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-gray-200">URL mẫu:</strong> https://random-name.trycloudflare.com',
          '<strong class="text-gray-200">Lưu ý:</strong> URL thay đổi mỗi lần bật lại Tunnel — cần cập nhật trong Casso/SePay',
          '<strong class="text-gray-200">Bảo mật:</strong> Chỉ dùng cho webhook, không ảnh hưởng đến dữ liệu khác',
        ]} />
      </Card>

      <Card>
        <SectionTitle>⚠️ Lưu ý</SectionTitle>
        <BulletList items={[
          'App phải đang chạy thì webhook mới hoạt động — tắt app là webhook không nhận được',
          'Mỗi lần khởi động lại app, cần bật lại Tunnel (nếu đã tắt trước đó)',
          'Nếu không nhận được webhook, kiểm tra: Tunnel đã bật chưa, URL đã cấu hình đúng chưa',
          'Dùng riêng mỗi nền tảng một webhook path riêng (VD: /webhook/casso, /webhook/sepay)',
        ]} />
      </Card>
    </div>
  );
}

function IntegrationShippingPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>📦 Tích hợp Vận chuyển — Tạo & Tra cứu vận đơn tự động</SectionTitle>
        <Paragraph>
          Kết nối Deplao với các đơn vị vận chuyển để tạo đơn giao hàng, tra cứu trạng thái vận đơn
          ngay trong hội thoại Zalo. Khi khách hỏi "đơn hàng tới đâu rồi?", Workflow tự động tra cứu và trả lời —
          không cần copy tracking ID qua các tab trình duyệt.
        </Paragraph>
        <div className="flex items-center gap-3 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-2">
          <span className="text-blue-400 text-sm flex-shrink-0">💡</span>
          <p className="text-blue-300 text-xs font-medium">Tích hợp vận chuyển hoạt động tốt nhất khi kết hợp với POS để tự động tạo đơn giao sau khi xác nhận thanh toán.</p>
        </div>
      </Card>

      <Card>
        <SectionTitle>📋 Các đơn vị vận chuyển hỗ trợ</SectionTitle>
        <div className="space-y-2">
          {[
            { icon: '📦', name: 'GHN Express', desc: 'Giao Hàng Nhanh — tạo đơn, tra cứu vận đơn, tính phí giao hàng.', token: 'Token GHN + Shop ID', note: 'Hỗ trợ Sandbox để test thử trước khi dùng thật.' },
            { icon: '🚚', name: 'GHTK', desc: 'Giao Hàng Tiết Kiệm — tạo đơn, tra cứu trạng thái giao hàng.', token: 'GHTK API Token', note: 'Phù hợp đơn hàng giá trị thấp, giao hàng tiết kiệm.' },
          ].map((p, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg p-3">
              <div className="flex items-start gap-3">
                <span className="text-lg flex-shrink-0">{p.icon}</span>
                <div>
                  <p className="text-gray-200 text-[11px] font-medium">{p.name}</p>
                  <p className="text-gray-500 text-[11px] mt-0.5 leading-relaxed">{p.desc}</p>
                  <div className="flex gap-2 mt-1.5 flex-wrap">
                    <span className="bg-gray-800/60 text-gray-400 text-[10px] px-2 py-0.5 rounded">{p.token}</span>
                    <span className="bg-blue-900/30 text-blue-400 text-[10px] px-2 py-0.5 rounded">💡 {p.note}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>🔧 Hướng dẫn kết nối vận chuyển</SectionTitle>
        <StepList steps={[
          { title: 'Lấy Token từ đơn vị vận chuyển', desc: 'Đăng nhập GHN/GHTK → Quản lý API → Tạo Token mới. Copy Token + Shop ID.' },
          { title: 'Mở Công cụ → Tích hợp', desc: 'Chọn tab <strong class="text-gray-200">Vận chuyển</strong> → Nhấn GHN hoặc GHTK.' },
          { title: 'Nhập Token và cấu hình', desc: 'Dán Token và Shop ID vào các trường. Với GHN, chọn môi trường Production hoặc Sandbox.' },
          { title: 'Test kết nối', desc: 'Nhấn "Test" — nếu thành công, hệ thống sẽ trả về thông tin shop của bạn.' },
          { title: 'Bật tích hợp', desc: 'Bật trạng thái → đã sẵn sàng tạo đơn và tra cứu từ chat và Workflow.' },
        ]} />
      </Card>

      <Card>
        <SectionTitle>⚡ Tính năng sau khi kết nối</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: '📋', name: 'Tạo vận đơn', desc: 'Nhập thông tin giao hàng → tạo đơn ngay trong chat.' },
            { icon: '🔍', name: 'Tra cứu vận đơn', desc: 'Nhập mã vận đơn → xem trạng thái, lịch trình giao hàng.' },
            { icon: '💰', name: 'Tính phí giao hàng', desc: 'Tính trước phí vận chuyển dựa trên địa chỉ, trọng lượng.' },
            { icon: '🔁', name: 'Workflow tự động', desc: 'Tự động tạo đơn vận chuyển sau khi xác nhận thanh toán.' },
          ].map((f, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg p-2.5">
              <p className="text-gray-200 text-[11px] font-medium">{f.icon} {f.name}</p>
              <p className="text-gray-500 text-[11px] mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>🔁 Ví dụ: Workflow vận chuyển</SectionTitle>
        <div className="bg-gray-900/60 rounded-lg border border-gray-700/50 p-3 space-y-1.5">
          <p className="text-gray-200 text-[11px] font-semibold">📌 Khi khách hỏi "Đơn hàng tới đâu rồi?"</p>
          <BulletList items={[
            '<strong class="text-gray-200">Trigger:</strong> Tin nhắn chứa "đơn hàng", "shipping", "giao hàng"',
            '<strong class="text-gray-200">Action 1:</strong> Tra cứu đơn hàng POS theo SĐT khách → lấy mã vận đơn',
            '<strong class="text-gray-200">Action 2:</strong> Tra cứu vận đơn GHN/GHTK theo mã vận đơn',
            '<strong class="text-gray-200">Action 3:</strong> Gửi kết quả: "Đơn hàng đang ở [trạng thái] — dự kiến giao [ngày]"',
          ]} />
        </div>
      </Card>

      <Card>
        <SectionTitle>⚠️ Lưu ý</SectionTitle>
        <BulletList items={[
          'Nên dùng môi trường Sandbox của GHN để test trước khi chuyển sang Production',
          'Token GHN/GHTK có thể hết hạn — cần refresh định kỳ nếu gặp lỗi xác thực',
          'Phí giao hàng là ước tính — phí thực tế có thể thay đổi dựa trên cân nặng/kích thước thực tế',
        ]} />
      </Card>
    </div>
  );
}

function AIAssistantPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>🤖 Trợ lý AI — Tăng tốc chăm sóc khách hàng</SectionTitle>
        <Paragraph>
          Trợ lý AI trong Deplao cho phép bạn tạo nhiều chatbot AI với tính cách, prompt và mục đích khác nhau.
          Mỗi trợ lý có thể được gán cho một hội thoại cụ thể hoặc dùng trong Workflow để tự động trả lời tin nhắn.
        </Paragraph>
        <div className="flex items-center gap-3 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-2">
          <span className="text-blue-400 text-sm flex-shrink-0">✨</span>
          <p className="text-blue-300 text-xs font-medium">Hỗ trợ đa dạng model: GPT, Gemini, Claude, Deepseek,... tuỳ chọn theo nhu cầu và ngân sách.</p>
        </div>
      </Card>

      <Card>
        <SectionTitle>📋 Tính năng Trợ lý AI</SectionTitle>
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: '👤', name: 'Đa trợ lý', desc: 'Tạo nhiều trợ lý với prompt riêng — mỗi trợ lý phục vụ mục đích khác nhau.' },
            { icon: '💬', name: 'Chat trong hội thoại', desc: 'Gán trợ lý vào hội thoại — AI tự động hỗ trợ khi có tin nhắn mới.' },
            { icon: '⚙️', name: 'Workflow node AI', desc: 'Node AI trong Workflow: tạo nội dung, phân loại tin nhắn, tóm tắt hội thoại.' },
            { icon: '📊', name: 'Báo cáo sử dụng', desc: 'Theo dõi token, request, chi phí ước tính theo từng trợ lý.' },
            { icon: '🔌', name: 'Nhiều model', desc: 'GPT, Gemini, Claude, Deepseek, Claude — chọn model phù hợp.' },
            { icon: '📝', name: 'Custom Prompt', desc: 'Viết prompt tùy chỉnh cho từng trợ lý — định hình phong cách trả lời.' },
          ].map((f, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg p-2.5">
              <p className="text-gray-200 text-[11px] font-medium">{f.icon} {f.name}</p>
              <p className="text-gray-500 text-[11px] mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>🔧 Hướng dẫn sử dụng Trợ lý AI</SectionTitle>
        <StepList steps={[
          { title: 'Cấu hình API Key', desc: 'Vào <strong class="text-gray-200">Cài đặt → AI Assistant</strong> — nhập API Key của OpenAI hoặc Gemini.' },
          { title: 'Tạo trợ lý', desc: 'Nhấn <strong class="text-gray-200">"Tạo trợ lý mới"</strong> → đặt tên, viết prompt mô tả tính cách và nhiệm vụ.' },
          { title: 'Chọn model', desc: 'Chọn model AI phù hợp (GPT-4o nhanh & rẻ, GPT-4o-chính xác cho nghiệp vụ phức tạp).' },
          { title: 'Gán vào hội thoại', desc: 'Mở hội thoại Zalo → nhấn icon AI → chọn trợ lý muốn dùng. AI sẽ đề xuất câu trả lời.' },
          { title: 'Dùng trong Workflow', desc: 'Tạo Workflow → thêm node AI → chọn trợ lý + prompt → kết nối với các node khác.' },
        ]} />
      </Card>

      {/* ─── 9Router section ───────────────────────────────────────────────── */}
      <div className="border-t border-gray-700/50 pt-4">
        <div className="flex items-start gap-3 mb-4">
          <span className="text-3xl leading-none">🔄</span>
          <div>
            <h3 className="text-white font-bold text-base">Tích hợp 9Router — Proxy AI giá rẻ & miễn phí</h3>
            <p className="text-gray-400 text-xs mt-0.5 leading-relaxed">
              9Router là dịch vụ proxy API AI cho phép bạn gọi các model GPT, Claude, Gemini với giá rẻ hơn so với gọi trực tiếp
              từ nhà cung cấp - Một số model miễn phí phù hợp với nhu cầu cơ bản. Chạy trên máy local, quản lý API key tập trung, tự động luân chuyển key và giảm chi phí.
            </p>
            <div className="flex gap-1.5 mt-2 flex-wrap">
              <Badge text="Tiết kiệm chi phí" color="bg-green-600/30 text-green-300" />
              <Badge text="Local Proxy" color="bg-blue-600/30 text-blue-300" />
              <Badge text="Đa provider" color="bg-purple-600/30 text-purple-300" />
            </div>
          </div>
        </div>

        <Card>
          <SectionTitle>🎯 Tại sao dùng 9Router với Deplao?</SectionTitle>
          <BulletList items={[
            '<strong class="text-gray-200">Giảm 30-50% chi phí AI</strong> — 9Router tự động chọn provider rẻ nhất cho mỗi request',
            '<strong class="text-gray-200">Quản lý tập trung</strong> — Một API key duy nhất cho tất cả model, quên chuyện key hết hạn hay leak key',
            '<strong class="text-gray-200">Tự động fallback</strong> — Provider A lỗi → tự động chuyển sang provider B, không gián đoạn',
            '<strong class="text-gray-200">Hỗ trợ đa model</strong> — GPT, Claude, Gemini, DeepSeek, Qwen... — tất cả qua một endpoint',
          ]} />
        </Card>

        <Card>
          <SectionTitle>📦 Cài đặt 9Router</SectionTitle>
          <div className="space-y-2 mb-3">
            <div className="bg-gray-900/60 border border-blue-700/40 rounded-lg p-3 space-y-2">
              <p className="text-gray-200 text-xs font-semibold">⚡ Hướng dẫn nhanh — 2 lệnh trong Terminal:</p>
              <div className="bg-gray-900/80 border border-gray-700 rounded-lg p-2.5 font-mono text-xs space-y-1.5">
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-green-900/40 text-green-400 flex items-center justify-center text-[10px] font-bold flex-shrink-0">1</span>
                  <code className="text-green-400">npm install -g 9router</code>
                  <span className="text-gray-500 text-[10px]">← Cài đặt 9Router</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-blue-900/40 text-blue-400 flex items-center justify-center text-[10px] font-bold flex-shrink-0">2</span>
                  <code className="text-blue-400">9router</code>
                  <span className="text-gray-500 text-[10px]">← Chạy 9Router (giữ cửa sổ Terminal mở)</span>
                </div>
              </div>
              <p className="text-gray-500 text-[10px]">
                Sau khi chạy, Dashboard mở tại <strong className="text-gray-400">http://localhost:20128</strong>
              </p>
            </div>
          </div>
          <StepList steps={[
            { title: 'Cài Node.js (nếu chưa có)', desc: 'Tải và cài Node.js phiên bản 18+ từ <strong class="text-gray-200">https://nodejs.org</strong>. Kiểm tra: <code style={{color:"#86efac",background:"#1f2937",padding:"1px 5px",borderRadius:"3px"}}>node -v</code>' },
            { title: 'Cài đặt 9Router', desc: 'Mở Terminal (CMD/PowerShell) và chạy: <code style={{color:"#86efac",background:"#1f2937",padding:"1px 5px",borderRadius:"3px"}}>npm install -g 9router</code>' },
            { title: 'Chạy 9Router', desc: 'Sau khi cài xong, gõ lệnh: <code style={{color:"#86efac",background:"#1f2937",padding:"1px 5px",borderRadius:"3px"}}>9router</code> — giữ Terminal chạy nền.' },
            { title: 'Kết nối Provider', desc: 'Mở Dashboard tại <strong class="text-gray-200">http://localhost:20128</strong> → Settings → Add Provider → nhập API Key (OpenAI, Claude, Gemini...).' },
            { title: 'Dùng trong Deplao', desc: 'Vào <strong class="text-gray-200">Cài đặt → Giới thiệu → Trợ lý AI</strong> hoặc <strong class="text-gray-200">Tích hợp → Trợ lý AI</strong>, chọn nền tảng <strong class="text-gray-200">9Router</strong> và chọn model miễn phí.' },
          ]} />
        </Card>

        <Card>
          <SectionTitle>🖼️ Hướng dẫn chi tiết các bước setup 9Router FREE</SectionTitle>
          <div className="space-y-3">
            {/* Step 1 */}
            <div className="bg-gray-900/40 border border-gray-700/60 rounded-xl p-3.5 flex items-start gap-3.5 hover:border-blue-700/50 transition-colors group">
              <div className="w-9 h-9 rounded-xl bg-blue-900/50 border border-blue-700/40 flex items-center justify-center text-blue-400 font-bold text-sm flex-shrink-0 group-hover:bg-blue-800/50 group-hover:border-blue-600/50 transition-colors">1</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-gray-200 text-xs font-semibold">Mở Terminal</span>
                  <span className="text-[10px] text-gray-400 bg-gray-700/50 px-1.5 py-0.5 rounded-full">CMD / PowerShell</span>
                </div>
                <p className="text-gray-400 text-[11px] leading-relaxed">
                  Nhấn <strong className="text-gray-300">Win + R</strong> → gõ <strong className="text-gray-300">cmd</strong> → Enter.
                  Hoặc chuột phải Start → <strong className="text-gray-300">Terminal</strong>.
                </p>
              </div>
            </div>

            {/* Step 2 */}
            <div className="bg-gray-900/40 border border-gray-700/60 rounded-xl p-3.5 flex items-start gap-3.5 hover:border-blue-700/50 transition-colors group">
              <div className="w-9 h-9 rounded-xl bg-blue-900/50 border border-blue-700/40 flex items-center justify-center text-blue-400 font-bold text-sm flex-shrink-0 group-hover:bg-blue-800/50 group-hover:border-blue-600/50 transition-colors">2</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-gray-200 text-xs font-semibold">Cài đặt 9Router</span>
                  <span className="text-[10px] text-gray-400 bg-gray-700/50 px-1.5 py-0.5 rounded-full">npm</span>
                </div>
                <p className="text-gray-400 text-[11px] leading-relaxed mb-1.5">
                  Copy và paste dòng sau vào Terminal, nhấn <strong className="text-gray-300">Enter</strong>:
                </p>
                <div className="bg-gray-900/80 rounded-lg px-3 py-2 border border-gray-700/60">
                  <code className="text-green-400 text-xs font-mono select-all">npm install -g 9router</code>
                </div>
                <p className="text-gray-500 text-[10px] mt-1">Đợi ~10-30s cho đến khi thấy dòng <code className="text-gray-400">added X packages</code></p>
              </div>
            </div>

            {/* Step 3 */}
            <div className="bg-gray-900/40 border border-gray-700/60 rounded-xl p-3.5 flex items-start gap-3.5 hover:border-blue-700/50 transition-colors group">
              <div className="w-9 h-9 rounded-xl bg-blue-900/50 border border-blue-700/40 flex items-center justify-center text-blue-400 font-bold text-sm flex-shrink-0 group-hover:bg-blue-800/50 group-hover:border-blue-600/50 transition-colors">3</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-gray-200 text-xs font-semibold">Chạy 9Router</span>
                  <span className="text-[10px] text-gray-400 bg-gray-700/50 px-1.5 py-0.5 rounded-full">startup</span>
                </div>
                <p className="text-gray-400 text-[11px] leading-relaxed mb-1.5">
                  Gõ lệnh sau và nhấn <strong className="text-gray-300">Enter</strong>:
                </p>
                <div className="bg-gray-900/80 rounded-lg px-3 py-2 border border-gray-700/60">
                  <code className="text-blue-400 text-xs font-mono select-all">9router</code>
                </div>
                <p className="text-gray-500 text-[10px] mt-1">
                  ⏳ Lần đầu chạy có thể hơi lâu — đợi đến khi thấy <strong className="text-gray-400">Dashboard ready at http://localhost:20128</strong>
                </p>
              </div>
            </div>

            {/* Step 4 */}
            <div className="bg-gray-900/40 border border-gray-700/60 rounded-xl p-3.5 flex items-start gap-3.5 hover:border-blue-700/50 transition-colors group">
              <div className="w-9 h-9 rounded-xl bg-blue-900/50 border border-blue-700/40 flex items-center justify-center text-blue-400 font-bold text-sm flex-shrink-0 group-hover:bg-blue-800/50 group-hover:border-blue-600/50 transition-colors">4</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1">
                  <span className="text-gray-200 text-xs font-semibold">Cấu hình trong Deplao</span>
                  <span className="text-[10px] text-green-400 bg-green-900/30 px-1.5 py-0.5 rounded-full">done ✅</span>
                </div>
                <p className="text-gray-400 text-[11px] leading-relaxed">
                  Vào <strong className="text-gray-300">Cài đặt → Giới thiệu → Trợ lý AI</strong> (hoặc <strong className="text-gray-300">Tích hợp → Trợ lý AI</strong>), tạo trợ lý mới,
                  chọn nền tảng <strong className="text-blue-400">9Router</strong>, chọn model FREE như <strong className="text-gray-300">kr/claude-sonnet-4.5</strong> hoặc <strong className="text-gray-300">oc/deepseek-v4-flash-free</strong>,
                  API Key nhập bất kỳ → Lưu → Test. 🎉
                </p>
              </div>
            </div>
          </div>

          {/* Issue #31 reference */}
          <div className="mt-3 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3.5 py-2.5">
            <div className="flex items-start gap-2.5">
              <span className="text-blue-400 text-sm flex-shrink-0 mt-0.5">💡</span>
              <div>
                <p className="text-blue-300 text-[11px] font-semibold">Model tự động đồng bộ từ 9Router</p>
                <p className="text-gray-400 text-[10px] leading-relaxed mt-0.5">
                  Sau khi kết nối thành công, danh sách model trong Deplao sẽ tự động cập nhật theo các provider bạn đã thêm vào 9Router.
                  Nếu có model mới xuất hiện trong Dashboard 9Router, bạn chỉ cần reload trang Deplao để thấy — không cần cấu hình thêm.{' '}
                  <button
                    onClick={() => ipc.shell?.openExternal('https://github.com/babyvibe/deplao-builder/issues/31')}
                    className="text-blue-400 hover:text-blue-300 underline underline-offset-2 inline-flex items-center gap-0.5"
                  >
                    Theo dõi issue #31 →
                  </button>
                </p>
              </div>
            </div>
          </div>
        </Card>

        <Card>
          <SectionTitle>🔧 Cấu hình trong Deplao</SectionTitle>
          <Paragraph>
            Sau khi đã cài đặt và chạy 9Router, cấu hình Deplao để sử dụng 9Router làm proxy AI:
          </Paragraph>
          <div className="mt-2 space-y-2">
            <div className="bg-gray-800/60 border border-gray-700/50 rounded-lg p-3">
              <p className="text-gray-200 text-[11px] font-semibold mb-1.5">Cách 1: Dùng Platform 9Router</p>
              <BulletList items={[
                'Vào <strong class="text-gray-200">Cài đặt → AI Assistant</strong>',
                'Mục <strong class="text-gray-200">"Nền tảng AI"</strong> → chọn <strong class="text-gray-200">9Router</strong>',
                'API Base URL tự động điền: <strong class="text-gray-200">http://localhost:20128/v1</strong>',
                'API Key: nhập bất kỳ giá trị gì (9Router không yêu cầu key xác thực cục bộ)',
              ]} />
            </div>
            <div className="bg-gray-800/60 border border-gray-700/50 rounded-lg p-3">
              <p className="text-gray-200 text-[11px] font-semibold mb-1.5">Cách 2: Dùng Custom Base URL</p>
              <BulletList items={[
                'Vào <strong class="text-gray-200">Cài đặt → AI Assistant</strong>',
                'Chọn <strong class="text-gray-200">"OpenAI Compatible"</strong>',
                'Nhập Base URL: <strong class="text-gray-200">http://localhost:20128/v1</strong>',
                'API Key: nhập bất kỳ (VD: "9router-key")',
                'Model: nhập tên model bạn muốn dùng (VD: gpt-4o-mini, claude-3-haiku)',
              ]} />
            </div>
          </div>
        </Card>

        <Card>
          <SectionTitle>📋 Danh sách model 9Router thường dùng</SectionTitle>
          <div className="grid grid-cols-2 gap-2">
            {[
              { icon: '🟢', name: 'gpt-4o-mini', cost: 'Rẻ nhất', note: 'Chat cơ bản, CSKH' },
              { icon: '🟡', name: 'gpt-4o', cost: 'Trung bình', note: 'Tư vấn bán hàng' },
              { icon: '🟣', name: 'gpt-4o-chatgptselect', cost: 'Rẻ', note: 'Từ ChatGPT Plus' },
              { icon: '🔴', name: 'claude-3-haiku', cost: 'Rẻ', note: 'Phân tích nhanh' },
              { icon: '🔵', name: 'claude-3.5-sonnet', cost: 'Cao', note: 'Nghiệp vụ phức tạp' },
              { icon: '🟤', name: 'gemini-2.0-flash', cost: 'Rất rẻ', note: 'Đa phương tiện' },
              { icon: '⚪', name: 'deepseek-chat', cost: 'Rất rẻ', note: 'Code, logic' },
              { icon: '🟠', name: 'qwen2.5-72b', cost: 'Rẻ', note: 'Tiếng Trung, đa năng' },
            ].map((m, i) => (
              <div key={i} className="bg-gray-700/30 rounded-lg p-2.5">
                <div className="flex items-center justify-between">
                  <p className="text-gray-200 text-[11px] font-medium font-mono">{m.icon} {m.name}</p>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${
                    m.cost === 'Rất rẻ' || m.cost === 'Rẻ nhất' ? 'bg-green-900/40 text-green-400' :
                    m.cost === 'Cao' ? 'bg-red-900/40 text-red-400' : 'bg-yellow-900/40 text-yellow-400'
                  }`}>{m.cost}</span>
                </div>
                <p className="text-gray-500 text-[10px] mt-0.5">{m.note}</p>
              </div>
            ))}
          </div>
        </Card>

        <Card>
          <SectionTitle>💡 Mẹo & Lưu ý</SectionTitle>
          <BulletList items={[
            '<strong class="text-gray-200">9Router phải chạy cùng lúc với Deplao</strong> — nếu tắt 9Router, AI request qua 9Router sẽ thất bại',
            '<strong class="text-gray-200">Dashboard 9Router</strong> mở tại <strong class="text-gray-200">http://localhost:20128</strong> — theo dõi request, chi phí, provider health',
            '<strong class="text-gray-200">Tự động chạy cùng Windows:</strong> Thêm 9Router vào startup (Task Scheduler) để không phải chạy thủ công mỗi lần',
            '<strong class="text-gray-200">Nạp key nhiều provider:</strong> Càng nhiều provider, 9Router càng tối ưu được giá và fallback khi có lỗi',
            '<strong class="text-gray-200">Kiểm tra kết nối:</strong> Sau khi cấu hình, dùng thử AI Assistant trong Deplao để xác nhận hoạt động',
          ]} />
        </Card>

        <div className="flex justify-center gap-2 mt-4">
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('nav:settings', { detail: { tab: 'introduction', subtab: 'ai-assistant' } }));
            }}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
          >
            Cấu hình AI Assistant →
          </button>
          <button
            onClick={() => ipc.shell?.openExternal('http://localhost:20128')}
            className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs font-medium rounded-lg transition-colors"
          >
            Mở Dashboard 9Router
          </button>
        </div>
      </div>
    </div>
  );
}

function AnalyticsPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>📈 Báo cáo & Phân tích — Nắm bắt toàn diện hoạt động</SectionTitle>
        <Paragraph>
          Trang Báo cáo tổng hợp mọi dữ liệu hoạt động trên Zalo thành biểu đồ trực quan,
          giúp bạn đánh giá hiệu quả kinh doanh, chăm sóc khách hàng và Tự động hoá.
        </Paragraph>
        <div className="flex items-center gap-3 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-2">
          <span className="text-blue-400 text-sm flex-shrink-0">📊</span>
          <p className="text-blue-300 text-xs font-medium">Truy cập: Sidebar → Báo cáo — hoặc nhấn icon biểu đồ trên thanh điều hướng.</p>
        </div>
      </Card>

      <Card>
        <SectionTitle>🎛️ Bộ lọc dữ liệu linh hoạt</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Chọn tài khoản:</strong> Xem báo cáo cho từng tài khoản Zalo riêng lẻ hoặc tất cả cùng lúc',
          '<strong class="text-gray-200">Khoảng thời gian:</strong> Hôm nay · Hôm qua · 7 ngày · 30 ngày · 90 ngày · Tuỳ chọn ngày bắt đầu — kết thúc',
          '<strong class="text-gray-200">Loại liên hệ:</strong> Tất cả · Cá nhân · Nhóm — lọc riêng để phân tích từng nhóm đối tượng',
        ]} />
      </Card>

      <Card>
        <SectionTitle>📊 Tab Tổng quan</SectionTitle>
        <Paragraph>
          Bảng KPI tổng hợp — nhìn nhanh mọi chỉ số quan trọng trong một màn hình.
        </Paragraph>
        <div className="grid grid-cols-2 gap-2 mt-1">
          {[
            { icon: '💬', kpi: 'Tin nhắn hôm nay', desc: 'Gửi & nhận, so sánh hôm qua' },
            { icon: '📨', kpi: 'Tổng tin nhắn', desc: 'Toàn kỳ, chia gửi/nhận' },
            { icon: '👥', kpi: 'Liên hệ & Nhóm', desc: 'Tổng bạn bè, nhóm Zalo' },
            { icon: '📢', kpi: 'Chiến dịch', desc: 'Tổng & đang chạy' },
            { icon: '🤝', kpi: 'Lời mời kết bạn', desc: 'Gửi & nhận trong kỳ' },
            { icon: '⚡', kpi: 'Workflow', desc: 'Số lần chạy & tỉ lệ thành công' },
            { icon: '🤖', kpi: 'AI request', desc: 'Số request & token tiêu thụ' },
          ].map((k, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg px-2.5 py-2">
              <p className="text-gray-200 text-[11px] font-medium">{k.icon} {k.kpi}</p>
              <p className="text-gray-500 text-[11px] mt-0.5">{k.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>💬 Tab Tin nhắn</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Biểu đồ lượng tin nhắn:</strong> Area chart gửi/nhận theo ngày — nhận diện xu hướng tăng/giảm',
          '<strong class="text-gray-200">Heatmap giờ cao điểm:</strong> Ma trận Thứ × Giờ — tìm khung giờ khách hàng tương tác nhiều nhất',
          '<strong class="text-gray-200">Thời gian phản hồi:</strong> Trung bình, trung vị, min/max — đánh giá tốc độ chăm sóc khách hàng',
          '<strong class="text-gray-200">Phân bố thời gian phản hồi:</strong> Biểu đồ cột theo khoảng (< 1 phút, 1–5 phút, 5–15 phút...)',
        ]} />
      </Card>

      <Card>
        <SectionTitle>👥 Tab Liên hệ</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Phân khúc liên hệ:</strong> Biểu đồ tròn phân loại theo bạn bè / nhóm / người lạ',
          '<strong class="text-gray-200">Phân bố nhãn:</strong> Pie chart phân bổ liên hệ theo từng nhãn Zalo',
          '<strong class="text-gray-200">Tăng trưởng liên hệ:</strong> Biểu đồ cột liên hệ mới & bạn bè mới theo thời gian',
          '<strong class="text-gray-200">Lời mời kết bạn:</strong> Timeline gửi/nhận friend request qua các ngày',
          '<strong class="text-gray-200">Tỉ lệ gán nhãn:</strong> Có nhãn vs. chưa gán nhãn, có ghi chú vs. chưa có',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🏷️ Tab Nhãn</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Timeline gán nhãn:</strong> Biểu đồ số lần gán nhãn theo ngày — theo dõi hoạt động phân loại',
          '<strong class="text-gray-200">Top nhãn được dùng:</strong> Bảng xếp hạng nhãn theo số lần sử dụng kèm emoji & màu sắc',
          '<strong class="text-gray-200">Gán nhãn gần đây:</strong> Danh sách nhãn vừa gán kèm hội thoại và thời gian',
        ]} />
      </Card>

      <Card>
        <SectionTitle>📢 Tab Chiến dịch</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Danh sách chiến dịch:</strong> Tên, loại, trạng thái (Chạy / Dừng / Xong / Nháp), tiến độ',
          '<strong class="text-gray-200">Chỉ số hiệu quả:</strong> Tổng gửi · Thành công · Thất bại · Đã phản hồi — tỷ lệ delivery & reply',
          '<strong class="text-gray-200">So sánh chiến dịch:</strong> Biểu đồ cột so sánh hiệu quả giữa các chiến dịch',
        ]} />
      </Card>

      <Card>
        <SectionTitle>⚡ Tab Workflow</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Tổng số lần chạy:</strong> Thành công / Lỗi / Tỷ lệ thành công — đánh giá độ ổn định',
          '<strong class="text-gray-200">Thời gian trung bình:</strong> Thời gian thực thi trung bình mỗi lần chạy',
          '<strong class="text-gray-200">Top Workflow:</strong> Bảng xếp hạng workflow chạy nhiều nhất kèm tỷ lệ thành công',
          '<strong class="text-gray-200">Timeline:</strong> Biểu đồ thành công/lỗi theo ngày — phát hiện sự cố nhanh',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🤖 Tab AI</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Tổng request & token:</strong> Prompt tokens, completion tokens — ước tính chi phí sử dụng',
          '<strong class="text-gray-200">Phân bổ theo model:</strong> Pie chart — GPT, Gemini, Claude, Deepseek... đang dùng bao nhiêu',
          '<strong class="text-gray-200">Phân bổ theo trợ lý:</strong> Xem trợ lý nào tiêu thụ nhiều token nhất',
          '<strong class="text-gray-200">Timeline:</strong> Biểu đồ request & token theo ngày — theo dõi xu hướng sử dụng AI',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🧑‍💼 Tab Nhân viên</SectionTitle>
        <Paragraph>
          Tab dành riêng cho Boss — theo dõi hiệu suất và hoạt động của từng nhân viên theo khoảng thời gian tùy chọn.
          Yêu cầu đã có ít nhất 1 nhân viên đã kết nối Relay Server.
        </Paragraph>
        <div className="grid grid-cols-2 gap-2 mt-1">
          {[
            { icon: '💬', kpi: 'Tổng tin nhắn gửi', desc: 'Số tin nhắn thực tế mỗi nhân viên đã gửi' },
            { icon: '🕐', kpi: 'Giờ online', desc: 'Tổng thời gian kết nối relay trong kỳ' },
            { icon: '⚡', kpi: 'Thời gian phản hồi', desc: 'Trung bình từ lúc nhận đến khi trả lời' },
            { icon: '🗣️', kpi: 'Hội thoại xử lý', desc: 'Số thread khác nhau đã nhắn tin' },
          ].map((k, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg px-2.5 py-2">
              <p className="text-gray-200 text-[11px] font-medium">{k.icon} {k.kpi}</p>
              <p className="text-gray-500 text-[11px] mt-0.5">{k.desc}</p>
            </div>
          ))}
        </div>
        <BulletList items={[
          '<strong class="text-gray-200">Bộ lọc đa nhân viên:</strong> Chọn 1 hoặc nhiều nhân viên để so sánh song song — hiển thị ảnh đại diện + tên + vai trò trong dropdown.',
          '<strong class="text-gray-200">Timeline tin nhắn:</strong> Biểu đồ area theo ngày, mỗi nhân viên một màu riêng để dễ phân biệt.',
          '<strong class="text-gray-200">Timeline giờ online:</strong> Biểu đồ thời gian kết nối relay theo ngày — phát hiện ai đăng nhập không đủ giờ.',
          '<strong class="text-gray-200">Phân bổ giờ hoạt động:</strong> Biểu đồ cột theo khung giờ trong ngày — nhân viên tập trung làm việc giờ nào.',
          '<strong class="text-gray-200">Phân bổ thời gian phản hồi:</strong> Histogram theo nhóm (&lt; 1 phút, 1–5 phút, 5–15 phút...) cho từng nhân viên.',
          '<strong class="text-gray-200">Biểu đồ radar:</strong> So sánh đa chiều (tin nhắn, giờ online, hội thoại, tốc độ phản hồi) giữa các nhân viên trong cùng kỳ.',
          '<strong class="text-gray-200">Bảng xếp hạng:</strong> Danh sách nhân viên sắp xếp theo tin nhắn hoặc giờ online — kèm badge màu sắc và avatar.',
        ]} />
        <div className="mt-2 bg-blue-900/20 border border-blue-700/30 rounded-lg px-3 py-2">
          <p className="text-blue-300 text-[11px]">
            💡 Dữ liệu được tính theo phiên kết nối relay thực tế — kể cả phiên kéo dài qua nhiều ngày đều được tính chính xác.
          </p>
        </div>
      </Card>
    </div>
  );
}

function DashboardPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>📊 Dashboard — Quản lý tài khoản</SectionTitle>
        <Paragraph>
          Dashboard là trang chủ khi mở app, hiển thị trạng thái tất cả tài khoản Zalo
          và các thao tác quản lý nhanh: kết nối, ngắt kết nối, gộp trang và quản trị tài khoản.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-gray-200">Thẻ tài khoản:</strong> Mỗi tài khoản hiển thị avatar, tên, trạng thái Online/Offline, listener sống/chết',
          '<strong class="text-gray-200">Kết nối lại:</strong> Nhấn nút kết nối trên thẻ để reconnect khi listener bị ngắt',
          '<strong class="text-gray-200">Gộp trang:</strong> Nhấn "Gộp tài khoản" để xem hội thoại từ nhiều Zalo trong một inbox duy nhất',
          '<strong class="text-gray-200">Trạng thái tài khoản:</strong> Theo dõi nhanh kết nối, listener và khả năng thao tác của từng tài khoản',
          '<strong class="text-gray-200">Kéo thả sắp xếp:</strong> Kéo thả thẻ tài khoản để thay đổi thứ tự hiển thị',
          '<strong class="text-gray-200">Tìm kiếm:</strong> Tìm tài khoản theo tên, Zalo ID, hoặc số điện thoại',
        ]} />
      </Card>

      <Card>
        <SectionTitle>📤 Xuất dữ liệu</SectionTitle>
        <BulletList items={[
          'Xuất danh sách liên hệ CRM ra file CSV / Excel',
          'Lọc theo tài khoản Zalo, nhãn khách hàng',
          'Hỗ trợ chia sẻ danh sách cho team qua file',
        ]} />
      </Card>
    </div>
  );
}

function SecurityPanel() {
  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle>🔒 Bảo mật tài khoản & Dữ liệu</SectionTitle>
        <Paragraph>
          Deplao được xây dựng theo kiến trúc toàn bộ dữ liệu được xử lý và lưu trữ ngay trên máy tính của bạn.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-gray-200">Dữ liệu lưu cục bộ 100%:</strong> Tin nhắn, danh bạ, CRM, cài đặt — tất cả được lưu trong cơ sở dữ liệu ngay trên máy bạn',
          '<strong class="text-gray-200">Không có server trung gian:</strong> App kết nối trực tiếp Zalo ↔ máy bạn, không đi qua proxy của chúng tôi',
          '<strong class="text-gray-200">Phiên đăng nhập Zalo được mã hóa:</strong> Cookie phiên được lưu bảo mật trong vùng dữ liệu riêng của ứng dụng',
          '<strong class="text-gray-200">Không lưu mật khẩu:</strong> App đăng nhập qua QR Code, không bao giờ yêu cầu hoặc lưu mật khẩu Zalo',
        ]} />
      </Card>

      <Card>
        <SectionTitle>💾 Lưu ý quan trọng về dung lượng lưu trữ</SectionTitle>
        <div className="flex items-start gap-3 bg-yellow-900/20 border border-yellow-700/40 rounded-lg px-3 py-3 mb-2">
          <span className="text-yellow-400 text-lg flex-shrink-0">⚠️</span>
          <div className="space-y-1.5">
            <p className="text-yellow-300 text-xs font-semibold">Mặc định dữ liệu lưu tại ổ C — có thể đầy nhanh!</p>
            <p className="text-gray-400 text-xs leading-relaxed">
              Theo mặc định, toàn bộ tin nhắn, ảnh, video, file đính kèm được lưu tại
              <code style={{color:'#86efac',background:'#1f2937',padding:'0.0625rem 0.375rem',borderRadius:'0.25rem',margin:'0 0.1875rem'}}>C:\Users\...\AppData\Roaming\Deplao</code>.
              Với nhiều tài khoản Zalo hoạt động, <strong style={{color:'#fbbf24'}}>thư mục media có thể chiếm vài GB đến hàng chục GB</strong> sau vài tháng sử dụng,
              đặc biệt khi nhận nhiều ảnh và video từ nhóm Zalo.
            </p>
          </div>
        </div>
        <BulletList items={[
          '<strong class="text-gray-200">Khuyến nghị mạnh:</strong> Chuyển thư mục lưu trữ sang ổ D, E hoặc ổ đĩa ngoài có nhiều dung lượng trống (tối thiểu 20–50 GB để thoải mái)',
          '<strong class="text-gray-200">Cách thay đổi:</strong> Vào <em>Cài đặt → Lưu trữ → Thay đổi thư mục</em> → chọn thư mục mới. App sẽ tự động sao chép dữ liệu hiện có sang thư mục mới.',
          '<strong class="text-gray-200">Dữ liệu được sao chép tự động:</strong> Không cần làm thủ công — app xử lý toàn bộ quá trình migrate khi bạn đổi thư mục.',
          '<strong class="text-gray-200">Sao lưu định kỳ:</strong> Sau khi chuyển sang ổ D/E, đặt lịch backup thư mục này hàng tuần để phòng mất dữ liệu khi hỏng ổ cứng.',
          '<strong class="text-gray-200">Kiểm tra dung lượng:</strong> Xem đường dẫn thực tế và dung lượng đang dùng trong <em>Cài đặt → Lưu trữ</em>.',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🛡️ Khuyến nghị bảo mật</SectionTitle>
        <BulletList items={[
          'Đặt thư mục lưu trữ dữ liệu ở ổ đĩa riêng (D, E...) và sao lưu định kỳ',
          'Không chia sẻ file dữ liệu app (.db) cho người khác',
          'Folder media là thư mục lưu trữ tất cả ảnh, file, video bạn gửi/nhận qua Zalo — hãy quản lý và sao lưu nếu cần',
          'Cài đặt antivirus và tường lửa (Windows Defender là đủ)',
          'Khi không dùng nữa, dùng nút "Xóa tài khoản" trong Dashboard hoặc Cài đặt để xoá hoàn toàn dữ liệu.',
        ]} />
      </Card>

      <Card>
        <SectionTitle>📦 Nơi lưu trữ dữ liệu</SectionTitle>
        <Paragraph>
          Mặc định, dữ liệu được lưu tại thư mục <code style={{color:'#86efac',background:'#1f2937',padding:'0.0625rem 0.375rem',borderRadius:'0.25rem'}}>%AppData%\Deplao</code> trên Windows (ổ C).
          Bạn có thể thay đổi sang bất kỳ thư mục nào trong <strong className="text-white font-semibold">Cài đặt → Lưu trữ</strong>.
        </Paragraph>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {[
            { label: 'Database (tin nhắn, danh bạ)', size: '~50–500 MB', icon: '🗃️' },
            { label: 'Media (ảnh, video, file)', size: '1 GB – 50+ GB', icon: '🖼️' },
            { label: 'Cài đặt & phiên đăng nhập', size: '< 1 MB', icon: '⚙️' },
            { label: 'Log ứng dụng', size: '~10–50 MB', icon: '📋' },
          ].map((item, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg px-2.5 py-2">
              <p className="text-gray-200 text-[11px] font-medium">{item.icon} {item.label}</p>
              <p className="text-gray-500 text-[11px] mt-0.5">Ước tính: {item.size}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function EmployeesPanel() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-4xl leading-none">🧑‍💼</span>
        <div>
          <h3 className="text-white font-bold text-base">Cài đặt nhân viên & Workspace</h3>
          <p className="text-gray-400 text-xs mt-0.5">Cho phép nhiều nhân viên truy cập và xử lý tin nhắn từ máy riêng — có phân quyền chi tiết</p>
          <div className="flex gap-1.5 mt-2 flex-wrap">
            <Badge text="Boss Mode" color="bg-purple-600/30 text-purple-300" />
            <Badge text="Employee Mode" color="bg-green-600/30 text-green-300" />
            <Badge text="Relay Server" color="bg-blue-600/30 text-blue-300" />
          </div>
        </div>
      </div>

      <Card>
        <SectionTitle>🏢 Mô hình hoạt động</SectionTitle>
        <Paragraph>
          Deplao hỗ trợ mô hình <strong>1 Boss — nhiều nhân viên</strong>: Boss chạy app trên máy chủ, bật Relay Server,
          nhân viên kết nối từ máy riêng qua <strong>mạng nội bộ (LAN)</strong> hoặc <strong>từ xa qua WAN / Cloudflare Tunnel</strong>.
          Dữ liệu workspace (DB, media) vẫn lưu trữ trên máy nhân viên. Do Zalo chỉ cho phép 1 kết nối cùng lúc, toàn bộ request Zalo sẽ được chuyển tiếp về máy Boss để xử lý.
        </Paragraph>
        <div className="grid grid-cols-2 gap-2 mt-2">
          {[
            { icon: '👑', label: 'Boss', desc: 'Toàn quyền, cài đặt nhân viên & tài khoản Zalo, bật Relay + Tunnel' },
            { icon: '👷', label: 'Nhân viên', desc: 'Truy cập theo phân quyền, kết nối qua LAN hoặc WAN từ bất kỳ đâu' },
          ].map((r, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg p-3 space-y-1">
              <p className="text-gray-200 text-xs font-semibold">{r.icon} {r.label}</p>
              <p className="text-gray-500 text-[11px]">{r.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>🖧 Relay Server — Cầu nối Boss ↔ Nhân viên</SectionTitle>
        <Paragraph>
          Boss bật <strong>Relay Server</strong> trong <em>Cài đặt → Nhân viên → Relay Server</em>.
          Server lắng nghe trên một cổng (mặc định 9900). Nhân viên có thể kết nối qua <strong>LAN</strong> (cùng mạng nội bộ)
          hoặc qua <strong>WAN / Cloudflare Tunnel</strong> (từ xa, bất kỳ đâu có Internet).
        </Paragraph>
        <div className="grid grid-cols-2 gap-2 mt-1 mb-3">
          {[
            { icon: '🏠', mode: 'Chế độ LAN', desc: 'Nhân viên và boss cùng mạng Wi-Fi / văn phòng. Nhân viên nhập IP nội bộ (VD: 192.168.1.10:9900).' },
            { icon: '🌍', mode: 'Chế độ WAN', desc: 'Boss bật Cloudflare Tunnel → nhận URL công khai (*.trycloudflare.com). Nhân viên nhập URL đó để kết nối từ xa.' },
          ].map((m, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg p-3 space-y-1">
              <p className="text-gray-200 text-[11px] font-semibold">{m.icon} {m.mode}</p>
              <p className="text-gray-500 text-[11px] leading-relaxed">{m.desc}</p>
            </div>
          ))}
        </div>
        <StepList steps={[
          { title: 'Boss bật Relay Server', desc: 'Cài đặt → Nhân viên → Relay Server → nhập cổng → "Bật server". Bật "Tự động bật khi khởi động" để không phải làm thủ công mỗi lần.' },
          { title: '(Tuỳ chọn) Bật Tunnel WAN', desc: 'Nhấn "Bật Tunnel WAN" — app tự cài cloudflared và tạo URL công khai dạng https://xxx.trycloudflare.com. Copy URL này gửi cho nhân viên remote.' },
          { title: 'Nhân viên cài app', desc: 'Nhân viên cài Deplao trên máy của họ, nhập địa chỉ LAN (IP:cổng) hoặc URL WAN từ boss.' },
          { title: 'Nhân viên đăng nhập', desc: 'Nhập tài khoản/mật khẩu được boss tạo sẵn. App kết nối relay và nhận dữ liệu từ boss.' },
          { title: 'Làm việc bình thường', desc: 'Nhân viên xem hội thoại, gửi tin nhắn được phân công — mọi thao tác đều đi qua relay về máy boss.' },
        ]} />
        <div className="mt-3 bg-blue-900/20 border border-blue-700/40 rounded-lg px-3 py-2.5 space-y-1.5">
          <p className="text-blue-300 text-[11px] font-semibold">🌐 Cloudflare Tunnel — không cần cấu hình router hay VPS</p>
          <BulletList items={[
            'Tunnel dùng Cloudflare Quick Tunnel miễn phí — không cần tài khoản, không giới hạn băng thông.',
            'URL tunnel thay đổi mỗi lần bật — hãy copy URL mới và gửi lại cho nhân viên sau mỗi lần restart.',
            'Không cần mở port router, không cần IP tĩnh, không cần VPS — phù hợp cho team làm việc từ xa.',
          ]} />
        </div>
        <div className="mt-2 bg-yellow-900/20 border border-yellow-700/40 rounded-lg px-3 py-2.5 space-y-1.5">
          <p className="text-yellow-300 text-[11px] font-semibold">⚠️ Lưu ý khi restart app boss</p>
          <BulletList items={[
            '<strong class="text-gray-300">Server tự dừng</strong> khi đóng app — nhân viên bị ngắt kết nối, cần đăng nhập lại.',
            '<strong class="text-gray-300">IP LAN có thể thay đổi</strong> nếu DHCP cấp IP mới — khuyến nghị đặt IP tĩnh cho máy boss.',
            '<strong class="text-gray-300">URL WAN thay đổi</strong> mỗi lần tắt/bật tunnel — copy URL mới và gửi lại cho nhân viên remote.',
          ]} />
        </div>
      </Card>

      <Card>
        <SectionTitle>👤 Tạo & Quản lý tài khoản nhân viên</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Tạo nhân viên:</strong> Cài đặt → Nhân viên → Danh sách → "Thêm nhân viên" → nhập tên đăng nhập, mật khẩu, tên hiển thị.',
          '<strong class="text-gray-200">Phân tài khoản Zalo:</strong> Mỗi nhân viên chỉ thấy các tài khoản Zalo được boss gán — bảo mật và rõ ràng trách nhiệm.',
          '<strong class="text-gray-200">Nhóm nhân viên:</strong> Tạo nhóm (VD: Nhóm Hà Nội, Nhóm CSKH) để phân loại và quản lý dễ hơn.',
          '<strong class="text-gray-200">Vô hiệu hóa / Xóa:</strong> Boss có thể tạm khóa hoặc xóa tài khoản nhân viên bất kỳ lúc nào.',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🔐 Phân quyền chi tiết</SectionTitle>
        <Paragraph>
          Boss có thể bật/tắt từng module riêng lẻ cho mỗi nhân viên. Nhân viên chỉ thấy và truy cập được những gì được phép.
        </Paragraph>
        <div className="grid grid-cols-2 gap-1.5 mt-2">
          {[
            { icon: '💬', mod: 'Chat', desc: 'Xem và gửi tin nhắn' },
            { icon: '👥', mod: 'CRM', desc: 'Quản lý khách hàng, nhãn' },
            { icon: '⚙️', mod: 'Workflow', desc: 'Xem và kích hoạt workflow' },
            { icon: '🔗', mod: 'Tích hợp', desc: 'Dùng panel tích hợp' },
            { icon: '📈', mod: 'Báo cáo', desc: 'Xem analytics, thống kê' },
            { icon: '👤', mod: 'Bạn bè', desc: 'Xem danh sách liên hệ' },
          ].map((p, i) => (
            <div key={i} className="flex items-center gap-2 bg-gray-700/30 rounded-lg px-2.5 py-2">
              <span className="text-sm">{p.icon}</span>
              <div>
                <p className="text-gray-200 text-[11px] font-medium">{p.mod}</p>
                <p className="text-gray-500 text-[10px]">{p.desc}</p>
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 bg-blue-900/20 border border-blue-700/30 rounded-lg px-3 py-2">
          <p className="text-blue-300 text-[11px]">
            💡 Khi nhân viên không có quyền vào một trang, app tự động chuyển về <strong>Dashboard</strong> — không xảy ra lỗi hay lộ dữ liệu.
          </p>
        </div>
      </Card>

      <Card>
        <SectionTitle>📊 Báo cáo nhân viên</SectionTitle>
        <Paragraph>
          Module <strong>Báo cáo → Nhân viên</strong> cho phép boss theo dõi hiệu suất từng nhân viên theo khoảng thời gian tùy chọn.
        </Paragraph>
        <BulletList items={[
          '<strong class="text-gray-200">Tổng tin nhắn gửi</strong> — số tin nhắn thực tế nhân viên đã gửi (không đếm trùng với log phản hồi).',
          '<strong class="text-gray-200">Giờ online</strong> — tổng thời gian nhân viên đã kết nối relay trong kỳ báo cáo, tính chính xác kể cả phiên kéo dài qua nhiều ngày.',
          '<strong class="text-gray-200">Thời gian phản hồi trung bình</strong> — tính từ lúc nhận tin khách đến khi nhân viên trả lời.',
          '<strong class="text-gray-200">Bộ lọc đa nhân viên</strong> — chọn 1 hoặc nhiều nhân viên để so sánh song song trên cùng biểu đồ, hiển thị ảnh + tên.',
          '<strong class="text-gray-200">Biểu đồ timeline, radar, phân bổ giờ</strong> — trực quan hóa hoạt động theo ngày và theo khung giờ trong ngày.',
        ]} />
      </Card>

      <Card>
        <SectionTitle>🔄 Đồng bộ dữ liệu Boss ↔ Nhân viên</SectionTitle>
        <BulletList items={[
          'Tin nhắn boss nhận/gửi được relay đến nhân viên theo thời gian thực.',
          'Chuyển giữa workspace boss ↔ nhân viên: app tự kiểm tra quyền và chuyển hướng về Dashboard nếu trang hiện tại không được phép.',
        ]} />
      </Card>
    </div>
  );
}

function PolicyPanel() {
  return (
    <div className="space-y-4">
      <div className="bg-blue-900/20 border border-blue-700/40 rounded-xl p-4">
        <p className="text-blue-300 text-xs font-semibold mb-1">📜 Chính sách sử dụng & Tuyên bố miễn trách nhiệm pháp lý</p>
        <p className="text-gray-400 text-[11px]">Phiên bản 1.0 — có hiệu lực từ ngày 01/01/2025</p>
      </div>

      <Card>
        <SectionTitle>1. Mục đích sử dụng hợp pháp</SectionTitle>
        <Paragraph>
          Deplao là phần mềm hỗ trợ quản lý giao tiếp trên nền tảng Zalo dành cho mục đích
          <strong className="text-white font-semibold"> kinh doanh hợp pháp</strong>, chăm sóc khách hàng và Tự động hoá quy trình làm việc.
          Phần mềm <strong style={{color:'#fbbf24'}}>không được thiết kế</strong> và <strong style={{color:'#fbbf24'}}>không khuyến khích sử dụng</strong> cho các hành vi:
        </Paragraph>
        <BulletList items={[
          'Gửi tin nhắn spam, quảng cáo hàng loạt không có sự đồng ý của người nhận',
          'Thu thập thông tin cá nhân trái phép',
          'Phát tán nội dung vi phạm pháp luật, nội dung khiêu dâm, bạo lực',
          'Lừa đảo, gian lận, hoặc bất kỳ hành vi vi phạm pháp luật Việt Nam nào',
          'Vi phạm Điều khoản dịch vụ của Zalo',
        ]} />
      </Card>

      <Card>
        <SectionTitle>2. Dữ liệu người dùng & Quyền riêng tư</SectionTitle>
        <BulletList items={[
          '<strong class="text-gray-200">Dữ liệu lưu hoàn toàn cục bộ</strong> trên máy tính của người dùng. Chúng tôi <em>không</em> thu thập, lưu trữ hoặc xử lý nội dung tin nhắn, danh bạ hay thông tin khách hàng của bạn trên bất kỳ server nào của chúng tôi.',
          '<strong class="text-gray-200">Không chia sẻ với bên thứ 3</strong>: Deplao không tích hợp bất kỳ SDK thu thập dữ liệu, analytics hay quảng cáo của bên thứ 3.',
          '<strong class="text-gray-200">Phiên Zalo</strong>: Cookie phiên Zalo được mã hóa AES và lưu cục bộ, chỉ dùng để duy trì kết nối Zalo từ máy bạn.',
        ]} />
      </Card>

      <Card>
        <SectionTitle>3. Yêu cầu vận hành 24/7</SectionTitle>
        <Paragraph>
          Để các tính năng Tự động hoá (Workflow, nhắn tin theo lịch, nhận tin nhắn thời gian thực) hoạt động liên tục,
          ứng dụng cần được <strong className="text-white font-semibold">để chạy nền 24/7</strong> trên máy tính.
          Người dùng chịu trách nhiệm đảm bảo máy tính có nguồn điện ổn định và kết nối Internet.
          Việc tắt máy hoặc ngắt kết nối Internet sẽ làm gián đoạn các automation đang chạy.
        </Paragraph>
      </Card>

      <Card>
        <SectionTitle>4. Tuyên bố miễn trách nhiệm</SectionTitle>
        <BulletList items={[
          'Deplao là công cụ hỗ trợ. Người dùng <strong class="text-gray-200">hoàn toàn chịu trách nhiệm</strong> về cách sử dụng phần mềm và tuân thủ pháp luật hiện hành.',
          'Chúng tôi không chịu trách nhiệm nếu tài khoản Zalo của bạn bị Zalo hạn chế do sử dụng không đúng cách hoặc vi phạm điều khoản Zalo.',
          'Dữ liệu lưu trên máy bạn là trách nhiệm của bạn. Hãy sao lưu định kỳ để tránh mất mát.',
          'Phần mềm được cung cấp "nguyên trạng" (as-is). Chúng tôi không đảm bảo phần mềm hoạt động hoàn toàn không có lỗi trong mọi môi trường.',
        ]} />
      </Card>

      <Card>
        <SectionTitle>5. Sở hữu trí tuệ</SectionTitle>
        <Paragraph>
          Deplao và tất cả tài liệu liên quan là tài sản trí tuệ của <strong className="text-white font-semibold">DepLao Team</strong>.
          Nghiêm cấm sao chép, phân phối lại, reverse-engineer hoặc bán lại phần mềm dưới bất kỳ hình thức nào
          khi chưa có sự đồng ý bằng văn bản.
        </Paragraph>
      </Card>

      <Card>
        <SectionTitle>6. Liên hệ & Hỗ trợ</SectionTitle>
        <BulletList items={[
          'Link github: <strong class="text-gray-200">https://github.com/babyvibe</strong>',
        ]} />
      </Card>
    </div>
  );
}

function BugReportPanel() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-3xl leading-none">🐛</span>
        <div>
          <h3 className="text-white font-bold text-base">Báo lỗi & Hướng dẫn</h3>
          <p className="text-gray-400 text-xs mt-0.5 leading-relaxed">
            Tìm thấy lỗi? Báo cáo chi tiết giúp nhóm phát triển xác định và sửa lỗi nhanh hơn.
            <strong className="text-amber-400"> Báo cáo có chứng minh rõ ràng sẽ được team ưu tiên xử lý trước.</strong>
          </p>
        </div>
      </div>

      <div className="flex justify-center gap-2">
        <button
          onClick={() => ipc.shell?.openExternal('https://github.com/babyvibe/deplao-builder/issues/new')}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-medium rounded-lg transition-colors"
        >
          Tạo Issue mới trên GitHub →
        </button>
        <button
          onClick={() => ipc.shell?.openExternal('https://github.com/babyvibe/deplao-builder/issues')}
          className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 text-xs font-medium rounded-lg transition-colors"
        >
          Xem danh sách Issues
        </button>
      </div>

      <Card>
        <SectionTitle>📝 Quy trình báo lỗi — 5 bước</SectionTitle>
        <StepList steps={[
          {
            title: '1. Tái hiện lỗi',
            desc: 'Lặp lại thao tác khi gặp lỗi. Ghi nhận từng bước cụ thể (VD: "Mở CRM → Nhấn Chiến dịch → Nhấn Tạo mới → Lỗi"). Xác nhận lỗi xảy ra mỗi lần hay chỉ thỉnh thoảng. Thử trên phiên bản Deplao mới nhất.',
          },
          {
            title: '2. Chụp ảnh / quay video minh hoạ',
            desc: 'Screenshot khi lỗi xuất hiện (PrtScn / Snipping Tool). Quay video ngắn 10-30s nếu lỗi liên quan nhiều bước (Win+G). Chụp Developer Tools (Ctrl+Shift+I → tab Console) để ghi lại lỗi đỏ. Dùng mũi tên/viền đỏ chỉ rõ vị trí lỗi.',
          },
          {
            title: '3. Thu thập thông tin kỹ thuật',
            desc: 'Phiên bản Deplao (thanh trên cùng bên trái). Hệ điều hành (Windows 10/11, macOS Intel/Apple Silicon). Tài khoản nào gặp lỗi (Zalo cá nhân, Business, Facebook). Tính năng liên quan. Nếu có lỗi Console (Ctrl+Shift+I → Console) — copy-paste nội dung.',
          },
          {
            title: '4. Viết mô tả Issue trên GitHub',
            desc: 'Tiêu đề mô tả ngắn gọn lỗi. Phần "Mô tả lỗi": 1-2 câu. "Bước tái hiện": danh sách numbered. "Kết quả mong đợi" vs "Kết quả thực tế". Đính kèm ảnh/video. "Thông tin môi trường": phiên bản, OS, tài khoản.',
          },
          {
            title: '5. Gửi Issue và theo dõi',
            desc: 'Nhấn Submit trên GitHub. Theo dõi email thông báo khi có phản hồi. Phản hồi sớm khi nhóm yêu cầu thêm thông tin. Khi lỗi đã sửa, cập nhật Deplao và xác nhận lại.',
          },
        ]} />
      </Card>

      <Card>
        <SectionTitle>📖 Ví dụ: Báo cáo lỗi chất lượng cao</SectionTitle>
        <div className="bg-gray-900/60 rounded-lg border border-gray-700/50 p-3 space-y-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="bg-red-900/40 text-red-300 text-[10px] px-2 py-0.5 rounded-full font-medium">bug</span>
            <span className="text-white font-semibold">Chiến dịch CRM: Không gửi được tin khi chọn hơn 100 liên hệ</span>
          </div>
          <p className="text-gray-400 leading-relaxed">
            <strong className="text-gray-200">Mô tả:</strong> Khi tạo chiến dịch gửi tin hàng loạt với hơn 100 người nhận,
            nút "Bắt đầu gửi" không phản hồi. Console hiện lỗi timeout.
          </p>
          <div className="text-gray-400 leading-relaxed space-y-1">
            <p><strong className="text-gray-200">Bước tái hiện:</strong></p>
            <ol className="list-decimal pl-5 space-y-0.5">
              <li>Mở CRM → Chiến dịch → Tạo chiến dịch mới</li>
              <li>Chọn đối tượng: tất cả liên hệ có nhãn "Khách hàng" (~150 người)</li>
              <li>Nhập nội dung tin nhắn → Nhấn "Bắt đầu gửi"</li>
              <li>→ Không có phản hồi, nút chuyển disabled nhưng không gửi</li>
            </ol>
          </div>
          <p className="text-gray-400 leading-relaxed">
            <strong className="text-gray-200">Môi trường:</strong> Deplao v26.4.5, Windows 11, Zalo cá nhân.
            Đã test 50 người (bình thường), 100 người (bình thường), 150 người (lỗi).
          </p>
          <div className="bg-green-900/20 border border-green-700/30 rounded-lg p-2 mt-2">
            <p className="text-[11px] text-green-300">
              ✅ Báo cáo này có: bước tái hiện chính xác, so sánh kết quả, thông tin môi trường đủ để xác định lỗi.
            </p>
          </div>
        </div>
      </Card>

      <Card>
        <SectionTitle>🔍 Các loại lỗi thường gặp</SectionTitle>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {[
            { icon: '🔴', type: 'Lỗi crash / treo app', tips: 'Mô tả thao tác cuối trước khi crash. Chụp screenshot lỗi. Kiểm tra Console (Ctrl+Shift+I).' },
            { icon: '🟡', type: 'Lỗi giao diện / hiển thị', tips: 'Screenshot so sánh hiện tại vs mong đợi. Ghi OS, độ phân giải màn hình.' },
            { icon: '🔵', type: 'Lỗi kết nối / đồng bộ', tips: 'Ghi thời điểm lỗi. Kiểm tra mạng. Thử đăng nhập lại. Gửi screenshot trạng thái.' },
            { icon: '🟣', type: 'Lỗi tích hợp bên thứ 3', tips: 'Ghi rõ tích hợp nào. Kiểm tra API key. Mô tả expected vs actual response.' },
            { icon: '🟠', type: 'Lỗi Workflow không chạy', tips: 'Screenshot flow designer. Ghi trigger + action. Kiểm tra log "Chạy gần đây".' },
            { icon: '⚪', type: 'Hiệu năng chậm / lag', tips: 'Ghi quy mô dữ liệu. Mô tả thao tác bị chậm. So sánh với phiên bản trước.' },
          ].map((item, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg p-2.5 border border-gray-600/30">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-sm">{item.icon}</span>
                <p className="text-[11px] font-semibold text-white">{item.type}</p>
              </div>
              <p className="text-[11px] text-gray-400 leading-relaxed">{item.tips}</p>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        <SectionTitle>🚫 Những điều KHÔNG nên làm</SectionTitle>
        <BulletList items={[
          'Gửi issue chỉ ghi "app bị lỗi" mà không có mô tả chi tiết',
          'Gửi nhiều issue trùng lặp — hãy kiểm tra issue đã tồn tại trước',
          'Đính kèm ảnh chụp thông tin nhạy cảm (mã OTP, mật khẩu, SĐT KH...)',
          'Dùng issue để hỏi cách sử dụng — đọc trang Hướng dẫn trước',
          'Gửi yêu cầu tính năng qua mục báo lỗi — tạo issue riêng nhãn "enhancement"',
        ]} />
      </Card>
    </div>
  );
}

function DonateCoffeePanel() {
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <span className="text-3xl leading-none">☕</span>
        <div>
          <h3 className="text-white font-bold text-base">Donate & Ủng hộ</h3>
          <p className="text-gray-400 text-xs mt-0.5 leading-relaxed">
            Dự án phát triển bởi <strong className="text-gray-200">Deplao</strong> với mục tiêu mang công cụ all-in-one tất cả mọi thứ người dùng cần để quản lý và marketing
            trên Zalo, Facebook đến mọi cá nhân và doanh nghiệp nhỏ hoàn toàn <strong className="text-green-400">miễn phí</strong>.
            Mỗi ly cà phê của bạn giúp tụi mình có thêm token AI, duy trì server và phát triển tính năng mới.
          </p>
        </div>
      </div>

      {/* QR Code placeholder */}
      <Card>
        <SectionTitle>📱 Quét mã QR — Ủng hộ qua chuyển khoản</SectionTitle>
        <Paragraph>
          Quét mã QR bên dưới bằng app ngân hàng để ủng hộ đội ngũ phát triển.
          Mọi đóng góp đều được ghi nhận và biết ơn!
        </Paragraph>
        <div className="flex justify-center mt-3">
          <div className="w-60 h-60 bg-gray-700/60 rounded-2xl border-2 border-dashed border-gray-600 flex flex-col items-center justify-center gap-2 select-none">
            <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-gray-500">
              <rect x="3" y="3" width="7" height="7"/>
              <rect x="14" y="3" width="7" height="7"/>
              <rect x="14" y="14" width="7" height="7"/>
              <rect x="3" y="14" width="7" height="7"/>
              <line x1="3" y1="10" x2="3" y2="14"/>
              <line x1="21" y1="10" x2="21" y2="14"/>
            </svg>
            <span className="text-xs text-gray-500">QR Code</span>
            <span className="text-[10px] text-gray-600 text-center px-4">
              <img src={qrCodeImg} alt="QR Code" className="w-full h-full object-contain" />
            </span>
          </div>
        </div>
      </Card>

      {/* Nhận Job */}
      <Card>
        <SectionTitle>💼 Nhận dự án — Team nhận làm phần mềm theo yêu cầu</SectionTitle>
        <Paragraph>
          Ngoài Deplao, team còn nhận phát triển phần mềm theo yêu cầu riêng (custom software development).
          Nếu bạn cần một công cụ quản lý, tự động hoá hoặc bất cứ giải pháp công nghệ nào, đừng ngần ngại liên hệ!
        </Paragraph>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
          {[
            { icon: '🛠️', title: 'Phần mềm desktop', desc: 'Ứng dụng Electron, React, TypeScript cho Windows/macOS' },
            { icon: '🌐', title: 'Web app & API', desc: 'Backend Node.js, React, PHP,... database quản lý doanh nghiệp' },
            { icon: '🤖', title: 'Tự động hoá & Bot', desc: 'Zalo bot, Facebook bot, Telegram bot, workflow automation' },
            { icon: '📊', title: 'CRM & ERP', desc: 'Hệ thống quản lý khách hàng, nhân viên, bán hàng riêng' },
            { icon: '🔌', title: 'Tích hợp API', desc: 'Kết nối POS, thanh toán, vận chuyển, webhook, third-party' },
            { icon: '📱', title: 'AI & Chatbot', desc: 'Tích hợp GPT, Gemini, xử lý ngôn ngữ tự nhiên, phân loại' },
          ].map((item, i) => (
            <div key={i} className="bg-gray-700/30 rounded-lg p-2.5 border border-gray-600/30">
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-sm">{item.icon}</span>
                <p className="text-[11px] font-semibold text-white">{item.title}</p>
              </div>
              <p className="text-[11px] text-gray-400 leading-relaxed">{item.desc}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Contact */}
      <Card>
        <SectionTitle>📞 Liên hệ team</SectionTitle>
        <div className="space-y-2">
          <div className="flex items-center gap-2.5 bg-gray-700/40 rounded-lg px-3 py-2.5">
            <span className="text-base">🐙</span>
            <div>
              <p className="text-xs text-gray-200 font-medium">GitHub Issues</p>
              <button
                onClick={() => ipc.shell?.openExternal('https://github.com/babyvibe/deplao-builder/issues')}
                className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors text-left"
              >
                github.com/babyvibe/deplao-builder
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2.5 bg-gray-700/40 rounded-lg px-3 py-2.5">
            <span className="text-base">✈️</span>
            <div>
              <p className="text-xs text-gray-200 font-medium">Telegram</p>
              <button
                onClick={() => ipc.shell?.openExternal('https://t.me/babyvibe9')}
                className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors text-left"
              >
                t.me/babyvibe9
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2.5 bg-gray-700/40 rounded-lg px-3 py-2.5">
            <span className="text-base">📘</span>
            <div>
              <p className="text-xs text-gray-200 font-medium">Facebook</p>
              <button
                onClick={() => ipc.shell?.openExternal('https://fb.com/tientt99')}
                className="text-[11px] text-blue-400 hover:text-blue-300 transition-colors text-left"
              >
                fb.com/tientt99
              </button>
            </div>
          </div>
          <div className="bg-gradient-to-r from-amber-900/20 to-orange-900/20 border border-amber-600/30 rounded-lg p-3">
            <p className="text-xs text-amber-300 font-medium text-center">
              ☕ Cảm ơn bạn đã quan tâm và ủng hộ! Mỗi đóng góp đều giúp dự án phát triển tốt hơn.
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
}

const PANEL_MAP = {
  overview:     OverviewPanel,
  dashboard:    DashboardPanel,
  multiAccount: MultiAccountPanel,
  messaging:    MessagingPanel,
  crm:          CrmPanel,
  workflow:     WorkflowPanel,
  'integration-pos': IntegrationPOSPanel,
  'integration-payment': IntegrationPaymentPanel,
  'integration-shipping': IntegrationShippingPanel,
  'ai-assistant': AIAssistantPanel,
  analytics:    AnalyticsPanel,
  erp:          ErpPanel,
  employees:    EmployeesPanel,
  security:     SecurityPanel,
  policy:       PolicyPanel,
  bugreport:    BugReportPanel,
  donate:       DonateCoffeePanel,
} satisfies Record<FeatureId, React.FC>;

// ─── Main component ───────────────────────────────────────────────────────────

interface IntroductionSettingsProps {
  initialSubtab?: FeatureId;
}

export default function IntroductionSettings({ initialSubtab }: IntroductionSettingsProps = {}) {
  const [activeFeature, setActiveFeature] = useState<FeatureId>(initialSubtab || 'overview');
  const Panel = PANEL_MAP[activeFeature];

  // Listen for external subtab navigation events
  useEffect(() => {
    const handler = (e: Event) => {
      const { subtab } = (e as CustomEvent).detail || {};
      if (subtab && subtab in PANEL_MAP) {
        setActiveFeature(subtab as FeatureId);
      }
    };
    window.addEventListener('nav:intro-subtab', handler);
    return () => window.removeEventListener('nav:intro-subtab', handler);
  }, []);

  // Reset to initialSubtab when prop changes (e.g. parent re-renders with new event)
  useEffect(() => {
    if (initialSubtab && initialSubtab in PANEL_MAP) {
      setActiveFeature(initialSubtab);
    }
  }, [initialSubtab]);

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold text-white">📖 Giới thiệu & Hướng dẫn sử dụng</h2>

      <div className="flex gap-0 border border-gray-700 rounded-xl overflow-hidden" style={{ minHeight: '30rem' }}>
        {/* Left: Feature tabs */}
        <div className="w-44 flex-shrink-0 border-r border-gray-700 bg-gray-850 flex flex-col py-2 gap-0.5 overflow-y-auto">
          {FEATURES.map(f => (
            <button
              key={f.id}
              onClick={() => setActiveFeature(f.id)}
              className={`flex items-center gap-2.5 w-full px-3 py-2.5 text-xs text-left transition-colors border-r-2 ${
                activeFeature === f.id
                  ? 'bg-blue-600/20 text-blue-400 border-blue-500'
                  : 'text-gray-400 hover:bg-gray-700/50 hover:text-gray-200 border-transparent'
              }`}
            >
              <span className="text-sm leading-none flex-shrink-0">{f.icon}</span>
              <span className="font-medium leading-tight">{f.label}</span>
            </button>
          ))}
        </div>

        {/* Right: Content */}
        <div className="flex-1 overflow-y-auto p-4">
          <Panel />
        </div>
      </div>
    </div>
  );
}

