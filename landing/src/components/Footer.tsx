import { Link } from 'react-router-dom';
import logo from '../logo/icon.png';

const Footer: React.FC = () => {
  const year = new Date().getFullYear();

  return (
    <footer className="border-t border-slate-200/80 bg-white/88 backdrop-blur-2xl">
      <div className="max-w-6xl mx-auto px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-10 mb-10">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2.5 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white shadow-[0_10px_24px_rgba(15,23,42,0.08)] ring-1 ring-slate-200">
                <img src={logo} alt="Deplao" className="w-8 h-8 rounded-lg object-contain" />
              </div>
              <span className="font-bold text-lg text-slate-950">Deplao</span>
            </div>
            <p className="text-slate-600 text-sm leading-relaxed max-w-sm">
              Phần mềm quản lý Zalo chuyên nghiệp dành cho cá nhân và doanh nghiệp.
              Nền tảng CRM & Workflow & AI giúp bạn quản lý hàng loạt tài khoản Zalo, triển khai chiến dịch nhắn tin thông minh, chăm sóc khách hàng tự động và vận hành toàn bộ trong một giao diện duy nhất.
            </p>
            <div className="flex items-center gap-3 mt-4">
              <span className="dot-pulse" style={{ background: '#34d399' }} />
              <span className="text-xs text-emerald-600">Hệ thống đang hoạt động bình thường</span>
            </div>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-slate-950 mb-4 uppercase tracking-wider">Sản phẩm</h4>
            <ul className="space-y-2.5">
              {[
                { target: 'features', label: 'Tính năng' },
                { target: 'workflow', label: 'Workflow' },
                { target: 'integration', label: 'Tích hợp' },
                { target: 'how-it-works', label: 'Hướng dẫn' },
              ].map((link) => (
                <li key={link.target}>
                  <button
                    onClick={() => document.getElementById(link.target)?.scrollIntoView({ behavior: 'smooth' })}
                    className="text-slate-600 hover:text-slate-950 text-sm transition-colors no-underline bg-transparent border-none cursor-pointer p-0"
                  >
                    {link.label}
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <h4 className="text-sm font-semibold text-slate-950 mb-4 uppercase tracking-wider">Hỗ trợ</h4>
            <ul className="space-y-2.5">
              <li>
                <button
                  onClick={() => document.getElementById('faq')?.scrollIntoView({ behavior: 'smooth' })}
                  className="text-slate-600 hover:text-slate-950 text-sm transition-colors no-underline bg-transparent border-none cursor-pointer p-0"
                >
                  FAQ
                </button>
              </li>
              {[
                { href: 'https://github.com/babyvibe/deplao-builder/issues', label: 'Báo lỗi' },
              ].map((link) => (
                <li key={link.label}>
                  <a href={link.href} className="text-slate-600 hover:text-slate-950 text-sm transition-colors no-underline">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="section-divider mb-6" />

        <div className="flex flex-col md:flex-row items-center justify-between gap-4 text-sm text-slate-500">
          <p>© {year} Deplao. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <Link to="/terms" className="hover:text-slate-900 transition-colors no-underline">Chính sách bảo mật</Link>
            <Link to="/terms" className="hover:text-slate-900 transition-colors no-underline">Điều khoản sử dụng</Link>
          </div>
        </div>
      </div>
    </footer>
  );
};

export default Footer;

