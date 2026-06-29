// netlify/functions/olympus-proxy.js
const https = require('https');
const zlib = require('zlib');

function fetchUrl(url, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/html, */*',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://olympusxyz.com/',
        ...extraHeaders
      }
    }, (res) => {
      let stream = res;
      const enc = res.headers['content-encoding'];
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on('data', c => chunks.push(c));
      stream.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      stream.on('error', reject);
    });
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function norm(s) {
  return s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9\s]/g, '').trim();
}
function sim(a, b) {
  const na = norm(a), nb = norm(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.9;
  const wa = new Set(na.split(/\s+/)), wb = new Set(nb.split(/\s+/));
  const comunes = [...wa].filter(w => wb.has(w)).length;
  return comunes / Math.max(wa.size, wb.size);
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const nombre = event.queryStringParameters?.nombre?.trim();

  try {
    const r = await fetchUrl('https://olympusxyz.com/api/series/list');
    if (r.status !== 200) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ error: `API status ${r.status}`, series: [] }) };
    }

    const data = JSON.parse(r.body);
    const series = data.data || data.series || data || [];
    console.log(`[olympus-proxy] Total series: ${series.length}`);

    if (nombre && series.length) {
      const ranked = series
        .map(s => ({ ...s, score: sim(nombre, s.name || s.title || '') }))
        .filter(s => s.score > 0.3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);

      console.log(`[olympus-proxy] Matches para "${nombre}": ${ranked.map(s => `"${s.name}" (${s.score.toFixed(2)})`).join(' | ')}`);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ series: ranked, total: ranked.length }) };
    }

    return { statusCode: 200, headers: cors, body: JSON.stringify({ series, total: series.length }) };
  } catch(e) {
    console.log(`[olympus-proxy] Error: ${e.message}`);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ error: e.message, series: [] }) };
  }
};
