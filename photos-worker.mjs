// Community photo submissions for zahabu.co.ke, served from photos.zahabu.co.ke.
// Public:  GET /api/photos (approved list), POST /api/photos (submit, held as pending), GET /media/{thumb|full}/<id>.jpg (approved only)
//          GET /api/contact (is the form ready?), POST /api/contact (contact form: saved to D1, emailed to info@zahabu.co.ke)
//          POST /api/vendors (vendor enquiry from vendors.html, up to 3 photos: saved to D1 + R2, emailed to info@zahabu.co.ke)
// Staff:   everything under /admin, gated by Cloudflare Access (verified here too, fail-closed):
//          /admin (photo review), /admin/messages (contact + vendor enquiries), /admin/vendors/<id> (one vendor enquiry)

const MAX_PHOTOS_PER_SUBMISSION = 5;
const MAX_FULL_BYTES = 3 * 1024 * 1024;
const MAX_THUMB_BYTES = 600 * 1024;
const MAX_UPLOADS_PER_IP_PER_HOUR = 15;
const MAX_PENDING = 300;
const ID_PATTERN = /^[0-9a-f-]{36}$/;
const CONTACT_REASONS = ['General enquiry', 'Booking / private event', 'Artist / performance', 'Press / media', 'Other'];
const CONTACT_MIN_WORDS = 25;
const CONTACT_MAX_WORDS = 100;
const CONTACT_MAX_CHARS = 1500;
const MAX_CONTACTS_PER_IP_PER_HOUR = 5;
// Keep these lists in sync with vendors.html.
const VENDOR_TYPES = ['Food & drink stall', 'Market stall', 'Sponsor / brand partner'];
const VENDOR_STALL_TYPES = ['Food & drink stall', 'Market stall'];
const VENDOR_NIGHTS = ['Tue: Textures / Interlude', 'Wed: Jirani', 'Thu: RnB Live', 'Fri: Zahabu Sundowner', 'Special events'];
const VENDOR_POWER = ['Yes', 'No', 'Not sure'];
const MAX_VENDOR_PHOTOS = 3;
const MAX_VENDOR_PHOTO_BYTES = 1536 * 1024;
const MAX_VENDORS_PER_IP_PER_HOUR = 5;

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
  if (!env.TURNSTILE_SECRET || typeof token !== 'string' || !token || token.length > 2048) {
    console.warn('Turnstile not attempted', JSON.stringify({hasSecret:!!env.TURNSTILE_SECRET, tokenType:typeof token, tokenLength:typeof token === 'string' ? token.length : null}));
    return false;
  }
  const body = new FormData();
  body.append('secret', env.TURNSTILE_SECRET);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);
  try {
    const result = await (await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {method:'POST', body})).json();
    // Error codes (e.g. invalid-input-secret, timeout-or-duplicate) show in `wrangler tail`; they hold nothing sensitive.
    if (result.success !== true) console.warn('Turnstile rejected', JSON.stringify({codes:result['error-codes'], hostname:result.hostname}));
    return result.success === true;
  } catch (error) {
    console.warn('Turnstile verify call failed', String(error));
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

export async function accessEmail(request, env) {
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
  // The landing page shows the newest 60; gallery.html asks for more with ?limit= (capped at 500).
  const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit'), 10) || 60, 1), 500);
  const {results} = await env.DB.prepare("SELECT id, credit, width, height FROM community_photos WHERE status = 'approved' ORDER BY reviewed_at DESC LIMIT ?").bind(limit).all();
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

// ---------- Contact form ----------

export const countWords = text => text.split(/\s+/).filter(Boolean).length;

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

// Returns {fields} or {error}. Single-line fields have newlines collapsed so nothing can reach the email headers.
function readContact(form) {
  const line = name => String(form.get(name) || '').replace(/\s+/g, ' ').trim();
  const fields = {
    name:line('name'),
    email:line('email'),
    phone:line('phone'),
    reason:line('reason'),
    eventDate:line('event_date'),
    message:String(form.get('message') || '').replace(/\r\n?/g, '\n').trim(),
  };
  if (!fields.name || fields.name.length > 100) return {error:'Please enter your name.'};
  if (fields.email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return {error:'Please enter a valid email address.'};
  if (fields.phone && !/^\+?[0-9 ()-]{7,20}$/.test(fields.phone)) return {error:'Please check the phone number.'};
  if (!CONTACT_REASONS.includes(fields.reason)) return {error:'Please choose what your message is about.'};
  if (fields.eventDate && !validDate(fields.eventDate)) return {error:'Please check the event date.'};
  if (fields.message.length > CONTACT_MAX_CHARS) return {error:'Your message is too long. Please shorten it a little.'};
  const words = countWords(fields.message);
  if (words < CONTACT_MIN_WORDS) return {error:`Please describe your request in at least ${CONTACT_MIN_WORDS} words.`};
  if (words > CONTACT_MAX_WORDS) return {error:`Please keep your request to ${CONTACT_MAX_WORDS} words or fewer.`};
  return {fields};
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[char]);

// ---------- Styled emails to info@ ----------
// Plain tables and inline styles, because email apps (Gmail, Outlook, Zoho, phones) ignore most CSS.
// Everything a visitor typed goes through escapeHtml. The plain-text version is still sent alongside.

const EMAIL_LOGO = 'https://zahabu.co.ke/images/logo-wordmark.png';
const EMAIL_FONT = "Futura, 'Century Gothic', 'Trebuchet MS', Arial, sans-serif";

// Kenyan numbers are usually typed as 07… or 01…; WhatsApp links need 2547… (same rule as messages.js).
export function whatsappNumber(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) digits = `254${digits.slice(1)}`;
  else if (/^[17]\d{8}$/.test(digits)) digits = `254${digits}`;
  return digits.length >= 9 ? digits : '';
}

function emailButton(label, href, primary = false) {
  const colours = primary ? 'background:#141814;color:#ffffff;border:1px solid #141814;' : 'background:#ffffff;color:#141814;border:1px solid #141814;';
  return `<a href="${escapeHtml(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:11px 20px;border-radius:999px;${colours}font-family:${EMAIL_FONT};font-size:12px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;">${escapeHtml(label)}</a>`;
}

function emailHtml({eyebrow, title, subtitle, tag, buttons, rows, message, extra = '', footer, origin}) {
  const detailRows = rows.map(([label, value, href]) => `<tr>
<td style="padding:7px 16px 7px 0;vertical-align:top;white-space:nowrap;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5f6a63;">${escapeHtml(label)}</td>
<td style="padding:7px 0;vertical-align:top;font-size:15px;color:#141814;word-break:break-word;">${href ? `<a href="${escapeHtml(href)}" style="color:#2f5d3a;">${escapeHtml(value)}</a>` : escapeHtml(value)}</td></tr>`).join('');
  const preheader = message.replace(/\s+/g, ' ').slice(0, 110);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#e9f0ea;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9f0ea;"><tr><td align="center" style="padding:28px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:18px;font-family:${EMAIL_FONT};color:#141814;">
<tr><td style="padding:26px 28px 0;"><img src="${EMAIL_LOGO}" width="112" alt="ZAHABU" style="display:block;width:112px;height:auto;border:0;font-size:20px;letter-spacing:3px;color:#141814;"></td></tr>
<tr><td style="padding:26px 28px 0;">
<p style="margin:0 0 10px;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#5f6a63;">${escapeHtml(eyebrow)}</p>
<h1 style="margin:0;font-size:26px;line-height:1.15;font-weight:normal;text-transform:uppercase;color:#141814;">${escapeHtml(title)}</h1>
${subtitle ? `<p style="margin:6px 0 0;font-size:16px;color:#3d4640;">${escapeHtml(subtitle)}</p>` : ''}
<p style="margin:14px 0 0;"><span style="display:inline-block;padding:4px 12px;border-radius:999px;background:${tag.vendor ? '#f4ead6;color:#7a5a1e' : '#e9f0ea;color:#2f5d3a'};font-size:11px;letter-spacing:2px;text-transform:uppercase;">${escapeHtml(tag.label)}</span></p>
</td></tr>
<tr><td style="padding:22px 28px 0;">${buttons.join('')}</td></tr>
<tr><td style="padding:14px 28px 0;"><table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="border-top:1px solid #dde3de;padding-top:8px;">${detailRows}</table></td></tr>
<tr><td style="padding:18px 28px 0;"><div style="padding:18px 20px;border-radius:12px;background:#f3f5f2;font-size:15px;line-height:1.65;color:#141814;">${escapeHtml(message).replace(/\n/g, '<br>')}</div></td></tr>
${extra}
<tr><td style="padding:26px 28px 28px;">
<p style="margin:0 0 14px;padding-top:18px;border-top:1px solid #dde3de;"><a href="${origin}/admin/messages" style="color:#2f5d3a;font-size:14px;">Open all website messages &rarr;</a></p>
<p style="margin:0;font-size:12px;line-height:1.6;color:#5f6a63;">${escapeHtml(footer)} Staff pages ask you to sign in with Zoho.</p>
</td></tr>
</table></td></tr></table></body></html>`;
}

function contactButtons(fields, subject) {
  const wa = whatsappNumber(fields.phone);
  return [
    emailButton(`Reply to ${fields.name.split(' ')[0]}`, `mailto:${fields.email}?subject=${encodeURIComponent(subject)}`, true),
    ...(wa ? [emailButton('WhatsApp', `https://wa.me/${wa}`)] : []),
  ];
}

export function contactEmail(fields, env, origin) {
  const rows = [
    ['Name', fields.name],
    ['Email', fields.email],
    ['Phone / WhatsApp', fields.phone || '-'],
    ['About', fields.reason],
    ['Event date', fields.eventDate || '-'],
  ];
  return {
    to:env.CONTACT_TO || 'info@zahabu.co.ke',
    from:{email:env.CONTACT_FROM, name:'Zahabu website'},
    replyTo:{email:fields.email, name:fields.name},
    subject:`Website enquiry: ${fields.reason} from ${fields.name}`.slice(0, 200),
    text:`${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\n${fields.message}\n\n--\nSent from the contact form on zahabu.co.ke. Reply to this email to answer ${fields.name} directly.\n${messagesLink(origin)}`,
    html:emailHtml({
      eyebrow:'New website enquiry',
      title:fields.name,
      tag:{label:fields.reason},
      buttons:contactButtons(fields, `Re: Your message to Zahabu (${fields.reason})`),
      rows:[
        ['Email', fields.email, `mailto:${fields.email}`],
        ...(fields.phone ? [['Phone / WhatsApp', fields.phone, `tel:${fields.phone.replace(/[^\d+]/g, '')}`]] : []),
        ['About', fields.reason],
        ...(fields.eventDate ? [['Event date', new Date(`${fields.eventDate}T00:00:00Z`).toLocaleDateString('en-GB', {weekday:'short', day:'numeric', month:'long', year:'numeric', timeZone:'UTC'})]] : []),
      ],
      message:fields.message,
      footer:`Sent from the contact form on zahabu.co.ke. Reply to this email to answer ${fields.name} directly.`,
      origin,
    }),
  };
}

// Footer line on every email to info@: the staff Messages page lists both forms with Mark done.
const messagesLink = origin => `All website messages (staff sign-in with Zoho): ${origin}/admin/messages\n`;

async function submitContact(request, env, url) {
  const cors = corsHeaders(request, env);
  const origin = request.headers.get('origin');
  if (origin !== url.origin && !allowedOrigins(env).includes(origin)) return json({error:'Messages are only accepted from zahabu.co.ke.'}, 403, cors);
  if (!env.CONTACT_EMAIL || !env.CONTACT_FROM) return json({error:'The contact form is not available right now. Please try again later.'}, 503, cors);
  if (Number(request.headers.get('content-length') || 0) > 64 * 1024) return json({error:'Your message is too long.'}, 413, cors);

  let form;
  try { form = await request.formData(); } catch { return json({error:'Could not read the form.'}, 400, cors); }
  // Hidden field that people never see; bots that fill it get a quiet "ok" and nothing is sent.
  if (String(form.get('website') || '')) return json({ok:true}, 201, cors);

  const {fields, error} = readContact(form);
  if (error) return json({error}, 400, cors);

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await verifyTurnstile(form.get('cf-turnstile-response'), ip, env))) return json({error:'Spam check failed. Please try again.'}, 400, cors);

  const ipHash = await hashIp(ip, env);
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM contact_messages WHERE ip_hash = ? AND created_at > ?').bind(ipHash, hourAgo).first();
  if ((recent?.n || 0) >= MAX_CONTACTS_PER_IP_PER_HOUR) return json({error:'You have sent several messages in the last hour. Please try again later.'}, 429, cors);

  // Saved before sending, so a message is never lost if the email fails.
  const id = crypto.randomUUID();
  await env.DB.prepare('INSERT INTO contact_messages (id, name, email, phone, reason, event_date, message, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, fields.name, fields.email, fields.phone, fields.reason, fields.eventDate || null, fields.message, ipHash, new Date().toISOString()).run();
  try {
    await env.CONTACT_EMAIL.send(contactEmail(fields, env, url.origin));
  } catch (sendError) {
    console.error('Contact email failed', JSON.stringify({id, code:sendError?.code, message:String(sendError?.message || sendError)}));
    await env.DB.prepare('UPDATE contact_messages SET email_error = ? WHERE id = ?').bind(String(sendError?.code || sendError?.message || 'send failed').slice(0, 200), id).run();
    return json({error:'We could not send your message right now. Please try again in a few minutes.'}, 502, cors);
  }
  await env.DB.prepare('UPDATE contact_messages SET emailed_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run();
  return json({ok:true}, 201, cors);
}

// ---------- Vendor enquiries (vendors.html) ----------

// Returns {fields} or {error}. Same header safety as readContact: single-line fields have newlines collapsed.
function readVendor(form) {
  const line = name => String(form.get(name) || '').replace(/\s+/g, ' ').trim();
  const fields = {
    type:line('vendor_type'),
    business:line('business'),
    name:line('name'),
    email:line('email'),
    phone:line('phone'),
    links:line('links'),
    nights:form.getAll('nights').map(String),
    power:line('power'),
    message:String(form.get('message') || '').replace(/\r\n?/g, '\n').trim(),
  };
  if (!VENDOR_TYPES.includes(fields.type)) return {error:'Please choose what kind of vendor you are.'};
  if (!fields.business || fields.business.length > 100) return {error:'Please enter your business or brand name.'};
  if (!fields.name || fields.name.length > 100) return {error:'Please enter your name.'};
  if (fields.email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email)) return {error:'Please enter a valid email address.'};
  if (!/^\+?[0-9 ()-]{7,20}$/.test(fields.phone)) return {error:'Please enter a phone or WhatsApp number we can reach you on.'};
  if (fields.links.length > 300) return {error:'Please shorten your links.'};
  if (fields.nights.some(night => !VENDOR_NIGHTS.includes(night)) || new Set(fields.nights).size !== fields.nights.length) return {error:'Please check the nights you picked.'};
  if (VENDOR_STALL_TYPES.includes(fields.type)) {
    if (!VENDOR_POWER.includes(fields.power)) return {error:'Please tell us if your stall needs electricity.'};
  } else {
    fields.power = '';
  }
  if (fields.message.length > CONTACT_MAX_CHARS) return {error:'Your description is too long. Please shorten it a little.'};
  const words = countWords(fields.message);
  if (words < CONTACT_MIN_WORDS) return {error:`Please tell us about your business in at least ${CONTACT_MIN_WORDS} words.`};
  if (words > CONTACT_MAX_WORDS) return {error:`Please keep the description to ${CONTACT_MAX_WORDS} words or fewer.`};
  return {fields};
}

