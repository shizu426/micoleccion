// netlify/functions/portada-desde-url.js v2
// Extrae portada desde URL de MangaCrab, Olympus, MHS u otro sitio
// Detecta URLs de capítulos y redirige a la página de la serie
const https = require('https');
const http = require('http');

function fetchUrl(url, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
      }
    }, res => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, url).href;
        return fetchUrl(next, timeout).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), url }));
    });
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// Convertir URL de capítulo a URL de serie según el sitio
function urlDeSerie(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;

    // MangaCrab: /series/nombre-serie/capitulo-X/ → /series/nombre-serie/
    if (host.includes('mangacrab.org')) {
      const m = url.match(/(https:\/\/mangacrab\.org\/series\/[^/]+)\//);
      return m ? m[1] + '/' : url;
    }

    // MHS: /series/nombre-serie/capitulo-X/ → /series/nombre-serie/
    if (host.includes('mhscans.com')) {
      const m = url.match(/(https:\/\/mhscans\.com\/series\/[^/]+)\//);
      return m ? m[1] + '/' : url;
    }

    // Olympus: /capitulo/ID/slug → /series/slug
    if (host.includes('olympusxyz.com')) {
      const m = url.match(/\/capitulo\/\d+\/([^/]+)/);
      if (m) return `https://olympusxyz.com/series/${m[1]}`;
      // Si ya es /series/ dejarlo como está
      return url;
    }

    return url;
  } catch(e) { return url; }
}

function extraerPortada(html, baseUrl) {
  const host = baseUrl ? new URL(baseUrl).hostname : '';

  // Olympus usa su propio CDN
  if (host.includes('olympusxyz.com')) {
    const img = html.match(/["'](https:\/\/media\.imagesolymp\.xyz\/comics\/covers\/[^"'\s]+\.(?:webp|jpg|jpeg|png))/);
    if (img?.[1]) return img[1];
  }

  // og:image (más confiable para todos)
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (og?.[1] && !og[1].match(/logo|icon|cropped|banner/i)) return og[1];

  // twitter:image
  const tw = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
           || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
  if (tw?.[1] && !tw[1].match(/logo|icon/i)) return tw[1];

  // Imágenes de wp-content/uploads (MangaCrab, MHS)
  const pats = [
    /<img[^>]+(?:class|id)=["'][^"']*(?:cover|portada|thumb|poster|serie-img|book-img|manga-img)[^"']*["'][^>]*src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/i,
    /data-src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/i,
    /<img[^>]+src=["']([^"']+\/(?:cover|thumb|covers|thumbs|images\/manga)[^"']+\.(?:jpg|jpeg|png|webp)[^"']*)/i,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m?.[1]) {
      let u = m[1];
      if (u.startsWith('//')) u = 'https:' + u;
      else if (u.startsWith('/') && baseUrl) u = new URL(baseUrl).origin + u;
      if (u.startsWith('http') && !u.match(/logo|icon|avatar/i)) return u;
    }
  }
  return null;
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  let pageUrl = event.queryStringParameters?.url;
  if (!pageUrl || !pageUrl.startsWith('http')) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'URL inválida' }) };
  }

  // Convertir URL de capítulo a URL de serie
  const serieUrl = urlDeSerie(pageUrl);
  if (serieUrl !== pageUrl) {
    console.log(`[portada-desde-url] Redirigiendo capítulo → serie: ${serieUrl}`);
    pageUrl = serieUrl;
  }

  try {
    console.log(`[portada-desde-url] Scraping: ${pageUrl}`);
    const res = await fetchUrl(pageUrl);
    if (res.status !== 200) {
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: `Página devolvió status ${res.status}` }) };
    }

    const portada = extraerPortada(res.body, pageUrl);
    if (!portada) {
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'No se encontró portada en la página' }) };
    }

    console.log(`[portada-desde-url] Encontrada: ${portada}`);
    return { statusCode: 200, headers: cors, body: JSON.stringify({ imagen: portada, url: pageUrl }) };
  } catch(e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
