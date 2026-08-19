// src/worker.js
//
// Punto de entrada del Worker de Cloudflare. Cloudflare Workers usa un formato distinto
// al de las funciones de Netlify (acá se recibe un "request" y se responde con un "Response",
// en vez de exports.handler con event/callback).
//
// Rutas disponibles:
//   GET /lens-detect?imageUrl=<url-encodeada>   →  identifica la obra en la imagen via SerpApi/Google Lens

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Content-Type': 'application/json',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
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

    return json({ error: 'Ruta no encontrada' }, 404);
  },
};
