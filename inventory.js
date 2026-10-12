const CONDITIONS = {
  'working':'Working',
  'needs-attention':'Needs attention',
  'in-repair':'In repair',
  'broken':'Broken',
  'retired':'Retired',
};
const DEFAULT_CATEGORIES = ['Audio', 'Lighting', 'Video', 'Power & cables', 'Staging', 'Instruments', 'Furniture', 'IT'];
const LOG_LABELS = {created:'Added', tested:'Tested', maintained:'Maintained', repaired:'Repaired', note:'Note', condition:'Condition'};

const $ = id => document.getElementById(id);
const grid = $('grid');
const empty = $('empty');
const message = $('message');
const search = $('search');
const filterCategory = $('filterCategory');
const filterLocation = $('filterLocation');
const filterCondition = $('filterCondition');
const detailDialog = $('detailDialog');
const itemDialog = $('itemDialog');
const itemForm = $('itemForm');
const logDialog = $('logDialog');
const logForm = $('logForm');
const photoInput = $('photoInput');

let items = [];
let canEdit = false;
let quickFilter = '';
let current = null; // {item, photos, log} shown in the detail dialog
let shownPhoto = 0;

const dateFormat = new Intl.DateTimeFormat('en-KE', {dateStyle:'medium', timeZone:'UTC'});
const formatDate = value => value ? dateFormat.format(new Date(`${value}T00:00:00Z`)) : 'Never';
const todayIso = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value === true ? '' : value);
  }
  node.append(...children.flat().filter(child => child !== null && child !== undefined && child !== false));
  return node;
}

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

