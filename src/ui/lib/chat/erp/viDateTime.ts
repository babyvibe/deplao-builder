/**
 * Reads the date and time in a Vietnamese message: the "Tạo lịch hẹn" (Create appointment) button right under a message with an upcoming date and time (ChatWindow), and "Thêm vào lịch" (Add to calendar) from a message (lib/chat/erp/messageToErp). The reference point is when the message was sent: "mai 9h" (tomorrow 9h) in yesterday's message is 9:00 today.
 *
 * What it reads (based on the Vietnamese rules of Duckling: facebook/duckling, Duckling/Time/VI/Rules.hs):
 *  - dates: "hôm nay" / "bữa nay" (today), "mai" / "ngày mai" (tomorrow), "mốt" / "ngày kia" (day after tomorrow), "hôm qua" / "hôm kia" (yesterday / day before yesterday), "thứ 2" … "chủ nhật" (Monday … Sunday; "t2", "cn"), "tuần sau" / "tuần tới" (next week, with or without a weekday), "thứ 6 tuần trước" / "vừa rồi" (last week), "đầu tuần sau" (start of next week), "cuối tuần" (weekend), "cuối tháng" (end of month), dd/mm[/yyyy], dd-mm-yyyy, yyyy-mm-dd, "ngày 5 [tháng 12]" (day 5 [of December]), "mồng / mùng 5" (the 5th), "ngày 5 tháng sau" (the 5th of next month);
 *  - times: "9h", "9h30", "9h30p" / "9h30ph", "9:30", "9g30", "9 giờ", "9 giờ 30 phút", "9 giờ rưỡi" (9:30), "9h kém 15" (8:45), "9-11h", "lúc 9" (at 9), "8pm", "7:30am", together with "buổi sáng / trưa / chiều / tối / đêm" (morning / noon / afternoon / evening / night) before or after the hour, or only the part of day ("chiều mai" (tomorrow afternoon) = 14:00);
 *  - durations counted from the sending time: "20 phút nữa" (in 20 minutes), "2 tiếng nữa" (in 2 hours), "1 tiếng rưỡi nữa" (in 1.5 hours), "nửa tiếng nữa" (in half an hour), "sau 30 phút" (after 30 minutes), "10 phút sau" (10 minutes later), "3 ngày nữa" (in 3 days), "1 tuần nữa" (in 1 week) (numbers written in words also work: "mười lăm phút nữa").
 * Messages typed without diacritics are read too ("toi mai 8h"). A message WITH diacritics only accepts the exact diacritic forms: "tối" is evening but "tôi" is not, "sáng" differs from "sang", "mốt" differs from "một". Hours 1-5 with no part of day are read as afternoon ("hẹn 3h" = 15:00); hours 6-9 with no part of day, when that morning hour has already passed on the sending day, are tonight if still within 8 hours ("hẹn 8h nhé" sent at 19:02 = 20:00).
 *
 * Avoids matching unrelated words:
 *  - "mai" / "mốt" standing alone (with no "ngày" or "sáng"… next to them) are judged by the context words (bareDayWordIsDate): people's names ("Mai Dũng", "chị Mai", "Mai ơi", "Mai vs Sơn", "gửi cho Mai", "Mai đã gửi"), compound words ("hoa mai", "mai mối", "mai mốt", "đúng mốt", "mốt mới") are dropped; it is a date only when it sits right next to a time ("mai 9h"), after a time word ("để mai", "đến mai"), or is followed by a subject / action / filler word ("Mai em gửi", "mai giao hàng", "Mai nhé");
 *  - "trong 2h" (within 2h), "mất 2 giờ đồng hồ" (takes 2 hours), "8h/ngày" (8h per day) (durations), "2HP" (horsepower), "lần thứ hai" (second time), "thứ nhất…, thứ hai…" (ordinals), "ngày 3 lần" (3 times a day) (count), "9-11h" (not day 9 or 11), "24/7", "còn 2/10 suất" (2/10 slots left), "số 12/3" (house no. 12/3) (address);
 *  - no diacritics: "toi qua", "dem qua", "sang qua" mean "tôi qua", "đem qua", "sang qua" (not "tối qua" (last night)…).
 * Lowers the certainty only (no button under the message, but "Thêm vào lịch" (Add to calendar) still pre-fills): repeating schedules ("hằng ngày", "giờ mở cửa" (opening hours), "thứ 2 - thứ 7"), a time with no date that has passed at sending time and no appointment word ("lúc 9h em có gọi" (I'll call at 9h)), a part of day only, "cn", "t2", "1/2".
 */

