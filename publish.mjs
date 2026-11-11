// Publishes the tracker's results.json to its Spacefast Space, changing nothing else.
// A results-only version keeps the Space's pages, alerts and server code exactly as they are.
import { createHash } from 'node:crypto';

const API = (process.env.SPACEFAST_API || 'https://api.spacefast.com').replace(/\/$/, '');
const SOURCE = 'https://results.gacsystems.com/';
const MAX_RESULTS = 2000;
const MIN_FILES = 12; // the tracker has 14 files; fewer means something went wrong

const resultKey = r => JSON.stringify([r.handler, r.dog, r.class, r.date || '', r.height || '', r.round || '', r.runId || '']);
const resultValues = r => JSON.stringify([r.placement ?? null, r.score ?? null, r.time ?? null, r.faults ?? null, r.status ?? null]);

// Merge freshly read records into the live file. Unchanged results keep their first "verified" time,
// so the alert sender only sees real changes. Results the reader didn't see this pass are kept.
export function merge(current, fresh, allowed, now = new Date()) {
  const base = current && current.schemaVersion === 1 && Array.isArray(current.results) ? current : { results: [] };
  const merged = new Map(base.results.map(r => [resultKey(r), r]));
  let changed = 0;
  for (const r of fresh) {
    if (!allowed.has(r.handler + '|' + r.dog)) continue;
    const rec = { ...r, sourceUrl: r.sourceUrl?.startsWith('https://results.gacsystems.com') ? r.sourceUrl : SOURCE, verifiedAt: r.verifiedAt || now.toISOString() };
    const old = merged.get(resultKey(rec));
    if (old && resultValues(old) === resultValues(rec)) continue;
    merged.set(resultKey(rec), rec);
    changed++;
  }
  const stamp = now.toISOString();
  return {
    changed,
    data: {
      schemaVersion: 1,
      status: changed ? `Updated from official results (${changed} new or changed)` : 'Checked official results',
      checkedAt: stamp,
      updatedAt: changed ? stamp : base.updatedAt ?? null,
      sourceUrl: SOURCE,
      results: [...merged.values()].slice(-MAX_RESULTS)
    }
  };
}

async function api(path, { method = 'GET', body, key }) {
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: 'Bearer ' + key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!r.ok) throw Error(`Spacefast ${method} ${path} → HTTP ${r.status}: ${(json?.detail || text).slice(0, 300)}`);
  return json;
}

// Publish one results.json as a new live version of the Space.
export async function publishResults(data, { spaceId, key }) {
  const bytes = Buffer.from(JSON.stringify(data, null, 1) + '\n');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const created = await api(`/v1/spaces/${spaceId}/versions`, {
    method: 'POST', key,
    body: {
      publishMode: 'additive',
      files: [{ path: 'results.json', size: bytes.length, sha256, contentType: 'application/json' }],
      finalize: { channel: null },
      source: { kind: 'api', message: data.status }
    }
  });
  const version = created.data;
  for (const t of version.upload?.targets || []) {
    const r = await fetch(t.url, { method: t.method || 'PUT', headers: t.headers, body: bytes });
    if (!r.ok) throw Error(`Upload of ${t.path} failed: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  // Build the version without making it live, check it kept the whole site, then promote it.
  const done = await api(`/v1/spaces/${spaceId}/versions/${version.versionId}/finalize`, { method: 'POST', key, body: { channel: null } });
  const v = done.data;
  if (v.status !== 'ready' || v.fileCount < MIN_FILES || !v.runtimeCodeDetected) {
    throw Error(`Version ${version.versionId} looks incomplete (status ${v.status}, ${v.fileCount} files, server code ${v.runtimeCodeDetected}); not making it live`);
  }
  await api(`/v1/spaces/${spaceId}/versions/${version.versionId}/promote`, { method: 'POST', key, body: { channel: 'live' } });
  return { versionId: version.versionId, number: v.number, bytes: bytes.length };
}
