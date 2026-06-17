import * as React from 'react';
import { styled } from 'styled-components';
import { useFetchClient } from '@strapi/strapi/admin';
import {
  Main,
  Box,
  Flex,
  Grid,
  Typography,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  Loader,
  SingleSelect,
  SingleSelectOption,
  IconButton,
} from '@strapi/design-system';
import { CaretUp, CaretDown } from '@strapi/icons';
import {
  ACTIONABLE,
  displayFor,
  statusPhrase,
  daysFromToday,
  STATUS_DISPLAY,
  type WinbackStatus,
} from '../winback-status';
import StatusPill from '../components/StatusPill';

interface ClientRow {
  documentId: string;
  full_name?: string;
  phone?: string;
  last_visit_date?: string | null;
  last_eligible_service?: string | null;
  next_recommended_date?: string | null;
  winback_status?: WinbackStatus | null;
  stampee_card?: 'matched' | 'sin_tarjeta' | null;
  needs_review?: boolean;
}

const ALL = 'all';

type SortKey =
  | 'full_name'
  | 'phone'
  | 'last_visit_date'
  | 'last_eligible_service'
  | 'next_recommended_date'
  | 'winback_status'
  | 'stampee_card';

interface SortState {
  key: SortKey;
  dir: 'asc' | 'desc';
}

const DEFAULT_SORT: SortState = { key: 'next_recommended_date', dir: 'asc' };

/** Urgency order: most overdue first → least. Used when sorting by Estado. */
const STATUS_RANK: Record<string, number> = {
  vencido: 0,
  por_vencer: 1,
  en_ventana: 2,
  reciente: 3,
  sin_cadencia: 4,
};

const FIDEL_RANK: Record<string, number> = { matched: 0, sin_tarjeta: 1, sin_dato: 2 };

/** A comparable scalar for a row under a given sort key (numbers rank, strings localeCompare). */
function comparable(row: ClientRow, key: SortKey): number | string {
  switch (key) {
    case 'winback_status':
      return STATUS_RANK[row.winback_status ?? 'sin_cadencia'] ?? 99;
    case 'stampee_card':
      return FIDEL_RANK[row.stampee_card ?? 'sin_dato'] ?? 99;
    case 'full_name':
    case 'last_eligible_service':
      return (row[key] ?? '').toString().toLowerCase();
    default:
      // phone + ISO date strings: lexical order matches numeric/chronological order.
      return (row[key] ?? '').toString();
  }
}

/** Columns, in render order, with which sort key each header drives. */
const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'full_name', label: 'Cliente' },
  { key: 'phone', label: 'Teléfono' },
  { key: 'last_visit_date', label: 'Última visita' },
  { key: 'last_eligible_service', label: 'Servicio base' },
  { key: 'next_recommended_date', label: 'Próximo retoque' },
  { key: 'winback_status', label: 'Estado' },
  { key: 'stampee_card', label: 'Fidelización' },
];

const KPI = ({ label, count, status }: { label: string; count: number; status: WinbackStatus }) => {
  const d = displayFor(status);
  return (
    <Box padding={4} hasRadius background="neutral0" shadow="tableShadow" style={{ borderLeft: `4px solid ${d.fg}` }}>
      <Typography variant="sigma" textColor="neutral600">
        {label}
      </Typography>
      <Box paddingTop={2}>
        <Typography variant="alpha" style={{ color: d.fg }}>
          {count}
        </Typography>
      </Box>
    </Box>
  );
};

const Fidelizacion = ({ value }: { value?: string | null }) => {
  if (value === 'matched')
    return (
      <Typography variant="pi" textColor="success600">
        ✓ Tarjeta
      </Typography>
    );
  if (value === 'sin_tarjeta')
    return (
      <Typography variant="pi" textColor="danger600">
        ✗ Sin tarjeta
      </Typography>
    );
  return <Typography variant="pi" textColor="neutral500">—</Typography>;
};

/**
 * Strapi's <Table> is a plain HTML table with no responsive behaviour, so the
 * 7 columns overflow a phone viewport. We render the table for tablet/desktop
 * and swap to a stacked card list below the design-system "medium" breakpoint
 * (768px). Pure CSS — no resize listeners — so it matches Strapi's own approach.
 */
const DesktopOnly = styled.div`
  @media (max-width: 768px) {
    display: none;
  }
`;

const MobileOnly = styled.div`
  display: none;
  @media (max-width: 768px) {
    display: block;
  }
`;

/** One label/value line inside a mobile card. */
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Flex justifyContent="space-between" alignItems="baseline" gap={4} paddingTop={1} paddingBottom={1}>
    <Typography variant="pi" textColor="neutral600">
      {label}
    </Typography>
    <Box style={{ textAlign: 'right' }}>{children}</Box>
  </Flex>
);

