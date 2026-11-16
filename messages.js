// Staff Messages page: contact form + vendor form enquiries, from GET /admin/api/messages (photos-worker.mjs).
const list = document.getElementById('list');
const empty = document.getElementById('empty');
const message = document.getElementById('message');
const search = document.getElementById('search');
const openCount = document.getElementById('openCount');
const tabs = [...document.querySelectorAll('.tab')];
const filters = [...document.querySelectorAll('.filter')];
let status = 'open';
let filter = 'all';
let messages = [];

const dateFormat = new Intl.DateTimeFormat('en-KE', {dateStyle:'medium', timeStyle:'short', timeZone:'Africa/Nairobi'});
const dayFormat = new Intl.DateTimeFormat('en-KE', {dateStyle:'medium', timeZone:'UTC'});

function showMessage(text, isError = false) {
  message.textContent = text;
  message.classList.toggle('error', isError);
  message.hidden = !text;
}

async function api(path, options = {}) {
  const response = await fetch(path, {credentials:'same-origin', ...options});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Kenyan numbers are usually typed as 07… or 01…; WhatsApp links need 2547…
function whatsappNumber(phone) {
  let digits = (phone || '').replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) digits = `254${digits.slice(1)}`;
  else if (/^[17]\d{8}$/.test(digits)) digits = `254${digits}`;
  return digits.length >= 9 ? digits : '';
}

function link(className, text, href) {
  const a = el('a', className, text);
  a.href = href;
  if (href.startsWith('http')) { a.target = '_blank'; a.rel = 'noopener'; }
  return a;
}

function item(msg) {
  const details = el('details', 'item');
  const summary = el('summary');
  const whoLine = el('span', 'who-line', msg.kind === 'vendor' ? msg.business : msg.name);
  if (msg.kind === 'vendor') whoLine.append(el('span', 'business', ` · ${msg.name}`));
  const when = el('time', 'when', dateFormat.format(new Date(msg.createdAt)));
  when.dateTime = msg.createdAt;
  const tags = el('span', 'tags');
  tags.append(el('span', msg.kind === 'vendor' ? 'tag vendor' : 'tag', msg.kind === 'vendor' ? `Vendor · ${msg.category}` : msg.category));
  if (msg.photos?.length) tags.append(el('span', 'tag', `${msg.photos.length} photo${msg.photos.length > 1 ? 's' : ''}`));
  if (msg.emailFailed) tags.append(el('span', 'tag warn', 'Email not sent'));
  summary.append(whoLine, when, tags, el('span', 'snippet', msg.message.replace(/\s+/g, ' ')));

  const body = el('div', 'body');
  const facts = el('dl', 'facts');
  const fact = (label, value) => { if (value) facts.append(el('dt', '', label), el('dd', '', value)); };
  fact('Name', msg.name);
  if (msg.kind === 'vendor') fact('Business', msg.business);
  fact('Email', msg.email);
  fact('Phone / WhatsApp', msg.phone);
  fact('Links', msg.links);
  fact('Nights', msg.nights);
  fact('Needs electricity', msg.power);
  if (msg.eventDate) fact('Event date', dayFormat.format(new Date(`${msg.eventDate}T00:00:00Z`)));
  body.append(facts, el('p', 'text', msg.message));

  // Photos are only fetched when a message is opened, to save data.
  if (msg.photos?.length) {
    const photos = el('div', 'photos');
    body.append(photos);
    details.addEventListener('toggle', () => {
      if (!details.open || photos.children.length) return;
      photos.append(...msg.photos.map((src, n) => {
        const a = link('', '', src);
        a.target = '_blank';
        const img = el('img');
        img.src = src;
        img.alt = `Photo ${n + 1}`;
        a.append(img);
        return a;
      }));
    });
  }

  const actions = el('div', 'actions');
  const subject = msg.kind === 'vendor' ? `Re: Your vendor enquiry (${msg.business})` : `Re: Your message to Zahabu (${msg.category})`;
  actions.append(link('btn primary', 'Reply by email', `mailto:${encodeURIComponent(msg.email)}?subject=${encodeURIComponent(subject)}`));
  const wa = whatsappNumber(msg.phone);
  if (wa) actions.append(link('btn', 'WhatsApp', `https://wa.me/${wa}`), link('btn', 'Call', `tel:${msg.phone.replace(/[^\d+]/g, '')}`));
  const toggle = el('button', 'btn done', msg.doneAt ? 'Reopen' : 'Mark done');
  toggle.type = 'button';
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    try {
      await api(`/admin/api/messages/${msg.kind}/${msg.id}/${msg.doneAt ? 'reopen' : 'done'}`, {method:'POST'});
      messages = messages.filter(m => m !== msg);
      render();
      load({quiet:true});
    } catch (error) {
      toggle.disabled = false;
      showMessage(error.message, true);
    }
  });
  actions.append(toggle);
  body.append(actions);
  if (msg.doneAt) body.append(el('p', 'done-note', `Marked done ${dateFormat.format(new Date(msg.doneAt))}${msg.doneBy ? ` by ${msg.doneBy}` : ''}`));

  details.append(summary, body);
  return details;
}

function render() {
  const query = search.value.trim().toLowerCase();
  const shown = messages.filter(msg => {
    if (filter === 'contact' || filter === 'vendor') { if (msg.kind !== filter) return false; }
    else if (filter !== 'all' && msg.category !== filter) return false;
    if (!query) return true;
    return [msg.name, msg.business, msg.email, msg.phone, msg.message, msg.category, msg.links].some(value => value?.toLowerCase().includes(query));
  });
  list.replaceChildren(...shown.map(item));
  empty.textContent = messages.length === 0
    ? (status === 'open' ? 'No open messages. All caught up.' : 'Nothing marked done yet.')
    : 'No messages match.';
  empty.hidden = shown.length > 0;
}

async function load({quiet = false} = {}) {
  if (!quiet) { list.replaceChildren(); empty.hidden = true; }
  try {
    const data = await api(`/admin/api/messages?status=${status}`);
    document.getElementById('who').textContent = data.email ? `Signed in as ${data.email}` : '';
    const open = data.open.contact + data.open.vendor;
    openCount.textContent = open ? `(${open})` : '';
    if (!quiet) { messages = data.messages; render(); }
    showMessage('');
  } catch (error) {
    showMessage(error.message, true);
  }
}

tabs.forEach(tab => tab.addEventListener('click', () => {
  status = tab.dataset.status;
  tabs.forEach(t => t.setAttribute('aria-pressed', String(t === tab)));
  load();
}));
filters.forEach(button => button.addEventListener('click', () => {
  filter = button.dataset.filter;
  filters.forEach(b => b.setAttribute('aria-pressed', String(b === button)));
  render();
}));
search.addEventListener('input', render);

load();
