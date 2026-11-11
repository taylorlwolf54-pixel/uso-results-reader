// Pure matching/parsing helpers: turn lines of text read off the results page into tracker result records.
// No browser code here so it can be tested on its own.

export const fold = s => String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const words = s => fold(s).split(' ').filter(Boolean);
const DAY_DATES = { wed: '2026-11-18', thu: '2026-11-19', fri: '2026-11-20', sat: '2026-11-21', sun: '2026-11-22' };

// Build lookups from the tracker's entries.json.
export function buildIndex(entries) {
  const entrants = entries.entrants.map(([handler, dog]) => ({ handler, dog, h: fold(handler), d: fold(dog), key: handler + '|' + dog }));
  const classes = new Map(); // folded class -> real class name
  const runs = new Map();    // key -> [{cls,date,height}]
  for (const ring of Object.values(entries.rings || {})) {
    classes.set(fold(ring.cls), ring.cls);
    for (const [, height, list] of ring.sections) for (const ei of list) {
      const [handler, dog] = entries.entrants[ei];
      const k = handler + '|' + dog;
      if (!runs.has(k)) runs.set(k, []);
      runs.get(k).push({ cls: ring.cls, date: ring.date, height, day: ring.day });
    }
  }
  // Handlers' last names help when the page shows "Rock" or "M. Rock".
  return { entrants, classes, runs };
}

// Best tracker class for a heading such as "Ring 1 – US Open Agility – Wednesday".
export function matchClass(text, index) {
  const t = fold(text);
  if (!t) return null;
  let best = null, bestScore = 0;
  for (const [f, real] of index.classes) {
    if (t.includes(f)) { const s = 100 + f.length; if (s > bestScore) { best = real; bestScore = s; } continue; }
    // Token overlap for small wording differences ("Speedstakes Round 1" vs "Speedstakes Rd 1").
    const cw = words(f).filter(w => !['rd', 'round', 'the', 'uki'].includes(w));
    const tw = new Set(words(t).map(w => w === 'round' ? 'rd' : w));
    const hit = cw.filter(w => tw.has(w)).length;
    const s = cw.length ? hit / cw.length : 0;
    if (s >= 0.75 && s * 100 > bestScore) { best = real; bestScore = s * 100; }
  }
  return best;
}

export function matchDate(text) {
  const t = fold(text);
  const m = t.match(/\b(?:nov(?:ember)?\s*)?(1[89]|2[012])\b/);
  if (/\bnov/.test(t) && m) return '2026-11-' + m[1];
  const iso = String(text).match(/2026-11-(1[89]|2[012])/);
  if (iso) return iso[0];
  const us = String(text).match(/\b11\/(1[89]|2[012])(?:\/(?:20)?26)?\b/);
  if (us) return '2026-11-' + us[1];
  for (const [day, date] of Object.entries(DAY_DATES)) {
    const full = { wed: 'wednesday', thu: 'thursday', fri: 'friday', sat: 'saturday', sun: 'sunday' }[day];
    if (new RegExp('\\b(' + full + '|' + day + ')\\b').test(t)) return date;
  }
  return null;
}

// Which entrant (if any) a row of text is about: needs the dog's call name AND the handler's name.
export function matchEntrant(line, index) {
  const t = ' ' + fold(line) + ' ';
  let found = [];
  for (const e of index.entrants) {
    if (!e.d || !t.includes(' ' + e.d + ' ')) continue;
    const hw = e.h.split(' ');
    const last = hw[hw.length - 1], first = hw[0];
    const full = t.includes(' ' + e.h + ' ');
    const partial = last.length > 1 && t.includes(' ' + last + ' ') && (t.includes(' ' + first + ' ') || t.includes(' ' + first[0] + ' '));
    if (full) found.push({ e, score: 3 });
    else if (partial) found.push({ e, score: 2 });
  }
  if (!found.length) return null;
  const top = Math.max(...found.map(f => f.score));
  found = found.filter(f => f.score === top);
  // Longest dog name wins ("Maui Jim" over "Jim"); still ambiguous means skip rather than guess.
  const longest = Math.max(...found.map(f => f.e.d.length));
  found = found.filter(f => f.e.d.length === longest);
  return found.length === 1 ? found[0].e : null;
}

const STATUS_WORDS = [
  [/\belim(inated)?\b/i, 'Eliminated'],
  [/(?:^|\s)E(?:\s|$)/, 'Eliminated'],
  [/\b(nfc|not for competition)\b/i, 'NFC'],
  [/\b(dq|disqualified)\b/i, 'Disqualified'],
  [/\b(abs|absent|scratch(ed)?|dns|no show)\b/i, 'Absent'],
  [/\b(withdrawn|wd)\b/i, 'Withdrawn']
];

// Pull result values out of a row once names are removed.
export function parseValues(line, entrant) {
  let rest = ' ' + String(line) + ' ';
  // Drop the names so numbers inside them can't be misread.
  for (const n of [entrant.handler, entrant.dog]) rest = rest.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  const out = {};
  const place = rest.match(/^\s*(?:#|pl(?:ace)?\.?\s*)?(\d{1,3})(?:st|nd|rd|th)?\b(?![.:]\d)/i) || rest.match(/\b(\d{1,3})(?:st|nd|rd|th)\b/i);
  if (place) out.placement = Number(place[1]);
  const time = rest.match(/\b(\d{1,3}\.\d{2,3})\s*(?:s|sec)?\b/);
  if (time) out.time = time[1];
  const faults = rest.match(/\b(?:faults?|f)\s*[:=]?\s*(\d{1,3})\b/i) || rest.match(/\b(\d{1,3})\s*(?:faults?|f)\b/i);
  if (faults) out.faults = Number(faults[1]);
  const score = rest.match(/\b(?:score|pts|points)\s*[:=]?\s*(-?\d{1,4}(?:\.\d+)?)\b/i) || rest.match(/\b(-?\d{1,4}(?:\.\d+)?)\s*(?:pts|points)\b/i);
  if (score) out.score = score[1];
  const cleanRest = rest.replace(/\b\d+(\.\d+)?\b/g, ' ');
  for (const [re, label] of STATUS_WORDS) if (re.test(cleanRest)) { out.status = label; break; }
  if (out.status && out.status !== 'Eliminated' && !out.time) delete out.placement;
  return out;
}

// Rows of one results screen -> records. `context` is the heading text above the rows.
export function recordsFromScreen({ heading, lines, sourceUrl }, index, now = new Date()) {
  const cls = matchClass(heading, index);
  const headingDate = matchDate(heading);
  const out = [];
  for (const line of lines) {
    const e = matchEntrant(line, index);
    if (!e) continue;
    const values = parseValues(line, e);
    if (!Object.keys(values).length) continue; // listed but no result yet (e.g. running order)
    const lineCls = cls || matchClass(line, index);
    if (!lineCls) continue;
    const candidates = (index.runs.get(e.key) || []).filter(r => r.cls === lineCls && (!headingDate || r.date === headingDate));
    const date = headingDate || (candidates.length === 1 ? candidates[0].date : undefined);
    const rec = { handler: e.handler, dog: e.dog, class: lineCls, ...values, sourceUrl, verifiedAt: now.toISOString() };
    if (date) rec.date = date;
    if (candidates.length === 1 && candidates[0].height) rec.height = candidates[0].height;
    out.push(rec);
  }
  return out;
}
