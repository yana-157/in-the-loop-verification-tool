# In The Loop Verification Tool

Open an original source page and compare it with the claims collected in a spreadsheet. Mark each record **incorrect**, **inconclusive**, or **correct** and add optional notes.

- [Open the GitHub Pages app](https://yana-157.github.io/in-the-loop-verification-tool/)
- [Public tool repository](https://github.com/yana-157/in-the-loop-verification-tool)

The sample includes five unrated claims from public Faridabad Medical Center and Arti Hospital pages. See [sample provenance](samples/README.md). Imported spreadsheets and review decisions stay in your browser.

## Run locally

With Python 3 installed, run from this directory:

```sh
python3 -m http.server 4173 --bind 127.0.0.1
```

Open <http://127.0.0.1:4173/> or run `npm run dev`. The browser loads the application and sample over HTTP. To run tests with Node 22 or later, use `npm test`.

## Prepare a spreadsheet

Import `.csv`, `.tsv`, or `.xlsx` files up to 20 MB and 25,000 rows. Choose a worksheet for Excel files. Each row needs an original page URL and the information to verify. The import dialog lets you map a custom URL, title, or ID column.

| Column | Purpose |
| --- | --- |
| `id` | Optional stable, unique record identifier. |
| `title` | Optional record title. |
| `source_url` | Required full `http://` or `https://` URL of the source page or PDF. |
| `source_anchor_text` | Optional exact phrase to highlight in browsers that support text fragments. |
| `source_pdf_page` | Optional page number to open in a PDF. |
| Other columns | Claims to compare with the original. |

An existing URL fragment takes precedence over the optional phrase or page number. Use [the CSV template](samples/template.csv) to get started. You can also import older spreadsheets once each row has an original source URL.

## Review and save

Choose **Open original page** to open the source in a new tab. Compare the source with the record and add a note if useful. The sidebar shows pending, accepted, rejected, and inconclusive records. Each list supports search and 1, 10, or 50 records per page.

- **1** marks a record incorrect.
- **2** marks a record inconclusive.
- **3** marks a record correct.

Use the previous and next buttons or the left and right arrows to move between records. You can change or clear a review. **Advance after rating** is optional.

The browser saves review state locally. **Export reviews** downloads a CSV with the data, review decisions, notes, and timestamps. You can reimport it elsewhere. A review included in an import takes precedence over the local draft. Export a copy before clearing browser data.

Excel parsing uses a pinned copy of SheetJS Community Edition. See [vendor/README.md](vendor/README.md) and its license.

## Deploy to GitHub Pages

The [Pages workflow](.github/workflows/pages.yml) tests and stages the app when `main` changes. It can also run from the Actions tab. For a new copy of the repository, select **GitHub Actions** under **Settings → Pages → Build and deployment**. The app uses relative URLs and works under a project subpath without a build step or backend.
