// Fotomaleri – bestillinger, status/logg og e-postsending (Netlify Blobs + Resend)
// Endepunkt: https://DITT-SITE.netlify.app/.netlify/functions/ordrer
//
// POST (offentlig, uten kode) : ny bestilling fra landingssiden (JSON + evt. bilde som data-URL)
// GET  (adminkode)            : hent alle ordrer -> { ordrer: [...] } (inkl. status/notat/svarlogg)
// GET  ?img=<id>              : serverer kundens bilde (CORS) så Pro kan hente det
// POST (adminkode + action)   : admin-handlinger:
//    { action:'oppdater', id, sak:{status,notat,levertUrl,vannmerke,skjult} }  -> lagrer på ordren
//    { action:'send', id, til, emne, tekst, markerLevert? }                    -> sender e-post + logger
//
// Miljøvariabler i Netlify:
//   ADMIN_KODE      (finnes fra før)  – admin-tilgang
//   RESEND_API_KEY  – nøkkel fra resend.com
//   RESEND_FROM     – avsender, f.eks.  Kristin <kristin@malestudio.no>  (må være verifisert domene)
//   RESEND_REPLYTO  – valgfritt svar-til (default = RESEND_FROM)

import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Kode',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

async function sendViaResend(til, emne, tekst) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM || 'Fotomaleri <onboarding@resend.dev>';
  if (!key) return { ok: false, error: 'RESEND_API_KEY er ikke satt i Netlify.' };
  if (!til) return { ok: false, error: 'Mangler mottakeradresse.' };
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [til],
      subject: emne || '(uten emne)',
      text: tekst || '',
      reply_to: process.env.RESEND_REPLYTO || from,
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: (data && (data.message || data.error)) || ('Resend svarte ' + r.status) };
  return { ok: true, id: data.id };
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });

  const store = getStore('fotomaleri-ordrer');
  const url = new URL(req.url);
  const adminOk = (req.headers.get('x-admin-kode') || '') === (process.env.ADMIN_KODE || '');

  // --- Serve bilde ---
  if (req.method === 'GET' && url.searchParams.has('img')) {
    const id = url.searchParams.get('img');
    const res = await store.getWithMetadata('bilde/' + id, { type: 'arrayBuffer' });
    if (!res || !res.data) return new Response('Ikke funnet', { status: 404, headers: CORS });
    const ct = (res.metadata && res.metadata.ct) || 'image/jpeg';
    return new Response(res.data, { headers: { ...CORS, 'Content-Type': ct, 'Cache-Control': 'public, max-age=31536000' } });
  }

  // --- Admin: hent alle ordrer ---
  if (req.method === 'GET') {
    if (!adminOk) return json({ error: 'Feil eller manglende adminkode' }, 401);
    const { blobs } = await store.list({ prefix: 'ordre/' });
    const ordrer = [];
    for (const b of blobs) {
      const o = await store.get(b.key, { type: 'json' });
      if (o) ordrer.push(o);
    }
    ordrer.sort((a, b) => new Date(b.mottatt) - new Date(a.mottatt));
    return json({ ordrer });
  }

  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Ugyldig JSON' }, 400); }

    // --- Admin-handlinger (krever kode) ---
    if (body.action) {
      if (!adminOk) return json({ error: 'Feil eller manglende adminkode' }, 401);
      const key = 'ordre/' + body.id;
      const o = await store.get(key, { type: 'json' });
      if (!o) return json({ error: 'Fant ikke ordren' }, 404);

      if (body.action === 'oppdater') {
        const s = body.sak || {};
        for (const k of ['status', 'notat', 'levertUrl', 'vannmerke', 'skjult']) {
          if (k in s) o[k] = s[k];
        }
        await store.setJSON(key, o);
        return json({ ok: true, ordre: o });
      }

      if (body.action === 'send') {
        const res = await sendViaResend(body.til, body.emne, body.tekst);
        if (!res.ok) return json({ error: res.error }, 502);
        o.svarlogg = o.svarlogg || [];
        o.svarlogg.push({ tid: new Date().toISOString(), emne: body.emne || '', tekst: body.tekst || '' });
        if (body.markerLevert) o.status = 'levert';
        await store.setJSON(key, o);
        return json({ ok: true, ordre: o, sendId: res.id });
      }

      return json({ error: 'Ukjent handling' }, 400);
    }

    // --- Ny bestilling fra landingssiden (offentlig) ---
    const id = 'o_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const mottatt = new Date().toISOString();

    let bildeUrl = '';
    if (typeof body.bilde === 'string' && body.bilde.startsWith('data:')) {
      const m = body.bilde.match(/^data:([^;]+);base64,(.*)$/);
      if (m) {
        const ct = m[1];
        const buf = Buffer.from(m[2], 'base64');
        await store.set('bilde/' + id, buf, { metadata: { ct } });
        bildeUrl = url.origin + url.pathname + '?img=' + id;
      }
    }

    const ordre = {
      id, mottatt,
      navn: body.navn || '', epost: body.epost || '', telefon: body.telefon || '',
      kategori: body.kategori || '', motiv: body.motiv || '', stemning: body.stemning || '',
      forbilde: body.forbilde || '', tekst: body.tekst || '', signatur: body.signatur || '',
      melding: body.melding || '', onske: body.onske || '', vei: body.vei || 'gratis',
      bildeUrl,
      // sak (lever på ordren, server-side)
      status: 'ny', notat: '', levertUrl: '', vannmerke: '', skjult: false, svarlogg: [],
    };
    await store.setJSON('ordre/' + id, ordre);
    return json({ ok: true, id });
  }

  return json({ error: 'Metoden støttes ikke' }, 405);
};
