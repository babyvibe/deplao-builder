/**
 * Mini App của bot Telegram chạy trong app, như Telegram (Web / Desktop):
 *  - Link lấy từ Telegram (requestWebView / requestMainWebView) đã kèm initData của tài khoản → Mini App tự đăng nhập.
 *  - Iframe + postMessage như Telegram Web (SDK telegram-web-app.js tự nhận ra), cầu sự kiện ở
 *    lib/chat/telegram/telegramMiniAppBridge: nút chính / nút phụ, quay lại, cài đặt, popup, màu đầu / nền, CloudStorage
 *    (bots.invokeWebViewCustomMethod), xin quyền nhắn tin, chia sẻ số điện thoại; link mở bằng trình duyệt của máy.
 *    Tính năng chưa có (toàn màn hình, sinh trắc, quét QR, thanh toán…) trả "không hỗ trợ" ngay để Mini App không treo.
 *  - Mini App là trang web khác origin: không chạm được giao diện hay electronAPI; popup / link mở ở trình duyệt máy.
 *  - Mở từ nút trong tin / menu bot: gia hạn phiên (prolongWebView) mỗi 60 s, hết phiên thì đóng.
 *  - Link t.me trong Mini App mở ngay trong app (lib/chat/links/chatLinks) và Mini App tự thu gọn xuống góc (vẫn chạy),
 *    bấm để mở lại. Mini App theo tên (t.me/<bot>/<app>): bot mới / xin quyền nhắn tin thì hỏi trước khi mở.
 * Đặt 1 lần ở App (TelegramMiniAppHost), mở bằng openTelegramMiniApp() / openTelegramUrlAuth().
 */
import React from 'react';
import {
  ArrowLeftIcon, CloseIcon, MaximizeIcon, MinimizeIcon, MinusIcon, RefreshIcon, SettingsIcon,
} from '@/components/common/icons';
import { Button, Checkbox } from '@/components/ui';
import { pluginTheme } from '@/components/plugins/runtime/pluginTheme';
import ipc from '@/lib/ipc';
import { useAppStore } from '@/store/app/appStore';
import {
  closeTelegramMiniApp, closeTelegramUrlAuth, useTelegramMiniAppRequest, useTelegramUrlAuthRequest, type MiniAppRequest,
} from '@/lib/chat/telegram/telegramMiniApp';
import { openChatLink } from '@/lib/chat/links/chatLinks';
import { openExternalLink } from '@/lib/chat/links/externalLink';
import {
  HIDDEN_MINI_APP_BUTTON, MINI_APP_ZERO_INSETS, createRateLimiter, miniAppButton, miniAppColor, miniAppCustomCall,
  miniAppHeaderColor, miniAppLinkUrl, miniAppPopup, miniAppTgLink, miniAppThemeFromVars, parseMiniAppEvent, textColorOn,
  unsupportedReply, type MiniAppButton, type MiniAppEvent, type MiniAppPopup,
} from '@/lib/chat/telegram/telegramMiniAppBridge';
import TelegramUrlAuthDialog from './TelegramUrlAuthDialog';

export function TelegramMiniAppHost() {
  const miniApp = useTelegramMiniAppRequest();
  const urlAuth = useTelegramUrlAuthRequest();
  return (
    <>
      {miniApp && <TelegramMiniApp key={miniApp.key} request={miniApp} onClose={closeTelegramMiniApp} />}
      {urlAuth && <TelegramUrlAuthDialog key={urlAuth.key} request={urlAuth} onClose={closeTelegramUrlAuth} />}
    </>
  );
}

type Prompt =
  | { kind: 'popup'; popup: MiniAppPopup }
  | { kind: 'write_access' }
  | { kind: 'phone' }
  | { kind: 'close' };

const PROLONG_MS = 60_000;
/** Iframe: script + origin riêng của Mini App (cookie / bộ nhớ của nó), form, popup (main mở bằng trình duyệt máy). */
const FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals';

interface BotAppInfo { id: string; accessHash: string; title: string; description: string; requestWriteAccess: boolean }
type WebViewResult = { success: boolean; webViewUrl?: string; queryId?: string; error?: string } | undefined;