export interface ViDateTime {
  /** Start time (ms, local time). Date only → 09:00 that day. */
  at: number;
  hasDate: boolean;
  hasTime: boolean;
  /**
   * Certain reads: a time, a clear date ("ngày mai" (tomorrow), "thứ 6" (Friday), "20/11") or "20 phút nữa" (in 20 minutes). Uncertain: only a part of day ("màu tối" (dark color)), "cn", "t2", "thứ hai là…" (Monday is…), "1/2" (also a fraction), repeating schedules, a time that has already passed with no appointment word. The "Tạo lịch hẹn" (Create appointment) button under the message only shows when certain.
   */
  confident: boolean;
  /** The parts that were read (positions in the NFC-normalized string), to remove from the title. */
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
/** Only a part of day, no time. */
const PERIOD_DEFAULT_HOUR: Record<Period, number> = { morning: 8, noon: 12, afternoon: 14, evening: 19, night: 21 };
/** Typed without diacritics: "toi" is also "tôi", "sang" is "sang (nhà)" (to the house), "dem" is "đem" → only a part of day when next to a time ("8h toi"). */
const AMBIGUOUS_PLAIN_PERIODS = new Set(['toi', 'sang', 'dem']);

/** Weekday → getDay() (0 = Sunday). */
const WEEKDAY_OF: Record<string, number> = {
  '2': 1, '3': 2, '4': 3, '5': 4, '6': 5, '7': 6,
  hai: 1, ba: 2, 'tư': 3, tu: 3, 'năm': 4, nam: 4, 'sáu': 5, sau: 5, 'bảy': 6, bay: 6,
};

/** Number words in "N phút nữa" (drops "sau" / "tam" when typed without diacritics: they collide with "sau" (after) / "tầm" (around)). */
const NUMBER_WORDS: Record<string, number> = {
  'một': 1, mot: 1, hai: 2, ba: 3, 'bốn': 4, bon: 4, 'năm': 5, nam: 5, 'sáu': 6, 'bảy': 7, bay: 7, 'tám': 8,
  'chín': 9, chin: 9, 'mười': 10, muoi: 10, 'mười lăm': 15, 'muoi lam': 15, 'hai mươi': 20, 'hai muoi': 20,
  'ba mươi': 30, 'ba muoi': 30, 'bốn mươi lăm': 45, 'bon muoi lam': 45, 'nửa': 0.5, nua: 0.5,
};

/** "lần thứ hai" (second time), "người thứ 3" (3rd person), "bên thứ ba" (3rd side): ordinals, not the weekday. */
const ORDINAL_NOUNS = {
  accented: 'lần|điều|bước|phần|ý|cái|người|loại|câu|hạng|vị|con|đứa|đứng|xếp|top|tầng|lầu|số|đợt|kỳ|kì|khóa|khoá|chương|bài|trang|dòng|mục|vòng|hiệp|ván|lớp|năm|tuần|tập|phiên|giải|bản|mẫu|bên|size|cỡ',
  plain: 'lan|dieu|buoc|phan|y|cai|nguoi|loai|cau|dua|xep|top|lau|so|dot|ky|ki|khoa|chuong|bai|trang|muc|vong|hiep|lop|nam|tuan|phien|ben|size',
};
/** "ngày 3 lần" (3 times a day), "mỗi ngày 2 viên" (2 tablets each day): counts per day, not day 3. */
const COUNT_WORDS = {
  accented: 'lần|viên|bữa|cữ|gói|ly|cốc|chai|hộp|cái|người|tiếng|giờ|phút|đơn|ca|km|kg|lít|triệu|tr|k|nghìn|ngàn|trăm|lượt|bài|trang|cuộc|chuyến|suất|tiết|h|%',
  plain: 'lan|vien|bua|goi|coc|chai|nguoi|tieng|gio|phut|km|kg|lit|trieu|tr|k|nghin|ngan|tram|luot|suat|tiet|h|%',
};

/**
 * Word context of "mai" / "mốt" standing alone: [with diacritics, without diacritics]. Typed by hand without diacritics, stripping the marks makes them clash with other
 * meanings ("ghe" = "ghé", "chieu" = "chiều", "danh" = "đánh", "da" = "đã" / "đá", "cho" = "cho" / "chờ"…).
 */
const DAY_WORD_LEXICON = {
  /** "hoa mai" (apricot blossom), "cây mai" (apricot tree), "đào mai" */
  maiCompoundBefore: ['hoa|cây|cành|chậu|gốc|bông|nhành|cội|vườn|đào', 'hoa|cay|chau|goc|bong|coi|vuon|dao'],
  /** "mai mối" (matchmaking), "mai táng" (burial), "mai một" (fade away), "mai sau" / "mai kia" / "mai mốt" / "mai này" (someday), "mai vàng", "mai cua"… */
  maiCompoundAfter: ['mối|táng|một|rùa|mỉa|phục|danh|sau|kia|mốt|này|vàng|trắng|tứ|đào|cua|mực|ghẹ|chiếu', 'mot|mia|phuc|sau|kia|nay|vang|dao|cua|muc'],
  /** "đúng mốt" (in fashion), "hợp mốt" (on trend), "đang là mốt" (in vogue) */
  motCompoundBefore: ['đúng|hợp|theo|lỗi|sành|chạy|mẫu|kiểu|thời|mai|là|làm|đang', ''],
  /** "mốt mới" (new trend), "mốt này" (this trend), "mốt năm nay" (this year's trend) */
  motCompoundAfter: ['mới|này|nhất|thời|trang|kia|năm|nay', ''],
  /** "Mai ơi" (hey Mai) */
  vocativeAfter: ['ơi', 'oi'],
  /** "Mai và Lan", "Mai vs Sơn" ("Mai" capitalized) */
  coordinationAfter: ['và|với|vs|cùng|hay|hoặc|&', 'va|voi|vs|cung|hay|hoac|&'],
  /** "gửi cho Mai", "của Mai", "rủ Mai": a person, not a date */
  personBefore: ['cho|của|với|và|cùng|mời|rủ|tặng|giúp|nhờ|thấy|như|là|bảo|nói|hỏi', 'cua|voi|va|cung|ru|tang|giup|thay|nhu|la|bao|noi|hoi'],
  /** "đến mai", "để mai", "hẹn mai", "dời sang mai", "sớm mai": after a time word, so it is a date */
  temporalBefore: ['đến|tới|từ|để|hẹn|đợi|chờ|tầm|khoảng|trước|sang|tận|dời|lùi|hoãn|sớm|nội|qua|ngay', 'den|toi|tu|de|hen|doi|tam|khoang|truoc|sang|tan|lui|hoan|som|qua|ngay'],
  /** "Mai em gửi", "mai shop nghỉ": the subject of tomorrow's action */
  pronounsAfter: [
    'em|anh|chị|mình|tôi|tớ|tao|mày|bọn|tụi|tui|chúng|cả|mọi|shop|bên|team|nhà|công|cty|cửa|kho|xe|thợ|a|e|c|mk|mik|mn|t|ck|vk|bé|con|mẹ|bố|ông|bà|cô|chú|bác|cháu|sếp|khách|ad|admin|bạn|ae|nhóm|lớp|phòng|ta',
    'em|anh|chi|minh|toi|to|tao|may|bon|tui|chung|ca|moi|shop|ben|team|nha|cong|cty|kho|xe|a|e|c|mk|mik|mn|t|ck|vk|be|con|me|bo|ong|co|chu|bac|chau|sep|khach|ad|admin|ban|ae|nhom|lop|phong|ta',
  ],
  /** "Mai gửi", "mai giao hàng": tomorrow's action */
  verbsAfter: [
    'gửi|giao|ship|qua|đến|tới|đi|về|họp|gặp|làm|nghỉ|có|nhận|lấy|trả|chuyển|gọi|nhắn|ghé|đón|check|xem|báo|test|học|thi|khai|mở|đóng|bán|nhập|lên|xuống|sang|ra|vào|bắt|chạy|chốt|ký|kí|nộp|thanh|tính|bàn|hẹn|đặt|book|order|live|đăng|post|quay|chụp|in|sửa|lắp|kiểm|duyệt|phỏng|ăn|uống|đá|tập|chơi|nhậu|khám|bay|trực|đổi|hoàn|bù|dạy|đưa|mang|đem|trình|demo|deploy|call|meet|review|update|cập|setup|cài|gom|xuất|thử|mua|tiếp|dọn|hết|còn|phải|nên|thu|xếp|giải|đối|khởi|thăm|vô|đánh|chở|rước|nấu|tổ|tiễn|cưới|tăng|rửa|chuẩn|giữ|đợi|chờ|ở|nhớ|rảnh|bận|trống|kẹt|vướng|tiện',
    'gui|giao|ship|qua|den|toi|di|ve|hop|gap|lam|nghi|co|nhan|lay|tra|chuyen|goi|ghe|don|check|xem|bao|test|hoc|thi|khai|mo|dong|ban|nhap|len|xuong|sang|ra|vao|bat|chay|chot|ky|ki|nop|thanh|tinh|hen|dat|book|order|live|post|quay|chup|in|sua|lap|kiem|duyet|phong|an|uong|tap|choi|nhau|kham|bay|truc|doi|hoan|bu|day|dua|mang|dem|trinh|demo|deploy|call|meet|review|update|cap|setup|cai|gom|xuat|thu|mua|tiep|het|con|phai|nen|xep|giai|khoi|tham|vo|danh|cho|ruoc|nau|to|tien|cuoi|tang|rua|chuan|giu|o|nho|ranh|ket|vuong',
  ],
  /** "Mai nhé" (OK?), "mai được không" (can it be tomorrow?), "mai mấy giờ" (what time tomorrow?) */
  particlesAfter: [
    'nhé|nha|nhá|nhe|nghen|hen|ha|hả|nhỉ|được|đc|dc|ok|oke|okay|thì|sẽ|cũng|luôn|rồi|mới|lại|không|ko|k|kg|mấy|lúc|vào|khoảng|tầm|nữa|thôi|ạ|á|à|chắc|nhen',
    'nhe|nha|nghen|hen|ha|nhi|duoc|dc|ok|oke|okay|thi|se|cung|luon|roi|moi|lai|khong|ko|k|kg|may|luc|vao|khoang|tam|nua|thoi|a|chac|nhen',
  ],
  /** "Mai đã gửi", "Mai vừa gọi", "Mai đang làm": something that already happened / is happening → a person's name */
  pastAfter: ['đã|vừa|đang|từng', 'vua|tung'],
  /** "Mai là ai", "Mai là người…" (who is Mai / Mai is someone who…): a name ("Mai là sinh nhật anh" (tomorrow is your birthday) and "Mai là thứ 3" (tomorrow is Tuesday) are dates) */
  personAfterIs: [
    'ai|người|bạn|em|chị|anh|con|cô|chú|bác|nhân|quản|sếp|vợ|chồng|mẹ|bố|ba|má|cháu|đứa|thằng|học|giáo|chủ|khách|một|cái',
    'ai|nguoi|ban|em|chi|anh|con|co|chu|bac|nhan|quan|sep|vo|chong|me|bo|ba|ma|chau|dua|thang|hoc|giao|khach|mot|cai',
  ],
} as const;

type DayWordLexicon = { [K in keyof typeof DAY_WORD_LEXICON]: Set<string> };

const foldCache = new Map<string, string>();
/** Removes diacritics, keeps the length (each UTF-16 unit) so the positions match the original string. */
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
/** Word boundary (a letter with a diacritic counts as a letter). */
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

/** The rule set for the messages with / without diacritics (built once). */
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
  // "sau 2h" / "2h sau" could be "sau 2 giờ chiều" (after 2 pm): only accept units that are not mixed up with times
  const safeUnit = pick('(tiếng|phút|p|ngày|tuần)', '(tieng|phut|p|ngay|tuan)');
  const notRelative = pick('(?!\\s+(?:khi|đó|kể|lúc))', '(?!\\s+(?:khi|do|ke|luc))');
  const periodWords = pick('sáng|trưa|chiều|tối|đêm', 'sang|trua|chieu|toi|dem');
  // "thứ 2 tuần sau" is not "2 tuần sau" (2 weeks later)
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
    // "thứ 6 vừa rồi", "thứ 6 tuần trước": a day already passed ("thứ 6 trước 9h" (Friday before 9h) is a deadline, not counted)
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
    // Without diacritics: "toi qua", "dem qua", "sang qua" usually mean "tôi qua", "đem qua", "sang qua" → only accept "chiều / trưa qua"
    // and "tối hôm qua" (last night)
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
    // dd/mm is not a date: a score / ratio ("được 9/10", "tỉ lệ 1/2"), an address ("số 12/3", "hẻm 5/7", "đường 3/2")…
    slashBefore: new RegExp(`(?:^|[^${L}])(?:${pick(
      'tỉ\\s+lệ|tỷ\\s+lệ|được|đạt|chấm|còn|số|hẻm|ngõ|ngách|kiệt|nhà|đường|lô|căn|địa\\s+chỉ|đ/c',
      'ti\\s+le|ty\\s+le|duoc|cham|con|so|hem|ngo|ngach|kiet|nha|duong|lo|can|dia\\s+chi|d/c',
    )})\\s*:?\\s*$`, 'u'),
    // … or a count / unit ("10/10 điểm" (10/10 points), "còn 2/10 suất" (2/10 slots left), "20/11h")
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
    // "Mai đi học chưa?", "Mai gửi rồi ạ": something that already happened
    pastClauseEnd: new RegExp(`(?<![${L}])${pick(
      '(?:rồi|chưa)(?:\\s+(?:ạ|à|nhỉ|ha|hả|vậy|thế|hở|á|đó|đấy))?',
      '(?:roi|chua)(?:\\s+(?:a|nhi|ha|vay|the|ho|do|day))?',
    )}\\s*$`, 'u'),
    // An appointment word: a time that has already passed when the message was sent only counts as an appointment for tomorrow if such a word is present ("9h họp nhé" (9h meeting, OK?) sent at 10h)
    future: word(pick(
      'nhé|nha|nhá|nhe|nghen|hen|nhen|sẽ|hẹn|nhớ|kịp|chuẩn\\s+bị|được\\s+không|đc\\s+không|ok\\s+không',
      'nhe|nha|nghen|hen|nhen|se|kip|chuan\\s+bi|duoc\\s+khong|dc\\s+khong|ok\\s+khong',
    )),
    // Repeating schedule / opening hours: not an appointment
    recurring: word(pick(
      'hằng\\s+ngày|hàng\\s+ngày|mỗi\\s+ngày|mỗi\\s+sáng|mỗi\\s+trưa|mỗi\\s+chiều|mỗi\\s+tối|mỗi\\s+tuần|hằng\\s+tuần|hàng\\s+tuần|các\\s+ngày|cả\\s+tuần|mở\\s+cửa|đóng\\s+cửa|giờ\\s+làm\\s+việc|giờ\\s+hành\\s+chính|thứ\\s*[2-7]\\s*(?:-|đến|tới)\\s*(?:thứ\\s*[2-7]|chủ\\s*nhật|cn)|t[2-7]\\s*-\\s*(?:t[2-7]|cn)|24/7',
      'hang\\s+ngay|moi\\s+ngay|moi\\s+sang|moi\\s+trua|moi\\s+chieu|moi\\s+toi|moi\\s+tuan|hang\\s+tuan|cac\\s+ngay|ca\\s+tuan|mo\\s+cua|dong\\s+cua|gio\\s+lam\\s+viec|gio\\s+hanh\\s+chinh|thu\\s*[2-7]\\s*(?:-|den|toi)\\s*(?:thu\\s*[2-7]|chu\\s*nhat|cn)|t[2-7]\\s*-\\s*(?:t[2-7]|cn)|24/7',
    )),
  };
  if (accented) rulesCache.accented = rules; else rulesCache.plain = rules;
  return rules;
}

