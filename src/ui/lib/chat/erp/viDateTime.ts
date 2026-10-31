/**
 * Đọc ngày giờ trong tin nhắn tiếng Việt: nút "Tạo lịch hẹn" ngay dưới tin có ngày giờ sắp tới (ChatWindow) và "Thêm vào
 * lịch" từ tin (lib/chat/erp/messageToErp). Mốc tính là lúc tin được gửi: "mai 9h" trong tin hôm qua là 9:00 hôm nay.
 *
 * Đọc được (tham khảo bộ luật tiếng Việt của Duckling: facebook/duckling, Duckling/Time/VI/Rules.hs):
 *  - ngày: hôm nay / bữa nay, (ngày) mai, (ngày) mốt / ngày kia, hôm qua / hôm kia, thứ 2 … chủ nhật (t2, cn), tuần sau /
 *    tuần tới (kèm thứ hoặc không), thứ 6 tuần trước / vừa rồi, đầu tuần sau, cuối tuần, cuối tháng, dd/mm[/yyyy],
 *    dd-mm-yyyy, yyyy-mm-dd, ngày 5 [tháng 12], mồng / mùng 5, ngày 5 tháng sau;
 *  - giờ: 9h, 9h30, 9h30p / 9h30ph, 9:30, 9g30, 9 giờ, 9 giờ 30 phút, 9 giờ rưỡi, 9h kém 15, 9-11h, lúc 9, 8pm, 7:30am,
 *    kèm buổi sáng / trưa / chiều / tối / đêm (trước hoặc sau giờ), hoặc chỉ có buổi ("chiều mai" = 14:00);
 *  - khoảng thời gian tính từ lúc gửi: 20 phút nữa, 2 tiếng nữa, 1 tiếng rưỡi nữa, nửa tiếng nữa, sau 30 phút, 10 phút sau,
 *    3 ngày nữa, 1 tuần nữa (số viết bằng chữ cũng được: "mười lăm phút nữa").
 * Gõ không dấu cũng đọc được ("toi mai 8h"). Tin CÓ dấu thì chỉ nhận chữ có dấu đúng: "tối" là buổi tối còn "tôi" thì
 * không, "sáng" khác "sang", "mốt" khác "một". Giờ 1-5 không kèm buổi hiểu là buổi chiều (hẹn 3h = 15:00); giờ 6-9 không
 * kèm buổi mà giờ sáng hôm đó đã qua thì là tối nay nếu còn trong 8 tiếng ("hẹn 8h nhé" gửi 19:02 = 20:00).
 *
 * Tránh bắt nhầm chữ không liên quan:
 *  - "mai" / "mốt" đứng một mình (không có "ngày", "sáng"… đi kèm) xét ngữ cảnh từ (bareDayWordIsDate): tên người ("Mai
 *    Dũng", "chị Mai", "Mai ơi", "Mai vs Sơn", "gửi cho Mai", "Mai đã gửi"), từ ghép ("hoa mai", "mai mối", "mai mốt",
 *    "đúng mốt", "mốt mới") thì bỏ; chỉ là ngày khi sát giờ ("mai 9h"), sau chữ chỉ thời gian ("để mai", "đến mai"), hoặc
 *    theo sau là chủ ngữ / việc làm / từ đệm ("Mai em gửi", "mai giao hàng", "Mai nhé");
 *  - "trong 2h", "mất 2 giờ đồng hồ", "8h/ngày" (khoảng thời gian), "2HP" (công suất), "lần thứ hai", "thứ nhất…, thứ
 *    hai…" (thứ tự), "ngày 3 lần" (số lần), "9-11h" (không phải ngày 9/11), "24/7", "còn 2/10 suất", "số 12/3" (địa chỉ);
 *  - gõ không dấu: "toi qua", "dem qua", "sang qua" là "tôi qua", "đem qua", "sang qua" (không phải tối qua…).
 * Chỉ bớt "chắc chắn" (không hiện nút dưới tin, "Thêm vào lịch" vẫn điền): lịch lặp ("hằng ngày", "giờ mở cửa", "thứ 2 -
 * thứ 7"), giờ không kèm ngày đã qua lúc gửi mà không có chữ hẹn ("lúc 9h em có gọi"), chỉ có buổi, "cn", "t2", "1/2".
 */

export interface ViDateTime {
  /** Thời điểm bắt đầu (ms, giờ máy). Chỉ có ngày → 09:00 ngày đó. */
  at: number;
  hasDate: boolean;
  hasTime: boolean;
  /**
   * Đọc chắc chắn: có giờ, ngày rõ ràng ("ngày mai", "thứ 6", "20/11") hoặc "20 phút nữa". Không chắc: chỉ có buổi ("màu
   * tối"), "cn", "t2", "thứ hai là…", "1/2" (cũng là phân số), lịch lặp, giờ đã qua mà không có chữ hẹn. Nút "Tạo lịch hẹn"
   * dưới tin chỉ hiện khi chắc chắn.
   */
  confident: boolean;
  /** Các đoạn đã đọc (vị trí trong chuỗi đã chuẩn hoá NFC) để bỏ khỏi tiêu đề. */
  spans: Array<[number, number]>;
}

type Period = 'morning' | 'noon' | 'afternoon' | 'evening' | 'night';

const PERIOD_OF: Record<string, Period> = {
  'sáng': 'morning', sang: 'morning',
  'trưa': 'noon', trua: 'noon',
  'chiều': 'afternoon', chieu: 'afternoon',
  'tối': 'evening', toi: 'evening',
  'đêm': 'night', dem: 'night',
};
/** Chỉ có buổi, không có giờ. */
const PERIOD_DEFAULT_HOUR: Record<Period, number> = { morning: 8, noon: 12, afternoon: 14, evening: 19, night: 21 };
/** Gõ không dấu: "toi" cũng là "tôi", "sang" là "sang (nhà)", "dem" là "đem" → chỉ là buổi khi sát giờ ("8h toi"). */
const AMBIGUOUS_PLAIN_PERIODS = new Set(['toi', 'sang', 'dem']);

/** Thứ → getDay() (0 = chủ nhật). */
const WEEKDAY_OF: Record<string, number> = {
  '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6,
  hai: 1, ba: 2, 'tư': 3, tu: 3, 'năm': 4, nam: 4, 'sáu': 5, sau: 5, 'bảy': 6, bay: 6,
};

/** Số bằng chữ trong "N phút nữa" (không dấu bỏ "sau" / "tam": trùng sau, tầm). */
const NUMBER_WORDS: Record<string, number> = {
  'một': 1, mot: 1, hai: 2, ba: 3, 'bốn': 4, bon: 4, 'năm': 5, nam: 5, 'sáu': 6, 'bảy': 7, bay: 7, 'tám': 8,
  'chín': 9, chin: 9, 'mười': 10, muoi: 10, 'mười lăm': 15, 'muoi lam': 15, 'hai mươi': 20, 'hai muoi': 20,
  'ba mươi': 30, 'ba muoi': 30, 'bốn mươi lăm': 45, 'bon muoi lam': 45, 'nửa': 0.5, nua: 0.5,
};

