import { useEffect, useState } from 'react';
import { IconUpload, IconCircleCheck } from '@tabler/icons-react';
import { get, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

// Admin-only: upload a destination's venue dataset (spec 6.3). The server
// checks every rule and rejects the whole file if anything is wrong.
export default function Admin() {
  const { user } = useAuth();
  const [datasets, setDatasets] = useState([]);
  const [file, setFile] = useState(null);
  const [json, setJson] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => get('/admin/datasets').then((r) => setDatasets(r.datasets)).catch(() => {});
  useEffect(() => {
    if (user?.role === 'admin') load();
  }, [user]);

  if (user?.role !== 'admin') {
    return <main className="page"><div className="banner info">Only admins can manage venue datasets.</div></main>;
  }

  async function pick(e) {
    const f = e.target.files?.[0];
    setResult(null);
    setJson(null);
    setFile(f ?? null);
    if (!f) return;
    try {
      setJson(JSON.parse(await f.text()));
    } catch {
      setResult({ error: "That file isn't valid JSON. Check it in a text editor." });
    }
  }

  async function send(path) {
    if (!json) return setResult({ error: 'Choose a dataset file first' });
    setBusy(true);
    try {
      const r = await post(path, json);
      setResult({ ok: r });
      if (path === '/admin/datasets') load();
    } catch (err) {
      setResult({ error: err.message, details: err.details });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page stack" style={{ maxWidth: 760 }}>
      <h1>Venue datasets</h1>
      <section className="panel">
        <table>
          <thead><tr><th>Destination</th><th>Version</th><th className="num">Venues</th><th>Updated</th></tr></thead>
          <tbody>
            {datasets.map((d) => (
              <tr key={d.slug}>
                <td>{d.name}</td>
                <td className="muted">{d.datasetVersion}</td>
                <td className="num">{d.venueCount}</td>
                <td className="muted">{new Date(d.updatedAt).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel">
        <h2>Upload a dataset</h2>
        <p className="small muted">
          A JSON file in the same format as <code>server/data/destinations/lisbon.json</code>. Uploading replaces that destination's venues. Check it first to see any problems without changing anything.
        </p>
        <div className="field">
          <label htmlFor="file">Dataset file</label>
          <input id="file" type="file" accept=".json,application/json" onChange={pick} />
        </div>
        {json && (
          <p className="small muted">
            {file?.name}: {json.destination?.name ?? 'unknown destination'}, {Array.isArray(json.venues) ? json.venues.length : 0} {json.venues?.length === 1 ? 'venue' : 'venues'}
          </p>
        )}
        <div className="row">
          <button onClick={() => send('/admin/datasets/validate')} disabled={busy}>Check file</button>
          <button className="primary" onClick={() => send('/admin/datasets')} disabled={busy}><IconUpload size={14} aria-hidden="true" /> Upload</button>
        </div>

        {result?.ok && (
          <div className="banner info" style={{ marginTop: 12 }}>
            <IconCircleCheck size={16} aria-hidden="true" />
            <span>
              {result.ok.summary
                ? `Uploaded ${result.ok.summary.destination}: ${result.ok.summary.venues} venues (${result.ok.summary.inserted} new, ${result.ok.summary.updated} changed, ${result.ok.summary.removed} removed).`
                : `The file passes every check: ${result.ok.venues} venues for ${result.ok.destination}.`}
            </span>
          </div>
        )}
        {result?.error && (
          <div className="banner danger" role="alert" style={{ marginTop: 12, display: 'block' }}>
            <div>{result.error}</div>
            {result.details && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {result.details.slice(0, 30).map((d, i) => <li key={i}><code>{d.path || '(file)'}</code>: {d.message}</li>)}
                {result.details.length > 30 && <li>and {result.details.length - 30} more</li>}
              </ul>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
