// Reads the text of a downloaded Sana transcript (.docx) so export.js can check
// that the file really is the call it was saved as. No dependencies.

const fs = require('fs');
const zlib = require('zlib');
const crypto = require('crypto');

// Returns the uncompressed bytes of one file inside a zip (a .docx is a zip), or null.
function readZipEntry(buf, name) {
  // The end-of-central-directory record sits in the last 22 bytes + up to 64 KB of comment.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const next = p + 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const local = buf.readUInt32LE(p + 42);
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return zlib.inflateRawSync(data);
      return null;
    }
    p = next;
  }
  return null;
}

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(s) {
  return s.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(amp|lt|gt|quot|apos));/gi, (m, hex, dec, named) =>
    hex ? String.fromCodePoint(parseInt(hex, 16))
      : dec ? String.fromCodePoint(Number(dec))
        : XML_ENTITIES[named.toLowerCase()]);
}

// Returns { title, fingerprint } for a Sana transcript, or null if the file is not
// a readable .docx. Sana puts the meeting title in the first paragraph. The
// fingerprint is a hash of the whole text: two different calls never share one.
function readTranscript(file) {
  try {
    const xml = readZipEntry(fs.readFileSync(file), 'word/document.xml');
    if (!xml) return null;
    const paragraphs = xml.toString('utf8').split('</w:p>')
      .map((p) => decodeXml(p.replace(/<[^>]*>/g, '')).trim())
      .filter(Boolean);
    return {
      title: paragraphs[0] || '',
      fingerprint: crypto.createHash('sha1').update(paragraphs.join('\n')).digest('hex'),
    };
  } catch {
    return null;
  }
}

function sameTitle(a, b) {
  const norm = (s) => String(s).normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

module.exports = { readTranscript, sameTitle };