/** "lần thứ hai", "người thứ 3", "bên thứ ba": thứ tự, không phải thứ trong tuần. */
const ORDINAL_NOUNS = {
  accented: 'lần|điều|bước|phần|ý|cái|người|loại|câu|hạng|vị|con|đứa|đứng|xếp|top|tầng|lầu|số|đợt|kỳ|kì|khóa|khoá|chương|bài|trang|dòng|mục|vòng|hiệp|ván|lớp|năm|tuần|tập|phiên|giải|bản|mẫu|bên|size|cỡ',
  plain: 'lan|dieu|buoc|phan|y|cai|nguoi|loai|cau|dua|xep|top|lau|so|dot|ky|ki|khoa|chuong|bai|trang|muc|vong|hiep|lop|nam|tuan|phien|ben|size',
};
/** "ngày 3 lần", "mỗi ngày 2 viên": số lần trong ngày, không phải ngày 3. */
const COUNT_WORDS = {
  accented: 'lần|viên|bữa|cữ|gói|ly|cốc|chai|hộp|cái|người|tiếng|giờ|phút|đơn|ca|km|kg|lít|triệu|tr|k|nghìn|ngàn|trăm|lượt|bài|trang|cuộc|chuyến|suất|tiết|h|%',
  plain: 'lan|vien|bua|goi|coc|chai|nguoi|tieng|gio|phut|km|kg|lit|trieu|tr|k|nghin|ngan|tram|luot|suat|tiet|h|%',
};

/**
 * Ngữ cảnh từ của "mai" / "mốt" đứng một mình: [có dấu, không dấu]. Bản không dấu viết tay, bỏ chữ mà bỏ dấu đi thì trùng
 * nghĩa khác ("ghe" = ghé, "chieu" = chiều, "danh" = đánh, "da" = đã / đá, "cho" = cho / chờ…).
 */
const DAY_WORD_LEXICON = {
  /** hoa mai, cây mai, đào mai */
  maiCompoundBefore: ['hoa|cây|cành|chậu|gốc|bông|nhành|cội|vườn|đào', 'hoa|cay|chau|goc|bong|coi|vuon|dao'],
  /** mai mối, mai táng, mai một, mai sau / mai kia / mai mốt / mai này (một ngày nào đó), mai vàng, mai cua… */
  maiCompoundAfter: ['mối|táng|một|rùa|mỉa|phục|danh|sau|kia|mốt|này|vàng|trắng|tứ|đào|cua|mực|ghẹ|chiếu', 'mot|mia|phuc|sau|kia|nay|vang|dao|cua|muc'],
  /** đúng mốt, hợp mốt, đang là mốt (thời trang) */
  motCompoundBefore: ['đúng|hợp|theo|lỗi|sành|chạy|mẫu|kiểu|thời|mai|là|làm|đang', ''],
  /** mốt mới, mốt này, mốt năm nay */
  motCompoundAfter: ['mới|này|nhất|thời|trang|kia|năm|nay', ''],
  /** Mai ơi */
  vocativeAfter: ['ơi', 'oi'],
  /** Mai và Lan, Mai vs Sơn (Mai viết hoa) */
  coordinationAfter: ['và|với|vs|cùng|hay|hoặc|&', 'va|voi|vs|cung|hay|hoac|&'],
  /** gửi cho Mai, của Mai, rủ Mai: người, không phải ngày */
  personBefore: ['cho|của|với|và|cùng|mời|rủ|tặng|giúp|nhờ|thấy|như|là|bảo|nói|hỏi', 'cua|voi|va|cung|ru|tang|giup|thay|nhu|la|bao|noi|hoi'],
  /** đến mai, để mai, hẹn mai, dời sang mai, sớm mai */
  temporalBefore: ['đến|tới|từ|để|hẹn|đợi|chờ|tầm|khoảng|trước|sang|tận|dời|lùi|hoãn|sớm|nội|qua|ngay', 'den|toi|tu|de|hen|doi|tam|khoang|truoc|sang|tan|lui|hoan|som|qua|ngay'],
  /** Mai em gửi, mai shop nghỉ: chủ ngữ của việc ngày mai */
  pronounsAfter: [
    'em|anh|chị|mình|tôi|tớ|tao|mày|bọn|tụi|tui|chúng|cả|mọi|shop|bên|team|nhà|công|cty|cửa|kho|xe|thợ|a|e|c|mk|mik|mn|t|ck|vk|bé|con|mẹ|bố|ông|bà|cô|chú|bác|cháu|sếp|khách|ad|admin|bạn|ae|nhóm|lớp|phòng|ta',
    'em|anh|chi|minh|toi|to|tao|may|bon|tui|chung|ca|moi|shop|ben|team|nha|cong|cty|kho|xe|a|e|c|mk|mik|mn|t|ck|vk|be|con|me|bo|ong|co|chu|bac|chau|sep|khach|ad|admin|ban|ae|nhom|lop|phong|ta',
  ],
  /** Mai gửi, mai giao hàng: việc làm ngày mai */
  verbsAfter: [
    'gửi|giao|ship|qua|đến|tới|đi|về|họp|gặp|làm|nghỉ|có|nhận|lấy|trả|chuyển|gọi|nhắn|ghé|đón|check|xem|báo|test|học|thi|khai|mở|đóng|bán|nhập|lên|xuống|sang|ra|vào|bắt|chạy|chốt|ký|kí|nộp|thanh|tính|bàn|hẹn|đặt|book|order|live|đăng|post|quay|chụp|in|sửa|lắp|kiểm|duyệt|phỏng|ăn|uống|đá|tập|chơi|nhậu|khám|bay|trực|đổi|hoàn|bù|dạy|đưa|mang|đem|trình|demo|deploy|call|meet|review|update|cập|setup|cài|gom|xuất|thử|mua|tiếp|dọn|hết|còn|phải|nên|thu|xếp|giải|đối|khởi|thăm|vô|đánh|chở|rước|nấu|tổ|tiễn|cưới|tăng|rửa|chuẩn|giữ|đợi|chờ|ở|nhớ|rảnh|bận|trống|kẹt|vướng|tiện',
    'gui|giao|ship|qua|den|toi|di|ve|hop|gap|lam|nghi|co|nhan|lay|tra|chuyen|goi|ghe|don|check|xem|bao|test|hoc|thi|khai|mo|dong|ban|nhap|len|xuong|sang|ra|vao|bat|chay|chot|ky|ki|nop|thanh|tinh|hen|dat|book|order|live|post|quay|chup|in|sua|lap|kiem|duyet|phong|an|uong|tap|choi|nhau|kham|bay|truc|doi|hoan|bu|day|dua|mang|dem|trinh|demo|deploy|call|meet|review|update|cap|setup|cai|gom|xuat|thu|mua|tiep|het|con|phai|nen|xep|giai|khoi|tham|vo|danh|cho|ruoc|nau|to|tien|cuoi|tang|rua|chuan|giu|o|nho|ranh|ket|vuong',
  ],
  /** Mai nhé, mai được không, mai mấy giờ */
  particlesAfter: [
    'nhé|nha|nhá|nhe|nghen|hen|ha|hả|nhỉ|được|đc|dc|ok|oke|okay|thì|sẽ|cũng|luôn|rồi|mới|lại|không|ko|k|kg|mấy|lúc|vào|khoảng|tầm|nữa|thôi|ạ|á|à|chắc|nhen',
    'nhe|nha|nghen|hen|ha|nhi|duoc|dc|ok|oke|okay|thi|se|cung|luon|roi|moi|lai|khong|ko|k|kg|may|luc|vao|khoang|tam|nua|thoi|a|chac|nhen',
  ],
  /** Mai đã gửi, Mai vừa gọi, Mai đang làm: việc đã / đang xảy ra → tên người */
  pastAfter: ['đã|vừa|đang|từng', 'vua|tung'],
  /** "Mai là ai", "Mai là người…": tên ("Mai là sinh nhật anh", "Mai là thứ 3" là ngày) */
  personAfterIs: [
    'ai|người|bạn|em|chị|anh|con|cô|chú|bác|nhân|quản|sếp|vợ|chồng|mẹ|bố|ba|má|cháu|đứa|thằng|học|giáo|chủ|khách|một|cái',
    'ai|nguoi|ban|em|chi|anh|con|co|chu|bac|nhan|quan|sep|vo|chong|me|bo|ba|ma|chau|dua|thang|hoc|giao|khach|mot|cai',
  ],
} as const;

