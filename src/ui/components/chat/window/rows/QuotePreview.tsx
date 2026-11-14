/**
 * Quote inside a bubble (click → jump to the original message): the quoted person's name in their color, a thumbnail + caption for
 * photo / sticker messages, otherwise 2 lines of text. quote_data is stored in advance, or the original message is looked up by reply_to_id.
 * Telegram: label + cover image by the type of the quoted message (video, GIF, round video, sticker, voice, file… telegramQuoteMedia).
 */
import { peerColorIndex } from '@/lib/chat/messages/peerStyle';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { getTelegramStickerMedia } from '@/lib/media/mediaResolver';
import { isTelegram } from '@/lib/channels/channelHelper';
import {
  extractMediaUrl, extractQuoteImage, getQuotedMediaCaption, isTelegramQuotePlaceholder, parseQuoteMsg, telegramQuoteMedia,
} from '@/lib/chat/messages/messageParser';
import { isMediaType } from '@/lib/chat/messages/messageTypeUtils';
import { QuotedStickerPreview } from '../../messages/ChatWindowBubbles';
import type { MessageRowContext, RowLocals } from './rowContext';
import { tr } from '../../../../../shared/i18n';

type QuotePreviewProps = { ctx: MessageRowContext } & Pick<RowLocals, 'msg' | 'isSent' | 'quoteShell' | 'isNoBubbleMsg' | 'postEdgeMedia'>;

