/** Browser-safe spreadsheet and review helpers. No network or storage side effects. */
const LEGACY_REVIEW_KEYS = new Set(['review_status', 'review_notes', 'reviewed_at', 'review_csv_encoding', 'review_asset_path', 'review_asset_id', 'review_asset_title']);
const REVIEW_KEYS = new Set([...LEGACY_REVIEW_KEYS, 'review_source_url']);
const LEGACY_ASSET_KEYS = ['review_asset_path', 'asset_path', 'screenshot_path', 'github_path', 'filepath', 'file_path', 'screenshot', 'screenshot_url', 'asset_url', 'image_path', 'image_url', 'asset'];
const EVIDENCE_METADATA = new Set([...LEGACY_ASSET_KEYS, 'full_page_screenshot_path', 'source_pdf_page', 'source_anchor_text']);
const ID_KEYS = ['review_asset_id', 'id', 'asset_id', 'record_id'];
const TITLE_KEYS = ['review_asset_title', 'title', 'name', 'facility_name', 'hospital_name', 'document_title', 'facility'];
export const SOURCE_KEYS = ['review_source_url', 'source_url', 'original_source_url', 'evidence_source_url', 'page_url', 'url', 'source', 'candidate_source_url'];
const STATUSES = new Set(['pending', 'accepted', 'rejected', 'inconclusive']);
const keyOf = value => String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
const stringOf = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const cellOf = (row, column) => column != null && Object.hasOwn(row, column) ? row[column] : '';
const needsCsvEscape = text => /^[\s\u0000-\u001f]*[=+\-@]/.test(text) || /^[\t\r\n']/.test(text);
const unescapeCsv = text => text.startsWith("'") && needsCsvEscape(text.slice(1)) ? text.slice(1) : text;

function detectDelimiter(text) {
  let quoted = false, commas = 0, tabs = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') i++;
      else quoted = !quoted;
    } else if (!quoted) {
      if (char === '\n' || char === '\r') break;
      if (char === ',') commas++;
      if (char === '\t') tabs++;
    }
  }
  return tabs > commas ? '\t' : ',';
}

