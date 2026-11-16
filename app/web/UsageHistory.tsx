/**
 * A factory's cost history: one row per server run, newest first.
 *
 * A native `<dialog>` opened with `showModal()` and styled with the confirm
 * dialog's rules, for the same reasons `Confirm` gives: focus is trapped, Escape
 * closes it, and a click on the backdrop means "never mind".
 *
 * The runs come from the on-disk ledger, so past runs survive a server restart.
 * The run marked `current` is the one the canvas totals are counting.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { creditsToUsd, fmtCredits, fmtUsd } from './costFormat.ts';
import type { FactoryRef, RunSummary } from './types.ts';

function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function UsageHistory({
  factory,
  onClose,
}: {
  factory: Pick<FactoryRef, 'id' | 'name'> | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [data, setData] = useState<{ current: string; runs: RunSummary[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  /*
   * Keyed by the id, not the `factory` object. The caller builds that object on
   * every render, and the toolbar re-renders with each status frame while loops
   * run, so depending on the object reset the dialog (and collapsed the open run)
   * many times a second.
   */
  const id = factory?.id ?? null;
  useEffect(() => {
    setData(null);
    setError(null);
    setOpen(null);
    const dialog = ref.current;
    if (id !== null && dialog && !dialog.open) dialog.showModal();
    if (id === null) return;
    let live = true;
    api
      .usageHistory(id)
      .then((d) => live && setData(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [id]);
  if (!factory) return null;
  return (
    <dialog
      ref={ref}
      className="confirm usage-history"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <h2>Run history: {factory.name}</h2>
      <p>One row per server run. Credits come from kiro-cli's own metering.</p>
      {error !== null && <p className="confirm-warning">{error}</p>}
      {data === null && error === null && <p>Loading.</p>}
      {data !== null && data.runs.length === 0 && <p>No finished iterations recorded yet.</p>}
      {data !== null && data.runs.length > 0 && (
        <table className="usage-runs">
          <thead>
            <tr>
              <th>Started</th>
              <th>Duration</th>
              <th>Iterations</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {data.runs.map((r) => (
              <RunRows
                key={r.runId}
                run={r}
                current={r.runId === data.current}
                expanded={open === r.runId}
                onToggle={() => setOpen(open === r.runId ? null : r.runId)}
              />
            ))}
          </tbody>
        </table>
      )}
      <div className="confirm-actions">
        <button autoFocus onClick={() => ref.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}

function RunRows({
  run,
  current,
  expanded,
  onToggle,
}: {
  run: RunSummary;
  current: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="usage-run" onClick={onToggle} title="Show the loops in this run">
        <td>
          {new Date(run.startedAt).toLocaleString()}
          {current && <span className="usage-current">current</span>}
        </td>
        <td>{duration(run.durationMs)}</td>
        <td>
          {run.iterations}
          {run.unmetered > 0 && <span title="Iterations with no metering"> ({run.unmetered} not metered)</span>}
        </td>
        <td title={fmtUsd(creditsToUsd(run.credits))}>{fmtCredits(run.credits)}</td>
      </tr>
      {expanded &&
        run.loops.map((l) => (
          <tr key={l.key} className="usage-loop">
            <td colSpan={2}>{l.loopName}</td>
            <td>{l.iterations}</td>
            <td>{fmtCredits(l.credits)}</td>
          </tr>
        ))}
    </>
  );
}
