// Stories editor at photos.zahabu.co.ke/admin/stories. The server side (API, checks, public pages, Brevo) is stories.mjs.
// The editor is a contenteditable area; on save its content is turned into simple JSON blocks (paragraphs, headings,
// quotes, lists, photos, players, dividers), so no raw HTML is ever stored. Pasting from Google Docs, Word, WhatsApp or
// a web page goes through the same conversion, which keeps bold, italics, links, headings and lists and drops the rest.

const $ = id => document.getElementById(id);
const editor = $('editor');
const titleField = $('title');
const subtitleField = $('subtitle');
const authorField = $('author');
const slugField = $('slug');
const statusEl = $('saveStatus');
const state = {
  stories:[], sections:[], mixLibrary:null, mixStorage:null, tab:'draft', email:'', site:'https://zahabu.co.ke', newsletter:{ready:false}, subscribers:{confirmed:0, pending:0, unsubscribed:0},
  id:null, story:null, baseUpdatedAt:null, coverId:null, coverAlt:'', version:0, savedVersion:0, saving:null, autosave:null, range:null, open:false, ignoreHash:false,
};
const dateTime = new Intl.DateTimeFormat('en-GB', {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit', timeZone:'Africa/Nairobi'});
const dateOnly = new Intl.DateTimeFormat('en-GB', {day:'numeric', month:'short', year:'numeric', timeZone:'Africa/Nairobi'});
const timeOnly = new Intl.DateTimeFormat('en-GB', {hour:'2-digit', minute:'2-digit', timeZone:'Africa/Nairobi'});
const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};

async function api(path, {json, ...options} = {}) {
  const init = {credentials:'same-origin', ...options};
  if (json !== undefined) { init.body = JSON.stringify(json); init.headers = {'content-type':'application/json'}; }
  let response;
  try { response = await fetch(path, init); } catch { throw new Error('No connection. Check your internet and try again.'); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || (response.status === 403 ? 'Your sign-in has expired. Reload the page to sign in again.' : `Request failed (${response.status}).`));
    error.conflict = !!body.conflict;
    throw error;
  }
  return body;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'})[char]);
const mediaUrl = (id, size) => `/stories/media/${id}-${size}.jpg`;
const siteHost = () => state.site.replace(/^https?:\/\//, '');

function slugify(text) {
  const slug = String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72).replace(/-+$/, '');
  return slug || 'story';
}

// ---------- Players (same sites as stories.mjs parseEmbed) ----------

function embedInfo(value) {
  let u;
  try { u = new URL(String(value || '').trim()); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtube.com' || host === 'youtu.be') {
    const id = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1];
    return /^[\w-]{11}$/.test(id || '') ? {kind:'YouTube', thumb:`https://i.ytimg.com/vi/${id}/mqdefault.jpg`} : null;
  }
  if (host === 'vimeo.com') return /^\/\d{5,12}/.test(u.pathname) ? {kind:'Vimeo'} : null;
  if (host === 'soundcloud.com') return u.pathname.length > 1 ? {kind:'SoundCloud'} : null;
  if (host === 'open.spotify.com') return /^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/[A-Za-z0-9]{10,40}/.test(u.pathname) ? {kind:'Spotify'} : null;
  if (host === 'mixcloud.com') return u.pathname.split('/').filter(Boolean).length >= 2 ? {kind:'Mixcloud'} : null;
  return null;
}

// ---------- DOM → blocks ----------

const BLOCK_TAGS = /^(P|DIV|H[1-6]|BLOCKQUOTE|UL|OL|LI|FIGURE|HR|SECTION|ARTICLE|HEADER|FOOTER|ASIDE|MAIN|NAV|TABLE|THEAD|TBODY|TFOOT|TR|TD|TH|PRE|DL|DT|DD|ADDRESS|CENTER|FIGCAPTION)$/;
const SKIP_TAGS = /^(SCRIPT|STYLE|META|LINK|TITLE|HEAD|NOSCRIPT|TEMPLATE|IFRAME|OBJECT|EMBED|SVG|BUTTON|INPUT|SELECT|TEXTAREA|IMG|PICTURE|VIDEO|AUDIO|CANVAS|MATH)$/;
const isBlock = node => node.nodeType === 1 && BLOCK_TAGS.test(node.tagName);
const hasBlockInside = node => [...node.childNodes].some(child => child.nodeType === 1 && !SKIP_TAGS.test(child.tagName) && (isBlock(child) || hasBlockInside(child)));

// Google Docs wraps pasted text in <b style="font-weight:normal">, so the style wins over the tag.
function marksFor(node, marks) {
  const next = {...marks};
  const style = node.style || {};
  const tag = node.tagName;
  if (style.fontWeight) next.b = /^(bold|bolder|[6-9]00)$/.test(style.fontWeight);
  else if (tag === 'B' || tag === 'STRONG') next.b = true;
  if (style.fontStyle) next.i = style.fontStyle === 'italic' || style.fontStyle === 'oblique';
  else if (tag === 'I' || tag === 'EM') next.i = true;
  if (tag === 'A' && node.getAttribute('href') && !node.getAttribute('href').startsWith('#')) next.href = node.getAttribute('href');
  return next;
}

function run(text, marks) {
  const r = {text};
  if (marks.b) r.b = true;
  if (marks.i) r.i = true;
  if (marks.href) r.href = marks.href;
  return r;
}

function runsOf(node, marks, out = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const text = child.nodeValue.replace(/[\t\n\r ]+/g, ' ');
      if (text) out.push(run(text, marks));
    } else if (child.nodeType === 1 && !SKIP_TAGS.test(child.tagName)) {
      if (child.tagName === 'BR') { out.push(run('\n', marks)); continue; }
      // A block inside a block (paragraphs in a quote, a list in a list item) becomes a line break.
      if (isBlock(child) && out.length && !out[out.length - 1].text.endsWith('\n')) out.push(run('\n', {}));
      runsOf(child, marksFor(child, marks), out);
    }
  }
  return out;
}

function tidy(runs, {plain = false} = {}) {
  const merged = [];
  for (const r of runs) {
    if (plain) { delete r.b; delete r.i; }
    let text = r.text.replace(/ *\n */g, '\n');
    const last = merged[merged.length - 1];
    if (last && /[ \n]$/.test(last.text)) text = text.replace(/^ +/, '');
    if (!text) continue;
    if (last && !!last.b === !!r.b && !!last.i === !!r.i && last.href === r.href) last.text += text;
    else merged.push({...r, text});
  }
  if (merged.length) merged[0].text = merged[0].text.replace(/^[\s\n]+/, '');
  if (merged.length) merged[merged.length - 1].text = merged[merged.length - 1].text.replace(/[\s\n]+$/, '');
  const result = merged.filter(r => r.text);
  return result.some(r => r.text.trim()) ? result : [];
}

