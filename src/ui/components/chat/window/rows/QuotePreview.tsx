/**
 * Trích dẫn trong bong bóng (bấm → nhảy tới tin gốc): tên người được trích theo màu, ảnh thu nhỏ + chú thích với
 * tin ảnh / sticker, không thì 2 dòng chữ. quote_data lưu sẵn, hoặc tra tin gốc theo reply_to_id.
 */
import { peerColorIndex } from '@/lib/chat/messages/peerStyle';
import { toLocalMediaUrl } from '@/lib/media/localMedia';
import { extractMediaUrl, extractQuoteImage, getQuotedMediaCaption, parseQuoteMsg } from '@/lib/chat/messages/messageParser';
import { isMediaType } from '@/lib/chat/messages/messageTypeUtils';
import { QuotedStickerPreview } from '../../messages/ChatWindowBubbles';
import type { MessageRowContext, RowLocals } from './rowContext';

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
  //  Ưu tiên imageUrl đã lưu, sau đó extract từ msg/attach
    const quotedImgUrl = q.imageUrl
      || (q.imageLocalPath ? toLocalMediaUrl(q.imageLocalPath) : '')
      || extractQuoteImage(q.msg, q.attach, q.msgType);
    // Nếu vẫn không có URL, tìm trong danh sách tin nhắn theo msgId
    let lookupImgUrl = '';
    // Khi q.msg rỗng (ví dụ Zalo gửi TQuote với msg="" cho chat.recommended/cliMsgType=38)
    // → tìm tin nhắn gốc để lấy content hiển thị
    let lookupContent = '';
    // Content của sticker gốc (để QuotedStickerPreview tải ảnh)
    let quotedStickerContent = '';
    // Nội dung tin gốc (lấy chú thích của ảnh / video được trích dẫn)
    let origContent = '';
    const isQuotedSticker = q.msgType === 'chat.sticker';

    if (q.msgId) {
      const origMsg = findMsgById(String(q.msgId));
      if (origMsg) {
        origContent = String(origMsg.content || '');
        // Dùng msg_type thật từ tin nhắn gốc nếu quote_data đang fallback sai
        if (origMsg.msg_type && origMsg.msg_type !== 'text') {
          q.msgType = origMsg.msg_type;
        }
        if (!quotedImgUrl && isMediaType(origMsg.msg_type, origMsg.content, origMsg.attachments)) {
          lookupImgUrl = extractMediaUrl(origMsg);
        }
        // Lấy content từ tin nhắn gốc nếu q.msg rỗng
        if (!q.msg && origMsg.content) {
          lookupContent = origMsg.content;
        }
        // Lấy content sticker từ tin gốc (kể cả nếu trong groupedStickerSkipIds)
        if (isQuotedSticker && origMsg.content) {
          quotedStickerContent = origMsg.content;
        }
      }
    }
    // Fallback sticker content từ q.attach hoặc q.msg
    if (isQuotedSticker && !quotedStickerContent) {
      quotedStickerContent = typeof q.attach === 'string'
        ? q.attach
        : (q.attach ? JSON.stringify(q.attach) : (q.msg || ''));
    }
    const finalImgUrl = quotedImgUrl || lookupImgUrl;
    const quoteAuthor = resolveQuoteAuthor(q);
    // Telegram: khung trích dẫn theo màu người được trích (vạch trái + nền nhạt + tên cùng màu); chữ trích dẫn
    // dài không kéo rộng bong bóng (w-0 min-w-full, chỉ tên người được trích tính) — tối thiểu 13rem, như Telegram
    const quoteSenderId = String(q.senderId || q.ownerId
      || (q.msgId ? findMsgById(String(q.msgId))?.sender_id : '') || '');
    const quotePeer = peerColorIndex(quoteSenderId, quoteAuthor);
    // Dùng lookupContent để parse quote nếu q.msg rỗng
    const effectiveMsgForQuote = q.msg || lookupContent;

    // Luôn tính quoteDisplayText (dùng làm fallback khi ảnh không tải được)
    let quoteDisplayText = '';
    {
      const parsedText = parseQuoteMsg(effectiveMsgForQuote, q.msgType);
      if (parsedText) {
        quoteDisplayText = parsedText;
      } else {
        // Fallback dựa trên msgType nếu có
        if (q.msgType === 'photo' || q.msgType === 'image' || q.msgType === 'chat.photo') {
          quoteDisplayText = '[Hình ảnh]';
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
          quoteDisplayText = '[Bình chọn]';
        } else if (q.msgType === 'chat.webcontent') {
          quoteDisplayText = '🏦 [Tài khoản ngân hàng]';
        } else {
          quoteDisplayText = '[Tin nhắn]';
        }
      }
    }

    return (
      <div
        className={`${quotePeer !== null ? `border-l-[3px] chat-peer-${quotePeer} chat-peer-quote` : `border-l-2 ${(quoteShell || !isNoBubbleMsg) ? (isSent ? 'border-primary bg-primary/20' : 'border-border-strong bg-background') : (isSent ? 'border-primary bg-bubble-out' : 'border-border-strong bg-bubble-in')}`} rounded pl-2 pr-1 py-1 text-xs cursor-pointer hover:opacity-100 overflow-hidden min-w-0 ${quoteShell ? 'w-0 min-w-[calc(100%-1rem)] mx-2 mt-2 mb-1.5' : postEdgeMedia ? 'mx-3 mt-2 mb-1.5' : 'mb-1 max-w-full'}`}
        onClick={() => handleScrollToMsg(String(q.msgId || ''), String(q.cliMsgId || ''))}
      >
        {(isQuotedSticker || finalImgUrl) ? (() => {
          // Như Telegram: ảnh thu nhỏ bên trái, tên + chú thích bên phải; ảnh không chú thích → nhãn "Hình ảnh"
          const quoteCaption = getQuotedMediaCaption(q, origContent || lookupContent);
          const quoteLabel = quoteCaption || quoteDisplayText.replace(/^\[(.*)\]$/, '$1');
          return (
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-10 h-10 flex-shrink-0 overflow-hidden rounded bg-foreground/5 [&_img]:w-full [&_img]:h-full [&_img]:object-cover">
                {isQuotedSticker ? (
                  <QuotedStickerPreview content={quotedStickerContent} />
                ) : (
                  <img
                    src={finalImgUrl}
                    alt="ảnh trích dẫn"
                    className="w-full h-full object-cover"
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