export function vendorEmail(fields, id, photoCount, env, origin) {
  const rows = [
    ['Type', fields.type],
    ['Business', fields.business],
    ['Name', fields.name],
    ['Email', fields.email],
    ['Phone / WhatsApp', fields.phone],
    ['Links', fields.links || '-'],
    ['Nights', fields.nights.join(', ') || '-'],
    ...(fields.power ? [['Needs electricity', fields.power]] : []),
    ['Photos', photoCount ? `${photoCount} (see link below)` : 'none'],
  ];
  return {
    to:env.CONTACT_TO || 'info@zahabu.co.ke',
    from:{email:env.CONTACT_FROM, name:'Zahabu website'},
    replyTo:{email:fields.email, name:fields.name},
    subject:`Vendor: ${fields.type} - ${fields.business} (${fields.name})`.slice(0, 200),
    text:`${rows.map(([label, value]) => `${label}: ${value}`).join('\n')}\n\n${fields.message}\n\n`
      + `See this enquiry${photoCount ? ' and its photos' : ''} online (staff sign-in with Zoho): ${origin}/admin/vendors/${id}\n\n`
      + `--\nSent from the vendor form on zahabu.co.ke/vendors.html. Reply to this email to answer ${fields.name} directly.\n${messagesLink(origin)}`,
    html:emailHtml({
      eyebrow:'New vendor enquiry',
      title:fields.business,
      subtitle:fields.name,
      tag:{label:fields.type, vendor:true},
      buttons:[
        ...contactButtons(fields, `Re: Your vendor enquiry (${fields.business})`),
        emailButton(photoCount ? `View ${photoCount} photo${photoCount > 1 ? 's' : ''}` : 'View online', `${origin}/admin/vendors/${id}`),
      ],
      rows:[
        ['Email', fields.email, `mailto:${fields.email}`],
        ['Phone / WhatsApp', fields.phone, `tel:${fields.phone.replace(/[^\d+]/g, '')}`],
        ...(fields.links ? [['Links', fields.links]] : []),
        ...(fields.nights.length ? [['Nights', fields.nights.join(', ')]] : []),
        ...(fields.power ? [['Needs electricity', fields.power]] : []),
        ['Photos', photoCount ? `${photoCount} attached online` : 'None'],
      ],
      message:fields.message,
      footer:`Sent from the vendor form on zahabu.co.ke/vendors.html. Reply to this email to answer ${fields.name} directly.`,
      origin,
    }),
  };
}

