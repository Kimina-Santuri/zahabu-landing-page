import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import worker from './dist/server/index.js';
import photosWorker, { sanitizeJpeg, storiesForTests as storiesForTestsModule } from './dist/photos/index.js';
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
assert.ok(sent[0].text.endsWith(`All website messages (staff sign-in with Zoho): ${photosOrigin}/admin/messages\n`), 'contact email links to the Messages page');
assert.ok(sent[0].html.includes(`${photosOrigin}/admin/messages`) && sent[0].html.includes('New website enquiry'), 'contact email has a styled HTML version');
assert.ok(sent[0].html.includes('https://wa.me/254700000000'), 'WhatsApp button uses the international number');

assert.equal((await contact(contactForm({name:'FAIL test'}), contactEnv, 'https://zahabu.co.ke', '198.51.100.8')).status, 502, 'email failure is reported');
const failedRow = contactRows().find(row => row.name === 'FAIL test');
assert.ok(failedRow && !failedRow.emailed_at && failedRow.email_error === 'E_DELIVERY_FAILED', 'kept in D1 when the email fails');

for (let i = 0; i < 4; i++) assert.equal((await contact(contactForm({message:words(25)}))).status, 201, 'exactly 25 words is fine');
assert.equal((await contact(contactForm())).status, 429, 'contact per-IP hourly limit');
console.log('Verified contact form: readiness flag, origin, validation (25 to 100 words), spam check, honeypot, header safety, saved before sending, email failure, and rate limiting.');

// ---------- Vendor enquiries ----------

db.exec(await readFile('migrations/0006_vendor_enquiries.sql','utf8'));
sent.length = 0;
const vendorForm = (overrides={}, photos=[]) => {
  const form = new FormData();
  const values = {vendor_type:'Food & drink stall', business:'Mama Njeri Bites', name:'Njeri W.', email:'njeri@example.com', phone:'+254 711 000000', links:'@mamanjeri', power:'Yes', message:words(40), 'cf-turnstile-response':'good-token', ...overrides};
  for (const [key, value] of Object.entries(values)) if (value !== undefined) form.append(key, value);
  for (const night of overrides.nightsList || ['Wed: Jirani', 'Fri: Zahabu Sundowner']) form.append('nights', night);
  photos.forEach((bytes, i) => form.append(`photo_${i}`, new File([bytes], `p${i}.jpg`, {type:'image/jpeg'})));
  return form;
};
const vendor = (form, env=contactEnv, origin='https://zahabu.co.ke', ip='198.51.100.20') => photosWorker.fetch(new Request(photosOrigin+'/api/vendors',{method:'POST',headers:{origin,'cf-connecting-ip':ip},body:form}),env);
const vendorRows = () => db.prepare('SELECT * FROM vendor_enquiries').all();

assert.equal((await vendor(vendorForm(), photoEnv)).status, 503, 'vendor form needs the email binding');
assert.equal((await vendor(vendorForm(), contactEnv, 'https://elsewhere.example')).status, 403);
assert.equal((await vendor(vendorForm({vendor_type:'Caterer'}))).status, 400, 'unknown vendor type');
assert.equal((await vendor(vendorForm({business:''}))).status, 400);
assert.equal((await vendor(vendorForm({phone:''}))).status, 400, 'phone is required for vendors');
assert.equal((await vendor(vendorForm({power:undefined}))).status, 400, 'stalls must answer the electricity question');
assert.equal((await vendor(vendorForm({nightsList:['Mon: Nothing']}))).status, 400, 'unknown night');
assert.equal((await vendor(vendorForm({message:words(24)}))).status, 400);
assert.equal((await vendor(vendorForm({message:words(101)}))).status, 400);
assert.equal((await vendor(vendorForm({}, [new TextEncoder().encode('<svg>')]))).status, 400, 'photos must be JPEG');
assert.equal((await vendor(vendorForm({}, Array.from({length:4},()=>jpeg(800,600))))).status, 400, 'at most 3 photos');
assert.equal((await vendor(vendorForm({'cf-turnstile-response':'bad-token'}))).status, 400);
assert.equal((await vendor(vendorForm({website:'spam'}))).status, 201, 'vendor honeypot looks like success');
assert.equal(vendorRows().length + sent.length, 0, 'nothing stored or sent for rejected vendor enquiries');

