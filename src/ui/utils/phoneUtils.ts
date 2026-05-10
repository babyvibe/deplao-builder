/**
 * Format phone number for display.
 * - Vietnam (+84 / 84): convert leading 84 → 0, e.g. 84912345678 → 0912345678
 * - Other countries: return as-is (strip leading + if present for consistency)
 * - Returns empty string if no phone.
 */
export function formatPhone(phone: string | undefined | null): string {
  if (!phone) return '';
  const raw = phone.trim();
  // Remove "+" prefix for uniformity
  const digits = raw.startsWith('+') ? raw.slice(1) : raw;
  // Vietnam: country code 84, phone numbers are 9-10 digits after 84
  if (digits.startsWith('84') && digits.length >= 11) {
    return '0' + digits.slice(2);
  }
  return raw;
}

