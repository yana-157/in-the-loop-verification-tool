import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimited, normalizeRows, resolveAssetUrl, safeSourceUrl, toCsv, paginate, datasetKey } from '../lib/data.js';

const rows = [
  { id: 'a', title: 'River Clinic', asset_path: 'screenshots/river clinic.png', beds: '40', source_url: 'https://example.org/river' },
  { id: 'b', title: 'Hill Clinic', asset_path: 'screenshots/hill.png', beds: '22', source_url: 'https://example.org/hill' },
  { id: 'c', title: 'Valley Clinic', asset_path: 'screenshots/valley.png', beds: '15', source_url: 'https://example.org/valley' },
  { id: 'd', title: 'Lake Clinic', asset_path: 'screenshots/lake.png', beds: '18', source_url: 'https://example.org/lake' },
];

test('CSV supports BOM, commas, escaped quotes, CRLF, and embedded line breaks', () => {
  const { headers, rows } = parseDelimited('\uFEFFid,asset_path,claim\r\n1,a.png,"Name, \"\"West\"\"\n40 beds"\r\n');
  assert.deepEqual(headers, ['id', 'asset_path', 'claim']);
  assert.equal(rows[0].claim, 'Name, "West"\n40 beds');
});

test('TSV is detected without counting separators inside quotes', () => {
  const { rows } = parseDelimited('id\tasset_path\tclaim\n1\ta.png\t"a,b,c"\n');
  assert.equal(rows[0].claim, 'a,b,c');
});

test('malformed, empty, header-only and ambiguous spreadsheets report errors', () => {
  for (const input of ['', 'id,asset_path\n', 'id,id\n1,2', 'id,\n1,2', 'id,asset_path\n1', 'id,asset_path\n1,"never closed', 'id,asset_path\n1,"closed"junk', 'id,asset_path\n1,un"quoted']) {
    assert.throws(() => parseDelimited(input));
  }
  assert.throws(() => parseDelimited('id|asset_path\n1|x.png', '|'));
});

test('normalization preserves arbitrary claims, source metadata and spreadsheet row numbers', () => {
  const records = normalizeRows(rows);
  assert.equal(records[0].rowNumber, 2);
  assert.equal(records[0].status, 'pending');
  assert.equal(records[0].sourceUrl, 'https://example.org/river');
  assert.deepEqual(records[0].fields, [{ name: 'title', value: 'River Clinic' }, { name: 'beds', value: '40' }]);
  assert.deepEqual(records[0].original, rows[0]);
  assert.equal(normalizeRows([{ Screenshot: 'a.png', 'Facility Name': 'A', Beds: 0 }])[0].title, 'A');
});

test('normalization supports explicit column mapping and rejects missing assets, duplicate IDs, unknown statuses', () => {
  assert.equal(normalizeRows([{ evidence: 'a.png', key: 'x', heading: 'A' }], { assetColumn: 'evidence', idColumn: 'key', titleColumn: 'heading' })[0].id, 'x');
  assert.throws(() => normalizeRows([]));
  assert.throws(() => normalizeRows([{ title: 'No asset' }]));
  assert.throws(() => normalizeRows([{ asset_path: '' }]));
  assert.throws(() => normalizeRows([rows[0], rows[0]]), /Duplicate/);
  assert.throws(() => normalizeRows([{ ...rows[0], review_status: 'maybe' }]), /unknown/);
});

test('GitHub blob/raw and repo-relative filenames resolve safely, including spaces and literal hash', () => {
  assert.equal(resolveAssetUrl('screenshots/a #1.png'), 'https://raw.githubusercontent.com/yana-157/in-the-loop-verification-tool/main/screenshots/a%20%231.png');
  assert.equal(resolveAssetUrl('https://github.com/me/repo/blob/main/folder/a%20b.png?raw=1'), 'https://raw.githubusercontent.com/me/repo/main/folder/a%20b.png');
  assert.equal(resolveAssetUrl('https://raw.githubusercontent.com/me/repo/main/a.png'), 'https://raw.githubusercontent.com/me/repo/main/a.png');
  assert.equal(resolveAssetUrl('./assets/a.png', { baseUrl: 'https://me.github.io/project/' }), 'https://me.github.io/project/assets/a.png');
  assert.equal(resolveAssetUrl('assets/a.png', { repository: 'me/repo', ref: 'feature/evidence' }), 'https://raw.githubusercontent.com/me/repo/feature%2Fevidence/assets/a.png');
});

