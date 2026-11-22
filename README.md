# In The Loop Verification Tool

A static review workspace for comparing agent-collected screenshots with scraped spreadsheet data. Inspect the evidence beside its claimed values, then mark each asset **incorrect**, **inconclusive**, or **correct**.

- [Open the GitHub Pages app](https://yana-157.github.io/in-the-loop-verification-tool/)
- [Public tool repository](https://github.com/yana-157/in-the-loop-verification-tool)

The included sample consists of five real screenshots and their scraped claims from public Faridabad Medical Center and Arti Hospital webpages. They were explicitly approved for inclusion in this public tool repository. These examples begin unrated; displaying a sample does not certify its claims. See [sample provenance](samples/README.md). Your own imported spreadsheets and review decisions stay in your browser.

## Run locally

With Python 3 installed, run from this directory:

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

Open <http://127.0.0.1:4173/>. Alternatively, use `npm run dev`. There are no dependencies to install and no build step. Use an HTTP server rather than opening `index.html` with `file://`, because JavaScript modules and sample loading require an HTTP origin.

Run tests with Node 22 or later:

```sh
npm test
```

## Deploy to GitHub Pages

The [Pages workflow](.github/workflows/pages.yml) runs the tests, stages only runtime assets, and publishes the app when `main` changes. It can also be run manually from the Actions tab.

For a new repository:

1. Copy this folder's contents to the repository root, including `.github` and `.nojekyll`.
2. In **Settings → Pages → Build and deployment**, select **GitHub Actions**.
3. Push to `main` and wait for **Deploy In The Loop to GitHub Pages** to finish.
4. Open `https://YOUR-USERNAME.github.io/YOUR-REPOSITORY/`.

The app uses relative resource URLs and works under a project subpath. Tests, documentation, and package metadata are excluded from the deployment. No backend, database, GitHub token, or API keys are needed. See [GitHub's publishing-source documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site).

## Prepare a spreadsheet

Import `.csv`, `.tsv`, or `.xlsx` files up to 20 MB and 25,000 rows. Choose a worksheet for Excel files. The import dialog lets you map a screenshot column and optional title and ID columns when headers differ from the defaults.

Each nonempty row represents one screenshot and its scraped claims:

| Column | Purpose |
| --- | --- |
| `id` | Optional stable, unique record identifier. |
| `title` | Optional human-readable asset name. |
| `screenshot_path` | Required screenshot path or URL; alternate headers can be mapped. |
| `source_url` | Optional original webpage address. |
| Other columns | Scraped values to compare against the screenshot. |

```csv
id,title,screenshot_path,source_url,facility_name,bed_count
example-001,Example facility,screenshots/example-001.png,https://example.com/facility,Example facility,120
```

Screenshot references can be:

- A repository-relative path such as `screenshots/example-001.png`, resolved against the repository and branch entered during import.
- A public GitHub file link such as `https://github.com/OWNER/REPO/blob/main/screenshots/example-001.png`.
- A raw GitHub URL or another public HTTP(S) image URL.
- An app-relative path beginning `./`, as used by the bundled sample.

Private GitHub files cannot be loaded anonymously. Use **Attach screenshots** to select matching local image files instead. These files stay in the current browser session and must be reattached after a reload. If different paths share the same filename, attachment is rejected to avoid showing the wrong evidence; give those files unique names and update the spreadsheet. The app never asks for a GitHub token.

## Review assets

The sidebar has separate lists for pending, accepted, rejected, and inconclusive assets. Only one can expand at a time. Each list supports **1**, **10**, or **50** assets per page, previous/next page arrows, a page selector, search, and direct selection of any asset.

The top tracker shows reviewed and remaining counts. All three decisions count as reviewed; inconclusive is never counted as accepted. Use image zoom and the expanded screenshot view when more detail is needed.

- **1 / red ×:** Incorrect; moves the asset to rejected.
- **2 / purple ?:** Inconclusive.
- **3 / green ✓:** Correct; moves the asset to accepted.

Use the previous/next asset buttons or left/right arrow keys to navigate. Add an optional note, revise a rating, or clear it to return the asset to the pending queue. Rating does not automatically advance unless **Advance after rating** is enabled. Shortcuts are ignored while typing or while a dialog is open.

## Save and export

Review state is saved in this browser's local storage, keyed to the dataset's content. Reloading restores the active workspace. Reimporting an unchanged source spreadsheet restores its local draft; explicit `review_status` values in an imported review export take precedence. Clearing browser data or changing browsers removes access to that local state. There is no automatic write to GitHub or the source spreadsheet.

**Export reviews** downloads the original data plus `review_status`, `review_notes`, and `reviewed_at`. Reimport this CSV to continue elsewhere. The statuses are `pending`, `accepted`, `rejected`, and `inconclusive`. A `review_csv_encoding` marker enables reversible protection against spreadsheet formulas; canonical asset columns preserve custom mappings when necessary.

Excel parsing uses a pinned local copy of SheetJS Community Edition. See [vendor/README.md](vendor/README.md) and its included license.
