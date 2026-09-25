import { DateTime } from 'luxon';

export const CSV_DATE_FORMAT = 'yyyy-MM-dd HH:mm';

// Accepted when reading user input. dd/MM is the Indian/UK spreadsheet default.
const LOCAL_FORMATS = [
  'yyyy-MM-dd HH:mm',
  'yyyy-MM-dd HH:mm:ss',
  "yyyy-MM-dd'T'HH:mm",
  "yyyy-MM-dd'T'HH:mm:ss",
  'yyyy/MM/dd HH:mm',
  'dd/MM/yyyy HH:mm',
  'dd/MM/yyyy HH:mm:ss',
  'dd-MM-yyyy HH:mm',
];

/**
 * Parses a user-entered date-time. Strings with an explicit offset/Z are taken as-is;
 * everything else is interpreted in `timezone`. Returns null if unparseable.
 */
export function parseUserDateTime(input: string, timezone: string): Date | null {
  const text = input.trim();
  if (!text) return null;
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
    const dt = DateTime.fromISO(text, { setZone: true });
    return dt.isValid ? dt.toJSDate() : null;
  }
  for (const format of LOCAL_FORMATS) {
    const dt = DateTime.fromFormat(text, format, { zone: timezone });
    if (dt.isValid) return dt.toJSDate();
  }
  return null;
}

export function formatLocal(iso: string | null | undefined, timezone: string, format = CSV_DATE_FORMAT): string {
  if (!iso) return '';
  const dt = DateTime.fromISO(iso).setZone(timezone);
  return dt.isValid ? dt.toFormat(format) : '';
}
