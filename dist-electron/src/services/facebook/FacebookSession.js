"use strict";
/**
 * FacebookSession.ts
 * Port từ Python _core/_session.py
 * Khởi tạo Facebook session từ cookie — parse fb_dtsg, jazoest, FacebookID, etc.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.fbHeaders = fbHeaders;
exports.fetchFBHomepage = fetchFBHomepage;
exports.initSession = initSession;
exports.checkCookieAlive = checkCookieAlive;
exports.fetchBasicProfileFromHome = fetchBasicProfileFromHome;
const axios_1 = __importDefault(require("axios"));
const FacebookUtils_1 = require("./FacebookUtils");
const Logger_1 = __importDefault(require("../../utils/Logger"));
const FB_HOME_URL = 'https://www.facebook.com/';
// Parse order: [name, startDelimiter, endDelimiter]
const SESSION_FIELDS = [
    ['fb_dtsg', 'DTSGInitialData",[],{"token":"', '"'],
    ['fb_dtsg_ag', 'async_get_token":"', '"'],
    ['jazoest', 'jazoest=', '"'],
    ['hash', 'hash":"', '"'],
    ['sessionID', 'sessionId":"', '"'],
    ['FacebookID', '"actorID":"', '"'],
    ['clientRevision', 'client_revision":', ','],
];
/**
 * Full browser-like headers cho Facebook requests
 */
function fbHeaders(cookie) {
    return {
        'authority': 'www.facebook.com',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'accept-language': 'vi-VN,vi;q=0.9,en-US;q=0.6,en;q=0.5',
        'cache-control': 'max-age=0',
        'cookie': cookie,
        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'sec-fetch-dest': 'document',
        'sec-fetch-mode': 'navigate',
        'sec-fetch-site': 'same-origin',
        'upgrade-insecure-requests': '1',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    };
}
/**
 * Fetch Facebook homepage HTML với đầy đủ headers
 */
async function fetchFBHomepage(cookie) {
    const response = await axios_1.default.get(FB_HOME_URL, {
        headers: fbHeaders(cookie),
        withCredentials: false,
        timeout: 60000,
    });
    return response.data;
}
/**
 * Khởi tạo session từ cookie string
 * Trả về FBSessionData với tất cả thông tin cần thiết cho mọi request
 */
async function initSession(cookie) {
    const html = await fetchFBHomepage(cookie);
    const result = {};
    for (const [name, start, end] of SESSION_FIELDS) {
        try {
            result[name] = (0, FacebookUtils_1.dataSplit)(html, start, end);
        }
        catch {
            result[name] = `[Unable to parse ${name}]`;
        }
    }
    result.cookieFacebook = cookie;
    return result;
}
/**
 * Kiểm tra cookie có còn sống không
 * Cookie alive = có parse được FacebookID từ homepage
 */
async function checkCookieAlive(cookie) {
    try {
        const data = await initSession(cookie);
        const fbId = data.FacebookID;
        if (!fbId || fbId.includes('Unable to parse') || !fbId.match(/^\d+$/)) {
            return false;
        }
        return true;
    }
    catch (err) {
        Logger_1.default.warn(`[FacebookSession] checkCookieAlive error: ${err.message}`);
        return false;
    }
}
/**
 * Decode HTML entities và Unicode escapes
 */
function decodeHtmlEntities(text) {
    if (!text)
        return text;
    return text
        .replace(/&#039;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}
/**
 * Lấy tên và avatar từ Facebook homepage HTML
 * - Avatar: parse từ thẻ <image xlink:href="..."> trong homepage
 * - Tên: parse từ "NAME":"..." trong homepage HTML
 * @param html  HTML trả về từ facebook.com homepage (cần Accept header đúng)
 */
async function fetchBasicProfileFromHome(html) {
    let name = '';
    let avatarUrl = '';
    // ── Avatar: parse từ thẻ <image xlink:href="..."> trong homepage ──────
    try {
        const imgMatch = html.match(/xlink:href="(https:\/\/scontent[^"]+)"/);
        if (imgMatch?.[1]) {
            avatarUrl = decodeHtmlEntities(imgMatch[1]);
        }
    }
    catch { }
    // Fallback: profile_pic_uri trong JSON
    if (!avatarUrl) {
        try {
            const picMatch = html.match(/"profile_pic_uri":"([^"]+)"/);
            if (picMatch?.[1]) {
                avatarUrl = picMatch[1].replace(/\\\//g, '/');
            }
        }
        catch { }
    }
    // ── Tên: "NAME":"<display name>" từ homepage HTML ─────────────────────
    try {
        const nameMatch = html.match(/"NAME":"(.*?)"/);
        if (nameMatch?.[1] && !nameMatch[1].match(/^\d+$/) && nameMatch[1].length < 100) {
            name = decodeHtmlEntities(nameMatch[1]);
        }
    }
    catch { }
    // Fallback: "SHORT_NAME"
    if (!name) {
        try {
            const shortMatch = html.match(/"SHORT_NAME":"(.*?)"/);
            if (shortMatch?.[1] && !shortMatch[1].match(/^\d+$/) && shortMatch[1].length < 100) {
                name = decodeHtmlEntities(shortMatch[1]);
            }
        }
        catch { }
    }
    return { name, avatarUrl };
}
//# sourceMappingURL=FacebookSession.js.map