function domToBlocks(root) {
  const blocks = [];
  let loose = [];
  const flush = () => { const c = tidy(loose); loose = []; if (c.length) blocks.push({t:'p', c}); };
  const push = (t, node, marks, options) => { const c = tidy(runsOf(node, marksFor(node, marks)), options); if (c.length) blocks.push({t, c}); };
  const walk = (node, marks) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) { runsOf({childNodes:[child]}, marks, loose); continue; }
      if (child.nodeType !== 1 || SKIP_TAGS.test(child.tagName)) continue;
      const tag = child.tagName;
      if (child.classList.contains('story-img')) {
        flush();
        blocks.push({t:'img', id:child.dataset.id, alt:child.querySelector('[name=alt]')?.value || '', caption:child.querySelector('[name=caption]')?.value || ''});
        continue;
      }
      if (child.classList.contains('story-embed')) { flush(); blocks.push({t:'embed', url:child.dataset.url}); continue; }
      if (child.classList.contains('story-callout')) { flush(); blocks.push({t:'callout', text:child.querySelector('textarea').value}); continue; }
      if (child.classList.contains('story-gallery')) {
        flush();
        blocks.push({t:'gallery', images:[...child.querySelectorAll('.gal-item')].map(item => ({id:item.dataset.id})), alt:child.querySelector('[name=alt]').value, caption:child.querySelector('[name=caption]').value});
        continue;
      }
      if (child.classList.contains('story-split')) {
        flush();
        if (child.dataset.id) blocks.push({t:'split', id:child.dataset.id, alt:child.querySelector('[name=alt]').value, text:child.querySelector('textarea').value, side:child.dataset.side});
        continue;
      }
      if (child.classList.contains('story-mix')) {
        flush();
        const value = name => child.querySelector(`[name=${name}]`)?.value || '';
        if (child.dataset.id) blocks.push({t:'mix', id:child.dataset.id, title:value('title'), artist:value('artist'), recorded:value('recorded'), artworkId:child.dataset.artworkId || ''});
        continue;
      }
      if (child.classList.contains('story-event')) {
        flush();
        const value = name => child.querySelector(`[name=${name}]`).value;
        blocks.push({t:'event', title:value('title'), date:value('date'), time:value('time'), place:value('place'), link:value('link'), label:value('label')});
        continue;
      }
      if (child.classList.contains('uploading')) continue;
      if (!isBlock(child)) {
        if (hasBlockInside(child)) walk(child, marksFor(child, marks));
        else if (tag === 'BR') loose.push(run('\n', {}));
        else runsOf(child, marksFor(child, marks), loose);
        continue;
      }
      flush();
      if (tag === 'HR') blocks.push({t:'hr'});
      else if (/^H[12]$/.test(tag)) push('h2', child, marks, {plain:true});
      else if (/^H[3-6]$/.test(tag)) push('h3', child, marks, {plain:true});
      else if (tag === 'BLOCKQUOTE') push('quote', child, marks);
      else if (tag === 'UL' || tag === 'OL') {
        const items = [...child.children].filter(li => li.tagName === 'LI').map(li => tidy(runsOf(li, marksFor(li, marks)))).filter(item => item.length);
        if (items.length) blocks.push({t:tag.toLowerCase(), items});
      } else if (tag !== 'P' && tag !== 'LI' && hasBlockInside(child)) walk(child, marks);
      else push('p', child, marks);
    }
  };
  walk(root, {});
  flush();
  return blocks;
}

// ---------- blocks → editor ----------

function runsHtml(runs) {
  return runs.map(r => {
    let html = esc(r.text).replace(/\n/g, '<br>');
    if (r.b) html = `<b>${html}</b>`;
    if (r.i) html = `<i>${html}</i>`;
    if (r.href) html = `<a href="${esc(r.href)}">${html}</a>`;
    return html;
  }).join('');
}

function blockHtml(block) {
  if (block.t === 'p' || block.t === 'h2' || block.t === 'h3') return `<${block.t}>${runsHtml(block.c)}</${block.t}>`;
  if (block.t === 'quote') return `<blockquote>${runsHtml(block.c)}</blockquote>`;
  if (block.t === 'ul' || block.t === 'ol') return `<${block.t}>${block.items.map(item => `<li>${runsHtml(item)}</li>`).join('')}</${block.t}>`;
  if (block.t === 'hr') return '<hr>';
  return '';
}

function htmlNode(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.firstElementChild;
}

function figureInput(name, placeholder, value) {
  const input = el('input');
  input.name = name;
  input.placeholder = placeholder;
  input.value = value || '';
  input.maxLength = 300;
  input.setAttribute('aria-label', placeholder);
  return input;
}

function figureTools(figure) {
  const tools = el('div', 'fig-tools');
  const up = el('button', '', 'Up');
  const down = el('button', '', 'Down');
  const remove = el('button', '', 'Remove');
  for (const button of [up, down, remove]) button.type = 'button';
  up.setAttribute('aria-label', 'Move up');
  down.setAttribute('aria-label', 'Move down');
  up.addEventListener('click', () => { if (figure.previousElementSibling) { figure.previousElementSibling.before(figure); changed(); } });
  down.addEventListener('click', () => { if (figure.nextElementSibling) { figure.nextElementSibling.after(figure); changed(); } });
  remove.addEventListener('click', () => {
    const next = figure.nextElementSibling;
    figure.remove();
    if (!editor.firstElementChild) editor.append(emptyParagraph());
    if (next) placeCaret(next);
    changed();
  });
  tools.append(up, down, remove);
  return tools;
}

function imageFigure({id, alt = '', caption = ''}) {
  const figure = el('figure', 'story-img');
  figure.contentEditable = 'false';
  figure.dataset.id = id;
  const img = el('img');
  img.src = mediaUrl(id, 1600);
  img.alt = alt;
  const fields = el('div', 'fig-fields');
  fields.append(figureInput('caption', 'Caption (optional)', caption), figureInput('alt', 'Describe the photo for people who can\'t see it', alt));
  figure.append(img, fields, figureTools(figure));
  return figure;
}

function embedFigure(url) {
  const info = embedInfo(url) || {kind:'Player'};
  const figure = el('figure', 'story-embed');
  figure.contentEditable = 'false';
  figure.dataset.url = url;
  const card = el('div', 'embed-card');
  if (info.thumb) { const img = el('img'); img.src = info.thumb; img.alt = ''; card.append(img); }
  const text = el('div');
  text.append(el('div', 'kind', `${info.kind} player`), el('div', 'url', url));
  card.append(text);
  figure.append(card, figureTools(figure));
  return figure;
}

function emptyParagraph() { const p = el('p'); p.append(el('br')); return p; }

function blockFigure(className, label) {
  const figure = el('figure', `block-card ${className}`);
  figure.contentEditable = 'false';
  figure.append(el('span', 'block-label', label));
  figure.append(figureTools(figure));
  return figure;
}

function textArea(name, placeholder, value) {
  const area = el('textarea');
  area.name = name;
  area.placeholder = placeholder;
  area.value = value || '';
  area.maxLength = 3000;
  area.setAttribute('aria-label', placeholder);
  return area;
}

function calloutFigure({text = ''} = {}) {
  const figure = blockFigure('story-callout', 'Highlighted note');
  figure.append(textArea('text', 'A note to stand out: opening hours, a ticket link, a key fact… Links are made clickable.', text));
  return figure;
}

function galleryItem(id) {
  const item = el('div', 'gal-item');
  item.dataset.id = id;
  const img = el('img');
  img.src = mediaUrl(id, 800);
  img.alt = '';
  const remove = el('button', '', '×');
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Remove this photo');
  remove.addEventListener('click', () => { item.remove(); changed(); });
  item.append(img, remove);
  return item;
}

function galleryFigure({images = [], alt = '', caption = ''} = {}) {
  const figure = blockFigure('story-gallery', 'Photo gallery');
  const grid = el('div', 'gal-grid');
  const add = el('button', 'gal-add', '+ Add photos');
  add.type = 'button';
  const picker = el('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.multiple = true;
  picker.hidden = true;
  add.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    const files = [...picker.files];
    picker.value = '';
    for (const file of files) {
      add.textContent = `Uploading ${files.indexOf(file) + 1} of ${files.length}…`;
      try { add.before(galleryItem((await uploadPhoto(file)).id)); changed(); }
      catch (error) { setStatus(error.message, 'error'); }
    }
    add.textContent = '+ Add photos';
  });
  grid.append(...images.map(image => galleryItem(image.id)), add, picker);
  const fields = el('div', 'fig-fields');
  fields.append(figureInput('caption', 'Caption (optional)', caption), figureInput('alt', 'Describe these photos for people who can\'t see them', alt));
  figure.append(grid, fields);
  return figure;
}

function splitFigure({id = '', alt = '', text = '', side = 'left'} = {}) {
  const figure = blockFigure('story-split', 'Photo + text');
  figure.dataset.id = id;
  figure.dataset.side = side;
  const wrap = el('div', `split-edit${side === 'right' ? ' right' : ''}`);
  const photo = el('div', 'split-photo');
  const img = el('img');
  img.alt = '';
  const choose = el('button', 'btn', id ? 'Change photo' : 'Choose photo');
  const flip = el('button', 'btn quiet', side === 'right' ? 'Photo on the right' : 'Photo on the left');
  choose.type = flip.type = 'button';
  const picker = el('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.hidden = true;
  const showPhoto = () => { img.hidden = !figure.dataset.id; if (figure.dataset.id) img.src = mediaUrl(figure.dataset.id, 800); };
  choose.addEventListener('click', () => picker.click());
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    picker.value = '';
    if (!file) return;
    choose.textContent = 'Uploading…';
    try { figure.dataset.id = (await uploadPhoto(file)).id; showPhoto(); changed(); }
    catch (error) { setStatus(error.message, 'error'); }
    choose.textContent = figure.dataset.id ? 'Change photo' : 'Choose photo';
  });
  flip.addEventListener('click', () => {
    figure.dataset.side = figure.dataset.side === 'right' ? 'left' : 'right';
    wrap.classList.toggle('right', figure.dataset.side === 'right');
    flip.textContent = figure.dataset.side === 'right' ? 'Photo on the right' : 'Photo on the left';
    changed();
  });
  photo.append(img, choose, flip, picker);
  wrap.append(photo, textArea('text', 'Text beside the photo. On phones it sits under the photo.', text));
  const fields = el('div', 'fig-fields');
  fields.append(figureInput('alt', 'Describe the photo for people who can\'t see it', alt));
  figure.append(wrap, fields);
  showPhoto();
  return figure;
}

