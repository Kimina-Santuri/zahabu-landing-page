// Stand-ins for Cloudflare D1 and R2 used by preview.mjs and verify.mjs. Never touches hosted data.
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function localD1(db) {
  const statement = (sql, values = []) => ({
    run:async () => db.prepare(sql).run(...values),
    all:async () => ({results:db.prepare(sql).all(...values)}),
    first:async () => db.prepare(sql).get(...values) ?? null,
  });
  return {prepare(sql) { return {...statement(sql), bind:(...values) => statement(sql, values)}; }};
}

export function localR2(dir) {
  const path = key => join(dir, key.replace(/\.\./g, ''));
  return {
    async put(key, value) { await mkdir(dirname(path(key)), {recursive:true}); await writeFile(path(key), value); },
    async get(key) {
      try { const bytes = await readFile(path(key)); return {body:new Blob([bytes]).stream(), size:bytes.length}; }
      catch { return null; }
    },
    async delete(keys) { for (const key of [keys].flat()) await rm(path(key), {force:true}); },
  };
}
