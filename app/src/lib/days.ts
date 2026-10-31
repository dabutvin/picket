/** Grouping photos by the day they were shot (capturedAt is camera local time, no zone). */

export const dayKey = (iso: string): string => iso.slice(0, 10);

export function dayLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? dayKey(iso) : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

export interface DayGroup<T> {
  key: string;
  label: string;
  items: T[];
}

/** Consecutive runs of the same capture day, in the order given (the API lists oldest first). */
export function groupByDay<T extends { capturedAt: string }>(items: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const key = dayKey(item.capturedAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(item.capturedAt), items: [item] });
  }
  return groups;
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