// An item is due for a check when it has an interval and its latest test/maintenance is older than that.
function isDue(item) {
  if (!item.checkEveryDays || item.condition === 'retired') return false;
  const last = [item.lastTested, item.lastMaintained].filter(Boolean).sort().pop();
  if (!last) return true;
  const due = new Date(`${last}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + item.checkEveryDays);
  return due.toISOString().slice(0, 10) < todayIso();
}

const badge = condition => el('span', {class:`badge ${condition}`}, CONDITIONS[condition] || condition);
const dueBadge = () => el('span', {class:'badge due'}, 'Check due');

// ---------- List ----------

const QUICK_FILTERS = [
  ['', 'Items', () => true],
  ['working', 'Working', item => item.condition === 'working'],
  ['problem', 'Need attention', item => ['needs-attention', 'broken', 'in-repair'].includes(item.condition)],
  ['due', 'Checks due', isDue],
  ['untested', 'Never tested', item => !item.lastTested && item.condition !== 'retired'],
];

function renderStats() {
  $('stats').replaceChildren(...QUICK_FILTERS.map(([key, label, test]) => el('button', {
    type:'button', class:'stat', 'aria-pressed':String(quickFilter === key),
    onclick:() => { quickFilter = quickFilter === key ? '' : key; render(); },
  }, el('strong', {}, String(items.filter(test).length)), el('span', {}, label))));
}

function fillSelect(select, values, allLabel) {
  const selected = select.value;
  select.replaceChildren(el('option', {value:''}, allLabel), ...values.map(value => el('option', {value}, value)));
  select.value = values.includes(selected) ? selected : '';
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function renderFilters() {
  const categories = uniqueSorted(items.map(item => item.category));
  const locations = uniqueSorted(items.map(item => item.location));
  fillSelect(filterCategory, categories, 'All categories');
  fillSelect(filterLocation, locations, 'All locations');
  $('categoryList').replaceChildren(...uniqueSorted([...categories, ...DEFAULT_CATEGORIES]).map(value => el('option', {value})));
  $('locationList').replaceChildren(...locations.map(value => el('option', {value})));
}

function matches(item) {
  const query = search.value.trim().toLowerCase();
  if (query && ![item.name, item.brand, item.model, item.serialNumber, item.assetTag, item.category, item.location, item.notes]
    .some(field => field.toLowerCase().includes(query))) return false;
  if (filterCategory.value && item.category !== filterCategory.value) return false;
  if (filterLocation.value && item.location !== filterLocation.value) return false;
  if (filterCondition.value && item.condition !== filterCondition.value) return false;
  return QUICK_FILTERS.find(([key]) => key === quickFilter)[2](item);
}

function card(item) {
  const subtitle = [item.brand, item.model].filter(Boolean).join(' ') || item.category;
  return el('button', {type:'button', class:'card', onclick:() => openDetail(item.id)},
    el('div', {class:'photo'},
      item.cover ? el('img', {src:item.cover, alt:'', loading:'lazy'}) : 'No photo',
      item.quantity !== 1 ? el('span', {class:'qty'}, `×${item.quantity}`) : null),
    el('div', {class:'body'},
      el('h2', {}, item.name),
      subtitle ? el('p', {class:'sub'}, subtitle) : null,
      el('div', {class:'badges'}, badge(item.condition), isDue(item) ? dueBadge() : null),
      el('p', {class:'when'}, `${item.location ? `${item.location} · ` : ''}Tested ${formatDate(item.lastTested)}`)));
}

function render() {
  renderStats();
  const shown = items.filter(matches);
  grid.replaceChildren(...shown.map(card));
  empty.hidden = shown.length > 0;
  empty.textContent = items.length ? 'Nothing matches these filters.' : canEdit ? 'No equipment yet. Use “Add item” to start the list.' : 'No equipment has been added yet.';
}

async function load() {
  try {
    ({items} = await api('/api/items'));
    renderFilters();
    render();
    showMessage('');
  } catch (error) {
    showMessage(error.message, true);
  }
}

// ---------- Detail ----------

function closeAll() {
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
}

async function openDetail(id, photoIndex = 0) {
  try {
    current = await api(`/api/items/${id}`);
    shownPhoto = Math.min(photoIndex, Math.max(0, current.photos.length - 1));
    renderDetail();
    if (!detailDialog.open) detailDialog.showModal();
  } catch (error) {
    showMessage(error.message, true);
  }
}

function renderGallery() {
  const {item, photos} = current;
  const main = el('div', {class:'gallery-main'});
  const photo = photos[shownPhoto];
  if (photo) main.append(el('a', {href:photo.full, target:'_blank', rel:'noopener', title:'Open full size'}, el('img', {src:photo.full, alt:item.name})));
  else main.append(canEdit ? 'No photos yet. Add one below.' : 'No photos yet');

  const thumbs = photos.length > 1 ? el('div', {class:'thumbs'}, photos.map((p, index) => el('button', {
    type:'button', class:'thumb', 'aria-current':String(index === shownPhoto), 'aria-label':`Photo ${index + 1}`,
    onclick:() => { shownPhoto = index; renderDetail(); },
  }, el('img', {src:p.thumb, alt:''}), p.id === item.coverPhotoId ? el('span', {class:'star', title:'Cover photo'}, '★') : null))) : null;

  const tools = canEdit ? el('div', {class:'photo-tools'},
    el('button', {type:'button', class:'btn', onclick:() => photoInput.click()}, 'Add photos'),
    photo && photo.id !== item.coverPhotoId ? el('button', {type:'button', class:'btn', onclick:() => photoAction('POST', photo.id)}, 'Make cover') : null,
    photo ? confirmButton('Delete photo', () => photoAction('DELETE', photo.id)) : null) : null;

  return el('div', {}, main, thumbs, tools);
}

// Two-tap delete, matching the photo review page: the first tap arms the button for a few seconds.
function confirmButton(label, action) {
  const button = el('button', {type:'button', class:'btn danger'}, label);
  button.addEventListener('click', () => {
    if (button.dataset.armed !== 'yes') {
      button.dataset.armed = 'yes';
      button.textContent = 'Tap again to confirm';
      setTimeout(() => { button.dataset.armed = ''; button.textContent = label; }, 4000);
      return;
    }
    button.disabled = true;
    action();
  });
  return button;
}

function renderDetail() {
  const {item, log} = current;
  $('detailTitle').textContent = item.name;
  const fact = (label, value) => value || value === 0 ? [el('dt', {}, label), el('dd', {}, String(value))] : [];
  const facts = el('dl', {class:'facts'},
    fact('Category', item.category), fact('Brand', item.brand), fact('Model', item.model),
    fact('Serial', item.serialNumber), fact('Asset tag', item.assetTag), fact('Quantity', item.quantity),
    fact('Location', item.location), fact('Last tested', formatDate(item.lastTested)),
    fact('Maintained', formatDate(item.lastMaintained)),
    fact('Check every', item.checkEveryDays ? `${item.checkEveryDays} days` : ''),
    fact('Updated', item.updatedBy ? `${formatDate(item.updatedAt.slice(0, 10))} by ${item.updatedBy}` : ''));

  const actions = canEdit ? el('div', {class:'actions'},
    el('button', {type:'button', class:'btn primary', onclick:openLog}, 'Log check'),
    el('button', {type:'button', class:'btn', onclick:() => openItemForm(item)}, 'Edit'),
    confirmButton('Delete item', deleteItem)) : null;

  const history = el('div', {},
    el('h3', {}, 'History'),
    log.length ? el('ul', {class:'log'}, log.map(entry => el('li', {},
      el('time', {datetime:entry.date}, formatDate(entry.date)),
      el('div', {},
        el('span', {class:'kind'}, LOG_LABELS[entry.kind] || entry.kind),
        entry.note ? el('div', {}, entry.note) : null,
        entry.doneBy ? el('div', {class:'by'}, entry.doneBy) : null),
      canEdit && entry.kind !== 'created' ? el('button', {type:'button', class:'link', title:'Remove this entry', onclick:() => deleteLog(entry.id)}, 'Remove') : el('span')))) : el('p', {class:'by'}, 'Nothing logged yet.'));

  $('detailBody').replaceChildren(
    el('div', {class:'detail'},
      renderGallery(),
      el('div', {style:'display:grid;gap:16px'},
        el('div', {class:'badges'}, badge(item.condition), isDue(item) ? dueBadge() : null),
        facts,
        item.notes ? el('p', {class:'notes'}, item.notes) : null,
        actions)),
    history);
}

async function refreshAfterChange(photoIndex = shownPhoto) {
  await load();
  if (current && items.some(item => item.id === current.item.id)) await openDetail(current.item.id, photoIndex);
}

async function photoAction(method, photoId) {
  try {
    await api(`/api/items/${current.item.id}/photos/${photoId}`, {method});
    await refreshAfterChange(method === 'DELETE' ? Math.max(0, shownPhoto - 1) : shownPhoto);
  } catch (error) {
    showMessage(error.message, true);
    closeAll();
  }
}

async function deleteItem() {
  try {
    await api(`/api/items/${current.item.id}`, {method:'DELETE'});
    closeAll();
    current = null;
    await load();
  } catch (error) {
    showMessage(error.message, true);
    closeAll();
  }
}

async function deleteLog(logId) {
  try {
    await api(`/api/items/${current.item.id}/log/${logId}`, {method:'DELETE'});
    await refreshAfterChange();
  } catch (error) {
    showMessage(error.message, true);
  }
}

// ---------- Photos ----------

// Re-encoding through a canvas resizes the photo and drops EXIF data, same as the community photo uploads.
async function encodeJpeg(bitmap, maxEdge, quality, maxBytes) {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  for (let q = quality; q >= .4; q -= .1) {
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', q));
    if (blob && blob.size <= maxBytes) return blob;
  }
  throw new Error('too large');
}

async function uploadPhotos(files) {
  const id = current.item.id;
  const before = current.photos.length;
  const tools = detailDialog.querySelector('.photo-tools');
  const status = el('span', {class:'by'});
  tools?.append(status);
  let uploaded = 0;
  try {
    for (const file of files) {
      status.textContent = `Uploading ${uploaded + 1} of ${files.length}…`;
      let bitmap;
      try { bitmap = await createImageBitmap(file); } catch { throw new Error(`Couldn't read ${file.name}. Try a JPEG or PNG.`); }
      const form = new FormData();
      try {
        form.append('full', await encodeJpeg(bitmap, 1800, .82, 2.8 * 1024 * 1024), 'full.jpg');
        form.append('thumb', await encodeJpeg(bitmap, 640, .78, 550 * 1024), 'thumb.jpg');
      } catch {
        throw new Error(`${file.name} is too large.`);
      } finally {
        bitmap.close();
      }
      await api(`/api/items/${id}/photos`, {method:'POST', body:form});
      uploaded++;
    }
    await refreshAfterChange(before);
  } catch (error) {
    status.textContent = error.message;
    if (uploaded) await refreshAfterChange(before);
  }
}

