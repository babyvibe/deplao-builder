import { DOWNLOAD_URL, DOWNLOAD_URL_MAC_ARM64, APP_VERSION, GITHUB_URL, RELEASES_URL } from "../constants";
export default function DownloadCTA() {
  return (
    <section id="download" className="py-24 px-5">
      <div className="mx-auto max-w-3xl text-center">
        <div className="editorial-band rounded-3xl p-10 md:p-14 stellar-panel">
          <div className="mini-kicker mb-4 text-white/70"><span className="w-2 h-2 rounded-full bg-emerald-400 inline-block" />Sẵn sàng</div>
          <h2 className="text-3xl md:text-4xl font-black text-white tracking-tight mb-4">
            Tải Deplao miễn phí<br />ngay hôm nay
          </h2>
          <p className="text-white/70 mb-8 max-w-lg mx-auto">
            Mã nguồn mở. Dữ liệu lưu cục bộ 100%. Không subscription, không yêu cầu tài khoản cloud.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <a href={DOWNLOAD_URL} className="flex items-center gap-2 px-6 py-3 rounded-xl bg-white text-slate-900 font-bold text-sm hover:bg-white/90 transition-colors no-underline">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 9l3 3 3-3M12 12V4"/></svg>
              🪟 Windows · v{APP_VERSION}
            </a>
            <a href={DOWNLOAD_URL_MAC_ARM64} className="flex items-center gap-2 px-6 py-3 rounded-xl bg-white/10 border border-white/20 text-white font-bold text-sm hover:bg-white/20 transition-colors no-underline">
              <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M18.7 12.4c0-2.9 2.3-4.3 2.4-4.4-1.3-1.9-3.3-2.1-4.1-2.2-1.7-.2-3.4 1-4.3 1-.9 0-2.3-1-3.8-1-1.9 0-3.7 1.1-4.7 2.9-2 3.5-.5 8.6 1.4 11.4 1 1.4 2.1 2.9 3.6 2.9 1.4-.1 2-.9 3.7-.9 1.7 0 2.2.9 3.7.9 1.6 0 2.6-1.4 3.6-2.8.7-1 1.3-2.1 1.5-3.3-3.3-1.3-3.1-5.4.0-5.5z"/><path d="M15.6 4.2c.8-1 1.3-2.4 1.2-3.7-1.2.1-2.5.8-3.3 1.8-.7.9-1.3 2.2-1.1 3.5 1.3 0 2.5-.7 3.2-1.6z"/></svg>
              🍎 macOS (M1+) · v{APP_VERSION}
            </a>
          </div>
          <div className="mt-6 flex items-center justify-center gap-4 text-sm text-white/50">
            <a href={RELEASES_URL} target="_blank" rel="noopener noreferrer" className="hover:text-white/80 transition-colors no-underline">Tất cả phiên bản →</a>
            <span>·</span>
            <a href={GITHUB_URL} target="_blank" rel="noopener noreferrer" className="hover:text-white/80 transition-colors no-underline flex items-center gap-1">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.438 9.8 8.205 11.387.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.807 5.625-5.479 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.5 24 5.87 18.627.5 12 .5z"/></svg>
              Source code
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}
