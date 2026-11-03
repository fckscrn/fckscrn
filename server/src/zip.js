import fs from "node:fs";
import zlib from "node:zlib";
import { Readable } from "node:stream";

// Minimal ZIP reader (no zip64), enough for .pptx/.key/.odp packages.
// Takes a Buffer or a file path. With a path only the directory and the entries asked for are read,
// so a 2 GB presentation full of videos never has to fit in memory.
// Returns Map<name, () => Buffer> (+ close() for files). get(name).stream() streams one entry
// (videos inside a presentation can be hundreds of MB).
export function readZip(src) {
  const r = typeof src === "string" ? fileReader(src) : bufReader(src);
  try {
    const tailLen = Math.min(r.size, 65557);
    const tail = r.read(r.size - tailLen, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("not a zip file");
    const count = tail.readUInt16LE(eocd + 10);
    const dirSize = tail.readUInt32LE(eocd + 12);
    const dir = r.read(tail.readUInt32LE(eocd + 16), dirSize);
    let off = 0;
    const entries = new Map();
    for (let n = 0; n < count; n++) {
      if (dir.readUInt32LE(off) !== 0x02014b50) throw new Error("corrupt zip directory");
      const method = dir.readUInt16LE(off + 10);
      const csize = dir.readUInt32LE(off + 20);
      const nameLen = dir.readUInt16LE(off + 28);
      const extraLen = dir.readUInt16LE(off + 30);
      const commentLen = dir.readUInt16LE(off + 32);
      const local = dir.readUInt32LE(off + 42);
      const name = dir.toString("utf8", off + 46, off + 46 + nameLen);
      const dataAt = () => { const head = r.read(local, 30); return local + 30 + head.readUInt16LE(26) + head.readUInt16LE(28); };
      const get = () => {
        const data = r.read(dataAt(), csize);
        return method === 0 ? Buffer.from(data) : zlib.inflateRawSync(data);
      };
      get.stream = () => {
        const raw = r.stream(dataAt(), csize);
        return method === 0 ? raw : raw.pipe(zlib.createInflateRaw());
      };
      entries.set(name, get);
      off += 46 + nameLen + extraLen + commentLen;
    }
    entries.close = r.close;
    return entries;
  } catch (e) { r.close(); throw e; }
}

function bufReader(buf) {
  return { size: buf.length, read: (pos, len) => buf.subarray(pos, pos + len), stream: (pos, len) => Readable.from([buf.subarray(pos, pos + len)]), close() {} };
}
function fileReader(file) {
  const fd = fs.openSync(file, "r");
  return {
    size: fs.fstatSync(fd).size,
    read(pos, len) { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, pos); return b; },
    // own file handle: the stream may outlive close()
    stream: (pos, len) => len ? fs.createReadStream(file, { start: pos, end: pos + len - 1 }) : Readable.from([]),
    close() { try { fs.closeSync(fd); } catch {} },
  };
}
