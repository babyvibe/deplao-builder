const STEPS = [
  { num: "01", icon: "⬇️", title: "Tải & cài đặt", desc: "Tải file .exe (Windows) hoặc .dmg (macOS). Cài đặt và mở app trong vài phút." },
  { num: "02", icon: "📱", title: "Đăng nhập Zalo", desc: "Quét QR Code bằng điện thoại. App kết nối ngay, không cần mật khẩu." },
  { num: "03", icon: "💬", title: "Quản lý hội thoại", desc: "Xem inbox, trả lời khách, gắn nhãn và ghi chú nội bộ ngay trong app." },
  { num: "04", icon: "⚙️", title: "Tạo Workflow", desc: "Kéo-thả hoặc mô tả bằng tiếng Việt để AI tạo workflow tự động cho bạn." },
];
export default function HowItWorks() {
  return (
    <section id="how-it-works" className="py-20 px-5">
      <div className="mx-auto max-w-5xl">
        <div className="text-center mb-14 aos-element">
          <div className="mini-kicker mb-3"><span className="signal-dot" />Bắt đầu</div>
          <h2 className="text-3xl md:text-4xl font-black text-slate-900 tracking-tight mb-3">Chạy ngay trong <span className="gradient-text">5 phút</span></h2>
          <p className="text-slate-500 max-w-xl mx-auto">Không cần server, không cần tài khoản cloud. Cài và chạy thôi.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
          {STEPS.map((s, i) => (
            <div key={s.num} className={`aos-element delay-${i + 1} relative`}>
              <div className="glass glass-hover rounded-2xl p-5 h-full flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <span className="text-3xl">{s.icon}</span>
                  <span className="text-4xl font-black text-slate-100">{s.num}</span>
                </div>
                <h3 className="font-bold text-slate-900">{s.title}</h3>
                <p className="text-sm text-slate-500 leading-relaxed">{s.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
