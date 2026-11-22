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

Use the **Inconclusive** queue to set aside rows for a later visit. Open the source again when you have enough information and change the rating to correct or incorrect. **Export inconclusive rows** saves that queue as a CSV with source links, claims, and review notes. Reimport it to review those rows on their own, or reopen the original frozen audit to update its result.

The browser saves review state locally. **Export reviews** downloads a CSV with the data, review decisions, notes, and timestamps. You can reimport it elsewhere. A review included in an import takes precedence over the local draft. Export a copy before clearing browser data.

## Verify a random sample

1. Open **Random-sample verification** and choose **Calculate sample**. The built-in example uses all five rows. You can also import a larger spreadsheet with an original source URL for every row.
2. Choose **Freeze random sample**. The app selects rows without replacement and keeps the selection in your browser. Sample ratings start blank and stay separate from your regular reviews.
3. Follow each sampled row’s source link and check the claim in context. Mark it correct when the source supports what the row recorded, including its scope. Use Inconclusive to set aside a row when the page is unavailable or the wording is unclear.
4. If any sampled rows are inconclusive, the audit holds the confidence interval and threshold result. Use **Revisit inconclusive rows** to check those rows again, or choose **Mark all as wrong** to count the inconclusive rows as wrong in the calculation. Those rows remain available for later review. Undoing the choice holds the results again while any inconclusive rows remain.
5. Once you have reviewed every sampled row and resolved or explicitly counted the inconclusive rows as wrong, the audit shows the **95% confidence interval** and a verdict against the accuracy target. For a review of the entire sheet, it shows the accuracy directly.

To try a smaller sample using the five example links, set the accuracy target to **50%** and leave the other settings at their defaults before calculating. The app will draw three rows.

With the defaults, a sheet of 161 rows calls for checking 39. At least 38 must be confirmed correct to support accuracy above 90%. The test limits the chance of passing a sheet at or below that target to 5%, using 98% as the planning accuracy and 80% as the target chance of passing at that planning accuracy. The confidence interval checks uncertainty in both directions. The threshold test checks only for evidence above the target and can pass even when the interval includes the target.

The audit measures copying accuracy within the imported sheet. Current service availability, conflicting publishers, and records the spreadsheet missed require their own checks. Use **Export audit receipt** to save the plan, selected rows, decisions, any calculation assumption, and result as JSON.

Excel parsing uses a pinned copy of SheetJS Community Edition. See [vendor/README.md](vendor/README.md) and its license.

## Deploy to GitHub Pages

The [Pages workflow](.github/workflows/pages.yml) tests and stages the app when `main` changes. It can also run from the Actions tab. For a new copy of the repository, select **GitHub Actions** under **Settings → Pages → Build and deployment**. The app uses relative URLs and works under a project subpath without a build step or backend.
