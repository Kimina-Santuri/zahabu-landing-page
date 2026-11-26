// Stories: Zahabu's own editorial site + newsletter (replaces Substack). Loaded by photos-worker.mjs.
// Public (zahabu.co.ke/stories*, a Worker route in front of GitHub Pages):
//   /stories                 list of published stories (?page=N), with the subscribe box
//   /stories/<slug>          one story
//   /stories/feed.xml        RSS          /stories/sitemap.xml   for search engines
//   /stories/media/<id>-<800|1600>.jpg   story photos (public by unguessable id, cached for a year)
//   /stories/api/latest      newest stories as JSON (landing page section)
//   /stories/api/subscribe   GET: is signing up available?  POST: email + Turnstile, sends a confirmation email
//   /stories/confirm?t=…     page with a Confirm button (a button, so email link scanners don't confirm people)
//   /stories/api/confirm     POST from that page: subscriber confirmed and added to the Brevo list
//   /stories/api/brevo-webhook   Brevo tells us about unsubscribes, bounces and spam complaints (each checked back with Brevo)
// Staff (photos.zahabu.co.ke/admin/…, behind Cloudflare Access; photos-worker.mjs checks the sign-in first):
//   /admin/stories (editor page), /admin/stories/<id>/preview, /admin/api/stories…, /admin/api/story-images,
//   /admin/api/subscribers
// Story bodies are stored as JSON blocks, never HTML: the server checks every block and builds the HTML itself.

const ID = /^[0-9a-f-]{36}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const RESERVED_SLUGS = new Set(['api', 'media', 'confirm', 'feed', 'sitemap', 'subscribe', 'page', 'admin', 'section']);
const MAX = {title:160, subtitle:300, author:80, alt:300, caption:300, slug:80, blocks:600, runs:400, runText:20000, bodyBytes:400_000};
const PER_PAGE = 20;
const MAX_SUBSCRIBES_PER_IP_PER_HOUR = 5;
const MAX_IMAGE_BYTES = {1600:2.5 * 1024 * 1024, 800:700 * 1024};
// Not plain "Futura": Apple devices only have Futura Medium/Bold built in, so the email body looked bold there.
// Apple Mail and iOS Mail load the site's own regular Futura (below); Gmail and others fall back to Century Gothic/Arial.
const EMAIL_FONT = "'Zahabu Futura', 'Century Gothic', 'Trebuchet MS', Arial, sans-serif";
const EMBED_HOSTS = ['https://www.youtube-nocookie.com', 'https://player.vimeo.com', 'https://w.soundcloud.com', 'https://open.spotify.com', 'https://www.mixcloud.com'];

