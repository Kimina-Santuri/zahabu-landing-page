// Equipment inventory, served from inventory.zahabu.co.ke.
// The whole hostname sits behind one Cloudflare Access app (verified here too, fail-closed). Anyone Access lets in can
// view; only emails in EDITOR_EMAILS can add, edit, log checks or upload photos.
// Built by build.mjs, which writes the page files to dist/inventory-assets.js; wrangler bundles this file directly.
import { sanitizeJpeg, accessEmail } from './photos-worker.mjs';
import INVENTORY_ASSETS from './dist/inventory-assets.js';

export const CONDITIONS = ['working', 'needs-attention', 'in-repair', 'broken', 'retired'];
const LOG_KINDS = ['tested', 'maintained', 'repaired', 'note'];
const MAX_PHOTOS_PER_ITEM = 20;
const MAX_FULL_BYTES = 3 * 1024 * 1024;
const MAX_THUMB_BYTES = 600 * 1024;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const TEXT_FIELDS = {name:120, category:60, brand:60, model:80, serialNumber:80, assetTag:40, location:80, notes:2000};
const COLUMNS = {serialNumber:'serial_number', assetTag:'asset_tag', lastTested:'last_tested', lastMaintained:'last_maintained', checkEveryDays:'check_every_days'};

const ITEM_SELECT = `SELECT i.id, i.name, i.category, i.brand, i.model, i.serial_number AS serialNumber, i.asset_tag AS assetTag,
  i.quantity, i.location, i.condition, i.last_tested AS lastTested, i.last_maintained AS lastMaintained,
  i.check_every_days AS checkEveryDays, i.notes, i.cover_photo_id AS coverPhotoId, i.created_at AS createdAt,
  i.updated_at AS updatedAt, i.updated_by AS updatedBy,
  (SELECT COUNT(*) FROM inventory_photos p WHERE p.item_id = i.id) AS photoCount
  FROM inventory_items i`;

function json(value, status = 200) {
  return Response.json(value, {status, headers:{'Cache-Control':'no-store'}});
}

export function canEdit(email, env) {
  const address = String(email || '').toLowerCase();
  if (!address.includes('@')) return false;
  return (env.EDITOR_EMAILS || '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean)
    .some(entry => entry.startsWith('@') ? address.endsWith(entry) : address === entry);
}

function isValidDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Returns {item} with every field normalised, or {error}.
export function validateItem(body) {
  if (!body || typeof body !== 'object') return {error:'Expected an item.'};
  const item = {};
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    const raw = body[field] ?? '';
    if (typeof raw !== 'string') return {error:`${field} must be text.`};
    item[field] = field === 'notes' ? raw.trim() : raw.replace(/\s+/g, ' ').trim();
    if (item[field].length > max) return {error:`Keep ${field} under ${max} characters.`};
  }
  if (!item.name) return {error:'Give the item a name.'};

  const quantity = body.quantity ?? 1;
  if (!Number.isInteger(quantity) || quantity < 0 || quantity > 9999) return {error:'Quantity must be a whole number from 0 to 9999.'};
  item.quantity = quantity;

  item.condition = body.condition ?? 'working';
  if (!CONDITIONS.includes(item.condition)) return {error:'Choose a condition from the list.'};

  for (const field of ['lastTested', 'lastMaintained']) {
    const value = body[field] || null;
    if (value !== null && !isValidDate(value)) return {error:`${field} must be a date.`};
    item[field] = value;
  }

  const every = body.checkEveryDays ?? null;
  if (every !== null && (!Number.isInteger(every) || every < 1 || every > 3650)) return {error:'Check interval must be between 1 and 3650 days.'};
  item.checkEveryDays = every;
  return {item};
}

function photoUrls(id) {
  return {thumb:`/media/thumb/${id}.jpg`, full:`/media/full/${id}.jpg`};
}

function withCover(row) {
  return {...row, cover:row.coverPhotoId ? photoUrls(row.coverPhotoId).thumb : null};
}

