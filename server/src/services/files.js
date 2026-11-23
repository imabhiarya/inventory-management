// Attached files (audit observations, DCS rate quotations). The bytes live in one GridFS bucket,
// "auditFiles", which the full backup includes.
import mongoose from 'mongoose';
import { badRequest } from '../utils/httpError.js';

export const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Allowed attachments, by extension. Only PDFs and photos open in the browser; the rest download. */
export const FILE_TYPES = {
  pdf: { type: 'application/pdf', inline: true, magic: (b) => b.subarray(0, 4).toString('latin1') === '%PDF' },
  png: { type: 'image/png', inline: true, magic: (b) => b[0] === 0x89 && b.subarray(1, 4).toString('latin1') === 'PNG' },
  jpg: { type: 'image/jpeg', inline: true, magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  jpeg: { type: 'image/jpeg', inline: true, magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  gif: { type: 'image/gif', inline: true, magic: (b) => b.subarray(0, 4).toString('latin1') === 'GIF8' },
  webp: { type: 'image/webp', inline: true, magic: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
  doc: { type: 'application/msword' },
  docx: { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xls: { type: 'application/vnd.ms-excel' },
  xlsx: { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  csv: { type: 'text/csv' },
  ppt: { type: 'application/vnd.ms-powerpoint' },
  pptx: { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};
export const ALLOWED_EXTENSIONS = Object.keys(FILE_TYPES);

export const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: 'auditFiles' });
export const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

export async function storeFile(name, base64, byName) {
  const spec = FILE_TYPES[extOf(name)];
  if (!spec) throw badRequest(`"${name}": only Word, Excel, PowerPoint, PDF and image files (${ALLOWED_EXTENSIONS.join(', ')}) can be attached`);
  const buf = Buffer.from(base64, 'base64');
  if (!buf.length) throw badRequest(`"${name}" is empty`);
  if (buf.length > MAX_FILE_BYTES) throw badRequest(`"${name}" is larger than 15 MB`);
  // Files that open in the browser must really be what their extension says.
  if (spec.magic && !spec.magic(buf)) throw badRequest(`"${name}" does not look like a valid .${extOf(name)} file`);
  const fileId = await new Promise((resolve, reject) => {
    const up = bucket().openUploadStream(name, { metadata: { type: spec.type } });
    up.once('error', reject);
    up.once('finish', () => resolve(up.id));
    up.end(buf);
  });
  return { fileId, name, type: spec.type, size: buf.length, uploadedAt: new Date(), byName };
}

export async function dropFiles(files) {
  for (const f of files) await bucket().delete(f.fileId).catch(() => {}); // already gone is fine
}


/** Sends one stored file (`meta` is its fileMeta). PDFs and photos open in the browser unless `?download`. */
export function sendFile(req, res, meta) {
  const spec = FILE_TYPES[extOf(meta.name)] || {};
  const inline = spec.inline && req.query.download === undefined;
  res.setHeader('Content-Type', meta.type);
  res.setHeader('Content-Length', meta.size);
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(meta.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  // Images: nothing may run. (Not applied to PDFs — a sandbox stops the browser's PDF viewer.)
  if (meta.type.startsWith('image/')) res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  bucket()
    .openDownloadStream(meta.fileId)
    .on('error', () => (res.headersSent ? res.end() : res.status(404).json({ error: 'File not found' })))
    .pipe(res);
}
