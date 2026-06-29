// netlify/functions/buscar-portada.js v10
const https = require('https');
const http = require('http');

function fetchUrl(url, timeout = 4500) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
      }
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(next, timeout).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

function toSlug(s) {
  return s.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
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

function extraerImg(html) {
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og?.[1] && !og[1].match(/logo|icon|cropped|banner/i)) return og[1];
  const pats = [
    /src=["'](https?:\/\/[^"']+wp-content\/uploads\/[^"']+?(?:420|600|800|portada|cover)[^"']*?\.(?:jpg|jpeg|png|webp))/i,
    /src=["'](https?:\/\/[^"']+wp-content\/uploads\/\d{4}\/\d{2}\/[^"'\s]{4,60}\.(?:jpg|jpeg|png|webp))/i,
    /data-src=["'](https?:\/\/[^"']+wp-content\/uploads\/[^"']+\.(?:jpg|jpeg|png|webp))/i,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m?.[1] && !m[1].match(/logo|icon|avatar|cropped|75x|110x|150x/i)) return m[1];
  }
  return null;
}

// Extraer links de series válidos de una página de búsqueda
function extraerSerieLinks(html, baseUrl) {
  // Regex estricto: solo slugs que parecen títulos (letras, números, guiones, mínimo 5 chars)
  // Excluir: feed, page, categoria, genero, tag, author, capitulo, chapter
  const escaped = baseUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`href=["'](${escaped}[a-z0-9][a-z0-9-]{3,}[a-z0-9])["']`, 'g');
  return [...html.matchAll(regex)]
    .map(m => m[1])
    .filter((v, i, a) => {
      if (a.indexOf(v) !== i) return false; // duplicados
      const path = v.replace(baseUrl, '');
      // Excluir paths que son secciones del sitio, no series
      if (path.match(/^(feed|page|category|genero|tag|author|capitulo|chapter|wp-|ajax)/)) return false;
      return true;
    });
}

// ─── MANGACRAB ───────────────────────────────────────────────
async function scrapeMangaCrab(nombre) {
  const slug = toSlug(nombre);

  // 1. URL directa (instantánea si existe)
  try {
    const r = await fetchUrl(`https://mangacrab.org/series/${slug}/`, 4000);
    if (r.status === 200) {
      const img = extraerImg(r.body);
      if (img) { console.log(`[MangaCrab] Directo: ${img}`); return [img]; }
    }
  } catch(e) {}

  // 2. Búsqueda con filtro estricto
  try {
    const busq = await fetchUrl(`https://mangacrab.org/series/?s=${encodeURIComponent(nombre)}`, 4000);
    if (busq.status !== 200) return [];

    const links = extraerSerieLinks(busq.body, 'https://mangacrab.org/series/');
    console.log(`[MangaCrab] Links válidos: ${links.length} → ${links.slice(0,3).join(' | ')}`);

    // Rankear por similitud y tomar solo el mejor
    const ranked = links
      .map(link => ({ link, s: sim(nombre, link.replace('https://mangacrab.org/series/', '').replace(/-/g, ' ')) }))
      .filter(x => x.s > 0.2)
      .sort((a, b) => b.s - a.s)
      .slice(0, 1); // solo el más similar para ahorrar tiempo

    const imgs = [];
    for (const { link, s } of ranked) {
      try {
        const p = await fetchUrl(link, 4000);
        if (p.status === 200) {
          const img = extraerImg(p.body);
          if (img) { console.log(`[MangaCrab] Búsqueda (sim:${s.toFixed(2)}): ${img}`); imgs.push(img); }
        }
      } catch(e) {}
    }
    return imgs;
  } catch(e) { return []; }
}

// ─── MHS SCANS ───────────────────────────────────────────────
async function scrapeMHS(nombre) {
  const slug = toSlug(nombre);

  // 1. URL directa
  try {
    const r = await fetchUrl(`https://mhscans.com/series/${slug}/`, 4000);
    if (r.status === 200) {
      const img = extraerImg(r.body);
      if (img) { console.log(`[MHS] Directo: ${img}`); return [img]; }
    }
  } catch(e) {}

  // 2. Búsqueda — solo tomar el primer resultado más similar
  try {
    const busq = await fetchUrl(`https://mhscans.com/?s=${encodeURIComponent(nombre)}&post_type=wp-manga`, 4000);
    if (busq.status !== 200) return [];

    const links = extraerSerieLinks(busq.body, 'https://mhscans.com/series/');
    console.log(`[MHS] Links válidos: ${links.length}`);

    const ranked = links
      .map(link => ({ link, s: sim(nombre, link.replace('https://mhscans.com/series/', '').replace(/-/g, ' ')) }))
      .filter(x => x.s > 0.2)
      .sort((a, b) => b.s - a.s)
      .slice(0, 1);

    const imgs = [];
    for (const { link, s } of ranked) {
      try {
        const p = await fetchUrl(link, 4000);
        if (p.status === 200) {
          const img = extraerImg(p.body);
          if (img) { console.log(`[MHS] Búsqueda (sim:${s.toFixed(2)}): ${img}`); imgs.push(img); }
        }
      } catch(e) {}
    }
    return imgs;
  } catch(e) { return []; }
}

