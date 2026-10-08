/**
 * AgendaPro *sales* export (.xlsx) parser — the "Reporte de ventas" (sales/sale/export).
 * Unlike the transactions export, this workbook says WHO paid and FOR WHAT, which is
 * what turns an Actual income from "Venta 1129" into "Monica Jaramillo · Tradicional pies".
 *
 * Sheets (AgendaPro Spanish headers; only the two we need are read):
 *   Ventas — ID | ID interno | Fecha | Monto venta | … | Cliente | Local | Nota | Creado por
 *   Ítems  — ID Venta | Fecha venta | Local | Cliente | Tipo item | Categoría | Nombre item | …
 *
 * The join key is the sale's "ID interno" (Ventas) == "ID Venta" (Ítems) == the
 * transactions report's "ID Venta" == Payment.sale_id. Ventas' own "ID" column is a
 * different, internal number and is NOT the key.
 */
import * as XLSX from 'xlsx';

/** One sale: who it was for and what was sold. */
export interface AgendaProSale {
  sale_id: string;
  client_name: string | null;
  service_name: string | null;
}

function norm(s: unknown): string {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Trim and collapse whitespace; AgendaPro names often carry a trailing space. */
function clean(s: unknown): string | null {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v || null;
}

/** Rows of the sheet whose (accent-insensitive) name is `name`, keyed by normalized header. */
function sheetRows(wb: XLSX.WorkBook, name: string): Array<Record<string, unknown>> {
  const sheetName = wb.SheetNames.find((n) => norm(n) === name);
  const ws = sheetName ? wb.Sheets[sheetName] : undefined;
  if (!ws) return [];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: '', raw: false });
  return raw.map((r) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(r)) out[norm(k)] = v;
    return out;
  });
}

/**
 * Parse a sales workbook into one entry per sale. A sale with several items lists them
 * joined with " + " in sale order. Throws when the workbook has neither sheet, so a
 * changed export format fails loud instead of silently enriching nothing.
 */
export function parseAgendaProSalesWorkbook(input: string | Buffer): AgendaProSale[] {
  const wb =
    typeof input === 'string' ? XLSX.readFile(input) : XLSX.read(input, { type: 'buffer' });
  const has = (name: string) => wb.SheetNames.some((n) => norm(n) === name);
  if (!has('ventas') && !has('items')) {
    throw new Error(`not a sales report (sheets: ${wb.SheetNames.join(', ')})`);
  }
  const ventas = sheetRows(wb, 'ventas');
  const items = sheetRows(wb, 'items');

  const sales = new Map<string, AgendaProSale>();
  const get = (id: string) => {
    let s = sales.get(id);
    if (!s) {
      s = { sale_id: id, client_name: null, service_name: null };
      sales.set(id, s);
    }
    return s;
  };

  for (const r of ventas) {
    const id = clean(r['id interno']);
    if (!id) continue;
    get(id).client_name = clean(r['cliente']);
  }

  const services = new Map<string, string[]>();
  for (const r of items) {
    const id = clean(r['id venta']);
    if (!id) continue;
    const s = get(id);
    if (!s.client_name) s.client_name = clean(r['cliente']);
    const item = clean(r['nombre item']);
    if (!item) continue;
    const list = services.get(id) ?? [];
    list.push(item);
    services.set(id, list);
  }
  for (const [id, list] of services) get(id).service_name = list.join(' + ');

  return [...sales.values()];
}
