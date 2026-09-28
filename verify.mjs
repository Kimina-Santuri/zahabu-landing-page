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
assert.equal((await call('PUT',{...record,supports:['Support A']})).status,400);
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
for (const path of ['/','/tracker.html','/tracker.js','/tracker.css','/viewer.html','/viewer.js','/images/logo.png','/fonts/Futura-Regular.ttf']) assert.equal((await call('GET',null,path)).status,200);
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
