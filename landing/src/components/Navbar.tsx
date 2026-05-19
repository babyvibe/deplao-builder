import { useState, useCallback } from 'react';
import logo from '../logo/icon.png';
import { DOWNLOAD_URL, DOWNLOAD_URL_MAC_ARM64, DOWNLOAD_URL_MAC_X64 } from '../constants';
import DownloadDropdown from './DownloadDropdown';

const navLinks = [
  { target: 'features', label: 'Tính năng' },
  { target: 'workflow', label: 'Workflow' },
  { target: 'integration', label: 'Tích hợp' },
  { target: 'how-it-works', label: 'Hướng dẫn' },
  // FREE_MODE_TEMP: tạm ẩn bảng giá, giữ link cũ để mở lại nhanh
  // { target: 'pricing', label: 'Bảng giá' },
  { target: 'faq', label: 'FAQ' },
];

const Navbar: React.FC = () => {
  const [menuOpen, setMenuOpen] = useState(false);

  const scrollToSection = useCallback((sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }, []);

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 border-b border-slate-200/80 bg-white/88 backdrop-blur-2xl shadow-[0_10px_28px_rgba(15,23,42,0.06)]">
      <div className="max-w-7xl mx-auto px-6 h-[72px] flex items-center justify-between">
        {/* Logo */}
        <button onClick={() => scrollToSection('hero')} className="flex items-center gap-3 no-underline group bg-transparent border-none cursor-pointer">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-white shadow-[0_10px_24px_rgba(15,23,42,0.08)] ring-1 ring-slate-200">
            <img src={logo} alt="Deplao" className="w-8 h-8 rounded-lg object-contain group-hover:scale-105 transition-transform" />
          </div>
          <div className="text-left">
            <span className="block font-bold text-lg text-slate-900 tracking-tight">Deplao</span>
            <span className="block text-[11px] font-medium uppercase tracking-[0.24em] text-slate-400">operator workspace</span>
          </div>
        </button>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-6">
          {navLinks.map((link) => (
            <button
              key={link.target}
              onClick={() => scrollToSection(link.target)}
              className="text-sm font-medium text-slate-500 hover:text-slate-900 transition-colors duration-200 no-underline bg-transparent border-none cursor-pointer"
            >
              {link.label}
            </button>
          ))}
        </div>

        {/* CTA — dùng DownloadDropdown chung */}
        <div className="hidden md:flex items-center gap-3">
          <DownloadDropdown
            label="Tải xuống"
            variant="primary"
            align="right"
            className="px-4 py-2 text-sm"
          />
        </div>

        {/* Mobile menu button */}
        <button
          onClick={() => setMenuOpen(!menuOpen)}
          className="md:hidden p-2 rounded-xl text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors"
          aria-label="Toggle menu"
        >
          {menuOpen ? (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden border-t border-slate-200/80 bg-white/80 px-6 py-4 space-y-3 backdrop-blur-2xl">
          {navLinks.map((link) => (
            <button
              key={link.target}
              onClick={() => { scrollToSection(link.target); setMenuOpen(false); }}
              className="block text-slate-600 hover:text-slate-900 py-2 text-sm font-medium no-underline bg-transparent border-none cursor-pointer w-full text-left"
            >
              {link.label}
            </button>
          ))}
          <div className="border-t border-slate-200 pt-3 space-y-2">
            <a href={DOWNLOAD_URL} download onClick={() => setMenuOpen(false)}
              className="flex items-center gap-3 py-2.5 px-3 rounded-2xl text-sm font-semibold text-white no-underline shadow-[0_16px_35px_rgba(79,70,229,0.2)]"
              style={{ background: 'linear-gradient(135deg, #4f46e5, #0ea5e9)' }}>
              <span>🪟</span> Tải Windows (.exe)
            </a>
            <a href={DOWNLOAD_URL_MAC_ARM64} download onClick={() => setMenuOpen(false)}
              className="flex items-center gap-3 py-2.5 px-3 rounded-2xl text-sm font-semibold text-slate-700 no-underline bg-slate-50 hover:bg-white border border-slate-200">
              <span>🍎</span> macOS Apple Silicon
            </a>
            <a href={DOWNLOAD_URL_MAC_X64} download onClick={() => setMenuOpen(false)}
              className="flex items-center gap-3 py-2.5 px-3 rounded-2xl text-sm font-semibold text-slate-700 no-underline bg-slate-50 hover:bg-white border border-slate-200">
              <span>🍎</span> macOS Intel
            </a>
          </div>
        </div>
      )}
    </nav>
  );
};

export default Navbar;

