/**
 * FacebookChangeTheme.ts
 * Port từ Python _messaging/_changeTheme.py
 * Đổi theme (màu/gradient) cho hội thoại Facebook Messenger
 */

import axios from 'axios';
import { FBSessionData } from '../FacebookTypes';
import { buildFormData, rateLimitDelay } from '../FacebookUtils';
import { assertFacebookMutationSuccess, parseFacebookResponse } from '../FacebookGraphQLResult';
import Logger from '../../../utils/Logger';

const GRAPHQL_URL = 'https://www.facebook.com/webgraphql/mutation/';

const THEME_LIGHT = 'light';
const THEME_DARK = 'dark';

export { THEME_LIGHT, THEME_DARK };

/**
 * Đổi theme cho hội thoại Facebook Messenger (N1)
 *
 * @param theme - Gradient color ID hoặc 'light'/'dark'. Ví dụ:
 *   '1408628207129185' = gradient xanh dương
 *   'light' = theme mặc định
 *   'dark' = dark mode
 */
export async function changeThreadTheme(
  dataFB: FBSessionData,
  threadId: string,
  theme: string,
  httpsAgent?: any
): Promise<{ success: boolean; error?: string }> {
  await rateLimitDelay();

  const form = buildFormData(dataFB, {
    friendlyName: 'CometChangeThemeMutation',
    docId: '5557418956951811',
  });

  form['variables'] = JSON.stringify({
    data: {
      theme: String(theme),
      thread_id: String(threadId),
      client_mutation_id: '1',
      actor_id: dataFB.FacebookID,
    }
  });
  form['dpr'] = '1';

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
      timeout: 30000,
      ...(httpsAgent ? { httpsAgent } : {}),
    });
    assertFacebookMutationSuccess('changeThreadTheme', parseFacebookResponse(response.data as string));
    return { success: true };
  } catch (err: any) {
    Logger.error(`[FacebookChangeTheme] error: ${err.message}`);
    return { success: false, error: err.message };
  }
}
