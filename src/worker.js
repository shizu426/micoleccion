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
      s = s.replace(/\b(read|manga|manhwa|manhua|online|chapter|capitulo|cap\.?|free)\b/gi, '');
      s = s.replace(/\s{2,}/g, ' ').trim();
      return s.length >= 2 ? s : null;
    };

    const titulo = limpiar(matches[0] && matches[0].title);
    const tituloAlt = matches[1] ? limpiar(matches[1].title) : null;

    return json({ titulo: titulo || null, tituloAlt: tituloAlt || null });
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
