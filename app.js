import { parseDelimited, normalizeRows, SOURCE_KEYS, safeSourceUrl, toCsv, paginate, datasetKey, legacyDatasetKey } from './lib/data.js';
import { planAudit, drawAuditSample, evaluateAudit } from './lib/audit.js';

const $ = selector => document.querySelector(selector);
const paths = {
  sheet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v18M5 9h14M5 15h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  link: '<path d="m10 13 4-4m-6 7-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l5-5a4 4 0 0 0-6-6l-1 1" transform="translate(1 -1) scale(.9)"/>',
  external: '<path d="M14 3h7v7m0-7L10 14M10 3H3v18h18v-7"/>',
  note: '<path d="M9 4H4v16h16v-5M14 3l7 7-8 8-5 1 1-5 8-8M14 6l4 4"/>',
  chart: '<path d="M4 18V9m6 9V5m6 13v-7m5 10H2"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  question: '<path d="M8 8a4 4 0 1 1 6 3.5c-1.3.7-2 1-2 3M12 19h.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9 8a3 3 0 1 1 4.5 2.7c-1 .5-1.5 1-1.5 2.3m0 4h.01"/>',
  left: '<path d="m14 6-6 6 6 6"/>',
  right: '<path d="m10 6 6 6-6 6"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M5 9h1m3 0h1m3 0h1m3 0h1M5 12h1m3 0h1m3 0h1m3 0h1M6 16h12"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 14v7h16v-7"/>',
  lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/>',
  pending: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M8 9h8M8 13h6M8 17h4"/>',
};
const icon = (name, className = '') => `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.sheet}</svg>`;
document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon); });
const escapeHtml = text => String(text ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const STATUS = {
  pending: { label: 'To verify', pill: 'Pending review', icon: 'pending' },
  accepted: { label: 'Accepted', pill: 'Correct', icon: 'check' },
  rejected: { label: 'Rejected', pill: 'Incorrect', icon: 'x' },
  inconclusive: { label: 'Inconclusive', pill: 'Inconclusive', icon: 'question' },
};
const STORAGE = 'in-the-loop:active:v1';
let records = [], selectedId = null, expanded = 'pending', query = '';
let replaceLegacySample = false;
let name = 'Repository evidence', isSample = true, key = '', saveFailed = false;
let auditPreview = null, auditRun = null, inAudit = false, allRowsView = null;
const reviewDecision = ({ id, status, notes, reviewedAt }) => ({ id, status, notes, reviewedAt });
const percent = rate => `${(rate * 100).toLocaleString('en-US', { maximumFractionDigits: 3 })}%`;
const queues = Object.fromEntries(Object.keys(STATUS).map(status => [status, { page: 1, size: 10 }]));
let pendingImport = null, workbook = null, loadedFileName = '', toastTimeout, importSequence = 0;

function notify(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}
function notice(message) {
  $('#notice').textContent = message;
  $('#notice').hidden = !message;
}
function visibleRecords() { return inAudit ? auditRun.records : records; }
function current() { return visibleRecords().find(record => record.id === selectedId); }
function queueRecords(status = expanded || current()?.status || 'pending') {
  return visibleRecords().filter(record => record.status === status && (!query || [record.id, record.title, record.sourceUrl, ...record.fields.map(field => field.value)].some(value => String(value).toLowerCase().includes(query))));
}
function auditKey() { return `${key}:accuracy-audit:v1`; }
function persist() {
  try {
    if (auditRun) localStorage.setItem(auditKey(), JSON.stringify({
      plan: auditRun.plan, startedAt: auditRun.startedAt, reviews: auditRun.records.map(reviewDecision),
      countInconclusiveAsWrong: auditRun.countInconclusiveAsWrong,
    }));
    localStorage.setItem(STORAGE, JSON.stringify({ records, name, isSample, key, selectedId, expanded, queues, autoAdvance: $('#auto-advance').checked, inAudit, allRowsView }));
    if (key) localStorage.setItem(key, JSON.stringify(records.map(reviewDecision)));
    saveFailed = false;
    $('#save-status').innerHTML = '<span class="local-dot"></span>Saved locally';
  } catch {
    saveFailed = true;
    $('#save-status').textContent = 'Export to save';
    notice(`Browser storage is unavailable or full. Your reviews are still here for this session. ${inAudit ? 'Export the audit receipt' : 'Export reviews'} to save a copy.`);
  }
}
function sampleRecords(reviews) {
  const byId = new Map(records.map(record => [record.id, record]));
  return reviews.map(({ id, status = 'pending', notes = '', reviewedAt = '' }) => {
    if (!byId.has(id) || !Object.hasOwn(STATUS, status)) throw new Error('The saved sample no longer matches this sheet.');
    return { ...byId.get(id), status, notes, reviewedAt };
  });
}
function restoreAudit() {
  auditRun = null;
  if (!key) return;
  try {
    const saved = JSON.parse(localStorage.getItem(auditKey()));
    if (!saved || saved.plan?.population !== records.length || !Array.isArray(saved.reviews)) return;
    const plan = planAudit(records.length, saved.plan);
    if (saved.reviews.length !== plan.sampleSize || new Set(saved.reviews.map(review => review.id)).size !== plan.sampleSize) return;
    const sample = sampleRecords(saved.reviews);
    const countInconclusiveAsWrong = saved.countInconclusiveAsWrong === true && sample.some(record => record.status === 'inconclusive');
    auditRun = { plan, startedAt: saved.startedAt, records: sample, countInconclusiveAsWrong };
  } catch { /* A damaged audit draft must not prevent the ordinary workspace opening. */ }
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE));
    if (!saved || !Array.isArray(saved.records) || !saved.records.length) return false;
    if (!saved.records.every(record => typeof record.id === 'string' && typeof record.title === 'string' && Array.isArray(record.fields) && Object.hasOwn(STATUS, record.status) && record.original)) return false;
    replaceLegacySample = saved.isSample && saved.records.some(record => Object.hasOwn(record, 'assetPath'));
    records = saved.records.map(({ assetPath, sourceUrl, ...record }) => ({ ...record, sourceUrl: safeSourceUrl(sourceUrl) }));
    name = saved.name || 'Imported spreadsheet';
    isSample = Boolean(saved.isSample);
    key = datasetKey(records);
    restoreAudit();
    inAudit = Boolean(saved.inAudit && auditRun);
    allRowsView = inAudit ? saved.allRowsView : null;
    if (inAudit) $('#audit-panel').open = true;
    const visible = visibleRecords();
    selectedId = visible.some(record => record.id === saved.selectedId) ? saved.selectedId : visible[0].id;
    expanded = saved.expanded === null ? null : STATUS[saved.expanded] ? saved.expanded : 'pending';
    for (const status of Object.keys(STATUS)) {
      if (saved.queues?.[status]) queues[status] = { page: Number(saved.queues[status].page) || 1, size: [1, 10, 50].includes(saved.queues[status].size) ? saved.queues[status].size : 10 };
    }
    $('#auto-advance').checked = Boolean(saved.autoAdvance);
    return true;
  } catch { return false; }
}
function renderNavigation() {
  const navigation = $('#navigators');
  navigation.innerHTML = Object.entries(STATUS).map(([status, meta]) => {
    const items = queueRecords(status), count = visibleRecords().filter(record => record.status === status).length;
    const paged = paginate(items, queues[status].page, queues[status].size);
    queues[status].page = paged.page;
    const open = expanded === status;
    const group = { accepted: 'REVIEWED ASSETS', inconclusive: 'REVISIT LATER' }[status];
    const exportButton = status === 'inconclusive'
      ? `<button type="button" class="queue-export" data-export-inconclusive ${count ? '' : 'disabled'}>Export inconclusive rows</button>`
      : '';
    return `${group ? `<div class="queue-label">${group}</div>` : ''}<div class="queue"><button class="queue-toggle" data-queue="${status}" aria-expanded="${open}" aria-controls="queue-${status}"><span class="queue-symbol ${status}">${icon(meta.icon)}</span><span class="queue-name">${meta.label}</span><span class="queue-count">${count}</span>${icon('right', 'chevron')}</button><div class="queue-panel" id="queue-${status}" ${open ? '' : 'hidden'}>${exportButton}<div class="page-size"><span>Assets per page</span><div class="size-buttons" role="group" aria-label="${meta.label} assets per page">${[1, 10, 50].map(size => `<button data-size="${size}" data-status="${status}" aria-pressed="${queues[status].size === size}" aria-label="Show ${size} ${meta.label.toLowerCase()} assets per page">${size}</button>`).join('')}</div></div><div class="asset-list">${paged.items.length ? paged.items.map((record, offset) => `<button class="asset-item" data-record="${escapeHtml(record.id)}" aria-current="${selectedId === record.id}" title="${escapeHtml(record.title)}"><span class="asset-index">${String((paged.page - 1) * queues[status].size + offset + 1).padStart(2, '0')}</span><span class="asset-item-copy"><strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(record.id)} · ${record.fields.length} fields</small></span></button>`).join('') : '<div class="list-empty">No matching assets</div>'}</div><div class="pagination"><button data-page-change="-1" data-status="${status}" aria-label="Previous ${meta.label.toLowerCase()} list page" ${paged.page <= 1 ? 'disabled' : ''}>${icon('left')}</button><span>Page <select data-page-select="${status}" aria-label="${meta.label} list page">${Array.from({ length: paged.totalPages }, (_, index) => `<option value="${index + 1}" ${index + 1 === paged.page ? 'selected' : ''}>${index + 1}</option>`).join('')}</select> of ${paged.totalPages}</span><button data-page-change="1" data-status="${status}" aria-label="Next ${meta.label.toLowerCase()} list page" ${paged.page >= paged.totalPages ? 'disabled' : ''}>${icon('right')}</button></div></div></div>`;
  }).join('');
}
function renderProgress() {
  const visible = visibleRecords();
  const reviewed = visible.filter(record => record.status !== 'pending').length;
  const accepted = visible.filter(record => record.status === 'accepted').length;
  const rejected = visible.filter(record => record.status === 'rejected').length;
  const inconclusive = visible.filter(record => record.status === 'inconclusive').length;
  const percent = visible.length ? Math.round(reviewed / visible.length * 100) : 0;
  $('#reviewed-count').textContent = reviewed;
  $('#total-count').textContent = visible.length;
  $('#remaining-count').textContent = visible.length - reviewed;
  $('#progress-percent').textContent = `${percent}%`;
  $('#progress-fill').style.width = `${percent}%`;
  $('#progress-track').setAttribute('aria-valuenow', percent);
  $('#progress-description').textContent = reviewed ? `${accepted} accepted · ${rejected} rejected · ${inconclusive} inconclusive` : 'Every review brings the data into focus.';
  $('#export-button').disabled = visible.length === 0;
  $('#export-label').textContent = inAudit ? 'Export audit receipt' : 'Export reviews';
  $('#dataset-label').textContent = name;
  $('#dataset-label').title = name;
  $('#dataset-meta').textContent = inAudit ? `${visible.length} of ${records.length} rows · Frozen sample` : `${records.length} assets · ${isSample ? 'Repository sample' : 'Imported spreadsheet'}`;
  $('#sample-badge').hidden = !isSample;
  renderAudit();
}
function auditResult() {
  const counts = { correct: 0, incorrect: 0, inconclusive: 0, remaining: 0 };
  const outcomes = { accepted: 'correct', rejected: 'incorrect', inconclusive: 'inconclusive', pending: 'remaining' };
  for (const record of auditRun.records) counts[outcomes[record.status]]++;
  return evaluateAudit(auditRun.plan, counts, { countInconclusiveAsWrong: auditRun.countInconclusiveAsWrong });
}
function describePlan(plan) {
  const size = plan.sampleSize === plan.population
    ? `This audit checks all ${plan.population} ${plan.population === 1 ? 'row' : 'rows'}.`
    : `This audit checks ${plan.sampleSize} of ${plan.population} rows, selected at random.`;
  return `${size} At least ${plan.criticalCorrect} ${plan.criticalCorrect === 1 ? 'row must be' : 'rows must be'} confirmed correct to show accuracy above ${percent(plan.floor)}.`;
}
function renderAudit() {
  $('#audit-panel').hidden = records.length === 0;
  $('#audit-form').hidden = Boolean(auditRun);
  $('#audit-demo').hidden = !isSample || records.length !== 5;
  $('#audit-run').hidden = !auditRun;
  if (!auditRun) return;
  $('#audit-toggle').textContent = inAudit ? 'Back to all rows' : 'Open frozen sample';
  $('#audit-export').hidden = inAudit;
  $('#audit-plan').textContent = describePlan(auditRun.plan);
  const result = auditResult();
  $('#audit-inconclusive-options').hidden = result.inconclusive === 0;
  $('#audit-count-inconclusive').textContent = auditRun.countInconclusiveAsWrong ? 'Undo counting as wrong' : 'Mark all as wrong';
  const labels = {
    pending: `${result.remaining} ${result.remaining === 1 ? 'row' : 'rows'} left to review.`,
    pass: `Threshold check passed. The sample supports accuracy above ${percent(auditRun.plan.floor)}.`,
    'not-demonstrated': `The sample did not demonstrate accuracy above ${percent(auditRun.plan.floor)}.`,
    'needs-review': 'The confidence interval is on hold. Revisit the inconclusive rows or choose Mark all as wrong.',
  };
  $('#audit-result').textContent = `${labels[result.status]} ${result.correct} correct · ${result.incorrect} incorrect · ${result.inconclusive} inconclusive.`;
  const interval = result.confidenceInterval;
  $('#audit-interval').hidden = !interval;
  if (!interval) { $('#audit-interval').textContent = ''; return; }
  const allRowsChecked = auditRun.plan.sampleSize === auditRun.plan.population;
  const qualification = result.countInconclusiveAsWrong ? ' Inconclusive rows count as wrong in these results.' : '';
  if (allRowsChecked) {
    $('#audit-interval').textContent = `Copying accuracy: ${percent(interval.lower)}. All rows were reviewed.${qualification}`;
  } else {
    $('#audit-interval').textContent = `${percent(interval.level)} confidence interval for this sheet’s copying accuracy: ${percent(interval.lower)} to ${percent(interval.upper)}.${qualification}`;
  }
}
function clearAuditPreview() {
  auditPreview = null;
  $('#audit-start').disabled = true;
  $('#audit-error').hidden = true;
  $('#audit-preview').hidden = true;
}
function reportAuditError(error) {
  $('#audit-error').textContent = error.message;
  $('#audit-error').hidden = false;
}
function switchAuditView(enabled, preferredStatus = 'pending') {
  const previous = allRowsView;
  if (enabled && !inAudit) allRowsView = { selectedId, expanded };
  if (!enabled) allRowsView = null;
  inAudit = enabled;
  const visible = visibleRecords();
  const selected = (!enabled && visible.find(record => record.id === previous?.selectedId))
    || visible.find(record => record.status === preferredStatus) || visible[0];
  const previousQueue = previous?.expanded;
  expanded = !enabled && (previousQueue === null || Object.hasOwn(STATUS, previousQueue)) ? previousQueue : selected.status;
  query = '';
  $('#asset-search').value = '';
  Object.values(queues).forEach(queue => { queue.page = 1; });
  selectAsset(selected.id, { alignPage: true });
  renderProgress();
}
function neighbor(direction) {
  const items = queueRecords();
  if (!items.length) return null;
  const index = items.findIndex(record => record.id === selectedId);
  if (index >= 0) return items[index + direction] || null;
  const visible = visibleRecords();
  const globalIndex = visible.findIndex(record => record.id === selectedId);
  return direction > 0 ? items.find(record => visible.indexOf(record) > globalIndex) || null : [...items].reverse().find(record => visible.indexOf(record) < globalIndex) || null;
}
function renderDecision() {
  const record = current();
  if (!record) return;
  $('#current-status').textContent = STATUS[record.status].pill;
  $('#current-status').className = `status-pill ${record.status}`;
  document.querySelectorAll('[data-rate]').forEach(button => button.setAttribute('aria-pressed', button.dataset.rate === record.status));
  $('#clear-rating').disabled = record.status === 'pending';
  const hints = {
    pending: 'Choose the result that best fits the evidence.',
    inconclusive: 'Saved in Inconclusive. Revisit this row when you have more evidence.',
  };
  $('#decision-hint').textContent = hints[record.status] || 'Decision saved. You can change it or move to another asset.';
  $('#previous-asset').disabled = !neighbor(-1);
  $('#next-asset').disabled = !neighbor(1);
}
function renderClaim(field) {
  const value = escapeHtml(field.value || '—');
  const source = /^(candidate[\s_-]+)?source[\s_-]+url$/i.test(field.name.trim()) && safeSourceUrl(field.value);
  const content = source
    ? `<a class="claim-source" href="${escapeHtml(source)}" target="_blank" rel="noopener noreferrer">${value}</a>`
    : value;
  return `<div><dt>${escapeHtml(field.name.replaceAll('_', ' '))}</dt><dd>${content}</dd></div>`;
}
function renderCurrent() {
  const record = current();
  $('#review-section').hidden = !record;
  $('#empty-state').hidden = Boolean(record);
  if (!record) return;
  $('#asset-id').textContent = record.id;
  $('#row-label').textContent = `Row ${record.rowNumber}`;
  $('#asset-title').textContent = record.title;
  const visible = visibleRecords();
  $('#asset-position').textContent = `${visible.indexOf(record) + 1} / ${visible.length}`;
  $('#field-count').textContent = `${record.fields.length} fields`;
  $('#claim-fields').innerHTML = record.fields.length ? record.fields.map(renderClaim).join('') : '<div><dd>No claim fields were supplied in this row.</dd></div>';
  const source = safeSourceUrl(record.sourceUrl);
  $('#source-link').hidden = !source;
  if (source) $('#source-link').setAttribute('href', source);
  else $('#source-link').removeAttribute('href');
  $('#source-address').textContent = source;
  $('#missing-source').hidden = Boolean(source);
  $('#review-notes').value = record.notes || '';
  renderDecision();
}
function renderAll() { renderProgress(); renderNavigation(); renderCurrent(); }
function selectAsset(id, { alignPage = false } = {}) {
  selectedId = id;
  if (alignPage && expanded) {
    const index = queueRecords().findIndex(record => record.id === id);
    if (index >= 0) queues[expanded].page = Math.floor(index / queues[expanded].size) + 1;
  }
  renderNavigation(); renderCurrent(); persist();
}
function navigate(direction) {
  const next = neighbor(direction);
  if (next) selectAsset(next.id, { alignPage: true });
}
function rate(status) {
  const record = current();
  if (!record || !STATUS[status]) return;
  const next = neighbor(1) || neighbor(-1);
  const addedInconclusive = status === 'inconclusive' && record.status !== 'inconclusive';
  record.status = status;
  record.reviewedAt = status === 'pending' ? '' : new Date().toISOString();
  if (inAudit && auditRun.countInconclusiveAsWrong
      && (addedInconclusive || !auditRun.records.some(row => row.status === 'inconclusive'))) {
    auditRun.countInconclusiveAsWrong = false;
  }
  persist(); renderProgress(); renderNavigation(); renderDecision();
  notify(status === 'pending' ? 'Decision cleared. Asset is back in To verify.' : `${STATUS[status].pill} · ${saveFailed ? 'export to save your review' : 'review saved'}`);
  if ($('#auto-advance').checked && next && status !== 'pending') selectAsset(next.id, { alignPage: true });
}
function openDataset(importedRecords, { datasetName, sample = false, previousSample } = {}) {
  records = importedRecords;
  key = datasetKey(records);
  // Explicit decisions in an imported review export take precedence over an older local draft.
  const includesReviews = records.some(record => Object.keys(record.original).some(column => column.trim().toLowerCase().replace(/[\s-]+/g, '_') === 'review_status'));
  if (!includesReviews) {
    try {
      const legacyKey = legacyDatasetKey(records);
      const savedDraft = localStorage.getItem(key) ?? (legacyKey && localStorage.getItem(legacyKey));
      const draft = previousSample ?? (savedDraft ? JSON.parse(savedDraft) : null);
      if (Array.isArray(draft)) {
        const byId = new Map(draft.map(review => [review.id, review]));
        records.forEach(record => {
          const review = byId.get(record.id);
          if (review && Object.hasOwn(STATUS, review.status)) {
            record.status = review.status;
            record.notes = typeof review.notes === 'string' ? review.notes : '';
            record.reviewedAt = typeof review.reviewedAt === 'string' ? review.reviewedAt : '';
          }
        });
      }
    } catch { /* Saving will show an actionable message if storage is unavailable. */ }
  }
  selectedId = (records.find(record => record.status === 'pending') || records[0])?.id || null;
  expanded = records.some(record => record.status === 'pending') ? 'pending' : records[0]?.status || 'pending';
  name = datasetName || 'Imported spreadsheet'; isSample = sample;
  restoreAudit();
  inAudit = false;
  allRowsView = null;
  clearAuditPreview();
  query = '';
  $('#asset-search').value = '';
  Object.values(queues).forEach(queue => { queue.page = 1; });
  notice(''); persist(); renderAll();
}
async function loadSample(previousSample) {
  try {
    const response = await fetch(new URL('./samples/evidence.csv', import.meta.url));
    if (!response.ok) throw new Error(`Could not load the sample (${response.status}).`);
    openDataset(normalizeRows(parseDelimited(await response.text()).rows), { datasetName: 'Repository evidence', sample: true, previousSample });
  } catch (error) { notice(error.message); renderAll(); }
}

