/**
 * Source of a <video> tag attached / removed in an effect (not through the `src` prop): removed on cleanup so Chromium's player is freed for
 * other videos (each page has a player limit), and attached again each time the effect runs.
 *
 * StrictMode (dev build) runs the cleanup and then re-runs the effect on the SAME <video> tag. When `src` is passed as a prop, the cleanup removes `src` and
 * React does not set it again (the prop does not change) → empty video: an animated Telegram sticker shows only its send time, with no picture.
 */
export function attachVideoSource(video: HTMLVideoElement, src: string): () => void {
  if (src && video.getAttribute('src') !== src) video.setAttribute('src', src);
  return () => {
    video.pause();
    video.removeAttribute('src');
    video.load();
  };
}