type DayWordLexicon = { [K in keyof typeof DAY_WORD_LEXICON]: Set<string> };

const foldCache = new Map<string, string>();
/** Bỏ dấu, giữ nguyên độ dài (từng đơn vị UTF-16) để vị trí khớp với chuỗi gốc. */
function foldKeepLength(lower: string): string {
  let out = '';
  for (let i = 0; i < lower.length; i++) {
    const ch = lower[i];
    if (ch.charCodeAt(0) < 0x80) { out += ch; continue; }
    let folded = foldCache.get(ch);
    if (folded === undefined) {
      const base = ch === 'đ' ? 'd' : ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
      folded = base.length === 1 ? base : ch;
      foldCache.set(ch, folded);
    }
    out += folded;
  }
  return out;
}

const L = '\\p{L}\\p{N}';
/** Ranh giới từ (chữ có dấu tính là chữ). */
const word = (body: string) => new RegExp(`(?<![${L}])(?:${body})(?![${L}])`, 'gu');

interface Rules {
  durations: RegExp[];
  endOfWeek: RegExp;
  startOfNextWeek: RegExp;
  endOfMonth: RegExp;
  nextWeek: RegExp;
  prevWeek: RegExp;
  weekdayPast: RegExp;
  enumeration: RegExp;
  weekday: RegExp;
  ordinalBefore: RegExp;
  listAfter: RegExp;
  rel: RegExp;
  dayOfMonth: RegExp;
  monthFirst: RegExp;
  slashBefore: RegExp;
  slashAfter: RegExp;
  period: RegExp;
  durationCue: RegExp;
  standalone: RegExp;
  lexicon: DayWordLexicon;
  pastClauseEnd: RegExp;
  future: RegExp;
  recurring: RegExp;
}

const rulesCache: { accented?: Rules; plain?: Rules } = {};