function eventFigure(block = {}) {
  const figure = blockFigure('story-event', 'Event card');
  const grid = el('div', 'event-grid');
  const field = (name, label, type, placeholder, wide, max) => {
    const wrap = el('label', wide ? 'wide' : '');
    const input = el('input');
    input.name = name;
    input.type = type;
    input.placeholder = placeholder || '';
    input.value = block[name] || '';
    if (max) input.maxLength = max;
    wrap.append(label, input);
    return wrap;
  };
  grid.append(
    field('title', 'Event name', 'text', 'e.g. Zahabu Sundowner', true, 120),
    field('date', 'Date', 'date', '', false),
    field('time', 'Time', 'text', 'e.g. 4pm till late', false, 60),
    field('place', 'Place', 'text', 'e.g. The Mall rooftop, Westlands', true, 120),
    field('link', 'Tickets / RSVP link (optional)', 'url', 'https://…', false, 2000),
    field('label', 'Button text', 'text', 'e.g. Get tickets', false, 40),
  );
  figure.append(grid);
  return figure;
}

// ---------- Mixes ----------

const MIX_KBPS = 128;
let activeUploads = 0;
const fmtBytes = n => n >= 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : `${Math.max(0.1, n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
const fmtClock = seconds => {
  const s = Math.max(0, Math.round(seconds || 0)), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`;
};
const isMp3 = file => /\.mp3$/i.test(file.name) || file.type === 'audio/mpeg';

function audioDuration(blob) {
  return new Promise(resolve => {
    const audio = new Audio(), url = URL.createObjectURL(blob);
    const done = value => { URL.revokeObjectURL(url); resolve(value); };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => done(Number.isFinite(audio.duration) ? audio.duration : 0);
    audio.onerror = () => done(0);
    audio.src = url;
  });
}

// WAV/AIFF/FLAC (and MP3s above ~170 kbps) are compressed to 128 kbps MP3 in a Web Worker (/admin/mix-encoder.js).
function compressMix(file, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = new Worker('/admin/mix-encoder.js');
    worker.onmessage = ({data}) => {
      if (data.type === 'progress') return onProgress(data.progress);
      worker.terminate();
      if (data.type === 'done') resolve(data); else reject(new Error(data.message));
    };
    worker.onerror = event => { worker.terminate(); reject(new Error(`The compressor stopped${event.message ? `: ${event.message}` : ''}. Try a laptop, or export the mix as MP3 (128–160 kbps).`)); };
    worker.postMessage({file, kbps:MIX_KBPS});
  });
}

// Compress if needed, then upload in pieces (each retried up to 5 times), then finish. onStatus(label, fraction).
async function uploadMix(file, meta, onStatus) {
  activeUploads++;
  try {
    let blob = null, durationSeconds = 0, bitrateKbps = MIX_KBPS;
    if (isMp3(file)) {
      durationSeconds = await audioDuration(file);
      const kbps = durationSeconds ? file.size * 8 / durationSeconds / 1000 : Infinity;
      if (kbps <= 170) { blob = file; bitrateKbps = Math.round(kbps); }
    }
    if (!blob) {
      onStatus('Compressing to MP3', 0);
      const out = await compressMix(file, progress => onStatus('Compressing to MP3', progress));
      blob = out.blob;
      durationSeconds = out.durationSeconds;
    }
    const created = await api('/admin/api/mixes', {method:'POST', json:{...meta, size:blob.size, durationSeconds, bitrateKbps, originalName:file.name}});
    const parts = [];
    for (let n = 1; n <= created.parts; n++) {
      const piece = blob.slice((n - 1) * created.partBytes, n * created.partBytes);
      for (let tries = 1; ; tries++) {
        try {
          const response = await fetch(`/admin/api/mixes/${created.id}/parts/${n}`, {method:'PUT', body:piece, credentials:'same-origin'});
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.error || `upload failed (${response.status})`);
          parts.push(body);
          break;
        } catch (error) {
          if (tries >= 5) throw new Error(`The upload stopped at ${Math.round((n - 1) / created.parts * 100)}% (${error.message}). Check your connection and try again.`);
          onStatus(`Connection dropped, trying again (${tries} of 4)`, (n - 1) / created.parts);
          await new Promise(resolve => setTimeout(resolve, 2000 * tries));
        }
      }
      onStatus(`Uploading ${fmtBytes(Math.min(n * created.partBytes, blob.size))} of ${fmtBytes(blob.size)}`, n / created.parts);
    }
    const done = await api(`/admin/api/mixes/${created.id}/complete`, {method:'POST', json:{parts}});
    state.mixLibrary = null;
    return done.mix;
  } finally {
    activeUploads--;
  }
}

async function loadMixLibrary() {
  const data = await api('/admin/api/mixes');
  state.mixLibrary = data.mixes;
  state.mixStorage = {used:data.usedBytes, free:data.freeBytes, max:data.maxBytes};
  return data.mixes;
}

function mixFigure(block = {}) {
  const figure = blockFigure('story-mix', 'Mix');
  figure.dataset.id = block.id || '';
  figure.dataset.artworkId = block.artworkId || '';

  // 1. Choose a file (or a mix that's already uploaded)
  const pick = el('div', 'mix-pick');
  const drop = el('button', 'mix-drop');
  drop.type = 'button';
  drop.innerHTML = '<b>Choose a mix file</b>WAV, AIFF, FLAC or MP3. WAVs are compressed on this computer first: a laptop is best.';
  const picker = el('input');
  picker.type = 'file';
  picker.accept = 'audio/*,.wav,.aif,.aiff,.flac,.mp3';
  picker.hidden = true;
  const library = el('select');
  library.setAttribute('aria-label', 'Or pick an uploaded mix');
  library.append(new Option('…or pick a mix that\'s already uploaded', ''));
  pick.append(drop, picker, library);

  // 2. Progress
  const progressBox = el('div', 'mix-progress');
  const bar = el('progress');
  bar.max = 1;
  const status = el('span', 'mix-status');
  progressBox.append(bar, status);
  progressBox.hidden = true;

  // 3. Ready: preview, details, artwork
  const ready = el('div', 'mix-ready');
  const artBox = el('div', 'mix-artwork');
  const art = el('div', 'ph', 'No artwork');
  const artButton = el('button', 'btn', 'Artwork');
  artButton.type = 'button';
  const artPicker = el('input');
  artPicker.type = 'file';
  artPicker.accept = 'image/*';
  artPicker.hidden = true;
  artBox.append(art, artButton, artPicker);
  const fields = el('div', 'mix-fields');
  const audio = el('audio');
  audio.controls = true;
  audio.preload = 'none';
  const title = figureInput('title', 'Mix title, e.g. Sundowner session', block.title);
  const artist = figureInput('artist', 'DJ / artist', block.artist);
  const recorded = figureInput('recorded', 'Recorded, e.g. Live at Textures, 4 December', block.recorded);
  const fileLine = el('span', 'mix-file');
  fields.append(audio, title, artist, recorded, fileLine);
  ready.append(artBox, fields);

  const showArt = () => {
    const id = figure.dataset.artworkId;
    const node = id ? Object.assign(el('img'), {src:mediaUrl(id, 800), alt:''}) : el('div', 'ph', 'No artwork');
    artBox.firstChild.replaceWith(node);
    artButton.textContent = id ? 'Change artwork' : 'Add artwork';
  };
  const show = mode => { pick.hidden = mode !== 'pick'; progressBox.hidden = mode !== 'progress'; ready.hidden = mode !== 'ready'; };
  const showReady = mix => {
    figure.dataset.id = mix.id;
    audio.src = `/stories/mixes/${mix.id}.mp3`;
    fileLine.textContent = [mix.durationSeconds ? fmtClock(mix.durationSeconds) : '', mix.sizeBytes ? fmtBytes(mix.sizeBytes) : '', mix.originalName].filter(Boolean).join(' · ');
    showArt();
    show('ready');
  };

  // Keep the library's copy of the details in step (shown in the Mixes tab and when reusing a mix).
  let syncTimer = null;
  const syncDetails = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      if (!figure.dataset.id) return;
      api(`/admin/api/mixes/${figure.dataset.id}`, {method:'PUT', json:{title:title.value, artist:artist.value, recorded:recorded.value, artworkId:figure.dataset.artworkId || null}}).catch(() => {});
      state.mixLibrary = null;
    }, 1200);
  };
  for (const input of [title, artist, recorded]) input.addEventListener('input', syncDetails);

  drop.addEventListener('click', () => picker.click());
  library.addEventListener('focus', async () => {
    if (library.options.length > 1) return;
    try {
      for (const mix of state.mixLibrary || await loadMixLibrary()) library.append(new Option([mix.title || mix.originalName || 'Untitled mix', mix.artist, fmtClock(mix.durationSeconds)].filter(Boolean).join(' · '), mix.id));
    } catch (error) { setStatus(error.message, 'error'); }
  });
  library.addEventListener('change', () => {
    const mix = (state.mixLibrary || []).find(item => item.id === library.value);
    if (!mix) return;
    title.value = mix.title; artist.value = mix.artist; recorded.value = mix.recorded;
    figure.dataset.artworkId = mix.artworkId || '';
    showReady(mix);
    changed();
  });
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    picker.value = '';
    if (!file) return;
    if (!title.value) title.value = file.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ');
    show('progress');
    status.classList.remove('error');
    try {
      const mix = await uploadMix(file, {title:title.value, artist:artist.value, recorded:recorded.value, artworkId:figure.dataset.artworkId || null}, (label, fraction) => {
        bar.value = fraction;
        status.textContent = `${label}… ${Math.round(fraction * 100)}%`;
      });
      showReady(mix);
      changed();
      setStatus('Mix uploaded. It plays in the story once you save or publish.');
    } catch (error) {
      show('pick');
      setStatus(error.message, 'error');
    }
  });
  artButton.addEventListener('click', () => artPicker.click());
  artPicker.addEventListener('change', async () => {
    const file = artPicker.files[0];
    artPicker.value = '';
    if (!file) return;
    artButton.textContent = 'Uploading…';
    try { figure.dataset.artworkId = (await uploadPhoto(file)).id; showArt(); changed(); syncDetails(); }
    catch (error) { setStatus(error.message, 'error'); showArt(); }
  });

  figure.append(pick, progressBox, ready);
  if (block.id) showReady({id:block.id, durationSeconds:block.durationSeconds}); else show('pick');
  return figure;
}

