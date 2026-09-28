// Community photo submissions for zahabu.co.ke, served from photos.zahabu.co.ke.
// Public:  GET /api/photos (approved list), POST /api/photos (submit, held as pending), GET /media/{thumb|full}/<id>.jpg (approved only)
// Staff:   everything under /admin, gated by Cloudflare Access (verified here too, fail-closed)

const MAX_PHOTOS_PER_SUBMISSION = 5;
const MAX_FULL_BYTES = 3 * 1024 * 1024;
const MAX_THUMB_BYTES = 600 * 1024;
const MAX_UPLOADS_PER_IP_PER_HOUR = 15;
const MAX_PENDING = 300;
const ID_PATTERN = /^[0-9a-f-]{36}$/;

const encoder = new TextEncoder();

function json(value, status = 200, headers = {}) {
  return Response.json(value, {status, headers:{'Cache-Control':'no-store', ...headers}});
}

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean);
}

function corsHeaders(request, env) {
  const origin = request.headers.get('origin');
  return allowedOrigins(env).includes(origin) ? {'Access-Control-Allow-Origin':origin, 'Vary':'Origin'} : {'Vary':'Origin'};
}

// ---------- JPEG handling ----------

// Walks the JPEG segments, drops metadata (EXIF/XMP in APP1, IPTC in APP13, comments and other APPn),
// keeps JFIF (APP0), ICC colour profile (APP2) and Adobe (APP14), and reads the real dimensions from the SOF header.
export function sanitizeJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  const parts = [bytes.subarray(0, 2)];
  let i = 2;
  let width = 0;
  let height = 0;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xFF) return null;
    const marker = bytes[i + 1];
    if (marker === 0xFF) { i++; continue; }
    if (marker === 0xDA) {
      parts.push(bytes.subarray(i));
      if (!width || !height) return null;
      const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) { out.set(part, offset); offset += part.length; }
      return {bytes:out, width, height};
    }
    if ((marker >= 0xD0 && marker <= 0xD7) || marker === 0x01) { parts.push(bytes.subarray(i, i + 2)); i += 2; continue; }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2 || i + 2 + length > bytes.length) return null;
    const isFrameHeader = marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker);
    if (isFrameHeader && length >= 7) {
      height = (bytes[i + 5] << 8) | bytes[i + 6];
      width = (bytes[i + 7] << 8) | bytes[i + 8];
    }
    const isMetadata = marker === 0xFE || (marker >= 0xE1 && marker <= 0xEF && marker !== 0xE2 && marker !== 0xEE);
    if (!isMetadata) parts.push(bytes.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  return null;
}

// ---------- Spam protection ----------

async function verifyTurnstile(token, ip, env) {
  if (!env.TURNSTILE_SECRET || typeof token !== 'string' || !token || token.length > 2048) return false;
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const result = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {method:'POST', body})).json();
    return result.success === true;
  } catch {
    return false;
  }
}

