import { Link } from "react-router-dom";
import { GITHUB_URL, APP_VERSION } from "../constants";
export default function Footer() {
  return (
    <footer className="border-t border-black/5 bg-white/60 backdrop-blur-xl">
      <div className="mx-auto max-w-6xl px-5 py-10 flex flex-col md:flex-row items-start justify-between gap-8">
        <div className="flex items-center gap-2.5">
          <img src="/deplao-builder/icon.png" alt="Deplao" className="w-8 h-8 rounded-xl object-contain" />
          <div>
            <p className="font-extrabold text-slate-900">Deplao <span className="text-slate-400 font-normal text-sm">v{APP_VERSION}</span></p>
            <p className="text-xs text-slate-400">Open source · Local-first</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-8 text-sm text-slate-500">
          <div className="space-y-2">
            <p className="font-semibold text-slate-700 text-xs uppercase tracking-widest mb-2">Sản phẩm</p>
            <a href="#features" className="block hover:text-slate-900 no-underline transition-colors">Tính năng</a>
            <a href="#workflow" className="block hover:text-slate-900 no-underline transition-colors">Workflow</a>
            <a href="#integrations" className="block hover:text-slate-900 no-underline transition-colors">Tích hợp</a>
            <a href="#how-it-works" className="block hover:text-slate-900 no-underline transition-colors">Cách dùng</a>
          </div>
          <div className="space-y-2">
            <p className="font-semibold text-slate-700 text-xs uppercase tracking-widest mb-2">Tải về</p>
            <a href="https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-Setup-26.4.0.exe" className="block hover:text-slate-900 no-underline transition-colors">🪟 Windows</a>
            <a href="https://github.com/babyvibe/deplao-builder/releases/latest/download/Deplao-26.4.0-arm64.dmg" className="block hover:text-slate-900 no-underline transition-colors">🍎 macOS (M1+)</a>
            <a href="https://github.com/babyvibe/deplao-builder/releases" target="_blank" rel="noopener noreferrer" className="block hover:text-slate-900 no-underline transition-colors">Tất cả phiên bản</a>
          </div>
          <div className="space-y-2">
            <p className="font-semibold text-slate-700 text-xs uppercase tracking-widest mb-2">Hỗ trợ</p>
            <a href={GITHUB_URL + "/issues"} target="_blank" rel="noopener noreferrer" className="block hover:text-slate-900 no-underline transition-colors">Báo lỗi (GitHub)</a>
            <a href="https://t.me/deplao_support" target="_blank" rel="noopener noreferrer" className="block hover:text-slate-900 no-underline transition-colors">Telegram support</a>
            <Link to="/terms" className="block hover:text-slate-900 no-underline transition-colors">Điều khoản</Link>
          </div>
        </div>
      </div>
      <div className="border-t border-black/5 py-5 text-center text-xs text-slate-400">
        © {new Date().getFullYear()} Deplao. Open source under ISC License. ·{" "}
        <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-slate-600 no-underline">GitHub</a>
      </div>
    </footer>
  );
}