const BLOCK_FIGURES = {img:imageFigure, embed:block => embedFigure(block.url), callout:calloutFigure, gallery:galleryFigure, split:splitFigure, event:eventFigure, mix:mixFigure};
function blocksToNodes(blocks) {
  return blocks.map(block => BLOCK_FIGURES[block.t] ? BLOCK_FIGURES[block.t](block) : htmlNode(blockHtml(block))).filter(Boolean);
}

// ---------- Editing helpers ----------

function topBlock(node) {
  if (!node || !editor.contains(node) || node === editor) return null;
  while (node.parentNode !== editor) node = node.parentNode;
  return node;
}

function currentBlock() {
  const range = state.range;
  return range ? topBlock(range.startContainer) : null;
}

function restoreRange() {
  editor.focus({preventScroll:true});
  if (!state.range) return;
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(state.range);
}

function placeCaret(node) {
  if (!node) return;
  if (node.contentEditable === 'false') return;
  const range = document.createRange();
  range.selectNodeContents(node);
  range.collapse(true);
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  state.range = range.cloneRange();
}

function insertBlock(node, anchor = currentBlock()) {
  if (anchor && anchor.tagName === 'P' && !anchor.textContent.trim()) anchor.replaceWith(node);
  else if (anchor) anchor.after(node);
  else editor.append(node);
  if (!node.nextElementSibling || node.nextElementSibling.contentEditable === 'false') node.after(emptyParagraph());
  placeCaret(node.nextElementSibling);
  changed();
}

function command(name, value = null) {
  restoreRange();
  document.execCommand(name, false, value);
  changed();
  updateToolbar();
}

function updateToolbar() {
  const selection = getSelection();
  if (!selection.rangeCount || !editor.contains(selection.anchorNode)) return;
  state.range = selection.getRangeAt(0).cloneRange();
  const block = topBlock(selection.anchorNode);
  const tag = block?.tagName;
  const pressed = (cmd, on) => document.querySelector(`[data-cmd="${cmd}"]`)?.setAttribute('aria-pressed', String(!!on));
  pressed('bold', document.queryCommandState('bold'));
  pressed('italic', document.queryCommandState('italic'));
  pressed('ul', tag === 'UL');
  pressed('ol', tag === 'OL');
  pressed('quote', tag === 'BLOCKQUOTE');
  const anchorEl = selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement;
  pressed('link', anchorEl?.closest('a'));
  $('blockType').value = tag === 'H2' ? 'h2' : tag === 'H3' ? 'h3' : 'p';
}

function ask(dialog) {
  return new Promise(resolve => {
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue), {once:true});
    dialog.showModal();
  });
}

async function confirmBox(title, text, okLabel) {
  $('confirmTitle').textContent = title;
  $('confirmText').textContent = text;
  $('confirmOk').textContent = okLabel;
  return (await ask($('confirmDialog'))) === 'ok';
}

// ---------- Photos ----------

async function decode(file) {
  try { return await createImageBitmap(file, {imageOrientation:'from-image'}); } catch {}
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file isn\'t a photo this browser can open. Try a JPEG or PNG.'));
    img.src = URL.createObjectURL(file);
  });
}

// Re-encoded here (strips location data and keeps uploads small): 1600px wide for big screens, 800px for phones.
async function preparePhoto(file) {
  if (!file.type.startsWith('image/')) throw new Error('Choose a photo (JPEG, PNG or WebP).');
  const source = await decode(file);
  const make = (maxWidth, quality) => {
    const scale = Math.min(1, maxWidth / source.width, (maxWidth * 1.5) / source.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not process that photo.')), 'image/jpeg', quality));
  };
  const large = await make(1600, 0.82);
  const small = await make(800, 0.78);
  const form = new FormData();
  form.append('large', large, 'large.jpg');
  form.append('small', small, 'small.jpg');
  return form;
}

async function uploadPhoto(file) {
  const form = await preparePhoto(file);
  return api('/admin/api/story-images', {method:'POST', body:form});
}

async function addPhotos(files, anchor) {
  for (const file of files) {
    const placeholder = el('div', 'uploading', `Uploading ${file.name || 'photo'}…`);
    placeholder.contentEditable = 'false';
    if (anchor && anchor.parentNode === editor) anchor.after(placeholder); else editor.append(placeholder);
    anchor = placeholder;
    try {
      const image = await uploadPhoto(file);
      const figure = imageFigure({id:image.id});
      placeholder.replaceWith(figure);
      anchor = figure;
      if (!figure.nextElementSibling || figure.nextElementSibling.contentEditable === 'false') figure.after(emptyParagraph());
      changed();
    } catch (error) {
      placeholder.remove();
      setStatus(error.message, 'error');
    }
  }
  const after = anchor?.nextElementSibling;
  if (after) placeCaret(after);
}

// ---------- Cover ----------

function renderCover() {
  const zone = $('coverZone');
  zone.replaceChildren();
  if (!state.coverId) {
    const add = el('button', 'cover-add');
    add.type = 'button';
    add.innerHTML = '<svg class="icon"><use href="#i-photo"/></svg>Add a cover photo';
    add.addEventListener('click', () => $('coverInput').click());
    zone.append(add);
    return;
  }
  const wrap = el('div', 'cover-img');
  const img = el('img');
  img.src = mediaUrl(state.coverId, 1600);
  img.alt = state.coverAlt;
  const tools = el('div', 'cover-tools');
  const change = el('button', 'btn', 'Change');
  const remove = el('button', 'btn', 'Remove');
  change.type = remove.type = 'button';
  change.addEventListener('click', () => $('coverInput').click());
  remove.addEventListener('click', () => { state.coverId = null; state.coverAlt = ''; renderCover(); changed(); });
  tools.append(change, remove);
  wrap.append(img, tools);
  const alt = el('input', 'cover-alt');
  alt.placeholder = 'Describe the cover photo for people who can\'t see it';
  alt.maxLength = 300;
  alt.value = state.coverAlt;
  alt.addEventListener('input', () => { state.coverAlt = alt.value; changed(); });
  zone.append(wrap, alt);
}

$('coverInput').addEventListener('change', async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  const zone = $('coverZone');
  zone.replaceChildren(el('div', 'uploading', 'Uploading cover photo…'));
  try {
    const image = await uploadPhoto(file);
    state.coverId = image.id;
    changed();
  } catch (error) {
    setStatus(error.message, 'error');
  }
  renderCover();
});

