/**
 * Opens a link with the machine's own apps (browser, mail app): web links keep the user's browser login session.
 * Main only accepts http, https, mailto (electron/app/mainWindowLinks); other types notify the user instead of failing silently.
 */
import ipc from '../../ipc';
import { useAppStore } from '../../../store/app/appStore';
import { tr } from '../../../../shared/i18n';

export function openExternalLink(url: string): boolean {
  if (!/^(https?:\/\/|mailto:)/i.test(String(url || ''))) {
    useAppStore.getState().showNotification(tr('Deplao chưa mở được loại link này'), 'warning');
    return false;
  }
  ipc.shell?.openExternal(url);
  return true;
}