function TelegramMiniApp({ request, onClose }: { request: MiniAppRequest; onClose: () => void }) {
  const mode = useAppStore((s) => s.theme);
  const notify = useAppStore((s) => s.showNotification);
  const theme = React.useMemo(() => miniAppThemeFromVars(pluginTheme(mode).vars), [mode]);
  const { accountId, botId, peerId } = request;
  const title = request.botName || 'Mini App';

  const [webView, setWebView] = React.useState<{ url: string; queryId: string } | null>(null);
  const [error, setError] = React.useState('');
  const [ready, setReady] = React.useState(false);
  const [frameKey, setFrameKey] = React.useState(0);
  const [large, setLarge] = React.useState(false);
  const [mainButton, setMainButton] = React.useState<MiniAppButton>(HIDDEN_MINI_APP_BUTTON);
  const [secondaryButton, setSecondaryButton] = React.useState<MiniAppButton>(HIDDEN_MINI_APP_BUTTON);
  const [backVisible, setBackVisible] = React.useState(false);
  const [settingsVisible, setSettingsVisible] = React.useState(false);
  const [headerColor, setHeaderColor] = React.useState<string | null>(null);
  const [bgColor, setBgColor] = React.useState<string | null>(null);
  const [bottomBarColor, setBottomBarColor] = React.useState<string | null>(null);
  const [prompt, setPrompt] = React.useState<Prompt | null>(null);
  /** Thu gọn xuống góc (Mini App vẫn chạy): tự thu gọn khi link t.me trong Mini App mở hội thoại / hộp trong app. */
  const [minimized, setMinimized] = React.useState(false);
  /** Mini App theo tên cần hỏi trước khi mở (bot mới / xin quyền nhắn tin). */
  const [appConfirm, setAppConfirm] = React.useState<{ app: BotAppInfo; allowWrite: boolean } | null>(null);

  const iframeRef = React.useRef<HTMLIFrameElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  /** Origin trang đang mở trong khung: chỉ gửi sự kiện cho đúng trang đó. */
  const originRef = React.useRef('');
  const confirmCloseRef = React.useRef(false);
  const themeRef = React.useRef(theme);
  themeRef.current = theme;
  const promptRef = React.useRef(prompt);
  promptRef.current = prompt;
  const backVisibleRef = React.useRef(backVisible);
  backVisibleRef.current = backVisible;
  const limits = React.useRef({
    link: createRateLimiter(1, 1000),
    popup: createRateLimiter(3, 3000),
    custom: createRateLimiter(30, 10_000),
  }).current;

  const post = React.useCallback((eventType: string, eventData?: unknown) => {
    const frame = iframeRef.current?.contentWindow;
    if (!frame || !originRef.current) return;
    try {
      frame.postMessage(JSON.stringify({ eventType, eventData: eventData ?? null }), originRef.current);
    } catch { /* khung đã đóng */ }
  }, []);

  const postViewport = React.useCallback(() => {
    const body = bodyRef.current;
    // Đang thu gọn (khung ẩn, cao 0): không báo, mở lại sẽ báo đúng cỡ
    if (!body || !body.clientHeight) return;
    post('viewport_changed', { height: body.clientHeight, width: body.clientWidth, is_state_stable: true, is_expanded: true });
  }, [post]);

  /** Link Telegram trả về (đã kèm initData) → khung; chỉ https. */
  const applyWebView = React.useCallback((res: WebViewResult) => {
    const url = res?.success ? String(res.webViewUrl || '') : '';
    let origin = '';
    try {
      const parsed = new URL(url);
      if (parsed.protocol === 'https:') origin = parsed.origin;
    } catch { /* không có link */ }
    if (!origin) {
      setError(res?.error ? `Không mở được Mini App: ${res.error}` : 'Không mở được Mini App');
      return;
    }
    originRef.current = origin;
    setWebView({ url, queryId: String(res?.queryId || '') });
  }, []);

  const requestDirectApp = React.useCallback((app: BotAppInfo, writeAllowed: boolean) => ipc.telegramUser?.requestAppWebView?.({
    accountId, botId, peerId, appId: app.id, accessHash: app.accessHash, writeAllowed,
    themeParams: themeRef.current as Record<string, string>,
    ...(request.startParam ? { startParam: request.startParam } : {}),
  }), [accountId, botId, peerId, request.startParam]);

  // ── Link Mini App (Telegram gắn initData của tài khoản) ──
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const api = ipc.telegramUser;
      const themeParams = themeRef.current as Record<string, string>;
      let res: WebViewResult;
      if (request.kind === 'app') {
        const found = await api?.getBotApp?.({ accountId, botId, shortName: request.appName || '' });
        if (cancelled) return;
        if (!found?.success || !found.app) {
          setError(found?.error ? `Không mở được Mini App: ${found.error}` : 'Không mở được Mini App');
          return;
        }
        // Bot mới / xin quyền nhắn tin: hỏi trước (https://core.telegram.org/api/bots/webapps#direct-link-mini-apps)
        if (found.app.inactive || found.app.requestWriteAccess) {
          setAppConfirm({ app: found.app, allowWrite: false });
          return;
        }
        res = await requestDirectApp(found.app, false);
      } else if (request.kind === 'main') {
        res = await api?.requestMainWebView?.({ accountId, botId, peerId, themeParams, ...(request.startParam ? { startParam: request.startParam } : {}) });
      } else {
        res = await api?.requestWebView?.({ accountId, botId, peerId, url: request.url || '', fromBotMenu: request.kind === 'menu', themeParams });
      }
      if (!cancelled) applyWebView(res);
    })().catch((err) => {
      if (!cancelled) setError(`Không mở được Mini App: ${err?.message || err}`);
    });
    return () => { cancelled = true; };
  }, [request, accountId, botId, peerId, applyWebView, requestDirectApp]);

  const confirmDirectApp = () => {
    const pending = appConfirm;
    if (!pending) return;
    setAppConfirm(null);
    requestDirectApp(pending.app, pending.app.requestWriteAccess && pending.allowWrite)
      ?.then(applyWebView)
      .catch((err) => setError(`Không mở được Mini App: ${err?.message || err}`));
  };

  // ── Gia hạn phiên (Mini App mở từ nút / menu có query_id) ──
  React.useEffect(() => {
    const queryId = webView?.queryId;
    if (!queryId) return;
    const timer = setInterval(() => {
      ipc.telegramUser?.prolongWebView?.({ accountId, botId, queryId, peerId })
        .then((res) => {
          if (!res?.expired) return;
          notify('Phiên Mini App đã hết, hãy mở lại', 'info');
          onClose();
        })
        .catch(() => {});
    }, PROLONG_MS);
    return () => clearInterval(timer);
  }, [webView?.queryId, accountId, botId, peerId, notify, onClose]);

  // ── Theme Deplao đổi → báo Mini App ──
  React.useEffect(() => {
    post('theme_changed', { theme_params: theme });
  }, [theme, post]);

  // ── Kích thước khung đổi (phóng to / thu nhỏ, đổi cỡ cửa sổ) ──
  React.useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof ResizeObserver === 'undefined') return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(postViewport, 100);
    });
    observer.observe(body);
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
    };
  }, [postViewport]);

  const requestClose = React.useCallback(() => {
    if (confirmCloseRef.current) setPrompt({ kind: 'close' });
    else onClose();
  }, [onClose]);

  const reload = () => {
    setReady(false);
    setMainButton(HIDDEN_MINI_APP_BUTTON);
    setSecondaryButton(HIDDEN_MINI_APP_BUTTON);
    setBackVisible(false);
    setSettingsVisible(false);
    setHeaderColor(null);
    setBgColor(null);
    setBottomBarColor(null);
    setPrompt(null);
    confirmCloseRef.current = false;
    setFrameKey((key) => key + 1);
  };

  const answerPrompt = (buttonId: string | null) => {
    const current = promptRef.current;
    setPrompt(null);
    if (!current) return;
    if (current.kind === 'popup') {
      post('popup_closed', buttonId === null ? {} : { button_id: buttonId });
    } else if (current.kind === 'write_access') {
      if (buttonId !== 'allow') {
        post('write_access_requested', { status: 'cancelled' });
        return;
      }
      ipc.telegramUser?.miniAppWriteAccess?.({ accountId, botId, action: 'allow' })
        .then((res) => post('write_access_requested', { status: res?.success ? 'allowed' : 'cancelled' }))
        .catch(() => post('write_access_requested', { status: 'cancelled' }));
    } else if (current.kind === 'phone') {
      if (buttonId !== 'share') {
        post('phone_requested', { status: 'cancelled' });
        return;
      }
      ipc.telegramUser?.miniAppSharePhone?.({ accountId, botId })
        .then((res) => {
          post('phone_requested', { status: res?.success ? 'sent' : 'cancelled' });
          if (!res?.success) notify(`Không gửi được số điện thoại${res?.error ? `: ${res.error}` : ''}`, 'error');
        })
        .catch(() => post('phone_requested', { status: 'cancelled' }));
    } else if (buttonId === 'close') {
      onClose();
    }
  };

  const requestWriteAccess = () => {
    ipc.telegramUser?.miniAppWriteAccess?.({ accountId, botId, action: 'check' })
      .then((res) => {
        if (res?.success && res.allowed) post('write_access_requested', { status: 'allowed' });
        else if (promptRef.current) post('write_access_requested', { status: 'cancelled' });
        else setPrompt({ kind: 'write_access' });
      })
      .catch(() => post('write_access_requested', { status: 'cancelled' }));
  };

  const invokeCustomMethod = (data: any) => {
    const call = miniAppCustomCall(data);
    const reqId = typeof data?.req_id === 'string' ? data.req_id : '';
    if (!call) {
      if (reqId) post('custom_method_invoked', { req_id: reqId, error: 'PARAMS_INVALID' });
      return;
    }
    if (!limits.custom()) {
      post('custom_method_invoked', { req_id: call.reqId, error: 'FLOOD_WAIT' });
      return;
    }
    ipc.telegramUser?.miniAppCustomMethod?.({ accountId, botId, method: call.method, params: call.params })
      .then((res) => post('custom_method_invoked', res?.success
        ? { req_id: call.reqId, result: res.result }
        : { req_id: call.reqId, error: res?.error || 'UNKNOWN_ERROR' }))
      .catch((err) => post('custom_method_invoked', { req_id: call.reqId, error: String(err?.message || err) }));
  };

  const handleEvent = (event: MiniAppEvent) => {
    const data = event.eventData && typeof event.eventData === 'object' ? event.eventData : {};
    switch (event.eventType) {
      case 'iframe_ready':
        post('theme_changed', { theme_params: themeRef.current });
        postViewport();
        post('safe_area_changed', MINI_APP_ZERO_INSETS);
        post('content_safe_area_changed', MINI_APP_ZERO_INSETS);
        return;
      case 'iframe_will_reload': setReady(false); return;
      case 'web_app_ready': setReady(true); return;
      case 'web_app_expand': return;
      case 'web_app_request_theme': post('theme_changed', { theme_params: themeRef.current }); return;
      case 'web_app_request_viewport': postViewport(); return;
      case 'web_app_request_safe_area': post('safe_area_changed', MINI_APP_ZERO_INSETS); return;
      case 'web_app_request_content_safe_area': post('content_safe_area_changed', MINI_APP_ZERO_INSETS); return;
      case 'web_app_setup_main_button': setMainButton(miniAppButton(data)); return;
      case 'web_app_setup_secondary_button': setSecondaryButton(miniAppButton(data)); return;
      case 'web_app_setup_back_button': setBackVisible(data.is_visible === true); return;
      case 'web_app_setup_settings_button': setSettingsVisible(data.is_visible === true); return;
      case 'web_app_setup_closing_behavior': confirmCloseRef.current = data.need_confirmation === true; return;
      case 'web_app_set_header_color': setHeaderColor(miniAppHeaderColor(data, themeRef.current)); return;
      case 'web_app_set_background_color': setBgColor(miniAppColor(data)); return;
      case 'web_app_set_bottom_bar_color': setBottomBarColor(miniAppColor(data)); return;
      case 'web_app_close': onClose(); return;
      case 'web_app_open_link': {
        const url = miniAppLinkUrl(data);
        if (url && limits.link()) openExternalLink(url);
        return;
      }
      case 'web_app_open_tg_link': {
        // Link t.me: mở trong app (hội thoại, hộp tham gia, Mini App khác…), Mini App thu gọn để thấy hội thoại
        const url = miniAppTgLink(data);
        if (url && limits.link() && openChatLink(url, { accountId })) setMinimized(true);
        return;
      }
      case 'web_app_open_popup': {
        if (promptRef.current) return;
        const popup = miniAppPopup(data);
        if (!popup) post('popup_closed', {});
        else if (limits.popup()) setPrompt({ kind: 'popup', popup });
        return;
      }
      case 'web_app_request_write_access': requestWriteAccess(); return;
      case 'web_app_request_phone':
        if (promptRef.current) post('phone_requested', { status: 'cancelled' });
        else setPrompt({ kind: 'phone' });
        return;
      case 'web_app_invoke_custom_method': invokeCustomMethod(data); return;
      default: {
        const reply = unsupportedReply(event);
        if (reply) post(reply.eventType, reply.eventData);
      }
    }
  };
  const handleEventRef = React.useRef(handleEvent);
  handleEventRef.current = handleEvent;

  // ── Sự kiện từ Mini App: chỉ khung của nó, đúng dạng SDK Telegram ──
  React.useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      const frame = iframeRef.current?.contentWindow;
      if (!frame || ev.source !== frame) return;
      const event = parseMiniAppEvent(ev.data);
      if (!event) return;
      if (typeof ev.origin === 'string' && ev.origin.startsWith('https://')) originRef.current = ev.origin;
      handleEventRef.current(event);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // ── Esc: đóng popup → nút quay lại của Mini App → đóng Mini App ──
  const answerPromptRef = React.useRef(answerPrompt);
  answerPromptRef.current = answerPrompt;
  const minimizedRef = React.useRef(minimized);
  minimizedRef.current = minimized;
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || minimizedRef.current) return;
      e.preventDefault();
      if (promptRef.current) answerPromptRef.current(null);
      else if (backVisibleRef.current) post('back_button_pressed');
      else requestClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [post, requestClose]);

  const headerBg = headerColor || theme.header_bg_color || theme.bg_color;
  const headerFg = headerColor ? textColorOn(headerColor) : undefined;
  const showBottom = mainButton.visible || secondaryButton.visible;

  return (
    <>
    {/* Thu gọn: khung ẩn nhưng vẫn giữ (iframe chạy tiếp), viên nhỏ ở góc để mở lại */}
    <div className={`fixed inset-0 z-50 items-center justify-center bg-black/60 ${minimized ? 'hidden' : 'flex'}`} role="dialog" aria-modal="true" aria-label={title}>
      <div
        className="relative flex flex-col overflow-hidden rounded-2xl border border-border shadow-2xl transition-[width,height] duration-150"
        style={{
          width: large ? 'min(1100px, 94vw)' : 'min(420px, 94vw)',
          height: large ? '92vh' : 'min(86vh, 760px)',
          background: bgColor || theme.bg_color,
        }}
      >
        <div
          className="flex h-11 flex-shrink-0 items-center gap-0.5 border-b border-border px-1.5 text-foreground"
          style={{ background: headerBg, ...(headerFg ? { color: headerFg } : {}) }}
        >
          {backVisible && (
            <HeaderButton label="Quay lại" onClick={() => post('back_button_pressed')}><ArrowLeftIcon size={4} /></HeaderButton>
          )}
          <span className="min-w-0 flex-1 truncate px-2 text-sm font-semibold">{title}</span>
          {settingsVisible && (
            <HeaderButton label="Cài đặt" onClick={() => post('settings_button_pressed')}><SettingsIcon size={4} /></HeaderButton>
          )}
          <HeaderButton label="Tải lại" onClick={reload} disabled={!webView}><RefreshIcon size={4} /></HeaderButton>
          <HeaderButton label={large ? 'Thu nhỏ' : 'Phóng to'} onClick={() => setLarge((v) => !v)}>
            {large ? <MinimizeIcon size={4} /> : <MaximizeIcon size={4} />}
          </HeaderButton>
          <HeaderButton label="Thu gọn" onClick={() => setMinimized(true)}><MinusIcon size={4} /></HeaderButton>
          <HeaderButton label="Đóng" onClick={requestClose}><CloseIcon size={4} /></HeaderButton>
        </div>

        <div ref={bodyRef} className="relative min-h-0 flex-1">
          {webView && (
            <iframe
              key={frameKey}
              ref={iframeRef}
              src={webView.url}
              title={title}
              className="absolute inset-0 h-full w-full border-0"
              sandbox={FRAME_SANDBOX}
              allow="clipboard-write"
              onLoad={() => setReady(true)}
            />
          )}
          {appConfirm && !webView && (
            <div className="absolute inset-0 flex items-center justify-center p-6" style={{ background: bgColor || theme.bg_color }}>
              <div className="w-full max-w-[340px] rounded-xl border border-border bg-popover p-4 shadow-xl">
                <p className="text-sm font-semibold text-foreground">Mở {appConfirm.app.title}?</p>
                <p className="mt-1 text-xs text-muted-foreground">Mini App của {title}</p>
                {appConfirm.app.description && (
                  <p className="mt-2 line-clamp-4 whitespace-pre-wrap text-xs text-foreground/80">{appConfirm.app.description}</p>
                )}
                {appConfirm.app.requestWriteAccess && (
                  <Checkbox
                    className="mt-3"
                    checked={appConfirm.allowWrite}
                    onCheckedChange={(allowWrite) => setAppConfirm((current) => (current ? { ...current, allowWrite } : current))}
                    label={`Cho ${title} nhắn tin cho bạn`}
                  />
                )}
                <div className="mt-4 flex justify-end gap-2">
                  <Button size="sm" variant="ghost" onClick={onClose}>Huỷ</Button>
                  <Button size="sm" onClick={confirmDirectApp}>Mở</Button>
                </div>
              </div>
            </div>
          )}
          {!ready && !error && !appConfirm && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3" style={{ background: bgColor || theme.bg_color }}>
              <span className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-sm text-muted-foreground">Đang mở {title}…</span>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button size="sm" variant="secondary" onClick={onClose}>Đóng</Button>
            </div>
          )}
          {prompt && <MiniAppPrompt prompt={prompt} botName={title} onAnswer={answerPrompt} />}
        </div>

        {showBottom && (
          <MiniAppBottomBar
            main={mainButton}
            secondary={secondaryButton}
            theme={theme}
            background={bottomBarColor || theme.bottom_bar_bg_color || theme.bg_color}
            onMain={() => post('main_button_pressed')}
            onSecondary={() => post('secondary_button_pressed')}
          />
        )}
      </div>
    </div>
    {minimized && (
      <div className="fixed bottom-4 right-4 z-50 flex max-w-[280px] items-center gap-1 rounded-full border border-border bg-popover py-1 pl-3 pr-1 text-foreground shadow-xl">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-sm font-medium hover:underline"
          title={`Mở lại ${title}`}
          onClick={() => setMinimized(false)}
        >
          {title}
        </button>
        <HeaderButton label="Mở lại" onClick={() => setMinimized(false)}><MaximizeIcon size={4} /></HeaderButton>
        <HeaderButton label="Đóng" onClick={() => { setMinimized(false); requestClose(); }}><CloseIcon size={4} /></HeaderButton>
      </div>
    )}
    </>
  );
}

