/**
 * FacebookAttachment.ts
 * Port từ Python _messaging/_attachments.py
 * Upload file đính kèm lên Facebook
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as mime from 'mime-types';
import { FBSessionData, FBAttachmentUploadResult } from './FacebookTypes';
import { strBase } from './FacebookUtils';
import Logger from '../../utils/Logger';

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
export async function uploadAttachment(
  dataFB: FBSessionData,
  filePath: string
): Promise<FBAttachmentUploadResult | null> {
  if (!fs.existsSync(filePath)) {
    Logger.error(`[FacebookAttachment] File not found: ${filePath}`);
    return null;
  }

  _uploadReqCounter += 1;
  const reqId = strBase(_uploadReqCounter, 36);
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
  const mimeType = (mime.lookup(filePath) || 'application/octet-stream') as string;
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);

  // Build multipart form data
  const FormData = (await import('form-data')).default;
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
    const response = await axios.post(UPLOAD_URL, formData, {
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

    let resultText = response.data as string;
    if (typeof resultText === 'string') {
      resultText = resultText.replace(/for\s*\(;;\);/, '').trim();
    }

    let parsed: any;
    try {
      parsed = typeof resultText === 'string' ? JSON.parse(resultText) : resultText;
    } catch {
      Logger.error(`[FacebookAttachment] Upload failed: cannot parse response — ${String(resultText).slice(0, 200)}`);
      return null;
    }

    const payload = parsed?.payload;

    if (!payload) {
      Logger.error(`[FacebookAttachment] Upload failed: no payload. Response: ${JSON.stringify(parsed).slice(0, 300)}`);
      return null;
    }

    // Parse metadata — FB sometimes returns array, sometimes object keyed by "0"
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

    const values = Array.isArray(metadata) ? metadata : Object.values(metadata);
    const attachmentId = values[0];
    const attachmentUrl = (values[3] as string | undefined) || undefined;
    const attachmentType = (values[2] as string | undefined) || mimeType;

    Logger.log(`[FacebookAttachment] Uploaded: ${fileName} → id=${attachmentId}`);

    return {
      attachmentId: attachmentId as string | number,
      attachmentUrl,
      attachmentType,
    };
  } catch (err: any) {
    Logger.error(`[FacebookAttachment] uploadAttachment error: ${err.message}`);
    return null;
  }
}