/** Phone layout: one card per client, header (name + status) over stacked fields. */
const RetoqueCard = ({ row }: { row: ClientRow }) => {
  const remaining = daysFromToday(row.next_recommended_date);
  return (
    <Box
      hasRadius
      background="neutral0"
      shadow="tableShadow"
      padding={4}
      marginBottom={3}
      style={{ borderLeft: `4px solid ${displayFor(row.winback_status).fg}` }}
    >
      <Flex justifyContent="space-between" alignItems="flex-start" gap={2}>
        <Typography variant="delta" fontWeight="bold">
          {row.full_name || '—'}
        </Typography>
        <StatusPill status={row.winback_status} />
      </Flex>

      <Box paddingTop={1} paddingBottom={2}>
        <Typography variant="pi" textColor="neutral600">
          {statusPhrase(row.winback_status, remaining)}
        </Typography>
        {row.needs_review ? (
          <Box paddingTop={1}>
            <Typography variant="pi" textColor="danger600">
              ⚠ revisar
            </Typography>
          </Box>
        ) : null}
      </Box>

      <Box style={{ borderTop: '1px solid #eaeaef' }} paddingTop={2}>
        <Field label="Teléfono">
          <Typography textColor="neutral700">{row.phone || '—'}</Typography>
        </Field>
        <Field label="Última visita">
          <Typography textColor="neutral700">{row.last_visit_date || '—'}</Typography>
        </Field>
        <Field label="Servicio base">
          <Typography textColor="neutral700">{row.last_eligible_service || '—'}</Typography>
        </Field>
        <Field label="Próximo retoque">
          <Typography textColor="neutral700">{row.next_recommended_date}</Typography>
        </Field>
        <Field label="Fidelización">
          <Fidelizacion value={row.stampee_card} />
        </Field>
      </Box>
    </Box>
  );
};

