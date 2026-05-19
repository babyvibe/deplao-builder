const INTEGRATIONS = [
  { category: "🛒 POS", items: ["KiotViet", "Haravan", "Sapo", "Nhanh.vn", "Pancake POS"] },
  { category: "🚚 Vận chuyển", items: ["GHN", "GHTK"] },
  { category: "💳 Thanh toán", items: ["Casso", "SePay", "Webhook"] },
  { category: "📊 Data", items: ["Google Sheets", "Google Calendar", "Notion"] },
  { category: "📣 Thông báo", items: ["Telegram Bot", "Discord", "Email (SMTP)"] },
  { category: "🤖 AI", items: ["OpenAI GPT", "Custom Prompt", "AI Node"] },
  { category: "🌐 HTTP", items: ["HTTP Request", "Webhook In", "REST API"] },
  { category: "📘 Facebook", items: ["FB Graph API", "FB Messenger"] },
];
export default function IntegrationShowcase() {
  return (
    <section id="integrations" className="py-20 px-5 orbit-shell">
      <div className="mx-auto max-w-6xl">
        <div className="text-center mb-14 aos-element">
          <div className="mini-kicker mb-3"><span className="signal-dot" />Tích hợp</div>
          <h2 className="text-3xl md:text-4xl font-black text-slate-900 tracking-tight mb-3">Kết nối với <span className="gradient-text">mọi công cụ</span></h2>
          <p className="text-slate-500 max-w-xl mx-auto">POS, vận chuyển, thanh toán, AI, Google Sheets và hàng chục platform khác — dùng trực tiếp trong workflow hoặc khi chat.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {INTEGRATIONS.map((g, i) => (
            <div key={g.category} className={`aos-element delay-${Math.min(i + 1, 6)} glass glass-hover rounded-2xl p-4`}>
              <p className="font-bold text-slate-800 mb-3 text-sm">{g.category}</p>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map((item: string) => <span key={item} className="planet-chip text-[11px]">{item}</span>)}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