/** Bộ luật cho tin có dấu / không dấu (dựng một lần). */
function rulesFor(accented: boolean): Rules {
  const cached = accented ? rulesCache.accented : rulesCache.plain;
  if (cached) return cached;
  const pick = (withAccents: string, plain: string) => (accented ? withAccents : plain);
  const keys = Object.keys(NUMBER_WORDS);
  const numberWords = keys
    .filter(key => (accented
      ? key !== foldKeepLength(key) || !keys.some(other => other !== key && foldKeepLength(other) === key)
      : key === foldKeepLength(key)))
    .sort((a, b) => b.length - a.length)
    .map(key => key.replace(/ /g, '\\s+'))
    .join('|');
  const num = `(\\d{1,3}|${numberWords})`;
  const half = pick('(\\s*rưỡi)?', '(\\s*ruoi)?');
  const anyUnit = pick('(tiếng|giờ|h|phút|p|ngày|tuần)', '(tieng|gio|h|phut|p|ngay|tuan)');
  // "sau 2h" / "2h sau" có thể là "sau 2 giờ chiều": chỉ nhận đơn vị không lẫn với giờ
  const safeUnit = pick('(tiếng|phút|p|ngày|tuần)', '(tieng|phut|p|ngay|tuan)');
  const notRelative = pick('(?!\\s+(?:khi|đó|kể|lúc))', '(?!\\s+(?:khi|do|ke|luc))');
  const periodWords = pick('sáng|trưa|chiều|tối|đêm', 'sang|trua|chieu|toi|dem');
  // "thứ 2 tuần sau" không phải "2 tuần sau"
  const notWeekday = `(?<!${pick('thứ', 'thu')}\\s*)`;
  const lexicon = Object.fromEntries(Object.entries(DAY_WORD_LEXICON).map(([key, pair]) => [
    key, new Set((accented ? pair[0] : pair[1]).split('|').filter(Boolean)),
  ])) as DayWordLexicon;
  const rules: Rules = {
    durations: [
      word(`${notWeekday}${num}\\s*${anyUnit}${half}\\s*${pick('nữa', 'nua')}`),
      word(`sau\\s+${num}\\s*${safeUnit}${half}${notRelative}`),
      word(`${notWeekday}${num}\\s*${safeUnit}${half}\\s+sau${notRelative}`),
    ],
    endOfWeek: word(pick('(?:cuối|hết)\\s+tuần(?:\\s+(sau|tới|này|trước|rồi|qua))?', '(?:cuoi|het)\\s+tuan(?:\\s+(sau|toi|nay|truoc|roi|qua))?')),
    startOfNextWeek: word(pick('đầu\\s+tuần\\s+(?:sau|tới)', 'dau\\s+tuan\\s+(?:sau|toi)')),
    endOfMonth: word(pick('cuối\\s+tháng(?:\\s+(sau|tới|này|trước|rồi|qua))?', 'cuoi\\s+thang(?:\\s+(sau|toi|nay|truoc|roi|qua))?')),
    nextWeek: word(pick('tuần\\s+(?:sau|tới)', 'tuan\\s+(?:sau|toi)')),
    prevWeek: word(pick('tuần\\s+(?:trước|rồi|qua)', 'tuan\\s+(?:truoc|roi|qua)')),
    // "thứ 6 vừa rồi", "thứ 6 tuần trước": ngày đã qua ("thứ 6 trước 9h" là hạn chót, không tính)
    weekdayPast: new RegExp(`^\\s+(?:${pick(
      'vừa\\s+rồi|vừa\\s+qua|tuần\\s+trước|tuần\\s+rồi|tuần\\s+qua',
      'vua\\s+roi|vua\\s+qua|tuan\\s+truoc|tuan\\s+roi|tuan\\s+qua',
    )})(?![${L}])`, 'u'),
    enumeration: word(pick('thứ\\s+nhất', 'thu\\s+nhat')),
    weekday: word(pick(
      'thứ\\s*(2|3|4|5|6|7|hai|ba|tư|năm|sáu|bảy)|(chủ\\s*nhật|cn)|t([2-7])',
      'thu\\s*(2|3|4|5|6|7|hai|ba|tu|nam|sau|bay)|(chu\\s*nhat|cn)|t([2-7])',
    )),
    ordinalBefore: new RegExp(`(?:^|[^${L}])(?:${pick(ORDINAL_NOUNS.accented, ORDINAL_NOUNS.plain)})\\s*$`, 'u'),
    listAfter: new RegExp(`^\\s*(?:${pick('là', 'la')}(?![${L}])|[,:;])`, 'u'),
    // Gõ không dấu: "toi qua", "dem qua", "sang qua" thường là "tôi qua", "đem qua", "sang qua" → chỉ nhận "chiều / trưa
    // qua" và "tối hôm qua"
    rel: word(pick(
      `hôm\\s+nay|bữa\\s+nay|(${periodWords})(?:\\s+hôm)?\\s+(nay|mai|qua)|ngày\\s+mai|ngày\\s+mốt|ngày\\s+kia|hôm\\s+qua|hôm\\s+kia`,
      `hom\\s+nay|bua\\s+nay|(${periodWords})(?:\\s+hom)?\\s+(nay|mai)|(trua|chieu)(?:\\s+hom)?\\s+(qua)|(sang|toi|dem)\\s+hom\\s+(qua)|ngay\\s+mai|ngay\\s+kia|hom\\s+qua|hom\\s+kia`,
    )),
    dayOfMonth: word(pick(
      `(?:ngày|mồng|mùng)\\s*(\\d{1,2})(?!\\s*(?:${COUNT_WORDS.accented})(?![${L}]))(?:\\s*(?:tháng|th)\\s*(\\d{1,2}))?(\\s+tháng\\s+(?:sau|tới))?`,
      `(?:ngay|mong|mung)\\s*(\\d{1,2})(?!\\s*(?:${COUNT_WORDS.plain})(?![${L}]))(?:\\s*(?:thang|th)\\s*(\\d{1,2}))?(\\s+thang\\s+(?:sau|toi))?`,
    )),
    monthFirst: word(pick(
      'tháng\\s+(?:sau|tới)\\s+(?:vào\\s+)?(?:ngày|mồng|mùng)\\s*(\\d{1,2})',
      'thang\\s+(?:sau|toi)\\s+(?:vao\\s+)?(?:ngay|mong|mung)\\s*(\\d{1,2})',
    )),
    // dd/mm không phải ngày: điểm / tỉ lệ ("được 9/10", "tỉ lệ 1/2"), địa chỉ ("số 12/3", "hẻm 5/7", "đường 3/2")…
    slashBefore: new RegExp(`(?:^|[^${L}])(?:${pick(
      'tỉ\\s+lệ|tỷ\\s+lệ|được|đạt|chấm|còn|số|hẻm|ngõ|ngách|kiệt|nhà|đường|lô|căn|địa\\s+chỉ|đ/c',
      'ti\\s+le|ty\\s+le|duoc|cham|con|so|hem|ngo|ngach|kiet|nha|duong|lo|can|dia\\s+chi|d/c',
    )})\\s*:?\\s*$`, 'u'),
    // … hoặc số đếm / đơn vị ("10/10 điểm", "còn 2/10 suất", "20/11h")
    slashAfter: new RegExp(`^\\s*(?:${pick(
      'điểm|sao|star|người|cái|sp|suất|lượt|slot|lần|bài|câu|môn|chiếc|gói|viên|ly|cốc|size|cuốn|kg|ml|cm|km|tr|triệu|k|nghìn|ngàn|%|h|g|giờ|p|phút',
      'diem|sao|star|nguoi|cai|sp|suat|luot|slot|lan|bai|cau|mon|chiec|goi|vien|ly|coc|size|cuon|kg|ml|cm|km|tr|trieu|k|nghin|ngan|%|h|g|gio|p|phut',
    )})(?![${L}])`, 'u'),
    period: word(pick(`(?:buổi\\s+)?(${periodWords})`, `(?:buoi\\s+)?(${periodWords})`)),
    durationCue: new RegExp(`(?:^|[^${L}])(?:${pick(
      'trong(?:\\s+vòng)?|mất|mỗi|cách|hơn|tối\\s+đa|ít\\s+nhất',
      'trong(?:\\s+vong)?|mat|moi|cach|hon|toi\\s+da|it\\s+nhat',
    )})\\s*$`, 'u'),
    standalone: word(pick('mai|mốt', 'mai')),
    lexicon,
    // "Mai đi học chưa?", "Mai gửi rồi ạ": việc đã xảy ra
    pastClauseEnd: new RegExp(`(?<![${L}])${pick(
      '(?:rồi|chưa)(?:\\s+(?:ạ|à|nhỉ|ha|hả|vậy|thế|hở|á|đó|đấy))?',
      '(?:roi|chua)(?:\\s+(?:a|nhi|ha|vay|the|ho|do|day))?',
    )}\\s*$`, 'u'),
    // Chữ hẹn: giờ đã qua lúc gửi mà có chữ này mới coi là hẹn ngày mai ("9h họp nhé" gửi lúc 10h)
    future: word(pick(
      'nhé|nha|nhá|nhe|nghen|hen|nhen|sẽ|hẹn|nhớ|kịp|chuẩn\\s+bị|được\\s+không|đc\\s+không|ok\\s+không',
      'nhe|nha|nghen|hen|nhen|se|kip|chuan\\s+bi|duoc\\s+khong|dc\\s+khong|ok\\s+khong',
    )),
    // Lịch lặp / giờ mở cửa: không phải một lịch hẹn
    recurring: word(pick(
      'hằng\\s+ngày|hàng\\s+ngày|mỗi\\s+ngày|mỗi\\s+sáng|mỗi\\s+trưa|mỗi\\s+chiều|mỗi\\s+tối|mỗi\\s+tuần|hằng\\s+tuần|hàng\\s+tuần|các\\s+ngày|cả\\s+tuần|mở\\s+cửa|đóng\\s+cửa|giờ\\s+làm\\s+việc|giờ\\s+hành\\s+chính|thứ\\s*[2-7]\\s*(?:-|đến|tới)\\s*(?:thứ\\s*[2-7]|chủ\\s*nhật|cn)|t[2-7]\\s*-\\s*(?:t[2-7]|cn)|24/7',
      'hang\\s+ngay|moi\\s+ngay|moi\\s+sang|moi\\s+trua|moi\\s+chieu|moi\\s+toi|moi\\s+tuan|hang\\s+tuan|cac\\s+ngay|ca\\s+tuan|mo\\s+cua|dong\\s+cua|gio\\s+lam\\s+viec|gio\\s+hanh\\s+chinh|thu\\s*[2-7]\\s*(?:-|den|toi)\\s*(?:thu\\s*[2-7]|chu\\s*nhat|cn)|t[2-7]\\s*-\\s*(?:t[2-7]|cn)|24/7',
    )),
  };
  if (accented) rulesCache.accented = rules; else rulesCache.plain = rules;
  return rules;
}

