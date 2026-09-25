/** CSV contract, docs/plan.md §9. Order here is the export column order. */
export const CSV_COLUMNS = [
  'id',
  'version',
  'filename',
  'duration_s',
  'spec_ok',
  'state',
  'publish_target',
  'caption',
  'hashtags',
  'title',
  'action',
  'scheduled_at',
  'is_ai_generated',
  'last_error',
] as const;
export type CsvColumn = (typeof CSV_COLUMNS)[number];

export const KEY_COLUMNS = ['id', 'version'] as const satisfies readonly CsvColumn[];
export const EDITABLE_COLUMNS = [
  'publish_target',
  'caption',
  'hashtags',
  'title',
  'action',
  'scheduled_at',
  'is_ai_generated',
] as const satisfies readonly CsvColumn[];
export const REQUIRED_COLUMNS: readonly CsvColumn[] = [...KEY_COLUMNS, ...EDITABLE_COLUMNS];

export type CsvRow = Partial<Record<CsvColumn, string>>;

export function formatBool(value: boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value ? 'yes' : 'no';
}

export function parseBool(value: string | undefined): boolean | null {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || ['no', 'n', 'false', '0'].includes(v)) return false;
  if (['yes', 'y', 'true', '1'].includes(v)) return true;
  return null;
}
