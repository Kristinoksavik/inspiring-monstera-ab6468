// netlify/functions/pexels.js
// Proxy for Pexels-bildesøk. Holder API-nøkkelen skjult server-side.
//
// OPPSETT (gjøres én gang):
//   Netlify → Site settings → Environment variables → Add variable
//     Key:   PEXELS_API_KEY
//     Value: <din Pexels-nøkkel fra pexels.com/api>
//   Deploy på nytt så funksjonen får nøkkelen.
//
// Klienten (index.html) kaller /.netlify/functions/pexels?query=...&per_page=12
// UTEN nøkkel. Denne funksjonen legger nøkkelen på og videresender til Pexels.

exports.handler = async (event) => {
  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    return json(500, { error: 'missing_key' });
  }

  const params = (event && event.queryStringParameters) || {};
  const query = (params.query || '').trim();
  if (!query) {
    return json(400, { error: 'missing_query' });
  }

  // Begrens per_page til et fornuftig tak.
  const perPage = Math.min(Math.max(parseInt(params.per_page, 10) || 12, 1), 30);

  const url = 'https://api.pexels.com/v1/search'
    + '?query=' + encodeURIComponent(query)
    + '&per_page=' + perPage;

  try {
    const resp = await fetch(url, { headers: { Authorization: key } });

    if (resp.status === 429) {
      return json(429, { error: 'rate_limited' });
    }
    if (!resp.ok) {
      return json(resp.status, { error: 'pexels_error' });
    }

    const data = await resp.json();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json',
        // La Netlify/CDN cache like søk en stund for å spare Pexels-kvoten.
        'Cache-Control': 'public, max-age=600'
      },
      body: JSON.stringify(data)
    };
  } catch (err) {
    console.error('Pexels-proxy feilet:', err);
    return json(502, { error: 'fetch_failed' });
  }
};

function json(statusCode, obj) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(obj)
  };
}
