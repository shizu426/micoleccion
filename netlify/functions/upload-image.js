// netlify/functions/upload-image.js
// Recibe imagen en base64 y la sube a ImgBB (hosting gratuito de imágenes)
// La API key de ImgBB es gratis y tiene 32MB por imagen

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Método no permitido' }) };

  try {
    const { image, nombre } = JSON.parse(event.body);
    if (!image) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Falta imagen' }) };

    const IMGBB_KEY = process.env.IMGBB_API_KEY;
    if (!IMGBB_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Sin clave de ImgBB' }) };

    // Subir a ImgBB
    const https = require('https');
    const formData = `image=${encodeURIComponent(image.replace(/^data:image\/\w+;base64,/, ''))}&name=${encodeURIComponent(nombre || 'cover')}`;

    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.imgbb.com',
        path: `/1/upload?key=${IMGBB_KEY}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(formData) }
      }, res => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      });
      req.on('error', reject);
      req.write(formData); req.end();
    });

    if (result.success) {
      return { statusCode: 200, headers: cors, body: JSON.stringify({ url: result.data.display_url, delete_url: result.data.delete_url }) };
    }
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Error subiendo imagen' }) };
  } catch(e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
