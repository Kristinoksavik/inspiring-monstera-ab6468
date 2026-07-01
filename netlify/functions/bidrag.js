// netlify/functions/bidrag.js
// Henter innsendte konkurransebidrag fra Netlify Forms.
// Token ligger som miljøvariabel (NETLIFY_TOKEN) i Netlify — ALDRI i klienten.
//
// Sikkerhet: krev en delt hemmelighet (ADMIN_KODE) fra panelet, slik at ikke
// hvem som helst kan kalle funksjonen og lese e-postadresser.

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, X-Admin-Kode",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }

  const TOKEN = process.env.NETLIFY_TOKEN;
  const ADMIN = process.env.ADMIN_KODE;
  const FORM_NAME = process.env.FORM_NAME || "fotomaleri-konkurranse";

  if (!TOKEN) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "NETLIFY_TOKEN mangler i miljøvariabler." }) };
  }

  // Enkel adgangskontroll
  const gitt = event.headers["x-admin-kode"] || event.headers["X-Admin-Kode"];
  if (ADMIN && gitt !== ADMIN) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "Feil adminkode." }) };
  }

  // --- Bilde-henter ---
  // Panelet kan ikke hente cloudfront-bildet direkte (CORS på file://).
  // Kall ?bilde=<url> så henter funksjonen det og gir base64 tilbake.
  const bildeUrl = event.queryStringParameters && event.queryStringParameters.bilde;
  if (bildeUrl) {
    try {
      // Bare tillat Netlify sine egne bilde-verter (trygghet)
      if (!/^https:\/\/[a-z0-9.-]*cloudfront\.net\//i.test(bildeUrl) &&
          !/^https:\/\/[a-z0-9.-]*netlify\./i.test(bildeUrl)) {
        return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Ugyldig bilde-adresse." }) };
      }
      const r = await fetch(bildeUrl);
      if (!r.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Fikk ikke hentet bildet (" + r.status + ")." }) };
      let media = r.headers.get("content-type") || "image/jpeg";
      if (!/^image\/(jpeg|png|gif|webp)$/.test(media)) media = "image/jpeg";
      const buf = Buffer.from(await r.arrayBuffer());
      const data = buf.toString("base64");
      return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ media, data }) };
    } catch (e) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Bildehenting feilet: " + String(e.message || e) }) };
    }
  }

  // --- Analyse (POST) ---
  // Panelet POSTer {bilde:<url>, prompt:<tekst>}. Funksjonen henter bildet,
  // kaller Anthropic med sin egen nøkkel (ANTHROPIC_API_KEY), og gir tekst tilbake.
  if (event.httpMethod === "POST") {
    const KEY = process.env.ANTHROPIC_API_KEY;
    if (!KEY) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "ANTHROPIC_API_KEY mangler i miljøvariabler." }) };
    }
    let inn;
    try { inn = JSON.parse(event.body || "{}"); }
    catch (_) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Ugyldig forespørsel." }) }; }

    const bUrl = inn.bilde;
    const prompt = inn.prompt;
    if (!bUrl || !prompt) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Mangler bilde eller prompt." }) };
    }
    if (!/^https:\/\/[a-z0-9.-]*cloudfront\.net\//i.test(bUrl) &&
        !/^https:\/\/[a-z0-9.-]*netlify\./i.test(bUrl)) {
      return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "Ugyldig bilde-adresse." }) };
    }

    try {
      // Hent bildet
      const ir = await fetch(bUrl);
      if (!ir.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Fikk ikke hentet bildet (" + ir.status + ")." }) };
      let media = ir.headers.get("content-type") || "image/jpeg";
      if (!/^image\/(jpeg|png|gif|webp)$/.test(media)) media = "image/jpeg";
      const bilde64 = Buffer.from(await ir.arrayBuffer()).toString("base64");

      // Kall Anthropic
      const ar = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: media, data: bilde64 } },
              { type: "text", text: prompt },
            ],
          }],
        }),
      });
      if (!ar.ok) {
        let m = "Analyse-tjenesten svarte " + ar.status;
        try { const e = await ar.json(); if (e.error && e.error.message) m = e.error.message; } catch (_) {}
        return { statusCode: 502, headers: cors, body: JSON.stringify({ error: m }) };
      }
      const ad = await ar.json();
      const tekst = (ad.content || []).filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();
      return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ tekst }) };
    } catch (e) {
      return { statusCode: 502, headers: cors, body: JSON.stringify({ error: "Analyse feilet: " + String(e.message || e) }) };
    }
  }

  const api = "https://api.netlify.com/api/v1";
  const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

  try {
    // Netlify gir funksjonen site-ID automatisk via miljøvariabelen SITE_ID.
    const siteId = process.env.SITE_ID;

    // 1) Hent skjemaer — først for DENNE siden (mest robust), ellers hele kontoen.
    let forms = null;
    let sisteStatus = null;

    if (siteId) {
      const r = await fetch(`${api}/sites/${siteId}/forms`, auth);
      sisteStatus = r.status;
      if (r.ok) forms = await r.json();
    }

    // Fallback: kontonivå-ruten
    if (!forms) {
      const r = await fetch(`${api}/forms`, auth);
      sisteStatus = r.status;
      if (r.ok) forms = await r.json();
    }

    if (!forms) {
      return {
        statusCode: 502,
        headers: cors,
        body: JSON.stringify({
          error: `Netlify svarte ${sisteStatus} da funksjonen spurte etter skjemaer. Dette skyldes nesten alltid at access-tokenet mangler tilgang. Lag et nytt token under User settings → Applications → Personal access tokens og oppdater NETLIFY_TOKEN.`,
        }),
      };
    }

    const form = forms.find((f) => f.name === FORM_NAME);
    if (!form) {
      const navn = forms.map((f) => f.name).join(", ") || "(ingen)";
      return {
        statusCode: 404,
        headers: cors,
        body: JSON.stringify({ error: `Fant ikke skjema "${FORM_NAME}". Skjemaer funksjonen ser: ${navn}. Sjekk at FORM_NAME stemmer med ett av navnene over.` }),
      };
    }

    // 2) Hent alle innsendinger for skjemaet (paginert, 100 om gangen)
    let side = 1;
    let alle = [];
    while (true) {
      const subRes = await fetch(`${api}/forms/${form.id}/submissions?per_page=100&page=${side}`, auth);
      if (!subRes.ok) throw new Error(`Netlify /submissions svarte ${subRes.status}`);
      const batch = await subRes.json();
      alle = alle.concat(batch);
      if (batch.length < 100) break;
      side++;
      if (side > 20) break; // sikkerhetstak: maks 2000
    }

    // 3) Normaliser til et rent format panelet forstår
    const bidrag = alle.map((s) => {
      const d = s.data || {};
      // Netlify legger filopplastinger i s.data.<feltnavn> som URL, eller i s.ordered_human_fields
      let bildeUrl = d.bilde || d.image || "";
      // Filopplastinger kan også ligge som objekt {url,...}
      if (bildeUrl && typeof bildeUrl === "object") bildeUrl = bildeUrl.url || "";
      return {
        id: s.id,
        navn: d.name || d.navn || "",
        epost: d.email || d.epost || "",
        kommentar: d.comment || d.kommentar || "",
        sprak: d.language || d.sprak || "",
        dato: d.composition_date || d.dato || "",
        filter: d.filter_used || d.filter || "",
        bildeUrl,
        mottatt: s.created_at,
      };
    });

    return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify({ bidrag }) };
  } catch (err) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: String(err.message || err) }) };
  }
};