// Đọc trên bản bỏ dấu (giờ / ngày bằng số)
const ISO_RE = /(?<![\d/.,:-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d/.,:-])/g;
/** dd/mm[/yy(yy)] hoặc dd-mm-yyyy ("9-11h" là khoảng giờ). */
const SLASH_RE = /(?<![\d/.,:-])(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{4}|\d{2}))?|-(\d{1,2})-(\d{4}|\d{2}))(?![\d/.,:-])/g;
/** [giờ, phút, đã là giờ 24 tiếng (am / pm: không suy buổi)] */
const TIME_RES: Array<{ re: RegExp; read: (m: RegExpExecArray) => [number, number, boolean?] }> = [
  // 8pm, 7:30am, 7h30 pm
  {
    re: /(?<![\d:/.,-])(\d{1,2})(?:\s*[:h]\s*(\d{2}))?\s*(am|pm)(?![a-z])/g,
    read: m => {
      const hour12 = Number(m[1]);
      if (hour12 < 1 || hour12 > 12) return [-1, 0];
      return [(hour12 % 12) + (m[3] === 'pm' ? 12 : 0), Number(m[2] || 0), true];
    },
  },
  // 9-11h, 9 đến 11h: giờ bắt đầu ("8-10h/ngày" là khoảng thời gian)
  { re: /(?<![\d:/.,-])(\d{1,2})\s*(?:h|gio)?\s*(?:-|den|toi)\s*\d{1,2}\s*(?:h|gio)(?![a-z0-9]|\s*\/)/g, read: m => [Number(m[1]), 0] },
  // 9h kém 15 → 8:45
  { re: /(?<![\d:/.,-])(\d{1,2})\s*(?:h|gio)\s*kem\s*(\d{1,2})\s*(?:phut|p)?(?![a-z0-9])/g, read: m => [Number(m[1]) - 1, 60 - Number(m[2])] },
  // 9 giờ rưỡi / 9h rưỡi
  { re: /(?<![\d:/.,-])(\d{1,2})\s*(?:h|gio)\s*ruoi(?![a-z0-9])/g, read: m => [Number(m[1]), 30] },
  // 9h, 9h30, 9h30p, 9h30ph, 9 giờ 30 phút, 9h 30, 9h đúng ("2HP" là công suất, "8h/ngày" là khoảng thời gian, "9h 2 người"
  // là 9:00)
  {
    re: /(?<![\d:/.,-])(\d{1,2})\s*(?:h|gio)(?:\s*(\d{1,2})\s*(?:phut|ph|p)(?![a-z])|(\d{1,2})|\s+(\d{2})(?!\d))?(?:\s+dung)?(?![a-z0-9]|\s*\/)/g,
    read: m => [Number(m[1]), Number(m[2] || m[3] || m[4] || 0)],
  },
  // 9:30
  { re: /(?<![\d:/.,-])(\d{1,2}):(\d{2})(?![\d:])/g, read: m => [Number(m[1]), Number(m[2])] },
  // 9g30
  { re: /(?<![\d:/.,-])(\d{1,2})g(\d{2})(?![a-z0-9])/g, read: m => [Number(m[1]), Number(m[2])] },
  // lúc 9 (không có h / giờ)
  { re: /(?<![a-z0-9])luc\s+(\d{1,2})(?![\d%]|[:.,/]\d)/g, read: m => [Number(m[1]), 0] },
];

interface Hit { start: number; end: number }

function overlaps(used: Hit[], start: number, end: number): boolean {
  return used.some(hit => start < hit.end && end > hit.start);
}

function firstMatch(re: RegExp, text: string, used: Hit[]): RegExpExecArray | null {
  re.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    if (!overlaps(used, match.index, match.index + match[0].length)) return match;
    if (match[0].length === 0) re.lastIndex++;
  }
  return null;
}

function hasMatch(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  return re.test(text);
}

const DAY_MS = 86_400_000;
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d: Date, days: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

function validDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(year, month - 1, day);
  return d.getMonth() === month - 1 && d.getDate() === day ? d : null;
}

/**
 * Ngày / tháng không kèm năm: năm nay; đã qua hơn nửa năm thì năm sau ("5/1" nói vào tháng 12). Mới qua ("20/10" nói ngày
 * 26/10) vẫn là ngày đã qua. "ngày 5": tháng này, đã qua thì tháng sau.
 */
function resolveDayMonth(today: Date, day: number, month: number, yearText?: string, nextMonth = false): Date | null {
  if (yearText) return validDate(yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText), month, day);
  if (month) {
    const thisYear = validDate(today.getFullYear(), month, day);
    if (thisYear && today.getTime() - thisYear.getTime() > 183 * DAY_MS) return validDate(today.getFullYear() + 1, month, day);
    return thisYear;
  }
  const monthStart = new Date(today.getFullYear(), today.getMonth() + (nextMonth ? 1 : 0), 1);
  const inMonth = validDate(monthStart.getFullYear(), monthStart.getMonth() + 1, day);
  if (nextMonth || (inMonth && inMonth >= today)) return inMonth;
  const following = new Date(today.getFullYear(), today.getMonth() + 1, 1);
  return validDate(following.getFullYear(), following.getMonth() + 1, day);
}

function adjustHour(hour: number, period: Period | null): number {
  if ((period === 'evening' || period === 'night') && hour === 12) return 24; // 12h đêm = 0:00 hôm sau
  if (period === 'afternoon' || period === 'evening') return hour < 12 ? hour + 12 : hour;
  if (period === 'noon') return hour <= 2 ? hour + 12 : hour;
  if (period === 'night') return hour >= 6 && hour < 12 ? hour + 12 : hour;
  if (period === 'morning') return hour === 12 ? 0 : hour;
  return hour >= 1 && hour <= 5 ? hour + 12 : hour;
}