// ---------- Saving ----------

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
}

const isDirty = () => state.version !== state.savedVersion;
const isLive = () => state.story?.status === 'published';

function changed() {
  if (!state.open) return;
  state.version++;
  clearTimeout(state.autosave);
  if (!isLive()) state.autosave = setTimeout(() => save().catch(() => {}), 2500);
  refreshStatus();
  updateWordStats();
}

function refreshStatus() {
  if (statusEl.classList.contains('error') && isDirty()) return;
  if (isDirty()) setStatus(isLive() ? 'Changes not live yet: press Update' : 'Saving soon…', 'dirty');
  else if (!state.story) setStatus('New story, not saved yet');
  else setStatus(`${isLive() ? 'Live' : 'Draft'} · saved ${timeOnly.format(new Date(state.story.updatedAt))}`);
}

function collect() {
  const data = {title:titleField.value, subtitle:subtitleField.value, author:authorField.value, coverId:state.coverId, coverAlt:state.coverAlt, sectionId:$('sectionSelect').value || null, body:domToBlocks(editor)};
  const slug = slugField.value.trim();
  if (slug) data.slug = slug;
  return data;
}

async function save() {
  clearTimeout(state.autosave);
  if (state.saving) { await state.saving.catch(() => {}); if (!isDirty() && state.id) return true; }
  const version = state.version;
  const payload = collect();
  if (!state.id && !payload.title.trim() && !payload.body.length && !payload.coverId) { state.savedVersion = version; refreshStatus(); return true; }
  setStatus('Saving…');
  state.saving = (async () => {
    const result = state.id
      ? await api(`/admin/api/stories/${state.id}`, {method:'PUT', json:{...payload, baseUpdatedAt:state.baseUpdatedAt}})
      : await api('/admin/api/stories', {method:'POST', json:payload});
    applyStory(result.story);
    state.savedVersion = version;
    if (payload.author) storage.set('stories-author', payload.author);
  })();
  try {
    await state.saving;
    refreshStatus();
    if (isDirty() && !isLive()) state.autosave = setTimeout(() => save().catch(() => {}), 2500);
    return true;
  } catch (error) {
    setStatus(error.message, 'error');
    return false;
  } finally {
    state.saving = null;
  }
}

function applyStory(story) {
  const first = !state.id;
  state.story = story;
  state.id = story.id;
  state.baseUpdatedAt = story.updatedAt;
  if (first || location.hash !== `#/story/${story.id}`) history.replaceState(null, '', `#/story/${story.id}`);
  if (document.activeElement !== slugField) slugField.value = story.slug || '';
  const existing = state.stories.findIndex(item => item.id === story.id);
  const summary = {id:story.id, slug:story.slug, title:story.title, subtitle:story.subtitle, author:story.author, coverId:story.coverId, status:story.status, publishedAt:story.publishedAt, updatedAt:story.updatedAt, updatedBy:story.updatedBy, newsletterSentAt:story.newsletterSentAt, newsletterError:story.newsletterError};
  if (existing >= 0) state.stories[existing] = summary; else state.stories.unshift(summary);
  renderSide();
}

function renderSide() {
  const story = state.story;
  const live = isLive();
  $('saveBtn').textContent = live ? 'Update' : 'Save draft';
  $('publishBtn').hidden = live;
  $('previewBtn').href = state.id ? `/admin/stories/${state.id}/preview` : '#';
  $('unpublishBtn').hidden = !live;
  $('deleteBtn').hidden = !story || live;
  const liveLink = $('liveLink');
  liveLink.hidden = !live;
  if (live) {
    liveLink.replaceChildren('Live at ', Object.assign(el('a', '', `${siteHost()}/stories/${story.slug}`), {href:`${state.site}/stories/${story.slug}`, target:'_blank', rel:'noopener'}));
    $('slugHint').textContent = 'Changing it after publishing breaks links people have already shared.';
    $('slugHint').className = 'hint warn';
  } else {
    $('slugHint').textContent = 'Letters, numbers and dashes. Made from the title when you publish.';
    $('slugHint').className = 'hint';
  }
  const meta = [];
  if (story) {
    meta.push(`Started ${dateOnly.format(new Date(story.createdAt))} by ${story.createdBy}.`);
    meta.push(`Last saved ${dateTime.format(new Date(story.updatedAt))} by ${story.updatedBy}.`);
    if (story.publishedAt) meta.push(`${live ? 'Published' : 'First published'} ${dateOnly.format(new Date(story.publishedAt))}.`);
  } else meta.push('Not saved yet. Drafts save by themselves as you write.');
  $('storyMeta').textContent = meta.join(' ');

  const n = state.subscribers.confirmed;
  const people = `${n} subscriber${n === 1 ? '' : 's'}`;
  const panelState = $('newsletterState');
  const testRow = $('testTo').closest('.panel');
  const send = $('sendBtn');
  send.hidden = true;
  for (const node of testRow.querySelectorAll('label, .test-row, .hint')) node.hidden = !state.newsletter.ready;
  if (!state.newsletter.ready) panelState.textContent = 'Email isn\'t connected yet. You can still publish stories on the website.';
  else if (story?.newsletterSentAt) panelState.textContent = `Emailed to subscribers ${dateTime.format(new Date(story.newsletterSentAt))} by ${story.newsletterSentBy || 'staff'}.`;
  else if (live) {
    panelState.textContent = `Not emailed yet. It will go to ${people}.`;
    send.hidden = false;
    send.disabled = n === 0;
    send.textContent = n ? `Email to ${people}` : 'No subscribers yet';
  } else panelState.textContent = `Publish first, then email it to ${people}. You can send yourself a test now.`;
  if (story?.newsletterError && !story.newsletterSentAt) panelState.textContent += ` Last attempt failed: ${story.newsletterError}`;
}

function fillSectionSelect(selected) {
  const select = $('sectionSelect');
  select.replaceChildren(new Option('No section', ''), ...state.sections.map(section => new Option(section.name, section.id)));
  select.value = state.sections.some(section => section.id === selected) ? selected : '';
}

function updateWordStats() {
  const words = (editor.innerText || '').split(/\s+/).filter(Boolean).length;
  $('wordStats').textContent = words ? `${words} words · about ${Math.max(1, Math.round(words / 220))} min read` : '';
}

function autosize(field) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

// ---------- Opening a story ----------

async function openEditor(id) {
  state.open = false;
  $('listView').hidden = true;
  $('editView').hidden = false;
  $('siteHeader').hidden = true;
  window.scrollTo(0, 0);
  setStatus(id ? 'Loading…' : '');
  // Opened straight from a link (#/story/… or #/new): the list, with the newsletter settings and subscriber count, isn't loaded yet.
  if (!state.email) await loadList();
  let story = null;
  if (id) {
    try { story = (await api(`/admin/api/stories/${id}`)).story; }
    catch (error) { setStatus(error.message, 'error'); return; }
  }
  state.id = story?.id || null;
  state.story = story;
  state.baseUpdatedAt = story?.updatedAt || null;
  state.coverId = story?.coverId || null;
  state.coverAlt = story?.coverAlt || '';
  titleField.value = story?.title || '';
  subtitleField.value = story?.subtitle || '';
  authorField.value = story ? story.author : storage.get('stories-author') || '';
  slugField.value = story?.slug || '';
  fillSectionSelect(story?.sectionId || '');
  $('testTo').value = $('testTo').value || state.email;
  editor.replaceChildren(...blocksToNodes(story?.body || []));
  if (!editor.firstElementChild || editor.lastElementChild.contentEditable === 'false') editor.append(emptyParagraph());
  renderCover();
  state.version = state.savedVersion = 0;
  state.open = true;
  renderSide();
  refreshStatus();
  updateWordStats();
  requestAnimationFrame(() => { autosize(titleField); autosize(subtitleField); });
  document.title = `${story?.title || 'New story'} · Stories · Zahabu`;
  if (!story) titleField.focus();
}

