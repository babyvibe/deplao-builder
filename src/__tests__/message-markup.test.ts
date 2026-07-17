import { parseMarkup } from '../services/crm/message-markup';

describe('parseMarkup', () => {
  it('text trơn → không style', () => {
    expect(parseMarkup('Xin chào')).toEqual({ text: 'Xin chào', styles: [] });
  });

  it('in đậm cơ bản: offset trên text sạch', () => {
    const r = parseMarkup('a[b]bc[/b]d');
    expect(r.text).toBe('abcd');
    expect(r.styles).toEqual([{ start: 1, len: 2, st: 'b' }]);
  });

  it('màu đỏ → mã zca-js', () => {
    const r = parseMarkup('[red]HOT[/red]');
    expect(r.text).toBe('HOT');
    expect(r.styles).toEqual([{ start: 0, len: 3, st: 'c_db342e' }]);
  });

  it('thẻ lồng nhau → nhiều style cùng range', () => {
    const r = parseMarkup('[b][red]X[/red][/b]');
    expect(r.text).toBe('X');
    expect(r.styles).toEqual(
      expect.arrayContaining([
        { start: 0, len: 1, st: 'c_db342e' },
        { start: 0, len: 1, st: 'b' },
      ]),
    );
    expect(r.styles).toHaveLength(2);
  });

  it('thẻ lạ giữ nguyên như text thường', () => {
    const r = parseMarkup('gia [x]100[/x]k');
    expect(r.text).toBe('gia [x]100[/x]k');
    expect(r.styles).toEqual([]);
  });

  it('thẻ đóng không mở → bỏ qua, không crash', () => {
    const r = parseMarkup('abc[/b]d');
    expect(r.text).toBe('abcd');
    expect(r.styles).toEqual([]);
  });

  // Cạm bẫy chính: {name} thay lúc gửi → offset phải luôn khớp text thật.
  it('offset đúng sau khi {name} đã substitute (tên dài/ngắn khác nhau)', () => {
    const tpl = 'Chào [b]{name}[/b] nhé';
    const short = parseMarkup(tpl.replace('{name}', 'An'));
    expect(short.text).toBe('Chào An nhé');
    expect(short.styles).toEqual([{ start: 5, len: 2, st: 'b' }]);

    const long = parseMarkup(tpl.replace('{name}', 'Nguyễn Văn Bình'));
    expect(long.text).toBe('Chào Nguyễn Văn Bình nhé');
    expect(long.styles).toEqual([{ start: 5, len: 15, st: 'b' }]);
  });
});
