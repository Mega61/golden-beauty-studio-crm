/**
 * The advent calendar's January "sellos dobles" (Stampee docs/ADVENT_PLAN.md): one extra stamp
 * per completed visit of semipermanente or above while the client holds the gift. Stampee keeps
 * the gift and its dates; the CRM knows the service, so it decides which visits qualify and asks
 * Stampee once per visit (`POST /advent/double-stamps`, idempotent on the visit).
 */
import type { ServiceCategory } from './category';

const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');
const norm = (s: string) => (s || '').normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase();

const ABOVE_SEMI: ServiceCategory[] = ['montaje', 'retoque', 'forrado', 'press_on'];
// Same keywords as category.ts for those categories (kept import-free so node --test runs it).
const ABOVE_SEMI_WORDS = ['retoque', 'press on', 'press-on', 'forrado', 'dipping', 'nivelacion', 'esculpid', 'polygel', 'acrilic', 'dual', 'builder gel', 'rubber'];

/** Semipermanente or above. Traditional and cleanup-only services don't qualify. */
export function qualifiesForDoubleStamp(serviceName: string, category?: ServiceCategory | null): boolean {
  const s = norm(serviceName);
  if (category && ABOVE_SEMI.includes(category)) return true;
  if (ABOVE_SEMI_WORDS.some((w) => s.includes(w))) return true;
  return s.includes('semipermanente') || /\bsemi\b/.test(s);
}

export interface DoubleStampVisit {
  ref: string;
  date: string;
  serviceName: string;
  category?: ServiceCategory | null;
}

/** The visits to send: qualifying service, inside the gift's dates (YYYY-MM-DD, inclusive). */
export function visitsForDoubleStamp(visits: DoubleStampVisit[], from: string | null, to: string | null): DoubleStampVisit[] {
  return visits.filter(
    (v) =>
      !!v.ref &&
      !!v.date &&
      (!from || v.date >= from) &&
      (!to || v.date <= to) &&
      qualifiesForDoubleStamp(v.serviceName, v.category),
  );
}
