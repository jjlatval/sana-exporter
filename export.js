#!/usr/bin/env node
// export.js: download every meeting transcript (.docx) from a Sana AI workspace.
//
// Usage:
//   node export.js
//   node export.js --workspace https://sana.ai/<workspace-id>   (pick a workspace explicitly;
//                                                                or set SANA_WORKSPACE)
//
// A Chrome window opens. On the first run, log in to Sana yourself (SSO, password,
// whatever your workspace uses). Without --workspace, the workspace is read from
// the address bar once you are logged in. The session is kept in ./.sana-browser-profile so
// later runs skip the login. Treat that folder like a password: it holds your
// session cookies.
//
// Output goes to the current directory:
//   ./transcripts/YYYY-MM-DD_<Sana folder>_<call title>.docx
//   ./download_log.csv   one row per (folder, call), used to resume and by organize.js
//
// Safe to stop (Ctrl+C) and re-run: calls already logged as 'downloaded' or
// 'skipped_no_transcript' are skipped; everything else is retried. Every downloaded
// file is checked against the call it was saved as; files that hold another call
// are moved to ./transcripts/_rejected and retried.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { LOG_HEADER, sanitize, csvEscape, readCsvObjects, latestRows, parseArgs } = require('./lib/common');
const { readTranscript, sameTitle } = require('./lib/transcript');

const args = parseArgs(process.argv.slice(2));

// Workspace URLs look like https://sana.ai/<id>/..., where <id> is a random
// mixed-case string such as "AbCdEf123456". Requiring an uppercase letter or digit
// keeps ordinary pages like https://sana.ai/onboarding from matching.
function workspaceIdFrom(value) {
  const id = String(value).replace(/^https?:\/\/(www\.)?sana\.ai\//, '').split(/[/?#]/)[0];
  return /^[A-Za-z0-9_-]{8,24}$/.test(id) && /[A-Z0-9]/.test(id) ? id : null;
}

const workspaceArg = args.workspace || process.env.SANA_WORKSPACE;
let WORKSPACE = null;
if (workspaceArg) {
  const id = workspaceArg !== true && workspaceIdFrom(workspaceArg);
  if (!id) {
    console.error('Usage: node export.js [--workspace https://sana.ai/<workspace-id>]');
    process.exit(1);
  }
  WORKSPACE = `https://sana.ai/${id}`;
}

const DATA_DIR = path.resolve(args.dir || '.');
const USER_DATA_DIR = path.join(DATA_DIR, '.sana-browser-profile');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'transcripts');
const REJECTED_DIR = path.join(DOWNLOAD_DIR, '_rejected');
const LOG_CSV = path.join(DATA_DIR, 'download_log.csv');

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', sept: '09', oct: '10', nov: '11', dec: '12',
};

// Parses "22 Oct 2025, 08:38" / "18 Sept 2025" / "31 Mar, 19:27" -> "YYYY-MM-DD".
// Sana leaves out the year for dates in the current calendar year. A yearless
// date is assumed to be this year, or last year if that would put it in the future.
function parseDate(dateText, now = new Date()) {
  const m = dateText.match(/(\d{1,2})\s+([A-Za-z]+)\.?\s*(\d{4})?/);
  if (!m) return '0000-00-00';
  const day = m[1].padStart(2, '0');
  const monKey = m[2].toLowerCase().slice(0, 4);
  const mon = MONTHS[monKey] || MONTHS[monKey.slice(0, 3)] || '00';
  let year = m[3] ? Number(m[3]) : now.getFullYear();
  if (!m[3] && new Date(year, Number(mon) - 1, Number(day)) > now) year--;
  return `${year}-${mon}-${day}`;
}

function appendLogRow(row) {
  if (!fs.existsSync(LOG_CSV)) fs.writeFileSync(LOG_CSV, LOG_HEADER.join(',') + '\n');
  fs.appendFileSync(LOG_CSV, LOG_HEADER.map((h) => csvEscape(row[h])).join(',') + '\n');
}