const WinbackDashboard = () => {
  const { get } = useFetchClient();
  const [rows, setRows] = React.useState<ClientRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await get('/content-manager/collection-types/api::client.client', {
          params: { page: 1, pageSize: 100, sort: 'next_recommended_date:ASC' },
        });
        if (active) setRows(data?.results ?? []);
      } catch (e: any) {
        if (active) setError(e?.message ?? 'Error cargando clientes');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [get]);

  const counts = React.useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of rows) c[r.winback_status ?? 'sin_cadencia'] = (c[r.winback_status ?? 'sin_cadencia'] ?? 0) + 1;
    return c;
  }, [rows]);

  // Only clients with a live countdown.
  const due = React.useMemo(() => rows.filter((r) => r.next_recommended_date), [rows]);

  const [statusFilter, setStatusFilter] = React.useState<string>(ALL);
  const [fidelFilter, setFidelFilter] = React.useState<string>(ALL);
  const [sort, setSort] = React.useState<SortState>(DEFAULT_SORT);

  const toggleSort = React.useCallback((key: SortKey) => {
    setSort((prev) =>
      prev.key === key ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' },
    );
  }, []);

  // Filter, then sort. Memoized so it only recomputes when inputs change.
  const visible = React.useMemo(() => {
    const filtered = due.filter((r) => {
      if (statusFilter !== ALL && (r.winback_status ?? 'sin_cadencia') !== statusFilter) return false;
      if (fidelFilter !== ALL && (r.stampee_card ?? 'sin_dato') !== fidelFilter) return false;
      return true;
    });
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const va = comparable(a, sort.key);
      const vb = comparable(b, sort.key);
      const cmp = typeof va === 'number' ? va - (vb as number) : String(va).localeCompare(String(vb));
      return cmp * dir;
    });
  }, [due, statusFilter, fidelFilter, sort]);

  // Header cell that sorts its column on click and shows the active direction.
  const SortableTh = ({ column }: { column: { key: SortKey; label: string } }) => {
    const active = sort.key === column.key;
    return (
      <Th>
        <Flex
          tag="button"
          type="button"
          onClick={() => toggleSort(column.key)}
          gap={1}
          alignItems="center"
          aria-label={`Ordenar por ${column.label}`}
          style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer' }}
        >
          <Typography variant="sigma" textColor={active ? 'primary600' : undefined}>
            {column.label}
          </Typography>
          {active ? (
            sort.dir === 'asc' ? (
              <CaretUp width="0.625rem" height="0.625rem" aria-hidden />
            ) : (
              <CaretDown width="0.625rem" height="0.625rem" aria-hidden />
            )
          ) : null}
        </Flex>
      </Th>
    );
  };

  const emptyText =
    due.length === 0
      ? 'No hay clientes con retoque pendiente todavía. Importa el reporte de AgendaPro para empezar.'
      : 'Ningún cliente coincide con los filtros seleccionados.';

  return (
    <Main>
      <Box padding={8}>
        <Typography variant="alpha" tag="h1">
          Retoques / Win-back
        </Typography>
        <Box paddingTop={1} paddingBottom={6}>
          <Typography variant="epsilon" textColor="neutral600">
            Ventana de retoque 15–21 días. Pasados 21 días el retoque no aplica: se cobra montaje completo.
          </Typography>
        </Box>

        <Grid.Root gap={4} paddingBottom={6}>
          <Grid.Item col={4} s={12}>
            <KPI label="En ventana (agendar)" count={counts.en_ventana ?? 0} status="en_ventana" />
          </Grid.Item>
          <Grid.Item col={4} s={12}>
            <KPI label="Por vencer" count={counts.por_vencer ?? 0} status="por_vencer" />
          </Grid.Item>
          <Grid.Item col={4} s={12}>
            <KPI label="Vencidos (cobrar montaje)" count={counts.vencido ?? 0} status="vencido" />
          </Grid.Item>
        </Grid.Root>

        {loading ? (
          <Flex justifyContent="center" padding={8}>
            <Loader>Cargando…</Loader>
          </Flex>
        ) : error ? (
          <Typography textColor="danger600">{error}</Typography>
        ) : (
          <>
          <Flex gap={3} paddingBottom={4} wrap="wrap" alignItems="flex-end">
            <Box minWidth="14rem">
              <SingleSelect
                label="Estado"
                value={statusFilter}
                onChange={(v) => setStatusFilter(String(v))}
              >
                <SingleSelectOption value={ALL}>Todos</SingleSelectOption>
                {Object.entries(STATUS_DISPLAY).map(([key, d]) => (
                  <SingleSelectOption key={key} value={key}>
                    {d.label}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Box>
            <Box minWidth="14rem">
              <SingleSelect
                label="Fidelización"
                value={fidelFilter}
                onChange={(v) => setFidelFilter(String(v))}
              >
                <SingleSelectOption value={ALL}>Todas</SingleSelectOption>
                <SingleSelectOption value="matched">Con tarjeta</SingleSelectOption>
                <SingleSelectOption value="sin_tarjeta">Sin tarjeta</SingleSelectOption>
                <SingleSelectOption value="sin_dato">Sin dato</SingleSelectOption>
              </SingleSelect>
            </Box>
            <Box minWidth="14rem">
              <SingleSelect
                label="Ordenar por"
                value={sort.key}
                onChange={(v) => setSort((p) => ({ key: v as SortKey, dir: p.dir }))}
              >
                {COLUMNS.map((c) => (
                  <SingleSelectOption key={c.key} value={c.key}>
                    {c.label}
                  </SingleSelectOption>
                ))}
              </SingleSelect>
            </Box>
            <IconButton
              label={sort.dir === 'asc' ? 'Orden ascendente' : 'Orden descendente'}
              onClick={() => setSort((p) => ({ key: p.key, dir: p.dir === 'asc' ? 'desc' : 'asc' }))}
            >
              {sort.dir === 'asc' ? <CaretUp /> : <CaretDown />}
            </IconButton>
            <Box paddingBottom={2}>
              <Typography variant="pi" textColor="neutral600">
                {visible.length} de {due.length}
              </Typography>
            </Box>
          </Flex>

          <DesktopOnly>
          <Box hasRadius background="neutral0" shadow="tableShadow">
            <Table colCount={7} rowCount={visible.length}>
              <Thead>
                <Tr>
                  {COLUMNS.map((c) => (
                    <SortableTh key={c.key} column={c} />
                  ))}
                </Tr>
              </Thead>
              <Tbody>
                {visible.map((r) => {
                  const remaining = daysFromToday(r.next_recommended_date);
                  return (
                    <Tr key={r.documentId}>
                      <Td>
                        <Flex direction="column" alignItems="flex-start">
                          <Typography fontWeight="semiBold">{r.full_name || '—'}</Typography>
                          {r.needs_review ? (
                            <Typography variant="pi" textColor="danger600">
                              ⚠ revisar
                            </Typography>
                          ) : null}
                        </Flex>
                      </Td>
                      <Td>
                        <Typography textColor="neutral700">{r.phone}</Typography>
                      </Td>
                      <Td>
                        <Typography textColor="neutral700">{r.last_visit_date || '—'}</Typography>
                      </Td>
                      <Td>
                        <Typography textColor="neutral700">{r.last_eligible_service || '—'}</Typography>
                      </Td>
                      <Td>
                        <Typography textColor="neutral700">{r.next_recommended_date}</Typography>
                      </Td>
                      <Td>
                        <Flex direction="column" alignItems="flex-start" gap={1}>
                          <StatusPill status={r.winback_status} />
                          <Typography variant="pi" textColor="neutral600">
                            {statusPhrase(r.winback_status, remaining)}
                          </Typography>
                        </Flex>
                      </Td>
                      <Td>
                        <Fidelizacion value={r.stampee_card} />
                      </Td>
                    </Tr>
                  );
                })}
              </Tbody>
            </Table>
            {visible.length === 0 ? (
              <Box padding={6}>
                <Typography textColor="neutral600">{emptyText}</Typography>
              </Box>
            ) : null}
          </Box>
          </DesktopOnly>

          <MobileOnly>
            {visible.length === 0 ? (
              <Box hasRadius background="neutral0" shadow="tableShadow" padding={6}>
                <Typography textColor="neutral600">{emptyText}</Typography>
              </Box>
            ) : (
              visible.map((r) => <RetoqueCard key={r.documentId} row={r} />)
            )}
          </MobileOnly>
          </>
        )}
      </Box>
    </Main>
  );
};

export default WinbackDashboard;
