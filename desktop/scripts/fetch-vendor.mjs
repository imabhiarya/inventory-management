// Downloads the Windows binaries the desktop app ships with:
//   vendor/mongodb/win32-x64/mongod.exe   MongoDB Community Server for Windows x64
//   vendor/vcredist/vc_redist.x64.exe     Microsoft Visual C++ runtime, which mongod.exe needs;
//                                         the installer runs it only when the PC lacks it.
//
// The official .zip is ~800 MB, mostly debug symbols. Instead of downloading all of it, this
// reads the zip's central directory with HTTP range requests and fetches only mongod.exe and
// the licence files (~70 MB). Each file's CRC-32 is checked against the zip directory.
//
// Usage: node scripts/fetch-vendor.mjs            (version below)
//        MONGODB_VERSION=8.0.38 node scripts/fetch-vendor.mjs
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const VERSION = process.env.MONGODB_VERSION || '8.0.38';
const URL_ = `https://fastdl.mongodb.org/windows/mongodb-windows-x86_64-${VERSION}.zip`;
const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(desktopDir, 'vendor/mongodb/win32-x64');
const stamp = path.join(outDir, 'VERSION');

const WANTED = [
  { match: (n) => n.endsWith('/bin/mongod.exe'), as: 'mongod.exe' },
  { match: (n) => /^[^/]+\/LICENSE-Community\.txt$/.test(n), as: 'LICENSE-Community.txt' },
  { match: (n) => /^[^/]+\/THIRD-PARTY-NOTICES$/.test(n), as: 'THIRD-PARTY-NOTICES' },
];

const VCREDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const vcredistFile = path.join(desktopDir, 'vendor/vcredist/vc_redist.x64.exe');

async function range(start, end) {
  const res = await fetch(URL_, { headers: { Range: `bytes=${start}-${end}` } });
  if (res.status !== 206) throw new Error(`Range request failed: HTTP ${res.status} for ${URL_}`);
  return { buf: Buffer.from(await res.arrayBuffer()), total: Number(res.headers.get('content-range')?.split('/')[1]) };
}

const u64 = (b, o) => Number(b.readBigUInt64LE(o));

async function fetchMongod() {
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === VERSION && fs.existsSync(path.join(outDir, 'mongod.exe'))) {
    console.log(`mongod.exe ${VERSION} already present in ${path.relative(desktopDir, outDir)}/`);
    return;
  }
  console.log(`Reading zip directory of MongoDB ${VERSION} for Windows…`);
  const tailLen = 128 * 1024;
  const { buf: probe, total } = await range(0, 0);
  if (!total || probe.length !== 1) throw new Error('Server did not report the archive size');
  const tailStart = Math.max(0, total - tailLen);
  const { buf: tail } = await range(tailStart, total - 1);

  const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('End of central directory not found');
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    const loc = eocd - 20; // ZIP64 end-of-central-directory locator
    if (tail.readUInt32LE(loc) !== 0x07064b50) throw new Error('ZIP64 locator not found');
    const z64Off = u64(tail, loc + 8);
    const { buf: z64 } = await range(z64Off, z64Off + 55);
    cdSize = u64(z64, 40);
    cdOffset = u64(z64, 48);
  }
  const { buf: cd } = await range(cdOffset, cdOffset + cdSize - 1);

  const entries = [];
  for (let p = 0; p < cd.length && cd.readUInt32LE(p) === 0x02014b50; ) {
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const name = cd.toString('utf8', p + 46, p + 46 + nameLen);
    let compSize = cd.readUInt32LE(p + 20);
    let size = cd.readUInt32LE(p + 24);
    let offset = cd.readUInt32LE(p + 42);
    // ZIP64 extended info: present fields appear in the order size, compSize, offset.
    for (let e = p + 46 + nameLen, end = e + extraLen; e < end; ) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) (size = u64(cd, q)), (q += 8);
        if (compSize === 0xffffffff) (compSize = u64(cd, q)), (q += 8);
        if (offset === 0xffffffff) offset = u64(cd, q);
      }
      e += 4 + len;
    }
    entries.push({ name, method: cd.readUInt16LE(p + 10), crc: cd.readUInt32LE(p + 16), compSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  fs.mkdirSync(outDir, { recursive: true });
  for (const want of WANTED) {
    const entry = entries.find((e) => want.match(e.name));
    if (!entry) throw new Error(`${want.as} not found in the archive`);
    const { buf: lh } = await range(entry.offset, entry.offset + 29);
    if (lh.readUInt32LE(0) !== 0x04034b50) throw new Error(`Bad local header for ${entry.name}`);
    const dataStart = entry.offset + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
    console.log(`  ${entry.name}  (${(entry.compSize / 1048576).toFixed(1)} MB compressed)`);
    const { buf: data } = await range(dataStart, dataStart + entry.compSize - 1);
    let file;
    if (entry.method === 8) file = zlib.inflateRawSync(data);
    else if (entry.method === 0) file = data;
    else throw new Error(`Unsupported compression method ${entry.method} for ${entry.name}`);
    if (file.length !== entry.size || zlib.crc32(file) !== entry.crc) throw new Error(`Checksum mismatch for ${entry.name}`);
    fs.writeFileSync(path.join(outDir, want.as), file);
  }
  fs.writeFileSync(stamp, `${VERSION}\n`);
  console.log(`Saved to ${path.relative(desktopDir, outDir)}/`);
}

async function fetchVcRedist() {
  if (fs.existsSync(vcredistFile)) {
    console.log(`vc_redist.x64.exe already present in ${path.relative(desktopDir, path.dirname(vcredistFile))}/`);
    return;
  }
  console.log('Downloading Microsoft Visual C++ Redistributable (x64)…');
  const res = await fetch(VCREDIST_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${VCREDIST_URL}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 2).toString() !== 'MZ') throw new Error('vc_redist download is not a Windows executable');
  fs.mkdirSync(path.dirname(vcredistFile), { recursive: true });
  fs.writeFileSync(vcredistFile, buf);
  console.log(`Saved ${(buf.length / 1048576).toFixed(1)} MB to ${path.relative(desktopDir, vcredistFile)}`);
}

async function main() {
  await fetchMongod();
  await fetchVcRedist();
}

main().catch((err) => {
  console.error(`fetch-vendor: ${err.message}`);
  process.exit(1);
});
