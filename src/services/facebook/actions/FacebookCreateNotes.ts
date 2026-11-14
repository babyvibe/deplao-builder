/**
 * FacebookCreateNotes.ts
 * Ported from Python _messaging/_createNotes.py (fbchat-v2 2.3.2)
 * Create Messenger Notes (24h)
 */

import axios from 'axios';
import { FBSessionData } from '../FacebookTypes';
import { buildFormData, rateLimitDelay } from '../FacebookUtils';
import {
  FacebookOperationError,
  assertFacebookMutationSuccess,
  isNonEmptyMutationNode,
  parseFacebookResponse,
} from '../FacebookGraphQLResult';
import Logger from '../../../utils/Logger';
import { tr } from '../../../shared/i18n';

const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';

/** Messenger Notes accept FRIENDS for both of these (fbchat-v2 PRIVACY_ALIASES). */
const PRIVACY_ALIASES: Record<string, string> = { EVERYONE: 'FRIENDS', PUBLIC: 'FRIENDS' };

function normalizePrivacy(privacy?: string): string {
  const value = String(privacy || 'FRIENDS').toUpperCase();
  return PRIVACY_ALIASES[value] || value;
}

/** Port of fbchat-v2 `generate_client_id` (random UUID-shaped id). */
function generateClientId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const gen = (length: number) => Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `${gen(8)}-${gen(4)}-${gen(4)}-${gen(4)}-${gen(12)}`;
}

/**
 * Create a new Messenger Note (N2)
 * Notes are messages that self-destruct after 24h and appear at the top of the inbox.
 *
 * fbchat-v2 2.3.2: a mutation is sent once (never retried: a lost response may
 * still have created the note), and only a confirmed status node counts as success.
 */
export async function createNote(
  dataFB: FBSessionData,
  text: string,
  privacy: string = 'FRIENDS',
  httpsAgent?: any
): Promise<{ success: boolean; noteId?: string; error?: string }> {
  if (!text) return { success: false, error: 'createNote: text cannot be empty' };
  await rateLimitDelay();

  const form = buildFormData(dataFB, {
    friendlyName: 'MWInboxTrayNoteCreationDialogCreationStepContentMutation',
    docId: '24060573783603122',
  });
  form['variables'] = JSON.stringify({
    input: {
      client_mutation_id: generateClientId(),
      actor_id: String(dataFB.FacebookID),
      text: String(text),
      duration: 86400, // 24 hours
      note_type: 'TEXT_NOTE',
      privacy: normalizePrivacy(privacy),
      session_id: generateClientId(),
    },
  });

  try {
    const formBody = new URLSearchParams(form).toString();
    const response = await axios.post(GRAPHQL_URL, formBody, {
      headers: {
        'Host': 'www.facebook.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
        'Cookie': dataFB.cookieFacebook,
      },
      timeout: 45000,
      ...(httpsAgent ? { httpsAgent } : {}),
    });

    const parsed = typeof response.data === 'string' ? parseFacebookResponse(response.data) : response.data;
    assertFacebookMutationSuccess('createNote', parsed);
    const status = parsed?.data?.xfb_rich_status_create?.status;
    if (!isNonEmptyMutationNode(status)) {
      throw new FacebookOperationError('createNote', 'not_confirmed', tr('Facebook không trả về trạng thái tạo note hợp lệ.'));
    }
    const noteId = status?.id;
    return { success: true, noteId: noteId ? String(noteId) : undefined };
  } catch (err: any) {
    Logger.error(`[FacebookCreateNotes] createNote error: ${err.message}`);
    return { success: false, error: err.message };
  }
}
