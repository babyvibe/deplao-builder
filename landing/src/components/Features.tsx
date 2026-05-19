const FEATURES = [
  { icon: "👤", color: "bg-blue-50 text-blue-600", title: "Đa tài khoản Zalo", desc: "Đăng nhập không giới hạn tài khoản qua QR Code. Gộp inbox từ nhiều tài khoản vào một giao diện duy nhất.", tags: ["Đa tài khoản", "Unified inbox", "QR login"] },
  { icon: "💬", color: "bg-emerald-50 text-emerald-600", title: "Chat đầy đủ tính năng", desc: "Gửi tin nhắn, ảnh, video, file. Quick messages, ghim tin nhắn không giới hạn, reply, tag thành viên.", tags: ["Quick reply", "Media", "Stickers"] },
  { icon: "👥", color: "bg-purple-50 text-purple-600", title: "CRM & Campaign", desc: "Quản lý liên hệ, nhãn, ghi chú nội bộ. Tạo campaign gửi tin, kết bạn, mời vào nhóm với tiến độ real-time.", tags: ["Labels", "Campaign", "Contact sync"] },
  { icon: "⚙️", color: "bg-orange-50 text-orange-600", title: "Workflow tự động hóa", desc: "Kéo-thả Trigger → Node → Action, hoặc dùng AI tạo workflow từ prompt. Chạy nền 24/7 không cần code.", tags: ["No-code", "AI builder", "Cron trigger"] },
  { icon: "🤖", color: "bg-pink-50 text-pink-600", title: "AI Assistant", desc: "Gợi ý câu trả lời, phân loại tin nhắn, trả lời khách hàng 24/7. Tích hợp trực tiếp trong hội thoại.", tags: ["OpenAI", "Auto-reply", "Suggestion"] },
  { icon: "🔗", color: "bg-cyan-50 text-cyan-600", title: "Tích hợp ngoài", desc: "POS, vận chuyển, Google Sheets, Telegram, Discord, Email, HTTP Request. Kết hợp trong workflow.", tags: ["POS", "GHN/GHTK", "Webhooks"] },
  { icon: "📈", color: "bg-indigo-50 text-indigo-600", title: "Báo cáo & Phân tích", desc: "Theo dõi tin nhắn, liên hệ, nhãn, nhân viên, chiến dịch, workflow và AI usage theo thời gian.", tags: ["Analytics", "Charts", "Export"] },
  { icon: "🧑‍💼", color: "bg-amber-50 text-amber-600", title: "Boss ↔ Nhân viên", desc: "Nhiều thiết bị cùng quản lý, phân quyền từng module, relay qua LAN hoặc tunnel. Theo dõi hiệu suất.", tags: ["Multi-device", "Permissions", "ERP"] },
];
export default function Features() {
  return (
    <section id="features" className="py-20 px-5 orbit-shell">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-14 aos-element">
          <div className="mini-kicker mb-3"><span className="signal-dot" />Tính năng</div>
          <h2 className="text-3xl md:text-4xl font-black text-slate-900 tracking-tight mb-3">
            Mọi thứ bạn cần trong <span className="gradient-text">một app</span>
          </h2>
          <p className="text-slate-500 max-w-xl mx-auto">Từ chat đơn giản đến automation phức tạp — Deplao xử lý hết, không cần nhiều công cụ rời rạc.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {FEATURES.map((f, i) => (
            <div key={f.title} className={`aos-element delay-${Math.min(i + 1, 6)} glass glass-hover rounded-2xl p-5 flex flex-col gap-3`}>
              <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg ${f.color}`}>{f.icon}</div>
              <div>
                <h3 className="font-bold text-slate-900 mb-1">{f.title}</h3>
                <p className="text-sm text-slate-500 leading-relaxed">{f.desc}</p>
              </div>
              <div className="flex flex-wrap gap-1.5 mt-auto">
                {f.tags.map((t: string) => <span key={t} className="planet-chip text-[11px]">{t}</span>)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
