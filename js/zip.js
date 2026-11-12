// Minimal ZIP writer (stored, no compression — PNG/JPEG are already compressed).
// Produces a Blob; enough for exporting training sets without a dependency.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export class ZipWriter {
  constructor() {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
    this.stamp = dosDateTime(new Date());
  }

  /** @param {string} name  path inside the archive  @param {Uint8Array|ArrayBuffer|string} content */
  add(name, content) {
    const data = typeof content === 'string' ? new TextEncoder().encode(content)
      : content instanceof Uint8Array ? content : new Uint8Array(content);
    const nameBytes = new TextEncoder().encode(name);
    if (this.entries.length >= 65535) throw new Error('ZIP_TOO_MANY_FILES');
    if (this.offset + data.length + nameBytes.length + 30 > 0xfff00000) throw new Error('ZIP_TOO_LARGE');
    const crc = crc32(data);
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);        // version needed
    header.setUint16(6, 0x0800, true);    // UTF-8 names
    header.setUint16(8, 0, true);         // stored
    header.setUint16(10, this.stamp.time, true);
    header.setUint16(12, this.stamp.day, true);
    header.setUint32(14, crc, true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, data.length, true);
    header.setUint16(26, nameBytes.length, true);
    header.setUint16(28, 0, true);
    this.parts.push(header.buffer, nameBytes, data);
    this.entries.push({ nameBytes, crc, size: data.length, offset: this.offset });
    this.offset += 30 + nameBytes.length + data.length;
  }

  /** @returns {Blob} */
  finish() {
    const start = this.offset;
    let size = 0;
    for (const e of this.entries) {
      const h = new DataView(new ArrayBuffer(46));
      h.setUint32(0, 0x02014b50, true);
      h.setUint16(4, 20, true);
      h.setUint16(6, 20, true);
      h.setUint16(8, 0x0800, true);
      h.setUint16(10, 0, true);
      h.setUint16(12, this.stamp.time, true);
      h.setUint16(14, this.stamp.day, true);
      h.setUint32(16, e.crc, true);
      h.setUint32(20, e.size, true);
      h.setUint32(24, e.size, true);
      h.setUint16(28, e.nameBytes.length, true);
      h.setUint32(42, e.offset, true);
      this.parts.push(h.buffer, e.nameBytes);
      size += 46 + e.nameBytes.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, start, true);
    this.parts.push(end.buffer);
    return new Blob(this.parts, { type: 'application/zip' });
  }
}
