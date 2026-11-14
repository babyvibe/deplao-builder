/**
 * The composer (MessageInput) sends to a place OTHER than the open conversation: currently used for the Telegram channel post comments:
 * sends to the DISCUSSION GROUP, the comment thread = the topic (the root message in the group), like sending to a forum topic.
 *
 * With a context → MessageInput takes the account / conversation / topic / contact from here instead of the open conversation, and sends everything
 * like the chat window does (text, images, video, files, voice recordings, stickers, GIFs, @mentions, quick messages, paste / drag and drop images, comment
 * replies), and turns off the parts that belong to the conversation (labels, AI suggestions, appointment reminders, notes, polls, conversation-switch shortcuts,
 * typing). Only one MessageInput is mounted at a time (App removes the channel's box while the comments are open), so quoting, pasting and
 * dragging still share the same state as before.
 */
import React from 'react';

export interface ComposerTarget {
  kind: 'telegramComments';
  accountId: string;
  /** Discussion group */
  threadId: string;
  threadType: number;
  /** Root message of the comment thread in the discussion group */
  topicId: string;
  /** The group's contact (when the group is not in the conversation list yet, i.e. not joined) */
  contact: { contact_id: string; channel: string; contact_type?: string; display_name?: string; [key: string]: unknown };
  placeholder?: string;
}

export const ComposerTargetContext = React.createContext<ComposerTarget | null>(null);