// Read on the no-diacritics version (times / dates as numbers)
const ISO_RE = /(?<![\d/.,:-])(\d{4})-(\d{1,2})-(\d{1,2})(?![\d/.,:-])/g;
/** dd/mm[/yy(yy)] or dd-mm-yyyy ("9-11h" is a time range). */
const SLASH_RE = /(?<![\d/.,:-])(\d{1,2})(?:\/(\d{1,2})(?:\/(\d{4}|\d{2}))?|-(\d{1,2})-(\d{4}|\d{2}))(?![\d/.,:-])/g;
/** [hour, minute, is already 24-hour (am / pm: do not infer the part of day)] */
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
  // 9-11h, "9 đến 11h": start hour ("8-10h/ngày" (8-10h per day) is a duration range)
  { re: /(?<![\d:/.,-])(\d{1,2})\s*(?:h|gio)?\s*(?:-|den|toi)\s*\d{1,2}\s*(?:h|gio)(?![a-z0-9]|\s*\/)/g, read: m => [Number(m[1]), 0] },
  // "9h kém 15" (quarter to 9) → 8:45
  { re: /(?<![\d:/.,-])(\d{1,2})\s*(?:h|gio)\s*kem\s*(\d{1,2})\s*(?:phut|p)?(?![a-z0-9])/g, read: m => [Number(m[1]) - 1, 60 - Number(m[2])] },
  // "9 giờ rưỡi" / "9h rưỡi" (half past nine)
  { re: /(?<![\d:/.,-])(\d{1,2})\s*(?:h|gio)\s*ruoi(?![a-z0-9])/g, read: m => [Number(m[1]), 30] },
  // "9h", "9h30", "9h30p", "9h30ph", "9 giờ 30 phút", "9h 30", "9h đúng" (exactly 9h) ("2HP" is horsepower, "8h/ngày" is a duration, "9h 2 người"
  // is 9:00)
  {
    re: /(?<![\d:/.,-])(\d{1,2})\s*(?:h|gio)(?:\s*(\d{1,2})\s*(?:phut|ph|p)(?![a-z])|(\d{1,2})|\s+(\d{2})(?!\d))?(?:\s+dung)?(?![a-z0-9]|\s*\/)/g,
    read: m => [Number(m[1]), Number(m[2] || m[3] || m[4] || 0)],
  },
  // 9:30
  { re: /(?<![\d:/.,-])(\d{1,2}):(\d{2})(?![\d:])/g, read: m => [Number(m[1]), Number(m[2])] },
  // 9g30
  { re: /(?<![\d:/.,-])(\d{1,2})g(\d{2})(?![a-z0-9])/g, read: m => [Number(m[1]), Number(m[2])] },
  // "lúc 9" (at 9), without an "h" or "giờ" (hour word)
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
 * Day / month without the year: this year; if it was more than half a year ago, next year ("5/1" said in December). Recently passed ("20/10" said on
 * 26/10) is still a past day. "ngày 5" (day 5): this month; if it has passed, next month.
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
  if ((period === 'evening' || period === 'night') && hour === 12) return 24; // "12h đêm" (12h at night) = 0:00 the next day
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

