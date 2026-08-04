import * as React from 'react';
import { displayForApplication } from '../application-status';

/** Colored triage pill for a Postulación status. Mirrors StatusPill (win-back). */
export const ApplicationPill = ({ status }: { status: string | null | undefined }) => {
  const d = displayForApplication(status);
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 999,
        background: d.bg,
        color: d.fg,
        fontSize: 12,
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {d.label}
    </span>
  );
};

export default ApplicationPill;