// ---------- List ----------

async function loadList() {
  try {
    const data = await api('/admin/api/stories');
    Object.assign(state, {stories:data.stories, sections:data.sections || [], email:data.email, site:data.site, newsletter:data.newsletter, subscribers:data.subscribers});
    $('who').textContent = data.email;
    $('siteLink').href = `${data.site}/stories`;
    $('siteLink').textContent = `${siteHost()}/stories`;
    $('listError').hidden = true;
  } catch (error) {
    $('listError').textContent = error.message;
    $('listError').hidden = false;
  }
}

function showList() {
  state.open = false;
  $('editView').hidden = true;
  $('listView').hidden = false;
  $('siteHeader').hidden = false;
  document.title = 'Stories · Zahabu';
  renderList();
}

function renderList() {
  const drafts = state.stories.filter(story => story.status === 'draft');
  const published = state.stories.filter(story => story.status === 'published');
  $('draftCount').textContent = drafts.length ? ` ${drafts.length}` : '';
  $('publishedCount').textContent = published.length ? ` ${published.length}` : '';
  $('subCount').textContent = state.subscribers.confirmed ? ` ${state.subscribers.confirmed}` : '';
  for (const tab of document.querySelectorAll('.tab')) tab.setAttribute('aria-pressed', String(tab.dataset.tab === state.tab));
  const note = $('newsletterNote');
  note.hidden = state.newsletter.ready;
  note.textContent = 'Email isn\'t connected yet. Stories can be published, but the subscribe box and the newsletter stay hidden until Brevo is set up.';

  const subscribersTab = state.tab === 'subscribers';
  const sectionsTab = state.tab === 'sections';
  const mixesTab = state.tab === 'mixes';
  $('subscribersView').hidden = !subscribersTab;
  $('sectionsView').hidden = !sectionsTab;
  $('mixesView').hidden = !mixesTab;
  $('rows').hidden = subscribersTab || sectionsTab || mixesTab;
  if (mixesTab) { $('listEmpty').hidden = true; renderMixes(); return; }
  if (subscribersTab) { $('listEmpty').hidden = true; loadSubscribers(); return; }
  if (sectionsTab) { $('listEmpty').hidden = true; renderSections(); return; }

  const items = state.tab === 'draft' ? drafts : published;
  const rows = items.map(story => {
    const row = el('a', 'row');
    row.href = `#/story/${story.id}`;
    const thumb = el('div', 'thumb');
    if (story.coverId) thumb.style.backgroundImage = `url("${mediaUrl(story.coverId, 800)}")`;
    const text = el('div');
    text.append(el('div', 'row-title', story.title || 'Untitled story'));
    text.append(el('div', 'row-sub', story.status === 'published'
      ? `Published ${dateOnly.format(new Date(story.publishedAt))}${story.author ? ` · ${story.author}` : ''}`
      : `Edited ${dateTime.format(new Date(story.updatedAt))} by ${story.updatedBy}`));
    const tags = el('div', 'row-tags');
    const section = state.sections.find(item => item.id === story.sectionId);
    if (section) tags.append(el('span', 'tag', section.name));
    tags.append(el('span', `tag ${story.status === 'published' ? 'live' : 'draft'}`, story.status === 'published' ? 'Live' : 'Draft'));
    if (story.newsletterSentAt) tags.append(el('span', 'tag mail', 'Emailed'));
    else if (story.newsletterError) tags.append(el('span', 'tag warn', 'Email failed'));
    row.append(thumb, text, tags);
    return row;
  });
  $('rows').replaceChildren(...rows);
  const empty = $('listEmpty');
  empty.hidden = rows.length > 0;
  empty.textContent = state.tab === 'draft' ? 'No drafts. Press "New story" to start one.' : 'Nothing published yet.';
}

// ---------- Mixes tab ----------

async function renderMixes() {
  let mixes;
  try { mixes = await loadMixLibrary(); }
  catch (error) { $('listError').textContent = error.message; $('listError').hidden = false; return; }
  const {used, free} = state.mixStorage;
  $('mixMeterFill').style.width = `${Math.min(100, used / free * 100).toFixed(1)}%`;
  $('mixMeterText').textContent = `${fmtBytes(used)} of ${fmtBytes(free)} free storage used (${mixes.length} ${mixes.length === 1 ? 'mix' : 'mixes'}). Beyond that, Cloudflare charges about $0.015 per GB a month.`;
  const rows = mixes.map(mix => {
    const row = el('div', 'mix-row');
    row.append(mix.artworkId ? Object.assign(el('img'), {src:mediaUrl(mix.artworkId, 800), alt:''}) : el('div', 'ph'));
    const text = el('div');
    text.append(el('div', 'row-title', mix.title || mix.originalName || 'Untitled mix'));
    text.append(el('div', 'row-sub', [mix.artist, fmtClock(mix.durationSeconds), fmtBytes(mix.sizeBytes || 0), mix.usedIn ? `in ${mix.usedIn} ${mix.usedIn === 1 ? 'story' : 'stories'}` : 'not in any story', `uploaded ${dateOnly.format(new Date(mix.createdAt))}`].filter(Boolean).join(' · ')));
    const remove = el('button', 'btn danger', 'Delete');
    remove.type = 'button';
    remove.disabled = mix.usedIn > 0;
    remove.title = mix.usedIn ? 'Remove it from its stories first' : 'Delete this mix';
    remove.addEventListener('click', async () => {
      if (!(await confirmBox('Delete this mix?', `"${mix.title || mix.originalName}" will be removed from storage for good.`, 'Delete'))) return;
      try { await api(`/admin/api/mixes/${mix.id}`, {method:'DELETE'}); renderMixes(); }
      catch (error) { $('listError').textContent = error.message; $('listError').hidden = false; }
    });
    row.append(text, remove);
    return row;
  });
  $('mixRows').replaceChildren(...rows);
  if (!rows.length) $('mixRows').append(el('p', 'empty', 'No mixes yet. Add one inside a story with + Insert… → Mix (audio).'));
}

// ---------- Sections tab ----------

function renderSections() {
  const rows = state.sections.map((section, index) => {
    const row = el('div', 'sec-row');
    const move = el('div', 'sec-move');
    const up = el('button', '', 'Up');
    const down = el('button', '', 'Down');
    up.type = down.type = 'button';
    up.setAttribute('aria-label', `Move ${section.name} up`);
    down.setAttribute('aria-label', `Move ${section.name} down`);
    up.disabled = index === 0;
    down.disabled = index === state.sections.length - 1;
    const reorder = async offset => {
      const ids = state.sections.map(item => item.id);
      [ids[index], ids[index + offset]] = [ids[index + offset], ids[index]];
      await sectionCall('/admin/api/story-sections/order', 'POST', {ids});
    };
    up.addEventListener('click', () => reorder(-1));
    down.addEventListener('click', () => reorder(1));
    move.append(up, down);
    const fields = el('div', 'sec-fields');
    const name = el('input', 'input');
    name.value = section.name;
    name.maxLength = 40;
    name.setAttribute('aria-label', 'Section name');
    const description = el('input', 'input');
    description.value = section.description;
    description.maxLength = 200;
    description.placeholder = 'One line about this section (shown on its page)';
    description.setAttribute('aria-label', 'Section description');
    fields.append(name, description, el('span', 'sec-meta', `${siteHost()}/stories/section/${section.slug} · ${section.storyCount} ${section.storyCount === 1 ? 'story' : 'stories'}`));
    const actions = el('div', 'sec-actions');
    const save = el('button', 'btn', 'Save');
    const remove = el('button', 'btn danger', 'Delete');
    save.type = remove.type = 'button';
    save.addEventListener('click', () => sectionCall(`/admin/api/story-sections/${section.id}`, 'PUT', {name:name.value, description:description.value}));
    remove.addEventListener('click', async () => {
      if (!(await confirmBox(`Delete "${section.name}"?`, 'The section and its page go away. Only empty sections can be deleted.', 'Delete'))) return;
      sectionCall(`/admin/api/story-sections/${section.id}`, 'DELETE');
    });
    actions.append(save, remove);
    row.append(move, fields, actions);
    return row;
  });
  $('sectionRows').replaceChildren(...rows);
}

