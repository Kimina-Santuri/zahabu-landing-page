import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import worker from './dist/server/index.js';
import photosWorker, { sanitizeJpeg } from './dist/photos/index.js';
import { localD1 } from './local-bindings.mjs';
const db = new DatabaseSync(':memory:');
db.exec(await readFile('drizzle/0000_lying_thanos.sql','utf8'));
db.exec(await readFile('migrations/0002_entry_details.sql','utf8'));
const env = {DB:localD1(db)};
const origin = 'https://tracker.zahabu.co.ke';
const call = (method,body,path='/api/work-dates') => worker.fetch(new Request(origin+path,{method,headers:{origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
const record={id:'test-1',date:'2026-09-15',eventName:'Test booking',workType:'Event',status:'Completed',lead:'Lead',supports:['Support A','Support B'],notes:'All clear',approvedBy:'Manager'};
assert.equal((await call('PUT',record)).status,200);
const saved = await (await call('GET')).json();
assert.equal(saved.length,1);
assert.deepEqual({...saved[0],createdAt:undefined,updatedAt:undefined}, {...record,createdAt:undefined,updatedAt:undefined});
assert.ok(saved[0].createdAt && saved[0].updatedAt);
assert.equal((await call('PUT',{...record,id:'test-2'})).status,409);
assert.equal((await call('PUT',{...record,supports:['Lead','Support B']})).status,400);
assert.equal((await call('PUT',{...record,lead:'',supports:[]})).status,400,'needs at least one person');
assert.equal((await call('PUT',{...record,lead:'Solo Lead',supports:[]})).status,200,'a lead on their own is fine');
assert.equal((await call('PUT',{...record,lead:'',supports:['Solo Support']})).status,200,'one support with no lead is fine');
assert.equal((await call('PUT',{...record,lead:'',supports:['Same','same']})).status,400,'still one person per role');
assert.equal((await call('PUT',{...record,date:'2026-02-30'})).status,400);
assert.equal((await call('PUT',{...record,lead:'Updated lead'})).status,200);
assert.equal((await (await call('GET')).json())[0].lead,'Updated lead');
const crossOrigin = new Request(origin+'/api/work-dates',{method:'DELETE',headers:{origin:'https://elsewhere.example'}});
assert.equal((await worker.fetch(crossOrigin,env)).status,403);
const publicOrigin = 'https://tracker-view.zahabu.co.ke';
const publicWrite = new Request(publicOrigin+'/api/work-dates',{method:'PUT',headers:{origin:publicOrigin,'content-type':'application/json'},body:JSON.stringify(record)});
assert.equal((await worker.fetch(publicWrite,env)).status,403);
assert.equal((await call('DELETE',null,'/api/work-dates?id=test-1')).status,200);
assert.deepEqual(await (await call('GET')).json(),[]);
for (const path of ['/','/tracker.html','/tracker.js','/tracker.css','/tracker-calendar.js','/viewer.html','/viewer.js','/images/logo.png','/fonts/Futura-Regular.ttf']) assert.equal((await call('GET',null,path)).status,200);
console.log('Verified save, reload, edit, delete, date uniqueness, crew validation, request origin, and page assets.');

// ---------- Community photos ----------

db.exec(await readFile('migrations/0003_community_photos.sql','utf8'));
const bucket = new Map();
const photoEnv = {
  DB:localD1(db),
  PHOTOS:{
    async put(key,value){ bucket.set(key,new Uint8Array(value)); },
    async get(key){ const bytes=bucket.get(key); return bytes ? {body:new Blob([bytes]).stream(),size:bytes.length} : null; },
    async delete(keys){ for (const key of [keys].flat()) bucket.delete(key); },
  },
  TURNSTILE_SECRET:'test-secret',
  ALLOWED_ORIGINS:'https://zahabu.co.ke',
};
const adminEnv = {...photoEnv, LOCAL_DEV:true};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('turnstile/v0/siteverify')) return Response.json({success:init.body.get('response') === 'good-token'});
  return realFetch(url, init);
};

const segment = (marker, payload) => [0xFF, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xFF, ...payload];
const ascii = text => [...text].map(char => char.charCodeAt(0));
const jpeg = (width, height) => new Uint8Array([
  0xFF, 0xD8,
  ...segment(0xE0, [...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  ...segment(0xE1, [...ascii('Exif'), 0, 0, ...ascii('GPS -1.2641,36.8028')]),
  ...segment(0xFE, ascii('camera comment')),
  ...segment(0xC0, [8, height >> 8, height & 0xFF, width >> 8, width & 0xFF, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
  ...segment(0xDA, [3, 1, 0, 2, 0, 3, 0, 0, 63, 0]), 0x12, 0x34, 0xFF, 0xD9,
]);
const hasText = (bytes, text) => new TextDecoder('latin1').decode(bytes).includes(text);

const cleaned = sanitizeJpeg(jpeg(1800, 1200));
assert.equal(cleaned.width, 1800);
assert.equal(cleaned.height, 1200);
assert.ok(!hasText(cleaned.bytes, 'Exif') && !hasText(cleaned.bytes, 'GPS') && !hasText(cleaned.bytes, 'camera comment'));
assert.ok(hasText(cleaned.bytes, 'JFIF'));
assert.equal(sanitizeJpeg(new TextEncoder().encode('<svg onload=alert(1)>')), null);

const photosOrigin = 'https://photos.zahabu.co.ke';
const submission = ({consent='yes', token='good-token', credit='Wanjiru K.', files=[[jpeg(1800,1200), jpeg(640,427)]]}={}) => {
  const form = new FormData();
  form.append('consent', consent);
  form.append('credit', credit);
  form.append('cf-turnstile-response', token);
  files.forEach(([full, thumb], i) => {
    form.append(`full_${i}`, new File([full], 'full.jpg', {type:'image/jpeg'}));
    form.append(`thumb_${i}`, new File([thumb], 'thumb.jpg', {type:'image/jpeg'}));
  });
  return form;
};
const upload = (form, origin='https://zahabu.co.ke', headers={}) => photosWorker.fetch(new Request(photosOrigin+'/api/photos',{method:'POST',headers:{origin,'cf-connecting-ip':'203.0.113.9',...headers},body:form}),photoEnv);
const getPhotos = async () => (await (await photosWorker.fetch(new Request(photosOrigin+'/api/photos',{headers:{origin:'https://zahabu.co.ke'}}),photoEnv)).json()).photos;
const admin = (path, method='GET', env=adminEnv) => photosWorker.fetch(new Request(photosOrigin+path,{method,headers:{origin:photosOrigin}}),env);

assert.equal((await upload(submission(), 'https://elsewhere.example')).status, 403);
assert.equal((await upload(submission({consent:''}))).status, 400);
assert.equal((await upload(submission({token:'bad-token'}))).status, 400);
assert.equal((await upload(submission({credit:'x'.repeat(61)}))).status, 400);
assert.equal((await upload(submission({files:[[new TextEncoder().encode('not a jpeg'), jpeg(640,427)]]}))).status, 400);
assert.equal((await upload(submission({files:Array.from({length:6},()=>[jpeg(1800,1200), jpeg(640,427)])}))).status, 400);
const accepted = await upload(submission());
assert.equal(accepted.status, 201);
assert.equal(accepted.headers.get('access-control-allow-origin'), 'https://zahabu.co.ke');
assert.equal(bucket.size, 2);
for (const bytes of bucket.values()) assert.ok(!hasText(bytes, 'GPS'));

assert.deepEqual(await getPhotos(), [], 'pending photos must not be public');
assert.equal((await admin('/admin/api/photos?status=pending','GET',photoEnv)).status, 403, 'admin must fail closed without Access config');
const pending = (await (await admin('/admin/api/photos?status=pending')).json()).photos;
assert.equal(pending.length, 1);
assert.equal(pending[0].credit, 'Wanjiru K.');
assert.equal(pending[0].width, 1800);
const id = pending[0].id;
assert.equal((await photosWorker.fetch(new Request(`${photosOrigin}/media/full/${id}.jpg`),photoEnv)).status, 404, 'pending media must not be public');
assert.equal((await admin(`/admin/media/full/${id}.jpg`)).status, 200);
const crossSiteApprove = new Request(`${photosOrigin}/admin/api/photos/${id}/approve`,{method:'POST',headers:{origin:'https://elsewhere.example'}});
assert.equal((await photosWorker.fetch(crossSiteApprove,adminEnv)).status, 403);

assert.equal((await admin(`/admin/api/photos/${id}/approve`,'POST')).status, 200);
const published = await getPhotos();
assert.equal(published.length, 1);
assert.equal(published[0].full, `${photosOrigin}/media/full/${id}.jpg`);
assert.equal((await photosWorker.fetch(new Request(published[0].full),photoEnv)).status, 200);

assert.equal((await admin(`/admin/api/photos/${id}/unpublish`,'POST')).status, 200);
assert.deepEqual(await getPhotos(), []);
assert.equal((await admin(`/admin/api/photos/${id}`,'DELETE')).status, 200);
assert.equal(bucket.size, 0);
assert.equal((await (await admin('/admin/api/photos?status=pending')).json()).photos.length, 0);
assert.equal((await admin('/admin')).status, 200);

for (let i = 0; i < 3; i++) assert.equal((await upload(submission({files:Array.from({length:5},()=>[jpeg(800,600), jpeg(640,480)])}))).status, 201);
assert.equal((await upload(submission())).status, 429, 'per-IP hourly limit');

// ---------- Contact form ----------

db.exec(await readFile('migrations/0005_contact_messages.sql','utf8'));
const sent = [];
const contactEnv = {...photoEnv, CONTACT_FROM:'website@mail.zahabu.co.ke', CONTACT_EMAIL:{async send(message){ if (message.subject.includes('FAIL')) throw Object.assign(new Error('nope'),{code:'E_DELIVERY_FAILED'}); sent.push(message); }}};
const words = n => Array.from({length:n},(_, i)=>`word${i}`).join(' ');
const longMessage = words(100);
const contactForm = (overrides={}) => {
  const form = new FormData();
  const values = {name:'Achieng O.', email:'achieng@example.com', phone:'+254 700 000000', reason:'Booking / private event', event_date:'2026-12-12', message:longMessage, 'cf-turnstile-response':'good-token', ...overrides};
  for (const [key, value] of Object.entries(values)) form.append(key, value);
  return form;
};
const contact = (form, env=contactEnv, origin='https://zahabu.co.ke', ip='198.51.100.7') => photosWorker.fetch(new Request(photosOrigin+'/api/contact',{method:'POST',headers:{origin,'cf-connecting-ip':ip},body:form}),env);
const contactRows = () => db.prepare('SELECT * FROM contact_messages').all();

assert.deepEqual(await (await photosWorker.fetch(new Request(photosOrigin+'/api/contact'),photoEnv)).json(), {ready:false}, 'hidden until the email binding exists');
assert.deepEqual(await (await photosWorker.fetch(new Request(photosOrigin+'/api/contact'),contactEnv)).json(), {ready:true});
assert.equal((await contact(contactForm(), photoEnv)).status, 503, 'no email binding');
assert.equal((await contact(contactForm(), contactEnv, 'https://elsewhere.example')).status, 403);
assert.equal((await contact(contactForm({message:words(24)}))).status, 400, 'needs 25 words');
assert.equal((await contact(contactForm({message:words(101)}))).status, 400, 'at most 100 words');
assert.equal((await contact(contactForm({email:'not-an-email'}))).status, 400);
assert.equal((await contact(contactForm({name:''}))).status, 400);
assert.equal((await contact(contactForm({reason:'Something else'}))).status, 400);
assert.equal((await contact(contactForm({event_date:'2026-02-30'}))).status, 400);
assert.equal((await contact(contactForm({phone:'call me maybe'}))).status, 400);
assert.equal((await contact(contactForm({'cf-turnstile-response':'bad-token'}))).status, 400);
assert.equal(contactRows().length, 0, 'rejected messages are not stored');
assert.equal((await contact(contactForm({website:'http://spam.example'}))).status, 201, 'honeypot looks like success');
assert.equal(sent.length + contactRows().length, 0, 'honeypot sends and stores nothing');

const contactOk = await contact(contactForm({name:'Achieng\r\nBcc: victim@example.com', event_date:''}));
assert.equal(contactOk.status, 201);
assert.equal(contactOk.headers.get('access-control-allow-origin'), 'https://zahabu.co.ke');
assert.equal(sent.length, 1);
assert.equal(sent[0].to, 'info@zahabu.co.ke');
assert.deepEqual(sent[0].replyTo, {email:'achieng@example.com', name:'Achieng Bcc: victim@example.com'});
assert.ok(!/[\r\n]/.test(sent[0].subject), 'no newlines in the subject');
assert.ok(sent[0].text.includes('Event date: -') && sent[0].text.includes(longMessage));
assert.ok(contactRows()[0].emailed_at && !contactRows()[0].email_error);

assert.equal((await contact(contactForm({name:'FAIL test'}), contactEnv, 'https://zahabu.co.ke', '198.51.100.8')).status, 502, 'email failure is reported');
const failedRow = contactRows().find(row => row.name === 'FAIL test');
assert.ok(failedRow && !failedRow.emailed_at && failedRow.email_error === 'E_DELIVERY_FAILED', 'kept in D1 when the email fails');

for (let i = 0; i < 4; i++) assert.equal((await contact(contactForm({message:words(25)}))).status, 201, 'exactly 25 words is fine');
assert.equal((await contact(contactForm())).status, 429, 'contact per-IP hourly limit');
console.log('Verified contact form: readiness flag, origin, validation (25 to 100 words), spam check, honeypot, header safety, saved before sending, email failure, and rate limiting.');

// Cloudflare Access tokens: signed by the team's key, right audience, not expired
const keyPair = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const publicJwk = {...await crypto.subtle.exportKey('jwk',keyPair.publicKey),kid:'test-kid'};
globalThis.fetch = async (url, init) => String(url) === 'https://zahabu.cloudflareaccess.com/cdn-cgi/access/certs' ? Response.json({keys:[publicJwk]}) : realFetch(url, init);
const b64url = bytes => Buffer.from(bytes).toString('base64url');
const signToken = async (claims, key=keyPair.privateKey) => {
  const head = b64url(JSON.stringify({alg:'RS256',kid:'test-kid'}));
  const body = b64url(JSON.stringify(claims));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
};
const accessEnv = {...photoEnv, ACCESS_TEAM_DOMAIN:'zahabu.cloudflareaccess.com', ACCESS_AUD:'aud-123'};
const good = {aud:['aud-123'],iss:'https://zahabu.cloudflareaccess.com',exp:Math.floor(Date.now()/1000)+600,email:'staff@zahabu.co.ke'};
const withToken = token => photosWorker.fetch(new Request(photosOrigin+'/admin/api/photos?status=pending',{headers:{'cf-access-jwt-assertion':token}}),accessEnv);
const okResponse = await withToken(await signToken(good));
assert.equal(okResponse.status, 200);
assert.equal((await okResponse.json()).email, 'staff@zahabu.co.ke');
assert.equal((await withToken(await signToken({...good,aud:['other-app']}))).status, 403);
assert.equal((await withToken(await signToken({...good,exp:Math.floor(Date.now()/1000)-10}))).status, 403);
assert.equal((await withToken(await signToken({...good,iss:'https://evil.cloudflareaccess.com'}))).status, 403);
const otherKey = await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
assert.equal((await withToken(await signToken(good, otherKey.privateKey))).status, 403, 'forged signature');
const [h,,sig] = (await signToken(good)).split('.');
assert.equal((await withToken(`${h}.${b64url(JSON.stringify({...good,email:'attacker@example.com'}))}.${sig}`)).status, 403, 'tampered payload');
assert.equal((await photosWorker.fetch(new Request(photosOrigin+'/admin'),accessEnv)).status, 403, 'no token');

globalThis.fetch = realFetch;
console.log('Verified community photos: metadata stripping, consent, spam check, origin, size limits, moderation, Access fail-closed, publish/unpublish/delete, rate limiting, and Access token checks.');

// ---------- Equipment inventory ----------

const { default: inventoryWorker, canEdit } = await import('./inventory-worker.mjs');
db.exec(await readFile('migrations/0004_inventory.sql','utf8'));
const media = new Map();
const inventoryEnv = {
  DB:localD1(db),
  MEDIA:{
    async put(key,value){ media.set(key,new Uint8Array(value)); },
    async get(key){ const bytes=media.get(key); return bytes ? {body:new Blob([bytes]).stream(),size:bytes.length} : null; },
    async delete(keys){ for (const key of [keys].flat()) media.delete(key); },
  },
  LOCAL_DEV:true,
  EDITOR_EMAILS:'preview@localhost',
};
const viewerEnv = {...inventoryEnv, EDITOR_EMAILS:'@zahabu.co.ke'};
const invOrigin = 'https://inventory.zahabu.co.ke';
const inv = (path, {method='GET', body, env=inventoryEnv, origin=invOrigin}={}) => inventoryWorker.fetch(new Request(invOrigin+path,{method,headers:{origin,...(body && !(body instanceof FormData)?{'content-type':'application/json'}:{})},...(body?{body:body instanceof FormData?body:JSON.stringify(body)}:{})}),env);

assert.ok(canEdit('Tech@Zahabu.co.ke',{EDITOR_EMAILS:'@zahabu.co.ke'}));
assert.ok(!canEdit('tech@notzahabu.co.ke.evil.com',{EDITOR_EMAILS:'@zahabu.co.ke'}));
assert.ok(!canEdit('staff',{EDITOR_EMAILS:'staff'}), 'service tokens without an email never edit');
assert.equal((await inventoryWorker.fetch(new Request(invOrigin+'/api/items'),{...inventoryEnv, LOCAL_DEV:false})).status, 403, 'inventory must fail closed without Access config');

const mixer = {name:'Yamaha MG16XU mixer', category:'Audio', brand:'Yamaha', model:'MG16XU', serialNumber:'ABC123', quantity:1, location:'Store room', condition:'working', lastTested:'2026-09-01', checkEveryDays:30};
assert.equal((await inv('/api/items',{method:'POST',body:{...mixer,name:''}})).status, 400);
assert.equal((await inv('/api/items',{method:'POST',body:{...mixer,condition:'fine'}})).status, 400);
assert.equal((await inv('/api/items',{method:'POST',body:{...mixer,lastTested:'2026-02-30'}})).status, 400);
assert.equal((await inv('/api/items',{method:'POST',body:{...mixer,quantity:1.5}})).status, 400);
assert.equal((await inv('/api/items',{method:'POST',body:mixer,origin:'https://elsewhere.example'})).status, 403);
assert.equal((await inv('/api/items',{method:'POST',body:mixer,env:viewerEnv})).status, 403, 'viewers cannot add');
const created = await inv('/api/items',{method:'POST',body:mixer});
assert.equal(created.status, 201);
const itemId = (await created.json()).item.id;
assert.equal((await (await inv('/api/items',{env:viewerEnv})).json()).items.length, 1, 'viewers can list');
assert.equal((await (await inv('/api/me',{env:viewerEnv})).json()).canEdit, false);

assert.equal((await inv(`/api/items/${itemId}`,{method:'PUT',body:{...mixer,condition:'needs-attention'}})).status, 200);
const logged = await inv(`/api/items/${itemId}/log`,{method:'POST',body:{kind:'tested',date:'2026-10-01',note:'Channel 3 crackles',condition:'in-repair'}});
assert.equal(logged.status, 200);
const detail = await logged.json();
assert.equal(detail.item.lastTested, '2026-10-01');
assert.equal(detail.item.condition, 'in-repair');
assert.deepEqual(detail.log.map(entry => entry.kind).sort(), ['condition','condition','created','tested']);
await inv(`/api/items/${itemId}/log`,{method:'POST',body:{kind:'tested',date:'2026-09-15'}});
assert.equal((await (await inv(`/api/items/${itemId}`)).json()).item.lastTested, '2026-10-01', 'older checks never move the date back');
assert.equal((await inv(`/api/items/${itemId}/log`,{method:'POST',body:{kind:'tested',date:'2999-01-01'}})).status, 400);
assert.equal((await inv(`/api/items/${itemId}/log`,{method:'POST',body:{kind:'tested'},env:viewerEnv})).status, 403);

const photoForm = (full=jpeg(1800,1200), thumb=jpeg(640,427)) => { const f=new FormData(); f.append('full',new File([full],'f.jpg')); f.append('thumb',new File([thumb],'t.jpg')); return f; };
assert.equal((await inv(`/api/items/${itemId}/photos`,{method:'POST',body:photoForm(new TextEncoder().encode('nope'))})).status, 400);
const firstPhoto = (await (await inv(`/api/items/${itemId}/photos`,{method:'POST',body:photoForm()})).json()).photo.id;
const secondPhoto = (await (await inv(`/api/items/${itemId}/photos`,{method:'POST',body:photoForm()})).json()).photo.id;
for (const bytes of media.values()) assert.ok(!hasText(bytes, 'GPS'));
assert.equal((await (await inv(`/api/items/${itemId}`)).json()).item.coverPhotoId, firstPhoto, 'first photo becomes the cover');
assert.equal((await inv(`/media/thumb/${firstPhoto}.jpg`,{env:viewerEnv})).status, 200);
assert.equal((await inv(`/api/items/${itemId}/photos/${firstPhoto}`,{method:'DELETE'})).status, 200);
assert.equal((await (await inv(`/api/items/${itemId}`)).json()).item.coverPhotoId, secondPhoto, 'cover moves on when deleted');
assert.equal(media.size, 2);

assert.equal((await inv(`/api/items/${itemId}`,{method:'DELETE'})).status, 200);
assert.equal(media.size, 0);
assert.equal((await (await inv('/api/items')).json()).items.length, 0);
for (const path of ['/','/inventory.js','/logo.png']) assert.equal((await inv(path)).status, 200);
console.log('Verified equipment inventory: Access fail-closed, editor vs viewer roles, origin check, validation, check logging, photos and cover, delete cleanup.');
