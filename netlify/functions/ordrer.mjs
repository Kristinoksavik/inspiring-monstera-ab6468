// Fotomaleri – bestillingsmottak og -lagring (Netlify Blobs)
// Endepunkt: https://DITT-SITE.netlify.app/.netlify/functions/ordrer
//
// POST  (offentlig)  : landingssiden sender en bestilling (JSON, evt. bilde som data-URL)
// GET   (adminkode)  : bestillingspanelet henter alle ordrer  -> { ordrer: [...] }
// GET   ?img=<id>    : serverer kundens bilde (med CORS) så Pro-appen kan hente det
//
// Krav i Netlify: sett miljøvariabelen ADMIN_KODE (Site settings -> Environment variables).

import { getStore } from '@netlify/blobs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Kode',
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: CORS });

  const store = getStore('fotomaleri-ordrer');
  const url = new URL(req.url);

  // --- Serve bilde: GET ?img=<id> ---
  if (req.method === 'GET' && url.searchParams.has('img')) {
    const id = url.searchParams.get('img');
    const res = await store.getWithMetadata('bilde/' + id, { type: 'arrayBuffer' });
    if (!res || !res.data) return new Response('Ikke funnet', { status: 404, headers: CORS });
    const ct = (res.metadata && res.metadata.ct) || 'image/jpeg';
    return new Response(res.data, { headers: { ...CORS, 'Content-Type': ct, 'Cache-Control': 'public, max-age=31536000' } });
  }

  // --- Admin: hent alle ordrer ---
  if (req.method === 'GET') {
    if ((req.headers.get('x-admin-kode') || '') !== (process.env.ADMIN_KODE || '')) {
      return json({ error: 'Feil eller manglende adminkode' }, 401);
    }
    const { blobs } = await store.list({ prefix: 'ordre/' });
    const ordrer = [];
    for (const b of blobs) {
      const o = await store.get(b.key, { type: 'json' });
      if (o) ordrer.push(o);
    }
    ordrer.sort((a, b) => new Date(b.mottatt) - new Date(a.mottatt));
    return json({ ordrer });
  }

  // --- Ny bestilling fra landingssiden ---
  if (req.method === 'POST') {
    let body;
    try { body = await req.json(); } catch { return json({ error: 'Ugyldig JSON' }, 400); }

    const id = 'o_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const mottatt = new Date().toISOString();

    // Lagre bilde (om det finnes som data-URL) og bygg en hentbar adresse
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
    };
    await store.setJSON('ordre/' + id, ordre);
    return json({ ok: true, id });
  }

  return json({ error: 'Metoden støttes ikke' }, 405);
};
