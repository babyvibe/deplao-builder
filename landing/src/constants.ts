// ──────────────────────────────────────────────────────────────
//  Landing page — Cấu hình dùng chung
//
//  ⚠️  Khi nâng cấp phiên bản, CHỈ CẦN SỬA APP_VERSION ở đây.
//  Tất cả nút tải xuống sẽ tự cập nhật URL.
// ──────────────────────────────────────────────────────────────

/** Phiên bản hiện tại — đồng bộ với package.json root */
export const APP_VERSION = '26.6.6';

const GH_RELEASES = 'https://github.com/babyvibe/deplao-builder/releases';
const GH_LATEST   = `${GH_RELEASES}/latest/download`;

/** Trang releases GitHub */
export const RELEASES_URL = GH_RELEASES;

/** Trang GitHub repo */
export const GITHUB_URL = 'https://github.com/babyvibe/deplao-builder';

/** Windows — NSIS installer */
export const DOWNLOAD_FILENAME      = `Deplao-Setup-${APP_VERSION}.exe`;
export const DOWNLOAD_URL           = `${GH_LATEST}/${DOWNLOAD_FILENAME}`;

/** macOS — Apple Silicon (M1/M2/M3) */
export const DOWNLOAD_FILENAME_MAC_ARM64 = `Deplao-${APP_VERSION}-arm64.dmg`;
export const DOWNLOAD_URL_MAC_ARM64      = `${GH_LATEST}/${DOWNLOAD_FILENAME_MAC_ARM64}`;

/** macOS — Intel (x64) */
export const DOWNLOAD_FILENAME_MAC_X64 = `Deplao-${APP_VERSION}.dmg`;
export const DOWNLOAD_URL_MAC_X64      = `${GH_LATEST}/${DOWNLOAD_FILENAME_MAC_X64}`;

/** Linux — AppImage (x64, works on any distro) */
export const DOWNLOAD_FILENAME_LINUX   = `Deplao-${APP_VERSION}.AppImage`;
export const DOWNLOAD_URL_LINUX         = `${GH_LATEST}/${DOWNLOAD_FILENAME_LINUX}`;

/** Linux — .deb (Ubuntu/Debian) */
export const DOWNLOAD_FILENAME_LINUX_DEB = `Deplao_${APP_VERSION}_amd64.deb`;
export const DOWNLOAD_URL_LINUX_DEB      = `${GH_LATEST}/${DOWNLOAD_FILENAME_LINUX_DEB}`;