test('unsafe asset and source URLs are rejected', () => {
  for (const path of ['javascript:alert(1)', 'data:image/svg+xml,abc', 'file:///tmp/a.png', '//example.org/a.png', '../a.png', '%2e%2e/a.png', 'C:\\assets\\a.png', 'https://user:secret@example.org/a.png']) assert.throws(() => resolveAssetUrl(path));
  assert.equal(safeSourceUrl('javascript:alert(1)'), '');
  assert.equal(safeSourceUrl('https://user:secret@example.org/'), '');
  assert.equal(safeSourceUrl('https://example.org/a'), 'https://example.org/a');
});

test('review CSV round-trips all original claims, notes and all four decision states', () => {
  const records = normalizeRows(rows);
  for (const [index, status] of ['accepted', 'rejected', 'inconclusive', 'pending'].entries()) {
    records[index].status = status;
    records[index].notes = 'Reviewer said "check", please\nNext line';
    records[index].reviewedAt = status === 'pending' ? '' : '2026-11-22T00:00:00Z';
  }
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  for (let index = 0; index < records.length; index++) {
    assert.equal(restored[index].status, records[index].status);
    assert.equal(restored[index].notes, records[index].notes);
    assert.equal(restored[index].reviewedAt, records[index].reviewedAt);
    assert.equal(restored[index].original.beds, rows[index].beds);
    assert.equal(restored[index].assetPath, records[index].assetPath);
  }
  assert.equal(toCsv(restored).match(/review_status/g).length, 1);
});

test('CSV export neutralizes formula injection in original claims, notes and headers', () => {
  const records = normalizeRows([{ ...rows[0], '=HEADER()': '=HYPERLINK("https://example.org")', claim: '  +SUM(1)' }]);
  records[0].notes = '@SUM(1)';
  const csv = toCsv(records);
  // An ordinary spreadsheet sees safe apostrophe-prefixed cells. Our marked
  // parser restores the exact original values for continued review.
  const parsed = parseDelimited(csv.replace('review_csv_encoding', 'external_marker'));
  assert.ok(parsed.headers.includes("'=HEADER()"));
  assert.equal(parsed.rows[0].claim, "'  +SUM(1)");
  assert.equal(parsed.rows[0].review_notes, "'@SUM(1)");
  const restored = normalizeRows(parseDelimited(csv).rows);
  assert.equal(restored[0].original['=HEADER()'], records[0].original['=HEADER()']);
  assert.equal(restored[0].original.claim, '  +SUM(1)');
  assert.equal(restored[0].notes, '@SUM(1)');
});

test('explicit null/empty ID and title mapping disables auto-detection and survives export', () => {
  const input = [
    { id: 'duplicate', title: 'Source title', asset_path: 'a.png' },
    { id: 'duplicate', title: 'Source title', asset_path: 'b.png' },
  ];
  assert.throws(() => normalizeRows(input), /Duplicate/);
  for (const disabled of [null, '']) {
    const records = normalizeRows(input, { idColumn: disabled, titleColumn: disabled });
    assert.deepEqual(records.map(record => [record.id, record.title]), [['asset-1', 'asset-1'], ['asset-2', 'asset-2']]);
    const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
    assert.deepEqual(restored.map(record => [record.id, record.title]), records.map(record => [record.id, record.title]));
    assert.equal(restored[0].original.id, 'duplicate');
    assert.ok(!restored[0].fields.some(field => field.name.startsWith('review_')));
  }
});

test('custom screenshot/id/title mappings reimport without supplying the mapping again', () => {
  const records = normalizeRows([{ evidence: 'screenshots/custom.png', code: 'ABC', label: 'Custom asset', beds: '4' }], { assetColumn: 'evidence', idColumn: 'code', titleColumn: 'label' });
  records[0].status = 'accepted';
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  assert.equal(restored[0].assetPath, records[0].assetPath);
  assert.equal(restored[0].id, 'ABC');
  assert.equal(restored[0].title, 'Custom asset');
  assert.equal(restored[0].status, 'accepted');
  assert.equal(restored[0].original.evidence, 'screenshots/custom.png');
});

