/**
 * AgendaPro *transactions* export (.xlsx) parser — the money ledger (Reporte de
 * transacciones), distinct from the reservations export in agendapro-xlsx.ts. This is
 * the ONE place the transactions spreadsheet shape is decoded; all business mapping
 * (method → account, amount → COP) happens downstream in the payment ingest service.
 *
 * Columns (AgendaPro Spanish headers):
 *   ID | ID Venta | Fecha | Monto | Propina | Comprobante | Método de Pago | Cuotas |
 *   Comisión | Fecha de transferencia | Estado de pago
 */
import * as XLSX from 'xlsx';

/** Raw AgendaPro transactions row, keyed by internal field names (still raw strings). */
export interface AgendaProTxRawRow {
  id?: string | number;
  id_venta?: string;
  fecha?: string;
  monto?: string | number;
  propina?: string | number;
  metodo_pago?: string;
  comision?: string | number;
  estado_pago?: string;
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
function buildHeaderMap(headers: string[]): Record<string, keyof AgendaProTxRawRow> {
  const map: Record<string, keyof AgendaProTxRawRow> = {};
  for (const h of headers) {
    const n = norm(h);
    if (n === 'id') map[h] = 'id';
    else if (n === 'id venta') map[h] = 'id_venta';
    else if (n === 'fecha') map[h] = 'fecha';
    else if (n === 'monto') map[h] = 'monto';
    else if (n === 'propina') map[h] = 'propina';
    else if (n.startsWith('metodo de pago')) map[h] = 'metodo_pago';
    else if (n.startsWith('comision')) map[h] = 'comision';
    else if (n === 'estado de pago') map[h] = 'estado_pago';
  }
  return map;
}

/** Parse a transactions workbook from a file path or an in-memory buffer into raw rows. */
export function parseAgendaProTxWorkbook(input: string | Buffer): AgendaProTxRawRow[] {
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
    const out: AgendaProTxRawRow = {};
    for (const [header, field] of Object.entries(headerMap)) {
      (out as Record<string, unknown>)[field] = r[header];
    }
    return out;
  });
}
