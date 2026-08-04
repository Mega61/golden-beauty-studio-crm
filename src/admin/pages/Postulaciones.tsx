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
  Link as DSLink,
} from '@strapi/design-system';
import {
  APPLICATION_STATUS_DISPLAY,
  OPEN_STATUSES,
  displayForApplication,
  experienceLabel,
  relativeAge,
  roleLabel,
  SURFACE_LABELS,
  surfaceLabel,
  type ApplicationStatus,
} from '../application-status';
import ApplicationPill from '../components/ApplicationPill';

const UID = 'api::job-application.job-application';
const CM_BASE = `/content-manager/collection-types/${UID}`;

interface ApplicationRow {
  documentId: string;
  id: number;
  full_name?: string;
  phone?: string;
  email?: string | null;
  role_applied?: string | null;
  role?: { id: number; slug?: string; label_es?: string } | null;
  experience?: string | null;
  techniques?: string | null;
  portfolio_url?: string | null;
  message?: string | null;
  triage_status?: ApplicationStatus | null;
  source_surface?: string | null;
  source_lang?: string | null;
  createdAt?: string;
  cv?: { id: number; url?: string; name?: string; ext?: string } | null;
}

const ALL = 'all';
const OPEN = 'open';

/** wa.me link from the stored E.164 phone (+57… → 57…). */
function whatsappHref(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? `https://wa.me/${digits}` : null;
}

/** Deep link to the entry's edit view — always available, even without a CV URL. */
function entryHref(documentId: string): string {
  return `/admin${CM_BASE}/${documentId}`;
}

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

