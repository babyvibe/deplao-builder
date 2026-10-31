/**
 * FacebookBlock.ts
 * Port từ Python _features/_facebook/_blocking.py (fbchat-v2 2.3.2)
 * Block/unblock user trên Facebook
 */

import axios from 'axios';
import { FBSessionData } from '../FacebookTypes';
import { buildFormData, rateLimitDelay } from '../FacebookUtils';
import {
  FacebookOperationError,
  assertFacebookMutationSuccess,
  hasConfirmedMutationRoot,
  parseFacebookResponse,
} from '../FacebookGraphQLResult';
import Logger from '../../../utils/Logger';

const GRAPHQL_URL = 'https://www.facebook.com/api/graphql/';

type BlockChoice = 'block' | 'unblock';

/** JSON with `userId` as a bare integer (it can exceed Number precision in principle). */
function variablesWithIntegerUserId(variables: Record<string, unknown>, placeholder: string, userId: string): string {
  return JSON.stringify(variables).replace(JSON.stringify(placeholder), userId);
}

function buildBlockForm(dataFB: FBSessionData, userId: string, choice: BlockChoice): Record<string, string> {
  if (choice === 'block') {
    const form = buildFormData(dataFB, {
      friendlyName: 'ProfileCometActionBlockUserMutation',
      docId: '6305880099497989',
    });
    const placeholder = '__DEPLAO_BLOCK_USER_ID__';
    form['variables'] = variablesWithIntegerUserId({
      collectionID: null,
      hasCollectionAndSectionID: false,
      input: {
        blocksource: 'PROFILE',
        should_apply_to_later_created_profiles: false,
        user_id: placeholder,
        actor_id: dataFB.FacebookID,
        // fbchat-v2: a fresh id per request (randrange(1025)).
        client_mutation_id: String(Math.floor(Math.random() * 1025)),
      },
      scale: 3,
      sectionID: null,
      isPrivacyCheckupContext: false,
    }, placeholder, userId);
    return form;
  }

  const form = buildFormData(dataFB, {
    friendlyName: 'BlockingSettingsBlockMutation',
    docId: '6009824239038988',
  });
  form['variables'] = JSON.stringify({
    input: {
      block_action: 'UNBLOCK',
      setting: 'USER',
      target_id: userId,
      actor_id: dataFB.FacebookID,
      client_mutation_id: '1',
    },
    profile_picture_size: 36,
  });
  return form;
}

async function changeBlockState(
  dataFB: FBSessionData,
  rawUserId: string,
  choice: BlockChoice,
  httpsAgent?: any,
): Promise<{ success: boolean; error?: string }> {
  const operation = choice === 'block' ? 'blockUser' : 'unblockUser';
  const userId = String(rawUserId || '').trim();
  if (!/^\d+$/.test(userId)) {
    return { success: false, error: `${operation}: userId không hợp lệ` };
  }
  await rateLimitDelay();

  try {
    const formBody = new URLSearchParams(buildBlockForm(dataFB, userId, choice)).toString();
    const response = await axios.post(GRAPHQL_URL, formBody, {
      headers: {
        'Host': 'www.facebook.com',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.facebook.com',
        'Referer': 'https://www.facebook.com/',
        'Cookie': dataFB.cookieFacebook,
      },
      timeout: 30000,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    const payload = typeof response.data === 'string' ? parseFacebookResponse(response.data) : response.data;
    assertFacebookMutationSuccess(operation, payload);
    // fbchat-v2 2.3.2: only a confirmed root of the block/unblock family
    // counts; HTTP 200 with an unrelated or empty node does not.
    if (!hasConfirmedMutationRoot(payload, (rootName) => rootName.toLowerCase().includes('block'))) {
      const label = choice === 'block' ? 'chặn' : 'bỏ chặn';
      throw new FacebookOperationError(operation, 'not_confirmed', `Facebook không xác nhận thao tác ${label} người dùng.`);
    }
    return { success: true };
  } catch (err: any) {
    Logger.error(`[FacebookBlock] ${operation} error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Chặn người dùng trên Facebook (N4)
 */
export async function blockUser(
  dataFB: FBSessionData,
  userId: string,
  httpsAgent?: any
): Promise<{ success: boolean; error?: string }> {
  return changeBlockState(dataFB, userId, 'block', httpsAgent);
}

/**
 * Bỏ chặn người dùng trên Facebook (N4)
 */
export async function unblockUser(
  dataFB: FBSessionData,
  userId: string,
  httpsAgent?: any
): Promise<{ success: boolean; error?: string }> {
  return changeBlockState(dataFB, userId, 'unblock', httpsAgent);
}
