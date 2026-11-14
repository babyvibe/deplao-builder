/**
 * Deplao's SHARED "Desktop app" OAuth client for Google Drive: used when the user does not enter a private client.
 *
 * How to set it up (maintainers):
 *  1. console.cloud.google.com → create a project (e.g. "Deplao") → APIs & Services → Library → enable "Google Drive API".
 *  2. OAuth consent screen (Google Auth Platform): User type = External. Data access: add exactly ONE scope
 *     https://www.googleapis.com/auth/drive.file (not sensitive: the app only sees files it created itself, so it needs no
 *     Google security review). Audience → Publishing status must be "In production": with "Testing" the refresh token
 *     expires after 7 days, and only accounts on the test user list can sign in.
 *  3. Credentials → Create credentials → OAuth client ID → Application type "Desktop app".
 *  4. Copy the Client ID + Client secret into the two values below (replace the empty string after `||`). The environment variables
 *     DEPLAO_GOOGLE_CLIENT_ID / DEPLAO_GOOGLE_CLIENT_SECRET only take effect when running dev: the installed app on users' machines
 *     does not have these variables, so the values must be filled in right here.
 *
 * The client secret of a "Desktop app" client is NOT a secret (Google states that an app installed on a machine cannot keep a secret; it is safe
 * thanks to PKCE + the loopback 127.0.0.1 redirect), the same way rclone / gcloud embed their own client in their release builds.
 * The Drive API quota (units / day) of this project is shared by ALL Deplao users of the shared client.
 *
 * Left empty = the app build has no shared client → users must enter their own OAuth client (Advanced section) before they can sign in.
 */
export const BUILTIN_GOOGLE_CLIENT: { clientId: string; clientSecret: string } = {
    clientId: process.env.DEPLAO_GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.DEPLAO_GOOGLE_CLIENT_SECRET || '',
};