const bucketBefore = bucket.size;
const vendorOk = await vendor(vendorForm({business:'Mama Njeri\r\nBites'}, [jpeg(1600,1200), jpeg(1200,1600)]));
assert.equal(vendorOk.status, 201);
assert.equal(sent.length, 1);
assert.ok(sent[0].subject.startsWith('Vendor: Food & drink stall - Mama Njeri Bites') && !/[\r\n]/.test(sent[0].subject));
assert.deepEqual(sent[0].replyTo, {email:'njeri@example.com', name:'Njeri W.'});
const [vendorRow] = vendorRows();
assert.equal(vendorRow.photo_count, 2);
assert.equal(vendorRow.nights, 'Wed: Jirani, Fri: Zahabu Sundowner');
assert.ok(vendorRow.emailed_at && !vendorRow.email_error);
assert.ok(sent[0].text.includes(`${photosOrigin}/admin/vendors/${vendorRow.id}`) && sent[0].text.includes('Needs electricity: Yes'));
assert.equal(bucket.size, bucketBefore + 2);
assert.ok(sent[0].text.endsWith(`${photosOrigin}/admin/messages\n`), 'vendor email links to the Messages page');
assert.ok(sent[0].html.includes(`${photosOrigin}/admin/vendors/${vendorRow.id}`) && sent[0].html.includes('View 2 photos'), 'vendor HTML email links to its photos');
assert.ok(!hasText(bucket.get(`vendors/${vendorRow.id}/0.jpg`), 'GPS'), 'vendor photos are stripped of metadata');

const sponsorOk = await vendor(vendorForm({vendor_type:'Sponsor / brand partner', power:'Yes', nightsList:[]}));
assert.equal(sponsorOk.status, 201);
assert.equal(vendorRows().find(row => row.vendor_type === 'Sponsor / brand partner').power, '', 'sponsors have no electricity answer');
assert.ok(!sent[1].text.includes('Needs electricity'));

// Staff view: behind Access, escapes what vendors typed, and serves the photos only under /admin.
assert.equal((await photosWorker.fetch(new Request(`${photosOrigin}/admin/vendors/${vendorRow.id}`),photoEnv)).status, 403, 'vendor page needs staff sign-in');
assert.equal((await photosWorker.fetch(new Request(`${photosOrigin}/media/full/${vendorRow.id}.jpg`),photoEnv)).status, 404, 'vendor photos are not public');
await vendor(vendorForm({business:'<script>alert(1)</script>', message:`<img src=x onerror=alert(1)> ${words(30)}`}), contactEnv, 'https://zahabu.co.ke', '198.51.100.21');
const xssRow = vendorRows().find(row => row.business.startsWith('<script>'));
const xssMail = sent.find(m => m.subject.includes('<script>'));
assert.ok(xssMail && !xssMail.html.includes('<script>alert') && !xssMail.html.includes('<img src=x') && xssMail.html.includes('&lt;script&gt;'), 'HTML email escapes what vendors typed');
const vendorHtml = await (await admin(`/admin/vendors/${xssRow.id}`)).text();
assert.ok(!vendorHtml.includes('<script>alert') && !vendorHtml.includes('<img src=x') && vendorHtml.includes('&lt;script&gt;'), 'vendor page escapes input');
const vendorPageHtml = await (await admin(`/admin/vendors/${vendorRow.id}`)).text();
assert.ok(vendorPageHtml.includes(`/admin/vendor-media/${vendorRow.id}/1.jpg`) && !vendorPageHtml.includes('/2.jpg'));
assert.equal((await admin(`/admin/vendor-media/${vendorRow.id}/0.jpg`)).status, 200);
assert.equal((await admin(`/admin/vendor-media/${vendorRow.id}/2.jpg`)).status, 404);
assert.equal((await admin('/admin/vendors/00000000-0000-0000-0000-000000000000')).status, 404);

assert.equal((await vendor(vendorForm({name:'FAIL vendor'}), contactEnv, 'https://zahabu.co.ke', '198.51.100.22')).status, 502);
assert.equal(vendorRows().find(row => row.name === 'FAIL vendor').email_error, 'E_DELIVERY_FAILED', 'vendor enquiry kept when the email fails');
for (let i = 0; i < 3; i++) assert.equal((await vendor(vendorForm())).status, 201);
assert.equal((await vendor(vendorForm())).status, 429, 'vendor per-IP hourly limit');
console.log('Verified vendor form: origin, validation, photos (JPEG only, max 3, metadata stripped, staff-only), staff page escaping, email failure, and rate limiting.');

// ---------- Staff Messages page ----------

