import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { readFile, readdir } from 'node:fs/promises';
import worker from './dist/server/index.js';
const db = new DatabaseSync('/private/tmp/zahabu-tracker-preview.sqlite');
db.exec('CREATE TABLE IF NOT EXISTS _local_migrations (name TEXT PRIMARY KEY)');
for(const file of (await readdir('drizzle')).filter(name=>name.endsWith('.sql')).sort()) {
  if (!db.prepare('SELECT name FROM _local_migrations WHERE name = ?').get(file)) {
    db.exec(await readFile(`drizzle/${file}`,'utf8'));
    db.prepare('INSERT INTO _local_migrations VALUES (?)').run(file);
  }
}
const env={DB:{prepare(sql){return {bind(...values){return {run:async()=>db.prepare(sql).run(...values)}},all:async()=>({results:db.prepare(sql).all()})}}}};
http.createServer(async(req,res)=>{
  try {
    const chunks=[]; for await(const chunk of req) chunks.push(chunk);
    const request=new Request(`http://localhost:5173${req.url}`,{method:req.method,headers:req.headers,...(!['GET','HEAD'].includes(req.method)?{body:Buffer.concat(chunks)}:{})});
    const response=await worker.fetch(request,env);
    res.writeHead(response.status,Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
  } catch {res.writeHead(500);res.end('Preview unavailable');}
}).listen(5173,'127.0.0.1',()=>console.log('Local: http://localhost:5173/tracker.html'));
