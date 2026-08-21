import React from 'react';
import { MessageBubble } from './MessageBubbles';

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
  inlineButtons?: Array<Array<{ text: string; type: 'url' | 'webview' | 'callback'; url?: string }>>;
  onInlineButtonClick?: (button: { text: string; type: string; url?: string }) => void;
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
      <div className="mt-1 flex flex-col gap-1">
        {inlineButtons.map((row, rowIdx) => (
          <div key={rowIdx} className="flex flex-wrap gap-1">
            {row.map((btn, btnIdx) => (
              <button
                key={btnIdx}
                onClick={() => onInlineButtonClick?.(btn)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-blue-500/50 text-blue-400 hover:bg-blue-500/10 transition-colors"
              >
                {btn.text}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}


