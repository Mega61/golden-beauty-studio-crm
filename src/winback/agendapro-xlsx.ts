/**
 * AgendaPro reservations export (.xlsx) parser — the ONE place the spreadsheet shape
 * is decoded, shared by the manual import script and the automated intake route.
 * Returns raw rows keyed by our internal field names; all business mapping
 * (category/status/phone) happens downstream in the ingest service.
 */
import * as XLSX from 'xlsx';

/** Raw AgendaPro export row, already keyed by internal field names (still raw strings). */
export interface AgendaProRawRow {
  fecha_realizacion?: string;
  nombre?: string;
  apellido?: string;
  email?: string;
  telefono?: string;
  identificacion?: string;
  servicio?: string;
  precio_lista?: string | number;
  precio_real?: string | number;
  estado?: string;
}

function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Resolve the AgendaPro Spanish headers to our raw-row field names. */
function buildHeaderMap(headers: string[]): Record<string, keyof AgendaProRawRow> {
  const map: Record<string, keyof AgendaProRawRow> = {};
  for (const h of headers) {
    const n = norm(h);
    if (n.startsWith('fecha de realiz')) map[h] = 'fecha_realizacion';
    else if (n === 'nombre') map[h] = 'nombre';
    else if (n === 'apellido') map[h] = 'apellido';
    else if (n === 'e-mail' || n === 'email') map[h] = 'email';
    else if (n === 'telefono') map[h] = 'telefono';
    else if (n.includes('identificacion')) map[h] = 'identificacion';
    else if (n === 'servicio') map[h] = 'servicio';
    else if (n === 'precio lista') map[h] = 'precio_lista';
    else if (n === 'precio real') map[h] = 'precio_real';
    else if (n === 'estado') map[h] = 'estado'; // exact: NOT "estado de pago"
  }
  return map;
}

/** Parse a workbook from a file path or an in-memory buffer into raw rows. */
export function parseAgendaProWorkbook(input: string | Buffer): AgendaProRawRow[] {
  const wb =
    typeof input === 'string'
      ? XLSX.readFile(input)
      : XLSX.read(input, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: '',
    raw: false,
  });
  if (raw.length === 0) return [];
  const headerMap = buildHeaderMap(Object.keys(raw[0]));
  return raw.map((r) => {
    const out: AgendaProRawRow = {};
    for (const [header, field] of Object.entries(headerMap)) {
      (out as Record<string, unknown>)[field] = r[header];
    }
    return out;
  });
}