db.exec(await readFile('migrations/0007_message_status.sql','utf8'));
assert.equal((await photosWorker.fetch(new Request(photosOrigin+'/admin/api/messages'),photoEnv)).status, 403, 'messages need staff sign-in');
assert.equal((await admin('/admin/messages')).status, 200, 'messages page is served');
const inbox = await (await admin('/admin/api/messages')).json();
const contactCount = contactRows().length, vendorCount = vendorRows().length;
assert.equal(inbox.messages.length, contactCount + vendorCount, 'both forms in one list');
assert.deepEqual(inbox.open, {contact:contactCount, vendor:vendorCount});
assert.ok(inbox.messages.every((m, i, all) => i === 0 || all[i - 1].createdAt >= m.createdAt), 'newest first');
const inboxVendor = inbox.messages.find(m => m.id === vendorRow.id);
assert.equal(inboxVendor.kind, 'vendor');
assert.deepEqual(inboxVendor.photos, [`/admin/vendor-media/${vendorRow.id}/0.jpg`, `/admin/vendor-media/${vendorRow.id}/1.jpg`]);
assert.equal(inbox.messages.find(m => m.name === 'FAIL test').emailFailed, true, 'failed emails are flagged');
assert.equal((await admin(`/admin/api/messages/vendor/${vendorRow.id}/done`, 'POST')).status, 200);
assert.equal(vendorRows().find(r => r.id === vendorRow.id).done_by, 'preview@localhost');
const afterDone = await (await admin('/admin/api/messages')).json();
assert.ok(!afterDone.messages.some(m => m.id === vendorRow.id) && afterDone.open.vendor === vendorCount - 1, 'done leaves the open list');
assert.ok((await (await admin('/admin/api/messages?status=done')).json()).messages.some(m => m.id === vendorRow.id), 'and shows under Done');
assert.equal((await admin(`/admin/api/messages/vendor/${vendorRow.id}/reopen`, 'POST')).status, 200);
assert.equal(vendorRows().find(r => r.id === vendorRow.id).done_at, null, 'reopen clears it');
assert.equal((await photosWorker.fetch(new Request(`${photosOrigin}/admin/api/messages/vendor/${vendorRow.id}/done`,{method:'POST',headers:{origin:'https://elsewhere.example'}}),adminEnv)).status, 403, 'cross-site mark-done blocked');
assert.equal((await admin('/admin/api/messages/contact/00000000-0000-0000-0000-000000000000/done', 'POST')).status, 404);
assert.equal((await admin(`/admin/api/messages/vendor/${vendorRow.id}/done`)).status, 405);
console.log('Verified Messages page: staff-only, both forms listed newest first, photos and failed emails shown, mark done / reopen, cross-site blocked.');

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

