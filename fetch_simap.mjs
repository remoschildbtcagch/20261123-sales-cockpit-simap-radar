// SIMAP-Abruf für das Sales Cockpit
// Holt die Publikationen der letzten Tage von der öffentlichen simap-API
// und speichert sie unbewertet als data/latest.json (+ Tagesdatei).
// Bewertet wird nicht hier, sondern im Cockpit.
import fs from 'node:fs';

const BASE = 'https://www.simap.ch';
const TAGE = Number(process.env.SIMAP_TAGE || 4);
const heute = new Date(new Date().toLocaleString('en-US', {timeZone: 'Europe/Zurich'}));
const iso = (d) => d.toISOString().slice(0, 10);
const stand = iso(heute);
const von = iso(new Date(heute.getTime() - (TAGE - 1) * 86400000));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(path, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(BASE + path, {headers: {accept: 'application/json', 'user-agent': 'sales-cockpit-simap/1.0'}});
      if (r.ok) return await r.json();
      if (i === tries) throw new Error(`HTTP ${r.status} für ${path}`);
    } catch (e) {
      if (i === tries) throw e;
    }
    await sleep(1500 * i);
  }
}

const L = (o) => (o ? o.de || o.fr || o.it || o.en || '' : '');
const strip = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
const cpvOf = (pr) => {
  const c = [];
  if (pr && pr.cpvCode) c.push(pr.cpvCode.code);
  ((pr && pr.additionalCpvCodes) || []).forEach((x) => c.push(x.code));
  return c;
};

// 1) Liste aller Publikationen seit «von»
const all = [];
let last = null, pages = 0;
do {
  const j = await getJson('/api/publications/v2/project/project-search?lang=de&newestPublicationFrom=' + von + (last ? '&lastItem=' + encodeURIComponent(last) : ''));
  all.push(...j.projects);
  last = j.pagination && j.pagination.lastItem;
  pages++;
  if (j.projects.length < 20) last = null;
} while (last && pages < 300);

const AUSSCHR = new Set(['tender', 'advance_notice', 'request_for_information', 'competition', 'study_contract', 'participant_selection']);
const ZUSCHL = new Set(['award', 'direct_award']);

// 2) Details Ausschreibungen
const tenders = [];
const tTodo = all.filter((p) => AUSSCHR.has(p.pubType) && p.projectSubType !== 'construction');
async function oneTender(p) {
  try {
    const j = await getJson(`/api/publications/v1/project/${p.id}/publication-details/${p.publicationId}`);
    const pr = j.procurement || {};
    const cpv = cpvOf(pr);
    const lotT = [];
    (j.lots || []).forEach((l) => { const lp = l.procurement || l; cpv.push(...cpvOf(lp)); lotT.push(L(l.title)); });
    tenders.push({id: p.id, nr: p.publicationNumber, typ: p.pubType, date: p.publicationDate, title: L(p.title), office: L(p.procOfficeName),
      canton: (j['project-info'] && j['project-info'].procOfficeAddress && j['project-info'].procOfficeAddress.cantonId) || '',
      cpv: [...new Set(cpv)], deadline: String((j.dates && j.dates.offerDeadline) || ''), lots: lotT.join(' | ').slice(0, 300),
      desc: strip(L(pr.orderDescription)).slice(0, 700)});
  } catch (e) { console.error('Ausschreibung', p.publicationNumber, e.message); }
}

// 3) Details Zuschläge (je Los)
const awards = [];
const aTodo = [];
for (const p of all) {
  if (!ZUSCHL.has(p.pubType) || p.projectSubType === 'construction') continue;
  if (p.lots && p.lots.length) for (const l of p.lots) aTodo.push({p, pubId: l.publicationId, nr: l.publicationNumber || p.publicationNumber, lotNr: l.lotNumber, lotId: l.lotId, lotTitle: L(l.lotTitle)});
  else aTodo.push({p, pubId: p.publicationId, nr: p.publicationNumber, lotNr: null, lotId: null, lotTitle: ''});
}
async function oneAward(a) {
  try {
    const j = await getJson(`/api/publications/v1/project/${a.p.id}/publication-details/${a.pubId}${a.lotId ? '?lotId=' + a.lotId : ''}`);
    const pr = j.procurement || {}, dec = j.decision || {}, pi = j['project-info'] || {};
    awards.push({key: a.nr + (a.lotNr != null ? '-L' + a.lotNr : ''), nr: a.nr, id: a.p.id, typ: a.p.pubType, date: a.p.publicationDate,
      title: L(pi.title) || L(a.p.title), lotTitle: a.lotTitle, office: L(a.p.procOfficeName),
      canton: (pi.procOfficeAddress && pi.procOfficeAddress.cantonId) || '', cpv: [...new Set(cpvOf(pr))],
      desc: strip(L(pr.orderDescription) + ' ' + L(pr.projectOrderDescription)).slice(0, 700),
      vendors: (dec.vendors || []).map((v) => ({name: v.vendorName || '', preis: v.price && v.price.price != null ? Number(v.price.price) : null})),
      range: (dec.totalPriceRange && dec.totalPriceRange.range) || null,
      angebote: dec.numberOfSubmissions != null ? dec.numberOfSubmissions : null, entscheid: dec.awardDecisionDate || ''});
  } catch (e) { console.error('Zuschlag', a.nr, e.message); }
}

async function pool(list, fn, n = 6) {
  for (let i = 0; i < list.length; i += n) { await Promise.all(list.slice(i, i + n).map(fn)); await sleep(200); }
}
await pool(tTodo, oneTender);
await pool(aTodo, oneAward);

const days = {};
for (const p of all) days[p.publicationDate] = (days[p.publicationDate] || 0) + 1;

const out = {stand, von, abgerufen: new Date().toISOString(), nAll: all.length, days, tenders, awards};
fs.mkdirSync('data', {recursive: true});
fs.writeFileSync('data/latest.json', JSON.stringify(out));
fs.writeFileSync(`data/${stand}.json`, JSON.stringify(out));
console.log(`OK ${stand}: ${all.length} Publikationen, ${tenders.length} Ausschreibungen, ${awards.length} Zuschläge (seit ${von})`);
if (!all.length) process.exit(1);
