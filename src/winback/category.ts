/**
 * Centralized, deterministic service-name → category mapper.
 * This is the ONLY place service strings are classified. Edit the keyword lists
 * here when the AgendaPro catalog changes — every consumer (import, intake, recompute)
 * goes through `mapCategory`.
 *
 * Order matters: the first matching rule wins. See plan §1.4.
 */
export type ServiceCategory =
  | 'montaje'
  | 'retoque'
  | 'forrado'
  | 'sencillo'
  | 'press_on'
  | 'otro';

// Combining diacritical marks block (U+0300–U+036F), built without embedding
// literal combining chars in source (keeps the file ASCII-safe).
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

function normalize(s: string): string {
  return (s || '')
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '') // strip combining accents
    .toLowerCase()
    .trim();
}

/**
 * Ordered rules. Each entry: a category + the substrings that select it.
 * `retoque` first (future-proof), then `press_on` (its own bucket, currently
 * inactive), then `forrado`, then the `montaje` set, then `sencillo`. Anything
 * unmatched falls through to `otro`.
 */
const RULES: Array<{ category: ServiceCategory; keywords: string[] }> = [
  { category: 'retoque', keywords: ['retoque'] },
  { category: 'press_on', keywords: ['press on', 'press-on'] },
  { category: 'forrado', keywords: ['forrado', 'dipping', 'nivelacion'] },
  {
    category: 'montaje',
    keywords: ['esculpid', 'polygel', 'acrilic', 'dual', 'builder gel'],
  },
  {
    category: 'sencillo',
    keywords: ['semipermanente', 'semi ', 'tradicional', 'limpieza', 'mani', 'pedi'],
  },
];

export function mapCategory(serviceName: string): ServiceCategory {
  const s = normalize(serviceName);
  if (!s) return 'otro';
  for (const rule of RULES) {
    if (rule.keywords.some((k) => s.includes(k))) {
      return rule.category;
    }
  }
  return 'otro';
}