photoInput.addEventListener('change', () => {
  const files = [...photoInput.files];
  photoInput.value = '';
  if (files.length && current) uploadPhotos(files);
});

// ---------- Forms ----------

function conditionOptions(select) {
  select.replaceChildren(...Object.entries(CONDITIONS).map(([value, label]) => el('option', {value}, label)));
}

function formError(node, text) {
  node.textContent = text;
  node.hidden = !text;
}

let editingId = null;

function openItemForm(item = null) {
  editingId = item?.id || null;
  $('itemTitle').textContent = item ? `Edit ${item.name}` : 'Add item';
  itemForm.reset();
  formError($('itemError'), '');
  const values = item || {quantity:1, condition:'working'};
  for (const field of itemForm.elements) {
    if (field.name && field.name in values) field.value = values[field.name] ?? '';
  }
  itemDialog.showModal();
  itemForm.elements.name.focus();
}

itemForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(itemForm));
  data.quantity = Number(data.quantity);
  data.checkEveryDays = data.checkEveryDays ? Number(data.checkEveryDays) : null;
  data.lastTested ||= null;
  data.lastMaintained ||= null;
  const submit = itemForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    const {item} = await api(editingId ? `/api/items/${editingId}` : '/api/items', {
      method:editingId ? 'PUT' : 'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify(data),
    });
    itemDialog.close();
    await load();
    await openDetail(item.id);
  } catch (error) {
    formError($('itemError'), error.message);
  } finally {
    submit.disabled = false;
  }
});

