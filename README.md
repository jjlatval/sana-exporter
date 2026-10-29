# sana-exporter

**Get your meeting transcripts out of [Sana AI](https://sana.ai).**

## Why this exists

Sana AI records and transcribes your meetings, but gives you no way to get those transcripts out in bulk: no API for transcripts and no "export all" button. The only way out is to open each call and click **Download transcript (.docx)**, one at a time. With hundreds or thousands of calls, that isn't realistic, whether you're leaving Sana, backing up your data, or moving your meeting archive to Google Drive, SharePoint or your own tools.

This repository does those clicks for you. It drives the normal Sana web app in a real Chrome window with your own login, downloads every transcript in every folder, and then sorts them into a clean folder tree that's ready to upload anywhere.

Along the way it fixes two things Sana allows that normal file storage handles badly:

- **Several folders with the same name.** Sana happily lets you have three folders called "Acme". They are merged into one.
- **One call in several folders.** Each call is downloaded once and placed in every folder it belongs to (or only the first one, if you prefer).

## What you get

```
drive_upload/
├── Acme/
│   ├── 2025-03-03 Weekly sync.docx
│   ├── 2025-03-10 Weekly sync.docx
│   └── Project X/
│       └── 2025-04-01 Kickoff.docx
├── Internal/
│   └── Team meetings/
│       └── ...
└── _index.csv        ← every file, its date, and the Sana folders it came from
```

## Requirements

- [Node.js](https://nodejs.org) 18 or newer
- A Sana AI account that can see the folders you want to export
- macOS, Windows or Linux

## Setup

```bash
git clone https://github.com/jjlatval/sana-exporter.git
cd sana-exporter
npm install
npx playwright install chromium
```

## 1. Download the transcripts

```bash
node export.js
```

A Chrome window opens on sana.ai. Log in the way you normally do (SSO, password, etc.). As soon as your workspace opens, the script reads its address from the address bar and starts walking through every folder.

Your workspace lives at an address like `https://sana.ai/AbCdEf123456`. The random part is your workspace id, and it's different for every company. If you belong to several workspaces, or detection doesn't work, pass it yourself:

```bash
node export.js --workspace https://sana.ai/AbCdEf123456
```

You only log in once: the session is kept in `.sana-browser-profile/`. The script writes:

| Output | What it is |
|---|---|
| `transcripts/` | One `.docx` per call: `YYYY-MM-DD_<Sana folder>_<call title>.docx` |
| `download_log.csv` | One row per folder and call: folder and call ids, date, file name, status |

You can stop it with Ctrl+C and run it again whenever you like. Finished calls are skipped and failed ones are retried. Expect about 200 calls an hour, so a few thousand calls take a night. Run it once more at the end to retry the calls that timed out.

<details>
<summary>Statuses in <code>download_log.csv</code></summary>

- `downloaded`: saved and checked: the title inside the file is the call's title, and no other call's file has the same text
- `skipped_no_transcript`: Sana says the call has no transcript (not retried)
- `wrong_transcript`: the file held a different call; it was moved to `transcripts/_rejected/` and is retried on the next run
- `downloaded_suspicious`, `skipped_unknown`, `skipped_no_menu_item`, `error: ...`: retried on the next run

Every run first re-checks the files it already downloaded, so running it again also repairs an export made with an older version.

</details>

## 2. Organize into folders

```bash
node organize.js init-mapping
```

This writes `folder_mapping.csv`, one row per Sana folder:

| sana_folder_name | sana_folder_id | calls | drive_folder |
|---|---|---|---|
| Acme MASTER | aB12cD34eF56 | 187 | Acme MASTER |
| Acme | gH78iJ90kL12 | 27 | Acme |
| Acme | mN34oP56qR78 | 12 | Acme |
| Acme - Project X | sT90uV12wX34 | 15 | Acme - Project X |

Folders with the same name already point at the same place. Open the file in Excel, Numbers or Google Sheets and edit the `drive_folder` column:

- **Merge:** give several Sana folders the same value, e.g. `Acme`
- **Nest:** use `/` for subfolders, e.g. `Acme/Project X`
- **Skip:** leave it empty

Then build the tree:

```bash
node organize.js build
```

This creates `drive_upload/`. Files are named `YYYY-MM-DD Call title.docx` so they sort by date. `drive_upload/_index.csv` lists every file, the Sana folders the call came from, and any other folders it was also copied into.

| Option | Effect |
|---|---|
| `--duplicates first` | A call that's in several Sana folders goes only into the first one instead of each |
| `--out <folder>` | Write somewhere other than `drive_upload/` |
| `--log`, `--transcripts`, `--mapping` | Read inputs from other paths |

To try a different layout, edit the mapping, delete `drive_upload/` and run `build` again. Your downloads are never touched.

## 3. Upload

**Google Drive in the browser:** create an empty folder (e.g. `Sana export`), open it, and drag the folders from `drive_upload/` into it. Then move them where you want them.

**Google Drive for desktop:** copy `drive_upload/` into your Drive folder, and choose *merge* rather than *replace* if a folder already exists. On macOS, `ditto drive_upload "<path to your Drive folder>"` merges safely.

> Google Drive also allows two folders with the same name. Uploading an `Acme` folder next to an existing `Acme` folder creates a second `Acme` instead of merging, so upload into an empty folder first and move from there.

Want Google Docs instead of Word files? Turn on **Settings → Convert uploads** in Drive before uploading.

## Privacy and security

- Everything runs on your machine. Nothing is sent anywhere except to Sana itself, through the same web app you already use.
- `.sana-browser-profile/` contains your **Sana login session**. Treat it like a password and delete it when you're done.
- `transcripts/`, `drive_upload/`, `download_log.csv` and `folder_mapping.csv` contain your company's meeting content and folder names.

All of these are in `.gitignore`. Never commit them or upload them anywhere public.

## Limitations

- It automates the Sana web UI, so a Sana redesign can break it. If a step stops working, the selectors in `export.js` (`collectFolders`, `scrapeListItems`, `downloadTranscriptForCall`) are the place to look. Pull requests are welcome.
- Only meeting transcripts are exported, not AI summaries, chats or uploaded documents.
- Sana shows dates without a year for the current year, so the year is inferred.

## Disclaimer

This is an independent community project, not affiliated with or endorsed by Sana Labs. It only accesses what your own account can already see, the same way you would by hand. You are responsible for following your organization's policies and Sana's terms of service.

## License

[MIT](LICENSE)
