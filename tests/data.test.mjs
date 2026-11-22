import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDelimited, normalizeRows, safeSourceUrl, sourceDestination, toCsv, paginate, datasetKey, legacyDatasetKey } from '../lib/data.js';

const rows = [
  { id: 'a', title: 'River Clinic', beds: '40', source_url: 'https://example.org/river' },
  { id: 'b', title: 'Hill Clinic', beds: '22', source_url: 'https://example.org/hill' },
  { id: 'c', title: 'Valley Clinic', beds: '15', source_url: 'https://example.org/valley' },
  { id: 'd', title: 'Lake Clinic', beds: '18', source_url: 'https://example.org/lake' },
];

test('CSV supports BOM, commas, escaped quotes, CRLF, and embedded line breaks', () => {
  const { headers, rows } = parseDelimited('\uFEFFid,source_url,claim\r\n1,https://example.org/a,"Name, \"\"West\"\"\n40 beds"\r\n');
  assert.deepEqual(headers, ['id', 'source_url', 'claim']);
  assert.equal(rows[0].claim, 'Name, "West"\n40 beds');
});

test('TSV is detected without counting separators inside quotes', () => {
  const { rows } = parseDelimited('id\tsource_url\tclaim\n1\thttps://example.org/a\t"a,b,c"\n');
  assert.equal(rows[0].claim, 'a,b,c');
});

test('malformed, empty, header-only and ambiguous spreadsheets report errors', () => {
  for (const input of ['', 'id,source_url\n', 'id,id\n1,2', 'id,\n1,2', 'id,source_url\n1', 'id,source_url\n1,"never closed', 'id,source_url\n1,"closed"junk', 'id,source_url\n1,un"quoted']) {
    assert.throws(() => parseDelimited(input));
  }
  assert.throws(() => parseDelimited('id|source_url\n1|https://example.org/a', '|'));
});

test('normalization preserves arbitrary claims, source metadata and spreadsheet row numbers', () => {
  const records = normalizeRows(rows);
  assert.equal(records[0].rowNumber, 2);
  assert.equal(records[0].status, 'pending');
  assert.equal(records[0].sourceUrl, 'https://example.org/river');
  assert.deepEqual(records[0].fields, [{ name: 'title', value: 'River Clinic' }, { name: 'beds', value: '40' }]);
  assert.deepEqual(records[0].original, rows[0]);
  assert.equal(normalizeRows([{ 'Evidence Source URL': 'https://example.org/a', 'Facility Name': 'A', Beds: 0 }])[0].title, 'A');
});

test('normalization supports explicit column mapping and rejects missing sources, duplicate IDs, unknown statuses', () => {
  assert.equal(normalizeRows([{ evidence: 'https://example.org/a', key: 'x', heading: 'A' }], { sourceColumn: 'evidence', idColumn: 'key', titleColumn: 'heading' })[0].id, 'x');
  assert.throws(() => normalizeRows([]));
  assert.throws(() => normalizeRows([{ title: 'No source' }]), /original source link column/);
  assert.throws(() => normalizeRows([{ source_url: '' }]), /Row 2.*HTTP or HTTPS/);
  assert.throws(() => normalizeRows([rows[0], rows[0]]), /Duplicate/);
  assert.throws(() => normalizeRows([{ ...rows[0], review_status: 'maybe' }]), /unknown/);
});

test('source links preserve explicit fragments and support PDF pages and text highlights', () => {
  assert.equal(sourceDestination('https://example.org/report.pdf?file=1', 12, 'ignore'), 'https://example.org/report.pdf?file=1#page=12');
  assert.equal(sourceDestination('https://example.org/a#summary', 2, 'ignore'), 'https://example.org/a#summary');
  assert.equal(sourceDestination('https://example.org/a', '', ' 35-bedded\ncapacity, including ICU '), 'https://example.org/a#:~:text=35%2Dbedded%20capacity%2C%20including%20ICU');
  assert.equal(sourceDestination('https://example.org/report.pdf', '', 'skip text'), 'https://example.org/report.pdf');
  const records = normalizeRows([{ ...rows[0], source_anchor_text: '40 beds', source_pdf_page: '' }]);
  assert.equal(records[0].sourceUrl, 'https://example.org/river#:~:text=40%20beds');
  assert.ok(!records[0].fields.some(({ name }) => name.startsWith('source_')));
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  assert.equal(restored[0].sourceUrl, records[0].sourceUrl);
  assert.equal(datasetKey(restored), datasetKey(records));
});

