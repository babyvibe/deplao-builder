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
  if (renderText) return <>{renderText()}</>;

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


