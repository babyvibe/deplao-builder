/**
 * Writes media files (images, videos, files, stickers, downloaded avatars) asynchronously, without blocking the main thread.
 *
 * Previously it used fs.writeFileSync: when the disk was busy (the machine was short on RAM and paging to the pagefile, other apps reading and writing a lot),
 * writing a video of several tens of MB blocked the main process for a second, and every IPC (opening a conversation, sending a message…) and other image had to wait.
 *
 * Writes to a temporary `.part` file and then renames it: local-media never serves a file that is still being written (async writes can interleave with the protocol handler),
 * and MediaScanner skips the `.part` extension. If the rename fails (Windows: the target file is held open by another program), it writes directly to the target file as before.
 */
import * as fs from 'fs';

export async function writeMediaFile(filePath: string, data: Buffer | Uint8Array): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.part`;
  try {
    await fs.promises.writeFile(tmpPath, data);
    await fs.promises.rename(tmpPath, filePath);
  } catch {
    await fs.promises.unlink(tmpPath).catch(() => {});
    await fs.promises.writeFile(filePath, data);
  }
}
