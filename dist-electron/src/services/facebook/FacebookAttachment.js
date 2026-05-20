"use strict";
/**
 * FacebookAttachment.ts
 * Port từ Python _messaging/_attachments.py
 * Upload file đính kèm lên Facebook
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.uploadAttachment = uploadAttachment;
const axios_1 = __importDefault(require("axios"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const mime = __importStar(require("mime-types"));
const FacebookUtils_1 = require("./FacebookUtils");
const Logger_1 = __importDefault(require("../../utils/Logger"));
const UPLOAD_URL = 'https://upload.facebook.com/ajax/mercury/upload.php';
const USER_AGENTS = [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.90 Safari/537.36',
    'Mozilla/5.0 (Windows NT 6.3; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.90 Safari/537.36',
    'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/22.0.1207.1 Safari/537.1',
];
let _uploadReqCounter = 0;
/**
 * Upload file đính kèm lên Facebook
 * Trả về attachmentId để dùng khi send message
 */
async function uploadAttachment(dataFB, filePath) {
    if (!fs.existsSync(filePath)) {
        Logger_1.default.error(`[FacebookAttachment] File not found: ${filePath}`);
        return null;
    }
    _uploadReqCounter += 1;
    const reqId = (0, FacebookUtils_1.strBase)(_uploadReqCounter, 36);
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
    const mimeType = (mime.lookup(filePath) || 'application/octet-stream');
    const fileName = path.basename(filePath);
    const fileBuffer = fs.readFileSync(filePath);
    // Build multipart form data
    const FormData = (await Promise.resolve().then(() => __importStar(require('form-data')))).default;
    const formData = new FormData();
    formData.append('voice_clip', 'false');
    formData.append('__a', '1');
    formData.append('__req', reqId);
    formData.append('fb_dtsg', dataFB.fb_dtsg);
    formData.append('upload_0', fileBuffer, {
        filename: fileName,
        contentType: mimeType,
    });
    try {
        const response = await axios_1.default.post(UPLOAD_URL, formData, {
            headers: {
                ...formData.getHeaders(),
                'Referer': 'https://www.facebook.com',
                'Accept': 'text/html',
                'User-Agent': userAgent,
                'Cookie': dataFB.cookieFacebook,
            },
            timeout: 60000,
            maxContentLength: 100 * 1024 * 1024, // 100MB max
        });
        let resultText = response.data;
        if (typeof resultText === 'string') {
            resultText = resultText.replace(/for\s*\(;;\);/, '').trim();
        }
        let parsed;
        try {
            parsed = typeof resultText === 'string' ? JSON.parse(resultText) : resultText;
        }
        catch {
            Logger_1.default.error(`[FacebookAttachment] Upload failed: cannot parse response — ${String(resultText).slice(0, 200)}`);
            return null;
        }
        const payload = parsed?.payload;
        if (!payload) {
            Logger_1.default.error(`[FacebookAttachment] Upload failed: no payload. Response: ${JSON.stringify(parsed).slice(0, 300)}`);
            return null;
        }
        // Parse metadata — FB sometimes returns array, sometimes object keyed by "0"
        let metadata = null;
        if (payload?.metadata) {
            if (Array.isArray(payload.metadata)) {
                metadata = payload.metadata[0] || null;
            }
            else if (typeof payload.metadata === 'object') {
                metadata = payload.metadata['0'] || Object.values(payload.metadata)[0] || null;
            }
        }
        // Fallback: some responses embed attachment directly in payload (no metadata wrapper)
        if (!metadata && payload.attachmentFbid) {
            metadata = { 0: payload.attachmentFbid, 1: null, 2: mimeType, 3: null };
        }
        if (!metadata) {
            Logger_1.default.error(`[FacebookAttachment] Upload failed: no metadata. Payload keys: ${Object.keys(payload || {}).join(',')}`);
            return null;
        }
        const values = Array.isArray(metadata) ? metadata : Object.values(metadata);
        const attachmentId = values[0];
        const attachmentUrl = values[3] || undefined;
        const attachmentType = values[2] || mimeType;
        Logger_1.default.log(`[FacebookAttachment] Uploaded: ${fileName} → id=${attachmentId}`);
        return {
            attachmentId: attachmentId,
            attachmentUrl,
            attachmentType,
        };
    }
    catch (err) {
        Logger_1.default.error(`[FacebookAttachment] uploadAttachment error: ${err.message}`);
        return null;
    }
}
//# sourceMappingURL=FacebookAttachment.js.map