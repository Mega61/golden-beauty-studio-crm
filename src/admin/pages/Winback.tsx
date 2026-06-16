import * as React from 'react';
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
} from '@strapi/design-system';
import {
  ACTIONABLE,
  displayFor,
  statusPhrase,
  daysFromToday,
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

  // Only clients with a live countdown, soonest deadline first (already sorted server-side).
  const due = React.useMemo(() => rows.filter((r) => r.next_recommended_date), [rows]);

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
          <Box hasRadius background="neutral0" shadow="tableShadow">
            <Table colCount={7} rowCount={due.length}>
              <Thead>
                <Tr>
                  <Th>
                    <Typography variant="sigma">Cliente</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Teléfono</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Última visita</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Servicio base</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Próximo retoque</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Estado</Typography>
                  </Th>
                  <Th>
                    <Typography variant="sigma">Fidelización</Typography>
                  </Th>
                </Tr>
              </Thead>
              <Tbody>
                {due.map((r) => {
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
            {due.length === 0 ? (
              <Box padding={6}>
                <Typography textColor="neutral600">
                  No hay clientes con retoque pendiente todavía. Importa el reporte de AgendaPro para empezar.
                </Typography>
              </Box>
            ) : null}
          </Box>
        )}
      </Box>
    </Main>
  );
};

export default WinbackDashboard;
