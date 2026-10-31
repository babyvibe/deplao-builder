/**
 * FacebookAttachment.ts
 * Port từ Python _messaging/_attachments.py
 * Upload file đính kèm lên Facebook
 *
 * Lưu ý: Sử dụng manual multipart body để tránh lỗi 0KB do form-data
 * npm package không tương thích với môi trường Electron Node.js.
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as mime from 'mime-types';
import { FBSessionData, FBAttachmentUploadResult } from '../FacebookTypes';
import { strBase } from '../FacebookUtils';
import Logger from '../../../utils/Logger';

const UPLOAD_URL = 'https://upload.facebook.com/ajax/mercury/upload.php';

const USER_AGENTS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_10_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.90 Safari/537.36',
  'Mozilla/5.0 (Windows NT 6.3; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.90 Safari/537.36',
  'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/22.0.1207.1 Safari/537.1',
];

let _uploadReqCounter = 0;

/**
 * Build a single multipart field (text value)
 */
function buildTextPart(boundary: string, name: string, value: string): Buffer {
  return Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
    `${value}\r\n`
  );
}

/**
 * Build a single multipart field (file value)
 */
function buildFilePart(boundary: string, name: string, filename: string, contentType: string, data: Buffer): Buffer {
  // Không dùng Content-Transfer-Encoding - header này không chuẩn trong
  // multipart/form-data và gây lỗi parser của Facebook (file về 0KB).
  const header = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n\r\n`
  );
  const footer = Buffer.from(`\r\n`);
  return Buffer.concat([header, data, footer]);
}

/**
 * Build closing boundary
 */
function buildClosingBoundary(boundary: string): Buffer {
  return Buffer.from(`--${boundary}--\r\n`);
}

/**
 * Upload file đính kèm lên Facebook
 * Trả về attachmentId để dùng khi send message
 */
export async function uploadAttachment(
  dataFB: FBSessionData,
  filePath: string,
  httpsAgent?: any
): Promise<FBAttachmentUploadResult | null> {
  if (!fs.existsSync(filePath)) {
    Logger.error(`[FacebookAttachment] File not found: ${filePath}`);
    return null;
  }

  _uploadReqCounter += 1;
  const reqId = strBase(_uploadReqCounter, 36);
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  let mimeType = (mime.lookup(filePath) || 'application/octet-stream') as string;
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  const fileSize = fileBuffer.length;

  // WebM audio recordings (từ MediaRecorder) có mimeType audio/webm nhưng
  // mime.lookup(filePath) chỉ dùng extension → trả về video/webm cho file .webm.
  // Heuristic: nếu file < 5MB và extension là .webm hoặc .ogg, coi như audio.
  if ((mimeType === 'video/webm' || mimeType === 'video/ogg') && fileSize < 5 * 1024 * 1024) {
    mimeType = mimeType === 'video/webm' ? 'audio/webm' : 'audio/ogg';
  }

  Logger.log(`[FacebookAttachment] Uploading: ${fileName} (${fileSize} bytes, ${mimeType})`);

  // Build multipart body manually - reliable across all Node.js versions
  const boundary = `----WebKitFormBoundary${Math.random().toString(36).slice(2, 12)}`;
  const parts: Buffer[] = [
    buildTextPart(boundary, 'voice_clip', 'false'),
    buildTextPart(boundary, '__a', '1'),
    buildTextPart(boundary, '__req', reqId),
    buildTextPart(boundary, 'fb_dtsg', dataFB.fb_dtsg),
    buildFilePart(boundary, 'upload_0', fileName, mimeType, fileBuffer),
    buildClosingBoundary(boundary),
  ];
  const bodyBuffer = Buffer.concat(parts);

  try {
    const response = await axios.post(UPLOAD_URL, bodyBuffer, {
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(bodyBuffer.length),
        'Referer': 'https://www.facebook.com',
        'Accept': 'text/html',
        'User-Agent': userAgent,
        'Cookie': dataFB.cookieFacebook,
      },
      timeout: 60000,
      maxBodyLength: 100 * 1024 * 1024, // 100MB max
      maxContentLength: 100 * 1024 * 1024, // 100MB max
      ...(httpsAgent ? { httpsAgent } : {}),
    });

    let resultText = response.data as string;
    if (typeof resultText === 'string') {
      resultText = resultText.replace(/for\s*\(;;\);/, '').trim();
    }

    let parsed: any;
    try {
      parsed = typeof resultText === 'string' ? JSON.parse(resultText) : resultText;
    } catch {
      Logger.error(`[FacebookAttachment] Upload failed: cannot parse response - ${String(resultText).slice(0, 200)}`);
      return null;
    }

    const payload = parsed?.payload;

    if (!payload) {
      Logger.error(`[FacebookAttachment] Upload failed: no payload. Response: ${JSON.stringify(parsed).slice(0, 300)}`);
      return null;
    }

    // Parse metadata - FB sometimes returns array, sometimes object keyed by "0"
    let metadata: any = null;
    if (payload?.metadata) {
      if (Array.isArray(payload.metadata)) {
        metadata = payload.metadata[0] || null;
      } else if (typeof payload.metadata === 'object') {
        metadata = payload.metadata['0'] || Object.values(payload.metadata)[0] || null;
      }
    }

    // Fallback: some responses embed attachment directly in payload (no metadata wrapper)
    if (!metadata && payload.attachmentFbid) {
      metadata = { 0: payload.attachmentFbid, 1: null, 2: mimeType, 3: null };
    }

    if (!metadata) {
      Logger.error(`[FacebookAttachment] Upload failed: no metadata. Payload keys: ${Object.keys(payload || {}).join(',')}`);
      return null;
    }

    // Extract attachment info from metadata
    // Quan trọng: dùng local mimeType thay vì values[2] từ FB response,
    // vì FB có thể trả về type sai (ví dụ audio/webm → video/mp4).
    const values = Array.isArray(metadata) ? metadata : Object.values(metadata);
    const attachmentId = values[0];
    const attachmentUrl = (values[3] as string | undefined) || undefined;

    Logger.log(`[FacebookAttachment] Uploaded: ${fileName} (${fileSize} bytes) → id=${attachmentId} type=${mimeType}`);

    return {
      attachmentId: attachmentId as string | number,
      attachmentUrl,
      attachmentType: mimeType,
    };
  } catch (err: any) {
    Logger.error(`[FacebookAttachment] uploadAttachment error: ${err.message}`);
    return null;
  }
}