$('#navigators').addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || button.disabled) return;
  if (button.dataset.queue) {
    if (expanded === button.dataset.queue) { expanded = null; renderNavigation(); renderDecision(); persist(); return; }
    expanded = button.dataset.queue;
    const paged = paginate(queueRecords(), queues[expanded].page, queues[expanded].size);
    selectedId = paged.items.some(record => record.id === selectedId) ? selectedId : paged.items[0]?.id || null;
    renderNavigation(); renderCurrent(); persist();
  } else if (button.dataset.record) selectAsset(button.dataset.record);
  else if (Object.hasOwn(button.dataset, 'exportInconclusive')) exportInconclusiveRows(visibleRecords(), inAudit);
  else if (button.dataset.size) {
    const queue = queues[button.dataset.status]; queue.size = Number(button.dataset.size); queue.page = 1;
    renderNavigation(); persist();
  } else if (button.dataset.pageChange) {
    queues[button.dataset.status].page += Number(button.dataset.pageChange); renderNavigation(); persist();
  }
});
$('#navigators').addEventListener('change', event => {
  if (event.target.dataset.pageSelect) { queues[event.target.dataset.pageSelect].page = Number(event.target.value); renderNavigation(); persist(); }
});
$('#asset-search').addEventListener('input', event => {
  query = event.target.value.trim().toLowerCase();
  Object.values(queues).forEach(queue => { queue.page = 1; });
  if (!expanded) expanded = 'pending';
  if (!queueRecords().some(record => record.id === selectedId)) selectedId = queueRecords()[0]?.id || null;
  renderNavigation(); renderCurrent();
});
$('#previous-asset').addEventListener('click', () => navigate(-1));
$('#next-asset').addEventListener('click', () => navigate(1));
document.querySelectorAll('[data-rate]').forEach(button => button.addEventListener('click', () => rate(button.dataset.rate)));
$('#clear-rating').addEventListener('click', () => rate('pending'));
$('#auto-advance').addEventListener('change', persist);
$('#review-notes').addEventListener('input', event => {
  const record = current();
  if (record) { record.notes = event.target.value; if (record.status !== 'pending') record.reviewedAt = new Date().toISOString(); persist(); }
});
function download(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportFilename() {
  return name.replace(/\.[^.]+$/, '').replace(/[^\w\s.-]/g, '_');
}
function exportInconclusiveRows(rows, sample) {
  const unresolved = rows.filter(record => record.status === 'inconclusive');
  if (!unresolved.length) return;
  try {
    const scope = sample ? 'sample-inconclusive' : 'inconclusive';
    download(toCsv(unresolved), `${exportFilename()}-${scope}.csv`, 'text/csv;charset=utf-8');
    notify('Inconclusive rows downloaded.');
  } catch (error) { notice(error.message); }
}
function exportAudit() {
  const receipt = {
    dataset: name, datasetKey: key, startedAt: auditRun.startedAt, exportedAt: new Date().toISOString(),
    method: { threshold: 'one-sided exact hypergeometric', interval: 'two-sided exact hypergeometric' },
    assumptions: { countInconclusiveAsWrong: auditRun.countInconclusiveAsWrong },
    plan: auditRun.plan, result: auditResult(), sample: auditRun.records.map((record, index) => ({
      drawOrder: index + 1, rowNumber: record.rowNumber, sourceUrl: record.sourceUrl, ...reviewDecision(record),
    })),
  };
  download(JSON.stringify(receipt, null, 2) + '\n', `${exportFilename()}-accuracy-audit.json`, 'application/json');
  notify('Audit receipt downloaded.');
}
$('#export-button').addEventListener('click', () => {
  try {
    if (inAudit) { exportAudit(); return; }
    download(toCsv(records), `${exportFilename()}-reviewed.csv`, 'text/csv;charset=utf-8');
    notify('Review export downloaded.');
  }
  catch (error) { notice(error.message); }
});
$('#audit-form').addEventListener('input', clearAuditPreview);
$('#audit-form').addEventListener('submit', event => {
  event.preventDefault();
  if (auditRun || !records.length) return;
  clearAuditPreview();
  const proportion = id => {
    const value = $(`#audit-${id}`).value.trim();
    return value ? Number(value) / 100 : NaN;
  };
  try {
    auditPreview = planAudit(records.length, {
      alpha: proportion('alpha'), floor: proportion('floor'),
      designAccuracy: proportion('target'), power: proportion('power'),
    });
    $('#audit-preview').textContent = describePlan(auditPreview);
    $('#audit-preview').hidden = false;
    $('#audit-start').disabled = false;
  } catch (error) { reportAuditError(error); }
});
$('#audit-start').addEventListener('click', () => {
  if (!auditPreview || auditRun) return;
  try {
    const ids = drawAuditSample(records.map(record => record.id), auditPreview.sampleSize);
    auditRun = {
      plan: auditPreview, startedAt: new Date().toISOString(), records: sampleRecords(ids.map(id => ({ id }))),
      countInconclusiveAsWrong: false,
    };
  } catch (error) { reportAuditError(error); return; }
  clearAuditPreview();
  switchAuditView(true);
  $('#audit-toggle').focus();
});
$('#audit-toggle').addEventListener('click', () => { if (auditRun) switchAuditView(!inAudit); });
$('#audit-revisit').addEventListener('click', () => {
  if (auditRun?.records.some(record => record.status === 'inconclusive')) switchAuditView(true, 'inconclusive');
});
$('#audit-count-inconclusive').addEventListener('click', () => {
  if (!auditRun?.records.some(record => record.status === 'inconclusive')) return;
  auditRun.countInconclusiveAsWrong = !auditRun.countInconclusiveAsWrong;
  persist();
  renderAudit();
});
$('#audit-export-inconclusive').addEventListener('click', () => {
  if (auditRun) exportInconclusiveRows(auditRun.records, true);
});
$('#audit-export').addEventListener('click', () => {
  if (!auditRun) return;
  try { exportAudit(); }
  catch (error) { notice(error.message); }
});
function importError(message = '') { $('#import-error').textContent = message; $('#import-error').hidden = !message; }
function showImport() { $('#import-dialog').showModal(); }
$('#import-button').addEventListener('click', showImport);
$('#empty-import').addEventListener('click', showImport);
$('#help-button').addEventListener('click', () => $('#help-dialog').showModal());
$('#load-sample').addEventListener('click', async () => { $('#help-dialog').close(); await loadSample(); notify('Repository sample loaded.'); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => document.getElementById(button.dataset.close).close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } }));