/** Parse CSV/TSV, including escaped quotes, quoted newlines and UTF-8 BOM. */
export function parseDelimited(input, delimiter) {
  if (typeof input !== 'string') throw new Error('The spreadsheet must contain text.');
  const text = input.replace(/^\uFEFF/, '');
  if (!text.trim()) throw new Error('The spreadsheet is empty.');
  delimiter ??= detectDelimiter(text);
  if (![',', '\t', ';'].includes(delimiter)) throw new Error('Use a comma, tab or semicolon delimiter.');
  const table = [];
  let row = [], field = '', quoted = false, closedQuote = false;
  const pushField = () => { row.push(field); field = ''; closedQuote = false; };
  const pushRow = () => {
    pushField();
    if (row.some(value => value.trim() !== '')) table.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { quoted = false; closedQuote = true; }
      } else field += char;
      continue;
    }
    if (char === delimiter) { pushField(); continue; }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      pushRow();
      continue;
    }
    if (closedQuote) {
      if (char === ' ') continue;
      throw new Error('Unexpected text after a closing quote in the spreadsheet.');
    }
    if (char === '"') {
      if (field !== '') throw new Error('A quote inside an unquoted cell must be escaped.');
      quoted = true;
    } else field += char;
  }
  if (quoted) throw new Error('The spreadsheet contains an unclosed quoted cell.');
  if (field !== '' || row.length || closedQuote) pushRow();
  if (!table.length) throw new Error('The spreadsheet is empty.');
  let headers = table.shift().map(value => value.trim());
  if (headers.some(value => !value)) throw new Error('Every spreadsheet column needs a header.');
  if (new Set(headers.map(keyOf)).size !== headers.length) throw new Error('Spreadsheet column headers must be unique.');
  if (!table.length) throw new Error('The spreadsheet has headers but no assets.');
  let rows = table.map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Row ${index + 2} has ${values.length} cells; expected ${headers.length}.`);
    return Object.fromEntries(headers.map((header, column) => [header, values[column]]));
  });
  // Only our explicitly marked export format is decoded. Ordinary CSV values
  // beginning with an apostrophe remain untouched.
  if (rows.every(row => cellOf(row, 'review_csv_encoding') === 'apostrophe-v1')) {
    const originalHeaders = headers;
    headers = headers.filter(header => header !== 'review_csv_encoding').map(unescapeCsv);
    if (new Set(headers.map(keyOf)).size !== headers.length) throw new Error('Spreadsheet column headers must be unique.');
    rows = rows.map(row => Object.fromEntries(originalHeaders.filter(header => header !== 'review_csv_encoding').map(header => [unescapeCsv(header), unescapeCsv(cellOf(row, header))])));
  }
  return { headers, rows };
}

function findColumn(headers, requested, aliases) {
  if (requested === null || requested === '') return undefined;
  if (requested !== undefined) {
    const found = headers.find(header => header === requested || keyOf(header) === keyOf(requested));
    if (!found) throw new Error(`Column “${requested}” was not found.`);
    return found;
  }
  for (const alias of aliases) {
    const found = headers.find(header => keyOf(header) === alias);
    if (found) return found;
  }
}

/** Convert arbitrary claim columns into one consistent review record per row.
 * Omitted/undefined mappings auto-detect; null or '' disables ID/title mapping.
 */
export function normalizeRows(rows, options = {}) {
  if (!Array.isArray(rows) || !rows.length) throw new Error('The spreadsheet contains no assets.');
  if (rows.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Every spreadsheet row must be an object with column headers.');
  const headers = [...new Set(rows.flatMap(row => Object.keys(row)))];
  if (new Set(headers.map(keyOf)).size !== headers.length) throw new Error('Spreadsheet column headers must be unique.');
  const sourceColumn = findColumn(headers, options.sourceColumn, SOURCE_KEYS);
  if (!sourceColumn) throw new Error('Choose the original source link column, such as source_url.');
  const idColumn = findColumn(headers, options.idColumn, ID_KEYS);
  const titleColumn = findColumn(headers, options.titleColumn, TITLE_KEYS);
  const pdfPageColumn = findColumn(headers, undefined, ['source_pdf_page']);
  const anchorColumn = findColumn(headers, undefined, ['source_anchor_text']);
  const statusColumn = findColumn(headers, undefined, ['review_status']);
  const notesColumn = findColumn(headers, undefined, ['review_notes']);
  const reviewedAtColumn = findColumn(headers, undefined, ['reviewed_at']);
  const ids = new Set();
  return rows.map((row, index) => {
    const original = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, stringOf(value)]));
    const sourceUrl = sourceDestination(cellOf(row, sourceColumn), cellOf(row, pdfPageColumn), cellOf(row, anchorColumn));
    if (!sourceUrl) throw new Error(`Row ${index + 2} needs an original HTTP or HTTPS source link without embedded credentials.`);
    const id = (idColumn && stringOf(cellOf(row, idColumn)).trim()) || `asset-${index + 1}`;
    if (ids.has(id)) throw new Error(`Duplicate asset ID “${id}” in row ${index + 2}. Give each row a unique ID.`);
    ids.add(id);
    const title = (titleColumn && stringOf(cellOf(row, titleColumn)).trim()) || id;
    const rawStatus = stringOf(cellOf(row, statusColumn)).trim().toLowerCase();
    if (rawStatus && !STATUSES.has(rawStatus)) throw new Error(`Row ${index + 2} has an unknown review_status: “${rawStatus}”.`);
    const excluded = new Set([idColumn, sourceColumn, statusColumn, notesColumn, reviewedAtColumn]);
    const fields = Object.entries(original).filter(([key]) => !excluded.has(key) && !REVIEW_KEYS.has(keyOf(key)) && !EVIDENCE_METADATA.has(keyOf(key))).map(([name, value]) => ({ name, value }));
    return {
      id, title, sourceUrl,
      fields, original, rowNumber: index + 2,
      status: rawStatus || 'pending',
      notes: stringOf(cellOf(row, notesColumn)),
      reviewedAt: stringOf(cellOf(row, reviewedAtColumn)),
    };
  });
}

/** Return a safe HTTP(S) link, or an empty string for unsafe/malformed links. */
export function safeSourceUrl(value) {
  const text = stringOf(value).trim();
  if (!/^https?:\/\//i.test(text) || /[\\\u0000-\u001f\u007f]/.test(text)) return '';
  try {
    const url = new URL(text);
    if (url.username || url.password) return '';
    return url.href;
  } catch { return ''; }
}

/** Add an optional PDF page or text fragment to a link that has no fragment. */
export function sourceDestination(value, pdfPage, anchorText) {
  const safe = safeSourceUrl(value);
  if (!safe) return '';
  const url = new URL(safe);
  if (url.hash) return safe;
  const page = stringOf(pdfPage).trim();
  const text = stringOf(anchorText).trim().replace(/\s+/g, ' ').toWellFormed();
  if (/^[1-9]\d*$/.test(page)) url.hash = `page=${page}`;
  else if (text && !/\.pdf$/i.test(url.pathname)) url.hash = `:~:text=${encodeURIComponent(text).replaceAll('-', '%2D')}`;
  return url.href;
}

function csvCell(value) {
  let text = stringOf(value);
  // Prevent imported claims or notes from becoming formulas when opened in Excel.
  if (needsCsvEscape(text)) text = "'" + text;
  return /[",\r\n]/.test(text) ? '"' + text.replaceAll('"', '""') + '"' : text;
}

/** Export original claims and all decisions, including pending assets. */
export function toCsv(records) {
  if (!Array.isArray(records) || !records.length) throw new Error('There are no assets to export.');
  const headers = [...new Set(records.flatMap(record => Object.keys(record.original || {})))].filter(header => !REVIEW_KEYS.has(keyOf(header)));
  const canonicalColumns = [];
  // Preserve explicit column mappings in an exported review even when an input
  // uses custom headers or the reviewer disabled an apparent ID/title column.
  for (const [aliases, property, reviewColumn, convert] of [
    [ID_KEYS, 'id', 'review_asset_id', value => stringOf(value).trim()],
    [TITLE_KEYS, 'title', 'review_asset_title', value => stringOf(value).trim()],
    [SOURCE_KEYS, 'sourceUrl', 'review_source_url', safeSourceUrl],
  ]) {
    const detected = findColumn(headers, undefined, aliases);
    // A restored review without an original URL can still be exported with its decisions.
    if (records.some(record => convert(cellOf(record.original || {}, detected)) !== stringOf(record[property]))) {
      headers.push(reviewColumn);
      canonicalColumns.push([reviewColumn, property]);
    }
  }
  headers.push('review_status', 'review_notes', 'reviewed_at', 'review_csv_encoding');
  const lines = [headers.map(csvCell).join(',')];
  for (const record of records) {
    const row = { ...record.original };
    for (const [column, property] of canonicalColumns) row[column] = record[property];
    row.review_status = STATUSES.has(record.status) ? record.status : 'pending';
    row.review_notes = record.notes || '';
    row.reviewed_at = record.reviewedAt || '';
    row.review_csv_encoding = 'apostrophe-v1';
    lines.push(headers.map(header => csvCell(cellOf(row, header))).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

/** Pages are one-based. Empty results display page 1 of 1 with no items. */
export function paginate(items, page = 1, pageSize = 10) {
  if (!Array.isArray(items)) throw new Error('Pagination requires an array of assets.');
  const size = [1, 10, 50].includes(Number(pageSize)) ? Number(pageSize) : 10;
  const totalPages = Math.max(1, Math.ceil(items.length / size));
  const requested = Number.isFinite(Number(page)) ? Math.trunc(Number(page)) : 1;
  const current = Math.min(totalPages, Math.max(1, requested));
  return { items: items.slice((current - 1) * size, current * size), page: current, totalPages, total: items.length };
}

/** Content-sensitive identity excludes mutable review metadata. */
export function datasetKey(records) {
  return hashDataset(records.map(record => ({
    id: record.id,
    title: record.title,
    sourceUrl: record.sourceUrl,
    original: sortedOriginal(record, key => !REVIEW_KEYS.has(key) && !EVIDENCE_METADATA.has(key)),
  })), 'v2');
}

/** Recognize old saved drafts when a spreadsheet still carries the original asset path. */
export function legacyDatasetKey(records) {
  const headers = [...new Set(records.flatMap(record => Object.keys(record.original || {})))];
  const pathColumn = findColumn(headers, undefined, LEGACY_ASSET_KEYS);
  const content = records.map(record => ({
    id: record.id,
    assetPath: record.assetPath || stringOf(cellOf(record.original || {}, pathColumn)).trim(),
    title: record.title,
    original: sortedOriginal(record, key => !LEGACY_REVIEW_KEYS.has(key)),
  }));
  return content.every(record => record.assetPath) ? hashDataset(content, 'v1') : '';
}

function sortedOriginal(record, include) {
  return Object.entries(record.original || {}).filter(([key]) => include(keyOf(key))).sort(([a], [b]) => a.localeCompare(b));
}

function hashDataset(records, version) {
  const content = JSON.stringify(records.sort((a, b) => a.id.localeCompare(b.id)));
  let first = 2166136261, second = 5381;
  for (let i = 0; i < content.length; i++) {
    first = Math.imul(first ^ content.charCodeAt(i), 16777619);
    second = Math.imul(second, 33) ^ content.charCodeAt(i);
  }
  return `in-the-loop:${version}:${records.length}:${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}
