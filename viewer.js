'use strict';

let records = [];
const csvCell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
const displayDate = date => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, {weekday:'short', day:'numeric', month:'short', year:'numeric'});

function exportCsv() {
  if (!records.length) return;
  const supportCount = Math.max(...records.map(record => record.supports.length), 0);
  const header = ['Work date', 'Event / booking name', 'Work type', 'Status', 'Lead tech', ...Array.from({length:supportCount}, (_, i) => `Support ${i + 1}`), 'Notes', 'Approved by', 'Created at', 'Updated at'];
  const rows = [...records].sort((a, b) => a.date.localeCompare(b.date)).map(record => [record.date, record.eventName || '', record.workType || 'Event', record.status || 'Completed', record.lead, ...record.supports, record.notes || '', record.approvedBy || '', record.createdAt || '', record.updatedAt || '']);
  const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], {type:'text/csv;charset=utf-8'}));
  const link = document.createElement('a'); link.href = url; link.download = `zahabu-tech-tracker-${new Date().toISOString().slice(0,10)}.csv`; document.body.append(link); link.click(); link.remove(); URL.revokeObjectURL(url);
}

function render() {
  const container = document.querySelector('#records'); container.replaceChildren();
  document.querySelector('#record-count').textContent = `${records.length} ${records.length === 1 ? 'date' : 'dates'}`;
  document.querySelector('#export-csv').disabled = !records.length;
  if (!records.length) { const empty = document.createElement('div'); empty.className = 'empty'; const title = document.createElement('h3'); title.textContent = 'No work dates yet'; const hint = document.createElement('p'); hint.textContent = 'Entries will appear here when the crew tracker is updated.'; empty.append(title, hint); container.append(empty); return; }
  for (const record of [...records].sort((a,b) => b.date.localeCompare(a.date))) {
    const article = document.createElement('article'); article.className = 'record';
    const top = document.createElement('div'); top.className = 'record-top'; const date = document.createElement('time'); date.dateTime = record.date; date.textContent = displayDate(record.date); top.append(date);
    const details = document.createElement('div'); details.className = 'record-details'; const event = document.createElement('strong'); event.textContent = record.eventName || 'Unnamed booking'; const typeStatus = document.createElement('span'); typeStatus.textContent = `${record.workType || 'Event'} · ${record.status || 'Completed'}`; details.append(event, typeStatus);
    const list = document.createElement('dl'); list.className = 'assignments';
    for (const [title, names] of [['Lead tech', [record.lead]], ['Support staff', record.supports]]) { const group = document.createElement('div'); const term = document.createElement('dt'); term.textContent = title; const detail = document.createElement('dd'); names.forEach(name => { const span = document.createElement('span'); span.textContent = name; if (title === 'Support staff') span.className = 'support-name'; detail.append(span); }); group.append(term, detail); list.append(group); }
    article.append(top, details, list);
    if (record.notes || record.approvedBy || record.createdAt || record.updatedAt) { const footer = document.createElement('div'); footer.className = 'record-footer'; if (record.notes) { const note = document.createElement('span'); note.textContent = record.notes; footer.append(note); } if (record.approvedBy) { const approved = document.createElement('span'); approved.textContent = `Approved by ${record.approvedBy}`; footer.append(approved); } if (record.createdAt) { const stamp = document.createElement('small'); stamp.textContent = `Created ${new Date(record.createdAt).toLocaleString()}`; footer.append(stamp); } if (record.updatedAt && record.updatedAt !== record.createdAt) { const stamp = document.createElement('small'); stamp.textContent = `Updated ${new Date(record.updatedAt).toLocaleString()}`; footer.append(stamp); } article.append(footer); }
    container.append(article);
  }
}

document.querySelector('#export-csv').onclick = exportCsv;
fetch('/api/work-dates', {headers:{'Accept':'application/json'}}).then(response => { if (!response.ok) throw new Error(); return response.json(); }).then(result => { records = result; render(); }).catch(() => { document.querySelector('#records').textContent = 'Work history could not be loaded.'; });
