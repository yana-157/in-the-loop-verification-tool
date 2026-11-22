# Evidence sample

These five records pair existing repository evidence with its captured screenshot. Every record begins without a rating; this sample does not import earlier review decisions.

The JPEGs are unchanged copies of the tracked files under `data/recovery/verification/`. They were captured through live Chrome on November 21, 2026. They are evidence crops, not full-page screenshots, and total approximately 46 KB. See [`data/recovery/SAMPLING.md`](../../data/recovery/SAMPLING.md) for the original capture context and [`public_documents_2026-11-21.json`](../../data/recovery/public_documents_2026-11-21.json) for the frozen text passages.

| Record | Original screenshot | Claim source |
| --- | --- | --- |
| FMC-001 | `faridabad-capacity.jpg` | Frozen Faridabad capacity passage |
| FMC-002 | `faridabad-address.jpg` | Captured homepage footer address; line breaks normalized to spaces |
| ARTI-001 | `arti-budge-address.jpg` | Frozen Budge Budge branch-address passage |
| ARTI-002 | `arti-dialysis-listing.jpg` | Frozen common-footer dialysis mention |
| ARTI-003 | `arti-group-capacity.jpg` | Frozen corporate About-page bed statement |

`publication_context` explains the available source context. For the Arti records, the shared footer and group About page do not establish branch-specific capacity or service availability. Review the exact claim and its scope before assigning a rating.

The bundled `screenshot_path` values are relative to the app root (`./samples/assets/...`) so the sample works on GitHub Pages without depending on external image requests. To use the original repository files in another spreadsheet, use paths such as `data/recovery/verification/faridabad-capacity.jpg` with repository `augustchu/datathon-F26` and ref `main`.