// ── Word context ──────────────────────────────────────────────────────────────────────────────────────────────────────

interface Token { text: string; lower: string; start: number; end: number; isWord: boolean }
const TOKEN_RE = /[\p{L}\p{N}&]+|[^\s\p{L}\p{N}&]+/gu;

/** Words / punctuation around the span [start, end) (short window: only a few words on each side). */
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
 * "mai" (tomorrow) / "mốt" (day after tomorrow) standing alone: whether it is a date depends on the words around it. A person's name ("Mai Dũng vs Đặng Sơn", "chị Mai", "Mai ơi", "gửi cho Mai", "Mai đã gửi"),
 * compound words ("hoa mai", "mai mối", "mai mốt" = someday, "đúng mốt", "mốt mới") are not. It is a date when next to a time / part of day ("Mai 9h", "9h mai"), after a time word ("để mai", "đến mai"),
 * or at the start of a sentence / lowercase and followed by a subject, action or filler word ("Mai em gửi", "mai giao hàng", "Mai nhé", "Dạ mai ạ"). A capitalized "Mai" in the middle of a sentence is always a name.
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

  // Compound / fashion words: "hoa mai", "mai mối", "mai mốt", "đúng mốt", "mốt mới"
  if (isMai ? has(lex.maiCompoundBefore, prev) || has(lex.maiCompoundAfter, next)
    : has(lex.motCompoundBefore, prev) || has(lex.motCompoundAfter, next)) return false;
  // Calling a name: "Mai ơi", "Mai à, …"
  if (has(lex.vocativeAfter, next)) return false;
  if (next && next.lower === (accented ? 'à' : 'a') && /^\s*,/.test(original.slice(next.end))) return false;
  // Names: the next word is capitalized ("Mai Dũng", "Mai Anh"; "Mai Em gửi" with a respectful capital is still a date), "Mai và Lan"
  if (next && upper(next.text) && !(lex.pronounsAfter.has(next.lower) && next.lower !== 'anh')) return false;
  if (capital && has(lex.coordinationAfter, next)) return false;
  // "chị Mai", "Nguyễn Thị Mai", "gặp Mai 9h": capitalized mid-sentence is a name
  if (capital && !sentenceStart) return false;
  // Next to a time / part of day: "Mai 9h", "9h mai", "mai sáng"
  const gap = (hit: Hit | null) => (!hit ? Infinity : start >= hit.end ? start - hit.end : hit.start - end);
  const nearest = Math.min(gap(timeHit), gap(periodHit));
  if (nearest <= 2) return true;
  // Action done / in progress: "Mai đã gửi", "Mai đi học chưa?"
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
  if (lower.length !== original.length) return null; // no position match (special characters when lowercased) → skip
  const folded = foldKeepLength(lower);
  // Message with diacritics: read the words on the diacritic version (telling "tối" and "tôi" apart…); message without diacritics: read on the stripped version
  const accented = folded !== lower;
  const text = accented ? lower : folded;
  const rules = rulesFor(accented);
  // All-caps message: capital letters say nothing (person names, street names)
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

  // ── Durations counted from the sending time: "20 phút nữa", "sau 2 tiếng", "3 ngày nữa" ──────────────────────────────
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

  // ── Dates ───────────────────────────────────────────────────────────────────
  if (!day) {
    const m = firstMatch(rules.endOfWeek, text, used); // weekend = "thứ 7" (Saturday)
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
  // Explicit date (wins over the "thứ" (weekday) word next to it: "thứ 2, 2/11")
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
      // "24/7", "được 9/10", "số 12/3", "còn 2/10 suất": not dates
      if (!yearText && m[1] === '24' && monthText === '7') continue;
      if (rules.slashBefore.test(text.slice(Math.max(0, start - 14), start)) || rules.slashAfter.test(text.slice(end))) continue;
      // "12/3 Nguyễn Trãi": house number + a capitalized street name
      if (!allCaps && /^\s+\p{Lu}\p{L}*\s+\p{Lu}/u.test(original.slice(end, end + 40))) continue;
      const resolved = resolveDayMonth(today, Number(m[1]), Number(monthText), yearText);
      if (!resolved) continue;
      day = resolved;
      weakDay = !yearText && m[1].length === 1 && monthText.length === 1; // "1/2" is also a fraction
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

  // "tuần sau" / "tuần tới" (next week; read before "tới" becomes evening when typed without diacritics), "tuần trước" (last week)
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
        const offset = (target + 6) % 7; // "thứ 2" (Monday) = 0 … "chủ nhật" (Sunday) = 6
        if (nextWeek) day = addDays(thisMonday, 7 + offset);
        else if (prevWeek) day = addDays(thisMonday, offset - 7);
        else if (pastAfter) day = addDays(today, -(((today.getDay() - target + 7) % 7) || 7));
        else day = addDays(today, (target - today.getDay() + 7) % 7);
        weekdayToday = !nextWeek && !prevWeek && !pastAfter && day.getTime() === today.getTime();
        // "thứ 2" is certain; "thứ hai là…", "cn", "t2" are not yet (need a time / part of day as well)
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

  // ── Time ────────────────────────────────────────────────────────────────────
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
      // "trong 2h", "mất 2h", "2 giờ đồng hồ": durations, not appointment times
      if (rules.durationCue.test(text.slice(Math.max(0, start - 16), start)) || /^\s*dong\s*ho(?![a-z])/.test(folded.slice(end))) continue;
      hour = h;
      minute = min;
      hourIs24 = !!is24;
      timeHit = { start, end };
      take(start, end);
      break search;
    }
  }

  // Part of day ("sáng" / "chiều" / "tối"…) nearest to the hour, if not already read together with "nay / mai" (today / tomorrow)
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

  // "mai" (tomorrow) / "mốt" (day after tomorrow) standing alone: judged by the context words (bareDayWordIsDate)
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

  // "tuần sau" with no weekday / date → Monday of next week ("thứ 2" (Monday), date only)
  if (!day && nextWeek) day = nextMonday();

  const hasTime = hour !== null || period !== null;
  if (!day && !hasTime) return null;

  let h = hour !== null ? (hourIs24 ? hour : adjustHour(hour, period)) : period ? PERIOD_DEFAULT_HOUR[period] : 9;
  const min = hour !== null ? minute : 0;
  const timeOn = (d: Date, hh: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), hh, min).getTime();
  // "hẹn a 8h nhé" sent at 19:02 is 20:00 that evening, not 8:00 tomorrow morning: hours 6-9 with no part of day, on the sending day, when the morning hour has passed,
  // the evening hour is still within 8 hours → evening ("9h30 họp" sent at 10:24 is still 9:30 tomorrow morning)
  const base = day || today;
  if (hour !== null && !hourIs24 && !period && hour >= 6 && hour <= 9 && !weekdayToday && base.getTime() === today.getTime()
    && timeOn(base, h) <= now.getTime() && timeOn(base, h + 12) > now.getTime()
    && timeOn(base, h + 12) - now.getTime() <= 8 * 3_600_000) h += 12;
  const atOn = (d: Date) => timeOn(d, h);
  let at = atOn(day || today);
  // Only an hour, and that hour today has already passed → tomorrow
  const rolled = !day && at <= now.getTime();
  if (rolled) at = atOn(addDays(today, 1));
  // "thứ X" is today: no time, or the time has passed → "thứ X" of next week (saying "thứ 2" on a Monday usually means next week)
  if (weekdayToday && (!hasTime || at <= now.getTime())) at = atOn(addDays(today, 7));

  let confident = hour !== null || (!!day && (!weakDay || period !== null));
  // Time already passed at sending time, with no date ("lúc 9h em có gọi" sent at 10h): only tomorrow's appointment when an appointment word is there ("9h họp nhé")
  if (rolled && !hasMatch(rules.future, text)) confident = false;
  // Repeating schedule, opening hours ("hằng ngày" (daily), "thứ 2 - thứ 7" (Mon-Sat)): not an appointment
  if (confident && hasMatch(rules.recurring, text)) confident = false;
  return { at, hasDate: !!day, hasTime, confident, spans: spansOf() };
}

