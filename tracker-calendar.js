'use strict';

// Month calendar shared by tracker.html and viewer.html. Each page owns its list view and records;
// this adds the List/Calendar toggle (remembered per browser) and draws the month grid.
//   const calendar = TrackerCalendar.mount({onSelect(record), onPickDate(date)?});
//   calendar.render(records);   // call whenever records change
//   calendar.show('list');      // e.g. to jump back to the list
window.TrackerCalendar = (() => {
  const STORAGE_KEY = 'zahabu-tracker-view';
  const pad = number => String(number).padStart(2, '0');
  const isoDate = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const monthLabel = new Intl.DateTimeFormat(undefined, {month:'long', year:'numeric'});
  const dayLabel = new Intl.DateTimeFormat(undefined, {weekday:'long', day:'numeric', month:'long'});
  const weekdayLabel = new Intl.DateTimeFormat(undefined, {weekday:'short'});
  // Monday-first, like the weekly programming on the website.
  const weekdays = Array.from({length:7}, (_, i) => weekdayLabel.format(new Date(2026, 0, 5 + i)));

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Lead and supports are both optional (but not both empty), so name whoever is there.
  function crewLabel(record) {
    const count = (record.lead ? 1 : 0) + record.supports.length;
    const first = record.lead || record.supports[0];
    return count > 1 ? `${first} +${count - 1}` : first;
  }

  function readView() {
    try { return localStorage.getItem(STORAGE_KEY) === 'calendar' ? 'calendar' : 'list'; } catch { return 'list'; }
  }

  function mount({onSelect, onPickDate}) {
    const list = document.querySelector('#records');
    const calendar = document.querySelector('#calendar');
    const buttons = [...document.querySelectorAll('.view-toggle [data-view]')];
    const today = new Date();
    let month = new Date(today.getFullYear(), today.getMonth(), 1);
    let view = readView();
    let records = [];

    function show(next) {
      view = next;
      try { localStorage.setItem(STORAGE_KEY, view); } catch {}
      buttons.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
      list.hidden = view !== 'list';
      calendar.hidden = view !== 'calendar';
      if (view === 'calendar') draw();
    }

    function move(offset) {
      month = new Date(month.getFullYear(), month.getMonth() + offset, 1);
      draw();
    }

    function entryButton(record, className) {
      const button = el('button', `${className} status-${(record.status || 'Completed').toLowerCase()}`);
      button.type = 'button';
      button.title = `${record.eventName || 'Unnamed booking'} · ${record.workType || 'Event'} · ${record.status || 'Completed'} · ${crewLabel(record)}`;
      button.append(el('span', 'cal-entry-name', record.eventName || 'Unnamed booking'), el('span', 'cal-entry-meta', `${record.workType || 'Event'} · ${crewLabel(record)}`));
      button.addEventListener('click', event => { event.stopPropagation(); onSelect(record); });
      return button;
    }

    function draw() {
      if (view !== 'calendar') return;
      const byDate = new Map();
      for (const record of records) byDate.set(record.date, [...(byDate.get(record.date) || []), record]);

      const prev = el('button', 'cal-nav', '‹'); prev.type = 'button'; prev.setAttribute('aria-label', 'Previous month'); prev.onclick = () => move(-1);
      const next = el('button', 'cal-nav', '›'); next.type = 'button'; next.setAttribute('aria-label', 'Next month'); next.onclick = () => move(1);
      const todayButton = el('button', 'cal-today', 'Today'); todayButton.type = 'button';
      todayButton.onclick = () => { month = new Date(today.getFullYear(), today.getMonth(), 1); draw(); };
      const title = el('h3', 'cal-title', monthLabel.format(month)); title.setAttribute('aria-live', 'polite');
      const head = el('div', 'cal-head'); head.append(prev, title, next, todayButton);

      const grid = el('div', 'cal-grid'); grid.setAttribute('role', 'grid');
      weekdays.forEach(name => grid.append(el('div', 'cal-weekday', name)));
      const start = new Date(month); start.setDate(1 - ((month.getDay() + 6) % 7));
      const end = new Date(month.getFullYear(), month.getMonth() + 1, 0);
      end.setDate(end.getDate() + (7 - ((end.getDay() + 6) % 7) - 1));
      const monthEntries = [];
      for (const day = new Date(start); day <= end; day.setDate(day.getDate() + 1)) {
        const date = isoDate(day);
        const entries = byDate.get(date) || [];
        const inMonth = day.getMonth() === month.getMonth();
        if (inMonth) monthEntries.push(...entries);
        const cell = el('div', 'cal-day'); cell.setAttribute('role', 'gridcell');
        cell.classList.toggle('is-outside', !inMonth);
        cell.classList.toggle('is-today', date === isoDate(today));
        cell.classList.toggle('has-entry', entries.length > 0);
        const number = el('span', 'cal-date', String(day.getDate()));
        number.setAttribute('aria-label', dayLabel.format(day));
        cell.append(number, ...entries.map(record => entryButton(record, 'cal-entry')));
        if (onPickDate && !entries.length) {
          cell.classList.add('is-pickable');
          cell.title = `Add a work date for ${dayLabel.format(day)}`;
          cell.addEventListener('click', () => onPickDate(date));
        }
        grid.append(cell);
      }

      // On phones the grid only shows dots, so the month's entries are listed underneath.
      const agenda = el('div', 'cal-agenda');
      if (monthEntries.length) {
        for (const record of monthEntries.sort((a, b) => a.date.localeCompare(b.date))) {
          const row = entryButton(record, 'cal-agenda-row');
          row.prepend(el('span', 'cal-agenda-date', dayLabel.format(new Date(`${record.date}T12:00:00`))));
          agenda.append(row);
        }
      } else {
        agenda.append(el('p', 'cal-empty', 'No work dates this month.'));
      }
      calendar.replaceChildren(head, grid, agenda);
    }

    buttons.forEach(button => button.addEventListener('click', () => show(button.dataset.view)));
    show(view);

    return {
      render(next) { records = next; draw(); },
      show,
    };
  }

  return {mount};
})();