function HeaderButton({ label, onClick, disabled, children }: {
  label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg opacity-80 transition hover:bg-foreground/10 hover:opacity-100 disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function MiniAppBottomBar({ main, secondary, theme, background, onMain, onSecondary }: {
  main: MiniAppButton;
  secondary: MiniAppButton;
  theme: ReturnType<typeof miniAppThemeFromVars>;
  background?: string;
  onMain: () => void;
  onSecondary: () => void;
}) {
  const both = main.visible && secondary.visible;
  const vertical = both && (secondary.position === 'top' || secondary.position === 'bottom');
  const secondaryFirst = secondary.position === 'left' || secondary.position === 'top';
  // Màu mặc định như Telegram: nút chính = button_color / button_text_color; nút phụ = bottom_bar_bg_color / button_color
  const mainEl = main.visible ? (
    <MiniAppActionButton key="main" button={main} background={main.color || theme.button_color} color={main.textColor || theme.button_text_color} onClick={onMain} />
  ) : null;
  const secondaryEl = secondary.visible ? (
    <MiniAppActionButton key="secondary" button={secondary} background={secondary.color || theme.bottom_bar_bg_color} color={secondary.textColor || theme.button_color} onClick={onSecondary} outline />
  ) : null;
  return (
    <div className={`flex flex-shrink-0 gap-2 border-t border-border p-2 ${vertical ? 'flex-col' : 'flex-row'}`} style={{ background }}>
      {secondaryFirst ? [secondaryEl, mainEl] : [mainEl, secondaryEl]}
    </div>
  );
}

function MiniAppActionButton({ button, background, color, onClick, outline }: {
  button: MiniAppButton; background?: string; color?: string; onClick: () => void; outline?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={!button.active || button.progress}
      onClick={onClick}
      className={`flex h-10 min-w-0 flex-1 items-center justify-center rounded-xl px-4 text-sm font-semibold transition-opacity hover:opacity-90 disabled:opacity-60${outline ? ' border border-border' : ''}`}
      style={{ background, color }}
    >
      {button.progress
        ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        : <span className="truncate">{button.text}</span>}
    </button>
  );
}

function MiniAppPrompt({ prompt, botName, onAnswer }: {
  prompt: Prompt; botName: string; onAnswer: (buttonId: string | null) => void;
}) {
  const content: { title?: string; message: string; buttons: Array<{ id: string; type: string; text: string }> } = prompt.kind === 'popup'
    ? { title: prompt.popup.title, message: prompt.popup.message, buttons: prompt.popup.buttons }
    : prompt.kind === 'write_access'
      ? {
        title: botName,
        message: `${botName} muốn được gửi tin nhắn cho bạn trên Telegram.`,
        buttons: [{ id: 'cancel', type: 'cancel', text: 'Không' }, { id: 'allow', type: 'default', text: 'Cho phép' }],
      }
      : prompt.kind === 'phone'
        ? {
          title: botName,
          message: `${botName} muốn biết số điện thoại của bạn. Deplao sẽ gửi số của tài khoản Telegram này cho bot.`,
          buttons: [{ id: 'cancel', type: 'cancel', text: 'Không' }, { id: 'share', type: 'default', text: 'Chia sẻ' }],
        }
        : {
          title: 'Đóng Mini App?',
          message: 'Thay đổi bạn vừa làm có thể chưa được lưu.',
          buttons: [{ id: 'cancel', type: 'cancel', text: 'Huỷ' }, { id: 'close', type: 'destructive', text: 'Vẫn đóng' }],
        };
  return (
    <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-6" onClick={() => onAnswer(null)}>
      <div
        role="alertdialog"
        aria-label={content.title || botName}
        className="w-full max-w-[320px] rounded-xl border border-border bg-popover p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {content.title && <p className="mb-1 text-sm font-semibold text-foreground">{content.title}</p>}
        <p className="whitespace-pre-wrap break-words text-sm text-foreground/80">{content.message}</p>
        <div className={`mt-4 flex gap-2 ${content.buttons.length > 2 ? 'flex-col' : 'justify-end'}`}>
          {content.buttons.map((button) => (
            <Button
              key={button.id}
              size="sm"
              variant={button.type === 'destructive' ? 'destructive' : button.type === 'cancel' || button.type === 'close' ? 'ghost' : 'primary'}
              onClick={() => onAnswer(button.id)}
            >
              {button.text}
            </Button>
          ))}
        </div>
      </div>
    </div>
  );
}