function setImportTable(table) {
  if (table.rows.length > 25000) throw new Error('Please split this spreadsheet into files of 25,000 rows or fewer.');
  pendingImport = table;
  const normalized = value => value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  function options(selector, aliases, placeholder = 'Generate from row') {
    const select = $(selector);
    select.replaceChildren();
    select.add(new Option(placeholder, ''));
    table.headers.forEach(header => select.add(new Option(header, header)));
    const match = aliases.map(alias => table.headers.find(header => normalized(header) === alias)).find(Boolean);
    select.value = match || '';
  }
  options('#source-column', SOURCE_KEYS, 'Select original page column');
  options('#title-column', ['review_asset_title', 'title', 'name', 'facility_name', 'hospital_name', 'document_title']);
  options('#id-column', ['review_asset_id', 'id', 'asset_id', 'record_id']);
  $('#import-settings').hidden = false;
  $('#import-summary').textContent = `${table.rows.length.toLocaleString()} assets · ${table.headers.length} columns · remaining claim fields appear in the workspace.`;
  $('#confirm-import').disabled = false;
}
function selectSheet() {
  pendingImport = null;
  $('#confirm-import').disabled = true;
  try {
    const sheet = workbook.Sheets[$('#sheet-select').value];
    const text = window.XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    setImportTable(parseDelimited(text)); importError();
  } catch (error) { importError(error.message); }
}
async function readSpreadsheet(file) {
  const sequence = ++importSequence;
  pendingImport = null; workbook = null;
  $('#confirm-import').disabled = true; $('#import-settings').hidden = true; importError();
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) { importError('Choose a file smaller than 20 MB.'); return; }
  try {
    loadedFileName = file.name;
    $('#file-label').textContent = file.name;
    if (/\.xlsx$/i.test(file.name)) {
      if (!window.XLSX) throw new Error('Excel support could not load. Refresh the page or save your spreadsheet as CSV.');
      const buffer = await file.arrayBuffer();
      if (sequence !== importSequence) return;
      workbook = window.XLSX.read(buffer, { type: 'array', cellDates: false });
      if (!workbook.SheetNames.length) throw new Error('The workbook contains no worksheets.');
      $('#sheet-select').replaceChildren(...workbook.SheetNames.map(sheet => new Option(sheet, sheet)));
      $('#sheet-field').hidden = false;
      selectSheet();
    } else if (/\.(csv|tsv)$/i.test(file.name)) {
      const text = await file.text();
      if (sequence !== importSequence) return;
      $('#sheet-field').hidden = true;
      setImportTable(parseDelimited(text, /\.tsv$/i.test(file.name) ? '\t' : undefined));
    } else throw new Error('Choose a CSV, TSV, or .xlsx spreadsheet.');
  } catch (error) { if (sequence === importSequence) importError(error.message); }
}
$('#spreadsheet-file').addEventListener('change', event => readSpreadsheet(event.target.files[0]));
$('#sheet-select').addEventListener('change', selectSheet);
$('#dropzone').addEventListener('dragover', event => { event.preventDefault(); $('#dropzone').classList.add('dragover'); });
$('#dropzone').addEventListener('dragleave', () => $('#dropzone').classList.remove('dragover'));
$('#dropzone').addEventListener('drop', event => { event.preventDefault(); $('#dropzone').classList.remove('dragover'); readSpreadsheet(event.dataTransfer.files[0]); });
$('#import-form').addEventListener('submit', event => {
  event.preventDefault();
  if (!pendingImport) return;
  try {
    const imported = normalizeRows(pendingImport.rows, {
      sourceColumn: $('#source-column').value || undefined,
      titleColumn: $('#title-column').value,
      idColumn: $('#id-column').value,
    });
    openDataset(imported, { datasetName: loadedFileName });
    $('#import-dialog').close(); notify(`Loaded ${records.length} assets. Ready for a human check.`);
  } catch (error) { importError(error.message); }
});
document.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]') || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
  if (['1', '2', '3'].includes(event.key)) { event.preventDefault(); rate({ 1: 'rejected', 2: 'inconclusive', 3: 'accepted' }[event.key]); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
});

if (restore()) {
  renderAll();
  if (replaceLegacySample) await loadSample(records);
} else {
  await loadSample();
}