// Moves a file that failed its check out of transcripts/, so organize.js never
// picks it up and its name is free for the re-download.
function reject(filename) {
  const src = path.join(DOWNLOAD_DIR, filename);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(REJECTED_DIR, { recursive: true });
  let dest = path.join(REJECTED_DIR, filename);
  for (let n = 1; fs.existsSync(dest); n++) dest = path.join(REJECTED_DIR, filename.replace(/\.docx$/, ` (${n}).docx`));
  fs.renameSync(src, dest);
}

function loadLog() {
  // done: folder+call pairs not to retry. downloaded: assetId -> file already on disk,
  // so a call that sits in several folders is only fetched from Sana once.
  // owners: transcript fingerprint -> assetId, to spot a file holding another call's text.
  const done = new Set();
  const downloaded = new Map();
  const owners = new Map();
  if (!fs.existsSync(LOG_CSV)) return { done, downloaded, owners };

  const rows = latestRows(readCsvObjects(LOG_CSV));
  const onDisk = [];
  for (const r of rows) {
    if (r.status === 'skipped_no_transcript') done.add(`${r.folderId}|||${r.assetHref}`);
    if (r.status !== 'downloaded') continue;
    const file = path.join(DOWNLOAD_DIR, r.savedFilename);
    if (fs.existsSync(file)) onDisk.push({ r, doc: readTranscript(file) });
    else done.add(`${r.folderId}|||${r.assetHref}`);
  }

  // Re-check earlier downloads: versions before this check saved the previous
  // call's transcript under the next call's name. A file is kept only if its title
  // is the call's title and no other call's file has the same text.
  const callsWithText = new Map();
  for (const { r, doc } of onDisk) {
    if (!doc) continue;
    const ids = callsWithText.get(doc.fingerprint) || new Set();
    callsWithText.set(doc.fingerprint, ids.add(r.assetId));
  }
  let rejected = 0;
  for (const { r, doc } of onDisk) {
    if (doc && sameTitle(doc.title, r.callTitle) && callsWithText.get(doc.fingerprint).size === 1) {
      done.add(`${r.folderId}|||${r.assetHref}`);
      downloaded.set(r.assetId, r.savedFilename);
      owners.set(doc.fingerprint, r.assetId);
    } else {
      reject(r.savedFilename);
      appendLogRow({ ...r, status: 'wrong_transcript' });
      rejected++;
    }
  }
  if (rejected) {
    console.log(`${rejected} earlier downloads contain a different call than their name says.`);
    console.log(`Moved them to ${REJECTED_DIR}; they will be downloaded again.`);
  }
  return { done, downloaded, owners };
}

// Never overwrite an existing file, including ones from earlier runs.
function uniqueFilename(baseName) {
  let name = `${baseName}.docx`;
  for (let n = 1; fs.existsSync(path.join(DOWNLOAD_DIR, name)); n++) name = `${baseName} (${n}).docx`;
  return name;
}

