/**
 * FacebookLoginHelper.ts
 * Port từ Python _core/_facebookLogin.py
 * Đăng nhập Facebook bằng username/password (+ 2FA optional)
 */

import axios from 'axios';
import { TOTP } from 'otplib';
import { FBLoginResult } from './FacebookTypes';
import { randStr } from './FacebookUtils';
import Logger from '../../utils/Logger';

const FB_AUTH_URL = 'https://b-graph.facebook.com/auth/login';
const REQUEST_TIMEOUT = 20000;

// Android Facebook app headers (như trong Python original)
const AUTH_HEADERS = {
  'Host': 'b-graph.facebook.com',
  'Content-Type': 'application/x-www-form-urlencoded',
  'X-Fb-Connection-Type': 'unknown',
  'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 7.1.2; SM-G988N Build/NRD90M) [FBAN/FB4A;FBAV/340.0.0.27.113;FBPN/com.facebook.katana;FBLC/vi_VN;FBBV/324485361;FBCR/Viettel Mobile;FBMF/samsung;FBBD/samsung;FBDV/SM-G988N;FBSV/7.1.2;FBCA/x86:armeabi-v7a;FBDM/{density=1.0,width=540,height=960};FB_FW/1;FBRV/0;]',
  'X-Fb-Connection-Quality': 'EXCELLENT',
  'Authorization': 'OAuth null',
  'X-Fb-Friendly-Name': 'authenticate',
  'Accept-Encoding': 'gzip, deflate',
  'X-Fb-Server-Cluster': 'True',
};

function generateDeviceId(): string {
  return `${randStr(8)}-${randStr(4)}-${randStr(4)}-${randStr(4)}-${randStr(12)}`;
}

function buildCookieExport(sessionCookies: any[]): string {
  return (sessionCookies || [])
    .filter((c: any) => c?.name && c?.value)
    .map((c: any) => `${c.name}=${c.value}; `)
    .join('');
}

function buildLoginResult(dataJson: any, statusLogin: 1 | 0, cookies?: string[]): FBLoginResult {
  if (statusLogin === 1) {
    return {
      success: {
        setCookies: (cookies || []).join(''),
        accessTokenFB: dataJson?.access_token || '',
        cookiesKeyValueList: dataJson?.session_cookies || [],
      },
    };
  }

  const error = dataJson?.error || {};
  return {
    error: {
      title: error.error_user_title || 'Đăng nhập thất bại',
      description: error.error_user_msg || 'Lỗi không xác định',
      error_subcode: error.error_subcode,
      error_code: error.code,
      fbtrace_id: error.fbtrace_id,
    },
  };
}

async function postLogin(data: Record<string, string>): Promise<any> {
  try {
    const body = new URLSearchParams(data).toString();
    const response = await axios.post(FB_AUTH_URL, body, {
      headers: AUTH_HEADERS,
      timeout: REQUEST_TIMEOUT,
    });
    return response.data;
  } catch (err: any) {
    return { error: { error_user_msg: err.message, code: -1 } };
  }
}

async function getToken2FA(key2FA: string): Promise<string> {
  try {
    if (!key2FA) return '';
    const cleaned = key2FA.replace(/\s/g, '');
    const totp = new TOTP();
    return await totp.generate({secret: cleaned});
  } catch (err: any) {
    Logger.warn(`[FacebookLoginHelper] 2FA token error: ${err.message}`);
    return String(100000 + Math.floor(Math.random() * 900000));
  }
}

/**
 * Đăng nhập Facebook bằng username/password
 * username: SĐT, email hoặc Facebook ID
 * password: Mật khẩu
 * twoFASecret: Chuỗi 16 ký tự từ Facebook 2FA setup (optional)
 */
export async function loginWithCredentials(
  username: string,
  password: string,
  twoFASecret?: string
): Promise<FBLoginResult> {
  const deviceId = generateDeviceId();
  const machineId = randStr(24);
  const adId = deviceId;

  const baseForm = (pw: string, credentialsType: string, tryNum: number): Record<string, string> => {
    const form: Record<string, string> = {
      adid: adId,
      format: 'json',
      device_id: deviceId,
      email: username,
      password: pw,
      generate_analytics_claim: '1',
      community_id: '',
      cpl: 'true',
      try_num: String(tryNum),
      family_device_id: deviceId,
      secure_family_device_id: deviceId,
      credentials_type: credentialsType,
      fb4a_shared_phone_cpl_experiment: 'fb4a_shared_phone_nonce_cpl_at_risk_v3',
      fb4a_shared_phone_cpl_group: 'enable_v3_at_risk',
      enroll_misauth: 'false',
      generate_session_cookies: '1',
      error_detail_type: 'button_with_disabled',
      source: 'login',
      machine_id: machineId,
      meta_inf_fbmeta: '',
      advertiser_id: adId,
      encrypted_msisdn: '',
      currently_logged_in_userid: '0',
      locale: 'vi_VN',
      client_country_code: 'VN',
      fb_api_req_friendly_name: 'authenticate',
      fb_api_caller_class: 'Fb4aAuthHandler',
      api_key: '882a8490361da98702bf97a021ddc14d',
      access_token: '350685531728|62f8ce9f74b12f84c123cc23437a4a32',
      jazoest: credentialsType === 'password' ? '22421' : '22327',
    };
    if (credentialsType === 'two_factor') {
      form.sim_serials = '[]';
    }
    return form;
  };

  // Step 1: Login with password
  const dataForm = baseForm(password, 'password', 1);
  const dataJson = await postLogin(dataForm);
  const error = dataJson?.error;

  // Success on first try
  if (!error) {
    const cookies = buildCookieExport(dataJson?.session_cookies || []);
    return buildLoginResult(dataJson, 1, [cookies]);
  }

  // Not a 2FA challenge — return error
  if (error.error_subcode !== 1348162) {
    return buildLoginResult(dataJson, 0);
  }

  // Step 2: Handle 2FA challenge
  const token2FA = getToken2FA(twoFASecret || '');
  const dataForm2FA = baseForm(await token2FA, 'two_factor', 2);
  const errorData = error.error_data || {};
  dataForm2FA.twofactor_code = await token2FA;
  dataForm2FA.userid = String(errorData.uid || '');
  dataForm2FA.first_factor = String(errorData.login_first_factor || '');

  const pass2FA = await postLogin(dataForm2FA);
  if (pass2FA?.error) {
    return buildLoginResult(pass2FA, 0);
  }

  const cookies2FA = buildCookieExport(pass2FA?.session_cookies || []);
  return buildLoginResult(pass2FA, 1, [cookies2FA]);
}