test('unsafe or ambiguous source URLs are rejected', () => {
  for (const source_url of ['javascript:alert(1)', 'data:text/html,abc', 'file:///tmp/a', '//example.org/a', '../a', 'https:example.org/a', 'https://user:secret@example.org/a', 'https://exa\tmple.org/a', 'https://example.org\\a']) {
    assert.equal(safeSourceUrl(source_url), '');
    assert.throws(() => normalizeRows([{ source_url }]), /Row 2.*HTTP or HTTPS/);
  }
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
    assert.equal(restored[index].sourceUrl, records[index].sourceUrl);
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
    { id: 'duplicate', title: 'Source title', source_url: 'https://example.org/a' },
    { id: 'duplicate', title: 'Source title', source_url: 'https://example.org/b' },
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

test('custom source/id/title mappings reimport without supplying the mapping again', () => {
  const records = normalizeRows([{ evidence: 'https://example.org/custom', code: 'ABC', label: 'Custom record', beds: '4' }], { sourceColumn: 'evidence', idColumn: 'code', titleColumn: 'label' });
  records[0].status = 'accepted';
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  assert.equal(restored[0].sourceUrl, records[0].sourceUrl);
  assert.equal(restored[0].id, 'ABC');
  assert.equal(restored[0].title, 'Custom record');
  assert.equal(restored[0].status, 'accepted');
  assert.equal(restored[0].original.evidence, 'https://example.org/custom');
  assert.equal(datasetKey(restored), datasetKey(records));
});

test('explicit mappings overriding recognized aliases preserve both original and chosen values', () => {
  const records = normalizeRows([{ id: 'source-id', source_url: 'https://example.org/old', title: 'Old title', evidence: 'https://example.org/correct', code: 'chosen', heading: 'Chosen title' }], { sourceColumn: 'evidence', idColumn: 'code', titleColumn: 'heading' });
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  assert.equal(restored[0].sourceUrl, 'https://example.org/correct');
  assert.equal(restored[0].id, 'chosen');
  assert.equal(restored[0].title, 'Chosen title');
  assert.equal(restored[0].original.source_url, 'https://example.org/old');
});

test('formula-safe CSV round-trips leading @ and existing apostrophes without changing data', () => {
  const input = [{ id: '@record', title: "'=literal", source_url: 'https://example.org/a', claim: "''two apostrophes", other: '\tWhitespace', '=header': '=VALUE()' }];
  const records = normalizeRows(input);
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  assert.deepEqual(restored[0].original, { ...records[0].original, review_status: 'pending', review_notes: '', reviewed_at: '' });
  assert.equal(datasetKey(restored), datasetKey(records));
  assert.equal(parseDelimited("id,source_url,claim\n1,https://example.org/a,'=literal").rows[0].claim, "'=literal");
});

test('prototype-like headers and missing cells never read inherited object properties', () => {
  const parsed = parseDelimited('id,source_url,__proto__,constructor,undefined\na,https://example.org/a,ordinary,also ordinary,pending-looking claim\n');
  const records = normalizeRows(parsed.rows);
  assert.equal(records[0].status, 'pending');
  assert.equal(records[0].original.__proto__, 'ordinary');
  assert.equal(records[0].original.constructor, 'also ordinary');
  assert.equal(Object.getPrototypeOf(parsed.rows[0]), Object.prototype);
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  assert.equal(restored[0].original.__proto__, 'ordinary');
  const heterogeneous = normalizeRows([parsed.rows[0], { id: 'b', source_url: 'https://example.org/b' }]);
  const exportedRows = parseDelimited(toCsv(heterogeneous)).rows;
  assert.equal(exportedRows[1].__proto__, '');
  assert.equal(exportedRows[1].constructor, '');
  assert.equal({}.polluted, undefined);
});

test('legacy drafts remain identifiable and legacy asset columns are preserved without being shown', () => {
  const old = { id: 'x', title: 'Legacy', screenshot_path: 'assets/a.jpg', source_url: 'https://example.org/a', beds: '21' };
  const records = normalizeRows([old]);
  assert.equal(records[0].assetPath, undefined);
  assert.ok(!records[0].fields.some(({ name }) => name === 'screenshot_path'));
  assert.equal(legacyDatasetKey(records), 'in-the-loop:v1:1:67242e06c18006a6');
  assert.equal(legacyDatasetKey(normalizeRows(rows)), '');
  assert.equal(legacyDatasetKey(normalizeRows([{ ...old, other: 'https://example.org/b' }], { sourceColumn: 'other' })), '');
  const restored = normalizeRows(parseDelimited(toCsv(records)).rows);
  assert.equal(restored[0].original.screenshot_path, old.screenshot_path);
  assert.equal(legacyDatasetKey(restored), legacyDatasetKey(records));
  assert.equal(datasetKey(records), datasetKey(normalizeRows([{ id: 'x', title: 'Legacy', source_url: 'https://example.org/a', beds: '21' }])));
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
  records[0].sourceUrl = 'https://example.org/different';
  assert.notEqual(datasetKey(records), initial);
  records[0].sourceUrl = 'https://example.org/river';
  records[0].original.beds = '400';
  assert.notEqual(datasetKey(records), initial);
});
