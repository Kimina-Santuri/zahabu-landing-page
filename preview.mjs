import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import worker from './dist/server/index.js';
import photosWorker from './dist/photos/index.js';
import { localD1, localR2 } from './local-bindings.mjs';
const db = new DatabaseSync('/private/tmp/zahabu-tracker-preview.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)');
for(const file of (await readdir('drizzle')).filter(name=>name.endsWith('.sql')).sort()) {
  if (!db.prepare('SELECT name FROM _local_migrations WHERE name = ?').get(file)) {
    db.exec(await readFile(`drizzle/${file}`,'utf8'));
    db.prepare('INSERT INTO _local_migrations VALUES (?)').run(file);
  }
}
db.exec(await readFile('migrations/0003_community_photos.sql','utf8'));
const env={DB:localD1(db)};
// Turnstile's published test secret always passes; LOCAL_DEV skips Cloudflare Access for /admin.
const photosEnv={DB:localD1(db),PHOTOS:localR2('/private/tmp/zahabu-photos-preview'),LOCAL_DEV:true,TURNSTILE_SECRET:'1x0000000000000000000000000000000AA',ALLOWED_ORIGINS:'http://localhost:5173,http://localhost:8123'};
const isPhotoRoute=path=>path.startsWith('/api/photos')||path.startsWith('/media/')||path==='/admin'||path.startsWith('/admin/');
http.createServer(async(req,res)=>{
  try {
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    const request=new Request(`http://localhost:5173${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks),duplex:'half'}:{})});
    const path=new URL(request.url).pathname;
    const response=isPhotoRoute(path)?await photosWorker.fetch(request,photosEnv):await worker.fetch(request,env);
    res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {console.error(error);res.writeHead(500);res.end('Preview unavailable');}
}).listen(5173,'127.0.0.1',()=>console.log('Local: http://localhost:5173/ (site), /tracker.html, /admin (photo review)'));
