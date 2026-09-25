/** Parses "20:00, 09:00,9:30" → ["09:00","09:30","20:00"]; "none" → []; invalid → null. */
export function parseSlots(input: string): string[] | null {
  const text = input.trim().toLowerCase();
  if (text === 'none') return [];
  const slots = new Set<string>();
  for (const part of text
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(part);
    if (!m) return null;
    const [h, min] = [Number(m[1]), Number(m[2])];
    if (h > 23 || min > 59) return null;
    slots.add(`${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
  }
  return slots.size ? [...slots].sort() : null;
}
