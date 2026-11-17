import { createClientApi } from '../../shared/platform/createClientApi';
import { browserMediaUrl } from '../../shared/platform/browserMedia';

test('shared API preserves desktop channel contracts and event cleanup', async () => {
  const transport = {
    invoke: jest.fn(async () => ({ success: true })), send: jest.fn(), on: jest.fn(),
    removeListener: jest.fn(), removeAllListeners: jest.fn(),
  };
  const api = createClientApi(transport, 'web');
  expect(api.platform).toBe('web');
  await api.login.loginQR('login-1', 2);
  expect(transport.invoke).toHaveBeenCalledWith('login:qr', { tempId: 'login-1', proxyId: 2 });
  const callback = jest.fn();
  const off = api.on('event:message', callback);
  const subscription = transport.on.mock.calls[0][1];
  subscription({}, { message: 'hello' });
  expect(callback).toHaveBeenCalledWith({ message: 'hello' });
  off();
  expect(transport.removeListener).toHaveBeenCalledWith('event:message', subscription);
});

test.each([
  ['/home/user/media/a b.jpg', '/home/user/media/a b.jpg'],
  ['local-media:///home/user/media/a%20b.jpg', '/home/user/media/a b.jpg'],
  ['local-media:///D:/media/a.jpg?cw=long', 'D:/media/a.jpg'],
  ['file:///D:/media/a%20b.jpg', 'D:/media/a b.jpg'],
  ['media://local/media/avatar.jpg', 'media/avatar.jpg'],
])('converts media URL %s without leaking custom protocols to browsers', (input, file) => {
  expect(browserMediaUrl(input)).toBe(`/api/browser/media?path=${encodeURIComponent(file)}`);
});
