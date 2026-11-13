'use strict';

// RAFZ GET HTML backend. Only fetches publicly reachable HTTP(S) resources.
// It does not execute target-page JavaScript or bypass authentication/CAPTCHA/paywalls.
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');
const cheerio = require('cheerio');
const archiver = require('archiver');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ASSETS = 100;
const TIMEOUT_MS = 15000;

function isPublicIp(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) parsed = parsed.toIPv4Address();
    return parsed.range() === 'unicast';
  } catch (_) { return false; }
}

async function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch (_) { throw new Error('URL tidak valid.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Hanya URL HTTP/HTTPS yang didukung.');
  if (url.username || url.password) throw new Error('URL dengan kredensial tidak diizinkan.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('Alamat lokal tidak diizinkan.');
  }
  if (ipaddr.isValid(hostname)) {
    if (!isPublicIp(hostname)) throw new Error('Alamat IP privat atau khusus tidak diizinkan.');
  } else {
    let records;
    try { records = await dns.lookup(hostname, { all: true, verbatim: true }); }
    catch (_) { throw new Error('Domain tidak dapat ditemukan.'); }
    if (!records.length || records.some(r => !isPublicIp(r.address))) throw new Error('Domain mengarah ke alamat nonpublik dan diblokir.');
  }
  return url;
}

