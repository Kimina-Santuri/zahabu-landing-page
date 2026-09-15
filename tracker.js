'use strict';

const form = document.querySelector('#entry-form');
const supportFields = document.querySelector('#supports');
const message = document.querySelector('#form-message');
let records = [];
let editingId = null;
let busy = false;

function say(text, error = false) {
  message.textContent = text;
  message.classList.toggle('error', error);
}

function addSupport(value = '') {
  const row = document.createElement('div');
  row.className = 'support-row';
  const field = document.createElement('div');
  field.className = 'support-field';
  const label = document.createElement('label');
  const input = document.createElement('input');
  input.value = value;
  input.maxLength = 100;
  input.required = true;
  input.placeholder = 'Full name';
  input.setAttribute('list', 'crew-names');
  field.append(label, input);
  const remove = document.createElement('button');
  remove.type = 'button';
  remove.className = 'remove-support';
  remove.textContent = '×';
  remove.addEventListener('click', () => { row.remove(); labelSupports(); });
  row.append(field, remove);
  supportFields.append(row);
  labelSupports();
  return input;
}

function labelSupports() {
  [...supportFields.children].forEach((row, i) => {
    const input = row.querySelector('input');
    input.id = `support-${i + 1}`;
    const label = row.querySelector('label');
    label.htmlFor = input.id;
    label.textContent = `Support ${i + 1}`;
    const remove = row.querySelector('button');
    remove.hidden = supportFields.children.length <= 2;
    remove.setAttribute('aria-label', `Remove support ${i + 1}`);
  });
}

function resetForm() {
  form.reset();
  const today = new Date();
  document.querySelector('#work-date').value = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  supportFields.replaceChildren();
  addSupport(); addSupport();
  editingId = null;
  document.querySelector('#form-title').textContent = 'Add a work date';
  document.querySelector('#save-button').textContent = 'Save work date';
  document.querySelector('#cancel-edit').hidden = true;
}

function displayDate(date) {
  return new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {weekday:'short', day:'numeric', month:'short', year:'numeric'});
}

function render() {
  const container = document.querySelector('#records');
  container.replaceChildren();
  document.querySelector('#record-count').textContent = `${records.length} ${records.length === 1 ? 'date' : 'dates'}`;
  if (!records.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const title = document.createElement('h3'); title.textContent = 'Your crew history starts here';
    const hint = document.createElement('p'); hint.textContent = 'Add a work date and the people on duty.';
    empty.append(title, hint); container.append(empty);
  }
  for (const record of [...records].sort((a,b) => b.date.localeCompare(a.date))) {
    const article = document.createElement('article'); article.className = 'record';
    const top = document.createElement('div'); top.className = 'record-top';
    const date = document.createElement('time'); date.dateTime = record.date; date.textContent = displayDate(record.date);
    const actions = document.createElement('div'); actions.className = 'record-actions';
    const edit = document.createElement('button'); edit.textContent = 'Edit'; edit.disabled = busy;
    edit.setAttribute('aria-label', `Edit ${displayDate(record.date)}`);
    edit.onclick = () => {
      editingId = record.id;
      document.querySelector('#work-date').value = record.date;
      document.querySelector('#lead').value = record.lead;
      supportFields.replaceChildren(); record.supports.forEach(addSupport);
      document.querySelector('#form-title').textContent = 'Edit work date';
      document.querySelector('#save-button').textContent = 'Save changes';
      document.querySelector('#cancel-edit').hidden = false;
      say(''); document.querySelector('#work-date').focus();
    };
    const remove = document.createElement('button'); remove.textContent = 'Delete'; remove.className = 'delete'; remove.disabled = busy;
    remove.setAttribute('aria-label', `Delete ${displayDate(record.date)}`);
    remove.onclick = async () => {
      if (!confirm(`Delete the crew record for ${displayDate(record.date)}?`)) return;
      setBusy(true);
      try {
        await storage.remove(record.id);
        records = records.filter(item => item.id !== record.id);
        if (editingId === record.id) resetForm();
        say('Work date deleted.');
      } catch (error) { say(error.message, true); }
      finally { setBusy(false); }
    };
    actions.append(edit,remove); top.append(date,actions);
    const list = document.createElement('dl'); list.className = 'assignments';
    for (const [title, names] of [['Lead tech', [record.lead]], ['Support staff', record.supports]]) {
      const group = document.createElement('div');
      const term = document.createElement('dt'); term.textContent = title;
      const detail = document.createElement('dd');
      names.forEach(name => { const span = document.createElement('span'); span.textContent = name; if (title === 'Support staff') span.className = 'support-name'; detail.append(span); });
      group.append(term, detail); list.append(group);
    }
    article.append(top,list); container.append(article);
  }
  const names = [...new Set(records.flatMap(record => [record.lead,...record.supports]))].sort();
  document.querySelector('#crew-names').replaceChildren(...names.map(name => { const option = document.createElement('option'); option.value = name; return option; }));
}

function setBusy(value) {
  busy = value;
  [...form.elements].forEach(element => { element.disabled = value; });
  render();
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  const record = {
    id: editingId || crypto.randomUUID(),
    date: document.querySelector('#work-date').value,
    lead: document.querySelector('#lead').value.trim(),
    supports: [...supportFields.querySelectorAll('input')].map(input => input.value.trim())
  };
  const names = [record.lead, ...record.supports];
  if (!record.lead || record.supports.length < 2 || record.supports.some(name => !name)) return say('Enter a lead tech and at least two support staff.', true);
  if (new Set(names.map(name => name.toLocaleLowerCase().replace(/\s+/g,' '))).size !== names.length) return say('Assign a different person to each role.', true);
  if (records.some(item => item.date === record.date && item.id !== record.id)) return say('This date already has a crew. Edit that entry to make changes.', true);
  setBusy(true);
  try {
    await storage.save(record);
    records = [...records.filter(item => item.id !== record.id),record];
    resetForm(); say('Work date saved.');
  } catch (error) { say(error.message, true); }
  finally { setBusy(false); }
});

document.querySelector('#add-support').onclick = () => addSupport().focus();
document.querySelector('#cancel-edit').onclick = () => { resetForm(); say(''); };

async function api(path = '', options = {}) {
  const response = await fetch(`/api/work-dates${path}`, { ...options, headers: {'Content-Type':'application/json'} });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Could not save. Please try again.');
  return result;
}
const storage = {
  list: () => api(),
  save: record => api('', {method:'PUT',body:JSON.stringify(record)}),
  remove: id => api(`?id=${encodeURIComponent(id)}`, {method:'DELETE'})
};
resetForm();
document.querySelector('#storage-note').textContent = 'Work dates are saved online. One crew entry per date.';
async function loadRecords() {
  setBusy(true);
  document.querySelector('#records').textContent = 'Loading work history…';
  try {
    records = await storage.list();
    setBusy(false);
  } catch {
    document.querySelector('#records').replaceChildren();
    const notice = document.createElement('p'); notice.textContent = 'Work history could not be loaded.';
    const retry = document.createElement('button'); retry.textContent = 'Try again'; retry.onclick = loadRecords;
    document.querySelector('#records').append(notice,retry);
    say('Load your work history before adding an entry.',true);
  }
}
loadRecords();
