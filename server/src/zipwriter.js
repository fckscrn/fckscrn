import fs from "node:fs";
import zlib from "node:zlib";

// Streaming ZIP writer (stored, no compression: presentations and videos are compressed already).
// Uses data descriptors, so file sizes and CRCs don't have to be known up front. No zip64 (< 4 GB).
export async function writeZip(out, entries) {
  let offset = 0;
  const central = [];
  const write = buf => new Promise((res, rej) => {
    offset += buf.length;
    out.write(buf, err => (err ? rej(err) : res()));
  });

  for (const { name, file, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const start = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0808, 6); // bit 3: data descriptor, bit 11: UTF-8 names
    local.writeUInt16LE(nameBuf.length, 26);
    await write(Buffer.concat([local, nameBuf]));

    let crc = 0, size = 0;
    const chunks = data != null ? [Buffer.from(data)] : fs.createReadStream(file);
    for await (const chunk of chunks) {
      crc = zlib.crc32(chunk, crc);
      size += chunk.length;
      await write(chunk);
    }
    const desc = Buffer.alloc(16);
    desc.writeUInt32LE(0x08074b50, 0); desc.writeUInt32LE(crc, 4); desc.writeUInt32LE(size, 8); desc.writeUInt32LE(size, 12);
    await write(desc);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0808, 8);
    c.writeUInt32LE(crc, 16); c.writeUInt32LE(size, 20); c.writeUInt32LE(size, 24);
    c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(start, 42);
    central.push(Buffer.concat([c, nameBuf]));
  }

  const cdStart = offset;
  const cd = Buffer.concat(central);
  await write(cd);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(cdStart, 16);
  await write(end);
  out.end();
}