function numberOf(token: string): number | null {
  const t = token.trim().replace(/\s+/g, ' ');
  if (/^\d{1,3}$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

// ── Ngữ cảnh từ ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Token { text: string; lower: string; start: number; end: number; isWord: boolean }
const TOKEN_RE = /[\p{L}\p{N}&]+|[^\s\p{L}\p{N}&]+/gu;

/** Các từ / dấu câu quanh đoạn [start, end) (cửa sổ ngắn: chỉ cần vài từ hai bên). */
function tokensAround(original: string, text: string, start: number, end: number): { before: Token[]; after: Token[] } {
  const from = Math.max(0, start - 48);
  const to = Math.min(original.length, end + 64);
  const windowText = original.slice(from, to);
  const before: Token[] = [];
  const after: Token[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(windowText))) {
    const tokenStart = from + m.index;
    const tokenEnd = tokenStart + m[0].length;
    const token = { text: m[0], lower: text.slice(tokenStart, tokenEnd), start: tokenStart, end: tokenEnd, isWord: /^[\p{L}\p{N}&]/u.test(m[0]) };
    if (tokenEnd <= start) before.push(token);
    else if (tokenStart >= end) after.push(token);
  }
  return { before, after };
}

/**
 * "mai" (ngày mai) / "mốt" (ngày kia) đứng một mình có phải là ngày không, theo các từ quanh nó. Tên người ("Mai Dũng vs
 * Đặng Sơn", "chị Mai", "Mai ơi", "gửi cho Mai", "Mai đã gửi"), từ ghép ("hoa mai", "mai mối", "mai mốt" = một ngày nào
 * đó, "đúng mốt", "mốt mới") thì không. Là ngày khi sát giờ / buổi ("Mai 9h", "9h mai"), sau chữ chỉ thời gian ("để mai",
 * "đến mai"), hoặc ở đầu câu / viết thường và theo sau là chủ ngữ, việc làm, từ đệm ("Mai em gửi", "mai giao hàng", "Mai
 * nhé", "Dạ mai ạ"). "Mai" viết hoa giữa câu luôn là tên.
 */
function bareDayWordIsDate(ctx: {
  rules: Rules; accented: boolean; allCaps: boolean; original: string; text: string; start: number; end: number;
  timeHit: Hit | null; periodHit: Hit | null;
}): boolean {
  const { rules, accented, allCaps, original, text, start, end, timeHit, periodHit } = ctx;
  const lex = rules.lexicon;
  const isMai = text.slice(start, end) === 'mai';
  const { before, after } = tokensAround(original, text, start, end);
  const sameLine = (from: number, to: number) => !original.slice(from, to).includes('\n');
  const prevToken = before[before.length - 1];
  const prev = prevToken?.isWord && sameLine(prevToken.end, start) ? prevToken : null;
  const nextToken = after[0];
  const next = nextToken?.isWord && sameLine(end, nextToken.start) ? nextToken : null;
  const afterNext = next && after[1]?.isWord && sameLine(next.end, after[1].start) ? after[1] : null;
  const has = (set: Set<string>, token: Token | null) => !!token && set.has(token.lower);
  const upper = (value: string) => !allCaps && /^\p{Lu}/u.test(value);
  const capital = upper(original.slice(start, end));
  const sentenceStart = /(?:^|[.!?…\n])[^\p{L}\p{N}]*$/u.test(original.slice(0, start));

  // Từ ghép, thời trang: hoa mai, mai mối, mai mốt, đúng mốt, mốt mới
  if (isMai ? has(lex.maiCompoundBefore, prev) || has(lex.maiCompoundAfter, next)
    : has(lex.motCompoundBefore, prev) || has(lex.motCompoundAfter, next)) return false;
  // Gọi tên: "Mai ơi", "Mai à, …"
  if (has(lex.vocativeAfter, next)) return false;
  if (next && next.lower === (accented ? 'à' : 'a') && /^\s*,/.test(original.slice(next.end))) return false;
  // Tên: chữ sau viết hoa ("Mai Dũng", "Mai Anh"; "Mai Em gửi" viết hoa kính trọng vẫn là ngày), "Mai và Lan"
  if (next && upper(next.text) && !(lex.pronounsAfter.has(next.lower) && next.lower !== 'anh')) return false;
  if (capital && has(lex.coordinationAfter, next)) return false;
  // "chị Mai", "Nguyễn Thị Mai", "gặp Mai 9h": viết hoa giữa câu là tên
  if (capital && !sentenceStart) return false;
  // Sát giờ / buổi: "Mai 9h", "9h mai", "mai sáng"
  const gap = (hit: Hit | null) => (!hit ? Infinity : start >= hit.end ? start - hit.end : hit.start - end);
  const nearest = Math.min(gap(timeHit), gap(periodHit));
  if (nearest <= 2) return true;
  // Việc đã / đang xảy ra: "Mai đã gửi", "Mai đi học chưa?"
  if (has(lex.pastAfter, next) || has(lex.pastAfter, afterNext)) return false;
  if (rules.pastClauseEnd.test(text.slice(end).split(/[.!?…\n]/u)[0])) return false;
  if (!capital && nearest <= 12) return true;
  if (has(lex.temporalBefore, prev)) return true;
  if (has(lex.personBefore, prev)) return false;
  // "Mai.", "hẹn mai", "em gửi mai"
  if (!next) return true;
  if (next.lower === (accented ? 'là' : 'la')) return !has(lex.personAfterIs, afterNext);
  return has(lex.pronounsAfter, next) || has(lex.verbsAfter, next) || has(lex.particlesAfter, next);
}

export function parseViDateTime(input: string, now: Date = new Date()): ViDateTime | null {
  const original = String(input || '').normalize('NFC');
  if (!original.trim()) return null;
  const lower = original.toLowerCase();
  if (lower.length !== original.length) return null; // không khớp vị trí (ký tự đặc biệt khi viết thường) → bỏ qua
  const folded = foldKeepLength(lower);
  // Tin có dấu: đọc chữ trên bản có dấu (phân biệt tối / tôi…); tin không dấu: đọc trên bản bỏ dấu
  const accented = folded !== lower;
  const text = accented ? lower : folded;
  const rules = rulesFor(accented);
  // Tin viết hoa toàn bộ: chữ hoa không nói lên gì (tên người, tên đường)
  const allCaps = !/\p{Ll}/u.test(original);
  const used: Hit[] = [];
  const take = (start: number, end: number) => { used.push({ start, end }); };
  const takeMatch = (m: RegExpExecArray) => take(m.index, m.index + m[0].length);
  const spansOf = () => used.map(hit => [hit.start, hit.end] as [number, number]).sort((a, b) => a[0] - b[0]);
  const today = startOfDay(now);
  const thisMonday = addDays(today, -((today.getDay() + 6) % 7));
  const nextMonday = () => addDays(thisMonday, 7);
  const lastOf = (when?: string) => (/^(trước|truoc|rồi|roi|qua)$/.test(when || '') ? -1 : /^(sau|tới|toi)$/.test(when || '') ? 1 : 0);

  let day: Date | null = null;
  let weakDay = false;

  // ── Khoảng thời gian tính từ lúc gửi: "20 phút nữa", "sau 2 tiếng", "3 ngày nữa" ──────────────────────────────
  for (const re of rules.durations) {
    const m = firstMatch(re, text, used);
    if (!m) continue;
    const amount = numberOf(m[1]);
    if (amount === null || amount <= 0) continue;
    const unit = foldKeepLength(m[2]);
    const half = m[3] ? 0.5 : 0;
    const minutes = unit === 'phut' || unit === 'p' ? (half ? NaN : amount)
      : unit === 'tieng' || unit === 'gio' || unit === 'h' ? (amount + half) * 60
        : null;
    if (minutes !== null) {
      if (!(minutes > 0 && minutes <= 7 * 24 * 60)) continue;
      takeMatch(m);
      return { at: now.getTime() + Math.round(minutes) * 60_000, hasDate: true, hasTime: true, confident: true, spans: spansOf() };
    }
    const days = unit === 'tuan' ? amount * 7 : amount;
    if (half || !Number.isInteger(days) || days > 366) continue;
    takeMatch(m);
    day = addDays(today, days);
    break;
  }

  // ── Ngày ───────────────────────────────────────────────────────────────────
  if (!day) {
    const m = firstMatch(rules.endOfWeek, text, used); // cuối tuần = thứ 7
    if (m) {
      day = addDays(today, ((6 - today.getDay() + 7) % 7) + 7 * lastOf(m[1]));
      takeMatch(m);
    }
  }
  if (!day) {
    const m = firstMatch(rules.startOfNextWeek, text, used);
    if (m) { day = nextMonday(); takeMatch(m); }
  }
  if (!day) {
    const m = firstMatch(rules.endOfMonth, text, used);
    if (m) {
      day = new Date(today.getFullYear(), today.getMonth() + 1 + lastOf(m[1]), 0);
      takeMatch(m);
    }
  }
  // Ngày viết rõ (thắng "thứ" đi kèm: "thứ 2, 2/11")
  if (!day) {
    const m = firstMatch(ISO_RE, folded, used);
    const resolved = m && validDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (m && resolved) { day = resolved; takeMatch(m); }
  }
  if (!day) {
    SLASH_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SLASH_RE.exec(folded))) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(used, start, end)) continue;
      const monthText = m[2] ?? m[4];
      const yearText = m[3] ?? m[5];
      // "24/7", "được 9/10", "số 12/3", "còn 2/10 suất": không phải ngày
      if (!yearText && m[1] === '24' && monthText === '7') continue;
      if (rules.slashBefore.test(text.slice(Math.max(0, start - 14), start)) || rules.slashAfter.test(text.slice(end))) continue;
      // "12/3 Nguyễn Trãi": số nhà + tên đường viết hoa
      if (!allCaps && /^\s+\p{Lu}\p{L}*\s+\p{Lu}/u.test(original.slice(end, end + 40))) continue;
      const resolved = resolveDayMonth(today, Number(m[1]), Number(monthText), yearText);
      if (!resolved) continue;
      day = resolved;
      weakDay = !yearText && m[1].length === 1 && monthText.length === 1; // "1/2" cũng là phân số
      takeMatch(m);
      break;
    }
  }
  if (!day) {
    const words = firstMatch(rules.dayOfMonth, text, used);
    const monthFirst = words ? null : firstMatch(rules.monthFirst, text, used);
    const m = words || monthFirst;
    if (m) {
      const resolved = resolveDayMonth(today, Number(m[1]), words && m[2] ? Number(m[2]) : 0, undefined, !!monthFirst || !!(words && m[3]));
      if (resolved) { day = resolved; takeMatch(m); }
    }
  }

  // "tuần sau / tuần tới" (trước khi đọc "tới" thành buổi tối khi gõ không dấu), "tuần trước"
  const nextWeek = firstMatch(rules.nextWeek, text, used);
  if (nextWeek) takeMatch(nextWeek);
  const prevWeek = nextWeek ? null : firstMatch(rules.prevWeek, text, used);
  let weekdayToday = false;
  {
    const enumeration = hasMatch(rules.enumeration, text);
    const re = rules.weekday;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(used, start, end)) continue;
      const target = m[2] ? 0 : WEEKDAY_OF[m[1] || m[3]];
      if (target === undefined) continue;
      if (m[1] && (enumeration || rules.ordinalBefore.test(text.slice(Math.max(0, start - 12), start)))) continue;
      takeMatch(m);
      if (!day) {
        const pastAfter = !nextWeek && !prevWeek ? rules.weekdayPast.exec(text.slice(end)) : null;
        if (pastAfter) take(end, end + pastAfter[0].length);
        if (prevWeek) takeMatch(prevWeek);
        const offset = (target + 6) % 7; // thứ 2 = 0 … chủ nhật = 6
        if (nextWeek) day = addDays(thisMonday, 7 + offset);
        else if (prevWeek) day = addDays(thisMonday, offset - 7);
        else if (pastAfter) day = addDays(today, -(((today.getDay() - target + 7) % 7) || 7));
        else day = addDays(today, (target - today.getDay() + 7) % 7);
        weekdayToday = !nextWeek && !prevWeek && !pastAfter && day.getTime() === today.getTime();
        // "thứ 2" chắc chắn; "thứ hai là…", "cn", "t2" thì chưa (cần thêm giờ / buổi)
        const spokenWord = !!m[1] && !/\d/.test(m[1]);
        weakDay = !nextWeek && (m[2] ? m[2].replace(/\s+/g, '') === 'cn'
          : m[3] ? true
            : spokenWord && rules.listAfter.test(text.slice(end, end + 4)));
      }
      break;
    }
  }

  let period: Period | null = null;
  let periodHit: Hit | null = null;

  if (!day) {
    const m = firstMatch(rules.rel, text, used);
    if (m) {
      const periodWord = m[1] || m[3] || m[5];
      const phrase = m[0].replace(/\s+/g, ' ');
      const tail = m[2] || m[4] || m[6] || phrase.slice(phrase.lastIndexOf(' ') + 1);
      const offset = tail === 'mai' ? 1
        : tail === 'qua' ? -1
          : /^(hôm|hom) kia$/.test(phrase) ? -2
            : tail === 'mốt' || tail === 'kia' ? 2 : 0;
      day = addDays(today, offset);
      if (periodWord) {
        period = PERIOD_OF[periodWord] || null;
        periodHit = { start: m.index, end: m.index + m[0].length };
      }
      takeMatch(m);
    }
  }

  // ── Giờ ────────────────────────────────────────────────────────────────────
  let hour: number | null = null;
  let minute = 0;
  let hourIs24 = false;
  let timeHit: Hit | null = null;
  search: for (const { re, read } of TIME_RES) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(folded))) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(used, start, end)) continue;
      const [h, min, is24] = read(m);
      if (h < 0 || h > 23 || min < 0 || min > 59) continue;
      // "trong 2h", "mất 2h", "2 giờ đồng hồ": khoảng thời gian, không phải giờ hẹn
      if (rules.durationCue.test(text.slice(Math.max(0, start - 16), start)) || /^\s*dong\s*ho(?![a-z])/.test(folded.slice(end))) continue;
      hour = h;
      minute = min;
      hourIs24 = !!is24;
      timeHit = { start, end };
      take(start, end);
      break search;
    }
  }

  // Buổi (sáng / chiều / tối…) gần giờ nhất, nếu chưa đọc cùng "nay / mai"
  if (!period) {
    const re = rules.period;
    re.lastIndex = 0;
    let best: { m: RegExpExecArray; distance: number } | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(used, start, end)) continue;
      const ambiguous = !accented && AMBIGUOUS_PLAIN_PERIODS.has(m[1]);
      if (!timeHit) {
        if (ambiguous) continue;
        best = { m, distance: 0 };
        break;
      }
      const distance = start >= timeHit.end ? start - timeHit.end : timeHit.start - end;
      if (distance > (ambiguous ? 2 : 12)) continue;
      if (!best || distance < best.distance) best = { m, distance };
    }
    if (best) {
      period = PERIOD_OF[best.m[1]] || null;
      periodHit = { start: best.m.index, end: best.m.index + best.m[0].length };
      take(periodHit.start, periodHit.end);
    }
  }

  // "mai" (ngày mai) / "mốt" (ngày kia) đứng một mình: xét ngữ cảnh từ (bareDayWordIsDate)
  if (!day) {
    const re = rules.standalone;
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(used, start, end)) continue;
      if (!bareDayWordIsDate({ rules, accented, allCaps, original, text, start, end, timeHit, periodHit })) continue;
      day = addDays(today, m[0] === 'mai' ? 1 : 2);
      takeMatch(m);
      break;
    }
  }

  // "tuần sau" không kèm thứ / ngày → thứ 2 tuần sau (chỉ có ngày)
  if (!day && nextWeek) day = nextMonday();

  const hasTime = hour !== null || period !== null;
  if (!day && !hasTime) return null;

  let h = hour !== null ? (hourIs24 ? hour : adjustHour(hour, period)) : period ? PERIOD_DEFAULT_HOUR[period] : 9;
  const min = hour !== null ? minute : 0;
  const timeOn = (d: Date, hh: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, min).getTime();
  // "hẹn a 8h nhé" gửi lúc 19:02 là 20:00 tối đó, không phải 8:00 sáng mai: giờ 6-9 không kèm buổi, trong ngày gửi, giờ
  // sáng đã qua mà giờ tối còn trong 8 tiếng → buổi tối ("9h30 họp" gửi 10:24 vẫn là 9:30 sáng mai)
  const base = day || today;
  if (hour !== null && !hourIs24 && !period && hour >= 6 && hour <= 9 && !weekdayToday && base.getTime() === today.getTime()
    && timeOn(base, h) <= now.getTime() && timeOn(base, h + 12) > now.getTime()
    && timeOn(base, h + 12) - now.getTime() <= 8 * 3_600_000) h += 12;
  const atOn = (d: Date) => timeOn(d, h);
  let at = atOn(day || today);
  // Chỉ có giờ, giờ đó hôm nay đã qua → ngày mai
  const rolled = !day && at <= now.getTime();
  if (rolled) at = atOn(addDays(today, 1));
  // Thứ X là hôm nay: không giờ, hoặc giờ đã qua → thứ X tuần sau (nói "thứ 2" vào thứ 2 thường là tuần sau)
  if (weekdayToday && (!hasTime || at <= now.getTime())) at = atOn(addDays(today, 7));

  let confident = hour !== null || (!!day && (!weakDay || period !== null));
  // Giờ đã qua lúc gửi, không kèm ngày ("lúc 9h em có gọi" gửi lúc 10h): chỉ là hẹn ngày mai khi có chữ hẹn ("9h họp nhé")
  if (rolled && !hasMatch(rules.future, text)) confident = false;
  // Lịch lặp, giờ mở cửa ("hằng ngày", "thứ 2 - thứ 7"): không phải một lịch hẹn
  if (confident && hasMatch(rules.recurring, text)) confident = false;
  return { at, hasDate: !!day, hasTime, confident, spans: spansOf() };
}