async function addLog(env, itemId, kind, date, note, email) {
  await env.DB.prepare('INSERT INTO inventory_log (id, item_id, kind, date, note, done_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), itemId, kind, date, note, email, new Date().toISOString()).run();
}

const conditionLabel = value => value.replace('-', ' ').replace(/^./, char => char.toUpperCase());
const today = () => new Date().toISOString().slice(0, 10);

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

async function getItem(env, id) {
  return env.DB.prepare(`${ITEM_SELECT} WHERE i.id = ?`).bind(id).first();
}

// ---------- Handlers ----------

async function itemDetail(env, id) {
  const item = await getItem(env, id);
  if (!item) return json({error:'That item no longer exists.'}, 404);
  const photos = (await env.DB.prepare('SELECT id, width, height, created_at AS createdAt, created_by AS createdBy FROM inventory_photos WHERE item_id = ? ORDER BY created_at').bind(id).all()).results;
  const log = (await env.DB.prepare('SELECT id, kind, date, note, done_by AS doneBy, created_at AS createdAt FROM inventory_log WHERE item_id = ? ORDER BY date DESC, created_at DESC LIMIT 200').bind(id).all()).results;
  return json({item:withCover(item), photos:photos.map(photo => ({...photo, ...photoUrls(photo.id)})), log});
}

async function saveItem(request, env, email, id) {
  const {item, error} = validateItem(await readJson(request));
  if (error) return json({error}, 400);
  const now = new Date().toISOString();
  const fields = Object.keys(item);
  const columns = fields.map(field => COLUMNS[field] || field);

  if (!id) {
    id = crypto.randomUUID();
    await env.DB.prepare(`INSERT INTO inventory_items (id, ${columns.join(', ')}, created_at, updated_at, updated_by) VALUES (?, ${columns.map(() => '?').join(', ')}, ?, ?, ?)`)
      .bind(id, ...fields.map(field => item[field]), now, now, email).run();
    await addLog(env, id, 'created', today(), '', email);
    return json({item:withCover(await getItem(env, id))}, 201);
  }

  const existing = await env.DB.prepare('SELECT condition FROM inventory_items WHERE id = ?').bind(id).first();
  if (!existing) return json({error:'That item no longer exists.'}, 404);
  await env.DB.prepare(`UPDATE inventory_items SET ${columns.map(column => `${column} = ?`).join(', ')}, updated_at = ?, updated_by = ? WHERE id = ?`)
    .bind(...fields.map(field => item[field]), now, email, id).run();
  if (existing.condition !== item.condition) await addLog(env, id, 'condition', today(), `${conditionLabel(existing.condition)} → ${conditionLabel(item.condition)}`, email);
  return json({item:withCover(await getItem(env, id))});
}

async function deleteItem(env, id) {
  const {results:photos} = await env.DB.prepare('SELECT id FROM inventory_photos WHERE item_id = ?').bind(id).all();
  if (photos.length) await env.MEDIA.delete(photos.flatMap(photo => [`full/${photo.id}.jpg`, `thumb/${photo.id}.jpg`]));
  await env.DB.prepare('DELETE FROM inventory_photos WHERE item_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM inventory_log WHERE item_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM inventory_items WHERE id = ?').bind(id).run();
  return json({ok:true});
}

// Logging a test or maintenance job moves the item's "last" date forward (never back) and can update its condition.
async function logEntry(request, env, email, id) {
  const body = await readJson(request);
  if (!body || !LOG_KINDS.includes(body.kind)) return json({error:'Choose what was done.'}, 400);
  const date = body.date || today();
  if (!isValidDate(date) || date > today()) return json({error:'Use a date that isn\'t in the future.'}, 400);
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  if (note.length > 1000) return json({error:'Keep the note under 1000 characters.'}, 400);
  if (body.kind === 'note' && !note) return json({error:'Write a note.'}, 400);
  if (body.condition != null && !CONDITIONS.includes(body.condition)) return json({error:'Choose a condition from the list.'}, 400);

  const item = await env.DB.prepare('SELECT condition, last_tested, last_maintained FROM inventory_items WHERE id = ?').bind(id).first();
  if (!item) return json({error:'That item no longer exists.'}, 404);

  await addLog(env, id, body.kind, date, note, email);
  const updates = {};
  if (body.kind === 'tested' && (!item.last_tested || date > item.last_tested)) updates.last_tested = date;
  if (['maintained', 'repaired'].includes(body.kind) && (!item.last_maintained || date > item.last_maintained)) updates.last_maintained = date;
  if (body.condition && body.condition !== item.condition) {
    updates.condition = body.condition;
    await addLog(env, id, 'condition', date, `${conditionLabel(item.condition)} → ${conditionLabel(body.condition)}`, email);
  }
  const columns = Object.keys(updates);
  await env.DB.prepare(`UPDATE inventory_items SET ${columns.map(column => `${column} = ?, `).join('')}updated_at = ?, updated_by = ? WHERE id = ?`)
    .bind(...columns.map(column => updates[column]), new Date().toISOString(), email, id).run();
  return itemDetail(env, id);
}

async function uploadPhoto(request, env, email, id) {
  if (!request.headers.get('content-type')?.includes('multipart/form-data')) return json({error:'Expected a photo upload.'}, 415);
  if (Number(request.headers.get('content-length') || 0) > MAX_FULL_BYTES + MAX_THUMB_BYTES + 64 * 1024) return json({error:'That photo is too large.'}, 413);
  const item = await env.DB.prepare('SELECT cover_photo_id AS coverPhotoId FROM inventory_items WHERE id = ?').bind(id).first();
  if (!item) return json({error:'That item no longer exists.'}, 404);
  const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM inventory_photos WHERE item_id = ?').bind(id).first();
  if ((count?.n || 0) >= MAX_PHOTOS_PER_ITEM) return json({error:`An item can have up to ${MAX_PHOTOS_PER_ITEM} photos. Delete one first.`}, 400);

  let form;
  try { form = await request.formData(); } catch { return json({error:'Could not read the upload.'}, 400); }
  const full = form.get('full');
  const thumb = form.get('thumb');
  if (!(full instanceof File) || !(thumb instanceof File)) return json({error:'Each photo needs a full-size and preview image.'}, 400);
  if (full.size > MAX_FULL_BYTES || thumb.size > MAX_THUMB_BYTES) return json({error:'That photo is too large.'}, 413);
  const fullJpeg = sanitizeJpeg(new Uint8Array(await full.arrayBuffer()));
  const thumbJpeg = sanitizeJpeg(new Uint8Array(await thumb.arrayBuffer()));
  if (!fullJpeg || !thumbJpeg) return json({error:'Photos must be JPEG images.'}, 400);
  if (fullJpeg.width > 4000 || fullJpeg.height > 4000) return json({error:'That photo is too large.'}, 413);

  const photoId = crypto.randomUUID();
  const httpMetadata = {contentType:'image/jpeg'};
  await env.MEDIA.put(`full/${photoId}.jpg`, fullJpeg.bytes, {httpMetadata});
  await env.MEDIA.put(`thumb/${photoId}.jpg`, thumbJpeg.bytes, {httpMetadata});
  const now = new Date().toISOString();
  await env.DB.prepare('INSERT INTO inventory_photos (id, item_id, width, height, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(photoId, id, fullJpeg.width, fullJpeg.height, now, email).run();
  if (!item.coverPhotoId) await env.DB.prepare('UPDATE inventory_items SET cover_photo_id = ? WHERE id = ?').bind(photoId, id).run();
  return json({photo:{id:photoId, width:fullJpeg.width, height:fullJpeg.height, ...photoUrls(photoId)}}, 201);
}

async function photoAction(request, env, itemId, photoId) {
  const photo = await env.DB.prepare('SELECT id FROM inventory_photos WHERE id = ? AND item_id = ?').bind(photoId, itemId).first();
  if (!photo) return json({error:'That photo no longer exists.'}, 404);
  if (request.method === 'POST') {
    await env.DB.prepare('UPDATE inventory_items SET cover_photo_id = ? WHERE id = ?').bind(photoId, itemId).run();
    return json({ok:true});
  }
  await env.MEDIA.delete([`full/${photoId}.jpg`, `thumb/${photoId}.jpg`]);
  await env.DB.prepare('DELETE FROM inventory_photos WHERE id = ?').bind(photoId).run();
  await env.DB.prepare(`UPDATE inventory_items SET cover_photo_id = (SELECT id FROM inventory_photos WHERE item_id = ? ORDER BY created_at LIMIT 1)
    WHERE id = ? AND cover_photo_id = ?`).bind(itemId, itemId, photoId).run();
  return json({ok:true});
}

async function serveMedia(env, size, id) {
  const object = await env.MEDIA.get(`${size}/${id}.jpg`);
  if (!object) return new Response('Not found', {status:404});
  return new Response(object.body, {headers:{'Content-Type':'image/jpeg', 'X-Content-Type-Options':'nosniff', 'Cache-Control':'private, max-age=86400'}});
}

function servePage(url) {
  const asset = INVENTORY_ASSETS[url.pathname === '/' ? '/index.html' : url.pathname];
  if (!asset) return new Response('Not found', {status:404});
  return new Response(Uint8Array.from(atob(asset.data), char => char.charCodeAt(0)), {headers:{
    'Content-Type':asset.type,
    'X-Content-Type-Options':'nosniff',
    'Cache-Control':'no-cache',
    'X-Frame-Options':'DENY',
  }});
}

async function route(request, env, url, email) {
  const {method} = request;
  if (url.pathname === '/api/me' && method === 'GET') return json({email, canEdit:canEdit(email, env)});
  if (url.pathname === '/api/items' && method === 'GET') {
    const {results} = await env.DB.prepare(`${ITEM_SELECT} ORDER BY i.category COLLATE NOCASE, i.name COLLATE NOCASE`).all();
    return json({items:results.map(withCover)});
  }
  const mediaMatch = url.pathname.match(/^\/media\/(thumb|full)\/([0-9a-f-]{36})\.jpg$/);
  if (mediaMatch && method === 'GET') return serveMedia(env, mediaMatch[1], mediaMatch[2]);

  const itemMatch = url.pathname.match(/^\/api\/items\/([0-9a-f-]{36})(?:\/(log|photos)(?:\/([0-9a-f-]{36}))?)?$/);
  if (url.pathname !== '/api/items' && !itemMatch) return method === 'GET' ? servePage(url) : json({error:'Not found.'}, 404);
  const [, id, sub, subId] = itemMatch || [];
  if (id && !sub && method === 'GET') return itemDetail(env, id);

  // Everything below changes data.
  if (!canEdit(email, env)) return json({error:'You have view-only access. Ask a tech lead to add you as an editor.'}, 403);
  if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({error:'Request blocked.'}, 403);
  if (!id && method === 'POST') return saveItem(request, env, email, null);
  if (id && !sub && method === 'PUT') return saveItem(request, env, email, id);
  if (id && !sub && method === 'DELETE') return deleteItem(env, id);
  if (sub === 'log' && !subId && method === 'POST') return logEntry(request, env, email, id);
  if (sub === 'log' && subId && method === 'DELETE') {
    await env.DB.prepare('DELETE FROM inventory_log WHERE id = ? AND item_id = ?').bind(subId, id).run();
    return json({ok:true});
  }
  if (sub === 'photos' && !subId && method === 'POST') return uploadPhoto(request, env, email, id);
  if (sub === 'photos' && subId && ['POST', 'DELETE'].includes(method)) return photoAction(request, env, id, subId);
  return json({error:'Method not allowed.'}, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      const email = await accessEmail(request, env);
      if (!email) return new Response('Sign-in required.', {status:403});
      return await route(request, env, url, email);
    } catch (error) {
      console.error('Inventory error', error);
      return json({error:'Something went wrong. Please try again.'}, 503);
    }
  }
};