export function createStories({json, escapeHtml:esc, verifyTurnstile, hashIp, sanitizeJpeg, allowedOrigins}) {
  const site = env => (env.SITE_ORIGIN || 'https://zahabu.co.ke').replace(/\/$/, '');
  const now = () => new Date().toISOString();
  const sameOrigin = (request, url) => request.headers.get('origin') === url.origin && request.headers.get('sec-fetch-site') !== 'cross-site';

  // ---------- Body blocks: checked on save, rendered on read ----------

  function cleanHref(value) {
    const href = String(value || '').trim().slice(0, 2000);
    if (/^mailto:[^\s<>"]+@[^\s<>"]+$/i.test(href)) return href;
    if (/^\/(?!\/)[^\s<>"]*$/.test(href)) return href;
    try { const u = new URL(href); if (u.protocol === 'https:' || u.protocol === 'http:') return u.href; } catch {}
    return null;
  }

  function cleanRuns(runs) {
    if (!Array.isArray(runs)) return [];
    const out = [];
    for (const run of runs.slice(0, MAX.runs)) {
      if (!run || typeof run.text !== 'string') continue;
      const text = run.text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f]/g, '').slice(0, MAX.runText);
      if (!text) continue;
      const clean = {text};
      if (run.b) clean.b = true;
      if (run.i) clean.i = true;
      const href = run.href ? cleanHref(run.href) : null;
      if (href) clean.href = href;
      const last = out[out.length - 1];
      if (last && !!last.b === !!clean.b && !!last.i === !!clean.i && last.href === clean.href) last.text += text;
      else out.push(clean);
    }
    // Drop trailing line breaks and empty paragraphs' whitespace.
    while (out.length && !out[out.length - 1].text.replace(/\n+$/, '')) out.pop();
    if (out.length) out[out.length - 1].text = out[out.length - 1].text.replace(/\n+$/, '');
    return out.some(run => run.text.trim()) ? out : [];
  }

  // Embeds open in a player on the page only after a tap (saves data until someone wants to play it).
  function parseEmbed(value) {
    let u;
    try { u = new URL(String(value || '').trim()); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    const host = u.hostname.replace(/^(www|m|music)\./, '');
    const link = u.href;
    if (host === 'youtube.com' || host === 'youtu.be' || host === 'youtube-nocookie.com') {
      const id = host === 'youtu.be' ? u.pathname.slice(1) : u.searchParams.get('v') || (u.pathname.match(/^\/(?:shorts|embed|live)\/([\w-]{11})/) || [])[1];
      if (!/^[\w-]{11}$/.test(id || '')) return null;
      return {kind:'youtube', label:'YouTube', link:`https://www.youtube.com/watch?v=${id}`, src:`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0`, thumb:`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, ratio:true};
    }
    if (host === 'vimeo.com') {
      const id = (u.pathname.match(/^\/(\d{5,12})/) || [])[1];
      if (!id) return null;
      return {kind:'vimeo', label:'Vimeo', link, src:`https://player.vimeo.com/video/${id}?autoplay=1`, ratio:true};
    }
    if (host === 'soundcloud.com' && u.pathname.length > 1) {
      return {kind:'soundcloud', label:'SoundCloud', link, src:`https://w.soundcloud.com/player/?url=${encodeURIComponent(`https://soundcloud.com${u.pathname}`)}&auto_play=true&visual=false&show_comments=false`, height:166};
    }
    if (host === 'open.spotify.com') {
      const match = u.pathname.match(/^\/(?:intl-[a-z-]+\/)?(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]{10,40})/);
      if (!match) return null;
      return {kind:'spotify', label:'Spotify', link, src:`https://open.spotify.com/embed/${match[1]}/${match[2]}?autoplay=1`, height:match[1] === 'track' || match[1] === 'episode' ? 152 : 352};
    }
    if (host === 'mixcloud.com' && u.pathname.split('/').filter(Boolean).length >= 2) {
      return {kind:'mixcloud', label:'Mixcloud', link, src:`https://www.mixcloud.com/widget/iframe/?hide_cover=1&autoplay=1&feed=${encodeURIComponent(u.pathname)}`, height:120};
    }
    return null;
  }

  const cleanLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  // Multi-line plain text (callouts, photo + text): line breaks kept, control characters dropped.
  const cleanText = (value, max) => String(value ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f]/g, '')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
  const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value);

  // Returns {blocks} or {error}.
  function cleanBody(raw) {
    if (!Array.isArray(raw)) return {error:'The story text could not be read.'};
    if (JSON.stringify(raw).length > MAX.bodyBytes) return {error:'The story is too long to save. Split it into two stories.'};
    const blocks = [];
    for (const block of raw.slice(0, MAX.blocks)) {
      if (!block || typeof block.t !== 'string') continue;
      if (['p', 'h2', 'h3', 'quote'].includes(block.t)) {
        const c = cleanRuns(block.c);
        if (c.length) blocks.push({t:block.t, c});
      } else if (block.t === 'ul' || block.t === 'ol') {
        const items = (Array.isArray(block.items) ? block.items : []).slice(0, 200).map(cleanRuns).filter(item => item.length);
        if (items.length) blocks.push({t:block.t, items});
      } else if (block.t === 'img') {
        if (!ID.test(block.id || '')) continue;
        blocks.push({t:'img', id:block.id, alt:String(block.alt || '').replace(/\s+/g, ' ').trim().slice(0, MAX.alt), caption:String(block.caption || '').replace(/\s+/g, ' ').trim().slice(0, MAX.caption)});
      } else if (block.t === 'embed') {
        const embed = parseEmbed(block.url);
        if (embed) blocks.push({t:'embed', url:embed.link});
      } else if (block.t === 'hr') {
        if (blocks.length && blocks[blocks.length - 1].t !== 'hr') blocks.push({t:'hr'});
      } else if (block.t === 'callout') {
        const text = cleanText(block.text, 2000);
        if (text) blocks.push({t:'callout', text});
      } else if (block.t === 'gallery') {
        const images = (Array.isArray(block.images) ? block.images : []).filter(image => ID.test(image?.id || '')).slice(0, 24).map(image => ({id:image.id}));
        if (images.length) blocks.push({t:'gallery', images, alt:cleanLine(block.alt, MAX.alt), caption:cleanLine(block.caption, MAX.caption)});
      } else if (block.t === 'split') {
        if (!ID.test(block.id || '')) continue;
        blocks.push({t:'split', id:block.id, alt:cleanLine(block.alt, MAX.alt), text:cleanText(block.text, 3000), side:block.side === 'right' ? 'right' : 'left'});
      } else if (block.t === 'event') {
        const title = cleanLine(block.title, 120);
        if (!title) continue;
        const link = block.link ? cleanHref(block.link) : null;
        blocks.push({t:'event', title, date:validDay(block.date) ? block.date : '', time:cleanLine(block.time, 60), place:cleanLine(block.place, 120),
          link:link && /^https?:/.test(link) ? link : '', label:cleanLine(block.label, 40)});
      }
    }
    return {blocks};
  }

  const plainText = runs => runs.map(run => run.text).join('');
  function bodyText(blocks) {
    return blocks.flatMap(block => block.c ? [plainText(block.c)] : block.items ? block.items.map(plainText)
      : block.t === 'event' ? [block.title, block.place] : [block.text, block.caption].filter(Boolean)).join('\n');
  }
  const wordCount = blocks => bodyText(blocks).split(/\s+/).filter(Boolean).length;
  const imageIds = story => [...new Set([story.cover_id, ...story.blocks.flatMap(b => b.t === 'img' || b.t === 'split' ? [b.id] : b.t === 'gallery' ? b.images.map(i => i.id) : [])].filter(Boolean))];

  async function imageSizes(env, ids) {
    if (!ids.length) return {};
    const {results} = await env.DB.prepare(`SELECT id, width, height FROM story_images WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    return Object.fromEntries(results.map(row => [row.id, row]));
  }
  const mediaUrl = (base, id, size) => `${base}/stories/media/${id}-${size}.jpg`;

  // mode: 'web' (story page), 'feed' (RSS, absolute links), 'email' (inline styles only)
  function renderRuns(runs, mode, base) {
    return runs.map(run => {
      let html = esc(run.text).replace(/\n/g, '<br>');
      if (run.b) html = `<strong>${html}</strong>`;
      if (run.i) html = `<em>${html}</em>`;
      if (run.href) {
        const href = run.href.startsWith('/') ? base + run.href : run.href;
        const style = mode === 'email' ? ' style="color:#2f5d3a;text-decoration:underline;"' : '';
        html = `<a href="${esc(href)}"${style}${/^https?:/.test(href) && !href.startsWith(base) ? ' rel="noopener"' : ''}>${html}</a>`;
      }
      return html;
    }).join('');
  }

  // Plain text → HTML: escaped, links made clickable, blank lines → paragraphs, single line breaks → <br>.
  function textHtml(text, {paragraph = '<p>', close = '</p>', link = ''} = {}) {
    return text.split(/\n{2,}/).map(part => paragraph + esc(part)
      .replace(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g, url => `<a href="${url}"${link}>${url}</a>`).replace(/\n/g, '<br>') + close).join('');
  }
  const eventDate = day => {
    if (!day) return null;
    const d = new Date(`${day}T12:00:00Z`);
    const part = options => new Intl.DateTimeFormat('en-GB', {...options, timeZone:'UTC'}).format(d);
    return {month:part({month:'short'}), day:part({day:'numeric'}), weekday:part({weekday:'short'}), long:part({weekday:'long', day:'numeric', month:'long', year:'numeric'})};
  };
  const eventLine = block => [eventDate(block.date)?.long, block.time, block.place].filter(Boolean).join(' · ');

  function renderBody(blocks, sizes, mode, base) {
    const P = 'margin:0 0 18px;font-size:17px;line-height:1.7;color:#24302a;';
    return blocks.map(block => {
      const runs = block.c ? renderRuns(block.c, mode, base) : '';
      if (mode === 'email') {
        if (block.t === 'p') return `<p style="${P}">${runs}</p>`;
        if (block.t === 'h2') return `<h2 style="margin:30px 0 12px;font-size:21px;line-height:1.25;font-weight:normal;text-transform:uppercase;letter-spacing:1px;color:#141814;">${runs}</h2>`;
        if (block.t === 'h3') return `<h3 style="margin:24px 0 10px;font-size:18px;line-height:1.3;font-weight:normal;color:#141814;">${runs}</h3>`;
        if (block.t === 'quote') return `<blockquote style="margin:0 0 18px;padding:2px 0 2px 18px;border-left:3px solid #2f5d3a;font-size:19px;line-height:1.55;color:#141814;">${runs}</blockquote>`;
        if (block.t === 'ul' || block.t === 'ol') return `<${block.t} style="margin:0 0 18px;padding-left:22px;">${block.items.map(item => `<li style="margin:0 0 6px;font-size:17px;line-height:1.6;color:#24302a;">${renderRuns(item, mode, base)}</li>`).join('')}</${block.t}>`;
        if (block.t === 'hr') return '<hr style="border:0;border-top:1px solid #dde3de;margin:28px 0;">';
        if (block.t === 'img') return `<p style="margin:6px 0 20px;"><img src="${mediaUrl(base, block.id, 1600)}" width="544" alt="${esc(block.alt)}" style="display:block;width:100%;max-width:544px;height:auto;border:0;border-radius:10px;">${block.caption ? `<span style="display:block;margin-top:8px;font-size:13px;line-height:1.5;color:#5f6a63;">${esc(block.caption)}</span>` : ''}</p>`;
        if (block.t === 'embed') {
          const embed = parseEmbed(block.url);
          if (!embed) return '';
          const thumb = embed.thumb ? `<a href="${esc(embed.link)}"><img src="${esc(embed.thumb)}" width="544" alt="Play on ${embed.label}" style="display:block;width:100%;max-width:544px;height:auto;border:0;border-radius:10px;"></a>` : '';
          return `<p style="margin:6px 0 20px;">${thumb}<a href="${esc(embed.link)}" style="display:inline-block;margin-top:${thumb ? 10 : 0}px;padding:10px 18px;border-radius:999px;border:1px solid #141814;color:#141814;font-size:12px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;">${embed.kind === 'youtube' || embed.kind === 'vimeo' ? 'Watch' : 'Listen'} on ${embed.label}</a></p>`;
        }
        const linkStyle = ' style="color:#2f5d3a;text-decoration:underline;"';
        if (block.t === 'callout') return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px;"><tr><td style="padding:16px 20px;background:#eef4ef;border-left:3px solid #2f5d3a;border-radius:0 10px 10px 0;">${textHtml(block.text, {paragraph:'<p style="margin:0 0 10px;font-size:16px;line-height:1.6;color:#141814;">', link:linkStyle})}</td></tr></table>`;
        if (block.t === 'gallery') {
          const cells = block.images.map(image => `<td width="50%" style="padding:4px;vertical-align:top;"><a href="${mediaUrl(base, image.id, 1600)}"><img src="${mediaUrl(base, image.id, 800)}" width="264" alt="${esc(block.alt)}" style="display:block;width:100%;height:auto;border:0;border-radius:8px;"></a></td>`);
          const rows = [];
          for (let i = 0; i < cells.length; i += 2) rows.push(`<tr>${cells[i]}${cells[i + 1] || '<td width="50%"></td>'}</tr>`);
          return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:2px -4px 6px;">${rows.join('')}</table>${block.caption ? `<p style="margin:0 0 20px;font-size:13px;line-height:1.5;color:#5f6a63;">${esc(block.caption)}</p>` : '<p style="margin:0 0 14px;"></p>'}`;
        }
        if (block.t === 'split') return `<p style="margin:6px 0 12px;"><img src="${mediaUrl(base, block.id, 1600)}" width="544" alt="${esc(block.alt)}" style="display:block;width:100%;max-width:544px;height:auto;border:0;border-radius:10px;"></p>${block.text ? textHtml(block.text, {paragraph:`<p style="${P}">`, link:linkStyle}) : ''}`;
        if (block.t === 'event') {
          const day = eventDate(block.date);
          const dateCell = day ? `<td width="76" style="vertical-align:top;padding:14px 0 14px 16px;"><div style="width:60px;border-radius:10px;background:#141814;color:#ffffff;text-align:center;padding:8px 0;"><div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;">${day.month}</div><div style="font-size:26px;line-height:1.1;">${day.day}</div><div style="font-size:11px;letter-spacing:1px;text-transform:uppercase;opacity:.8;">${day.weekday}</div></div></td>` : '';
          const button = block.link ? `<a href="${esc(block.link)}" style="display:inline-block;margin-top:10px;padding:9px 18px;border-radius:999px;background:#141814;color:#ffffff;font-size:12px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;">${esc(block.label || 'Details')}</a>` : '';
          return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px;border:1px solid #dde3de;border-radius:12px;"><tr>${dateCell}<td style="vertical-align:top;padding:14px 16px;"><p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5f6a63;">Event</p><p style="margin:4px 0 0;font-size:19px;line-height:1.25;color:#141814;">${esc(block.title)}</p>${eventLine(block) ? `<p style="margin:6px 0 0;font-size:14px;line-height:1.5;color:#3d4640;">${esc(eventLine(block))}</p>` : ''}${button}</td></tr></table>`;
        }
        return '';
      }
      if (block.t === 'p') return `<p>${runs}</p>`;
      if (block.t === 'h2' || block.t === 'h3') return `<${block.t}>${runs}</${block.t}>`;
      if (block.t === 'quote') return `<blockquote><p>${runs}</p></blockquote>`;
      if (block.t === 'ul' || block.t === 'ol') return `<${block.t}>${block.items.map(item => `<li>${renderRuns(item, mode, base)}</li>`).join('')}</${block.t}>`;
      if (block.t === 'hr') return '<hr>';
      if (block.t === 'img') {
        const size = sizes[block.id];
        const prefix = mode === 'feed' ? base : '';
        const dims = size ? ` width="${size.width}" height="${size.height}"` : '';
        return `<figure><img src="${mediaUrl(prefix, block.id, 1600)}" srcset="${mediaUrl(prefix, block.id, 800)} 800w, ${mediaUrl(prefix, block.id, 1600)} 1600w" sizes="(max-width: 760px) 100vw, 680px"${dims} alt="${esc(block.alt)}" loading="lazy" decoding="async">${block.caption ? `<figcaption>${esc(block.caption)}</figcaption>` : ''}</figure>`;
      }
      if (block.t === 'embed') {
        const embed = parseEmbed(block.url);
        if (!embed) return '';
        if (mode === 'feed') return `<p><a href="${esc(embed.link)}">${embed.kind === 'youtube' || embed.kind === 'vimeo' ? 'Watch' : 'Listen'} on ${embed.label}</a></p>`;
        const verb = embed.kind === 'youtube' || embed.kind === 'vimeo' ? 'Play video' : 'Play';
        return `<div class="embed embed-${embed.kind}${embed.ratio ? ' ratio' : ''}" data-src="${esc(embed.src)}"${embed.height ? ` data-h="${embed.height}" style="--h:${embed.height}px"` : ''}>
<button type="button" class="embed-play" aria-label="${verb} on ${embed.label}">${embed.thumb ? `<img src="${esc(embed.thumb)}" alt="" loading="lazy" decoding="async">` : ''}<span class="embed-btn"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg>${verb} on ${embed.label}</span></button>
<a class="embed-link" href="${esc(embed.link)}" rel="noopener">Open on ${embed.label}</a></div>`;
      }
      const prefix = mode === 'feed' ? base : '';
      const dims = id => sizes[id] ? ` width="${sizes[id].width}" height="${sizes[id].height}"` : '';
      if (block.t === 'callout') return mode === 'feed' ? `<blockquote>${textHtml(block.text)}</blockquote>` : `<aside class="callout">${textHtml(block.text)}</aside>`;
      if (block.t === 'gallery') {
        return `<figure class="gallery${block.images.length === 1 ? ' one' : block.images.length === 2 ? ' two' : ''}"><div class="gallery-grid">${block.images.map(image => `<a href="${mediaUrl(prefix, image.id, 1600)}" target="_blank" rel="noopener"><img src="${mediaUrl(prefix, image.id, 800)}"${dims(image.id)} alt="${esc(block.alt)}" loading="lazy" decoding="async"></a>`).join('')}</div>${block.caption ? `<figcaption>${esc(block.caption)}</figcaption>` : ''}</figure>`;
      }
      if (block.t === 'split') {
        const img = `<img src="${mediaUrl(prefix, block.id, 1600)}" srcset="${mediaUrl(prefix, block.id, 800)} 800w, ${mediaUrl(prefix, block.id, 1600)} 1600w" sizes="(max-width: 640px) 100vw, 340px"${dims(block.id)} alt="${esc(block.alt)}" loading="lazy" decoding="async">`;
        return mode === 'feed' ? `<p>${img}</p>${textHtml(block.text)}` : `<div class="split${block.side === 'right' ? ' right' : ''}"><div class="split-img">${img}</div><div class="split-text">${textHtml(block.text)}</div></div>`;
      }
      if (block.t === 'event') {
        const day = eventDate(block.date);
        const button = block.link ? `<a class="pill dark" href="${esc(block.link)}" rel="noopener">${esc(block.label || 'Details')}</a>` : '';
        if (mode === 'feed') return `<p><strong>${esc(block.title)}</strong>${eventLine(block) ? `<br>${esc(eventLine(block))}` : ''}${block.link ? `<br><a href="${esc(block.link)}">${esc(block.label || 'Details')}</a>` : ''}</p>`;
        return `<div class="event-card">${day ? `<div class="event-date" aria-hidden="true"><span>${day.month}</span><b>${day.day}</b><span>${day.weekday}</span></div>` : ''}<div class="event-info"><span class="eyebrow">Event</span><h3>${esc(block.title)}</h3>${eventLine(block) ? `<p>${esc(eventLine(block))}</p>` : ''}${button}</div></div>`;
      }
      return '';
    }).join('\n');
  }

  // ---------- Reading stories ----------

  function rowToStory(row) {
    if (!row) return null;
    let blocks = [];
    try { blocks = JSON.parse(row.body || '[]'); } catch {}
    return {...row, blocks};
  }
  // Stories with their section's name and slug (st = stories, sec = story_sections).
  const CARD_SQL = 'SELECT st.id, st.slug, st.title, st.subtitle, st.author, st.cover_id, st.cover_alt, st.published_at, sec.name AS section_name, sec.slug AS section_slug FROM stories st LEFT JOIN story_sections sec ON sec.id = st.section_id';
  const FULL_SQL = 'SELECT st.*, sec.name AS section_name, sec.slug AS section_slug FROM stories st LEFT JOIN story_sections sec ON sec.id = st.section_id';
  const SECTION_ID = /^[a-z0-9-]{3,64}$/;

  const publicStory = (row, base) => ({
    slug:row.slug, title:row.title, subtitle:row.subtitle, author:row.author, publishedAt:row.published_at, section:row.section_name || null, sectionSlug:row.section_slug || null,
    url:`${base}/stories/${row.slug}`, cover:row.cover_id ? mediaUrl(base, row.cover_id, 800) : null, coverAlt:row.cover_alt,
  });

  const dateFormat = new Intl.DateTimeFormat('en-GB', {day:'numeric', month:'long', year:'numeric', timeZone:'Africa/Nairobi'});
  const formatDate = iso => iso ? dateFormat.format(new Date(iso)) : '';

  // ---------- Public pages ----------

  const ICONS = {
    whatsapp:'<path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2c0 1.3.9 2.5 1.1 2.7.1.2 1.9 2.9 4.6 4 1.7.7 2.4.8 3.2.7.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2-.1-.1-.3-.2-.5-.3z"/>',
    x:'<path fill="currentColor" d="M17.8 3h3.1l-6.8 7.7L22 21h-6.2l-4.9-6.4L5.3 21H2.2l7.2-8.3L1.8 3h6.4l4.4 5.8L17.8 3zm-1.1 16.2h1.7L7.4 4.7H5.6l11.1 14.5z"/>',
    facebook:'<path fill="currentColor" d="M13.5 22v-8h2.7l.4-3.2h-3.1V8.8c0-.9.3-1.5 1.6-1.5h1.7V4.4c-.3 0-1.3-.1-2.4-.1-2.4 0-4 1.5-4 4.1v2.4H7.6V14h2.8v8h3.1z"/>',
    link:'<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/>',
    arrow:'<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 12h14M13 6l6 6-6 6"/>',
  };
  const icon = name => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

  function pageCss(base) {
    return `@font-face{font-family:Futura;src:url("${base}/fonts/Futura-Regular.ttf") format("truetype");font-display:swap}
:root{--glass:rgba(255,255,255,.66);--glass-border:rgba(255,255,255,.7);--blur:blur(18px) saturate(1.2);--ink:#141814;--ink-soft:#3d4640;--body:#24302a;--muted:#5f6a63;--line:rgba(20,24,20,.14);--forest:#2f5d3a;--paper:#fff;--bg:#e9f0ea;--gutter:clamp(16px,5vw,56px)}
*{margin:0;padding:0;box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{font-family:Futura,"Century Gothic","Trebuchet MS",Arial,sans-serif;color:var(--ink);background:var(--bg);-webkit-font-smoothing:antialiased;overflow-x:hidden}
.bg-photo,.bg-overlay{position:fixed;inset:0}
.bg-photo{background:url("${base}/assets/garden-background.jpg") center/cover no-repeat;z-index:-2}
.bg-overlay{z-index:-1;background:linear-gradient(to bottom,rgba(255,255,255,.12) 0%,rgba(255,255,255,.34) 45%,rgba(255,255,255,.55) 100%)}
a{color:inherit}
img{display:block;max-width:100%;height:auto}
[hidden]{display:none!important}
:focus-visible{outline:2px solid var(--ink);outline-offset:3px}
.icon{width:18px;height:18px;flex:none}
.top{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:20px var(--gutter)}
.top img{width:96px}
.top nav{display:flex;gap:20px;font-size:12px;letter-spacing:.16em;text-transform:uppercase}
.top nav a{text-decoration:none;padding:6px 0;border-bottom:1px solid transparent}
.top nav a:hover,.top nav a[aria-current]{border-bottom-color:currentColor}
main{padding:clamp(16px,4vw,40px) var(--gutter) clamp(56px,9vw,100px)}
.eyebrow{display:block;font-size:12px;letter-spacing:.24em;text-transform:uppercase;color:var(--muted)}
.sections{max-width:1080px;margin:0 auto 22px;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;padding:2px}
.sections::-webkit-scrollbar{display:none}
.sections a{flex:none;padding:9px 16px;border-radius:999px;background:var(--glass);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid var(--glass-border);font-size:12px;letter-spacing:.14em;text-transform:uppercase;text-decoration:none}
.sections a[aria-current]{background:var(--ink);border-color:var(--ink);color:#fff}
a.eyebrow{text-decoration:none}
a.eyebrow:hover{color:var(--ink)}
.hero{max-width:1080px;margin:0 auto 36px;display:grid;gap:24px;grid-template-columns:1fr;align-items:end}
.hero h1{font-weight:normal;font-size:clamp(44px,9vw,96px);line-height:.95;text-transform:uppercase;margin-top:12px}
.hero p{font-size:clamp(17px,2.2vw,20px);line-height:1.55;color:var(--ink-soft);max-width:560px;margin-top:14px}
@media(min-width:860px){.hero{grid-template-columns:1.2fr 1fr}}
.cards{max-width:1080px;margin:0 auto;display:grid;gap:18px;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr))}
.card{display:flex;flex-direction:column;background:var(--glass);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border-radius:18px;overflow:hidden;text-decoration:none;border:1px solid var(--glass-border);box-shadow:0 18px 40px -26px rgba(20,40,20,.5);transition:transform .2s ease,box-shadow .2s ease}
.card:hover{transform:translateY(-2px);box-shadow:0 18px 40px -26px rgba(20,40,20,.45)}
.card .cover{aspect-ratio:16/10;background:#dfe7e0;overflow:hidden}
.card .cover img{width:100%;height:100%;object-fit:cover}
.card .text{padding:18px 20px 22px;display:flex;flex-direction:column;gap:8px}
.card h2{font-weight:normal;font-size:21px;line-height:1.2;text-transform:uppercase;letter-spacing:.01em}
.card p{font-size:15px;line-height:1.55;color:var(--ink-soft)}
.card .meta{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin-top:auto;padding-top:6px}
.card.lead{grid-column:1/-1}
@media(min-width:760px){.card.lead{flex-direction:row}.card.lead .cover{flex:1.3;aspect-ratio:auto;min-height:340px}.card.lead .text{flex:1;justify-content:center;padding:32px}.card.lead h2{font-size:clamp(26px,3vw,36px)}.card.lead p{font-size:17px}}
.empty{max-width:1080px;margin:0 auto;padding:56px 20px;text-align:center;color:var(--ink-soft);background:var(--glass);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border:1px solid var(--glass-border);border-radius:18px}
.pager{max-width:1080px;margin:28px auto 0;display:flex;justify-content:space-between;gap:12px}
.pill{display:inline-flex;align-items:center;gap:8px;padding:11px 20px;border-radius:999px;border:1px solid var(--ink);background:var(--paper);font-size:12px;letter-spacing:.14em;text-transform:uppercase;text-decoration:none;color:var(--ink);cursor:pointer;font-family:inherit}
.pill.dark{background:var(--ink);color:#fff}
.pill.dark:hover{background:var(--forest);border-color:var(--forest)}
.subscribe{background:var(--glass);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border-radius:18px;padding:22px;border:1px solid var(--glass-border);box-shadow:0 18px 40px -26px rgba(20,40,20,.5)}
.subscribe h2{font-weight:normal;font-size:20px;text-transform:uppercase;letter-spacing:.02em}
.subscribe p{font-size:15px;line-height:1.55;color:var(--ink-soft);margin-top:6px}
.subscribe form{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.subscribe input[type=email]{flex:1 1 200px;min-width:0;padding:12px 16px;border-radius:999px;border:1px solid var(--line);font:inherit;font-size:16px;background:#fff;color:var(--ink)}
.subscribe .ts{flex-basis:100%}
.subscribe .note{font-size:14px;margin-top:10px;color:var(--forest)}
.subscribe .note.error{color:#a3312b}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}
article.story{max-width:760px;margin:0 auto;background:rgba(255,255,255,.9);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border-radius:22px;padding:clamp(24px,6vw,64px);border:1px solid var(--glass-border);box-shadow:0 30px 80px -40px rgba(20,40,20,.4)}
.story header h1{font-weight:normal;font-size:clamp(32px,6vw,54px);line-height:1.04;text-transform:uppercase;margin-top:14px;overflow-wrap:break-word}
.story .dek{font-size:clamp(18px,2.4vw,22px);line-height:1.5;color:var(--ink-soft);margin-top:16px}
.story .byline{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:22px;padding-top:18px;border-top:1px solid var(--line)}
.story .lead-img{margin:28px calc(-1*clamp(24px,6vw,64px)) 0;}
.story .lead-img img{width:100%}
.prose{margin-top:32px}
.prose p,.prose li{font-size:18px;line-height:1.75;color:var(--body)}
.prose p+p,.prose p+ul,.prose p+ol,.prose ul+p,.prose ol+p{margin-top:18px}
.prose h2{font-weight:normal;font-size:clamp(21px,2.8vw,26px);line-height:1.2;text-transform:uppercase;letter-spacing:.02em;margin:44px 0 14px}
.prose h3{font-weight:normal;font-size:20px;line-height:1.3;margin:32px 0 10px}
.prose a{color:var(--forest);text-decoration-thickness:1px;text-underline-offset:3px}
.prose strong{font-weight:normal;color:var(--ink);background:linear-gradient(transparent 62%,rgba(47,93,58,.18) 0)}
.prose ul,.prose ol{padding-left:1.3em;margin-top:18px}
.prose li+li{margin-top:8px}
.prose li::marker{color:var(--forest)}
.prose blockquote{margin:30px 0;padding-left:22px;border-left:3px solid var(--forest)}
.prose blockquote p{font-size:clamp(20px,2.6vw,24px);line-height:1.5;color:var(--ink)}
.prose hr{border:0;height:1px;background:var(--line);margin:40px 0}
.prose figure{margin:30px 0}
.prose figure img{width:100%;border-radius:12px;background:#dfe7e0}
.prose figcaption{font-size:14px;line-height:1.5;color:var(--muted);margin-top:10px}
.embed{margin:30px 0;border-radius:12px;overflow:hidden;background:#141814;position:relative}
.embed.ratio{aspect-ratio:16/9}
.embed:not(.ratio){min-height:var(--h,166px)}
.embed iframe{display:block;width:100%;height:100%;border:0;min-height:var(--h,0)}
.embed-play{all:unset;cursor:pointer;display:flex;align-items:center;justify-content:center;width:100%;height:100%;min-height:inherit;position:absolute;inset:0}
.embed-play img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.75}
.embed-btn{position:relative;display:inline-flex;align-items:center;gap:8px;padding:12px 20px;border-radius:999px;background:#fff;color:var(--ink);font-size:12px;letter-spacing:.14em;text-transform:uppercase}
.embed-link{position:absolute;right:10px;bottom:8px;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#fff;opacity:.8}
.embed.playing .embed-link{display:none}
.callout{margin:30px 0;padding:20px 24px;background:#eef4ef;border-left:3px solid var(--forest);border-radius:0 14px 14px 0}
.prose .callout p{font-size:17px;line-height:1.65;color:var(--ink)}
.prose .callout p+p{margin-top:12px}
.gallery{margin:30px 0}
.gallery-grid{display:grid;gap:8px;grid-template-columns:repeat(2,1fr)}
@media(min-width:640px){.gallery:not(.two):not(.one) .gallery-grid{grid-template-columns:repeat(3,1fr)}}
.gallery.one .gallery-grid{grid-template-columns:1fr}
.gallery-grid a{display:block;border-radius:10px;overflow:hidden;background:#dfe7e0;aspect-ratio:1}
.gallery.one .gallery-grid a{aspect-ratio:auto}
.gallery-grid img{width:100%;height:100%;object-fit:cover}
.split{display:grid;gap:18px;margin:30px 0;align-items:center}
.split-img img{width:100%;border-radius:12px;background:#dfe7e0}
@media(min-width:640px){.split{grid-template-columns:1fr 1fr;gap:28px}.split.right .split-img{order:2}}
.prose .split-text p+p{margin-top:14px}
.event-card{display:flex;gap:18px;align-items:flex-start;margin:30px 0;padding:18px;border:1px solid var(--line);border-radius:16px;background:#fff}
.event-date{flex:none;width:68px;border-radius:12px;background:var(--ink);color:#fff;text-align:center;padding:9px 0;display:flex;flex-direction:column;gap:2px}
.event-date span{font-size:11px;letter-spacing:.16em;text-transform:uppercase;opacity:.85}
.event-date b{font-weight:normal;font-size:28px;line-height:1}
.event-info{display:flex;flex-direction:column;gap:6px;align-items:flex-start;min-width:0}
.prose .event-info h3{margin:0;font-size:21px;line-height:1.2}
.prose .event-info p{font-size:15px;line-height:1.5;color:var(--ink-soft)}
.event-info .pill{margin-top:6px;text-decoration:none}
.share{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:40px;padding-top:24px;border-top:1px solid var(--line)}
.share span{font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:var(--muted);margin-right:6px}
.share a,.share button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-width:44px;height:44px;padding:0 14px;border-radius:999px;border:1px solid var(--line);background:#fff;color:var(--ink);text-decoration:none;font:inherit;font-size:12px;letter-spacing:.1em;text-transform:uppercase;cursor:pointer}
.share a:hover,.share button:hover{border-color:var(--ink)}
.after{max-width:760px;margin:24px auto 0;display:grid;gap:24px}
.more h2{font-weight:normal;font-size:14px;letter-spacing:.2em;text-transform:uppercase;color:var(--ink);margin-bottom:12px}
.more .cards{grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))}
.more .card h2{font-size:17px;color:var(--ink);letter-spacing:.01em;margin:0}
.banner{position:sticky;top:0;z-index:5;background:#f4ead6;color:#7a5a1e;text-align:center;padding:10px 16px;font-size:13px;letter-spacing:.12em;text-transform:uppercase}
.notice{max-width:560px;margin:8vh auto;background:var(--glass);-webkit-backdrop-filter:var(--blur);backdrop-filter:var(--blur);border-radius:22px;padding:clamp(24px,6vw,48px);border:1px solid var(--glass-border);text-align:center;box-shadow:0 30px 80px -40px rgba(20,40,20,.4)}
.notice h1{font-weight:normal;font-size:clamp(26px,5vw,40px);text-transform:uppercase;line-height:1.1}
.notice p{font-size:17px;line-height:1.6;color:var(--ink-soft);margin:14px 0 22px}
footer{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;padding:36px var(--gutter);border-top:1px solid var(--line);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft)}
footer img{width:72px}
footer nav{display:flex;gap:18px;flex-wrap:wrap}
footer a{text-decoration:none}
@media(max-width:560px){footer{justify-content:center;text-align:center}.top nav{gap:14px}}`;
  }

  function pageScript() {
    // Embeds load only when tapped; share button copies the link; subscribe form posts to /stories/api/subscribe.
    return `document.addEventListener('click',function(e){
var b=e.target.closest('.embed-play');if(b){var box=b.closest('.embed'),f=document.createElement('iframe');f.src=box.dataset.src;f.title=b.getAttribute('aria-label');f.allow='autoplay; encrypted-media; fullscreen; picture-in-picture';f.allowFullscreen=true;if(box.dataset.h)f.height=box.dataset.h;box.classList.add('playing');b.replaceWith(f);return}
var c=e.target.closest('[data-copy]');if(c){var done=function(){c.querySelector('.label').textContent='Copied'};if(navigator.clipboard)navigator.clipboard.writeText(c.dataset.copy).then(done,function(){prompt('Copy this link',c.dataset.copy)});else prompt('Copy this link',c.dataset.copy)}});
(function(){var forms=document.querySelectorAll('.subscribe form');if(!forms.length)return;var key=document.body.dataset.ts,loading=null;
function ts(){if(!loading)loading=new Promise(function(ok,no){var s=document.createElement('script');s.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';s.async=true;s.onload=ok;s.onerror=no;document.head.appendChild(s)});return loading}
forms.forEach(function(form){var box=form.querySelector('.ts'),note=form.parentNode.querySelector('.note'),btn=form.querySelector('button'),wid=null;
function show(t,err){note.textContent=t;note.classList.toggle('error',!!err);note.hidden=!t}
function widget(){if(wid!==null)return;wid='loading';ts().then(function(){wid=turnstile.render(box,{sitekey:key,theme:'light'})},function(){wid=null;show('The spam check could not load. Check your connection and try again.',true)})}
form.querySelector('input[type=email]').addEventListener('focus',widget);
form.addEventListener('submit',function(e){e.preventDefault();widget();var data=new FormData(form);if(!data.get('cf-turnstile-response')){show('One moment: finishing the spam check, then press Subscribe again.');return}
btn.disabled=true;show('Sending…');fetch('/stories/api/subscribe',{method:'POST',body:data}).then(function(r){return r.json().then(function(j){return[r.ok,j]})}).then(function(x){if(x[0]){form.reset();show(x[1].message||'Check your inbox to confirm.')}else show(x[1].error||'Something went wrong. Please try again.',true)},function(){show('No connection. Please try again.',true)}).finally(function(){btn.disabled=false;if(window.turnstile&&wid!==null&&wid!=='loading')turnstile.reset(wid)})})})})();`;
  }

  function subscribeBox(env, {heading = 'Get new stories by email', text = 'Stories from the garden, the music and the people behind Zahabu, sent when there is something to tell. Free, and you can leave any time.'} = {}) {
    if (!newsletterReady(env)) return '';
    return `<section class="subscribe" aria-label="Subscribe">
<h2>${esc(heading)}</h2><p>${esc(text)}</p>
<form novalidate><input type="email" name="email" required maxlength="254" autocomplete="email" placeholder="Your email address" aria-label="Email address">
<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
<button class="pill dark" type="submit">Subscribe</button><div class="ts"></div></form>
<p class="note" hidden role="status"></p></section>`;
  }

  function layout(env, url, {title, description = '', canonical, image, body, robots, jsonLd, banner = ''}) {
    const base = site(env);
    const nonce = crypto.randomUUID().replace(/-/g, '');
    const isSite = url.origin === base;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${description ? `<meta name="description" content="${esc(description)}">` : ''}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}${robots || !isSite ? `<meta name="robots" content="${robots || 'noindex'}">` : ''}
