/**
 * Voice notes recorded in the app (Chromium MediaRecorder: WebM / Opus) in the formats chat apps play as voice messages:
 * OGG / Opus (WhatsApp-style encrypted Messenger chats) and M4A / AAC (ordinary Messenger voice clips). ffmpeg runs as a
 * child process (never blocks the main thread); any failure returns the original file.
 */
import fs from 'fs';
import Logger from '../../utils/Logger';

/** ffmpeg bundled with the app (ffmpeg-static; the packaged copy lives outside the asar); else ffmpeg on the machine. */
export function ffmpegBinary(): string {
  try {
    let bin = require('ffmpeg-static') as string;
    if (bin && bin.includes('app.asar') && !bin.includes('app.asar.unpacked')) bin = bin.replace('app.asar', 'app.asar.unpacked');
    if (bin && fs.existsSync(bin)) return bin;
  } catch {}
  return 'ffmpeg';
}

/** Duration (s) from an ffmpeg log: "Duration: hh:mm:ss.xx", else the last "time=" mark (Chromium recordings have none). */
export function ffmpegDurationSeconds(log: string): number {
  const toSeconds = (h: string, m: string, sec: string) => Number(h) * 3600 + Number(m) * 60 + Number(sec);
  const declared = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(log);
  if (declared) return Math.max(1, Math.round(toSeconds(declared[1], declared[2], declared[3])));
  const progress = [...log.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)].pop();
  return progress ? Math.max(1, Math.round(toSeconds(progress[1], progress[2], progress[3]))) : 0;
}

export interface PreparedVoiceNote {
  path: string;
  mimeType: string;
  durationSec: number;
  /** false = conversion failed, path is the original file. */
  converted: boolean;
}

function runFfmpeg(args: string[]): Promise<{ ok: boolean; log: string }> {
  const { execFile } = require('child_process') as typeof import('child_process');
  return new Promise((resolve) => {
    execFile(ffmpegBinary(), args, { timeout: 60_000, windowsHide: true }, (err, _stdout, stderr) => {
      resolve({ ok: !err, log: String(stderr || '') });
    });
  });
}

function sibling(inputPath: string, suffix: string): string {
  return inputPath.replace(/\.[^.\\/]+$/, '') + suffix;
}

/** OGG / Opus: change the container without re-encoding; encode at 32 kb/s when that fails. */
export async function prepareOggVoiceNote(inputPath: string, originalMime = 'audio/webm'): Promise<PreparedVoiceNote> {
  const out = sibling(inputPath, '.voice.ogg');
  let result = await runFfmpeg(['-y', '-hide_banner', '-i', inputPath, '-vn', '-c:a', 'copy', out]);
  if (!result.ok || !fs.existsSync(out)) {
    result = await runFfmpeg(['-y', '-hide_banner', '-i', inputPath, '-vn', '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', out]);
  }
  if (!result.ok || !fs.existsSync(out)) {
    Logger.warn(`[voiceNotes] OGG conversion failed: ${result.log.slice(-200)}`);
    return { path: inputPath, mimeType: originalMime, durationSec: ffmpegDurationSeconds(result.log), converted: false };
  }
  return { path: out, mimeType: 'audio/ogg; codecs=opus', durationSec: ffmpegDurationSeconds(result.log), converted: true };
}

/** M4A / AAC mono 64 kb/s (Messenger's own voice clips). */
export async function prepareM4aVoiceNote(inputPath: string, originalMime = 'audio/webm'): Promise<PreparedVoiceNote> {
  const out = sibling(inputPath, '.voice.m4a');
  const result = await runFfmpeg(['-y', '-hide_banner', '-i', inputPath, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out]);
  if (!result.ok || !fs.existsSync(out)) {
    Logger.warn(`[voiceNotes] M4A conversion failed: ${result.log.slice(-200)}`);
    return { path: inputPath, mimeType: originalMime, durationSec: ffmpegDurationSeconds(result.log), converted: false };
  }
  return { path: out, mimeType: 'audio/mp4', durationSec: ffmpegDurationSeconds(result.log), converted: true };
}

/** Delete a converted temp file (never the original). */
export function removeConverted(note: PreparedVoiceNote | null | undefined): void {
  if (!note?.converted) return;
  fs.promises.unlink(note.path).catch(() => {});
}
