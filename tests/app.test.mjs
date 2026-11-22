import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as data from '../lib/data.js';
import * as audit from '../lib/audit.js';

// A small DOM adapter exercises the app's actual event handlers without a browser
// dependency. Layout and XLSX uploads can also be exercised in a real browser.
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/gm, '')
  .replaceAll('import.meta.url', "'http://localhost:4173/app.js'");
const storageKey = 'in-the-loop:active:v1';

class Element {
  constructor() {
    this.events = new Map();
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.options = [];
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = '';
    this.innerHTML = '';
    this.classList = { add() {}, remove() {} };
  }
  addEventListener(type, handler) { this.events.set(type, handler); }
  dispatch(type, event = {}) { return this.events.get(type)?.({ target: this, preventDefault() {}, ...event }); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  replaceChildren(...children) { this.options = children; }
  add(option) { this.options.push(option); }
  focus() {}
  scrollTo() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function fixture(count = 64) {
  return data.normalizeRows(Array.from({ length: count }, (_, index) => ({
    id: `asset-${index + 1}`,
    title: `Asset ${index + 1}`,
    source_url: `https://example.com/source/${index + 1}`,
    claim: `Claim ${index + 1}`,
  })));
}

async function harness(records = fixture(), savedStorage) {
  const elements = new Map();
  const get = selector => {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  };
  const ratings = ['rejected', 'inconclusive', 'accepted'].map(status => {
    const button = new Element(); button.dataset.rate = status; return button;
  });
  for (const [input, value] of Object.entries({ floor: '90', target: '98', alpha: '5', power: '80' })) {
    get(`#audit-${input}`).value = value;
  }
  const storage = savedStorage || new Map([[storageKey, JSON.stringify({
    records, selectedId: records[0].id, expanded: 'pending',
    name: 'Test spreadsheet', isSample: false,
  })]]);
  const objectUrls = new Map();
  const downloads = [];
  class TestURL extends URL {
    static createObjectURL(blob) {
      const url = `blob:test-${objectUrls.size + 1}`;
      objectUrls.set(url, blob);
      return url;
    }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    ...data, ...audit,
    document: {
      querySelector: selector => selector === 'dialog[open]' ? null : get(selector),
      querySelectorAll: selector => selector === '[data-rate]' ? ratings : [],
      getElementById: id => get(`#${id}`),
      addEventListener() {},
      body: { append() {} },
      createElement: () => ({
        click() { downloads.push({ name: this.download, blob: objectUrls.get(this.href) }); },
        remove() {},
      }),
    },
    fetch: async () => ({
      ok: true,
      text: async () => readFileSync(new URL('../samples/evidence.csv', import.meta.url), 'utf8'),
    }),
    location: { href: 'http://localhost:4173/' },
    URL: TestURL,
    Blob,
    Option: class { constructor(label, value) { this.label = label; this.value = value; } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
    },
    // Toast timers are irrelevant to these checks and must not keep Node alive.
    setTimeout: () => 0, clearTimeout() {}, console,
  });
  await vm.runInContext(`(async () => {\n${appSource}\n})()`, context);
  return {
    get, storage, downloads,
    state: () => JSON.parse(storage.get(storageKey)),
    audit: () => JSON.parse(storage.get(`${JSON.parse(storage.get(storageKey)).key}:accuracy-audit:v1`)),
    clickQueue: dataset => get('#navigators').dispatch('click', { target: { closest: () => ({ dataset }) } }),
    rate: status => ratings.find(button => button.dataset.rate === status).dispatch('click'),
  };
}

test('queue controls support arbitrary pages and selections with only one queue expanded', async () => {
  const app = await harness();
  app.clickQueue({ size: '1', status: 'pending' });
  app.clickQueue({ pageChange: '1', status: 'pending' });
  assert.deepEqual(app.state().queues.pending, { page: 2, size: 1 });
  app.clickQueue({ size: '10', status: 'pending' });
  app.get('#navigators').dispatch('change', { target: { dataset: { pageSelect: 'pending' }, value: '6' } });
  assert.match(app.get('#navigators').innerHTML, /data-record="asset-60"/);
  app.clickQueue({ record: 'asset-60' });
  assert.equal(app.get('#asset-id').textContent, 'asset-60');
  app.rate('accepted');
  assert.equal(app.get('#reviewed-count').textContent, 1);
  assert.equal(app.get('#remaining-count').textContent, 63);
  app.clickQueue({ size: '50', status: 'pending' });
  app.clickQueue({ pageChange: '1', status: 'pending' });
  assert.equal(app.state().queues.pending.page, 2);
  assert.match(app.get('#navigators').innerHTML, /data-record="asset-64"/);
  app.clickQueue({ queue: 'accepted' });
  assert.equal((app.get('#navigators').innerHTML.match(/aria-expanded="true"/g) || []).length, 1);
  assert.equal(app.get('#asset-id').textContent, 'asset-60');
  app.clickQueue({ queue: 'rejected' });
  assert.equal((app.get('#navigators').innerHTML.match(/aria-expanded="true"/g) || []).length, 1);
  assert.equal(app.get('#empty-state').hidden, false);
});

test('a frozen random sample keeps its links and reviews through reloads separately from ordinary reviews', async () => {
  const app = await harness(fixture(161));
  app.clickQueue({ record: 'asset-17' });
  app.rate('accepted');
  app.get('#audit-form').dispatch('submit');
  assert.match(app.get('#audit-preview').textContent, /39 of 161 rows.*38 rows must be confirmed correct/);
  app.get('#audit-start').dispatch('click');
  const firstDraw = app.audit();
  assert.equal(firstDraw.reviews.length, 39);
  assert.ok(firstDraw.reviews.every(review => review.status === 'pending'));
  const [first] = firstDraw.reviews;
  assert.equal(app.get('#asset-id').textContent, first.id);
  assert.equal(app.get('#source-link').attributes.href, `https://example.com/source/${first.id.slice(6)}`);
  app.rate('inconclusive');
  app.get('#review-notes').value = 'The source no longer shows the claim.';
  app.get('#review-notes').dispatch('input');

  const restored = await harness(undefined, app.storage);
  assert.equal(restored.state().inAudit, true);
  assert.deepEqual(restored.audit().reviews.map(review => review.id), firstDraw.reviews.map(review => review.id));
  assert.equal(restored.get('#review-notes').value, 'The source no longer shows the claim.');
  assert.match(restored.get('#audit-result').textContent, /38 rows left to review/);
  restored.get('#audit-toggle').dispatch('click');
  assert.equal(restored.get('#asset-id').textContent, 'asset-17');
  assert.equal(restored.get('#current-status').textContent, 'Correct');
  assert.equal(restored.get('#review-notes').value, '');
  assert.equal(restored.get('#total-count').textContent, 161);
  assert.equal(restored.get('#export-label').textContent, 'Export reviews');
  restored.get('#audit-toggle').dispatch('click');
  assert.equal(restored.get('#total-count').textContent, 39);
  assert.equal(restored.get('#export-label').textContent, 'Export audit receipt');
});

test('the source-link demo reports a confidence interval and exports its reviewed sample', async () => {
  const app = await harness(undefined, new Map());
  assert.equal(app.get('#audit-demo').hidden, false);
  app.get('#audit-form').dispatch('submit');
  assert.match(app.get('#audit-preview').textContent, /all 5 rows/);
  app.get('#audit-floor').value = '50';
  app.get('#audit-form').dispatch('input');
  assert.equal(app.get('#audit-start').disabled, true);
  app.get('#audit-form').dispatch('submit');
  assert.match(app.get('#audit-preview').textContent, /3 of 5 rows/);
  app.get('#audit-start').dispatch('click');
  for (const { id } of app.audit().reviews) {
    app.clickQueue({ record: id });
    assert.match(app.get('#source-link').attributes.href, /^https:\/\//);
    app.rate('accepted');
  }
  assert.match(app.get('#audit-result').textContent, /passed.*50%/);
  assert.match(app.get('#audit-interval').textContent, /95% confidence interval.*60% to 100%/);
  app.rate('inconclusive');
  assert.match(app.get('#audit-result').textContent, /threshold check is inconclusive/);
  assert.match(app.get('#audit-interval').textContent, /40% to 100%.*unclear rows/);
  app.get('#export-button').dispatch('click');
  const [download] = app.downloads;
  assert.match(download.name, /-accuracy-audit\.json$/);
  const receipt = JSON.parse(await download.blob.text());
  assert.equal(receipt.result.status, 'inconclusive');
  assert.equal(receipt.result.confidenceInterval.lower, 0.4);
  assert.equal(receipt.sample.length, 3);
  assert.ok(receipt.sample.every(row => row.sourceUrl.startsWith('https://')));
});

test('collapsing the navigator preserves previous and next asset navigation', async () => {
  const app = await harness(fixture(3));
  app.clickQueue({ queue: 'pending' });
  assert.equal((app.get('#navigators').innerHTML.match(/aria-expanded="true"/g) || []).length, 0);
  app.get('#next-asset').dispatch('click');
  assert.equal(app.get('#asset-id').textContent, 'asset-2');
  app.get('#previous-asset').dispatch('click');
  assert.equal(app.get('#asset-id').textContent, 'asset-1');
});

test('reviews, notes, and selection survive a page reload', async () => {
  const app = await harness(fixture(3));
  app.clickQueue({ record: 'asset-2' });
  app.rate('inconclusive');
  app.get('#review-notes').value = 'The source does not identify this branch.';
  app.get('#review-notes').dispatch('input');
  const restored = await harness(undefined, app.storage);
  assert.equal(restored.get('#asset-id').textContent, 'asset-2');
  assert.equal(restored.get('#current-status').textContent, 'Inconclusive');
  assert.equal(restored.get('#review-notes').value, 'The source does not identify this branch.');
  assert.equal(restored.get('#reviewed-count').textContent, 1);
  restored.get('#clear-rating').dispatch('click');
  assert.equal(restored.get('#reviewed-count').textContent, 0);
  assert.equal(restored.state().records[1].status, 'pending');
});

test('the sample shows original links and changing records updates the destination', async () => {
  const app = await harness(undefined, new Map());
  assert.equal(app.get('#asset-id').textContent, 'FMC-001');
  assert.match(app.get('#source-link').attributes.href, /^https:\/\/faridabadmedicalcenter\.com\/home\/#:~:text=/);
  assert.equal(app.get('#source-address').textContent, app.get('#source-link').attributes.href);
  app.clickQueue({ record: 'ARTI-003' });
  assert.match(app.get('#source-link').attributes.href, /^https:\/\/artihospital\.com\/site_content\/about/);
  assert.equal(app.get('#missing-source').hidden, true);
});

test('old workspace reviews remain available when a record has no usable source link', async () => {
  const old = fixture(2).map(record => ({ ...record, assetPath: 'review.png' }));
  old[0].sourceUrl = 'javascript:alert(1)';
  old[0].status = 'inconclusive';
  old[0].notes = 'The published total applies to the group.';
  const app = await harness(old);
  assert.equal(app.get('#source-link').hidden, true);
  assert.equal(app.get('#source-link').attributes.href, undefined);
  assert.equal(app.get('#missing-source').hidden, false);
  assert.equal(app.get('#current-status').textContent, 'Inconclusive');
  assert.equal(app.get('#review-notes').value, old[0].notes);
  app.clickQueue({ record: 'asset-2' });
  assert.equal(app.get('#source-link').hidden, false);
  assert.equal(app.get('#source-link').attributes.href, 'https://example.com/source/2');
  assert.equal(app.get('#missing-source').hidden, true);
});

test('an active legacy sample keeps its decisions when the link sample replaces it', async () => {
  const old = {
    id: 'FMC-001', title: 'Old sample', assetPath: './samples/assets/faridabad-capacity.jpg',
    sourceUrl: 'https://faridabadmedicalcenter.com/home/', fields: [{ name: 'claim', value: '35 beds' }],
    original: { id: 'FMC-001' }, status: 'accepted', notes: 'Reviewed in the old sample.', reviewedAt: '2026-11-22',
  };
  const storage = new Map([[storageKey, JSON.stringify({ records: [old], isSample: true, selectedId: old.id })]]);
  const app = await harness(undefined, storage);
  const [first] = app.state().records;
  assert.equal(first.id, old.id);
  assert.equal(first.status, old.status);
  assert.equal(first.notes, old.notes);
  assert.equal(first.reviewedAt, old.reviewedAt);
  assert.equal(Object.hasOwn(first, 'assetPath'), false);
  assert.match(first.sourceUrl, /#:~:text=/);
});

test('the import dialog honors canonical mappings from a reviewed CSV export', async () => {
  const app = await harness(fixture(1));
  const custom = data.normalizeRows([{
    id: 'old-id', custom_id: 'chosen-id', source_url: 'https://example.com/old', page: 'https://example.com/chosen',
    title: 'Old title', custom_title: 'Chosen title', claim: 'Claim',
  }], { idColumn: 'custom_id', sourceColumn: 'page', titleColumn: 'custom_title' });
  custom[0].status = 'rejected';
  const csv = data.toCsv(custom);
  await app.get('#spreadsheet-file').dispatch('change', {
    target: { files: [{ name: 'reviewed.csv', size: csv.length, text: async () => csv }] },
  });
  assert.equal(app.get('#source-column').value, 'review_source_url');
  assert.equal(app.get('#id-column').value, 'review_asset_id');
  assert.equal(app.get('#title-column').value, 'review_asset_title');
  app.get('#import-form').dispatch('submit');
  const [imported] = app.state().records;
  assert.equal(imported.id, 'chosen-id');
  assert.equal(imported.sourceUrl, 'https://example.com/chosen');
  assert.equal(imported.title, 'Chosen title');
  assert.equal(imported.status, 'rejected');
});
