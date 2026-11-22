import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as data from '../lib/data.js';

// A small DOM adapter exercises the app's actual event handlers without a browser
// dependency. Layout and XLSX uploads can also be exercised in a real browser.
const appSource = readFileSync(new URL('../app.js', import.meta.url), 'utf8')
  .replace(/^import[^\n]+\n/, '')
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
  const storage = savedStorage || new Map([[storageKey, JSON.stringify({
    records, selectedId: records[0].id, expanded: 'pending',
    name: 'Test spreadsheet', isSample: false,
  })]]);
  let objectUrls = 0;
  class TestURL extends URL {
    static createObjectURL() { return `blob:test-${++objectUrls}`; }
    static revokeObjectURL() {}
  }
  const context = vm.createContext({
    ...data,
    document: {
      querySelector: selector => selector === 'dialog[open]' ? null : get(selector),
      querySelectorAll: selector => selector === '[data-rate]' ? ratings : [],
      getElementById: id => get(`#${id}`),
      addEventListener() {},
    },
    fetch: async () => ({
      ok: true,
      text: async () => readFileSync(new URL('../samples/evidence.csv', import.meta.url), 'utf8'),
    }),
    location: { href: 'http://localhost:4173/' },
    URL: TestURL,
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
    get, storage,
    state: () => JSON.parse(storage.get(storageKey)),
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
