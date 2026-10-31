/**
 * Centralized helper to extract user profile fields from a Zalo getUserInfo response.
 * Used by ALL code paths that call getUserInfo → ensures gender, birthday, phone, etc.
 * are always extracted consistently.
 *
 * This module is intentionally dependency-free so it can be used in both
 * the main process (Electron) and the renderer process (React).
 */

export interface ExtractedProfile {
  displayName: string;
  avatar: string;
  phone: string;
  gender: number | null;    // 0 = Nam, 1 = Nữ, null = không xác định
  birthday: string | null;  // DD/MM/YYYY format
  alias: string;            // friendAlias / nickname
}

/**
 * Extract ALL relevant profile fields from a single Zalo getUserInfo profile object.
 *
 * @param profile - A single profile entry from `changed_profiles[userId]` or `data[userId]`
 * @returns Standardized profile fields, never throws.
 *
 * Usage:
 * ```ts
 * const res = await api.getUserInfo(userId);
 * const profile = res?.changed_profiles?.[userId] || res?.data?.[userId];
 * if (profile) {
 *   const extracted = extractUserProfile(profile);
 *   // extracted.displayName, extracted.gender, extracted.birthday, etc.
 * }
 * ```
 */
export function extractUserProfile(profile: any): ExtractedProfile {
  if (!profile) {
    return { displayName: '', avatar: '', phone: '', gender: null, birthday: null, alias: '' };
  }

  const displayName: string = profile.displayName || profile.zaloName || profile.name || '';
  const avatar: string = profile.avatar || profile.avatarUrl || '';
  const phone: string = profile.phoneNumber || profile.msisdn || profile.phone || '';
  const alias: string = profile.friendAlias || profile.alias || profile.nickName || '';

  // Gender: 0 = Nam, 1 = Nữ
  const gender: number | null =
    (profile.gender === 0 || profile.gender === 1) ? profile.gender : null;

  // Birthday: prefer sdob string "DD/MM/YYYY" or "DD/MM", fallback to dob unix timestamp
  let birthday: string | null = null;
  if (profile.sdob && typeof profile.sdob === 'string' && profile.sdob.includes('/')
      && profile.sdob !== '00/00/0000' && !/^[0/]+$/.test(profile.sdob)) {
    birthday = profile.sdob; // Already DD/MM/YYYY or DD/MM
  } else if (profile.dob && typeof profile.dob === 'number' && profile.dob > 0) {
    const d = new Date(profile.dob * 1000);
    birthday = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }

  return { displayName, avatar, phone, gender, birthday, alias };
}

/**
 * Resolve profile from a getUserInfo API response for a specific userId.
 * Handles both response shapes: changed_profiles and data.
 */
export function resolveProfileFromResponse(response: any, userId: string): any | null {
  if (!response) return null;
  return response.changed_profiles?.[userId]
    || response.data?.[userId]
    || null;
}