// ---------- Stories (editorial + newsletter) ----------
{

db.exec(await readFile('migrations/0008_stories.sql','utf8'));
db.exec(await readFile('migrations/0009_story_sections.sql','utf8'));
const brevoCalls = [];
let brevoFail = null;
const storiesEnv = {...photoEnv, LOCAL_DEV:true, SITE_ORIGIN:'https://zahabu.co.ke', ALLOWED_ORIGINS:'https://zahabu.co.ke', TURNSTILE_SITE_KEY:'site-key',
  NEWSLETTER_FROM:'stories@zahabu.co.ke', BREVO_LIST_ID:'7',
  BREVO_FAKE:async (path, body, method) => { if (path.startsWith('/contacts/')) { const email = decodeURIComponent(path.slice(10)); if (email === 'gone@example.com') throw Object.assign(new Error('Contact not found'), {code:'document_not_found'}); return email === 'fan@example.com' ? {emailBlacklisted:true, listIds:[7]} : {emailBlacklisted:false, listIds:[7], listUnsubscribed:[]}; } if (brevoFail && path.includes(brevoFail)) throw Object.assign(new Error('Sender not valid'), {code:'invalid_parameter'}); brevoCalls.push({path, body}); return path === '/emailCampaigns' ? {id:42} : {}; }};
const publicEnv = {...storiesEnv, LOCAL_DEV:false};
globalThis.fetch = async (url, init) => String(url).includes('turnstile/v0/siteverify') ? Response.json({success:init.body.get('response') === 'good-token'}) : realFetch(url, init);
const staff = (path, {method='GET', json, body, origin=photosOrigin}={}) => photosWorker.fetch(new Request(photosOrigin+path, {method,
  headers:{origin, ...(json ? {'content-type':'application/json'} : {})}, ...(json ? {body:JSON.stringify(json)} : body ? {body} : {})}), storiesEnv);
const site = (path, init={}, env=publicEnv) => photosWorker.fetch(new Request('https://zahabu.co.ke'+path, init), env);

// Staff only, same-origin writes
assert.equal((await photosWorker.fetch(new Request(photosOrigin+'/admin/api/stories'), {...storiesEnv, LOCAL_DEV:false})).status, 403, 'stories API needs sign-in');
assert.equal((await staff('/admin/api/stories', {method:'POST', json:{title:'x'}, origin:'https://evil.example'})).status, 403, 'cross-site write blocked');
const editorRedirect = await staff('/admin/stories');
assert.equal(editorRedirect.status, 302, 'photos.zahabu.co.ke/admin/stories moves to comms.zahabu.co.ke');
assert.equal(editorRedirect.headers.get('location'), 'https://comms.zahabu.co.ke/');
const comms = (path, env=storiesEnv) => photosWorker.fetch(new Request('https://comms.zahabu.co.ke'+path), env);
const commsHome = await comms('/');
assert.equal(commsHome.status, 200, 'editor served at the root of comms.zahabu.co.ke');
assert.match(await commsHome.text(), /stories\.js/);
assert.equal((await comms('/', {...storiesEnv, LOCAL_DEV:false})).status, 403, 'comms.zahabu.co.ke needs staff sign-in');
assert.equal((await comms('/admin/api/stories', {...storiesEnv, LOCAL_DEV:false})).status, 403);
assert.equal((await comms('/admin/api/stories')).status, 200);
assert.equal((await comms('/admin/messages')).headers.get('location'), 'https://photos.zahabu.co.ke/admin/messages');
assert.equal((await comms('/random')).status, 404);
assert.equal((await staff('/admin/stories.js')).status, 200);

// Body is checked block by block: no HTML, no javascript: links, unknown embeds and block types dropped
const body = [
  {t:'p', c:[{text:'Hello <script>alert(1)</script> '}, {text:'bold', b:true}, {text:' and a ', i:true}, {text:'bad link', href:'javascript:alert(1)'}, {text:' good link', href:'https://zahabu.co.ke/#visit'}]},
  {t:'h2', c:[{text:'A heading'}]},
  {t:'quote', c:[{text:'Line one\nLine two'}]},
  {t:'ul', items:[[{text:'One'}], [{text:''}], [{text:'Two'}]]},
  {t:'embed', url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'},
  {t:'embed', url:'https://evil.example/player'},
  {t:'embed', url:'https://soundcloud.com/zahabu/sundowner-mix'},
  {t:'img', id:'../../etc/passwd'},
  {t:'script', c:[{text:'nope'}]},
  {t:'hr'}, {t:'hr'},
  {t:'p', c:[{text:'   '}]},
];
const {blocks} = storiesForTestsModule.cleanBody(body);
assert.deepEqual(blocks.map(b => b.t), ['p', 'h2', 'quote', 'ul', 'embed', 'embed', 'hr']);
assert.equal(blocks[0].c.find(r => r.text === 'bad link').href, undefined, 'javascript: link dropped');
assert.equal(blocks[3].items.length, 2, 'empty list item dropped');

// Create, conflict check, publish
let created = await staff('/admin/api/stories', {method:'POST', json:{title:'Sundowner season & <more>', subtitle:'Every Friday', author:'Comms', body}});
assert.equal(created.status, 201);
let story = (await created.json()).story;
assert.equal(story.status, 'draft');
assert.equal(story.createdBy, 'preview@localhost');
assert.equal((await site('/stories/sundowner-season-and-more')).status, 404, 'drafts are not public');
const firstSave = story.updatedAt;
await new Promise(resolve => setTimeout(resolve, 5));
let saved = await staff(`/admin/api/stories/${story.id}`, {method:'PUT', json:{...story, body, baseUpdatedAt:firstSave}});
assert.equal(saved.status, 200);
story = (await saved.json()).story;
const stale = await staff(`/admin/api/stories/${story.id}`, {method:'PUT', json:{...story, body, title:'Older copy', baseUpdatedAt:firstSave}});
assert.equal(stale.status, 409, 'a stale save is refused');
assert.ok((await stale.json()).conflict);
const preview = await staff(`/admin/stories/${story.id}/preview`);
assert.equal(preview.status, 200);
assert.match(await preview.text(), /not published yet/);
assert.equal((await staff(`/admin/api/stories/${story.id}/send`, {method:'POST'})).status, 400, 'cannot email a draft');
const empty = (await (await staff('/admin/api/stories', {method:'POST', json:{}})).json()).story;
assert.equal((await staff(`/admin/api/stories/${empty.id}/publish`, {method:'POST'})).status, 400, 'needs a title and text');
assert.equal((await staff(`/admin/api/stories/${empty.id}`, {method:'DELETE'})).status, 200, 'drafts can be deleted');

let published = await staff(`/admin/api/stories/${story.id}/publish`, {method:'POST'});
assert.equal(published.status, 200);
story = (await published.json()).story;
assert.equal(story.slug, 'sundowner-season-and-more');
assert.ok(story.publishedAt);
assert.equal((await staff(`/admin/api/stories/${story.id}`, {method:'DELETE'})).status, 400, 'published stories must be unpublished first');
const twin = (await (await staff('/admin/api/stories', {method:'POST', json:{title:'Sundowner season & more', body}})).json()).story;
assert.equal((await (await staff(`/admin/api/stories/${twin.id}/publish`, {method:'POST'})).json()).story.slug, 'sundowner-season-and-more-2', 'slugs stay unique');
const reserved = (await (await staff('/admin/api/stories', {method:'POST', json:{title:'Media', body}})).json()).story;
assert.equal((await (await staff(`/admin/api/stories/${reserved.id}/publish`, {method:'POST'})).json()).story.slug, 'media-story', 'reserved paths are not used as slugs');

// Public pages
const page = await site('/stories/sundowner-season-and-more');
assert.equal(page.status, 200);
const html = await page.text();
assert.ok(html.includes('Sundowner season &amp; &lt;more&gt;'), 'title escaped');
assert.ok(!html.includes('<script>alert(1)</script>') && html.includes('Hello &lt;script&gt;'), 'body text escaped');
assert.ok(!html.includes('javascript:'), 'no javascript: links');
assert.ok(html.includes('href="https://zahabu.co.ke/#visit"'));
assert.ok(html.includes('data-src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'), 'YouTube player waits for a tap');
assert.ok(html.includes('w.soundcloud.com/player/?url=https%3A%2F%2Fsoundcloud.com%2Fzahabu%2Fsundowner-mix'));
assert.ok(!html.includes('evil.example'));
assert.ok(html.includes('Line one<br>Line two'));
assert.ok(html.includes('"@type":"Article"'));
assert.ok(html.includes('wa.me/?text='), 'WhatsApp share');
assert.ok(html.includes('class="subscribe"'), 'subscribe box shows once Brevo is set up');
const csp = page.headers.get('content-security-policy');
assert.match(csp, /script-src 'nonce-[0-9a-f]+' https:\/\/challenges\.cloudflare\.com/);
assert.ok(!/script-src[^;]*unsafe-inline/.test(csp));
const index = await (await site('/stories')).text();
assert.ok(index.includes('/stories/sundowner-season-and-more') && index.includes('card lead'));
assert.equal((await site('/stories/sundowner-season-and-more/')).status, 301, 'trailing slash redirects');
assert.equal((await site('/stories/no-such-story')).status, 404);
assert.equal(new URL((await photosWorker.fetch(new Request('https://www.zahabu.co.ke/stories'), publicEnv)).headers.get('location')).host, 'zahabu.co.ke', 'www redirects');
assert.equal((await photosWorker.fetch(new Request('https://zahabu.co.ke/admin/api/stories'), storiesEnv)).status, 404, 'staff area is only on photos.zahabu.co.ke');
const feedXml = await (await site('/stories/feed.xml')).text();
assert.ok(feedXml.includes('<link>https://zahabu.co.ke/stories/sundowner-season-and-more</link>') && feedXml.includes('<content:encoded><![CDATA['));
assert.ok((await (await site('/stories/sitemap.xml')).text()).includes('<loc>https://zahabu.co.ke/stories/sundowner-season-and-more</loc>'));
const latest = await (await site('/stories/api/latest?limit=2')).json();
assert.equal(latest.stories.length, 2);
assert.equal(latest.stories[0].url.startsWith('https://zahabu.co.ke/stories/'), true);
assert.equal((await (await site('/stories', {}, {...publicEnv, BREVO_LIST_ID:''})).text()).includes('class="subscribe"'), false, 'no subscribe box without Brevo');

// Photos: re-stripped server-side, public only by id
const upload = new FormData();
upload.append('large', new Blob([jpeg(1600, 1067)], {type:'image/jpeg'}), 'large.jpg');
upload.append('small', new Blob([jpeg(800, 533)], {type:'image/jpeg'}), 'small.jpg');
const uploaded = await staff('/admin/api/story-images', {method:'POST', body:upload});
assert.equal(uploaded.status, 201);
const image = await uploaded.json();
assert.equal(image.width, 1600);
assert.ok(!hasText(bucket.get(`stories/${image.id}-1600.jpg`), 'GPS'), 'location data stripped');
const mediaResponse = await site(`/stories/media/${image.id}-800.jpg`);
assert.equal(mediaResponse.status, 200);
assert.match(mediaResponse.headers.get('cache-control'), /immutable/);
const badUpload = new FormData();
badUpload.append('large', new Blob(['<svg onload=alert(1)>']), 'x.jpg');
badUpload.append('small', new Blob(['<svg>']), 'y.jpg');
assert.equal((await staff('/admin/api/story-images', {method:'POST', body:badUpload})).status, 400);

// Subscribing: Turnstile, double opt-in by button, same answer for everyone, rate limit
const subscribeForm = (email, token='good-token') => { const form = new FormData(); form.append('email', email); form.append('cf-turnstile-response', token); return form; };
const subscribeCall = (email, token, ip='10.0.0.1') => site('/stories/api/subscribe', {method:'POST', headers:{origin:'https://zahabu.co.ke', 'cf-connecting-ip':ip}, body:subscribeForm(email, token)});
assert.equal((await subscribeCall('fan@example.com', 'bad-token')).status, 400, 'spam check');
assert.equal((await site('/stories/api/subscribe', {method:'POST', headers:{origin:'https://evil.example'}, body:subscribeForm('fan@example.com')})).status, 403);
assert.equal((await subscribeCall('not-an-email')).status, 400);
brevoCalls.length = 0;
const joined = await subscribeCall('Fan@Example.com');
assert.equal(joined.status, 201);
const confirmMail = brevoCalls.find(call => call.path === '/smtp/email');
assert.equal(confirmMail.body.to[0].email, 'fan@example.com');
const token = confirmMail.body.htmlContent.match(/confirm\?t=([0-9a-f]{48})/)[1];
let subscriber = db.prepare('SELECT status FROM subscribers WHERE email = ?').get('fan@example.com');
assert.equal(subscriber.status, 'pending');
const confirmPage = await (await site(`/stories/confirm?t=${token}`)).text();
assert.ok(confirmPage.includes('method="post"') && db.prepare('SELECT status FROM subscribers WHERE email = ?').get('fan@example.com').status === 'pending', 'opening the link alone does not confirm (email scanners)');
brevoCalls.length = 0;
const confirmForm = new FormData(); confirmForm.append('t', token);
const confirmed = await site('/stories/api/confirm', {method:'POST', headers:{origin:'https://zahabu.co.ke'}, body:confirmForm});
assert.equal(confirmed.status, 200);
assert.equal(db.prepare('SELECT status FROM subscribers WHERE email = ?').get('fan@example.com').status, 'confirmed');
assert.deepEqual(brevoCalls[0], {path:'/contacts', body:{email:'fan@example.com', listIds:[7], updateEnabled:true, emailBlacklisted:false}});
brevoCalls.length = 0;
const again = await subscribeCall('fan@example.com');
assert.equal(again.status, 201, 'same answer for someone already subscribed');
assert.equal(brevoCalls.length, 0, 'and no second email');
for (let n = 0; n < 4; n++) await subscribeCall(`person${n}@example.com`, 'good-token', '10.0.0.9');
assert.equal((await subscribeCall('person9@example.com', 'good-token', '10.0.0.9')).status, 201);
assert.equal((await subscribeCall('person10@example.com', 'good-token', '10.0.0.9')).status, 429, 'rate limited per connection');
assert.equal((await site('/stories/api/subscribe', {method:'POST', headers:{origin:'https://zahabu.co.ke'}, body:subscribeForm('x@example.com')}, {...publicEnv, BREVO_LIST_ID:''})).status, 503);

// Newsletter: test email, send once, failures free the story for another try
brevoCalls.length = 0;
assert.equal((await staff(`/admin/api/stories/${story.id}/test-email`, {method:'POST', json:{to:'me@zahabu.co.ke'}})).status, 200);
assert.match(brevoCalls[0].body.htmlContent, /Test email: only you got this/);
assert.equal(brevoCalls[0].body.to[0].email, 'me@zahabu.co.ke');
brevoFail = 'sendNow';
const failed = await staff(`/admin/api/stories/${story.id}/send`, {method:'POST'});
assert.equal(failed.status, 502);
assert.match((await (await staff(`/admin/api/stories/${story.id}`)).json()).story.newsletterError, /Sender not valid/);
brevoFail = null;
brevoCalls.length = 0;
assert.equal((await staff(`/admin/api/stories/${story.id}/send`, {method:'POST'})).status, 200);
const campaign = brevoCalls.find(call => call.path === '/emailCampaigns').body;
assert.deepEqual(campaign.recipients, {listIds:[7]});
assert.equal(campaign.tag, undefined, 'no campaign tag (refused on Brevo free plan)');
assert.equal(campaign.subject, 'Sundowner season & <more>');
assert.ok(campaign.htmlContent.includes('{{ unsubscribe }}'), 'Brevo unsubscribe link');
assert.ok(campaign.htmlContent.includes('Sundowner season &amp; &lt;more&gt;'), 'email escapes the title');
assert.ok(!campaign.htmlContent.includes('<script>alert'), 'email escapes the body');
assert.ok(brevoCalls.some(call => call.path === '/emailCampaigns/42/sendNow'));
assert.equal((await staff(`/admin/api/stories/${story.id}/send`, {method:'POST'})).status, 409, 'never sent twice');
const listing = await (await staff('/admin/api/stories')).json();
assert.equal(listing.subscribers.confirmed, 1);
assert.ok(listing.stories.find(s => s.id === story.id).newsletterSentAt);

// Brevo webhook: public address, so every event is checked back with Brevo before anyone is marked unsubscribed
const hook = events => site('/stories/api/brevo-webhook', {method:'POST', body:JSON.stringify(events)});
db.prepare("UPDATE subscribers SET status = 'confirmed' WHERE email IN ('person0@example.com', 'person1@example.com')").run();
db.prepare("INSERT INTO subscribers (id, email, status, token, created_at) VALUES ('g1', 'gone@example.com', 'confirmed', 't', '2026-01-01')").run();
assert.equal((await (await hook({event:'unsubscribed', email:'person0@example.com'})).json()).marked, 0, 'a fake event for someone still on the list changes nothing');
assert.equal(db.prepare('SELECT status FROM subscribers WHERE email = ?').get('person0@example.com').status, 'confirmed');
assert.equal((await (await hook([{event:'unsubscribed', email:'Fan@example.com'}, {event:'hard_bounce', email:'gone@example.com'}, {event:'opened', email:'person1@example.com'}])).json()).marked, 2);
assert.equal(db.prepare('SELECT status FROM subscribers WHERE email = ?').get('fan@example.com').status, 'unsubscribed');
assert.equal(db.prepare('SELECT status FROM subscribers WHERE email = ?').get('gone@example.com').status, 'unsubscribed');
assert.equal(db.prepare('SELECT status FROM subscribers WHERE email = ?').get('person1@example.com').status, 'confirmed', 'other events ignored');

// Sections: seeded four, staff can add/rename/reorder/delete-if-empty; stories show their section
let sectionList = (await (await staff('/admin/api/story-sections')).json()).sections;
assert.deepEqual(sectionList.map(x => x.name), ['News', 'Features', 'Interviews', 'Mixes & music']);
assert.equal((await staff('/admin/api/story-sections', {method:'POST', json:{name:'Food'}, origin:'https://evil.example'})).status, 403);
sectionList = (await (await staff('/admin/api/story-sections', {method:'POST', json:{name:'Food & drink'}})).json()).sections;
const food = sectionList.find(x => x.name === 'Food & drink');
assert.equal(food.slug, 'food-and-drink');
sectionList = (await (await staff(`/admin/api/story-sections/${food.id}`, {method:'PUT', json:{name:'Food', description:'From the kitchen'}})).json()).sections;
assert.equal(sectionList.find(x => x.id === food.id).slug, 'food-and-drink', 'renaming keeps the address');
sectionList = (await (await staff('/admin/api/story-sections/order', {method:'POST', json:{ids:[food.id, ...sectionList.filter(x => x.id !== food.id).map(x => x.id)]}})).json()).sections;
assert.equal(sectionList[0].id, food.id, 'reordered');
assert.equal((await staff(`/admin/api/stories/${story.id}`, {method:'PUT', json:{...story, body, sectionId:'no-such-section'}})).status, 400);
story = (await (await staff(`/admin/api/stories/${story.id}`, {method:'PUT', json:{...story, body, sectionId:'sec-features'}})).json()).story;
assert.equal(story.sectionId, 'sec-features');
assert.equal((await staff('/admin/api/story-sections/sec-features', {method:'DELETE'})).status, 400, 'sections with stories cannot be deleted');
assert.equal((await staff(`/admin/api/story-sections/${food.id}`, {method:'DELETE'})).status, 200, 'empty sections can');
const featuresPage = await site('/stories/section/features');
assert.equal(featuresPage.status, 200);
const featuresHtml = await featuresPage.text();
assert.ok(featuresHtml.includes('sundowner-season-and-more') && !featuresHtml.includes('media-story'), 'section page lists only its stories');
assert.ok(featuresHtml.includes('aria-current="page">Features</a>'), 'section tab marked');
assert.equal((await site('/stories/section/interviews')).status, 200, 'empty section page still answers');
assert.equal((await site('/stories/section/nope')).status, 404);
const allHtml = await (await site('/stories')).text();
assert.ok(allHtml.includes('href="https://zahabu.co.ke/stories/section/features"') && !allHtml.includes('/stories/section/interviews'), 'tabs only for sections with stories');
assert.ok(allHtml.includes('Features · '), 'card shows its section');
const storyHtml = await (await site('/stories/sundowner-season-and-more')).text();
assert.ok(storyHtml.includes('class="eyebrow" href="https://zahabu.co.ke/stories/section/features">Features</a>') && storyHtml.includes('"articleSection":"Features"'));
assert.ok((await (await site('/stories/sitemap.xml')).text()).includes('/stories/section/features'));
assert.equal((await (await site('/stories/api/latest')).json()).stories.find(x => x.slug === 'sundowner-season-and-more').section, 'Features');

// Home page: newest story per section, in section order; falls back to newest overall
const twinStory = (await (await staff(`/admin/api/stories/${twin.id}`)).json()).story;
await staff(`/admin/api/stories/${twin.id}`, {method:'PUT', json:{...twinStory, sectionId:'sec-news'}});
const perSection = (await (await site('/stories/api/latest?by=section&limit=8')).json()).stories;
assert.deepEqual(perSection.map(x => x.section), ['News', 'Features'], 'one per section, in section order');
assert.equal(perSection[0].slug, 'sundowner-season-and-more-2');
assert.equal(perSection[1].sectionSlug, 'features');
await staff(`/admin/api/stories/${twin.id}`, {method:'PUT', json:{...twinStory, sectionId:null}});

// Layout blocks: gallery, photo + text, highlighted note, event card
const imageA = image.id;
const richBody = [...body,
  {t:'callout', text:'Doors at 4pm.\nTickets: https://tickets.example/zahabu <script>x</script>\n\nSecond line'},
  {t:'gallery', images:[{id:imageA}, {id:'bad'}, {id:imageA}], alt:'The garden', caption:'Friday night'},
  {t:'split', id:imageA, alt:'DJ booth', text:'Words beside the photo', side:'right'},
  {t:'split', id:'not-an-id', text:'dropped'},
  {t:'event', title:'Zahabu Sundowner', date:'2026-12-05', time:'4pm till late', place:'The Mall rooftop', link:'javascript:alert(1)', label:'Tickets'},
  {t:'event', title:'Bad date', date:'2026-02-30', link:'https://tickets.example/x'},
  {t:'event', title:''},
];
const richClean = storiesForTestsModule.cleanBody(richBody).blocks.slice(blocks.length);
assert.deepEqual(richClean.map(b => b.t), ['callout', 'gallery', 'split', 'event', 'event']);
assert.equal(richClean[1].images.length, 2, 'bad gallery ids dropped');
assert.equal(richClean[3].link, '', 'javascript: event link dropped');
assert.equal(richClean[4].date, '', 'impossible date dropped');
story = (await (await staff(`/admin/api/stories/${story.id}`, {method:'PUT', json:{...story, body:richBody, sectionId:'sec-features'}})).json()).story;
const richHtml = await (await site('/stories/sundowner-season-and-more')).text();
assert.ok(richHtml.includes('<aside class="callout"><p>Doors at 4pm.<br>Tickets: <a href="https://tickets.example/zahabu">https://tickets.example/zahabu</a> &lt;script&gt;x&lt;/script&gt;</p><p>Second line</p></aside>'), 'callout escaped, links clickable');
assert.ok(richHtml.includes('class="gallery two"') && richHtml.includes('alt="The garden"'));
assert.ok(richHtml.includes('class="split right"') && richHtml.includes('Words beside the photo'));
assert.ok(richHtml.includes('class="event-card"') && richHtml.includes('<span>Dec</span><b>5</b><span>Sat</span>') && richHtml.includes('Saturday, 5 December 2026 · 4pm till late · The Mall rooftop'));
assert.ok(!richHtml.includes('javascript:'));
brevoCalls.length = 0;
assert.equal((await staff(`/admin/api/stories/${story.id}/test-email`, {method:'POST', json:{to:'me@zahabu.co.ke'}})).status, 200);
const richEmail = brevoCalls[0].body.htmlContent;
assert.ok(richEmail.includes('Zahabu Stories · Features'), 'email shows the section');
assert.ok(richEmail.includes('Zahabu Sundowner') && richEmail.includes('Doors at 4pm.') && richEmail.includes('Friday night') && richEmail.includes('Words beside the photo'));
assert.ok(!richEmail.includes('<script>x'));
assert.ok(richEmail.includes("font-family:'Zahabu Futura'") || richEmail.includes("'Zahabu Futura'"), 'email uses the site font');
assert.ok(!/font-family:Futura/.test(richEmail), 'never the built-in Futura');
const richFeed = await (await site('/stories/feed.xml')).text();
assert.ok(richFeed.includes('<category>Features</category>'));

// Unpublish takes it off the site
assert.equal((await staff(`/admin/api/stories/${story.id}/unpublish`, {method:'POST'})).status, 200);
assert.equal((await site('/stories/sundowner-season-and-more')).status, 404);
globalThis.fetch = realFetch;
console.log('Verified stories: staff-only editor API, body checks and escaping, conflicts, publish/unpublish/slugs, public pages, feed, sitemap, photos, double opt-in subscribe, rate limit, newsletter send-once, Brevo webhook.');
}