/** Chữ nối đứng trước ngày giờ ("lúc 5h", "tầm 9h", "ngày 5/11"): bỏ cùng ngày giờ. */
const LEAD_CONNECTORS = [
  'vào lúc', 'vào khoảng', 'lúc', 'vào', 'khoảng', 'tầm', 'gần', 'đúng', 'từ', 'hôm', 'ngày', 'buổi',
  'luc', 'vao', 'khoang', 'tam',
];
/** Chữ nối còn sót ở đầu / cuối tiêu đề. "đến", "tới", "sau" ở cuối giữ lại: "anh tới", "khách đến". */
const CONNECTORS = [...LEAD_CONNECTORS, 'đến', 'tới', 'sau', 'còn'];
const TRAILING_KEEP = new Set(['đến', 'tới', 'sau']);
const LEAD_BEFORE_SPAN = new RegExp(`(?:^|\\s)(?:${LEAD_CONNECTORS.map(c => c.replace(/ /g, '\\s+')).join('|')})\\s*$`, 'iu');
const PARTICLES = [
  'nhé cả nhà', 'nha cả nhà', 'nhé mọi người', 'nha mọi người', 'mọi người nhé', 'cả nhà nhé', 'nhé anh em', 'anh em nhé',
  'nhé anh', 'nhé chị', 'nhé em', 'anh nhé', 'chị nhé', 'em nhé', 'nhé', 'nha', 'nhe', 'nhá', 'nhỉ', 'ạ', 'à', 'nhen', 'nghen',
];

