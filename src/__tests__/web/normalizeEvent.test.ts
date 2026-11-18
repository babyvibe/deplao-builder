import { normalizeEvent, NormalizeHelpers } from '../../services/api/events/normalize';
import { fromZaloMentions, fromFbPrng, fromEventMentions } from '../../services/api/events/mentions';

const NOW = 1_800_000_000_000;

function helpers(row: any | null, contact: any | null): NormalizeHelpers {
  return {
    loadMessage: async () => row,
    loadContact: async () => contact,
    accountChannel: async () => 'facebook',
    now: () => NOW,
  };
}

const fbRow = (threadType: number) => ({
  msg_id: 'mid.1', owner_zalo_id: 'acc-fb', channel: 'facebook', thread_id: '1608907027224633', thread_type: threadType,
  sender_id: '100038321176259', content: 'Em test', msg_type: 'text', timestamp: NOW, is_sent: 0,
});
const fbContact = {
  contact_id: '1608907027224633', owner_zalo_id: 'acc-fb', channel: 'facebook', contact_type: 'user',
};
const fbPayload = (type: 'user' | 'group') => ({
  fbAccountId: 'acc-fb',
  message: { messageID: 'mid.1', threadID: '1608907027224633', userID: '100038321176259', body: 'Em test', type, timestamp: String(NOW) },
});

describe('normalizeEvent message threads', () => {
  test('fb group message from DB row is reported as group', async () => {
    const [ev] = await normalizeEvent('fb:onMessage', fbPayload('group'), helpers(fbRow(0), fbContact));
    expect(ev.type).toBe('message.received');
    expect(ev.data.message.thread_type).toBe('group');
    expect(ev.data.conversation.type).toBe('group');
  });

  test('fb group message without DB row uses payload type', async () => {
    const [ev] = await normalizeEvent('fb:onMessage', fbPayload('group'), helpers(null, null));
    expect(ev.data.message.thread_type).toBe('group');
    expect(ev.data.conversation.type).toBe('group');
  });

  test('fb direct message stays user', async () => {
    const [ev] = await normalizeEvent('fb:onMessage', fbPayload('user'), helpers(fbRow(0), fbContact));
    expect(ev.data.message.thread_type).toBe('user');
    expect(ev.data.conversation.type).toBe('user');
  });

  test('zalo group row is unchanged', async () => {
    const rowZalo = {
      msg_id: 'z1', owner_zalo_id: 'acc-z', channel: 'zalo', thread_id: 'g1', thread_type: 1,
      sender_id: 'u1', content: 'hi', msg_type: 'text', timestamp: NOW, is_sent: 0,
    };
    const [ev] = await normalizeEvent('event:message', {
      zaloId: 'acc-z',
      message: { type: 1, threadId: 'g1', data: { msgId: 'z1', uidFrom: 'u1', content: 'hi', ts: String(NOW) } },
    }, helpers(rowZalo, null));
    expect(ev.data.message.thread_type).toBe('group');
  });
});

describe('mentions', () => {
  test('fromFbPrng parses JSON string and array', () => {
    const expected = [{ user_id: '615', offset: 0, length: 7 }];
    expect(fromFbPrng('[{"i":"615","o":0,"l":7,"t":"p"}]')).toEqual(expected);
    expect(fromFbPrng([{ i: '615', o: 0, l: 7, t: 'p' }])).toEqual(expected);
  });

  test('fromFbPrng tolerates garbage', () => {
    for (const raw of [undefined, '', 'not json', '{}', [{ o: 1, l: 2 }], [{ i: 'x', o: 0, l: 0 }]]) {
      expect(fromFbPrng(raw)).toEqual([]);
    }
  });

  test('fromZaloMentions maps uid/pos/len', () => {
    expect(fromZaloMentions([{ uid: 123, pos: 2, len: 5, type: 0 }, { uid: '-1', pos: 0, len: 4 }])).toEqual([
      { user_id: '123', offset: 2, length: 5 },
      { user_id: '-1', offset: 0, length: 4 },
    ]);
  });

  test('fromEventMentions keeps normalized fields', () => {
    expect(fromEventMentions([{ user_id: 'a', offset: 1, length: 2 }, { user_id: '', offset: 0, length: 3 }])).toEqual([
      { user_id: 'a', offset: 1, length: 2 },
    ]);
  });

  test('fb event carries mentions', async () => {
    const mentions = [{ user_id: 'acc-fb', offset: 0, length: 7 }];
    const payload = fbPayload('group');
    (payload.message as any).mentions = mentions;
    const [ev] = await normalizeEvent('fb:onMessage', payload, helpers(fbRow(0), fbContact));
    expect(ev.data.message.mentions).toEqual(mentions);
  });

  test('zalo event carries mentions', async () => {
    const rowZalo = {
      msg_id: 'z1', owner_zalo_id: 'acc-z', channel: 'zalo', thread_id: 'g1', thread_type: 1,
      sender_id: 'u1', content: 'hi', msg_type: 'text', timestamp: NOW, is_sent: 0,
    };
    const [ev] = await normalizeEvent('event:message', {
      zaloId: 'acc-z',
      message: { type: 1, threadId: 'g1', data: { msgId: 'z1', uidFrom: 'u1', content: 'hi', ts: String(NOW), mentions: [{ uid: 'acc-z', pos: 0, len: 4 }] } },
    }, helpers(rowZalo, null));
    expect(ev.data.message.mentions).toEqual([{ user_id: 'acc-z', offset: 0, length: 4 }]);
  });

  test('message without mentions has empty array', async () => {
    const [ev] = await normalizeEvent('fb:onMessage', fbPayload('user'), helpers(fbRow(0), fbContact));
    expect(ev.data.message.mentions).toEqual([]);
  });
});
