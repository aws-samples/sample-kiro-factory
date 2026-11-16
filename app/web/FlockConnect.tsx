/**
 * The connections dialog: which Kiro Flocks this factory can run remote loops on.
 *
 * A native `<dialog>`, like `Confirm`, holding three things: the list of
 * connections with sign in and out, a form to add one, and - per connection -
 * the clusters on that flock with who owns them, so a cluster left running by a
 * closed factory can be found and stopped from here. Nothing in this dialog
 * stops or deletes anything without a confirm.
 *
 * The password is typed here and goes to the server once, in the add or sign-in
 * POST. It is not kept in React state a moment longer than the request, and the
 * server never sends it back. It is used for one sign-in and not stored anywhere.
 */
import { useEffect, useRef, useState } from 'react';
import { Confirm, type ConfirmAsk } from './Confirm.tsx';
import { Icon } from './Icon.tsx';
import { api, type FlockClusterView, type FlockConnectionView } from './api.ts';

export function FlockConnect({
  open,
  connections,
  onChange,
  onClose,
  onPick,
}: {
  open: boolean;
  connections: FlockConnectionView[];
  /** The list changed on the server; the owner refetches. */
  onChange: () => void;
  onClose: () => void;
  /** Present when the dialog was opened to choose a connection for a new loop. */
  onPick?: (connectionId: string) => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [adding, setAdding] = useState(connections.length === 0);
  const [confirm, setConfirm] = useState<ConfirmAsk | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Each opening starts on the list, unless there is nothing to list. The
  // component mounts before the connections have loaded, so the initial state
  // alone would leave the add form up for the rest of the session.
  useEffect(() => {
    if (open) setAdding(connections.length === 0);
  }, [open, connections.length]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      className="confirm flock-dialog"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current?.close();
      }}
    >
      <h2>Kiro Flock connections</h2>
      <p>
        A remote loop runs as a cluster on a Kiro Flock you already have. The factory keeps the
        sign-in here, drives the cluster through the flock's API, and moves queue items between
        your wires and the cluster's S3 folders. Nothing is deployed from here.
      </p>

      {connections.length > 0 && !adding && (
        <ul className="flock-list">
          {connections.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              onChange={onChange}
              onError={setError}
              onConfirm={setConfirm}
              {...(onPick !== undefined ? { onPick: () => onPick(c.id) } : {})}
            />
          ))}
        </ul>
      )}

      {adding ? (
        <AddForm
          onAdded={() => {
            setAdding(false);
            onChange();
          }}
          onCancel={connections.length > 0 ? () => setAdding(false) : undefined}
          onError={setError}
        />
      ) : (
        <div className="confirm-actions flock-actions">
          <button onClick={() => setAdding(true)}>
            <Icon name="hero-plus" /> Add a flock
          </button>
          <span className="spacer" />
          <button onClick={() => ref.current?.close()}>Close</button>
        </div>
      )}
      {error !== null && (
        <p className="confirm-warning" onClick={() => setError(null)}>
          {error}
        </p>
      )}
      <Confirm ask={confirm} onClose={() => setConfirm(null)} />
    </dialog>
  );
}

