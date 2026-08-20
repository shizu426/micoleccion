// src/worker.js
//
// Punto de entrada del Worker de Cloudflare. Cloudflare Workers usa un formato distinto
// al de las funciones de Netlify (acá se recibe un "request" y se responde con un "Response",
// en vez de exports.handler con event/callback).
//
// Rutas disponibles:
//   GET /lens-detect?imageUrl=<url-encodeada>   →  identifica la obra en la imagen via SerpApi/Google Lens
//   GET /tipo-detect?nombre=<nombre-encodeado>  →  identifica Manga/Manhwa/Manhua probando varias bases de datos

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function normalizar(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// --- Fuente 1: AniList (título romaji/inglés + verificación cruzada por escritura del nativo) ---
async function probarAniList(nombre) {
  try {
    const query = `query($s:String){Page(perPage:5){media(search:$s,type:MANGA,sort:SEARCH_MATCH){title{romaji english native}countryOfOrigin}}}`;
    const r = await fetch('https://graphql.anilist.co', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ query, variables: { s: nombre } }),
    });
    const d = await r.json();
    const lista = d?.data?.Page?.media;
    if (!lista?.length) return null;

    const objetivo = normalizar(nombre);
    let mejor = lista[0], mejorScore = -1;
    for (const m of lista) {
      const candidatos = [m.title?.romaji, m.title?.english].filter(Boolean).map(normalizar);
      const score = candidatos.some(c => c === objetivo) ? 2
        : candidatos.some(c => c.includes(objetivo) || objetivo.includes(c)) ? 1 : 0;
      if (score > mejorScore) { mejorScore = score; mejor = m; }
    }
    if (mejorScore === 0) return null;

    const pais = mejor.countryOfOrigin;
    const nativo = mejor.title?.native || '';
    const tieneHangul = /[\uAC00-\uD7A3]/.test(nativo);
    const tieneKana = /[\u3040-\u30FF]/.test(nativo);
    const tieneHanzi = /[\u4E00-\u9FFF]/.test(nativo);
    let porEscritura = tieneHangul ? 'Manhwa' : tieneKana ? 'Manga' : tieneHanzi ? 'Manhua' : null;
    let porPais = pais === 'JP' ? 'Manga' : pais === 'KR' ? 'Manhwa' : (pais === 'CN' || pais === 'TW') ? 'Manhua' : null;
    const tipo = porEscritura || porPais;
    if (!tipo) return null;
    const contradiccion = porEscritura && porPais && porEscritura !== porPais;
    const confianza = (mejorScore === 2 && !contradiccion) ? 'alta' : 'media';
    return { tipo, confianza, fuente: 'AniList', obra: mejor.title?.romaji || mejor.title?.english };
  } catch (e) { return null; }
}

// --- Fuente 2: MangaDex (guarda títulos alternativos en muchos idiomas, incluido español) ---
async function probarMangaDex(nombre) {
  try {
    const r = await fetch('https://api.mangadex.org/manga?title=' + encodeURIComponent(nombre) + '&limit=5&order[relevance]=desc');
    if (!r.ok) return null;
    const d = await r.json();
    const mejor = d?.data?.[0];
    if (!mejor) return null;
    const idioma = mejor.attributes?.originalLanguage;
    const tipo = idioma === 'ja' ? 'Manga' : idioma === 'ko' ? 'Manhwa' : (idioma === 'zh' || idioma === 'zh-hk') ? 'Manhua' : null;
    if (!tipo) return null;
    const obra = mejor.attributes?.title?.en || Object.values(mejor.attributes?.title || {})[0];
    return { tipo, confianza: 'media', fuente: 'MangaDex', obra };
  } catch (e) { return null; }
}

// --- Fuente 3: Jikan (API no oficial de MyAnimeList) ---
async function probarJikan(nombre) {
  try {
    const r = await fetch('https://api.jikan.moe/v4/manga?q=' + encodeURIComponent(nombre) + '&limit=5');
    if (!r.ok) return null;
    const d = await r.json();
    const lista = d?.data;
    if (!lista?.length) return null;
    const objetivo = normalizar(nombre);
    let mejor = null;
    for (const m of lista) {
      const candidatos = [m.title, m.title_english].filter(Boolean).map(normalizar);
      if (candidatos.some(c => c === objetivo || c.includes(objetivo) || objetivo.includes(c))) { mejor = m; break; }
    }
    if (!mejor) mejor = lista[0];
    // Jikan expone el "type": Manga | Manhwa | Manhua | Doujinshi | ... directamente
    const tipoRaw = (mejor.type || '').toLowerCase();
    let tipo = null;
    if (tipoRaw === 'manga') tipo = 'Manga';
    else if (tipoRaw === 'manhwa') tipo = 'Manhwa';
    else if (tipoRaw === 'manhua') tipo = 'Manhua';
    if (!tipo) return null;
    return { tipo, confianza: 'media', fuente: 'Jikan (MyAnimeList)', obra: mejor.title };
  } catch (e) { return null; }
}

