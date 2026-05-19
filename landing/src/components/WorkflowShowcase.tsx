const STEPS = [
  { icon: "⚡", label: "TRIGGER", color: "bg-blue-600", examples: ["Tin nhắn mới", "Nhãn thay đổi", "Cron schedule", "Webhook"] },
  { icon: "🧠", label: "LOGIC / AI", color: "bg-violet-600", examples: ["Điều kiện", "AI phân loại", "Biến / bộ nhớ", "Vòng lặp"] },
  { icon: "🎯", label: "ACTION", color: "bg-emerald-600", examples: ["Gửi tin nhắn", "Cập nhật CRM", "Google Sheets", "HTTP Request"] },
];
const USECASES = [
  { emoji: "🛒", title: "Chốt đơn tự động", desc: "Nhận "cho xin giá" → AI gợi ý → gửi báo giá → theo dõi phản hồi" },
  { emoji: "📅", title: "Nhắc lịch hẹn", desc: "Cron mỗi sáng → lọc lịch hôm nay → nhắn từng khách" },
  { emoji: "🏷️", title: "Phân loại khách", desc: "Tin nhắn mới → AI phân tích → gắn nhãn → chuyển nhân viên phù hợp" },
  { emoji: "💳", title: "Xác nhận thanh toán", desc: "Webhook nhận tiền → tạo đơn POS → nhắn xác nhận → báo nội bộ" },
];
export default function WorkflowShowcase() {
  return (
    <section id="workflow" className="py-20 px-5">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-14 aos-element">
          <div className="mini-kicker mb-3"><span className="signal-dot" />Tự động hóa</div>
          <h2 className="text-3xl md:text-4xl font-black text-slate-900 tracking-tight mb-3">Workflow <span className="gradient-text">kéo-thả</span>, chạy 24/7</h2>
          <p className="text-slate-500 max-w-xl mx-auto">Không cần code. Dùng AI tạo flow từ một câu mô tả, hoặc kéo-thả node trực tiếp.</p>
        </div>
        <div className="aos-element workflow-preview mb-10">
          <div className="workflow-tabs mb-6">
            {STEPS.map((s) => <div key={s.label} className="workflow-tab is-active"><div className="workflow-tab-icon">{s.icon}</div>{s.label}</div>)}
          </div>
          <div className="workflow-stack">
            {STEPS.map((s, i) => (
              <div key={s.label} className="workflow-stack-item">
                {i > 0 && <div className="workflow-connector workflow-connector-live mx-auto" />}
                <div className={`workflow-node ${i === 1 ? "workflow-node-dark" : ""}`}>
                  <div className="flex items-center gap-3">
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center text-white text-base ${s.color}`}>{s.icon}</div>
                    <div>
                      <p className={`text-xs font-black tracking-widest uppercase ${i === 1 ? "text-white/60" : "text-slate-400"}`}>{s.label}</p>
                      <p className={`text-sm font-bold ${i === 1 ? "text-white" : "text-slate-800"}`}>{s.examples[0]}</p>
                    </div>
                    <div className="ml-auto flex flex-wrap gap-1.5">
                      {s.examples.slice(1).map((e: string) => <span key={e} className={`planet-chip text-[11px] ${i === 1 ? "bg-white/10 border-white/10 text-white/80" : ""}`}>{e}</span>)}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="workflow-usecase-grid">
          {USECASES.map((u, i) => (
            <div key={u.title} className={`aos-element delay-${i + 1} workflow-mini-card`}>
              <div className="flex items-start gap-3">
                <span className="text-2xl">{u.emoji}</span>
                <div><p className="font-bold text-slate-900 text-sm mb-1">{u.title}</p><p className="text-xs text-slate-500 leading-relaxed">{u.desc}</p></div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
