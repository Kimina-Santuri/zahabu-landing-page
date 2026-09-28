const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const message = document.getElementById('message');
const who = document.getElementById('who');
const pendingCount = document.getElementById('pendingCount');
const tabs = [...document.querySelectorAll('.tab')];
let status = 'pending';

const dateFormat = new Intl.DateTimeFormat('en-KE', {dateStyle:'medium', timeStyle:'short'});

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

function card(photo) {
  const article = document.createElement('article');
  article.className = 'card';

  const link = document.createElement('a');
  link.href = photo.full;
  link.target = '_blank';
  link.rel = 'noopener';
  link.title = 'Open full size';
  const img = document.createElement('img');
  img.src = photo.thumb;
  img.alt = photo.credit ? `Photo by ${photo.credit}` : 'Community photo';
  img.loading = 'lazy';
  link.append(img);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const credit = document.createElement('p');
  credit.className = photo.credit ? 'credit' : 'credit none';
  credit.textContent = photo.credit || 'No credit name';
  const time = document.createElement('time');
  const when = status === 'approved' ? photo.reviewedAt : photo.createdAt;
  time.dateTime = when;
  time.textContent = status === 'approved'
    ? `Published ${dateFormat.format(new Date(when))}${photo.reviewedBy ? ` by ${photo.reviewedBy}` : ''}`
    : `Submitted ${dateFormat.format(new Date(when))}`;
  meta.append(credit, time);

  const actions = document.createElement('div');
  actions.className = 'actions';
  const primary = document.createElement('button');
  primary.type = 'button';
  primary.className = status === 'approved' ? 'unpublish' : 'approve';
  primary.textContent = status === 'approved' ? 'Unpublish' : 'Approve';
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'delete';
  remove.textContent = 'Delete';
  actions.append(primary, remove);

  primary.addEventListener('click', () => act(article, [primary, remove], `/admin/api/photos/${photo.id}/${status === 'approved' ? 'unpublish' : 'approve'}`, 'POST'));
  remove.addEventListener('click', () => {
    if (remove.dataset.confirm !== 'yes') {
      remove.dataset.confirm = 'yes';
      remove.textContent = 'Confirm delete';
      setTimeout(() => { remove.dataset.confirm = ''; remove.textContent = 'Delete'; }, 4000);
      return;
    }
    act(article, [primary, remove], `/admin/api/photos/${photo.id}`, 'DELETE');
  });

  article.append(link, meta, actions);
  return article;
}

async function act(article, buttons, path, method) {
  buttons.forEach(button => button.disabled = true);
  try {
    await api(path, {method});
    article.remove();
    if (!grid.children.length) load();
    refreshPendingCount();
    showMessage('');
  } catch (error) {
    buttons.forEach(button => button.disabled = false);
    showMessage(error.message, true);
  }
}

async function refreshPendingCount() {
  try {
    const {photos} = await api('/admin/api/photos?status=pending');
    pendingCount.textContent = photos.length ? `(${photos.length})` : '';
  } catch {}
}

async function load() {
  grid.replaceChildren();
  empty.hidden = true;
  try {
    const {email, photos} = await api(`/admin/api/photos?status=${status}`);
    who.textContent = email ? `Signed in as ${email}` : '';
    if (status === 'pending') pendingCount.textContent = photos.length ? `(${photos.length})` : '';
    grid.append(...photos.map(card));
    empty.textContent = status === 'pending' ? 'No photos waiting for review.' : 'Nothing published yet.';
    empty.hidden = photos.length > 0;
    showMessage('');
  } catch (error) {
    showMessage(error.message, true);
  }
}

tabs.forEach(tab => tab.addEventListener('click', () => {
  status = tab.dataset.status;
  tabs.forEach(t => t.setAttribute('aria-selected', String(t === tab)));
  load();
}));

load();