async function collectFolders(page) {
  await page.goto(`${WORKSPACE}/folders`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const containerSel = 'div[class*="SidebarScrollableContainer"]';
  await page.waitForSelector(containerSel, { timeout: 15000 });

  const folders = new Map();
  let lastSize = -1;
  let stableRounds = 0;
  let declaredTotal = null;

  for (let i = 0; i < 300; i++) {
    const found = await page.$$eval('a[href*="/folders/"]', (links) =>
      links
        .map((l) => ({ href: l.getAttribute('href'), aria: l.getAttribute('aria-label') }))
        .filter((x) => x.aria && /position \d+ of \d+/.test(x.aria))
    );
    for (const f of found) {
      const m = f.aria.match(/^(.*), position (\d+) of (\d+)$/);
      if (m) {
        const id = f.href.split('/folders/')[1];
        folders.set(id, { id, name: m[1], position: parseInt(m[2], 10) });
        declaredTotal = parseInt(m[3], 10);
      }
    }
    if (declaredTotal && folders.size >= declaredTotal) break;
    if (folders.size === lastSize) stableRounds++; else stableRounds = 0;
    lastSize = folders.size;
    if (stableRounds >= 6) break;

    await page.$eval(containerSel, (el) => el.scrollBy(0, 500)).catch(() => {});
    await page.waitForTimeout(350);
  }

  return Array.from(folders.values()).sort((a, b) => a.position - b.position);
}

const CALL_LINK = 'a[href*="/agent#with="]';

async function scrapeListItems(page) {
  return page.$$eval(CALL_LINK, (anchors) =>
    anchors.map((a) => {
      const text = a.innerText || '';
      const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
      const idx = lines.findIndex((l) => l === 'Meeting');
      const title = idx > 0 ? lines[idx - 1] : lines[0] || 'Untitled';
      const date = idx >= 0 && lines[idx + 1] ? lines[idx + 1] : '';
      return { href: a.getAttribute('href'), title, date };
    })
  );
}

async function collectAllItemsInFolder(page, folderId) {
  await page.goto(`${WORKSPACE}/folders/${folderId}`, { waitUntil: 'domcontentloaded' });
  // The call list renders a moment after the page. Read too early, a full folder
  // looks empty and is silently skipped, so wait for the first call to appear.
  // A folder that really is empty costs the 15 s timeout.
  await page.waitForSelector(CALL_LINK, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1200);

  const items = [];
  const seenHrefs = new Set();

  for (let pageNum = 1; pageNum <= 200; pageNum++) {
    await page.waitForTimeout(400);
    const pageItems = await scrapeListItems(page);
    for (const it of pageItems) {
      if (it.href && !seenHrefs.has(it.href)) {
        seenHrefs.add(it.href);
        items.push(it);
      }
    }

    const nextBtn = page.getByRole('button', { name: 'Next', exact: true });
    const nextCount = await nextBtn.count();
    if (nextCount === 0) break;
    const isDisabled = await nextBtn.first().isDisabled().catch(() => true);
    if (isDisabled) break;
    // Wait for the next page to replace this one; otherwise this page is read
    // twice and the following click jumps past the next page.
    const firstHref = pageItems.length ? pageItems[0].href : null;
    await nextBtn.first().click();
    await page.waitForFunction(
      ([sel, href]) => document.querySelector(sel)?.getAttribute('href') !== href,
      [CALL_LINK, firstHref],
      { timeout: 15000 },
    ).catch(() => {});
    await page.waitForTimeout(600);
  }

  return items;
}

async function downloadTranscriptForCall(page, href) {
  // Calls differ only after the '#' (.../agent#with=<id>), so going straight from one
  // call to the next is an in-page hash change: Sana keeps the previous call open
  // and its transcript gets downloaded again. Leaving the page forces a full load.
  await page.goto('about:blank');
  await page.goto(`https://sana.ai${href}`, { waitUntil: 'domcontentloaded' });

  // Scoped to the header toolbar (<nav class="navigation-bar...">) so this never
  // collides with the chat panel's own per-message "Share"/"..." action buttons.
  const moreBtn = page
    .locator('nav[class*="navigation-bar"] button[aria-haspopup="menu"]')
    .nth(1);
  await moreBtn.waitFor({ state: 'visible', timeout: 20000 });
  await page.keyboard.press('Escape').catch(() => {}); // close any stray menu first
  await moreBtn.click();

  const menuItem = page.getByRole('menuitem', { name: 'Download transcript (.docx)' });
  await menuItem.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
  if ((await menuItem.count()) === 0) {
    await page.keyboard.press('Escape').catch(() => {});
    return { status: 'skipped_no_menu_item' };
  }

  let download = null;
  let noTranscript = false;

  const downloadWait = page
    .waitForEvent('download', { timeout: 15000 })
    .then((d) => { download = d; })
    .catch(() => {});
  const toastWait = page
    .getByText('No transcript available', { exact: false })
    .waitFor({ state: 'visible', timeout: 15000 })
    .then(() => { noTranscript = true; })
    .catch(() => {});

  await menuItem.click();
  await Promise.allSettled([downloadWait, toastWait]);

  if (download) return { status: 'downloaded', download };
  if (noTranscript) return { status: 'skipped_no_transcript' };
  return { status: 'skipped_unknown' };
}

(async () => {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const { done, downloaded, owners } = loadLog();

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    acceptDownloads: true,
    viewport: { width: 1400, height: 920 },
  });
  const page = context.pages()[0] || (await context.newPage());

  console.log('If you are not logged in, please log in now in the opened browser window.');
  if (!WORKSPACE) {
    // No --workspace given: open Sana and read the workspace id from the address
    // bar once the login lands on a workspace page.
    await page.goto('https://sana.ai/', { waitUntil: 'domcontentloaded' });
    console.log('Waiting for your Sana workspace to open (up to 5 minutes)...');
    await page.waitForURL((url) => url.hostname.endsWith('sana.ai') && workspaceIdFrom(url.href), { timeout: 300000 })
      .catch(() => {
        console.error('Could not detect your workspace. Open Sana in the browser, copy the address up to the');
        console.error('workspace id (https://sana.ai/<workspace-id>) and run: node export.js --workspace <that URL>');
        process.exit(1);
      });
    WORKSPACE = `https://sana.ai/${workspaceIdFrom(page.url())}`;
    console.log(`Detected workspace: ${WORKSPACE} (pass --workspace to choose another one)`);
  }

  await page.goto(`${WORKSPACE}/folders`, { waitUntil: 'domcontentloaded' });
  console.log('Waiting for the folder sidebar to appear (up to 2 minutes)...');
  await page.waitForSelector('a[href*="/folders/"]', { timeout: 120000 });

  const folders = await collectFolders(page);
  console.log(`Found ${folders.length} folders.`);

  for (const folder of folders) {
    console.log(`\n=== Folder ${folder.position}: ${folder.name} (${folder.id}) ===`);
    const items = await collectAllItemsInFolder(page, folder.id);
    console.log(`  ${items.length} calls found.`);

    for (const item of items) {
      const key = `${folder.id}|||${item.href}`;
      if (done.has(key)) {
        console.log(`  [skip, already logged] ${item.title}`);
        continue;
      }

      const assetId = (item.href.split('with=')[1] || '').trim();
      const baseName = sanitize(`${parseDate(item.date)}_${folder.name}_${item.title}`);
      const logRow = {
        folderPosition: folder.position, folderName: folder.name, folderId: folder.id,
        callTitle: item.title, callDate: item.date, assetHref: item.href, assetId,
      };

      // Same call already downloaded from another folder: reuse the file.
      if (downloaded.has(assetId)) {
        const finalName = uniqueFilename(baseName);
        fs.copyFileSync(path.join(DOWNLOAD_DIR, downloaded.get(assetId)), path.join(DOWNLOAD_DIR, finalName));
        console.log(`  [OK, copied from earlier download] ${item.title} -> ${finalName}`);
        appendLogRow({ ...logRow, savedFilename: finalName, status: 'downloaded' });
        continue;
      }

      try {
        const result = await downloadTranscriptForCall(page, item.href);

        if (result.status === 'downloaded') {
          const finalName = uniqueFilename(baseName);
          const destPath = path.join(DOWNLOAD_DIR, finalName);
          await result.download.saveAs(destPath);

          // Check it is the call we asked for: a readable .docx whose title is this
          // call's title and whose text no other call has.
          const doc = readTranscript(destPath);
          const owner = doc && owners.get(doc.fingerprint);
          let status = 'downloaded';
          if (!doc) status = 'downloaded_suspicious';
          else if (!sameTitle(doc.title, item.title) || (owner && owner !== assetId)) status = 'wrong_transcript';

          if (status === 'downloaded') {
            downloaded.set(assetId, finalName);
            owners.set(doc.fingerprint, assetId);
            console.log(`  [OK] ${item.title} -> ${finalName}`);
          } else {
            reject(finalName);
            console.log(`  [${status}, will retry] ${item.title}${doc ? ` (file contains: ${doc.title})` : ''}`);
          }
          appendLogRow({ ...logRow, savedFilename: finalName, status });
        } else {
          console.log(`  [SKIP: ${result.status}] ${item.title}`);
          appendLogRow({ ...logRow, savedFilename: '', status: result.status });
        }
      } catch (err) {
        console.log(`  [ERROR] ${item.title}: ${err.message}`);
        appendLogRow({ ...logRow, savedFilename: '', status: `error: ${err.message}`.slice(0, 200) });
      }
    }
  }

  console.log('\nAll done. See download_log.csv for the full mapping.');
  console.log('Next: node organize.js init-mapping   (then edit folder_mapping.csv and run: node organize.js build)');
  await context.close();
})();