/** Connecting word before a date / time ("lúc 5h" (at 5h), "tầm 9h" (around 9h), "ngày 5/11"): removed along with the date / time. */
const LEAD_CONNECTORS = [
  'vào lúc', 'vào khoảng', 'lúc', 'vào', 'khoảng', 'tầm', 'gần', 'đúng', 'từ', 'hôm', 'ngày', 'buổi',
  'luc', 'vao', 'khoang', 'tam',
];
/** Leftover connecting word at the start / end of the title. "đến", "tới", "sau" at the end are kept: "anh tới" (you come), "khách đến" (the guest arrives). */
const CONNECTORS = [...LEAD_CONNECTORS, 'đến', 'tới', 'sau', 'còn'];
const TRAILING_KEEP = new Set(['đến', 'tới', 'sau']);
const LEAD_BEFORE_SPAN = new RegExp(`(?:^|\\s)(?:${LEAD_CONNECTORS.map(c => c.replace(/ /g, '\\s+')).join('|')})\\s*$`, 'iu');
const PARTICLES = [
  'nhé cả nhà', 'nha cả nhà', 'nhé mọi người', 'nha mọi người', 'mọi người nhé', 'cả nhà nhé', 'nhé anh em', 'anh em nhé',
  'nhé anh', 'nhé chị', 'nhé em', 'anh nhé', 'chị nhé', 'em nhé', 'nhé', 'nha', 'nhe', 'nhá', 'nhỉ', 'ạ', 'à', 'nhen', 'nghen',
];

/** Calendar title from the message: remove the date / time that was read, connecting words left over ("lúc", "vào"…), filler words at the end of a sentence ("nhé cả nhà"…). */
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
 * A message with a date / time read with certainty that has NOT come yet (counted from when the message was sent) → the "Tạo lịch hẹn" (Create appointment) button under the message. The read result is remembered per message
 * (the message list redraws many times); if only a date, it still counts as upcoming for the rest of that day.
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