async function submitVendor(request, env, url) {
  const cors = corsHeaders(request, env);
  const origin = request.headers.get('origin');
  if (origin !== url.origin && !allowedOrigins(env).includes(origin)) return json({error:'Enquiries are only accepted from zahabu.co.ke.'}, 403, cors);
  if (!env.CONTACT_EMAIL || !env.CONTACT_FROM) return json({error:'The vendor form is not available right now. Please try again later.'}, 503, cors);
  if (Number(request.headers.get('content-length') || 0) > MAX_VENDOR_PHOTOS * MAX_VENDOR_PHOTO_BYTES + 64 * 1024) return json({error:'That is too large to send. Try fewer or smaller photos.'}, 413, cors);

  let form;
  try { form = await request.formData(); } catch { return json({error:'Could not read the form.'}, 400, cors); }
  if (String(form.get('website') || '')) return json({ok:true}, 201, cors);

  const {fields, error} = readVendor(form);
  if (error) return json({error}, 400, cors);

  const photos = [];
  for (let index = 0; index < MAX_VENDOR_PHOTOS; index++) {
    const file = form.get(`photo_${index}`);
    if (!file) break;
    if (!(file instanceof File)) return json({error:'Could not read one of the photos.'}, 400, cors);
    if (file.size > MAX_VENDOR_PHOTO_BYTES) return json({error:'One of the photos is too large.'}, 413, cors);
    const jpeg = sanitizeJpeg(new Uint8Array(await file.arrayBuffer()));
    if (!jpeg) return json({error:'Photos must be JPEG images.'}, 400, cors);
    if (jpeg.width > 4000 || jpeg.height > 4000) return json({error:'One of the photos is too large.'}, 413, cors);
    photos.push(jpeg);
  }
  if (form.has(`photo_${MAX_VENDOR_PHOTOS}`)) return json({error:`You can add up to ${MAX_VENDOR_PHOTOS} photos.`}, 400, cors);

  const ip = request.headers.get('cf-connecting-ip') || '';
  if (!(await verifyTurnstile(form.get('cf-turnstile-response'), ip, env))) return json({error:'Spam check failed. Please try again.'}, 400, cors);

  const ipHash = await hashIp(ip, env);
  const hourAgo = new Date(Date.now() - 3600_000).toISOString();
  const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM vendor_enquiries WHERE ip_hash = ? AND created_at > ?').bind(ipHash, hourAgo).first();
  if ((recent?.n || 0) >= MAX_VENDORS_PER_IP_PER_HOUR) return json({error:'You have sent several enquiries in the last hour. Please try again later.'}, 429, cors);

  // Photos and the row are saved before sending, so an enquiry is never lost if the email fails.
  const id = crypto.randomUUID();
  for (const [index, photo] of photos.entries()) {
    await env.PHOTOS.put(`vendors/${id}/${index}.jpg`, photo.bytes, {httpMetadata:{contentType:'image/jpeg'}});
  }
  await env.DB.prepare('INSERT INTO vendor_enquiries (id, vendor_type, business, name, email, phone, links, nights, power, message, photo_count, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, fields.type, fields.business, fields.name, fields.email, fields.phone, fields.links, fields.nights.join(', '), fields.power, fields.message, photos.length, ipHash, new Date().toISOString()).run();
  try {
    await env.CONTACT_EMAIL.send(vendorEmail(fields, id, photos.length, env, url.origin));
  } catch (sendError) {
    console.error('Vendor email failed', JSON.stringify({id, code:sendError?.code, message:String(sendError?.message || sendError)}));
    await env.DB.prepare('UPDATE vendor_enquiries SET email_error = ? WHERE id = ?').bind(String(sendError?.code || sendError?.message || 'send failed').slice(0, 200), id).run();
    return json({error:'We could not send your enquiry right now. Please try again in a few minutes.'}, 502, cors);
  }
  await env.DB.prepare('UPDATE vendor_enquiries SET emailed_at = ? WHERE id = ?').bind(new Date().toISOString(), id).run();
  return json({ok:true}, 201, cors);
}


// Staff view of one enquiry, linked from its email. Plain server-rendered page: no scripts.
async function vendorPage(env, id) {
  const row = await env.DB.prepare('SELECT * FROM vendor_enquiries WHERE id = ?').bind(id).first();
  if (!row) return new Response('That enquiry no longer exists.', {status:404});
  const rows = [
    ['Type', row.vendor_type], ['Business', row.business], ['Name', row.name],
    ['Email', `<a href="mailto:${escapeHtml(row.email)}">${escapeHtml(row.email)}</a>`, true],
    ['Phone / WhatsApp', row.phone], ['Links', row.links || '-'], ['Nights', row.nights || '-'],
    ...(row.power ? [['Needs electricity', row.power]] : []),
    ['Received', new Date(row.created_at).toLocaleString('en-GB', {timeZone:'Africa/Nairobi', dateStyle:'medium', timeStyle:'short'})],
  ];
  const photos = Array.from({length:row.photo_count}, (_, n) => `<a href="/admin/vendor-media/${id}/${n}.jpg" target="_blank"><img src="/admin/vendor-media/${id}/${n}.jpg" alt="Photo ${n + 1}" loading="lazy"></a>`).join('');
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Vendor: ${escapeHtml(row.business)}</title>
<style>body{margin:0;padding:24px 16px 48px;font:16px/1.6 system-ui,sans-serif;color:#141814;background:#e9f0ea}main{max-width:760px;margin:0 auto;background:#fff;border-radius:18px;padding:clamp(20px,5vw,40px)}
h1{margin:0 0 4px;font-size:26px;font-weight:600}.eyebrow{font-size:12px;letter-spacing:.2em;text-transform:uppercase;color:#5f6a63}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 18px;margin:24px 0}
dt{color:#5f6a63}dd{margin:0;overflow-wrap:anywhere}p.msg{white-space:pre-wrap;border-top:1px solid #dde3de;padding-top:20px}.photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-top:24px}
.photos img{width:100%;border-radius:12px;display:block}a{color:#2f5d3a}@media(max-width:480px){dl{grid-template-columns:1fr}dt{margin-top:8px}}</style></head>
<body><main><p style="margin:0 0 16px;font-size:14px"><a href="/admin/messages">← All messages</a></p><span class="eyebrow">Vendor enquiry</span><h1>${escapeHtml(row.business)}</h1><dl>${rows.map(([label, value, raw]) => `<dt>${label}</dt><dd>${raw ? value : escapeHtml(value)}</dd>`).join('')}</dl>
<p class="msg">${escapeHtml(row.message)}</p>${photos ? `<div class="photos">${photos}</div>` : '<p>No photos were attached.</p>'}</main></body></html>`;
  return new Response(html, {headers:{
    'Content-Type':'text/html; charset=utf-8',
    'Content-Security-Policy':"default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Cache-Control':'private, no-store',
  }});
}

async function vendorMedia(env, id, index) {
  const object = await env.PHOTOS.get(`vendors/${id}/${index}.jpg`);
  if (!object) return new Response('Not found', {status:404});
  return new Response(object.body, {headers:{'Content-Type':'image/jpeg', 'X-Content-Type-Options':'nosniff', 'Cache-Control':'private, no-store'}});
}

// ---------- Staff Messages page (/admin/messages) ----------

const MESSAGE_TABLES = {contact:'contact_messages', vendor:'vendor_enquiries'};

async function listMessages(env, url) {
  const done = url.searchParams.get('status') === 'done';
  const where = done ? 'done_at IS NOT NULL' : 'done_at IS NULL';
  const order = done ? 'done_at DESC' : 'created_at DESC';
  const [{results:contacts}, {results:vendors}, openContacts, openVendors] = await Promise.all([
    env.DB.prepare(`SELECT * FROM contact_messages WHERE ${where} ORDER BY ${order} LIMIT 300`).all(),
    env.DB.prepare(`SELECT * FROM vendor_enquiries WHERE ${where} ORDER BY ${order} LIMIT 300`).all(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM contact_messages WHERE done_at IS NULL').first(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM vendor_enquiries WHERE done_at IS NULL').first(),
  ]);
  const common = row => ({id:row.id, name:row.name, email:row.email, phone:row.phone, message:row.message, createdAt:row.created_at,
    emailFailed:!row.emailed_at, doneAt:row.done_at, doneBy:row.done_by});
  const messages = [
    ...contacts.map(row => ({...common(row), kind:'contact', category:row.reason, eventDate:row.event_date})),
    ...vendors.map(row => ({...common(row), kind:'vendor', category:row.vendor_type, business:row.business, links:row.links, nights:row.nights, power:row.power,
      photos:Array.from({length:row.photo_count}, (_, n) => `/admin/vendor-media/${row.id}/${n}.jpg`)})),
  ].sort((a, b) => (done ? b.doneAt.localeCompare(a.doneAt) : b.createdAt.localeCompare(a.createdAt)));
  return {messages, open:{contact:openContacts?.n || 0, vendor:openVendors?.n || 0}};
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

  const vendorMatch = url.pathname.match(/^\/admin\/vendors\/([0-9a-f-]{36})$/);
  if (vendorMatch && request.method === 'GET') return vendorPage(env, vendorMatch[1]);
  const vendorMediaMatch = url.pathname.match(/^\/admin\/vendor-media\/([0-9a-f-]{36})\/([0-2])\.jpg$/);
  if (vendorMediaMatch && request.method === 'GET') return vendorMedia(env, vendorMediaMatch[1], vendorMediaMatch[2]);

  if (url.pathname === '/admin/api/photos' && request.method === 'GET') {
    const status = url.searchParams.get('status') === 'approved' ? 'approved' : 'pending';
    const order = status === 'approved' ? 'reviewed_at DESC' : 'created_at ASC';
    const {results} = await env.DB.prepare(`SELECT id, status, credit, width, height, created_at AS createdAt, reviewed_at AS reviewedAt, reviewed_by AS reviewedBy FROM community_photos WHERE status = ? ORDER BY ${order} LIMIT 200`).bind(status).all();
    return json({email, photos:results.map(row => ({...row, thumb:`/admin/media/thumb/${row.id}.jpg`, full:`/admin/media/full/${row.id}.jpg`}))});
  }

  if (url.pathname === '/admin/api/messages' && request.method === 'GET') return json({email, ...await listMessages(env, url)});
  const messageMatch = url.pathname.match(/^\/admin\/api\/messages\/(contact|vendor)\/([0-9a-f-]{36})\/(done|reopen)$/);
  if (messageMatch) {
    if (request.method !== 'POST') return json({error:'Method not allowed.'}, 405);
    if (request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site') return json({error:'Request blocked.'}, 403);
    const [, kind, id, action] = messageMatch;
    const table = MESSAGE_TABLES[kind];
    const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
    if (!row) return json({error:'That message no longer exists.'}, 404);
    if (action === 'done') await env.DB.prepare(`UPDATE ${table} SET done_at = ?, done_by = ? WHERE id = ?`).bind(new Date().toISOString(), email, id).run();
    else await env.DB.prepare(`UPDATE ${table} SET done_at = NULL, done_by = NULL WHERE id = ?`).bind(id).run();
    return json({ok:true});
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
  const assetPath = url.pathname === '/admin' || url.pathname === '/admin/' ? '/admin/index.html'
    : url.pathname === '/admin/messages' ? '/admin/messages.html' : url.pathname;
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

      if (url.pathname === '/api/contact') {
        if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:{...corsHeaders(request, env), 'Access-Control-Allow-Methods':'GET, POST', 'Access-Control-Max-Age':'86400'}});
        // The landing page only shows the form once this says the email binding is set up.
        if (request.method === 'GET') return json({ready:Boolean(env.CONTACT_EMAIL && env.CONTACT_FROM)}, 200, {...corsHeaders(request, env), 'Cache-Control':'public, max-age=300'});
        if (request.method === 'POST') return await submitContact(request, env, url);
        return json({error:'Method not allowed.'}, 405);
      }

      if (url.pathname === '/api/vendors') {
        if (request.method === 'OPTIONS') return new Response(null, {status:204, headers:{...corsHeaders(request, env), 'Access-Control-Allow-Methods':'POST', 'Access-Control-Max-Age':'86400'}});
        if (request.method === 'POST') return await submitVendor(request, env, url);
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
