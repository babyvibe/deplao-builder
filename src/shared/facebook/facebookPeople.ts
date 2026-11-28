/** One answer of the Messenger people search (bridge searchUsers). Ids are strings: they can exceed 2^53. */
export interface FacebookPersonResult {
  id: string;
  name: string;
  avatarUrl?: string;
  /** Second line Messenger shows ("Bạn bè", mutual friends, Page category...). */
  contextLine?: string;
  /** 'contact' | 'non_contact' | 'page' | 'group' | 'other' */
  kind: string;
  isGroup?: boolean;
  canMessage: boolean;
  verified?: boolean;
  /** Deplao already has a conversation with this person / group. */
  hasConversation?: boolean;
}
