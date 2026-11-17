/** Fork profile: the web operator only needs channel transport and administration. */
declare const __CHANNELS_ONLY__: boolean;
export const CHANNELS_ONLY = typeof __CHANNELS_ONLY__ !== 'undefined'
    ? __CHANNELS_ONLY__
    : typeof process === 'undefined' || process.env.DEPLAO_CHANNELS_ONLY !== '0';
export const CHANNEL_VIEWS = new Set(['chat', 'friends', 'settings', 'plugin']);
export function channelViewAllowed(view: string): boolean {
    return !CHANNELS_ONLY || CHANNEL_VIEWS.has(view);
}