// ─── OLYMPUS ─────────────────────────────────────────────────
// Olympus ignora el parámetro search — devuelve todas las series en orden alfabético
// Hay que descargar el catálogo completo y buscar por similitud de título
async function scrapeOlympus(nombre) {
  try {
    const catalogo = await fetchUrl('https://olympusxyz.com/series', 5000);
    if (catalogo.status !== 200) return [];

    // Extraer todos los links de series y los títulos del catálogo
    // La estructura de Olympus tiene los títulos en <em> o en texto plano cerca del link
    const linksRaw = [...catalogo.body.matchAll(/href=["'](https:\/\/olympusxyz\.com\/series\/[^"'?#\s]+)["']/g)]
      .map(m => m[1].replace(/\/$/, ''))
      .filter((v, i, a) => a.indexOf(v) === i && v !== 'https://olympusxyz.com/series');

    // Para cada link, extraer el título del contexto cercano (100 chars después del href)
    const series = [];
    for (const link of linksRaw) {
      const idx = catalogo.body.indexOf(link);
      if (idx === -1) continue;
      // Buscar texto en los ~300 chars siguientes al link
      const chunk = catalogo.body.slice(idx, idx + 300);
      // Extraer texto de <em> o texto plano entre tags
      const emMatch = chunk.match(/<em>([^<]{3,})<\/em>/);
      const txtMatch = chunk.match(/>([A-ZÁÉÍÓÚáéíóúÑñ][^<]{2,50})</);
      const titulo = (emMatch?.[1] || txtMatch?.[1] || '').trim();
      if (titulo.length > 2) series.push({ link, titulo });
    }

    console.log(`[Olympus] Catálogo: ${series.length} series`);

    if (!series.length) return [];

    // Buscar las más similares al nombre
    const ranked = series
      .map(x => ({ ...x, s: sim(nombre, x.titulo) }))
      .filter(x => x.s > 0.3)
      .sort((a, b) => b.s - a.s)
      .slice(0, 2);

    console.log(`[Olympus] Mejores matches: ${ranked.map(x => `"${x.titulo}" (${x.s.toFixed(2)})`).join(' | ')}`);

    if (!ranked.length) return [];

    // Entrar a cada serie y sacar la portada del og:image
    const imgs = [];
    await Promise.all(ranked.map(async ({ link, titulo, s }) => {
      try {
        const p = await fetchUrl(link, 4500);
        if (p.status === 200) {
          const og = p.body.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
                  || p.body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
          const img = og?.[1] || p.body.match(/["'](https:\/\/media\.imagesolymp\.xyz\/[^"'\s]+\.(?:webp|jpg|jpeg|png))/)?.[1];
          if (img && !imgs.includes(img)) {
            console.log(`[Olympus] "${titulo}" (sim:${s.toFixed(2)}): ${img}`);
            imgs.push(img);
          }
        }
      } catch(e) {}
    }));
    return imgs;
  } catch(e) { console.log(`[Olympus] Error: ${e.message}`); return []; }
}

// ─── HANDLER ─────────────────────────────────────────────────
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const nombre = event.queryStringParameters?.nombre?.trim();
  if (!nombre) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Falta nombre' }) };

  console.log(`[buscar-portada] "${nombre}" → slug: "${toSlug(nombre)}"`);

  const [resCrab, resMHS, resOlympus] = await Promise.all([
    scrapeMangaCrab(nombre),
    scrapeMHS(nombre),
    scrapeOlympus(nombre),
  ]);

  console.log(`Crab:${resCrab.length} MHS:${resMHS.length} Olympus:${resOlympus.length}`);

  const opciones = [...new Set([...resCrab, ...resMHS, ...resOlympus])].slice(0, 5);

  if (!opciones.length) {
    return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Sin resultados', opciones: [] }) };
  }

  return {
    statusCode: 200,
    headers: cors,
    body: JSON.stringify({ opciones, cached: false, fuente: 'scraping', total: opciones.length })
  };
};
