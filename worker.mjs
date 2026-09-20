const json = (value, status = 200) => Response.json(value, {status, headers:{'Cache-Control':'no-store'}});
function validRecord(value) {
  if (!value || typeof value.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value.id)) return false;
  if (typeof value.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)) return false;
  const parsed = new Date(`${value.date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value.date) return false;
  if (!Array.isArray(value.supports) || value.supports.length < 2 || value.supports.length > 50) return false;
  const names = [value.lead, ...value.supports];
  const types = ['Setup','Soundcheck','Event','Breakdown','Maintenance','Rehearsal','Other'];
  const statuses = ['Planned','Completed','Cancelled','Pending'];
  return names.every(name => typeof name === 'string' && name.trim().length > 0 && name.length <= 100) && new Set(names.map(name => name.trim().toLocaleLowerCase().replace(/\s+/g,' '))).size === names.length
    && typeof value.eventName === 'string' && value.eventName.trim().length <= 160
    && types.includes(value.workType) && statuses.includes(value.status)
    && typeof value.notes === 'string' && value.notes.length <= 2000
    && typeof value.approvedBy === 'string' && value.approvedBy.trim().length <= 100;
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      if (url.pathname !== '/api/work-dates') return json({error:'Not found.'},404);
      if (!['GET','PUT','DELETE'].includes(request.method)) return json({error:'Method not allowed.'},405);
      const editorHost = ['tracker.zahabu.co.ke','localhost','127.0.0.1'].includes(url.hostname);
      if (request.method !== 'GET' && (!editorHost || request.headers.get('origin') !== url.origin || request.headers.get('sec-fetch-site') === 'cross-site')) return json({error:'This link is view-only.'},403);
      try {
        if (request.method === 'GET') {
          const result = await env.DB.prepare('SELECT id, date, lead, supports, event_name AS eventName, work_type AS workType, status, notes, approved_by AS approvedBy, created_at AS createdAt, updated_at AS updatedAt FROM work_dates ORDER BY date DESC').all();
          return json(result.results.map(row => ({...row,supports:JSON.parse(row.supports)})));
        }
        if (request.method === 'DELETE') {
          const id = url.searchParams.get('id');
          if (!id) return json({error:'Missing record.'},400);
          await env.DB.prepare('DELETE FROM work_dates WHERE id = ?').bind(id).run();
          return json({ok:true});
        }
        if (!request.headers.get('content-type')?.includes('application/json')) return json({error:'Expected a crew record.'},415);
        const body = await request.text();
        if (body.length > 16000) return json({error:'Crew record is too large.'},413);
        let record;
        try { record = JSON.parse(body); } catch { return json({error:'Invalid crew record.'},400); }
        if (!validRecord(record)) return json({error:'Enter a valid date, lead tech and at least two different support staff.'},400);
        const now = new Date().toISOString();
        await env.DB.prepare('INSERT INTO work_dates (id, date, lead, supports, event_name, work_type, status, notes, approved_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET date = excluded.date, lead = excluded.lead, supports = excluded.supports, event_name = excluded.event_name, work_type = excluded.work_type, status = excluded.status, notes = excluded.notes, approved_by = excluded.approved_by, updated_at = excluded.updated_at').bind(record.id,record.date,record.lead.trim(),JSON.stringify(record.supports.map(name=>name.trim())),record.eventName.trim(),record.workType,record.status,record.notes.trim(),record.approvedBy.trim(),now,now).run();
        return json({ok:true});
      } catch (error) {
        if (String(error).includes('UNIQUE constraint failed')) return json({error:'This date already has a crew. Reload to see the latest entries.'},409);
        console.error('Crew storage error',error);
        return json({error:'Could not access the work history. Please try again.'},503);
      }
    }
    if (!['GET','HEAD'].includes(request.method)) return new Response('Method not allowed',{status:405});
    const asset = ASSETS[url.pathname === '/' ? (url.hostname === 'tracker-view.zahabu.co.ke' ? '/viewer.html' : '/index.html') : url.pathname];
    if (!asset) return new Response('Not found',{status:404});
    const bytes = Uint8Array.from(atob(asset.data), c => c.charCodeAt(0));
    return new Response(request.method === 'HEAD' ? null : bytes, {headers:{'Content-Type':asset.type,'X-Content-Type-Options':'nosniff','Cache-Control':'no-cache'}});
  }
};