async function safeFetch(raw, maxBytes = MAX_PAGE_BYTES) {
  let current = raw;
  for (let hop = 0; hop <= 5; hop++) {
    const url = await validatePublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method: 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': 'RAFZ-Web-Extractor/1.0', 'Accept': '*/*' }
      });
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Waktu koneksi habis.');
      throw new Error('Tidak dapat mengakses alamat tujuan.');
    } finally { clearTimeout(timer); }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error('Redirect tidak memiliki tujuan.');
      current = new URL(location, url).href;
      continue;
    }
    if (!response.ok) throw new Error('Website merespons HTTP ' + response.status + '.');
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('Ukuran resource melewati batas.');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('Ukuran resource melewati batas.');
    return { url, response, buffer };
  }
  throw new Error('Terlalu banyak redirect.');
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
function safeName(url, contentType) {
  const extFromPath = path.extname(url.pathname).slice(0, 10).replace(/[^.a-zA-Z0-9]/g, '');
  const extFromType = ({
    'text/css': '.css', 'text/javascript': '.js', 'application/javascript': '.js',
    'image/svg+xml': '.svg', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp',
    'image/gif': '.gif', 'image/x-icon': '.ico', 'font/woff2': '.woff2', 'font/woff': '.woff',
    'video/mp4': '.mp4', 'audio/mpeg': '.mp3'
  })[String(contentType || '').split(';')[0].trim().toLowerCase()] || '.bin';
  return crypto.createHash('sha1').update(url.href).digest('hex').slice(0, 16) + (extFromPath || extFromType);
}
function contentTypeOf(response) { return response.headers.get('content-type') || ''; }

async function handleFetch(url, res) {
  const result = await safeFetch(url, MAX_PAGE_BYTES);
  const type = contentTypeOf(result.response);
  if (!/text\/html|application\/xhtml\+xml/i.test(type)) throw new Error('URL tujuan bukan dokumen HTML.');
  json(res, 200, { html: result.buffer.toString('utf8'), finalUrl: result.url.href, contentType: type });
}

async function handleExtract(url, req, res) {
  const page = await safeFetch(url, MAX_PAGE_BYTES);
  const pageType = contentTypeOf(page.response);
  if (!/text\/html|application\/xhtml\+xml/i.test(pageType)) throw new Error('URL tujuan bukan dokumen HTML.');
  const $ = cheerio.load(page.buffer.toString('utf8'));
  const baseHref = $('base[href]').first().attr('href');
  const baseUrl = baseHref ? new URL(baseHref, page.url) : page.url;
  const assets = new Map();
  let totalBytes = 0;
  let hasExternalResources = false;

  async function addAsset(raw, kind, resourceBase = baseUrl) {
    if (!raw || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(raw.trim())) return null;
    let absolute;
    try { absolute = new URL(raw, resourceBase); } catch (_) { return null; }
    if (!['http:', 'https:'].includes(absolute.protocol)) return null;
    hasExternalResources = true;
    if (assets.has(absolute.href)) return assets.get(absolute.href);
    if (assets.size >= MAX_ASSETS) return null;
    try {
      const fetched = await safeFetch(absolute.href, MAX_ASSET_BYTES);
      totalBytes += fetched.buffer.length;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Batas total aset tercapai.');
      const filename = safeName(fetched.url, contentTypeOf(fetched.response));
      const record = { filename, buffer: fetched.buffer, type: contentTypeOf(fetched.response), kind };
      assets.set(absolute.href, record);
      return record;
    } catch (error) {
      console.warn('Asset dilewati:', absolute.href, error.message);
      return null;
    }
  }

  // Collect common linked resources and rewrite successful references to local paths.
  const attrSpecs = [
    ['img[src]', 'src', 'images'], ['script[src]', 'src', 'scripts'],
    ['link[rel="stylesheet"][href]', 'href', 'styles'], ['link[rel="icon"][href]', 'href', 'icons'],
    ['link[rel="shortcut icon"][href]', 'href', 'icons'], ['source[src]', 'src', 'media'],
    ['video[poster]', 'poster', 'images'], ['video[src]', 'src', 'media'], ['audio[src]', 'src', 'media'],
    ['iframe[src]', 'src', 'documents']
  ];
  for (const [selector, attr, kind] of attrSpecs) {
    for (const el of $(selector).toArray()) {
      const raw = $(el).attr(attr); const asset = await addAsset(raw, kind);
      if (asset) $(el).attr(attr, 'assets/' + asset.filename);
    }
  }

  // Download resources referenced from inline style attributes and style blocks.
  const cssTextNodes = [];
  $('[style]').each((_, el) => cssTextNodes.push({ el, attr: 'style', text: $(el).attr('style') || '' }));
  $('style').each((_, el) => cssTextNodes.push({ el, attr: null, text: $(el).html() || '' }));
  for (const item of cssTextNodes) {
    const matches = [...item.text.matchAll(/url\((?:\s*['"]?)([^)'"]+)(?:['"]?\s*)\)/gi)];
    let updated = item.text;
    for (const match of matches) {
      const asset = await addAsset(match[1], 'assets');
      if (asset) updated = updated.replace(match[0], 'url("assets/' + asset.filename + '")');
    }
    if (item.attr) $(item.el).attr(item.attr, updated); else $(item.el).html(updated);
  }

  // Resolve url(...) references inside downloaded external CSS files as local ZIP assets.
  // A bounded one-level pass avoids unbounded recursive crawling of third-party stylesheets.
  for (const [sourceHref, record] of [...assets.entries()]) {
    if (!/text\/css/i.test(record.type) && !/\.css(?:$|[?#])/i.test(sourceHref)) continue;
    let css = record.buffer.toString('utf8');
    const cssUrl = new URL(sourceHref);
    const refs = [...css.matchAll(/url\((?:\s*['"]?)([^)'"\s]+)(?:['"]?\s*)\)/gi)];
    for (const ref of refs) {
      const child = await addAsset(ref[1], 'css-assets', cssUrl);
      if (child) css = css.replace(ref[0], 'url("' + child.filename + '")');
    }
    record.buffer = Buffer.from(css, 'utf8');
  }

  // Resolve relative navigation and form paths against the original page.
  $('a[href],form[action]').each((_, el) => {
    const attr = el.tagName === 'form' ? 'action' : 'href';
    const value = $(el).attr(attr);
    if (value && !/^(#|mailto:|tel:|javascript:)/i.test(value)) {
      try { $(el).attr(attr, new URL(value, page.url).href); } catch (_) {}
    }
  });
  $('base').remove();
  const html = $.html();

  // If no external assets were collected, return a standalone HTML download.
  if (assets.size === 0 && !hasExternalResources) {
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': 'attachment; filename=\"website.html\"',
      'Cache-Control': 'no-store'
    });
    res.end(html);
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': 'attachment; filename="website-extract.zip"',
    'Cache-Control': 'no-store'
  });
  const zip = archiver('zip', { zlib: { level: 8 } });
  zip.on('warning', err => console.warn('ZIP warning:', err.message));
  zip.on('error', err => { console.error('ZIP error:', err); if (!res.headersSent) res.writeHead(500); res.end(); });
  zip.pipe(res);
  zip.append(html, { name: 'index.html' });
  for (const asset of assets.values()) zip.append(asset.buffer, { name: 'assets/' + asset.filename });
  zip.append(
    'Hasil ekstraksi dari ' + page.url.href + '\n\n' +
    'index.html adalah salinan HTML statis. Aset yang berhasil diambil berada di folder assets/. ' +
    'Halaman yang bergantung pada login, CAPTCHA, paywall, API privat, atau JavaScript runtime mungkin tidak berfungsi sama persis.\n',
    { name: 'README-EXTRACT.txt' }
  );
  await zip.finalize();
}

module.exports = { handleFetch, handleExtract, json };
