/**
 * Mở link bằng ứng dụng của máy (trình duyệt, ứng dụng thư): link web giữ phiên đăng nhập của trình duyệt người dùng.
 * Main chỉ nhận http, https, mailto (electron/app/mainWindowLinks); loại khác báo người dùng thay vì im lặng.
 */
import ipc from '../../ipc';
import { useAppStore } from '../../../store/app/appStore';

export function openExternalLink(url: string): boolean {
  if (!/^(https?:\/\/|mailto:)/i.test(String(url || ''))) {
    useAppStore.getState().showNotification('Deplao chưa mở được loại link này', 'warning');
    return false;
  }
  ipc.shell?.openExternal(url);
  return true;
}
