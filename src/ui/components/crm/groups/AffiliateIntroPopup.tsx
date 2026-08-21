import React from 'react';
import ipc from '@/lib/ipc';

interface Props {
  onClose: () => void;
}

export default function AffiliateIntroPopup({ onClose }: Props) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-gray-800 border border-gray-600 rounded-2xl w-[520px] max-h-[85vh] shadow-2xl overflow-hidden flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* ── Hero Banner ─────────────────────────────────────────────── */}
        <div className="relative bg-gradient-to-br from-amber-600 via-orange-600 to-red-600 px-6 py-8 text-center overflow-hidden">
          {/* Decorative circles */}
          <div className="absolute -top-10 -right-10 w-40 h-40 bg-white/10 rounded-full" />
          <div className="absolute -bottom-8 -left-8 w-32 h-32 bg-white/10 rounded-full" />

          <div className="relative z-10">
            <h2 className="text-xl font-bold text-white-important mb-1">Kiếm tiền cùng Deplao</h2>
            <p className="text-white/80 text-sm">Chia sẻ trải nghiệm - Nhận hoa hồng hấp dẫn</p>
          </div>
        </div>

        {/* ── Body ────────────────────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">

          {/* Intro text */}
          <div className="text-center">
            <p className="text-gray-300 text-sm leading-relaxed">
              Bạn đang sử dụng Deplao và thấy hữu ích? <span className="text-white font-semibold">Giới thiệu cho bạn bè</span> — mỗi khách hàng mới đăng ký qua mã của bạn, bạn nhận <span className="text-amber-400 font-bold">25% hoa hồng</span> trên giá trị đơn hàng.
            </p>
          </div>

          {/* ── Use cases ─────────────────────────────────────────────── */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Deplao giúp gì cho người dùng?</h3>

            {[
              {
                icon: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-purple-400">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" /><circle cx="12" cy="12" r="3" />
                  </svg>
                ),
                title: 'Quét thành viên nhóm ẩn',
                desc: 'Khai thác hàng nghìn khách hàng tiềm năng từ các nhóm Zalo - gồm các nhóm đã tham gia hoặc chưa tham gia đang ẩn thành viên.',
              },
              {
                icon: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-blue-400">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                    <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                ),
                title: 'Kết nối hàng trăm nghìn người',
                desc: 'Tiếp cận tệp khách khổng lồ qua mạng lưới nhóm Zalo - Từ UID thành viên nhóm hoặc data SĐT có sẵn lên chiến dịch gửi tin nhắn, kết bạn, mời vào nhóm tự động.',
              },
              {
                icon: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-green-400">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96" /><line x1="12" y1="22.08" x2="12" y2="12" />
                  </svg>
                ),
                title: 'Hàng nghìn kho nhóm theo lĩnh vực',
                desc: 'Kho nhóm Zalo sẵn có theo từng ngành nghề - Không biết phải tim nhóm ở đâu? Tất cả nghành như Kinh doanh, BĐS, giáo dục, spa...(join và quét ngay, không cần tìm kiếm thủ công).',
              },
              {
                icon: (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400">
                    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                  </svg>
                ),
                title: 'Workflow + AI vận hành tự động',
                desc: 'Đa tài khoản kết hợp Workflow và Trợ lý AI - Phù hợp với các tệp khách kinh doanh trên Zalo, app giúp tự động trả lời, chăm sóc khách, gửi chiến dịch hàng loạt mà không cần thao tác tay.',
              },
            ].map((item, i) => (
              <div key={i} className="flex gap-3 bg-gray-700/40 rounded-xl p-3.5">
                <div className="w-9 h-9 rounded-lg bg-gray-600/50 flex items-center justify-center flex-shrink-0">
                  {item.icon}
                </div>
                <div>
                  <p className="text-sm text-white font-semibold">{item.title}</p>
                  <p className="text-[11px] text-gray-400 mt-0.5 leading-relaxed">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* ── Commission highlight ──────────────────────────────────── */}
          <div className="bg-gradient-to-r from-amber-900/30 via-orange-900/20 to-amber-900/30 border border-amber-600/30 rounded-xl p-4">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center flex-shrink-0">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-400">
                  <path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" />
                </svg>
              </div>
              <div>
                <p className="text-amber-300 font-bold text-sm">Hoa hồng cực kỳ hấp dẫn</p>
                <p className="text-amber-400/60 text-[11px]">Không giới hạn số lượng giới thiệu</p>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-gray-800/60 rounded-lg px-3 py-2.5 text-center">
                <p className="text-2xl font-bold text-amber-400">25%</p>
                <p className="text-[10px] text-gray-400 mt-0.5">Mỗi giao dịch đầu tiên của tài khoản mới</p>
              </div>
              <div className="bg-gray-800/60 rounded-lg px-3 py-2.5 text-center">
                <p className="text-2xl font-bold text-orange-400">15%</p>
                <p className="text-[10px] text-gray-400 mt-0.5">Mọi lần gia hạn tiếp theo</p>
              </div>
            </div>
          </div>

          {/* ── Who is this for ────────────────────────────────────────── */}
          <div className="space-y-2">
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Phù hợp với ai?</h3>
            <div className="grid grid-cols-2 gap-2">
              {[
                'Company, Freelancer Marketing',
                'Agency / Team sales',
                'KOL / Content Creator',
                'Nhân viên kinh doanh',
                'Developer / Coder',
                'Tất cả mọi người',
              ].map((role, i) => (
                <div key={i} className="flex items-center gap-2 bg-gray-700/30 rounded-lg px-3 py-2">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" className="text-green-400 flex-shrink-0">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  <span className="text-xs text-gray-300">{role}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <div className="px-6 py-4 border-t border-gray-700 flex flex-col items-center gap-3">
          <button
            onClick={() => ipc.shell?.openExternal('https://deplaoapp.com/affiliate')}
            className="w-full py-3 bg-gradient-to-r from-amber-500 via-orange-500 to-red-500 hover:from-amber-400 hover:via-orange-400 hover:to-red-400
              text-white-important font-bold rounded-xl text-sm shadow-lg shadow-orange-500/25 hover:shadow-orange-500/40
              transition-all duration-200 flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" />
            </svg>
            Đăng ký ngay — Miễn phí
          </button>
          <button onClick={onClose} className="text-xs text-gray-500 hover:text-gray-300 transition-colors">
            Để sau
          </button>
        </div>
      </div>
    </div>
  );
}
