/**
 * Shared win-back status presentation (colors + Spanish phrasing) for both the
 * Retoques dashboard and the inline Client badge. Mirrors the taxonomy in plan §4.1.
 */
export type WinbackStatus =
  | 'reciente'
  | 'en_ventana'
  | 'por_vencer'
  | 'vencido'
  | 'sin_cadencia';

export interface StatusDisplay {
  label: string;
  bg: string;
  fg: string;
}

export const STATUS_DISPLAY: Record<string, StatusDisplay> = {
  en_ventana: { label: 'En ventana', bg: '#d9fbe8', fg: '#2f6846' },
  por_vencer: { label: 'Por vencer', bg: '#fdf4dc', fg: '#845c00' },
  vencido: { label: 'Vencido', bg: '#fcecea', fg: '#b72b1a' },
  reciente: { label: 'Reciente', bg: '#eaf5ff', fg: '#2b5e9e' },
  sin_cadencia: { label: 'Sin cadencia', bg: '#eaeaef', fg: '#666687' },
};

/** The three statuses the owner acts on, in priority order (for the dashboard KPIs). */
export const ACTIONABLE: WinbackStatus[] = ['en_ventana', 'por_vencer', 'vencido'];

export function displayFor(status: string | null | undefined): StatusDisplay {
  return STATUS_DISPLAY[status ?? ''] ?? STATUS_DISPLAY.sin_cadencia;
}

/** Whole-day difference `dateIso - today` (today in America/Bogota). */
export function daysFromToday(dateIso: string | null | undefined): number | null {
  if (!dateIso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateIso);
  if (!m) return null;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const bogota = new Date(now.getTime() - 5 * 3_600_000);
  const today = Date.UTC(bogota.getUTCFullYear(), bogota.getUTCMonth(), bogota.getUTCDate());
  return Math.round((target - today) / 86_400_000);
}

/** Human phrase for a status given days-remaining-until-deadline (negative = overdue). */
export function statusPhrase(
  status: string | null | undefined,
  daysRemaining: number | null,
): string {
  switch (status) {
    case 'en_ventana':
      return daysRemaining != null
        ? `Quedan ${daysRemaining} días de ventana`
        : 'En ventana de retoque';
    case 'por_vencer':
      return daysRemaining != null
        ? `${daysRemaining} días para el retoque`
        : 'Por vencer';
    case 'vencido':
      return daysRemaining != null
        ? `Vencido hace ${Math.abs(daysRemaining)} días · cobrar montaje`
        : 'Vencido · cobrar montaje';
    case 'reciente':
      return 'Reciente · aún no toca retoque';
    default:
      return 'Sin cadencia (solo sencillos)';
  }
}
