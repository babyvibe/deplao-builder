/**
 * GitHub release notes of Deplao: the visible text is English; the Vietnamese notes sit in an HTML comment
 * (`<!-- deplao-notes-vi:start` … `deplao-notes-vi:end -->`), hidden on GitHub. The update window shows the part that
 * matches the interface language. Releases without the hidden part are shown as they are.
 */
export const RELEASE_NOTES_VI_START = '<!-- deplao-notes-vi:start';
export const RELEASE_NOTES_VI_END = 'deplao-notes-vi:end -->';

/**
 * Markdown of one release for the given interface language: Vietnamese gets the hidden Vietnamese notes, every other
 * language the visible English. Whatever follows the hidden part (the commit links block) is kept for both.
 */
export function releaseNotesForLanguage(body: string, lang: string): string {
  const text = String(body || '').replace(/\r\n/g, '\n');
  const start = text.indexOf(RELEASE_NOTES_VI_START);
  const end = start >= 0 ? text.indexOf(RELEASE_NOTES_VI_END, start + RELEASE_NOTES_VI_START.length) : -1;
  if (start < 0 || end < 0) return text.trim();
  const visible = text.slice(0, start).trim();
  const vietnamese = text.slice(start + RELEASE_NOTES_VI_START.length, end).trim();
  const after = text.slice(end + RELEASE_NOTES_VI_END.length).trim();
  const main = lang === 'vi' && vietnamese ? vietnamese : visible;
  return [main, after].filter(Boolean).join('\n\n');
}