async function sectionCall(path, method, json) {
  try {
    state.sections = (await api(path, {method, json})).sections;
    $('listError').hidden = true;
    renderSections();
  } catch (error) {
    $('listError').textContent = error.message;
    $('listError').hidden = false;
  }
}

$('sectionAdd').addEventListener('submit', async event => {
  event.preventDefault();
  const name = $('newSectionName').value.trim();
  if (!name) return;
  await sectionCall('/admin/api/story-sections', 'POST', {name});
  $('newSectionName').value = '';
});

let subscriberList = [];
async function loadSubscribers() {
  const {confirmed, pending, unsubscribed} = state.subscribers;
  const stat = (n, label) => { const box = el('div', 'stat'); box.append(el('b', '', String(n)), el('span', '', label)); return box; };
  $('subStats').replaceChildren(stat(confirmed, 'Subscribed'), stat(pending, 'Not confirmed yet'), stat(unsubscribed, 'Unsubscribed'));
  try {
    subscriberList = (await api('/admin/api/subscribers')).subscribers;
  } catch (error) {
    $('subRows').replaceChildren();
    $('listError').textContent = error.message;
    $('listError').hidden = false;
    return;
  }
  const labels = {confirmed:'Subscribed', pending:'Not confirmed', unsubscribed:'Unsubscribed'};
  $('subRows').replaceChildren(...subscriberList.map(sub => {
    const tr = el('tr');
    const status = el('td');
    status.append(el('span', `tag ${sub.status === 'confirmed' ? 'live' : sub.status === 'pending' ? 'draft' : ''}`, labels[sub.status] || sub.status));
    if (sub.brevoError && sub.status === 'confirmed') status.append(' ', el('span', 'tag warn', 'Not in Brevo'));
    tr.append(el('td', '', sub.email), status, el('td', '', dateOnly.format(new Date(sub.confirmedAt || sub.createdAt))));
    return tr;
  }));
  if (!subscriberList.length) {
    const tr = el('tr');
    const td = el('td', '', 'No one has subscribed yet.');
    td.colSpan = 3;
    tr.append(td);
    $('subRows').append(tr);
  }
}

$('downloadCsv').addEventListener('click', () => {
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  const lines = [['email', 'status', 'joined', 'confirmed'].join(','), ...subscriberList.map(sub => [sub.email, sub.status, sub.createdAt, sub.confirmedAt || ''].map(cell).join(','))];
  const link = el('a');
  link.href = URL.createObjectURL(new Blob([lines.join('\n')], {type:'text/csv'}));
  link.download = `zahabu-subscribers-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
});

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    state.tab = tab.dataset.tab;
    history.replaceState(null, '', ['subscribers', 'sections', 'mixes'].includes(state.tab) ? `#/${state.tab}` : '#/');
    renderList();
  });
}

// ---------- Routing (#/, #/new, #/story/<id>, #/subscribers) ----------

let currentHash = location.hash;
async function route() {
  const hash = location.hash || '#/';
  const match = hash.match(/^#\/story\/([0-9a-f-]{36})$/);
  if (hash === '#/new') return openEditor(null);
  if (match) return openEditor(match[1]);
  if (hash === '#/subscribers') state.tab = 'subscribers';
  else if (hash === '#/sections') state.tab = 'sections';
  else if (hash === '#/mixes') state.tab = 'mixes';
  else if (['subscribers', 'sections', 'mixes'].includes(state.tab)) state.tab = 'draft';
  await loadList();
  showList();
}

window.addEventListener('hashchange', async () => {
  if (state.ignoreHash) { state.ignoreHash = false; return; }
  if (activeUploads && state.open && !state.leavingUpload) {
    const target = location.hash;
    state.ignoreHash = true;
    location.hash = currentHash;
    if (!(await confirmBox('A mix is still uploading', 'Leave this story and the mix won\'t be added to it (it will still finish uploading to the Mixes library if you stay on this page).', 'Leave'))) return;
    state.ignoreHash = false;
    state.leavingUpload = true;
    location.hash = target;
    return;
  }
  state.leavingUpload = false;
  if (state.open && isDirty()) {
    const target = location.hash;
    if (isLive()) {
      state.ignoreHash = true;
      location.hash = currentHash;
      if (!(await confirmBox('Leave without updating?', 'Your changes aren\'t live yet. Leave and lose them, or stay and press Update.', 'Leave'))) return;
      state.version = state.savedVersion;
      state.ignoreHash = false;
      location.hash = target;
      return;
    }
    if (!(await save())) {
      state.ignoreHash = true;
      location.hash = currentHash;
      return;
    }
  }
  currentHash = location.hash;
  // On comms.zahabu.co.ke the editor is the whole site; Photos and Messages stay on photos.zahabu.co.ke.
if (location.hostname === 'comms.zahabu.co.ke') {
  for (const link of document.querySelectorAll('.nav a')) {
    const path = link.getAttribute('href');
    link.href = path === '/admin/stories' ? '/' : `https://photos.zahabu.co.ke${path}`;
  }
}

route();
});

window.addEventListener('beforeunload', event => {
  if ((state.open && isDirty()) || activeUploads) event.preventDefault();
});

// ---------- Editor events ----------

document.execCommand('defaultParagraphSeparator', false, 'p');
editor.addEventListener('input', changed);
$('sectionSelect').addEventListener('change', changed);
for (const field of [titleField, subtitleField, authorField, slugField]) field.addEventListener('input', () => { if (field.tagName === 'TEXTAREA') autosize(field); changed(); });
titleField.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); subtitleField.focus(); } });
subtitleField.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); editor.focus(); placeCaret(editor.firstElementChild); } });
slugField.addEventListener('blur', () => { if (slugField.value.trim()) slugField.value = slugify(slugField.value); });
document.addEventListener('selectionchange', updateToolbar);
window.addEventListener('resize', () => { autosize(titleField); autosize(subtitleField); });

$('insertBlock').addEventListener('change', event => {
  const kind = event.target.value;
  event.target.value = '';
  const anchor = currentBlock();
  const figure = {gallery:galleryFigure, split:splitFigure, callout:calloutFigure, event:eventFigure, mix:mixFigure}[kind]?.();
  if (!figure) return;
  insertBlock(figure, anchor);
  if (kind === 'gallery') figure.querySelector('.gal-add').click();
  else if (kind === 'mix') figure.querySelector('.mix-drop').click();
  else if (kind === 'split') figure.querySelector('.split-photo .btn').click();
  else figure.querySelector('textarea, input')?.focus();
});

// Keep the editor's selection when pressing toolbar buttons.
$('toolbar').addEventListener('mousedown', event => { if (event.target.closest('button')) event.preventDefault(); });
$('blockType').addEventListener('change', event => command('formatBlock', `<${event.target.value}>`));

async function editLink() {
  restoreRange();
  const selection = getSelection();
  const anchorNode = selection.anchorNode && (selection.anchorNode.nodeType === 1 ? selection.anchorNode : selection.anchorNode.parentElement);
  const existing = anchorNode?.closest('a');
  if (existing && selection.isCollapsed) {
    const range = document.createRange();
    range.selectNodeContents(existing);
    selection.removeAllRanges();
    selection.addRange(range);
    state.range = range.cloneRange();
  }
  $('linkUrl').value = existing?.getAttribute('href') || '';
  $('linkRemove').hidden = !existing;
  const result = await ask($('linkDialog'));
  if (result === 'remove') { command('unlink'); return; }
  if (result !== 'ok') { restoreRange(); return; }
  let url = $('linkUrl').value.trim();
  if (!url) return;
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(url)) url = `mailto:${url}`;
  else if (!/^(https?:|mailto:|\/)/i.test(url)) url = `https://${url}`;
  restoreRange();
  if (getSelection().isCollapsed) document.execCommand('insertHTML', false, `<a href="${esc(url)}">${esc(url.replace(/^mailto:/, ''))}</a>`);
  else document.execCommand('createLink', false, url);
  changed();
}

async function addEmbed() {
  const anchor = currentBlock();
  $('embedUrl').value = '';
  $('embedError').hidden = true;
  const dialog = $('embedDialog');
  const result = await ask(dialog);
  if (result !== 'ok') { restoreRange(); return; }
  const url = $('embedUrl').value.trim();
  insertBlock(embedFigure(url), anchor);
}
$('embedOk').addEventListener('click', event => {
  if (!embedInfo($('embedUrl').value)) { event.preventDefault(); $('embedError').hidden = false; }
});

