import * as React from 'react';
import { displayFor } from '../winback-status';

/** A small colored status pill, used by both the dashboard and the inline badge. */
export const StatusPill = ({ status }: { status: string | null | undefined }) => {
  const d = displayFor(status);
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

export default StatusPill;