/** Tiêu đề lịch từ tin: bỏ phần ngày giờ đã đọc, chữ nối thừa ("lúc", "vào"…), từ đệm cuối câu ("nhé cả nhà"…). */
export function titleWithoutDateTime(input: string, spans: Array<[number, number]>, max = 80): string {
  let text = String(input || '').normalize('NFC');
  for (const [start, end] of [...spans].sort((a, b) => b[0] - a[0])) {
    let head = text.slice(0, start);
    for (let lead = LEAD_BEFORE_SPAN.exec(head); lead; lead = LEAD_BEFORE_SPAN.exec(head)) head = head.slice(0, lead.index);
    text = `${head} ${text.slice(end)}`;
  }
  text = text.replace(/\s+/g, ' ').trim();
  const edge = (value: string) => value.replace(/^[\s,.;:!?…-]+|[\s,.;:!?…-]+$/g, '');
  for (let pass = 0; pass < 4; pass++) {
    const before = text;
    text = edge(text);
    for (const c of CONNECTORS) {
      const lowered = text.toLowerCase();
      if (lowered.startsWith(`${c} `)) text = text.slice(c.length + 1);
      if (lowered.endsWith(` ${c}`) && !TRAILING_KEEP.has(c)) text = text.slice(0, -(c.length + 1));
    }
    for (const p of PARTICLES) {
      const lowered = text.toLowerCase();
      if (lowered === p) text = '';
      else if (lowered.endsWith(` ${p}`)) text = text.slice(0, -(p.length + 1));
    }
    text = edge(text.replace(/\s+/g, ' '));
    if (text === before) break;
  }
  if (!text) return '';
  const capped = text.charAt(0).toLocaleUpperCase('vi') + text.slice(1);
  return capped.length > max ? `${capped.slice(0, max - 1)}…` : capped;
}

/**
 * Tin có ngày giờ đọc chắc chắn và CHƯA tới (tính từ lúc gửi tin) → nút "Tạo lịch hẹn" dưới tin. Kết quả đọc nhớ theo tin
 * (danh sách tin vẽ lại nhiều lần); chỉ có ngày thì còn trong ngày đó vẫn tính là sắp tới.
 */
const upcomingCache = new Map<string, ViDateTime | null>();
export function upcomingDateTimeInMessage(
  msg: { msg_id?: string | number | null; timestamp?: number | string | null; text: string },
  nowMs: number = Date.now(),
): ViDateTime | null {
  const text = msg.text || '';
  if (!text.trim() || text.length > 1000) return null;
  const sentAt = Number(msg.timestamp) || nowMs;
  const key = `${msg.msg_id ?? ''}|${sentAt}|${text.length}|${text.slice(0, 24)}`;
  let parsed = upcomingCache.get(key);
  if (parsed === undefined) {
    const found = parseViDateTime(text, new Date(sentAt));
    parsed = found && found.confident ? found : null;
    if (upcomingCache.size >= 4000) upcomingCache.delete(upcomingCache.keys().next().value as string);
    upcomingCache.set(key, parsed);
  }
  if (!parsed) return null;
  const endsAt = parsed.hasTime ? parsed.at : startOfDay(new Date(parsed.at)).getTime() + DAY_MS - 1;
  return endsAt > nowMs ? parsed : null;
}