async function hashIp(ip, env) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${env.IP_SALT || 'zahabu'}:${ip}`));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

// ---------- Cloudflare Access ----------

function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

let accessKeys = {fetchedAt:0, keys:[]};

async function accessEmail(request, env) {
  if (env.LOCAL_DEV) return 'preview@localhost';
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) return null;
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) return null;
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerPart)));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadPart)));
    if (Date.now() - accessKeys.fetchedAt > 3600_000 || !accessKeys.keys.some(key => key.kid === header.kid)) {
      const certs = await (await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`)).json();
      accessKeys = {fetchedAt:Date.now(), keys:certs.keys || []};
    }
    const jwk = accessKeys.keys.find(key => key.kid === header.kid);
    if (!jwk || header.alg !== 'RS256') return null;
    const key = await crypto.subtle.importKey('jwk', jwk, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(signaturePart), encoder.encode(`${headerPart}.${payloadPart}`));
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    const now = Date.now() / 1000;
    if (!valid || !audiences.includes(env.ACCESS_AUD) || payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}` || !(payload.exp > now)) return null;
    return typeof payload.email === 'string' ? payload.email : 'staff';
  } catch {
    return null;
  }
}

// ---------- Handlers ----------

function toPublicPhoto(row, origin) {
  return {
    id:row.id,
    credit:row.credit,
    width:row.width,
    height:row.height,
    thumb:`${origin}/media/thumb/${row.id}.jpg`,
    full:`${origin}/media/full/${row.id}.jpg`,
  };
}

async function listApproved(request, env, url) {
  const {results} = await env.DB.prepare("SELECT id, credit, width, height FROM community_photos WHERE status = 'approved' ORDER BY reviewed_at DESC LIMIT 60").all();
  return json({photos:results.map(row => toPublicPhoto(row, url.origin))}, 200, {...corsHeaders(request, env), 'Cache-Control':'public, max-age=60'});
}

async function submitPhotos(request, env, url) {
  const cors = corsHeaders(request, env);
  const origin = request.headers.get('origin');
  if (origin !== url.origin && !allowedOrigins(env).includes(origin)) return json({error:'Uploads are only accepted from zahabu.co.ke.'}, 403, cors);
  if (!request.headers.get('content-type')?.includes('multipart/form-data')) return json({error:'Expected a photo upload.'}, 415, cors);
  const declaredLength = Number(request.headers.get('content-length') || 0);
  if (declaredLength > MAX_PHOTOS_PER_SUBMISSION * (MAX_FULL_BYTES + MAX_THUMB_BYTES) + 64 * 1024) return json({error:'That upload is too large.'}, 413, cors);

  let form;
  try { form = await request.formData(); } catch { return json({error:'Could not read the upload.'}, 400, cors); }

  if (form.get('consent') !== 'yes') return json({error:'Please confirm you took these photos and have permission to share them.'}, 400, cors);
  const credit = String(form.get('credit') || '').replace(/\s+/g, ' ').trim();
  if (credit.length > 60) return json({error:'Keep the credit name under 60 characters.'}, 400, cors);

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await verifyTurnstile(form.get('cf-turnstile-response'), ip, env))) return json({error:'Spam check failed. Please try again.'}, 400, cors);

  const photos = [];
  for (let index = 0; index < MAX_PHOTOS_PER_SUBMISSION; index++) {
    const full = form.get(`full_${index}`);
    const thumb = form.get(`thumb_${index}`);
    if (!full && !thumb) break;
    if (!(full instanceof File) || !(thumb instanceof File)) return json({error:'Each photo needs a full-size and preview image.'}, 400, cors);
    if (full.size > MAX_FULL_BYTES || thumb.size > MAX_THUMB_BYTES) return json({error:'One of the photos is too large.'}, 413, cors);
    const fullJpeg = sanitizeJpeg(new Uint8Array(await full.arrayBuffer()));
    const thumbJpeg = sanitizeJpeg(new Uint8Array(await thumb.arrayBuffer()));
    if (!fullJpeg || !thumbJpeg) return json({error:'Photos must be JPEG images.'}, 400, cors);
    if (fullJpeg.width > 4000 || fullJpeg.height > 4000) return json({error:'One of the photos is too large.'}, 413, cors);
    photos.push({full:fullJpeg, thumb:thumbJpeg});
  }
  if (!photos.length) return json({error:'Choose at least one photo.'}, 400, cors);
  if (form.has(`full_${MAX_PHOTOS_PER_SUBMISSION}`)) return json({error:`You can share up to ${MAX_PHOTOS_PER_SUBMISSION} photos at a time.`}, 400, cors);

  const ipHash = await hashIp(ip, env);
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM community_photos WHERE ip_hash = ? AND created_at > ?').bind(ipHash, hourAgo).first();
  if ((recent?.n || 0) + photos.length > MAX_UPLOADS_PER_IP_PER_HOUR) return json({error:'You have shared a lot of photos in the last hour. Please try again later.'}, 429, cors);
  const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM community_photos WHERE status = 'pending'").first();
  if ((pending?.n || 0) + photos.length > MAX_PENDING) return json({error:'We have a lot of photos waiting for review. Please try again in a few days.'}, 503, cors);

  const now = new Date().toISOString();
  for (const photo of photos) {
    const id = crypto.randomUUID();
    const httpMetadata = {contentType:'image/jpeg'};
    await env.PHOTOS.put(`full/${id}.jpg`, photo.full.bytes, {httpMetadata});
    await env.PHOTOS.put(`thumb/${id}.jpg`, photo.thumb.bytes, {httpMetadata});
    await env.DB.prepare("INSERT INTO community_photos (id, status, credit, width, height, ip_hash, created_at) VALUES (?, 'pending', ?, ?, ?, ?, ?)")
      .bind(id, credit, photo.full.width, photo.full.height, ipHash, now).run();
  }
  return json({ok:true, received:photos.length}, 201, cors);
}

async function serveMedia(env, size, id, {requireApproved}) {
  if (!['thumb', 'full'].includes(size) || !ID_PATTERN.test(id)) return new Response('Not found', {status:404});
  if (requireApproved) {
    const row = await env.DB.prepare("SELECT id FROM community_photos WHERE id = ? AND status = 'approved'").bind(id).first();
    if (!row) return new Response('Not found', {status:404});
  }
  const object = await env.PHOTOS.get(`${size}/${id}.jpg`);
  if (!object) return new Response('Not found', {status:404});
  return new Response(object.body, {headers:{
    'Content-Type':'image/jpeg',
    'X-Content-Type-Options':'nosniff',
    'Cache-Control':requireApproved ? 'public, max-age=3600' : 'private, no-store',
    'Access-Control-Allow-Origin':'*',
  }});
}

async function handleAdmin(request, env, url) {
  const email = await accessEmail(request, env);
  if (!email) return new Response('Staff sign-in required.', {status:403});

  const mediaMatch = url.pathname.match(/^\/admin\/media\/(thumb|full)\/([0-9a-f-]{36})\.jpg$/);
  if (mediaMatch && request.method === 'GET') return serveMedia(env, mediaMatch[1], mediaMatch[2], {requireApproved:false});

  if (url.pathname === '/admin/api/photos' && request.method === 'GET') {
    const status = url.searchParams.get('status') === 'approved' ? 'approved' : 'pending';
    const order = status === 'approved' ? 'reviewed_at DESC' : 'created_at ASC';
    const {results} = await env.DB.prepare(`SELECT id, status, credit, width, height, created_at AS createdAt, reviewed_at AS reviewedAt, reviewed_by AS reviewedBy FROM community_photos WHERE status = ? ORDER BY ${order} LIMIT 200`).bind(status).all();
    return json({email, photos:results.map(row => ({...row, thumb:`/admin/media/thumb/${row.id}.jpg`, full:`/admin/media/full/${row.id}.jpg`}))});
  }

  const actionMatch = url.pathname.match(/^\/admin\/api\/photos\/([0-9a-f-]{36})(?:\/(approve|unpublish))?$/);
  if (actionMatch) {
    if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({error:'Request blocked.'}, 403);
    const [, id, action] = actionMatch;
    const row = await env.DB.prepare('SELECT id FROM community_photos WHERE id = ?').bind(id).first();
    if (!row) return json({error:'That photo no longer exists.'}, 404);
    const now = new Date().toISOString();
    if (request.method === 'POST' && action === 'approve') {
      await env.DB.prepare("UPDATE community_photos SET status = 'approved', reviewed_at = ?, reviewed_by = ? WHERE id = ?").bind(now, email, id).run();
      return json({ok:true});
    }
    if (request.method === 'POST' && action === 'unpublish') {
      await env.DB.prepare("UPDATE community_photos SET status = 'pending', reviewed_at = ?, reviewed_by = ? WHERE id = ?").bind(now, email, id).run();
      return json({ok:true});
    }
    if (request.method === 'DELETE' && !action) {
      await env.PHOTOS.delete([`full/${id}.jpg`, `thumb/${id}.jpg`]);
      await env.DB.prepare('DELETE FROM community_photos WHERE id = ?').bind(id).run();
      return json({ok:true});
    }
    return json({error:'Method not allowed.'}, 405);
  }

  if (request.method !== 'GET') return new Response('Method not allowed', {status:405});
  const assetPath = url.pathname === '/admin' || url.pathname === '/admin/' ? '/admin/index.html' : url.pathname;
  const asset = PHOTO_ASSETS[assetPath];
  if (!asset) return new Response('Not found', {status:404});
  return new Response(Uint8Array.from(atob(asset.data), char => char.charCodeAt(0)), {headers:{
    'Content-Type':asset.type,
    'X-Content-Type-Options':'nosniff',
    'Cache-Control':'no-cache',
    'X-Frame-Options':'DENY',
  }});
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return await handleAdmin(request, env, url);

      if (url.pathname === '/api/photos') {
        if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:{...corsHeaders(request, env), 'Access-Control-Allow-Methods':'GET, POST', 'Access-Control-Max-Age':'86400'}});
        if (request.method === 'GET') return await listApproved(request, env, url);
        if (request.method === 'POST') return await submitPhotos(request, env, url);
        return json({error:'Method not allowed.'}, 405);
      }

      const mediaMatch = url.pathname.match(/^\/media\/(thumb|full)\/([0-9a-f-]{36})\.jpg$/);
      if (mediaMatch && ['GET', 'HEAD'].includes(request.method)) return await serveMedia(env, mediaMatch[1], mediaMatch[2], {requireApproved:true});

      if (url.pathname === '/') return Response.redirect('https://zahabu.co.ke/#community', 302);
      return new Response('Not found', {status:404});
    } catch (error) {
      console.error('Community photos error', error);
      return json({error:'Something went wrong. Please try again.'}, 503, corsHeaders(request, env));
    }
  }
};