// --- Fuente 4: Kitsu ---
async function probarKitsu(nombre) {
  try {
    const r = await fetch('https://kitsu.io/api/edge/manga?filter[text]=' + encodeURIComponent(nombre) + '&page[limit]=5');
    if (!r.ok) return null;
    const d = await r.json();
    const mejor = d?.data?.[0];
    if (!mejor) return null;
    const subtipo = (mejor.attributes?.subtype || '').toLowerCase(); // 'manga' | 'manhwa' | 'manhua' | 'novel' | ...
    let tipo = null;
    if (subtipo === 'manga') tipo = 'Manga';
    else if (subtipo === 'manhwa') tipo = 'Manhwa';
    else if (subtipo === 'manhua') tipo = 'Manhua';
    if (!tipo) return null;
    const obra = mejor.attributes?.canonicalTitle;
    return { tipo, confianza: 'media', fuente: 'Kitsu', obra };
  } catch (e) { return null; }
}

async function handleTipoDetect(request) {
  const url = new URL(request.url);
  const nombre = url.searchParams.get('nombre');
  if (!nombre) return json({ error: 'Falta el parámetro nombre' }, 400);

  const intentos = [
    { fn: probarAniList, nombre: 'AniList' },
    { fn: probarMangaDex, nombre: 'MangaDex' },
    { fn: probarJikan, nombre: 'Jikan' },
    { fn: probarKitsu, nombre: 'Kitsu' },
  ];
  const probados = [];
  for (const intento of intentos) {
    const res = await intento.fn(nombre);
    probados.push(intento.nombre + (res ? ` → ${res.tipo}` : ' → sin resultado'));
    if (res) {
      return json({ ...res, intentos: probados });
    }
  }
  return json({ tipo: null, intentos: probados });
}

async function handleLensDetect(request, env) {
  const url = new URL(request.url);
  const imageUrl = url.searchParams.get('imageUrl');
  if (!imageUrl) {
    return json({ error: 'Falta el parámetro imageUrl' }, 400);
  }

  const apiKey = env.SERPAPI_API_KEY;
  if (!apiKey) {
    return json({ error: 'SERPAPI_API_KEY no está configurada en las variables de entorno del Worker' }, 500);
  }

  try {
    const serpUrl =
      'https://serpapi.com/search.json?engine=google_lens&url=' +
      encodeURIComponent(imageUrl) +
      '&api_key=' +
      apiKey;

    const r = await fetch(serpUrl);
    if (!r.ok) {
      return json({ error: 'SerpApi respondió con error ' + r.status }, 502);
    }
    const data = await r.json();

    const matches = data.visual_matches || [];
    if (!matches.length) {
      return json({ titulo: null });
    }

    const limpiar = (t) => {
      if (!t) return null;
      let s = t;
      s = s.split(/\s[-–—|]\s/)[0];
      // Palabras de ruido en varios idiomas ("leer" / "read" / etc, nombres de sitios genéricos)
      s = s.replace(/\b(read|manga|manhwa|manhua|online|chapter|capitulo|cap\.?|free|leer|читать)\b/gi, '');
      s = s.replace(/\s{2,}/g, ' ').trim();
      return s.length >= 2 ? s : null;
    };

    // Tomamos varios candidatos (no solo los primeros 2), porque a veces el resultado mejor
    // rankeado por Google no está en el idioma que AniList indexa (inglés/romaji), pero alguno
    // de los siguientes resultados sí. El frontend los va a probar en orden hasta que uno funcione.
    const candidatos = matches
      .slice(0, 8)
      .map(m => limpiar(m.title))
      .filter(Boolean)
      // Descartamos los que tienen muy pocas letras latinas (probablemente ruso/coreano/chino/etc,
      // que casi seguro tampoco va a matchear en AniList) — mejor priorizar los que sí tienen chance.
      .sort((a, b) => {
        const latino = (s) => (s.match(/[a-zA-Z]/g) || []).length / Math.max(s.length, 1);
        return latino(b) - latino(a);
      });
    // Sacamos duplicados manteniendo el orden
    const unicos = [...new Set(candidatos)];

    return json({ titulo: unicos[0] || null, candidatos: unicos.slice(0, 6) });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response('', { status: 200, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === '/lens-detect') {
      return handleLensDetect(request, env);
    }
    if (url.pathname === '/tipo-detect') {
      return handleTipoDetect(request);
    }

    return json({ error: 'Ruta no encontrada' }, 404);
  },
};
