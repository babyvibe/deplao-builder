/**
 * The account's own proxy (accounts.proxy_id): chosen at login, and can be added / changed / removed later in Settings → Accounts
 * and Settings → Proxy. The account reconnects through the new proxy by itself (issue #73; previously the user had to log in again).
 * Only Zalo (zca-js) and Facebook (session + MQTT) go through a proxy; Telegram is not supported yet.
 */

/** Channels that can use their own proxy; old accounts without a channel = Zalo. */
export function supportsAccountProxy(channel?: string | null): boolean {
  return !channel || channel === 'zalo' || channel === 'facebook';
}