let photoAnchor = null;
$('toolbar').addEventListener('click', event => {
  const button = event.target.closest('button[data-cmd]');
  if (!button) return;
  const cmd = button.dataset.cmd;
  if (cmd === 'bold' || cmd === 'italic') command(cmd);
  else if (cmd === 'ul') command('insertUnorderedList');
  else if (cmd === 'ol') command('insertOrderedList');
  else if (cmd === 'quote') command('formatBlock', currentBlock()?.tagName === 'BLOCKQUOTE' ? '<p>' : '<blockquote>');
  else if (cmd === 'link') editLink();
  else if (cmd === 'embed') addEmbed();
  else if (cmd === 'hr') insertBlock(el('hr'));
  else if (cmd === 'photo') { photoAnchor = currentBlock(); $('photoInput').click(); }
});

$('photoInput').addEventListener('change', event => {
  const files = [...event.target.files];
  event.target.value = '';
  if (!files.length) return;
  let anchor = photoAnchor;
  if (anchor && anchor.tagName === 'P' && !anchor.textContent.trim() && anchor.previousElementSibling) { const prev = anchor.previousElementSibling; anchor.remove(); anchor = prev; }
  addPhotos(files, anchor);
});

editor.addEventListener('keydown', event => {
  if (event.target.closest('textarea')) return;
  if (event.target.closest('input')) {
    if (event.key === 'Enter') event.preventDefault();
    return;
  }
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); editLink(); }
});

document.addEventListener('keydown', event => {
  if (state.open && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); save(); }
});

editor.addEventListener('paste', event => {
  if (event.target.closest('input, textarea')) return;
  event.preventDefault();
  const html = event.clipboardData.getData('text/html');
  const text = event.clipboardData.getData('text/plain');
  const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'));
  if (files.length && !text.trim()) { addPhotos(files, currentBlock()); return; }
  // A link to YouTube, SoundCloud and so on, pasted on an empty line, becomes a player.
  const trimmed = text.trim();
  const block = currentBlock();
  if (/^https?:\/\/\S+$/.test(trimmed) && embedInfo(trimmed) && (!block || !block.textContent.trim())) { insertBlock(embedFigure(trimmed), block); return; }
  let blocks;
  if (html) blocks = domToBlocks(new DOMParser().parseFromString(html, 'text/html').body).filter(b => b.t !== 'img' && b.t !== 'embed');
  else {
    const clean = text.replace(/\r\n?/g, '\n');
    const parts = /\n\s*\n/.test(clean) ? clean.split(/\n\s*\n/) : clean.split('\n');
    blocks = parts.map(part => ({t:'p', c:tidy([{text:part}])})).filter(b => b.c.length);
  }
  if (!blocks.length) return;
  if (blocks.length === 1 && blocks[0].t === 'p') document.execCommand('insertHTML', false, runsHtml(blocks[0].c));
  else document.execCommand('insertHTML', false, blocks.map(blockHtml).join(''));
  changed();
});

editor.addEventListener('dragover', event => { if ([...event.dataTransfer.items].some(item => item.kind === 'file')) event.preventDefault(); });
editor.addEventListener('drop', event => {
  const files = [...event.dataTransfer.files].filter(file => file.type.startsWith('image/'));
  if (!files.length) return;
  event.preventDefault();
  const target = document.caretRangeFromPoint ? document.caretRangeFromPoint(event.clientX, event.clientY) : null;
  addPhotos(files, topBlock(target?.startContainer) || editor.lastElementChild);
});

// ---------- Buttons ----------

$('saveBtn').addEventListener('click', async () => {
  if (isLive()) {
    const blocks = domToBlocks(editor);
    if (!titleField.value.trim() || !blocks.length) { setStatus('A published story needs a title and some text.', 'error'); return; }
  }
  if (await save()) setStatus(isLive() ? `Updated · live at ${timeOnly.format(new Date())}` : `Draft saved · ${timeOnly.format(new Date())}`);
});

$('previewBtn').addEventListener('click', async event => {
  if (state.id && !isDirty()) return;
  event.preventDefault();
  if (isLive()) { setStatus('Press Update first: the preview shows the saved story.', 'dirty'); return; }
  const tab = window.open('about:blank', '_blank');
  if (await save() && state.id) { if (tab) tab.location = `/admin/stories/${state.id}/preview`; }
  else if (tab) tab.close();
});

$('publishBtn').addEventListener('click', async () => {
  if (!titleField.value.trim()) { setStatus('Give the story a title before publishing.', 'error'); titleField.focus(); return; }
  if (!domToBlocks(editor).length) { setStatus('The story has no text yet.', 'error'); return; }
  $('publishUrl').textContent = `${siteHost()}/stories/${slugField.value.trim() ? slugify(slugField.value) : slugify(titleField.value)}`;
  const n = state.subscribers.confirmed;
  const box = $('publishEmail');
  box.checked = false;
  box.disabled = !state.newsletter.ready || n === 0;
  $('publishEmailText').textContent = `Also email it to ${n} subscriber${n === 1 ? '' : 's'} now`;
  $('publishEmailHint').textContent = !state.newsletter.ready ? 'Email isn\'t connected yet.' : n === 0 ? 'No one has subscribed yet.' : 'You can also email it later from the Newsletter box.';
  if ((await ask($('publishDialog'))) !== 'ok') return;
  const sendNow = box.checked && !box.disabled;
  if (!(await save())) return;
  try {
    setStatus('Publishing…');
    applyStory((await api(`/admin/api/stories/${state.id}/publish`, {method:'POST'})).story);
    setStatus(`Published · live at ${siteHost()}/stories/${state.story.slug}`);
  } catch (error) { setStatus(error.message, 'error'); return; }
  if (sendNow) await sendNewsletter();
});

async function sendNewsletter() {
  setStatus('Sending the newsletter…');
  $('sendBtn').disabled = true;
  try {
    await api(`/admin/api/stories/${state.id}/send`, {method:'POST'});
    setStatus('Sent to subscribers. Brevo delivers it over the next few minutes.');
  } catch (error) {
    setStatus(error.message, 'error');
  }
  try { applyStory((await api(`/admin/api/stories/${state.id}`)).story); } catch {}
}

$('sendBtn').addEventListener('click', async () => {
  if (isDirty()) { setStatus('Press Update first, so subscribers get the latest version.', 'dirty'); return; }
  const n = state.subscribers.confirmed;
  if (!(await confirmBox('Email this story?', `"${state.story.title}" goes to ${n} subscriber${n === 1 ? '' : 's'} now. You can't unsend it.`, 'Send now'))) return;
  sendNewsletter();
});

$('testBtn').addEventListener('click', async () => {
  const to = $('testTo').value.trim();
  if (!to) { $('testTo').focus(); return; }
  if (isDirty() && !isLive() && !(await save())) return;
  if (!state.id) { setStatus('Write something first.', 'error'); return; }
  const button = $('testBtn');
  button.disabled = true;
  setStatus(`Sending a test to ${to}…`);
  try {
    await api(`/admin/api/stories/${state.id}/test-email`, {method:'POST', json:{to}});
    setStatus(`Test sent to ${to}${isLive() && isDirty() ? ' (from the live version; your unsaved changes aren\'t in it)' : ''}.`);
  } catch (error) { setStatus(error.message, 'error'); }
  button.disabled = false;
});

$('unpublishBtn').addEventListener('click', async () => {
  if (!(await confirmBox('Unpublish this story?', 'It comes off the website and goes back to Drafts. Links to it stop working until you publish it again.', 'Unpublish'))) return;
  try { applyStory((await api(`/admin/api/stories/${state.id}/unpublish`, {method:'POST'})).story); refreshStatus(); }
  catch (error) { setStatus(error.message, 'error'); }
});

$('deleteBtn').addEventListener('click', async () => {
  if (!(await confirmBox('Delete this draft?', 'It will be gone for good.', 'Delete'))) return;
  try {
    await api(`/admin/api/stories/${state.id}`, {method:'DELETE'});
    state.stories = state.stories.filter(story => story.id !== state.id);
    state.version = state.savedVersion;
    location.hash = '#/';
  } catch (error) { setStatus(error.message, 'error'); }
});

route();