test('explicit mappings overriding recognized aliases preserve both original and chosen values', () => {
  const records = normalizeRows([{ id: 'source-id', asset_path: 'old.png', title: 'Old title', evidence: 'correct.png', code: 'chosen', heading: 'Chosen title' }], { assetColumn: 'evidence', idColumn: 'code', titleColumn: 'heading' });
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  assert.equal(restored[0].assetPath, 'correct.png');
  assert.equal(restored[0].id, 'chosen');
  assert.equal(restored[0].title, 'Chosen title');
  assert.equal(restored[0].original.asset_path, 'old.png');
});

test('formula-safe CSV round-trips @ filenames and existing apostrophes without changing data', () => {
  const input = [{ id: '@record', title: "'=literal", asset_path: '@evidence.png', claim: "''two apostrophes", other: '\tWhitespace', '=header': '=VALUE()' }];
  const records = normalizeRows(input);
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  assert.deepEqual(restored[0].original, { ...records[0].original, review_status: 'pending', review_notes: '', reviewed_at: '' });
  assert.equal(resolveAssetUrl(restored[0].assetPath), 'https://raw.githubusercontent.com/yana-157/in-the-loop-verification-tool/main/%40evidence.png');
  assert.equal(datasetKey(restored), datasetKey(records));
  assert.equal(parseDelimited("id,asset_path,claim\n1,a.png,'=literal").rows[0].claim, "'=literal");
});

test('prototype-like headers and missing cells never read inherited object properties', () => {
  const parsed = parseDelimited('id,asset_path,__proto__,constructor,undefined\na,a.png,ordinary,also ordinary,pending-looking claim\n');
  const records = normalizeRows(parsed.rows);
  assert.equal(records[0].status, 'pending');
  assert.equal(records[0].original.__proto__, 'ordinary');
  assert.equal(records[0].original.constructor, 'also ordinary');
  assert.equal(Object.getPrototypeOf(parsed.rows[0]), Object.prototype);
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  assert.equal(restored[0].original.__proto__, 'ordinary');
  const heterogeneous = normalizeRows([parsed.rows[0], { id: 'b', asset_path: 'b.png' }]);
  const exportedRows = parseDelimited(toCsv(heterogeneous)).rows;
  assert.equal(exportedRows[1].__proto__, '');
  assert.equal(exportedRows[1].constructor, '');
  assert.equal({}.polluted, undefined);
});

test('GitHub branch slashes and pre-encoded filenames remain correctly encoded', () => {
  assert.equal(resolveAssetUrl('folder/a%20b.png', { repository: 'owner/repo', ref: 'feature/screenshots' }), 'https://raw.githubusercontent.com/owner/repo/feature%2Fscreenshots/folder/a%20b.png');
  assert.equal(resolveAssetUrl('https://github.com/owner/repo/blob/feature%2Fscreenshots/folder/a%20b.png'), 'https://raw.githubusercontent.com/owner/repo/feature%2Fscreenshots/folder/a%20b.png');
  assert.throws(() => resolveAssetUrl('a.png', { baseUrl: 'javascript:alert(1)' }));
  assert.throws(() => resolveAssetUrl('a.png', { repository: 'owner/repo/other' }));
});

test('pagination handles 1/10/50 sizes, arbitrary page jumps, and shrinking filtered lists', () => {
  const items = Array.from({ length: 64 }, (_, i) => i);
  assert.deepEqual(paginate(items, 2, 50), { items: items.slice(50), page: 2, totalPages: 2, total: 64 });
  assert.equal(paginate(items, 8, 10).page, 7);
  assert.deepEqual(paginate(items, 42, 1).items, [41]);
  assert.equal(paginate(items.slice(0, 3), 7, 10).page, 1);
  assert.deepEqual(paginate([], 3, 50), { items: [], page: 1, totalPages: 1, total: 0 });
});

test('dataset keys ignore review edits and ordering, but distinguish changed scraped claims', () => {
  const records = normalizeRows(rows);
  const initial = datasetKey(records);
  records[0].status = 'accepted';
  records[0].notes = 'Matches';
  assert.equal(datasetKey(records), initial);
  assert.equal(datasetKey([...records].reverse()), initial);
  assert.equal(datasetKey(normalizeRows(parseDelimited(toCsv(records)).rows)), initial);
  records[0].original.beds = '400';
  assert.notEqual(datasetKey(records), initial);
});
