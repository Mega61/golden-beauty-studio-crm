/**
 * Presentation for the Postulación triage status (colors + Spanish labels),
 * shared by the Postulaciones dashboard and the inline badge. Mirrors the
 * `status` enum in api/job-application/content-types/job-application/schema.json —
 * keep both in sync.
 */
export type ApplicationStatus =
  | 'nueva'
  | 'en_revision'
  | 'entrevista'
  | 'contratada'
  | 'descartada';

export interface StatusDisplay {
  label: string;
  bg: string;
  fg: string;
}

// Same palette family as winback-status.ts so the two dashboards read as one product.
export const APPLICATION_STATUS_DISPLAY: Record<string, StatusDisplay> = {
  nueva: { label: 'Nueva', bg: '#fdf4dc', fg: '#845c00' },
  en_revision: { label: 'En revisión', bg: '#eaf5ff', fg: '#2b5e9e' },
  entrevista: { label: 'Entrevista', bg: '#efe7ff', fg: '#6b40c4' },
  contratada: { label: 'Contratada', bg: '#d9fbe8', fg: '#2f6846' },
  descartada: { label: 'Descartada', bg: '#eaeaef', fg: '#666687' },
};

/** Statuses still awaiting a decision — the dashboard's default view. */
export const OPEN_STATUSES: ApplicationStatus[] = ['nueva', 'en_revision', 'entrevista'];

export function displayForApplication(status: string | null | undefined): StatusDisplay {
  return APPLICATION_STATUS_DISPLAY[status ?? ''] ?? APPLICATION_STATUS_DISPLAY.nueva;
}

export const EXPERIENCE_LABELS: Record<string, string> = {
  sin_experiencia: 'Sin experiencia',
  menos_de_1: 'Menos de 1 año',
  de_1_a_3: '1 – 3 años',
  de_3_a_5: '3 – 5 años',
  mas_de_5: 'Más de 5 años',
};

export const SURFACE_LABELS: Record<string, string> = {
  landing: 'Página web',
  bio: 'Link de Instagram',
};

/**
 * Cargo name for a row. Prefers the live Cargo entry (so a renamed vacancy shows
 * its new name) and falls back to the snapshot stored on the application, which
 * is all that survives if the vacancy was deleted.
 */
export function roleLabel(
  role: { label_es?: string } | null | undefined,
  snapshot: string | null | undefined,
): string {
  return role?.label_es || snapshot || '—';
}

export function experienceLabel(value: string | null | undefined): string {
  return EXPERIENCE_LABELS[value ?? ''] ?? '—';
}

export function surfaceLabel(value: string | null | undefined): string {
  return SURFACE_LABELS[value ?? ''] ?? '—';
}

/** "hace 3 días" — relative age of a submission, for the dashboard list. */
export function relativeAge(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const days = Math.floor((Date.now() - then) / 86_400_000);
  if (days <= 0) return 'hoy';
  if (days === 1) return 'ayer';
  if (days < 30) return `hace ${days} días`;
  const months = Math.floor(days / 30);
  return months === 1 ? 'hace 1 mes' : `hace ${months} meses`;
}
