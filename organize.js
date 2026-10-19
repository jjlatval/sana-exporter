#!/usr/bin/env node
// organize.js: turn the flat ./transcripts export into a folder tree you can
// drag into Google Drive (or copy into a Google Drive for desktop folder).
//
// Sana lets several folders share one name, and lets one call live in several
// folders. This script fixes both with an editable mapping file:
//
//   1. node organize.js init-mapping
//        Writes folder_mapping.csv with one row per Sana folder. Folders with the
//        same name (ignoring case/spaces) already point at the same Drive folder.
//        Edit the drive_folder column: use "/" for subfolders (e.g. "Acme/Project X"),
//        give several Sana folders the same value to merge them, or leave it
//        empty to skip a folder.
//
//   2. node organize.js build
//        Copies every downloaded transcript into ./drive_upload/<drive_folder>/,
//        named "YYYY-MM-DD Title.docx". A call is written once per Drive folder
//        even if it sat in several Sana folders that now map to the same place.
//        Also writes drive_upload/_index.csv listing where each call ended up.
//
// Options (all optional, paths are relative to the current directory):
//   --log download_log.csv   --transcripts transcripts   --mapping folder_mapping.csv
//   --out drive_upload       --duplicates all|first      --force (init-mapping only)
//
// --duplicates all   (default) a call that sits in Sana folders mapped to
//                    different Drive folders is copied into each of them.
// --duplicates first put it only in the first one (lowest Sana folder position).

const fs = require('fs');
const path = require('path');
const { sanitize, toCsv, readCsvObjects, parseArgs } = require('./lib/common');

const MAPPING_HEADER = ['sana_folder_position', 'sana_folder_name', 'sana_folder_id', 'calls', 'drive_folder'];
const MAX_TITLE_CHARS = 150;

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}

function loadLog(file) {
  if (!fs.existsSync(file)) fail(`log not found: ${file} (run export.js first, or pass --log)`);
  return readCsvObjects(file);
}

// "Sales / Ops" -> "Sales - Ops": a slash in a Sana name is not a subfolder.
function defaultDriveFolder(sanaName) {
  return sanitize(sanaName.replace(/\s*\/\s*/g, ' - '));
}

function cleanDrivePath(p) {
  return p.split('/').map(sanitize).filter(Boolean).join('/');
}

function initMapping(args) {
  const logFile = args.log || 'download_log.csv';
  const mappingFile = args.mapping || 'folder_mapping.csv';
  if (fs.existsSync(mappingFile) && !args.force) {
    fail(`${mappingFile} already exists. Edit it, or pass --force to regenerate it.`);
  }

  const folders = new Map();
  for (const r of loadLog(logFile)) {
    const f = folders.get(r.folderId) || {
      sana_folder_position: r.folderPosition, sana_folder_name: r.folderName,
      sana_folder_id: r.folderId, calls: 0,
    };
    if (r.status === 'downloaded') f.calls++;
    folders.set(r.folderId, f);
  }

  // Same name (case/whitespace-insensitive) -> same Drive folder, spelled like the first one seen.
  const canonical = new Map();
  const rows = [...folders.values()].sort((a, b) => a.sana_folder_position - b.sana_folder_position);
  for (const f of rows) {
    const name = defaultDriveFolder(f.sana_folder_name);
    const key = name.toLowerCase();
    if (!canonical.has(key)) canonical.set(key, name);
    f.drive_folder = canonical.get(key);
  }

  fs.writeFileSync(mappingFile, toCsv(MAPPING_HEADER, rows));
  const merged = rows.length - canonical.size;
  console.log(`Wrote ${mappingFile}: ${rows.length} Sana folders -> ${canonical.size} Drive folders` +
    (merged ? ` (${merged} same-name folders merged).` : '.'));
  console.log('Edit the drive_folder column, then run: node organize.js build');
}

