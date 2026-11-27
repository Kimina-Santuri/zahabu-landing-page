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
  const uploads = new Map();
  const toBytes = async value => value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
  const r2 = {
    async put(key, value) { const bytes = await toBytes(value); await mkdir(dirname(path(key)), {recursive:true}); await writeFile(path(key), bytes); return {key, size:bytes.length}; },
    async head(key) { try { return {key, size:(await readFile(path(key))).length}; } catch { return null; } },
    // Supports R2-style ranges: {range:{offset, length}} or {range:{suffix}}.
    async get(key, options = {}) {
      let bytes;
      try { bytes = await readFile(path(key)); } catch { return null; }
      const r = options.range;
      if (!r) return {body:new Blob([bytes]).stream(), size:bytes.length};
      if (r instanceof Headers || typeof r.get === 'function') throw new Error('Pass R2 a {offset, length} range, not request headers');
      const start = 'suffix' in r ? Math.max(0, bytes.length - r.suffix) : r.offset || 0;
      const end = 'suffix' in r ? bytes.length : Math.min(bytes.length, start + (r.length ?? bytes.length - start));
      return {body:new Blob([bytes.subarray(start, end)]).stream(), size:bytes.length, range:r};
    },
    async delete(keys) { for (const key of [keys].flat()) await rm(path(key), {force:true}); },
    async createMultipartUpload(key) { const uploadId = crypto.randomUUID(); uploads.set(uploadId, {key, parts:new Map()}); return {key, uploadId}; },
    resumeMultipartUpload(key, uploadId) {
      return {
        async uploadPart(partNumber, value) { const upload = uploads.get(uploadId); if (!upload) throw new Error('No such upload'); upload.parts.set(partNumber, await toBytes(value)); return {partNumber, etag:`etag-${partNumber}`}; },
        async complete(parts) {
          const upload = uploads.get(uploadId);
          const chunks = parts.map(part => { const bytes = upload.parts.get(part.partNumber); if (!bytes || part.etag !== `etag-${part.partNumber}`) throw new Error('Bad part'); return bytes; });
          const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
          let offset = 0;
          for (const chunk of chunks) { all.set(chunk, offset); offset += chunk.length; }
          uploads.delete(uploadId);
          return r2.put(key, all);
        },
        async abort() { uploads.delete(uploadId); },
      };
    },
  };
  return r2;
}
