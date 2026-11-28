import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { RenderErrorBoundary } from './components/app/RenderErrorBoundary';
import './index.css';
import Logger from '../utils/Logger';

// Every import above has loaded and run: main's boot watchdog (electron/app/bootWatchdog.ts) reads this to tell a stalled
// load (reload it) from a slow one (wait)
document.documentElement.dataset.deplaoApp = 'started';

// The UI stays busy for ≥ 1 s (long task: a big render, a burst of events…) → logged as "[Hiệu năng] …" (Performance). Together with
// the "Luồng chính bị chặn" (main thread blocked) message from the main process shows whether the app froze because of the UI or because of main.
try {
  if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 1000) {
          Logger.warn(`[Hiệu năng] Giao diện bận ${(entry.duration / 1000).toFixed(1)} s (${Math.round(entry.startTime / 1000)} s sau khi tải giao diện)`);
        }
      }
    }).observe({ type: 'longtask', buffered: true });
  }
} catch { /* the browser does not support long tasks: skip */ }

// Dragging a file / image and dropping it outside a drop zone (chat frame, composer, library…): Chromium by default opens that file in the
// app window (the UI is lost, dev still reloads the page). Drop zones call preventDefault in dragover; elsewhere the drop is refused.
window.addEventListener('dragover', (event) => {
  if (event.defaultPrevented) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
});
window.addEventListener('drop', (event) => {
  if (!event.defaultPrevented) event.preventDefault();
});

// A render error that no inner boundary catches would make React unmount everything (blank window): show a reload screen
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <RenderErrorBoundary name="app" variant="app">
      <App />
    </RenderErrorBoundary>
  </React.StrictMode>
);

