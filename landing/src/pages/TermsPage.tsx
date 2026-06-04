import { Link } from 'react-router-dom';

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-[#060a18] text-white">
      {/* Simple header */}
      <nav className="border-b border-white/5 bg-[#060a18]/80 backdrop-blur-xl sticky top-0 z-50">
        <div className="max-w-4xl mx-auto px-6 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2.5 no-underline group">
            <img src="/deplao-builder/icon.png" alt="Deplao" className="w-8 h-8 rounded-lg object-contain group-hover:scale-105 transition-transform" />
            <span className="font-bold text-lg text-white tracking-tight">Deplao</span>
          </Link>
          <Link to="/" className="text-sm text-slate-400 hover:text-white transition-colors no-underline">
            ← Về trang chủ
          </Link>
        </div>
      </nav>

      <main className="max-w-4xl mx-auto px-6 py-16">
        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-block px-4 py-1.5 rounded-full text-sm font-medium text-blue-300 border border-blue-500/30 bg-blue-500/10 mb-4">
            Chính sách & Điều khoản
          </div>
          <h1 className="text-3xl md:text-4xl font-bold mb-3">
            Điều khoản sử dụng & Chính sách bảo mật
          </h1>
          <p className="text-slate-500 text-sm">
            Có hiệu lực khi bạn sử dụng phần mềm
          </p>
        </div>

        <div className="space-y-8">
          {/* Section 1 */}
          <section className="glass rounded-2xl border border-white/5 p-6 md:p-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="text-blue-400">1.</span> Mục đích sử dụng hợp pháp
            </h2>
            <p className="text-slate-400 text-sm leading-relaxed mb-4">
              Deplao là phần mềm hỗ trợ quản lý giao tiếp trên nền tảng Zalo dành cho mục đích
              <strong className="text-white"> kinh doanh hợp pháp</strong>, chăm sóc khách hàng và tự động hoá quy trình làm việc.
              Phần mềm <strong className="text-amber-400">không được thiết kế</strong> và <strong className="text-amber-400">không khuyến khích sử dụng</strong> cho các hành vi:
            </p>
            <ul className="space-y-2 text-slate-400 text-sm">
              <li className="flex items-start gap-2"><span className="text-red-400 mt-0.5">✗</span>
                Gửi tin nhắn spam, quảng cáo không có sự đồng ý của người nhận
              </li>
              <li className="flex items-start gap-2"><span className="text-red-400 mt-0.5">✗</span>
                Thu thập thông tin cá nhân trái phép
              </li>
              <li className="flex items-start gap-2"><span className="text-red-400 mt-0.5">✗</span>
                Phát tán nội dung vi phạm pháp luật, nội dung khiêu dâm, bạo lực
              </li>
              <li className="flex items-start gap-2"><span className="text-red-400 mt-0.5">✗</span>
                Lừa đảo, gian lận, hoặc bất kỳ hành vi vi phạm pháp luật Việt Nam nào
              </li>
              <li className="flex items-start gap-2"><span className="text-red-400 mt-0.5">✗</span>
                Vi phạm Điều khoản dịch vụ của Zalo
              </li>
            </ul>
          </section>

          {/* Section 2 */}
          <section className="glass rounded-2xl border border-white/5 p-6 md:p-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="text-blue-400">2.</span> Dữ liệu người dùng & Quyền riêng tư
            </h2>
            <ul className="space-y-3 text-slate-400 text-sm">
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 mt-0.5 flex-shrink-0">🔒</span>
                <span><strong className="text-white">Dữ liệu lưu hoàn toàn cục bộ</strong> trên máy tính của người dùng. Chúng tôi không thu thập, lưu trữ hoặc xử lý nội dung tin nhắn, danh bạ hay thông tin khách hàng của bạn trên bất kỳ server nào.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 mt-0.5 flex-shrink-0">🔒</span>
                <span><strong className="text-white">Không chia sẻ với bên thứ 3:</strong> Deplao không tích hợp bất kỳ SDK thu thập dữ liệu, analytics hay quảng cáo của bên thứ 3.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 mt-0.5 flex-shrink-0">🔒</span>
                <span><strong className="text-white">Phiên Zalo:</strong> Cookie phiên Zalo được mã hóa AES và lưu cục bộ, chỉ dùng để duy trì kết nối Zalo từ máy bạn.</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 mt-0.5 flex-shrink-0">🔒</span>
                <span><strong className="text-white">Không lưu mật khẩu:</strong> App đăng nhập qua QR Code, không bao giờ yêu cầu hoặc lưu mật khẩu Zalo.</span>
              </li>
            </ul>
          </section>

          {/* Section 3 */}
          <section className="glass rounded-2xl border border-white/5 p-6 md:p-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="text-blue-400">3.</span> Bảo mật tài khoản & Dữ liệu
            </h2>
            <p className="text-slate-400 text-sm leading-relaxed mb-4">
              Deplao được xây dựng theo kiến trúc toàn bộ dữ liệu được xử lý và lưu trữ ngay trên máy tính của bạn.
            </p>
            <ul className="space-y-2 text-slate-400 text-sm">
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">•</span>
                <span><strong className="text-white">Dữ liệu lưu cục bộ 100%:</strong> Tin nhắn, danh bạ, CRM, cài đặt — tất cả được lưu trong cơ sở dữ liệu ngay trên máy bạn</span>
              </li>
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">•</span>
                <span><strong className="text-white">Không có server trung gian:</strong> App kết nối trực tiếp Zalo ↔ máy bạn, không đi qua proxy của chúng tôi</span>
              </li>
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">•</span>
                <span><strong className="text-white">Phiên đăng nhập Zalo được mã hóa:</strong> Cookie phiên được lưu bảo mật trong vùng dữ liệu riêng của ứng dụng</span>
              </li>
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">•</span>
                <span><strong className="text-white">Sao lưu định kỳ:</strong> Khuyến nghị backup thư mục dữ liệu hàng tuần để phòng mất dữ liệu khi hỏng ổ cứng</span>
              </li>
            </ul>
          </section>

          {/* Section 4 */}
          <section className="glass rounded-2xl border border-white/5 p-6 md:p-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="text-blue-400">4.</span> Yêu cầu vận hành 24/7
            </h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Để các tính năng tự động hoá (Workflow, nhắn tin theo lịch, nhận tin nhắn thời gian thực) hoạt động liên tục,
              ứng dụng cần được <strong className="text-white">để chạy nền 24/7</strong> trên máy tính.
              Người dùng chịu trách nhiệm đảm bảo máy tính có nguồn điện ổn định và kết nối Internet.
              Việc tắt máy hoặc ngắt kết nối Internet sẽ làm gián đoạn các automation đang chạy.
            </p>
          </section>

          {/* Section 5 */}
          <section className="glass rounded-2xl border border-white/5 p-6 md:p-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="text-blue-400">5.</span> Tuyên bố miễn trách nhiệm
            </h2>
            <ul className="space-y-3 text-slate-400 text-sm">
              <li className="flex items-start gap-2"><span className="text-amber-400 mt-0.5 flex-shrink-0">⚠️</span>
                <span>Deplao là công cụ hỗ trợ. Người dùng <strong className="text-white">hoàn toàn chịu trách nhiệm</strong> về cách sử dụng phần mềm và tuân thủ pháp luật hiện hành.</span>
              </li>
              <li className="flex items-start gap-2"><span className="text-amber-400 mt-0.5 flex-shrink-0">⚠️</span>
                <span>Chúng tôi không chịu trách nhiệm nếu tài khoản Zalo của bạn bị Zalo hạn chế do sử dụng không đúng cách hoặc vi phạm điều khoản Zalo.</span>
              </li>
              <li className="flex items-start gap-2"><span className="text-amber-400 mt-0.5 flex-shrink-0">⚠️</span>
                <span>Dữ liệu lưu trên máy bạn là trách nhiệm của bạn. Hãy sao lưu định kỳ để tránh mất mát.</span>
              </li>
              <li className="flex items-start gap-2"><span className="text-amber-400 mt-0.5 flex-shrink-0">⚠️</span>
                <span>Phần mềm được cung cấp "nguyên trạng" (as-is). Chúng tôi không đảm bảo phần mềm hoạt động hoàn toàn không có lỗi trong mọi môi trường.</span>
              </li>
            </ul>
          </section>

          {/* Section 6 */}
          <section className="glass rounded-2xl border border-white/5 p-6 md:p-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="text-blue-400">6.</span> Kích hoạt & sử dụng
            </h2>
            <ul className="space-y-2 text-slate-400 text-sm">
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">•</span>
                <span>Trong giai đoạn hiện tại, Deplao đang được mở để người dùng có thể kích hoạt và sử dụng mà không cần thao tác gia hạn thủ công trên giao diện công khai.</span>
              </li>
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">•</span>
                <span>Tài khoản mới vẫn có thể được hệ thống ghi nhận dưới trạng thái <strong className="text-white">trial</strong> để phục vụ vận hành và theo dõi nội bộ.</span>
              </li>
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">•</span>
                <span>Thông tin kích hoạt và trạng thái sử dụng có thể được cập nhật phục vụ mục đích hỗ trợ, đồng bộ thiết bị và theo dõi vận hành hệ thống.</span>
              </li>
              <li className="flex items-start gap-2"><span className="text-blue-400 mt-0.5">•</span>
                <span>Khi chính sách thương mại thay đổi trong tương lai, Deplao có thể cập nhật lại giao diện và điều khoản liên quan trước khi áp dụng công khai.</span>
              </li>
            </ul>
          </section>

          {/* Section 7 */}
          <section className="glass rounded-2xl border border-white/5 p-6 md:p-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="text-blue-400">7.</span> Sở hữu trí tuệ
            </h2>
            <p className="text-slate-400 text-sm leading-relaxed">
              Deplao và tất cả tài liệu liên quan là tài sản trí tuệ của <strong className="text-white">DepLao Team</strong>.
              Nghiêm cấm sao chép, phân phối lại, reverse-engineer hoặc bán lại phần mềm dưới bất kỳ hình thức nào
              khi chưa có sự đồng ý bằng văn bản.
            </p>
          </section>

          {/* Section 8 */}
          <section className="glass rounded-2xl border border-white/5 p-6 md:p-8">
            <h2 className="text-xl font-bold text-white mb-4 flex items-center gap-2">
              <span className="text-blue-400">8.</span> Liên hệ & Hỗ trợ
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center gap-3 bg-gray-800/50 rounded-xl px-4 py-3">
                <span className="text-2xl">💬</span>
                <div>
                  <p className="text-white text-sm font-medium">Telegram hỗ trợ</p>
                  <a href="https://t.me/babyvibe9" className="text-blue-400 text-sm no-underline hover:underline" target="_blank" rel="noopener noreferrer">@Deplao_support</a>
                </div>
              </div>
            </div>
          </section>
        </div>
      </main>

      {/* Simple footer */}
      <footer className="border-t border-white/5 bg-[#060a18]">
        <div className="max-w-4xl mx-auto px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-slate-600">
          <p>© {new Date().getFullYear()} Deplao. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <Link to="/" className="hover:text-slate-400 transition-colors no-underline">Trang chủ</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