export function QuotePreview({ ctx, msg, isSent, quoteShell, isNoBubbleMsg, postEdgeMedia }: QuotePreviewProps) {
  const { findMsgById, handleScrollToMsg, resolveQuoteAuthor } = ctx;
  // Build quote object from quote_data or fallback to reply_to_id + msgs lookup
  let q: any;
  if (msg.quote_data) {
    try { q = JSON.parse(msg.quote_data); } catch { q = {}; }
  } else {
    // Fallback: look up original message from msgs by reply_to_id
    const origFromMsgs = findMsgById(msg.reply_to_id);
    q = {
      msgId: msg.reply_to_id,
      msg: origFromMsgs?.content || '',
      senderId: '',
      msgType: origFromMsgs?.msg_type || 'text',
    };
  }

  try {
  //  Prefer the saved imageUrl, then extract from msg/attach
    const quotedImgUrl = q.imageUrl
      || (q.imageLocalPath ? toLocalMediaUrl(q.imageLocalPath) : '')
      || extractQuoteImage(q.msg, q.attach, q.msgType);
    // If there is still no URL, look in the message list by msgId
    let lookupImgUrl = '';
    // When q.msg is empty (e.g. Zalo sends TQuote with msg="" for chat.recommended/cliMsgType=38)
    // → look up the original message to get the content to display
    let lookupContent = '';
    // Content of the original sticker (so QuotedStickerPreview can load the image)
    let quotedStickerContent = '';
    // Content of the original message (takes the caption of the quoted photo / video)
    let origContent = '';
    const isQuotedSticker = q.msgType === 'chat.sticker';
    // Telegram: attachments + sticker image of the original message (old quote_data may lack attach)
    let origAttachments: unknown = null;
    let telegramStickerImg = '';

    if (q.msgId) {
      const origMsg = findMsgById(String(q.msgId));
      if (origMsg) {
        origAttachments = origMsg.attachments;
        if (isTelegram(msg.channel)) {
          const sticker = getTelegramStickerMedia(origMsg);
          // A static sticker that has a file (webp / png); animated stickers (tgs / webm) only show the emoji + "Sticker"
          if (sticker?.localPath && /\.(webp|png)$/i.test(sticker.localPath)) telegramStickerImg = toLocalMediaUrl(sticker.localPath);
        }
        origContent = String(origMsg.content || '');
        // Use the real msg_type from the original message if quote_data falls back wrongly
        if (origMsg.msg_type && origMsg.msg_type !== 'text') {
          q.msgType = origMsg.msg_type;
        }
        if (!quotedImgUrl && isMediaType(origMsg.msg_type, origMsg.content, origMsg.attachments)) {
          lookupImgUrl = extractMediaUrl(origMsg);
        }
        // Get the content from the original message if q.msg is empty
        if (!q.msg && origMsg.content) {
          lookupContent = origMsg.content;
        }
        // Get the sticker content from the original message (even if it is in groupedStickerSkipIds)
        if (isQuotedSticker && origMsg.content) {
          quotedStickerContent = origMsg.content;
        }
      }
    }
    // Fallback sticker content from q.attach or q.msg
    if (isQuotedSticker && !quotedStickerContent) {
      quotedStickerContent = typeof q.attach === 'string'
        ? q.attach
        : (q.attach ? JSON.stringify(q.attach) : (q.msg || ''));
    }
    const tgQuote = isTelegram(msg.channel)
      ? telegramQuoteMedia(q.msgType, q.attach && q.attach !== '[]' ? q.attach : origAttachments)
      : null;
    const tgSticker = !!tgQuote?.sticker && !!telegramStickerImg;
    const finalImgUrl = quotedImgUrl || lookupImgUrl || tgQuote?.thumb || (tgSticker ? telegramStickerImg : '');
    const quoteAuthor = resolveQuoteAuthor(q);
    // Telegram: quote frame in the quoted person's color (left bar + light background + name in the same color); the quoted text
    // long text does not widen the bubble (w-0 min-w-full, only the quoted person's name counts), minimum 13rem, like Telegram
    const quoteSenderId = String(q.senderId || q.ownerId
      || (q.msgId ? findMsgById(String(q.msgId))?.sender_id : '') || '');
    const quotePeer = peerColorIndex(quoteSenderId, quoteAuthor);
    // Use lookupContent to parse the quote if q.msg is empty
    const effectiveMsgForQuote = q.msg || lookupContent;

    // Always compute quoteDisplayText (used as the fallback when the image cannot load)
    let quoteDisplayText = '';
    {
      // Telegram: message text is plain (caption / poll question…), not JSON like Zalo: parseQuoteMsg
      // reading it the Zalo way, a file message loses both its caption and the file name ("[File]")
      const telegramCaption = tgQuote ? String(effectiveMsgForQuote || '').trim() : '';
      const parsedText = tgQuote ? '' : parseQuoteMsg(effectiveMsgForQuote, q.msgType);
      if (tgQuote) {
        const caption = telegramCaption && telegramCaption !== 'null' && !isTelegramQuotePlaceholder(telegramCaption) ? telegramCaption : '';
        // Poll / contact / location: the message text with a type icon (like Telegram); no text → label by type
        quoteDisplayText = caption
          ? (tgQuote.prefix && !caption.startsWith(tgQuote.prefix.trim()) ? `${tgQuote.prefix}${caption}` : caption)
          : tgQuote.label;
      } else if (parsedText) {
        quoteDisplayText = parsedText;
      } else {
        // Fallback based on msgType if present
        if (q.msgType === 'photo' || q.msgType === 'image' || q.msgType === 'chat.photo') {
          quoteDisplayText = tr('[Hình ảnh]');
        } else if (q.msgType === 'chat.video.msg') {
          quoteDisplayText = '[Video]';
        } else if (q.msgType === 'chat.sticker') {
          quoteDisplayText = '[Sticker]';
        } else if (q.msgType === 'chat.recommended' || q.msgType === 'chat.link') {
          quoteDisplayText = '[Link]';
        } else if (['share.file', 'share.link', 'file'].includes(q.msgType)) {
          quoteDisplayText = '[File/Link]';
        } else if (q.msgType === 'chat.todo') {
          quoteDisplayText = '[Todo]';
        } else if (q.msgType === 'chat.poll') {
          quoteDisplayText = tr('[Bình chọn]');
        } else if (q.msgType === 'chat.webcontent') {
          quoteDisplayText = tr('🏦 [Tài khoản ngân hàng]');
        } else {
          quoteDisplayText = tr('[Tin nhắn]');
        }
      }
    }

    return (
      <div
        className={`${quotePeer !== null ? `border-l-[3px] chat-peer-${quotePeer} chat-peer-quote` : `border-l-2 ${(quoteShell || !isNoBubbleMsg) ? (isSent ? 'border-primary bg-primary/20' : 'border-border-strong bg-background') : (isSent ? 'border-primary bg-bubble-out' : 'border-border-strong bg-bubble-in')}`} rounded pl-2 pr-1 py-1 text-xs cursor-pointer hover:opacity-100 overflow-hidden min-w-0 ${quoteShell ? 'w-0 min-w-[calc(100%-1rem)] mx-2 mt-2 mb-1.5' : postEdgeMedia ? 'mx-3 mt-2 mb-1.5' : 'mb-1 max-w-full'}`}
        onClick={() => handleScrollToMsg(String(q.msgId || ''), String(q.cliMsgId || ''))}
      >
        {(isQuotedSticker || finalImgUrl) ? (() => {
          // Like Telegram: thumbnail on the left, name + caption on the right; a photo without a caption → label "Hình ảnh" (Photo)
          const quoteCaption = getQuotedMediaCaption(q, origContent || lookupContent);
          const quoteLabel = quoteCaption || quoteDisplayText.replace(/^\[(.*)\]$/, '$1');
          return (
            <div className="flex items-center gap-2 min-w-0">
              <div className={`w-10 h-10 flex-shrink-0 overflow-hidden rounded bg-foreground/5 [&_img]:w-full [&_img]:h-full ${tgSticker ? '[&_img]:object-contain' : '[&_img]:object-cover'}`}>
                {isQuotedSticker ? (
                  <QuotedStickerPreview content={quotedStickerContent} />
                ) : (
                  <img
                    src={finalImgUrl}
                    alt={tr('ảnh trích dẫn')}
                    className={`w-full h-full ${tgSticker ? 'object-contain' : 'object-cover'}`}
                    onError={(e) => { const box = e.currentTarget.parentElement; if (box) box.style.display = 'none'; }}
                  />
                )}
              </div>
              <div className="min-w-0 flex-1">
                {quoteAuthor && <p className={`font-semibold truncate ${quotePeer !== null ? 'chat-peer-name' : 'text-foreground'}`}>{quoteAuthor}</p>}
                <p className={`truncate ${quoteCaption ? 'text-foreground/80' : 'text-muted-foreground'}${quotePeer !== null ? ' w-0 min-w-full' : ''}`}>{quoteLabel}</p>
              </div>
            </div>
          );
        })() : (
          <>
            {quoteAuthor && <p className={`font-semibold truncate ${quotePeer !== null ? 'chat-peer-name' : 'text-foreground'}`}>{quoteAuthor}</p>}
            <p className={`line-clamp-2 break-words whitespace-pre-wrap mt-1 mb-1${quotePeer !== null ? ' w-0 min-w-full' : ''}`}>{quoteDisplayText}</p>
          </>
        )}
      </div>
    );
  } catch { return null; }
}
