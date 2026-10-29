// Small helpers shared by export.js and organize.js. No dependencies.

const fs = require('fs');

const LOG_HEADER = [
  'folderPosition', 'folderName', 'folderId', 'callTitle', 'callDate',
  'assetHref', 'assetId', 'savedFilename', 'status',
];

// Characters that are illegal in file names on Windows/macOS, plus control chars.
function sanitize(name) {
  return String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(header, rows) {
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) lines.push(header.map((h) => csvEscape(r[h])).join(','));
  return lines.join('\n') + '\n';
}

// RFC 4180-ish parser: handles quoted fields, escaped quotes and newlines inside quotes.
function parseCsv(text) {
  const records = [];
  let row = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cur); cur = '';
      if (row.length > 1 || row[0] !== '') records.push(row);
      row = [];
    } else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); records.push(row); }
  return records;
}

// Reads a CSV with a header row into an array of objects.
function readCsvObjects(file) {
  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  if (!header) return [];
  return rows.map((cols) => Object.fromEntries(header.map((h, i) => [h.trim(), cols[i] ?? ''])));
}

// download_log.csv is append-only, so one folder+call can have several rows across
// runs (an error, then a download; a download, then a rejection). The last row is
// its current state.
function latestRows(rows) {
  const latest = new Map();
  for (const r of rows) latest.set(`${r.folderId}|||${r.assetHref}`, r);
  return [...latest.values()];
}

// Tiny "--flag value" / "--flag" argument parser.
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      if (inline !== undefined) args[k] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
      else args[k] = true;
    } else args._.push(a);
  }
  return args;
}

module.exports = { LOG_HEADER, sanitize, csvEscape, toCsv, parseCsv, readCsvObjects, latestRows, parseArgs };
