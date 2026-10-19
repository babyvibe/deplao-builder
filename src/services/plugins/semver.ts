/**
 * semver.ts — so sánh phiên bản tối giản (MAJOR.MINOR.PATCH[-pre][+build]) cho plugin.
 * Không thêm dependency; đủ cho kiểm tra "bản mới lớn hơn" và minDeplaoVersion.
 */

export interface SemVer {
    major: number;
    minor: number;
    patch: number;
    pre: Array<string | number>;
}

const SEMVER_RE = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(input: string): SemVer | null {
    const m = SEMVER_RE.exec(String(input || '').trim());
    if (!m) return null;
    return {
        major: Number(m[1]),
        minor: Number(m[2]),
        patch: Number(m[3]),
        pre: m[4] ? m[4].split('.').map(p => (/^\d+$/.test(p) ? Number(p) : p)) : [],
    };
}

export function isValidSemver(input: string): boolean {
    return parseSemver(input) !== null;
}

/** -1 nếu a < b, 0 nếu bằng, 1 nếu a > b. Chuỗi sai định dạng coi là nhỏ nhất. */
export function compareSemver(a: string, b: string): number {
    const x = parseSemver(a);
    const y = parseSemver(b);
    if (!x && !y) return 0;
    if (!x) return -1;
    if (!y) return 1;
    for (const k of ['major', 'minor', 'patch'] as const) {
        if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
    }
    // Bản có pre-release nhỏ hơn bản chính thức cùng số.
    if (!x.pre.length && !y.pre.length) return 0;
    if (!x.pre.length) return 1;
    if (!y.pre.length) return -1;
    const len = Math.max(x.pre.length, y.pre.length);
    for (let i = 0; i < len; i++) {
        const p = x.pre[i];
        const q = y.pre[i];
        if (p === undefined) return -1;
        if (q === undefined) return 1;
        if (p === q) continue;
        if (typeof p === 'number' && typeof q === 'number') return p > q ? 1 : -1;
        if (typeof p === 'number') return -1;
        if (typeof q === 'number') return 1;
        return p > q ? 1 : -1;
    }
    return 0;
}
