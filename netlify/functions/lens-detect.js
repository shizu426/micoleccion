// netlify/functions/lens-detect.js
//
// Recibe la URL de una portada ya encontrada (por Olympus, MHS, MangaCrab, etc.) y usa
// SerpApi (Google Lens) para identificar QUÉ OBRA es esa imagen — no decide el tipo
// (Manga/Manhwa/Manhua), solo devuelve el título con el que el frontend después busca
// el país de origen real en AniList.
//
// La API key vive únicamente acá, como variable de entorno de Netlify (SERPAPI_API_KEY),
// nunca en el frontend.
//
// Contrato esperado por el frontend (index.html → identificarConGoogleLens):
//   GET /.netlify/functions/lens-detect?imageUrl=<url-encodeada>
//   → 200 { "titulo": "Rise of the Mushroom King", "tituloAlt": "..." | null }
//   → 200 { "titulo": null }                     (si no encontró nada)
//   → 4xx/5xx { "error": "mensaje" }

exports.handler = async function (event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const imageUrl = event.queryStringParameters && event.queryStringParameters.imageUrl;
  if (!imageUrl) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Falta el parámetro imageUrl' }) };
  }

  const apiKey = process.env.SERPAPI_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'SERPAPI_API_KEY no está configurada en las variables de entorno de Netlify' }),
    };
  }

  try {
    const serpUrl =
      'https://serpapi.com/search.json?engine=google_lens&url=' +
      encodeURIComponent(imageUrl) +
      '&api_key=' +
      apiKey;

    const r = await fetch(serpUrl);
    if (!r.ok) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'SerpApi respondió con error ' + r.status }) };
    }
    const data = await r.json();

    // Google Lens (vía SerpApi) devuelve "visual_matches": páginas donde aparece
    // una imagen visualmente igual/parecida, cada una con su propio título.
    const matches = data.visual_matches || [];
    if (!matches.length) {
      return { statusCode: 200, headers, body: JSON.stringify({ titulo: null }) };
    }

    // Los títulos de estas páginas suelen venir con ruido tipo "Nombre - Read Manga Online - Sitio.com".
    // Recortamos ese ruido para quedarnos solo con el nombre de la obra.
    const limpiar = (t) => {
      if (!t) return null;
      let s = t;
      s = s.split(/\s[-–|]\s/)[0]; // corta en el primer separador " - " o " | "
      s = s.replace(/\b(read|manga|manhwa|manhua|online|chapter|capitulo|cap\.?|free)\b/gi, '');
      s = s.replace(/\s{2,}/g, ' ').trim();
      return s.length >= 2 ? s : null;
    };

    const titulo = limpiar(matches[0] && matches[0].title);
    const tituloAlt = matches[1] ? limpiar(matches[1].title) : null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ titulo: titulo || null, tituloAlt: tituloAlt || null }),
    };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