function openLog() {
  logForm.reset();
  formError($('logError'), '');
  logForm.elements.date.value = todayIso();
  logForm.elements.date.max = todayIso();
  logForm.elements.condition.value = current.item.condition;
  logDialog.showModal();
}

logForm.addEventListener('submit', async event => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(logForm));
  const submit = logForm.querySelector('[type="submit"]');
  submit.disabled = true;
  try {
    current = await api(`/api/items/${current.item.id}/log`, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(data)});
    logDialog.close();
    renderDetail();
    load();
  } catch (error) {
    formError($('logError'), error.message);
  } finally {
    submit.disabled = false;
  }
});

// ---------- CSV export ----------

function exportCsv() {
  const columns = [
    ['Name', 'name'], ['Category', 'category'], ['Brand', 'brand'], ['Model', 'model'], ['Serial number', 'serialNumber'],
    ['Asset tag', 'assetTag'], ['Quantity', 'quantity'], ['Location', 'location'], ['Condition', item => CONDITIONS[item.condition]],
    ['Last tested', 'lastTested'], ['Last maintained', 'lastMaintained'], ['Check every (days)', 'checkEveryDays'],
    ['Check due', item => isDue(item) ? 'Yes' : ''], ['Photos', 'photoCount'], ['Notes', 'notes'],
  ];
  // Leading =, +, - or @ would be read as a formula by spreadsheet apps.
  const cell = value => {
    let text = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const rows = [columns.map(([label]) => label), ...items.filter(matches).map(item => columns.map(([, key]) => typeof key === 'function' ? key(item) : item[key]))];
  const blob = new Blob(['﻿' + rows.map(row => row.map(cell).join(',')).join('\r\n')], {type:'text/csv'});
  const link = el('a', {href:URL.createObjectURL(blob), download:`zahabu-equipment-${todayIso()}.csv`});
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- Start ----------

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('click', event => {
    if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
  });
}
conditionOptions(itemForm.elements.condition);
conditionOptions(logForm.elements.condition);
filterCondition.append(...Object.entries(CONDITIONS).map(([value, label]) => el('option', {value}, label)));
for (const input of [search, filterCategory, filterLocation, filterCondition]) input.addEventListener('input', render);
$('addItem').addEventListener('click', () => openItemForm());
$('exportCsv').addEventListener('click', exportCsv);

(async () => {
  try {
    const me = await api('/api/me');
    canEdit = me.canEdit;
    $('who').textContent = `${me.email} · ${canEdit ? 'Editor' : 'View only'}`;
    $('addItem').hidden = !canEdit;
  } catch (error) {
    showMessage(error.message, true);
  }
  load();
})();
