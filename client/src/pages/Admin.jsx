import { useEffect, useState } from 'react';
import { IconUpload, IconCircleCheck } from '@tabler/icons-react';
import { get, post } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';
import { useI18n } from '../lib/i18n.jsx';

// Admin-only: upload a destination's venue dataset (spec 6.3). The server
// checks every rule and rejects the whole file if anything is wrong.
export default function Admin() {
  const { user } = useAuth();
  const { t } = useI18n();
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
    return <main className="page"><div className="banner info">{t('Only admins can manage venue datasets.')}</div></main>;
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
      setResult({ error: t("That file isn't valid JSON. Check it in a text editor.") });
    }
  }

  async function send(path) {
    if (!json) return setResult({ error: t('Choose a dataset file first') });
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
      <h1>{t('Venue datasets')}</h1>
      <section className="panel">
        <table>
          <thead><tr><th>{t('Destination')}</th><th>{t('Version')}</th><th className="num">{t('Venues')}</th><th>{t('Updated')}</th></tr></thead>
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
        <h2>{t('Upload a dataset')}</h2>
        <p className="small muted">
          {t('A JSON file in the same format as')} <code>server/data/destinations/jaipur.json</code>. {t("Uploading replaces that destination's venues. Check it first to see any problems without changing anything.")}
        </p>
        <div className="field">
          <label htmlFor="file">{t('Dataset file')}</label>
          <input id="file" type="file" accept=".json,application/json" onChange={pick} />
        </div>
        {json && (
          <p className="small muted">
            {file?.name}: {json.destination?.name ?? t('unknown destination')}, {t('{n} venues', { n: Array.isArray(json.venues) ? json.venues.length : 0 })}
          </p>
        )}
        <div className="row">
          <button onClick={() => send('/admin/datasets/validate')} disabled={busy}>{t('Check file')}</button>
          <button className="primary" onClick={() => send('/admin/datasets')} disabled={busy}><IconUpload size={14} aria-hidden="true" /> {t('Upload')}</button>
        </div>

        {result?.ok && (
          <div className="banner info" style={{ marginTop: 12 }}>
            <IconCircleCheck size={16} aria-hidden="true" />
            <span>
              {result.ok.summary
                ? t('Uploaded {name}: {n} venues ({added} new, {changed} changed, {removed} removed).', { name: result.ok.summary.destination, n: result.ok.summary.venues, added: result.ok.summary.inserted, changed: result.ok.summary.updated, removed: result.ok.summary.removed })
                : t('The file passes every check: {n} venues for {name}.', { n: result.ok.venues, name: result.ok.destination })}
            </span>
          </div>
        )}
        {result?.error && (
          <div className="banner danger" role="alert" style={{ marginTop: 12, display: 'block' }}>
            <div>{result.error}</div>
            {result.details && (
              <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {result.details.slice(0, 30).map((d, i) => <li key={i}><code>{d.path || '(file)'}</code>: {d.message}</li>)}
                {result.details.length > 30 && <li>{t('and {n} more', { n: result.details.length - 30 })}</li>}
              </ul>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