function ConnectionRow({
  connection,
  onChange,
  onError,
  onConfirm,
  onPick,
}: {
  connection: FlockConnectionView;
  onChange: () => void;
  onError: (e: string | null) => void;
  onConfirm: (ask: ConfirmAsk | null) => void;
  onPick?: () => void;
}) {
  const [signingIn, setSigningIn] = useState(false);
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [clusters, setClusters] = useState<FlockClusterView[] | null | 'loading'>(null);

  const host = (() => {
    try {
      return new URL(connection.apiUrl).host;
    } catch {
      return connection.apiUrl;
    }
  })();
  const isApiGateway = /\.execute-api\.[a-z0-9-]+\.amazonaws\.com$/.test(host);

  async function run(work: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    onError(null);
    try {
      await work();
      onChange();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function loadClusters(): Promise<void> {
    setClusters('loading');
    try {
      setClusters((await api.flocks.clusters(connection.id)).clusters);
    } catch (e) {
      onError((e as Error).message);
      setClusters(null);
    }
  }

  return (
    <li className="flock-row">
      <div className="flock-row-head">
        <div className="flock-row-name">
          <strong>{connection.name}</strong>
          <span className="flock-row-host" title={connection.apiUrl}>
            {host}
            {!isApiGateway && (
              <span className="hint" title="Not an API Gateway host name. Custom domains are fine; just make sure this is the flock you mean.">
                {' '}
                custom domain
              </span>
            )}
          </span>
          <span className="flock-row-user">{connection.username}</span>
        </div>
        <div className="flock-row-state">
          {connection.queueRoutes === false && (
            <span className="flock-needs-update" title="This flock's Lambda does not have the env-list, env-put and env-delete routes. Redeploy it from a checkout that carries them, then press Re-check.">
              needs flock update
            </span>
          )}
          <span className={`flock-signed ${connection.signedIn ? 'in' : 'out'}`}>
            {connection.signedIn ? 'signed in' : 'signed out'}
          </span>
        </div>
      </div>

      <div className="flock-row-actions">
        {onPick !== undefined && (
          <button className="primary" disabled={!connection.signedIn || connection.queueRoutes === false} onClick={onPick}>
            Use for this loop
          </button>
        )}
        {signingIn ? (
          <form
            className="flock-signin"
            onSubmit={(e) => {
              e.preventDefault();
              const pw = password;
              const code = mfaCode.trim();
              setPassword('');
              setMfaCode('');
              void run(async () => {
                await api.flocks.signin(connection.id, pw, code || undefined);
                setSigningIn(false);
              });
            }}
          >
            <input type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            <input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} placeholder="Authenticator code" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
            <button type="submit" disabled={busy || password.length === 0}>Sign in</button>
            <button type="button" onClick={() => setSigningIn(false)}>Cancel</button>
          </form>
        ) : (
          <>
            <button onClick={() => setSigningIn(true)} disabled={busy}>
              {connection.signedIn ? 'Sign in again' : 'Sign in'}
            </button>
            {connection.signedIn && (
              <button onClick={() => void run(() => api.flocks.signout(connection.id))} disabled={busy} title="Forget the tokens. Running clusters are not touched.">
                Sign out
              </button>
            )}
            <button onClick={() => void run(() => api.flocks.probe(connection.id))} disabled={busy || !connection.signedIn} title="Ask the flock whether it has the queue routes remote loops need.">
              Re-check
            </button>
            <button onClick={() => void loadClusters()} disabled={busy || !connection.signedIn} title="Every cluster on this flock, with who owns it. Clusters left running by a closed factory show up here.">
              {clusters === null ? 'Clusters' : 'Refresh clusters'}
            </button>
            <button
              className="danger icon-only"
              title="Remove this connection and its stored sign-in. Refused while a loop in an open factory uses it."
              aria-label="Remove connection"
              disabled={busy}
              onClick={() =>
                onConfirm({
                  title: `Remove the connection to ${connection.name}?`,
                  body: 'The stored sign-in is deleted from this machine. Clusters on the flock are not touched.',
                  action: 'Remove connection',
                  onConfirm: () => void run(() => api.flocks.remove(connection.id)),
                })
              }
            >
              <Icon name="hero-trash" />
            </button>
          </>
        )}
      </div>

      {clusters === 'loading' && <p className="hint">asking the flock…</p>}
      {Array.isArray(clusters) && (
        <ClusterList
          connection={connection}
          clusters={clusters}
          onRefresh={loadClusters}
          onError={onError}
          onConfirm={onConfirm}
        />
      )}
    </li>
  );
}

const OWNER_WORDS: Record<FlockClusterView['owner'], string> = {
  'this-factory': 'this factory',
  'other-factory': 'an open factory',
  'kiro-factory-orphan': 'Kiro Factory, nobody driving it',
  'not-ours': 'not created by Kiro Factory',
};

function ClusterList({
  connection,
  clusters,
  onRefresh,
  onError,
  onConfirm,
}: {
  connection: FlockConnectionView;
  clusters: FlockClusterView[];
  onRefresh: () => Promise<void>;
  onError: (e: string | null) => void;
  onConfirm: (ask: ConfirmAsk | null) => void;
}) {
  if (clusters.length === 0) return <p className="hint">no clusters on this flock</p>;
  const act = (work: () => Promise<unknown>) => () =>
    void work().then(onRefresh).catch((e: Error) => onError(e.message));
  return (
    <table className="flock-clusters">
      <thead>
        <tr>
          <th>cluster</th>
          <th>state</th>
          <th>owner</th>
          <th>cost</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {clusters.map((c) => {
          const orphan = c.owner === 'kiro-factory-orphan';
          const live = c.state !== undefined && c.state !== 'stopped';
          return (
            <tr key={c.id} className={orphan ? 'orphan' : ''}>
              <td>
                <a href={c.uiUrl} target="_blank" rel="noopener noreferrer" title="Open in the flock's own UI (needs its own sign-in)">
                  {c.id}
                </a>
              </td>
              <td className={`state ${c.state ?? ''}`}>{c.state ?? '?'}</td>
              <td>
                {OWNER_WORDS[c.owner]}
                {c.drivenBy !== undefined && <span className="hint"> ({c.drivenBy.factory} / {c.drivenBy.loop})</span>}
                {c.detached !== undefined && (
                  <span className="hint" title={c.detached.baseDir}>
                    {' '}
                    (left running by {c.detached.factoryName})
                  </span>
                )}
              </td>
              <td className="cost">
                {typeof c.infraCostUsd === 'number' ? `$${c.infraCostUsd.toFixed(2)}` : ''}
                {typeof c.totalCredits === 'number' ? ` ${c.totalCredits.toFixed(1)} cr` : ''}
              </td>
              <td className="actions">
                {orphan && live && (
                  <button
                    onClick={() =>
                      onConfirm({
                        title: `Stop ${c.id}?`,
                        body: 'The cluster stops now; its nodes do not finish their current turn. Its files stay in S3.',
                        action: 'Stop cluster',
                        onConfirm: act(() => api.flocks.stopCluster(connection.id, c.id)),
                      })
                    }
                  >
                    Stop
                  </button>
                )}
                {orphan && (
                  <button
                    className="danger"
                    onClick={() =>
                      onConfirm({
                        title: `Remove ${c.id} from the flock?`,
                        body: live ? 'It is stopped first, then removed from the flock\'s list. Its files stay in S3.' : 'Removed from the flock\'s list. Its files stay in S3.',
                        action: 'Remove cluster',
                        onConfirm: act(() => api.flocks.removeCluster(connection.id, c.id)),
                      })
                    }
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function AddForm({
  onAdded,
  onCancel,
  onError,
}: {
  onAdded: () => void;
  onCancel?: () => void;
  onError: (e: string | null) => void;
}) {
  const [apiUrl, setApiUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [mfaCode, setMfaCode] = useState('');
  const [name, setName] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [userPoolId, setUserPoolId] = useState('');
  const [clientId, setClientId] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <form
      className="flock-add"
      onSubmit={(e) => {
        e.preventDefault();
        setBusy(true);
        onError(null);
        const pw = password;
        const code = mfaCode.trim();
        setPassword('');
        setMfaCode('');
        api.flocks
          .add({
            apiUrl: apiUrl.trim(),
            username: username.trim(),
            password: pw,
            ...(code ? { mfaCode: code } : {}),
            ...(name.trim() ? { name: name.trim() } : {}),
            ...(advanced && userPoolId.trim() ? { userPoolId: userPoolId.trim() } : {}),
            ...(advanced && clientId.trim() ? { clientId: clientId.trim() } : {}),
          })
          .then(() => onAdded())
          .catch((err: Error) => {
            onError(err.message);
            if (/auth-config|pool id|client id/i.test(err.message)) setAdvanced(true);
          })
          .finally(() => setBusy(false));
      }}
    >
      <label>
        Flock API URL
        <input
          type="url"
          placeholder="https://abc123.execute-api.eu-central-1.amazonaws.com/prod"
          value={apiUrl}
          onChange={(e) => setApiUrl(e.target.value)}
          required
          autoFocus
        />
        <span className="hint">The URL the flock's dashboard lives at. Must be https.</span>
      </label>
      <div className="flock-add-row">
        <label>
          Username
          <input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required />
        </label>
        <label>
          Password
          <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        <label>
          Authenticator code
          <input type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*" maxLength={8} placeholder="123456" value={mfaCode} onChange={(e) => setMfaCode(e.target.value)} />
        </label>
      </div>
      <label>
        Name <span className="hint">(optional)</span>
        <input type="text" placeholder="My flock" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="hint">
        The password and the code from your authenticator app are used once to sign in; enroll the authenticator by
        signing in to the flock dashboard first. The factory keeps the 7-day refresh token on this machine and asks you to
        sign in again when it expires; a remote loop that is syncing then shows &quot;signed out&quot; until you do.
      </p>
      <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
        <summary>Advanced: the flock did not publish auth-config.json</summary>
        <div className="flock-add-row">
          <label>
            User pool id
            <input type="text" placeholder="eu-central-1_AbCdEf" value={userPoolId} onChange={(e) => setUserPoolId(e.target.value)} />
          </label>
          <label>
            Client id
            <input type="text" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </label>
        </div>
      </details>
      <div className="confirm-actions flock-actions">
        {onCancel !== undefined && (
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        )}
        <span className="spacer" />
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Signing in…' : 'Add and sign in'}
        </button>
      </div>
    </form>
  );
}
