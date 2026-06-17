/**
 * Pure win-back computation helpers. No Strapi imports — unit-testable and shared by
 * the Visit lifecycle, the recompute service, and the import script. See plan §3 + §4.1.
 */
import type { ServiceCategory } from './category';

export type VisitStatus = 'completed' | 'upcoming' | 'cancelled';
export type WinbackStatus =
  | 'reciente'
  | 'en_ventana'
  | 'por_vencer'
  | 'vencido'
  | 'sin_cadencia';

export interface Cadence {
  service_category: string;
  min_days: number;
  max_days: number;
  active: boolean;
}

/** Map AgendaPro's `Estado` to our internal status (plan §1.1). */
export function statusFromEstado(estado: string): VisitStatus {
  const e = (estado || '').trim().toLowerCase();
  if (e === 'cancelado') return 'cancelled';
  if (e === 'asiste') return 'completed';
  // Reservado / Confirmado / anything else not-yet-happened.
  return 'upcoming';
}

/** A category drives a countdown only when it has an active cadence row. */
export function isEligible(cadence: Cadence | undefined): boolean {
  return !!cadence && cadence.active && cadence.max_days > 0;
}

/** Parse a YYYY-MM-DD date string into a UTC-midnight Date. */
function parseISODate(iso: string): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Add `n` days to a YYYY-MM-DD string, returning YYYY-MM-DD (or null on bad input). */
export function addDays(iso: string, n: number): string | null {
  const d = parseISODate(iso);
  if (!d) return null;
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whole-day difference `to - from` (positive when `to` is later). */
export function daysBetween(fromIso: string, toIso: string): number | null {
  const a = parseISODate(fromIso);
  const b = parseISODate(toIso);
  if (!a || !b) return null;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000);
}

/**
 * A completed visit's recommended next-service deadline = service_date + max_days.
 * Returns null for non-completed visits or non-eligible categories.
 */
export function visitNextRecommended(
  status: VisitStatus,
  serviceDate: string,
  cadence: Cadence | undefined,
): string | null {
  if (status !== 'completed' || !isEligible(cadence)) return null;
  return addDays(serviceDate, cadence!.max_days);
}

/**
 * Derive a client's win-back status from the days elapsed since their latest
 * eligible completed visit. Thresholds come from the cadence (config-driven), so the
 * amber "por_vencer" band is simply the last 3 days of the window. See plan §4.1.
 */
export function clientWinback(
  lastEligibleDate: string | null,
  cadence: Cadence | undefined,
  todayIso: string,
): { winback_status: WinbackStatus; next_recommended_date: string | null } {
  if (!lastEligibleDate || !isEligible(cadence)) {
    return { winback_status: 'sin_cadencia', next_recommended_date: null };
  }
  const { min_days, max_days } = cadence!;
  const d = daysBetween(lastEligibleDate, todayIso);
  const next = addDays(lastEligibleDate, max_days);
  if (d === null) return { winback_status: 'sin_cadencia', next_recommended_date: null };

  let winback_status: WinbackStatus;
  const amberStart = max_days - 2; // last 3 days of the window (e.g. 19,20,21)
  if (d < min_days) winback_status = 'reciente';
  else if (d < amberStart) winback_status = 'en_ventana';
  else if (d <= max_days) winback_status = 'por_vencer';
  else winback_status = 'vencido';

  return { winback_status, next_recommended_date: next };
}

/** Days remaining until the deadline (negative = overdue). Computed on read, never stored. */
export function timeRemainingDays(
  nextRecommendedDate: string | null,
  todayIso: string,
): number | null {
  if (!nextRecommendedDate) return null;
  return daysBetween(todayIso, nextRecommendedDate);
}

/** Today's date in America/Bogota (UTC-5, no DST) as YYYY-MM-DD. */
export function bogotaToday(now: Date = new Date()): string {
  const bogota = new Date(now.getTime() - 5 * 3_600_000);
  return bogota.toISOString().slice(0, 10);
}
