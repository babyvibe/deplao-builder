import React from 'react';
import { MessageBubble } from './MessageBubbles';

type InlineButton = { text: string; type: 'url' | 'url_auth' | 'webview' | 'callback'; url?: string; buttonId?: number };

/** Inline button under a bot message (Telegram); a button waiting for the bot to answer (callback) shows a spinner and cannot be pressed again. */
function InlineButtonRows({ rows, onClick }: {
  rows: InlineButton[][];
  onClick?: (button: InlineButton, row: number, col: number) => void | Promise<unknown>;
}) {
  const [pending, setPending] = React.useState<string | null>(null);
  return (
    <div className="mt-1 flex flex-col gap-1">
      {rows.map((row, rowIdx) => (
        <div key={rowIdx} className="flex flex-wrap gap-1">
          {row.map((btn, btnIdx) => {
            const key = `${rowIdx}:${btnIdx}`;
            const busy = pending === key;
            return (
              <button
                key={btnIdx}
                disabled={busy}
                onClick={() => {
                  const result = onClick?.(btn, rowIdx, btnIdx);
                  if (result && typeof (result as Promise<unknown>).finally === 'function') {
                    setPending(key);
                    void (result as Promise<unknown>).finally(() => setPending((current) => (current === key ? null : current)));
                  }
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-blue-500/50 text-blue-400 hover:bg-blue-500/10 transition-colors disabled:opacity-70"
              >
                {busy && <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />}
                {btn.text}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

interface SharedMessageContentProps {
  msg: any;
  isSelf: boolean;
  senderName?: string;
  onManage?: () => void;
  onView?: (src: string) => void;
  onOpenProfile?: (userId: string, e: React.MouseEvent) => void;
  isPoll?: boolean;
  isGroupMedia?: boolean;
  isVideo?: boolean;
  isVoice?: boolean;
  isFile?: boolean;
  isMedia?: boolean;
  isCard?: boolean;
  isEcard?: boolean;
  isSticker?: boolean;
  isRtf?: boolean;
  isBankCard?: boolean;
  isLocation?: boolean;
  /** Facebook Page template message (card + button) */
  isFbTemplate?: boolean;
  renderFbTemplate?: () => React.ReactNode;
  /** Zalo Official Account zinstant message (chat.webcontent / .v2): news, notices, promotions */
  isZinstant?: boolean;
  renderZinstant?: () => React.ReactNode;
  renderPoll?: () => React.ReactNode;
  renderGroupMedia?: () => React.ReactNode;
  renderVideo?: () => React.ReactNode;
  renderVoice?: () => React.ReactNode;
  renderFile?: () => React.ReactNode;
  renderMedia?: () => React.ReactNode;
  renderCard?: () => React.ReactNode;
  renderEcard?: () => React.ReactNode;
  renderSticker?: () => React.ReactNode;
  renderRtf?: () => React.ReactNode;
  renderBankCard?: () => React.ReactNode;
  renderText?: () => React.ReactNode;
  inlineButtons?: Array<Array<InlineButton>>;
  /** Press an inline button (row / column of buttons). Returns a Promise when waiting for Telegram: the button shows a spinner until done. */
  onInlineButtonClick?: (button: InlineButton, row: number, col: number) => void | Promise<unknown>;
}

/**
 * Unified message-content renderer used by both ChatWindow and QuickChatModal.
 * Screen-specific message types (poll/group-media) can be injected via render props.
 */
export default function SharedMessageContent({
  msg,
  isSelf,
  senderName,
  onManage,
  onView,
  onOpenProfile,
  isPoll,
  isGroupMedia,
  isVideo,
  isVoice,
  isFile,
  isMedia,
  isCard,
  isEcard,
  isSticker,
  isRtf,
  isBankCard,
  isLocation,
  isFbTemplate,
  renderFbTemplate,
  isZinstant,
  renderZinstant,
  renderPoll,
  renderGroupMedia,
  renderVideo,
  renderVoice,
  renderFile,
  renderMedia,
  renderCard,
  renderEcard,
  renderSticker,
  renderRtf,
  renderBankCard,
  renderText,
  inlineButtons,
  onInlineButtonClick,
}: SharedMessageContentProps) {
  if (isGroupMedia && renderGroupMedia) return <>{renderGroupMedia()}</>;
  if (isPoll && renderPoll) return <>{renderPoll()}</>;
  if (isVideo && renderVideo) return <>{renderVideo()}</>;
  if (isVoice && renderVoice) return <>{renderVoice()}</>;
  if (isFile && renderFile) return <>{renderFile()}</>;
  if (isMedia && renderMedia) return <>{renderMedia()}</>;
  if (isCard && renderCard) return <>{renderCard()}</>;
  if (isBankCard && renderBankCard) return <>{renderBankCard()}</>;
  if (isEcard && renderEcard) return <>{renderEcard()}</>;
  if (isSticker && renderSticker) return <>{renderSticker()}</>;
  if (isRtf && renderRtf) return <>{renderRtf()}</>;
  if (isFbTemplate && renderFbTemplate) return <>{renderFbTemplate()}</>;
  if (isZinstant && renderZinstant) return <>{renderZinstant()}</>;
  if (isLocation) {
    return (
      <MessageBubble
        msg={msg}
        isSelf={isSelf}
        senderName={senderName}
        onManage={onManage}
        onView={onView}
        onOpenProfile={onOpenProfile}
      />
    );
  }
  if (renderText) return <>{renderText()}</>;

  const mainContent = (
    <MessageBubble
      msg={msg}
      isSelf={isSelf}
      senderName={senderName}
      onManage={onManage}
      onView={onView}
      onOpenProfile={onOpenProfile}
    />
  );

  if (!inlineButtons || inlineButtons.length === 0) return mainContent;

  return (
    <div className="flex flex-col">
      {mainContent}
      <InlineButtonRows rows={inlineButtons} onClick={onInlineButtonClick} />
    </div>
  );
}


