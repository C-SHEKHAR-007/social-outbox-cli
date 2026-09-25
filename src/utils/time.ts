/** All persisted timestamps use this exact format so string comparison == time comparison. */
export function toIso(date: Date): string {
  return date.toISOString();
}

export function nowIso(): string {
  return toIso(new Date());
}
