import * as React from 'react';
import { unstable_useContentManagerContext as useContentManagerContext } from '@strapi/strapi/admin';
import { Box, Flex, Typography } from '@strapi/design-system';
import { statusPhrase, daysFromToday } from '../winback-status';
import StatusPill from './StatusPill';

/**
 * Inline retoque badge injected into the Client edit view (editView.informations).
 * Renders only for `api::client.client`; reads the live form values so it reflects
 * the current record without an extra fetch. See plan §4.3.
 */
const WinbackBadge = () => {
  const ctx = useContentManagerContext() as any;
  if (!ctx || ctx.model !== 'api::client.client') return null;

  const values = (ctx.form?.values ?? {}) as Record<string, any>;
  const status = values.winback_status as string | undefined;
  if (!status) return null;

  const remaining = daysFromToday(values.next_recommended_date);

  return (
    <Box paddingTop={4} paddingBottom={2}>
      <Typography variant="sigma" textColor="neutral600">
        Retoque
      </Typography>
      <Flex direction="column" alignItems="flex-start" gap={1} paddingTop={2}>
        <StatusPill status={status} />
        <Typography variant="pi" textColor="neutral800">
          {statusPhrase(status, remaining)}
        </Typography>
        {values.next_recommended_date ? (
          <Typography variant="pi" textColor="neutral600">
            Próximo retoque: {values.next_recommended_date}
          </Typography>
        ) : null}
        {values.last_visit_date ? (
          <Typography variant="pi" textColor="neutral600">
            Última visita: {values.last_visit_date}
          </Typography>
        ) : null}
        {values.needs_review ? (
          <Typography variant="pi" textColor="danger600">
            ⚠ Revisar (teléfono compartido)
          </Typography>
        ) : null}
      </Flex>
    </Box>
  );
};

export default WinbackBadge;
