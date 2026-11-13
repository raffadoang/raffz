use strict';
const { handleExtract, json } = require('../lib/extractor');
module.exports = async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { error: 'Method tidak diizinkan.' });
  const target = new URL(req.url, 'https://vercel.invalid').searchParams.get('url');
  if (!target) return json(res, 400, { error: 'Parameter url wajib diisi.' });
  try { await handleExtract(target, req, res); }
  catch (error) { if (!res.headersSent) json(res, 400, { error: error.message || 'Permintaan gagal.' }); else res.destroy(); }
};