<meta property="og:site_name" content="Zahabu Culture Garden"><meta property="og:title" content="${esc(title)}">${description ? `<meta property="og:description" content="${esc(description)}">` : ''}
${canonical ? `<meta property="og:url" content="${esc(canonical)}">` : ''}<meta property="og:type" content="${jsonLd ? 'article' : 'website'}">
${image ? `<meta property="og:image" content="${esc(image)}"><meta name="twitter:card" content="summary_large_image">` : '<meta name="twitter:card" content="summary">'}
<link rel="icon" href="${base}/favicon.ico"><link rel="alternate" type="application/rss+xml" title="Zahabu Stories" href="${base}/stories/feed.xml">
<style>${pageCss(base)}</style>
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
</head><body data-ts="${esc(env.TURNSTILE_SITE_KEY || '')}"><div class="bg-photo"></div><div class="bg-overlay"></div>${banner}
<header class="top"><a href="${base}/" aria-label="Zahabu home"><img src="${base}/images/logo-wordmark.png" alt="Zahabu" width="96" height="19"></a>
<nav><a href="${base}/stories"${url.pathname === '/stories' ? ' aria-current="page"' : ''}>Stories</a><a href="${base}/">Zahabu</a></nav></header>
${body}
<footer><img src="${base}/images/logo-wordmark.png" alt="Zahabu" width="72" height="14"><nav><a href="${base}/stories">Stories</a><a href="${base}/stories/feed.xml">RSS</a><a href="${base}/code-of-conduct.html">Code of conduct</a><a href="${base}/#contact">Contact</a></nav><span>© ${new Date().getFullYear()} Zahabu Culture Garden</span></footer>
<script nonce="${nonce}">${pageScript()}</script></body></html>`;
    const csp = [
      "default-src 'self'", `img-src 'self' ${base} https://i.ytimg.com data:`, `font-src 'self' ${base}`, "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}' https://challenges.cloudflare.com`, `frame-src https://challenges.cloudflare.com ${EMBED_HOSTS.join(' ')}`,
      "connect-src 'self'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'",
    ].join('; ');
    return new Response(html, {headers:{'Content-Type':'text/html; charset=utf-8', 'Content-Security-Policy':csp, 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'strict-origin-when-cross-origin', 'Cache-Control':'public, max-age=60'}});
  }

  function card(story, base, {lead = false} = {}) {
    const cover = story.cover_id ? `<div class="cover"><img src="${mediaUrl('', story.cover_id, lead ? 1600 : 800)}" alt="${esc(story.cover_alt)}" loading="${lead ? 'eager' : 'lazy'}" decoding="async"></div>` : '';
    return `<a class="card${lead ? ' lead' : ''}" href="${base}/stories/${story.slug}">${cover}<div class="text"><h2>${esc(story.title)}</h2>${story.subtitle ? `<p>${esc(story.subtitle)}</p>` : ''}<span class="meta">${story.section_name ? `${esc(story.section_name)} · ` : ''}${esc(formatDate(story.published_at))}${story.author ? ` · ${esc(story.author)}` : ''}</span></div></a>`;
  }

  // Section tabs: only sections with at least one published story.
  async function sectionTabs(env, base, current) {
    const {results} = await env.DB.prepare("SELECT sec.slug, sec.name FROM story_sections sec WHERE EXISTS (SELECT 1 FROM stories st WHERE st.section_id = sec.id AND st.status = 'published') ORDER BY sec.position, sec.name").all();
    if (!results.length) return '';
    return `<nav class="sections" aria-label="Sections"><a href="${base}/stories"${current ? '' : ' aria-current="page"'}>All</a>${results.map(row => `<a href="${base}/stories/section/${row.slug}"${current === row.slug ? ' aria-current="page"' : ''}>${esc(row.name)}</a>`).join('')}</nav>`;
  }

  // /stories (all) and /stories/section/<slug> (one section).
  async function indexPage(env, url, sectionSlug = null) {
    const base = site(env);
    let section = null;
    if (sectionSlug) {
      section = await env.DB.prepare('SELECT id, slug, name, description FROM story_sections WHERE slug = ?').bind(sectionSlug).first();
      if (!section) return notFound(env, url);
    }
    const page = Math.max(1, Math.min(500, Number.parseInt(url.searchParams.get('page') || '1', 10) || 1));
    const where = section ? "st.status = 'published' AND st.section_id = ?" : "st.status = 'published'";
    const binds = section ? [section.id] : [];
    const {results} = await env.DB.prepare(`${CARD_SQL} WHERE ${where} ORDER BY st.published_at DESC LIMIT ? OFFSET ?`).bind(...binds, PER_PAGE + 1, (page - 1) * PER_PAGE).all();
    const stories = results.slice(0, PER_PAGE);
    const path = section ? `/stories/section/${section.slug}` : '/stories';
    const cards = stories.map((story, index) => card(story, base, {lead:page === 1 && index === 0})).join('');
    const pager = page > 1 || results.length > PER_PAGE ? `<nav class="pager">${page > 1 ? `<a class="pill" href="${base}${path}${page > 2 ? `?page=${page - 1}` : ''}">Newer stories</a>` : '<span></span>'}${results.length > PER_PAGE ? `<a class="pill" href="${base}${path}?page=${page + 1}">Older stories</a>` : ''}</nav>` : '';
    const intro = section ? (section.description || `Stories in ${section.name}.`) : 'News, features and conversations from the garden: the nights, the music and the people who make Zahabu.';
    const body = `<main><section class="hero"><div>${section ? `<a class="eyebrow" href="${base}/stories">Stories</a>` : '<span class="eyebrow">Zahabu Culture Garden</span>'}<h1>${esc(section ? section.name : 'Stories')}</h1><p>${esc(intro)}</p></div>${subscribeBox(env)}</section>
${await sectionTabs(env, base, section?.slug)}
${stories.length ? `<div class="cards">${cards}</div>${pager}` : `<p class="empty">${section ? 'No stories in this section yet.' : 'The first stories are on their way.'}</p>`}</main>`;
    const title = `${section ? section.name : 'Stories'}${page > 1 ? ` (page ${page})` : ''} · ${section || page > 1 ? 'Zahabu' : 'Zahabu Culture Garden'}`;
    return layout(env, url, {title, description:section ? intro : 'News, features and conversations from Zahabu Culture Garden in Nairobi.', canonical:`${base}${path}${page > 1 ? `?page=${page}` : ''}`, body});
  }

  function storyArticle(env, story, sizes, more, {preview = false} = {}) {
    const base = site(env);
    const url = `${base}/stories/${story.slug || 'preview'}`;
    const words = wordCount(story.blocks);
    const minutes = Math.max(1, Math.round(words / 220));
    const share = preview ? '' : `<div class="share"><span>Share</span>
<a href="https://wa.me/?text=${encodeURIComponent(`${story.title} ${url}`)}" rel="noopener" target="_blank" aria-label="Share on WhatsApp">${icon('whatsapp')}<span class="label">WhatsApp</span></a>
<a href="https://twitter.com/intent/tweet?url=${encodeURIComponent(url)}&text=${encodeURIComponent(story.title)}" rel="noopener" target="_blank" aria-label="Share on X">${icon('x')}</a>
<a href="https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}" rel="noopener" target="_blank" aria-label="Share on Facebook">${icon('facebook')}</a>
<button type="button" data-copy="${esc(url)}">${icon('link')}<span class="label">Copy link</span></button></div>`;
    const cover = story.cover_id ? `<figure class="lead-img"><img src="${mediaUrl('', story.cover_id, 1600)}" srcset="${mediaUrl('', story.cover_id, 800)} 800w, ${mediaUrl('', story.cover_id, 1600)} 1600w" sizes="(max-width: 760px) 100vw, 760px"${sizes[story.cover_id] ? ` width="${sizes[story.cover_id].width}" height="${sizes[story.cover_id].height}"` : ''} alt="${esc(story.cover_alt)}"></figure>` : '';
    const moreHtml = more.length ? `<section class="more"><h2>More stories</h2><div class="cards">${more.map(row => card(row, base)).join('')}</div></section>` : '';
    const eyebrow = story.section_name ? `<a class="eyebrow" href="${base}/stories/section/${story.section_slug}">${esc(story.section_name)}</a>` : `<a class="eyebrow" href="${base}/stories">Stories</a>`;
    return `<main><article class="story"><header>${eyebrow}<h1>${esc(story.title || 'Untitled story')}</h1>${story.subtitle ? `<p class="dek">${esc(story.subtitle)}</p>` : ''}
<p class="byline">${story.author ? `By ${esc(story.author)} · ` : ''}${preview && !story.published_at ? 'Not published yet' : esc(formatDate(story.published_at))} · ${minutes} min read</p>${cover}</header>
<div class="prose">${renderBody(story.blocks, sizes, 'web', base)}</div>${share}</article>
<div class="after">${preview ? '' : subscribeBox(env, {heading:'Enjoyed this story?', text:'Get the next one by email. Free, and you can leave any time.'})}${moreHtml}</div></main>`;
  }

  async function storyPage(env, url, slug) {
    const base = site(env);
    const story = rowToStory(await env.DB.prepare(`${FULL_SQL} WHERE st.slug = ? AND st.status = 'published'`).bind(slug).first());
    if (!story) return notFound(env, url);
    const [sizes, more] = await Promise.all([
      imageSizes(env, imageIds(story)),
      env.DB.prepare(`${CARD_SQL} WHERE st.status = 'published' AND st.id != ? ORDER BY st.published_at DESC LIMIT 3`).bind(story.id).all().then(r => r.results),
    ]);
    const canonical = `${base}/stories/${story.slug}`;
    const description = story.subtitle || bodyText(story.blocks).replace(/\s+/g, ' ').slice(0, 180);
    const image = story.cover_id ? mediaUrl(base, story.cover_id, 1600) : null;
    const jsonLd = {'@context':'https://schema.org', '@type':'Article', headline:story.title, description, datePublished:story.published_at, dateModified:story.updated_at,
      ...(image ? {image:[image]} : {}), ...(story.section_name ? {articleSection:story.section_name} : {}), ...(story.author ? {author:{'@type':'Person', name:story.author}} : {}),
      publisher:{'@type':'Organization', name:'Zahabu Culture Garden', logo:{'@type':'ImageObject', url:`${base}/images/logo-wordmark.png`}}, mainEntityOfPage:canonical};
    return layout(env, url, {title:`${story.title} · Zahabu`, description, canonical, image, jsonLd, body:storyArticle(env, story, sizes, more)});
  }

  function notFound(env, url) {
    const response = layout(env, url, {title:'Story not found · Zahabu', robots:'noindex', body:`<main><div class="notice"><h1>Story not found</h1><p>It may have moved or been taken down.</p><a class="pill dark" href="${site(env)}/stories">All stories</a></div></main>`});
    return new Response(response.body, {status:404, headers:response.headers});
  }

  function noticePage(env, url, heading, text, extra = '') {
    return layout(env, url, {title:`${heading} · Zahabu Stories`, robots:'noindex', body:`<main><div class="notice"><h1>${esc(heading)}</h1><p>${esc(text)}</p>${extra || `<a class="pill dark" href="${site(env)}/stories">Read the stories</a>`}</div></main>`});
  }

  async function feed(env) {
    const base = site(env);
    const {results} = await env.DB.prepare(`${FULL_SQL} WHERE st.status = 'published' ORDER BY st.published_at DESC LIMIT 30`).all();
    const stories = results.map(rowToStory);
    const sizes = await imageSizes(env, [...new Set(stories.flatMap(imageIds))]);
    const cdata = text => `<![CDATA[${String(text).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
    const items = stories.map(story => {
      const link = `${base}/stories/${story.slug}`;
      const cover = story.cover_id ? `<p><img src="${mediaUrl(base, story.cover_id, 1600)}" alt="${esc(story.cover_alt)}"></p>` : '';
      return `<item><title>${esc(story.title)}</title><link>${link}</link><guid isPermaLink="true">${link}</guid><pubDate>${new Date(story.published_at).toUTCString()}</pubDate>
${story.author ? `<dc:creator>${esc(story.author)}</dc:creator>` : ''}${story.section_name ? `<category>${esc(story.section_name)}</category>` : ''}<description>${esc(story.subtitle || bodyText(story.blocks).slice(0, 300))}</description>
<content:encoded>${cdata(cover + renderBody(story.blocks, sizes, 'feed', base))}</content:encoded></item>`;
    }).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:atom="http://www.w3.org/2005/Atom"><channel>
<title>Zahabu Stories</title><link>${base}/stories</link><description>News, features and conversations from Zahabu Culture Garden in Nairobi.</description><language>en</language>
<atom:link href="${base}/stories/feed.xml" rel="self" type="application/rss+xml"/>
${items}
</channel></rss>`;
    return new Response(xml, {headers:{'Content-Type':'application/rss+xml; charset=utf-8', 'Cache-Control':'public, max-age=300'}});
  }

  async function sitemap(env) {
    const base = site(env);
    const {results} = await env.DB.prepare("SELECT slug, updated_at FROM stories WHERE status = 'published' ORDER BY published_at DESC LIMIT 5000").all();
    const {results:sections} = await env.DB.prepare("SELECT slug FROM story_sections sec WHERE EXISTS (SELECT 1 FROM stories st WHERE st.section_id = sec.id AND st.status = 'published') ORDER BY position").all();
    const urls = [`<url><loc>${base}/stories</loc></url>`, ...sections.map(row => `<url><loc>${base}/stories/section/${row.slug}</loc></url>`), ...results.map(row => `<url><loc>${base}/stories/${row.slug}</loc><lastmod>${row.updated_at.slice(0, 10)}</lastmod></url>`)];
    return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>`, {headers:{'Content-Type':'application/xml; charset=utf-8', 'Cache-Control':'public, max-age=3600'}});
  }

  async function media(env, id, size) {
    const object = await env.PHOTOS.get(`stories/${id}-${size}.jpg`);
    if (!object) return new Response('Not found', {status:404});
    return new Response(object.body, {headers:{'Content-Type':'image/jpeg', 'Cache-Control':'public, max-age=31536000, immutable', 'X-Content-Type-Options':'nosniff'}});
  }

  // ---------- Brevo (newsletter + confirmation emails) ----------

  const newsletterReady = env => Boolean((env.BREVO_API_KEY || env.BREVO_FAKE) && env.NEWSLETTER_FROM && env.BREVO_LIST_ID);

  async function brevo(env, path, body, method = 'POST') {
    if (env.BREVO_FAKE) return env.BREVO_FAKE(path, body, method);
    const response = await fetch(`https://api.brevo.com/v3${path}`, {method, headers:{'api-key':env.BREVO_API_KEY, 'content-type':'application/json', accept:'application/json'}, ...(body ? {body:JSON.stringify(body)} : {})});
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch {}
    if (!response.ok) {
      const error = new Error(data.message || `Brevo answered ${response.status}`);
      error.code = data.code || String(response.status);
      throw error;
    }
    return data;
  }
  const sender = env => ({name:env.NEWSLETTER_FROM_NAME || 'Zahabu', email:env.NEWSLETTER_FROM});
  const replyTo = env => ({email:env.NEWSLETTER_REPLY_TO || env.NEWSLETTER_FROM});

  function emailShell({preheader, inner, footer}) {
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light">
<style>@font-face{font-family:'Zahabu Futura';src:url('https://zahabu.co.ke/fonts/Futura-Regular.ttf') format('truetype');font-weight:normal;font-style:normal}</style></head>
<body style="margin:0;padding:0;background:#e9f0ea;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#e9f0ea;"><tr><td align="center" style="padding:24px 10px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:18px;font-family:${EMAIL_FONT};color:#141814;">
${inner}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;"><tr><td style="padding:18px 28px;font-family:${EMAIL_FONT};font-size:12px;line-height:1.6;color:#5f6a63;text-align:center;">${footer}</td></tr></table>
</td></tr></table></body></html>`;
  }

  function emailButton(label, href, primary = true) {
    const colours = primary ? 'background:#141814;color:#ffffff;border:1px solid #141814;' : 'background:#ffffff;color:#141814;border:1px solid #141814;';
    return `<a href="${esc(href)}" style="display:inline-block;margin:0 8px 8px 0;padding:12px 22px;border-radius:999px;${colours}font-family:${EMAIL_FONT};font-size:12px;letter-spacing:2px;text-transform:uppercase;text-decoration:none;">${esc(label)}</a>`;
  }

  // unsubscribe: Brevo's {{ unsubscribe }} tag for real sends; a plain link for test sends (Brevo only fills the tag in campaigns).
  function storyEmail(env, story, {unsubscribe, test = false}) {
    const base = site(env);
    const url = `${base}/stories/${story.slug}`;
    const cover = story.cover_id ? `<tr><td style="padding:22px 0 0;"><a href="${url}"><img src="${mediaUrl(base, story.cover_id, 1600)}" width="600" alt="${esc(story.cover_alt)}" style="display:block;width:100%;max-width:600px;height:auto;border:0;"></a></td></tr>` : '';
    const inner = `${test ? '<tr><td style="padding:10px 28px;background:#f4ead6;color:#7a5a1e;font-size:12px;letter-spacing:2px;text-transform:uppercase;text-align:center;border-radius:18px 18px 0 0;">Test email: only you got this</td></tr>' : ''}
<tr><td style="padding:24px 28px 0;"><a href="${base}/stories"><img src="${base}/images/logo-wordmark.png" width="104" alt="ZAHABU" style="display:block;width:104px;height:auto;border:0;font-size:20px;letter-spacing:3px;color:#141814;"></a></td></tr>
<tr><td style="padding:26px 28px 0;"><p style="margin:0 0 10px;font-size:11px;letter-spacing:3px;text-transform:uppercase;color:#5f6a63;">Zahabu Stories${story.section_name ? ` · ${esc(story.section_name)}` : ''}</p>
<h1 style="margin:0;font-size:28px;line-height:1.12;font-weight:normal;text-transform:uppercase;color:#141814;"><a href="${url}" style="color:#141814;text-decoration:none;">${esc(story.title)}</a></h1>
${story.subtitle ? `<p style="margin:12px 0 0;font-size:18px;line-height:1.5;color:#3d4640;">${esc(story.subtitle)}</p>` : ''}
<p style="margin:16px 0 0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#5f6a63;">${story.author ? `By ${esc(story.author)} · ` : ''}${esc(formatDate(story.published_at || now()))}</p></td></tr>
${cover}
<tr><td style="padding:26px 28px 0;">${renderBody(story.blocks, {}, 'email', base)}</td></tr>
<tr><td style="padding:8px 28px 30px;border-top:0;">${emailButton('Read on the website', url)}${emailButton('Share on WhatsApp', `https://wa.me/?text=${encodeURIComponent(`${story.title} ${url}`)}`, false)}</td></tr>`;
    const footer = `You're getting this because you subscribed to Zahabu Stories at <a href="${base}/stories" style="color:#5f6a63;">zahabu.co.ke/stories</a>.<br>
Zahabu Culture Garden · The Mall, Rooftop · Westlands, Nairobi<br><a href="${unsubscribe}" style="color:#5f6a63;">Unsubscribe</a>`;
    return emailShell({preheader:story.subtitle || bodyText(story.blocks).slice(0, 120), inner, footer});
  }

  function confirmEmail(env, token) {
    const base = site(env);
    const link = `${base}/stories/confirm?t=${token}`;
    const inner = `<tr><td style="padding:24px 28px 0;"><img src="${base}/images/logo-wordmark.png" width="104" alt="ZAHABU" style="display:block;width:104px;height:auto;border:0;"></td></tr>
<tr><td style="padding:26px 28px 30px;"><h1 style="margin:0;font-size:24px;line-height:1.2;font-weight:normal;text-transform:uppercase;">Confirm your subscription</h1>
<p style="margin:14px 0 22px;font-size:16px;line-height:1.6;color:#3d4640;">Someone (hopefully you) asked to get Zahabu Stories by email. Tap the button to confirm. If it wasn't you, ignore this email and nothing will happen.</p>
${emailButton('Confirm subscription', link)}
<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#5f6a63;">Or open this link: <a href="${link}" style="color:#2f5d3a;word-break:break-all;">${link}</a></p></td></tr>`;
    return {
      subject:'Confirm your subscription to Zahabu Stories',
      htmlContent:emailShell({preheader:'One tap to confirm.', inner, footer:'Zahabu Culture Garden · The Mall, Rooftop · Westlands, Nairobi'}),
      textContent:`Someone (hopefully you) asked to get Zahabu Stories by email.\n\nConfirm here: ${link}\n\nIf it wasn't you, ignore this email and nothing will happen.\n\nZahabu Culture Garden, Nairobi`,
    };
  }

  // ---------- Subscribing ----------

  const EMAIL_PATTERN = /^[^\s@<>"(),;:]+@[^\s@<>"(),;:]+\.[a-z]{2,}$/i;
  const newToken = () => [...crypto.getRandomValues(new Uint8Array(24))].map(byte => byte.toString(16).padStart(2, '0')).join('');

  async function subscribe(request, env, url) {
    const origin = request.headers.get('origin');
    if (origin !== url.origin && !allowedOrigins(env).includes(origin)) return json({error:'Sign-ups are only accepted from zahabu.co.ke.'}, 403);
    if (!newsletterReady(env)) return json({error:'Email sign-up isn\'t open yet. Please check back soon.'}, 503);
    let form;
    try { form = await request.formData(); } catch { return json({error:'Could not read the form.'}, 400); }
    const message = 'Almost done: check your inbox (and spam folder) for an email from Zahabu and tap Confirm.';
    if (String(form.get('website') || '')) return json({ok:true, message}, 201);
    const email = String(form.get('email') || '').trim().toLowerCase();
    if (email.length > 254 || !EMAIL_PATTERN.test(email)) return json({error:'Please enter a valid email address.'}, 400);
    const ip = request.headers.get('cf-connecting-ip') || '';
    if (!(await verifyTurnstile(form.get('cf-turnstile-response'), ip, env))) return json({error:'Spam check failed. Please try again.'}, 400);
    const ipHash = await hashIp(ip, env);
    const recent = await env.DB.prepare('SELECT COUNT(*) AS n FROM subscribers WHERE ip_hash = ? AND created_at > ?').bind(ipHash, new Date(Date.now() - 3600_000).toISOString()).first();
    if ((recent?.n || 0) >= MAX_SUBSCRIBES_PER_IP_PER_HOUR) return json({error:'Too many sign-ups from this connection. Please try again later.'}, 429);

    const existing = await env.DB.prepare('SELECT id, status, token, created_at FROM subscribers WHERE email = ?').bind(email).first();
    // The same answer every time, so the form never reveals who is already subscribed.
    if (existing?.status === 'confirmed') return json({ok:true, message}, 201);
    let token;
    if (!existing) {
      token = newToken();
      await env.DB.prepare('INSERT INTO subscribers (id, email, status, token, created_at, ip_hash) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), email, 'pending', token, now(), ipHash).run();
    } else {
      token = existing.status === 'pending' ? existing.token : newToken();
      await env.DB.prepare("UPDATE subscribers SET status = 'pending', token = ?, created_at = ?, ip_hash = ? WHERE id = ?").bind(token, now(), ipHash, existing.id).run();
    }
    try {
      await brevo(env, '/smtp/email', {sender:sender(env), replyTo:replyTo(env), to:[{email}], ...confirmEmail(env, token), tags:['stories-confirm']});
    } catch (error) {
      console.error('Stories confirmation email failed', JSON.stringify({code:error.code, message:String(error.message)}));
      return json({error:'We couldn\'t send the confirmation email right now. Please try again in a few minutes.'}, 502);
    }
    return json({ok:true, message}, 201);
  }

  async function syncToBrevo(env, subscriber) {
    try {
      await brevo(env, '/contacts', {email:subscriber.email, listIds:[Number(env.BREVO_LIST_ID)], updateEnabled:true, emailBlacklisted:false});
      await env.DB.prepare('UPDATE subscribers SET brevo_synced_at = ?, brevo_error = NULL WHERE id = ?').bind(now(), subscriber.id).run();
      return true;
    } catch (error) {
      console.error('Brevo contact sync failed', JSON.stringify({code:error.code, message:String(error.message)}));
      await env.DB.prepare('UPDATE subscribers SET brevo_error = ? WHERE id = ?').bind(String(error.code || error.message).slice(0, 200), subscriber.id).run();
      return false;
    }
  }

  async function confirmPage(env, url) {
    const token = url.searchParams.get('t') || '';
    const row = /^[0-9a-f]{48}$/.test(token) ? await env.DB.prepare('SELECT status FROM subscribers WHERE token = ?').bind(token).first() : null;
    if (!row) return noticePage(env, url, 'Link expired', 'This confirmation link is no longer valid. Sign up again and we will send a fresh one.');
    if (row.status === 'confirmed') return noticePage(env, url, 'You\'re subscribed', 'New Zahabu stories will come straight to your inbox.');
    return noticePage(env, url, 'One last step', 'Tap the button to start getting Zahabu Stories by email.',
      `<form method="post" action="/stories/api/confirm"><input type="hidden" name="t" value="${esc(token)}"><button class="pill dark" type="submit">Confirm subscription</button></form>`);
  }

  async function confirm(request, env, url) {
    if (!sameOrigin(request, url) && !allowedOrigins(env).includes(request.headers.get('origin'))) return new Response('Request blocked.', {status:403});
    let token = '';
    try { token = String((await request.formData()).get('t') || ''); } catch {}
    const subscriber = /^[0-9a-f]{48}$/.test(token) ? await env.DB.prepare('SELECT id, email, status FROM subscribers WHERE token = ?').bind(token).first() : null;
    if (!subscriber) return noticePage(env, url, 'Link expired', 'This confirmation link is no longer valid. Sign up again and we will send a fresh one.');
    if (subscriber.status !== 'confirmed') {
      await env.DB.prepare("UPDATE subscribers SET status = 'confirmed', confirmed_at = ?, unsubscribed_at = NULL WHERE id = ?").bind(now(), subscriber.id).run();
      await syncToBrevo(env, subscriber);
    }
    return noticePage(env, url, 'You\'re subscribed', 'Thank you. New Zahabu stories will come straight to your inbox.');
  }

  // Brevo → us: unsubscribes, hard bounces and spam complaints. The webhook address is public, so its body is only a hint:
  // each email is looked up in Brevo (with our API key) and marked unsubscribed here only if Brevo agrees it has left the list.
  async function brevoWebhook(request, env) {
    if (!newsletterReady(env)) return json({ok:true});
    let events;
    try { events = await request.json(); } catch { return json({error:'Bad JSON.'}, 400); }
    const emails = [...new Set([events].flat().filter(event => ['unsubscribed', 'hard_bounce', 'spam', 'contact_deleted', 'list_deletion', 'blocked'].includes(event?.event))
      .map(event => String(event.email || '').trim().toLowerCase()).filter(email => EMAIL_PATTERN.test(email)))].slice(0, 50);
    const listId = Number(env.BREVO_LIST_ID);
    let marked = 0;
    for (const email of emails) {
      const row = await env.DB.prepare("SELECT id FROM subscribers WHERE email = ? AND status != 'unsubscribed'").bind(email).first();
      if (!row) continue;
      let contact = null;
      try {
        contact = await brevo(env, `/contacts/${encodeURIComponent(email)}`, null, 'GET');
      } catch (error) {
        if (!['404', 'document_not_found'].includes(String(error.code))) { console.warn('Brevo contact lookup failed', JSON.stringify({code:error.code})); continue; }
      }
      const left = !contact || contact.emailBlacklisted || (contact.listUnsubscribed || []).includes(listId) || !(contact.listIds || []).includes(listId);
      if (!left) continue;
      await env.DB.prepare("UPDATE subscribers SET status = 'unsubscribed', unsubscribed_at = ? WHERE id = ?").bind(now(), row.id).run();
      marked++;
    }
    return json({ok:true, marked});
  }

  // ---------- Public router ----------

  async function publicRoute(request, env, url) {
    const base = site(env);
    // www and trailing slashes → one address per page.
    if (url.hostname === `www.${new URL(base).hostname}`) return Response.redirect(`${base}${url.pathname}${url.search}`, 301);
    const path = url.pathname.length > 8 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    if (path !== url.pathname && request.method === 'GET') return Response.redirect(`${url.origin}${path}${url.search}`, 301);

    if (path === '/stories/api/subscribe') {
      if (request.method === 'GET') return json({ready:newsletterReady(env)}, 200, {'Cache-Control':'public, max-age=300'});
      if (request.method === 'POST') return subscribe(request, env, url);
      return json({error:'Method not allowed.'}, 405);
    }
    if (path === '/stories/api/confirm' && request.method === 'POST') return confirm(request, env, url);
    if (path === '/stories/api/brevo-webhook' && request.method === 'POST') return brevoWebhook(request, env);

    if (!['GET', 'HEAD'].includes(request.method)) return new Response('Method not allowed', {status:405});
    if (path === '/stories' || path === '/stories/') return indexPage(env, url);
    if (path === '/stories/feed.xml') return feed(env);
    if (path === '/stories/sitemap.xml') return sitemap(env);
    if (path === '/stories/confirm') return confirmPage(env, url);
    const sectionMatch = path.match(/^\/stories\/section\/([a-z0-9-]{1,80})$/);
    if (sectionMatch) return indexPage(env, url, sectionMatch[1]);
    if (path === '/stories/api/latest') {
      const limit = Math.max(1, Math.min(12, Number.parseInt(url.searchParams.get('limit') || '3', 10) || 3));
      // ?by=section: the newest story in each section, in section order (landing page), so every section shows up.
      // Falls back to the newest stories overall while no published story has a section.
      let results = [];
      if (url.searchParams.get('by') === 'section') {
        results = (await env.DB.prepare(`SELECT * FROM (SELECT st.id, st.slug, st.title, st.subtitle, st.author, st.cover_id, st.cover_alt, st.published_at, sec.name AS section_name, sec.slug AS section_slug, sec.position AS section_position,
          ROW_NUMBER() OVER (PARTITION BY st.section_id ORDER BY st.published_at DESC) AS rn
          FROM stories st JOIN story_sections sec ON sec.id = st.section_id WHERE st.status = 'published') WHERE rn = 1 ORDER BY section_position, section_name LIMIT ?`).bind(limit).all()).results;
      }
      if (!results.length) results = (await env.DB.prepare(`${CARD_SQL} WHERE st.status = 'published' ORDER BY st.published_at DESC LIMIT ?`).bind(limit).all()).results;
      return json({stories:results.map(row => publicStory(row, base))}, 200, {'Cache-Control':'public, max-age=60', 'Access-Control-Allow-Origin':'*'});
    }
    const mediaMatch = path.match(/^\/stories\/media\/([0-9a-f-]{36})-(800|1600)\.jpg$/);
    if (mediaMatch) return media(env, mediaMatch[1], mediaMatch[2]);
    const slugMatch = path.match(/^\/stories\/([a-z0-9-]{1,80})$/);
    if (slugMatch) return storyPage(env, url, slugMatch[1]);
    return notFound(env, url);
  }

  // ---------- Staff: editor API ----------

  const LIST_COLUMNS = 'id, slug, title, subtitle, author, cover_id AS coverId, section_id AS sectionId, status, published_at AS publishedAt, updated_at AS updatedAt, updated_by AS updatedBy, newsletter_sent_at AS newsletterSentAt, newsletter_sent_by AS newsletterSentBy, newsletter_error AS newsletterError';
  function storyJson(row) {
    const story = rowToStory(row);
    return {id:story.id, slug:story.slug, title:story.title, subtitle:story.subtitle, author:story.author, coverId:story.cover_id, coverAlt:story.cover_alt, sectionId:story.section_id || null, body:story.blocks,
      status:story.status, publishedAt:story.published_at, createdAt:story.created_at, createdBy:story.created_by, updatedAt:story.updated_at, updatedBy:story.updated_by,
      newsletterSentAt:story.newsletter_sent_at, newsletterSentBy:story.newsletter_sent_by, newsletterError:story.newsletter_error};
  }

  function slugify(text) {
    const slug = String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/['’]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72).replace(/-+$/, '');
    return slug || 'story';
  }

  async function uniqueSlug(env, wanted, id) {
    let base = slugify(wanted);
    if (RESERVED_SLUGS.has(base)) base = `${base}-story`;
    for (let n = 1; n < 100; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const taken = await env.DB.prepare('SELECT id FROM stories WHERE slug = ? AND id != ?').bind(slug, id).first();
      if (!taken) return slug;
    }
    return `${base}-${Date.now().toString(36)}`;
  }

  // Returns {fields} or {error}.
  function readStoryFields(input) {
    if (!input || typeof input !== 'object') return {error:'Could not read the story.'};
    const line = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
    const fields = {title:line(input.title, MAX.title), subtitle:line(input.subtitle, MAX.subtitle), author:line(input.author, MAX.author), coverAlt:line(input.coverAlt, MAX.alt)};
    if (input.coverId && !ID.test(input.coverId)) return {error:'That cover photo could not be found.'};
    fields.coverId = input.coverId || null;
    if (input.sectionId && !SECTION_ID.test(input.sectionId)) return {error:'That section could not be found.'};
    fields.sectionId = input.sectionId || null;
    const {blocks, error} = cleanBody(input.body ?? []);
    if (error) return {error};
    fields.blocks = blocks;
    if (input.slug !== undefined && input.slug !== null && input.slug !== '') {
      const slug = slugify(input.slug);
      if (!SLUG.test(slug)) return {error:'The web address can only use letters, numbers and dashes.'};
      fields.slug = slug;
    }
    return {fields};
  }

  async function readImage(form, name, size) {
    const file = form.get(name);
    if (!file || typeof file.arrayBuffer !== 'function') return {error:'Photo missing.'};
    if (file.size > MAX_IMAGE_BYTES[size]) return {error:'That photo is too large. Try a smaller one.'};
    // The editor re-encodes every photo to JPEG in the browser; sanitizeJpeg strips any metadata left and reads the real size.
    const clean = sanitizeJpeg(new Uint8Array(await file.arrayBuffer()));
    if (!clean) return {error:'That file is not a photo we can use (JPEG, PNG or WebP).'};
    return clean;
  }

  async function uploadImage(request, env, email) {
    if (Number(request.headers.get('content-length') || 0) > 4 * 1024 * 1024) return json({error:'That photo is too large.'}, 413);
    let form;
    try { form = await request.formData(); } catch { return json({error:'Could not read the upload.'}, 400); }
    const large = await readImage(form, 'large', 1600);
    if (large.error) return json({error:large.error}, 400);
    const small = await readImage(form, 'small', 800);
    if (small.error) return json({error:small.error}, 400);
    const id = crypto.randomUUID();
    await env.PHOTOS.put(`stories/${id}-1600.jpg`, large.bytes, {httpMetadata:{contentType:'image/jpeg'}});
    await env.PHOTOS.put(`stories/${id}-800.jpg`, small.bytes, {httpMetadata:{contentType:'image/jpeg'}});
    await env.DB.prepare('INSERT INTO story_images (id, width, height, created_at, created_by) VALUES (?, ?, ?, ?, ?)').bind(id, large.width, large.height, now(), email).run();
    return json({id, width:large.width, height:large.height, url:mediaUrl('', id, 1600)}, 201);
  }

  async function sendNewsletter(env, id, email) {
    if (!newsletterReady(env)) return json({error:'Newsletter sending isn\'t set up yet (Brevo key, sender and list).'}, 503);
    const story = rowToStory(await env.DB.prepare(`${FULL_SQL} WHERE st.id = ?`).bind(id).first());
    if (!story) return json({error:'That story no longer exists.'}, 404);
    if (story.status !== 'published') return json({error:'Publish the story before emailing it.'}, 400);
    // Claim the send first, so two people pressing Send at once can't email everyone twice.
    const claimed = await env.DB.prepare('UPDATE stories SET newsletter_sent_at = ?, newsletter_sent_by = ?, newsletter_error = NULL WHERE id = ? AND newsletter_sent_at IS NULL').bind(now(), email, id).run();
    if (!(claimed?.meta?.changes ?? claimed?.changes)) return json({error:'This story has already been emailed to subscribers.'}, 409);
    let campaignId = null;
    try {
      const created = await brevo(env, '/emailCampaigns', {
        name:`Story: ${story.title}`.slice(0, 200), subject:story.title, previewText:story.subtitle || undefined,
        sender:sender(env), replyTo:replyTo(env).email, htmlContent:storyEmail(env, story, {unsubscribe:'{{ unsubscribe }}'}),
        // No campaign tag: Brevo's free plan refuses campaigns that have one ("not allowed to avail tag option").
        recipients:{listIds:[Number(env.BREVO_LIST_ID)]},
      });
      campaignId = String(created.id);
      await env.DB.prepare('UPDATE stories SET newsletter_campaign_id = ? WHERE id = ?').bind(campaignId, id).run();
      await brevo(env, `/emailCampaigns/${campaignId}/sendNow`, null);
    } catch (error) {
      const reason = String(error.message || error.code || 'send failed').slice(0, 300);
      console.error('Newsletter send failed', JSON.stringify({id, campaignId, code:error.code, message:reason}));
      // Nothing went out, so free the story to try again (the half-made campaign stays as a draft in Brevo).
      await env.DB.prepare('UPDATE stories SET newsletter_sent_at = NULL, newsletter_sent_by = NULL, newsletter_error = ? WHERE id = ?').bind(reason, id).run();
      return json({error:`Brevo didn't send it: ${reason}`}, 502);
    }
    return json({ok:true, campaignId});
  }

  // ---------- Staff: sections ----------

  const sectionExists = async (env, id) => !id || !!(await env.DB.prepare('SELECT id FROM story_sections WHERE id = ?').bind(id).first());
  const listSections = async env => (await env.DB.prepare('SELECT id, slug, name, description, position, (SELECT COUNT(*) FROM stories st WHERE st.section_id = story_sections.id) AS storyCount FROM story_sections ORDER BY position, name').all()).results;

  async function sectionsRoute(request, env, url) {
    const path = url.pathname;
    if (path === '/admin/api/story-sections' && request.method === 'GET') return json({sections:await listSections(env)});
    let input = {};
    if (request.method !== 'GET' && request.method !== 'DELETE') { try { input = await request.json(); } catch { return json({error:'Could not read that.'}, 400); } }
    const name = cleanLine(input.name, 40);
    const description = cleanLine(input.description, 200);
    if (path === '/admin/api/story-sections' && request.method === 'POST') {
      if (!name) return json({error:'Give the section a name.'}, 400);
      let base = slugify(name);
      if (RESERVED_SLUGS.has(base)) base = `${base}-section`;
      let slug = base;
      for (let n = 2; await env.DB.prepare('SELECT id FROM story_sections WHERE slug = ?').bind(slug).first(); n++) slug = `${base}-${n}`;
      const last = await env.DB.prepare('SELECT MAX(position) AS p FROM story_sections').first();
      await env.DB.prepare('INSERT INTO story_sections (id, slug, name, description, position, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(), slug, name, description, (last?.p || 0) + 1, now()).run();
      return json({sections:await listSections(env)}, 201);
    }
    if (path === '/admin/api/story-sections/order' && request.method === 'POST') {
      const ids = Array.isArray(input.ids) ? input.ids.filter(id => SECTION_ID.test(id)).slice(0, 100) : [];
      for (const [index, id] of ids.entries()) await env.DB.prepare('UPDATE story_sections SET position = ? WHERE id = ?').bind(index + 1, id).run();
      return json({sections:await listSections(env)});
    }
    const match = path.match(/^\/admin\/api\/story-sections\/([a-z0-9-]{3,64})$/);
    if (!match) return null;
    const section = await env.DB.prepare('SELECT id FROM story_sections WHERE id = ?').bind(match[1]).first();
    if (!section) return json({error:'That section no longer exists.'}, 404);
    if (request.method === 'PUT') {
      if (!name) return json({error:'A section needs a name.'}, 400);
      // The slug (web address) stays the same when a section is renamed, so shared links keep working.
      await env.DB.prepare('UPDATE story_sections SET name = ?, description = ? WHERE id = ?').bind(name, description, section.id).run();
      return json({sections:await listSections(env)});
    }
    if (request.method === 'DELETE') {
      const used = await env.DB.prepare('SELECT COUNT(*) AS n FROM stories WHERE section_id = ?').bind(section.id).first();
      if (used?.n) return json({error:`${used.n} ${used.n === 1 ? 'story is' : 'stories are'} in this section. Move ${used.n === 1 ? 'it' : 'them'} to another section first.`}, 400);
      await env.DB.prepare('DELETE FROM story_sections WHERE id = ?').bind(section.id).run();
      return json({sections:await listSections(env)});
    }
    return json({error:'Method not allowed.'}, 405);
  }

  async function adminRoute(request, env, url, email) {
    const path = url.pathname;
    const write = !['GET', 'HEAD'].includes(request.method);
    if (write && (path.startsWith('/admin/api/stor') || path.startsWith('/admin/api/subscribers')) && !sameOrigin(request, url)) return json({error:'Request blocked.'}, 403);

    const previewMatch = path.match(/^\/admin\/stories\/([0-9a-f-]{36})\/preview$/);
    if (previewMatch && request.method === 'GET') {
      const story = rowToStory(await env.DB.prepare(`${FULL_SQL} WHERE st.id = ?`).bind(previewMatch[1]).first());
      if (!story) return new Response('Not found', {status:404});
      const sizes = await imageSizes(env, imageIds(story));
      const banner = `<div class="banner">Preview${story.status === 'published' ? ' of the live story, as last saved' : ': not published yet'}</div>`;
      return layout(env, url, {title:`Preview: ${story.title || 'Untitled'}`, robots:'noindex', banner, body:storyArticle(env, story, sizes, [], {preview:true})});
    }

    if (path.startsWith('/admin/api/story-sections')) {
      const response = await sectionsRoute(request, env, url);
      if (response) return response;
    }

    if (path === '/admin/api/stories' && request.method === 'GET') {
      const [{results}, counts, sections] = await Promise.all([
        env.DB.prepare(`SELECT ${LIST_COLUMNS} FROM stories ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END, COALESCE(published_at, updated_at) DESC LIMIT 500`).all(),
        env.DB.prepare("SELECT SUM(status = 'confirmed') AS confirmed, SUM(status = 'pending') AS pending, SUM(status = 'unsubscribed') AS unsubscribed FROM subscribers").first(),
        listSections(env),
      ]);
      return json({email, stories:results, sections, subscribers:{confirmed:counts?.confirmed || 0, pending:counts?.pending || 0, unsubscribed:counts?.unsubscribed || 0},
        newsletter:{ready:newsletterReady(env), from:env.NEWSLETTER_FROM || null, fromName:sender(env).name}, site:site(env)});
    }

    if (path === '/admin/api/stories' && request.method === 'POST') {
      let input = {};
      try { input = await request.json(); } catch {}
      const {fields, error} = readStoryFields(input);
      if (error) return json({error}, 400);
      if (!(await sectionExists(env, fields.sectionId))) return json({error:'That section no longer exists. Pick another.'}, 400);
      const id = crypto.randomUUID();
      const stamp = now();
      await env.DB.prepare('INSERT INTO stories (id, title, subtitle, author, cover_id, cover_alt, section_id, body, status, created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(id, fields.title, fields.subtitle, fields.author, fields.coverId, fields.coverAlt, fields.sectionId, JSON.stringify(fields.blocks), 'draft', stamp, email, stamp, email).run();
      return json({story:storyJson(await env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(id).first())}, 201);
    }

    const storyMatch = path.match(/^\/admin\/api\/stories\/([0-9a-f-]{36})(?:\/(publish|unpublish|test-email|send))?$/);
    if (storyMatch) {
      const [, id, action] = storyMatch;
      const row = await env.DB.prepare(`${FULL_SQL} WHERE st.id = ?`).bind(id).first();
      if (!row) return json({error:'That story no longer exists. Someone may have deleted it.'}, 404);

      if (!action && request.method === 'GET') return json({story:storyJson(row)});

      if (!action && request.method === 'PUT') {
        let input;
        try { input = await request.json(); } catch { return json({error:'Could not read the story.'}, 400); }
        // Two people editing the same story: the second save is refused instead of silently overwriting the first.
        if (input.baseUpdatedAt && input.baseUpdatedAt !== row.updated_at) {
          return json({error:`${row.updated_by} saved this story at ${new Date(row.updated_at).toLocaleTimeString('en-GB', {timeZone:'Africa/Nairobi', hour:'2-digit', minute:'2-digit'})}. Reload to see their changes before saving yours.`, conflict:true}, 409);
        }
        const {fields, error} = readStoryFields(input);
        if (error) return json({error}, 400);
        if (!(await sectionExists(env, fields.sectionId))) return json({error:'That section no longer exists. Pick another.'}, 400);
        let slug = row.slug;
        if (fields.slug && fields.slug !== row.slug) slug = await uniqueSlug(env, fields.slug, id);
        if (row.status === 'published' && (!fields.title || !fields.blocks.length)) return json({error:'A published story needs a title and some text.'}, 400);
        await env.DB.prepare('UPDATE stories SET title = ?, subtitle = ?, author = ?, cover_id = ?, cover_alt = ?, section_id = ?, body = ?, slug = ?, updated_at = ?, updated_by = ? WHERE id = ?')
          .bind(fields.title, fields.subtitle, fields.author, fields.coverId, fields.coverAlt, fields.sectionId, JSON.stringify(fields.blocks), slug, now(), email, id).run();
        return json({story:storyJson(await env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(id).first())});
      }

      if (!action && request.method === 'DELETE') {
        if (row.status === 'published') return json({error:'Unpublish the story before deleting it.'}, 400);
        await env.DB.prepare('DELETE FROM stories WHERE id = ?').bind(id).run();
        return json({ok:true});
      }

      if (action === 'publish' && request.method === 'POST') {
        const story = rowToStory(row);
        if (!story.title) return json({error:'Give the story a title before publishing.'}, 400);
        if (!story.blocks.length) return json({error:'The story has no text yet.'}, 400);
        const slug = row.slug || await uniqueSlug(env, story.title, id);
        await env.DB.prepare("UPDATE stories SET status = 'published', slug = ?, published_at = COALESCE(published_at, ?), updated_at = ?, updated_by = ? WHERE id = ?").bind(slug, now(), now(), email, id).run();
        return json({story:storyJson(await env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(id).first())});
      }

      if (action === 'unpublish' && request.method === 'POST') {
        await env.DB.prepare("UPDATE stories SET status = 'draft', updated_at = ?, updated_by = ? WHERE id = ?").bind(now(), email, id).run();
        return json({story:storyJson(await env.DB.prepare('SELECT * FROM stories WHERE id = ?').bind(id).first())});
      }

      if (action === 'test-email' && request.method === 'POST') {
        if (!newsletterReady(env)) return json({error:'Newsletter sending isn\'t set up yet (Brevo key, sender and list).'}, 503);
        let input = {};
        try { input = await request.json(); } catch {}
        const to = String(input.to || '').trim().toLowerCase();
        if (!EMAIL_PATTERN.test(to) || to.length > 254) return json({error:'Enter the email address to send the test to.'}, 400);
        const story = rowToStory(row);
        if (!story.title || !story.blocks.length) return json({error:'Add a title and some text first.'}, 400);
        const preview = {...story, slug:story.slug || slugify(story.title)};
        try {
          await brevo(env, '/smtp/email', {sender:sender(env), replyTo:replyTo(env), to:[{email:to}], subject:`[Test] ${story.title}`,
            htmlContent:storyEmail(env, preview, {unsubscribe:`${site(env)}/stories`, test:true}), tags:['stories-test']});
        } catch (error) {
          return json({error:`Brevo didn't send the test: ${String(error.message || error.code)}`}, 502);
        }
        return json({ok:true});
      }

      if (action === 'send' && request.method === 'POST') return sendNewsletter(env, id, email);
      return json({error:'Method not allowed.'}, 405);
    }

    if (path === '/admin/api/story-images' && request.method === 'POST') return uploadImage(request, env, email);

    if (path === '/admin/api/subscribers' && request.method === 'GET') {
      const {results} = await env.DB.prepare('SELECT email, status, created_at AS createdAt, confirmed_at AS confirmedAt, unsubscribed_at AS unsubscribedAt, source, brevo_error AS brevoError FROM subscribers ORDER BY created_at DESC LIMIT 5000').all();
      return json({subscribers:results});
    }

    return null;
  }

  return {publicRoute, adminRoute, cleanBody, parseEmbed, renderBody, storyEmail, slugify};
}
