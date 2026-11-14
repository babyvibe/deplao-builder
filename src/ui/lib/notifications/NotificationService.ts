/**
 * NotificationService - handles sound and desktop (OS) notifications
 */

let audioCtx: AudioContext | null = null;

/** Play a pleasant two-tone notification beep using Web Audio API (no external file needed) */
export function playNotificationSound(volume = 0.5) {
  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    // Resume if suspended (browser autoplay policy)
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const ctx = audioCtx;
    const vol = Math.max(0, Math.min(1, volume));

    // Two-tone ding: 880 Hz then 1100 Hz
    const tones = [880, 1100];
    let t = ctx.currentTime + 0.01;
    for (const freq of tones) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(vol * 0.4, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
      osc.start(t);
      osc.stop(t + 0.18);
      t += 0.16;
    }
  } catch (e) {
    console.warn('[NotificationService] playSound error:', e);
  }
}

/** Request OS notification permission (call once at app start) */
export async function requestNotificationPermission(): Promise<boolean> {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

// ─── Notification queue ───────────────────────────────────────────────────────
// The OS limits how many notifications can be shown at once.
// The queue makes sure each notification is shown long enough before the next one.

interface QueueItem {
  title: string;
  body: string;
  icon?: string;
  threadInfo?: { zaloId: string; threadId: string; threadType: number };
}

const notifQueue: QueueItem[] = [];
let notifBusy = false;
// Track the last notification time per thread to group rapid messages
const lastNotifTime: Record<string, number> = {};
// Active notification instance per thread (replaced when a new message arrives in the same thread)
const activeNotifs: Record<string, Notification> = {};

function processQueue() {
  if (notifBusy || notifQueue.length === 0) return;
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  notifBusy = true;
  const item = notifQueue.shift()!;
  const threadKey = item.threadInfo
    ? `${item.threadInfo.zaloId}_${item.threadInfo.threadId}`
    : 'global';

  // Close the old notification of the same thread if it is still showing
  if (activeNotifs[threadKey]) {
    try { activeNotifs[threadKey].close(); } catch {}
    delete activeNotifs[threadKey];
  }

  try {
    const n = new Notification(item.title, {
      body: item.body.length > 120 ? item.body.slice(0, 117) + '…' : item.body,
      icon: item.icon || undefined,
      silent: true,
      // Do NOT use a tag: a tag makes the OS replace instead of stack, which loses notifications
    });

    activeNotifs[threadKey] = n;

    // Keep the ref so onclick can still access it after the timeout closes it
    const threadInfo = item.threadInfo;
    let handled = false;

    if (threadInfo) {
      n.onclick = () => {
        if (handled) return;
        handled = true;
        try { n.close(); } catch {}
        delete activeNotifs[threadKey];
        // Send IPC to open the conversation
        try {
          (window as any).electronAPI?.app?.openThread(threadInfo);
        } catch (e) {
          console.warn('[NotificationService] openThread IPC error:', e);
        }
      };
    }

    // onclose: free the queue slot for the next notification
    n.onclose = () => {
      delete activeNotifs[threadKey];
      notifBusy = false;
      setTimeout(processQueue, 300);
    };

    // Show for 4 seconds, then close automatically
    // onclose handles the next queue item (no need to duplicate it in setTimeout)
    setTimeout(() => {
      try { n.close(); } catch {}
    }, 4000);
  } catch (e) {
    console.warn('[NotificationService] showDesktopNotification error:', e);
    notifBusy = false;
    setTimeout(processQueue, 300);
  }
}

/** Show a desktop (OS) notification that appears in the system tray corner.
 *  Uses a queue to make sure every notification is shown.
 *  Rapid messages from the same thread within 800ms are merged into 1 notification.
 */
export function showDesktopNotification(
  title: string,
  body: string,
  icon?: string,
  threadInfo?: { zaloId: string; threadId: string; threadType: number }
) {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'granted') return;

  const threadKey = threadInfo
    ? `${threadInfo.zaloId}_${threadInfo.threadId}`
    : 'global';

  const now = Date.now();
  const timeSinceLast = now - (lastNotifTime[threadKey] || 0);
  lastNotifTime[threadKey] = now;

  // If a notification of the same thread is already in the queue, replace it instead of adding a new one
  if (timeSinceLast < 800) {
    const existingIdx = notifQueue.findIndex(
      q => q.threadInfo?.threadId === threadInfo?.threadId &&
           q.threadInfo?.zaloId === threadInfo?.zaloId
    );
    if (existingIdx >= 0) {
      // Update the body of the pending notification
      notifQueue[existingIdx].body = body;
      notifQueue[existingIdx].title = title;
      return;
    }
  }

  notifQueue.push({ title, body, icon, threadInfo });
  processQueue();
}