const KPI = ({ label, count, status }: { label: string; count: number; status: string }) => {
  const d = displayForApplication(status);
  return (
    <Box
      padding={4}
      hasRadius
      background="neutral0"
      shadow="tableShadow"
      style={{ borderLeft: `4px solid ${d.fg}` }}
    >
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

/** Status dropdown — writes straight through to the entry (optimistic). */
const StatusSelect = ({
  row,
  saving,
  onChange,
}: {
  row: ApplicationRow;
  saving: boolean;
  onChange: (row: ApplicationRow, next: ApplicationStatus) => void;
}) => (
  <SingleSelect
    size="S"
    aria-label={`Estado de ${row.full_name || 'la postulación'}`}
    value={row.triage_status ?? 'nueva'}
    disabled={saving}
    onChange={(v: unknown) => onChange(row, String(v) as ApplicationStatus)}
  >
    {Object.entries(APPLICATION_STATUS_DISPLAY).map(([key, d]) => (
      <SingleSelectOption key={key} value={key}>
        {d.label}
      </SingleSelectOption>
    ))}
  </SingleSelect>
);

/** CV + contact shortcuts for one applicant. */
const RowActions = ({ row }: { row: ApplicationRow }) => {
  const wa = whatsappHref(row.phone);
  return (
    <Flex gap={3} wrap="wrap">
      {row.cv?.url ? (
        <DSLink href={row.cv.url} isExternal>
          Descargar CV
        </DSLink>
      ) : (
        <DSLink href={entryHref(row.documentId)}>Ver CV</DSLink>
      )}
      {wa ? (
        <DSLink href={wa} isExternal>
          WhatsApp
        </DSLink>
      ) : null}
      {row.portfolio_url ? (
        <DSLink href={row.portfolio_url} isExternal>
          Portafolio
        </DSLink>
      ) : null}
    </Flex>
  );
};

/** One label/value line inside a mobile card. */
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <Flex
    justifyContent="space-between"
    alignItems="baseline"
    gap={4}
    paddingTop={1}
    paddingBottom={1}
  >
    <Typography variant="pi" textColor="neutral600">
      {label}
    </Typography>
    <Box style={{ textAlign: 'right' }}>{children}</Box>
  </Flex>
);

const ApplicationCard = ({
  row,
  saving,
  onStatusChange,
}: {
  row: ApplicationRow;
  saving: boolean;
  onStatusChange: (row: ApplicationRow, next: ApplicationStatus) => void;
}) => (
  <Box
    hasRadius
    background="neutral0"
    shadow="tableShadow"
    padding={4}
    marginBottom={3}
    style={{ borderLeft: `4px solid ${displayForApplication(row.triage_status).fg}` }}
  >
    <Flex justifyContent="space-between" alignItems="flex-start" gap={2}>
      <Typography variant="delta" fontWeight="bold">
        {row.full_name || '—'}
      </Typography>
      <ApplicationPill status={row.triage_status} />
    </Flex>

    <Box paddingTop={1} paddingBottom={2}>
      <Typography variant="pi" textColor="neutral600">
        {roleLabel(row.role, row.role_applied)} · {relativeAge(row.createdAt)} ·{' '}
        {surfaceLabel(row.source_surface)}
      </Typography>
    </Box>

    <Box style={{ borderTop: '1px solid #eaeaef' }} paddingTop={2}>
      <Field label="Teléfono">
        <Typography textColor="neutral700">{row.phone || '—'}</Typography>
      </Field>
      <Field label="Correo">
        <Typography textColor="neutral700">{row.email || '—'}</Typography>
      </Field>
      <Field label="Experiencia">
        <Typography textColor="neutral700">{experienceLabel(row.experience)}</Typography>
      </Field>
      <Field label="Técnicas">
        <Typography textColor="neutral700">{row.techniques || '—'}</Typography>
      </Field>
      <Field label="Estado">
        <StatusSelect row={row} saving={saving} onChange={onStatusChange} />
      </Field>
      <Box paddingTop={2}>
        <RowActions row={row} />
      </Box>
    </Box>
  </Box>
);

const COLUMNS = [
  'Postulante',
  'Cargo',
  'Experiencia',
  'Contacto',
  'Origen',
  'Recibida',
  'Estado',
  'Acciones',
];

/**
 * "Postulaciones" — triage surface for the Trabaja con nosotros form.
 *
 * Everything here is a read + a status write on the job-application content
 * type; the Content Manager remains the place to read a full application (long
 * message, internal notes). This page exists so the owner can answer the only
 * question she has on her phone — "who applied and do I want to call them?" —
 * without paging through the CM list view.
 */
const PostulacionesDashboard = () => {
  const { get, put } = useFetchClient();
  const [rows, setRows] = React.useState<ApplicationRow[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [savingIds, setSavingIds] = React.useState<Set<string>>(new Set());

  const [statusFilter, setStatusFilter] = React.useState<string>(OPEN);
  const [roleFilter, setRoleFilter] = React.useState<string>(ALL);
  const [surfaceFilter, setSurfaceFilter] = React.useState<string>(ALL);

  React.useEffect(() => {
    let active = true;
    (async () => {
      try {
        const { data } = await get(CM_BASE, {
          params: {
            page: 1,
            pageSize: 100,
            sort: 'createdAt:DESC',
            // Media isn't in the default list payload; ask for it so the CV is
            // one click away instead of one navigation away.
            populate: ['cv', 'role'],
          },
        });
        if (active) setRows(data?.results ?? []);
      } catch (e: any) {
        if (active) setError(e?.message ?? 'Error cargando postulaciones');
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
    for (const r of rows) {
      const key = r.triage_status ?? 'nueva';
      c[key] = (c[key] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  // Cargo filter options are derived from the applications on screen rather than
  // from a fixed list: vacancies are CMS-configured and come and go, and this way
  // a closed-but-still-relevant cargo remains filterable.
  const roleOptions = React.useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of rows) {
      const key = r.role?.slug ?? r.role_applied ?? '';
      if (key && !seen.has(key)) seen.set(key, roleLabel(r.role, r.role_applied));
    }
    return Array.from(seen, ([value, label]) => ({ value, label })).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [rows]);

  const setStatus = React.useCallback(
    async (row: ApplicationRow, next: ApplicationStatus) => {
      const prev = row.triage_status ?? 'nueva';
      if (next === prev) return;
      setRows((rs) =>
        rs.map((r) => (r.documentId === row.documentId ? { ...r, triage_status: next } : r)),
      );
      setSavingIds((s) => new Set(s).add(row.documentId));
      try {
        await put(`${CM_BASE}/${row.documentId}`, { triage_status: next });
      } catch (e: any) {
        setRows((rs) =>
          rs.map((r) => (r.documentId === row.documentId ? { ...r, triage_status: prev } : r)),
        );
        setError(e?.message ?? 'No se pudo guardar el estado');
      } finally {
        setSavingIds((s) => {
          const n = new Set(s);
          n.delete(row.documentId);
          return n;
        });
      }
    },
    [put],
  );

  const visible = React.useMemo(
    () =>
      rows.filter((r) => {
        const status = r.triage_status ?? 'nueva';
        if (statusFilter === OPEN && !OPEN_STATUSES.includes(status)) return false;
        if (statusFilter !== OPEN && statusFilter !== ALL && status !== statusFilter) return false;
        if (roleFilter !== ALL && (r.role?.slug ?? r.role_applied ?? '') !== roleFilter) return false;
        if (surfaceFilter !== ALL && (r.source_surface ?? '') !== surfaceFilter) return false;
        return true;
      }),
    [rows, statusFilter, roleFilter, surfaceFilter],
  );

  const emptyText =
    rows.length === 0
      ? 'Todavía no hay postulaciones. Aparecerán aquí en cuanto alguien envíe el formulario de "Trabaja con nosotros".'
      : 'Ninguna postulación coincide con los filtros seleccionados.';

  return (
    <Main>
      <Box padding={8}>
        <Typography variant="alpha" tag="h1">
          Postulaciones
        </Typography>
        <Box paddingTop={1} paddingBottom={6}>
          <Typography variant="epsilon" textColor="neutral600">
            Quien se postula desde la página web o el link de Instagram aparece acá. Cambia el
            estado para no perderle el hilo; la hoja de vida se descarga con un clic.
          </Typography>
        </Box>

        <Grid.Root gap={4} paddingBottom={6}>
          <Grid.Item col={3} s={12}>
            <KPI label="Nuevas" count={counts.nueva ?? 0} status="nueva" />
          </Grid.Item>
          <Grid.Item col={3} s={12}>
            <KPI label="En revisión" count={counts.en_revision ?? 0} status="en_revision" />
          </Grid.Item>
          <Grid.Item col={3} s={12}>
            <KPI label="En entrevista" count={counts.entrevista ?? 0} status="entrevista" />
          </Grid.Item>
          <Grid.Item col={3} s={12}>
            <KPI label="Contratadas" count={counts.contratada ?? 0} status="contratada" />
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
                  onChange={(v: unknown) => setStatusFilter(String(v))}
                >
                  <SingleSelectOption value={OPEN}>Sin resolver</SingleSelectOption>
                  <SingleSelectOption value={ALL}>Todas</SingleSelectOption>
                  {Object.entries(APPLICATION_STATUS_DISPLAY).map(([key, d]) => (
                    <SingleSelectOption key={key} value={key}>
                      {d.label}
                    </SingleSelectOption>
                  ))}
                </SingleSelect>
              </Box>
              <Box minWidth="14rem">
                <SingleSelect
                  label="Cargo"
                  value={roleFilter}
                  onChange={(v: unknown) => setRoleFilter(String(v))}
                >
                  <SingleSelectOption value={ALL}>Todos</SingleSelectOption>
                  {roleOptions.map((o) => (
                    <SingleSelectOption key={o.value} value={o.value}>
                      {o.label}
                    </SingleSelectOption>
                  ))}
                </SingleSelect>
              </Box>
              <Box minWidth="14rem">
                <SingleSelect
                  label="Origen"
                  value={surfaceFilter}
                  onChange={(v: unknown) => setSurfaceFilter(String(v))}
                >
                  <SingleSelectOption value={ALL}>Todos</SingleSelectOption>
                  {Object.entries(SURFACE_LABELS).map(([key, label]) => (
                    <SingleSelectOption key={key} value={key}>
                      {label}
                    </SingleSelectOption>
                  ))}
                </SingleSelect>
              </Box>
              <Box paddingBottom={2}>
                <Typography variant="pi" textColor="neutral600">
                  {visible.length} de {rows.length}
                </Typography>
              </Box>
            </Flex>

            <DesktopOnly>
              <Box hasRadius background="neutral0" shadow="tableShadow">
                <Table colCount={COLUMNS.length} rowCount={visible.length}>
                  <Thead>
                    <Tr>
                      {COLUMNS.map((label) => (
                        <Th key={label}>
                          <Typography variant="sigma">{label}</Typography>
                        </Th>
                      ))}
                    </Tr>
                  </Thead>
                  <Tbody>
                    {visible.map((r) => (
                      <Tr key={r.documentId}>
                        <Td>
                          <Flex direction="column" alignItems="flex-start">
                            <Typography fontWeight="semiBold">{r.full_name || '—'}</Typography>
                            {r.techniques ? (
                              <Typography variant="pi" textColor="neutral600">
                                {r.techniques}
                              </Typography>
                            ) : null}
                          </Flex>
                        </Td>
                        <Td>
                          <Typography textColor="neutral700">
                            {roleLabel(r.role, r.role_applied)}
                          </Typography>
                        </Td>
                        <Td>
                          <Typography textColor="neutral700">
                            {experienceLabel(r.experience)}
                          </Typography>
                        </Td>
                        <Td>
                          <Flex direction="column" alignItems="flex-start">
                            <Typography textColor="neutral700">{r.phone || '—'}</Typography>
                            {r.email ? (
                              <Typography variant="pi" textColor="neutral600">
                                {r.email}
                              </Typography>
                            ) : null}
                          </Flex>
                        </Td>
                        <Td>
                          <Typography variant="pi" textColor="neutral600">
                            {surfaceLabel(r.source_surface)}
                          </Typography>
                        </Td>
                        <Td>
                          <Typography variant="pi" textColor="neutral600">
                            {relativeAge(r.createdAt)}
                          </Typography>
                        </Td>
                        <Td onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                          <StatusSelect
                            row={r}
                            saving={savingIds.has(r.documentId)}
                            onChange={setStatus}
                          />
                        </Td>
                        <Td onClick={(e: React.MouseEvent) => e.stopPropagation()}>
                          <RowActions row={r} />
                        </Td>
                      </Tr>
                    ))}
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
                visible.map((r) => (
                  <ApplicationCard
                    key={r.documentId}
                    row={r}
                    saving={savingIds.has(r.documentId)}
                    onStatusChange={setStatus}
                  />
                ))
              )}
            </MobileOnly>
          </>
        )}
      </Box>
    </Main>
  );
};

export default PostulacionesDashboard;