function build(args) {
  const logFile = args.log || 'download_log.csv';
  const transcriptsDir = args.transcripts || 'transcripts';
  const mappingFile = args.mapping || 'folder_mapping.csv';
  const outDir = args.out || 'drive_upload';
  const duplicates = args.duplicates || 'all';
  if (!['all', 'first'].includes(duplicates)) fail('--duplicates must be "all" or "first"');
  if (!fs.existsSync(mappingFile)) fail(`${mappingFile} not found. Run: node organize.js init-mapping`);
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length) {
    fail(`${outDir} already exists and is not empty. Delete it or pass --out <new folder>.`);
  }

  const mapping = new Map();
  for (const m of readCsvObjects(mappingFile)) mapping.set(m.sana_folder_id, cleanDrivePath(m.drive_folder || ''));

  const rows = loadLog(logFile)
    .filter((r) => r.status === 'downloaded')
    .sort((a, b) => a.folderPosition - b.folderPosition);

  // assetId -> { row, sanaFolders, driveFolders (ordered, unique) }
  const calls = new Map();
  const unmappedFolders = new Set();
  for (const r of rows) {
    const call = calls.get(r.assetId) || { row: r, sanaFolders: [], driveFolders: [] };
    call.sanaFolders.push(r.folderName.trim());
    if (!mapping.has(r.folderId)) unmappedFolders.add(`${r.folderName} (${r.folderId})`);
    const dest = mapping.get(r.folderId);
    if (dest && !call.driveFolders.includes(dest)) call.driveFolders.push(dest);
    calls.set(r.assetId, call);
  }

  const usedNames = new Map(); // drive folder -> Set of lowercase file names
  const index = [];
  let copied = 0;
  let missing = 0;
  let skipped = 0;

  for (const [assetId, call] of calls) {
    const dests = duplicates === 'first' ? call.driveFolders.slice(0, 1) : call.driveFolders;
    if (!dests.length) { skipped++; continue; }

    const src = path.join(transcriptsDir, call.row.savedFilename);
    if (!fs.existsSync(src)) {
      console.warn(`  missing file, skipped: ${src}`);
      missing++;
      continue;
    }

    const date = (call.row.savedFilename.match(/^\d{4}-\d{2}-\d{2}/) || ['0000-00-00'])[0];
    const title = sanitize(call.row.callTitle).slice(0, MAX_TITLE_CHARS).trim() || 'Untitled';

    for (const dest of dests) {
      const taken = usedNames.get(dest) || new Set();
      usedNames.set(dest, taken);
      let name = `${date} ${title}.docx`;
      for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${date} ${title} (${n}).docx`;
      taken.add(name.toLowerCase());

      const destDir = path.join(outDir, ...dest.split('/'));
      fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, path.join(destDir, name));
      copied++;

      index.push({
        drive_folder: dest, file: name, call_title: call.row.callTitle, call_date: date,
        sana_folders: [...new Set(call.sanaFolders)].join(' | '),
        also_in: dests.filter((d) => d !== dest).join(' | '),
        sana_asset_id: assetId,
      });
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  index.sort((a, b) => a.drive_folder.localeCompare(b.drive_folder) || a.file.localeCompare(b.file));
  fs.writeFileSync(path.join(outDir, '_index.csv'), toCsv(
    ['drive_folder', 'file', 'call_title', 'call_date', 'sana_folders', 'also_in', 'sana_asset_id'], index,
  ));

  const perFolder = new Map();
  for (const i of index) perFolder.set(i.drive_folder, (perFolder.get(i.drive_folder) || 0) + 1);
  console.log(`\n${outDir}/`);
  for (const [f, n] of [...perFolder].sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${f.padEnd(70)} ${String(n).padStart(5)}`);
  }
  const multi = index.filter((i) => i.also_in).length;
  console.log(`\n${calls.size} unique calls -> ${copied} files in ${perFolder.size} folders.`);
  if (multi) console.log(`${multi} files are copies of a call that also appears in another Drive folder (see also_in in _index.csv).`);
  if (skipped) console.log(`${skipped} calls skipped because their Sana folders have an empty drive_folder.`);
  if (missing) console.log(`${missing} calls skipped because the .docx was missing from ${transcriptsDir}.`);
  if (unmappedFolders.size) {
    console.log(`Not in ${mappingFile} (skipped): ${[...unmappedFolders].join(', ')}. Re-run init-mapping --force or add rows.`);
  }
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
if (cmd === 'init-mapping') initMapping(args);
else if (cmd === 'build') build(args);
else {
  console.log('Usage:\n  node organize.js init-mapping [--force]\n  node organize.js build [--out drive_upload] [--duplicates all|first]');
  process.exit(cmd ? 1 : 0);
}
