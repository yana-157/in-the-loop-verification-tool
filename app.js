import { parseDelimited, normalizeRows, resolveAssetUrl, safeSourceUrl, toCsv, paginate, datasetKey } from './lib/data.js';

const $ = selector => document.querySelector(selector);
const paths = {
  sheet: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 3v18M5 9h14M5 15h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 15v5h16v-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 5-5 4 4 4-6 5 7"/>',
  expand: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m8 0h5v-5"/>',
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
let records = [], selectedId = null, expanded = 'pending', query = '', zoom = 100;
let settings = { repository: 'yana-157/in-the-loop-verification-tool', ref: 'main' };
let name = 'Repository evidence', isSample = true, key = '', saveFailed = false;
const queues = Object.fromEntries(Object.keys(STATUS).map(status => [status, { page: 1, size: 10 }]));
let pendingImport = null, workbook = null, loadedFileName = '', toastTimeout, importSequence = 0;
let localFiles = new Map(), localUrls = new Set();

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
function current() { return records.find(record => record.id === selectedId); }
function queueRecords(status = expanded || current()?.status || 'pending') {
  return records.filter(record => record.status === status && (!query || [record.id, record.title, record.assetPath, ...record.fields.map(field => field.value)].some(value => String(value).toLowerCase().includes(query))));
}
function persist() {
  try {
    localStorage.setItem(STORAGE, JSON.stringify({ records, settings, name, isSample, key, selectedId, expanded, queues, autoAdvance: $('#auto-advance').checked }));
    if (key) localStorage.setItem(key, JSON.stringify(records.map(({ id, status, notes, reviewedAt }) => ({ id, status, notes, reviewedAt }))));
    saveFailed = false;
    $('#save-status').innerHTML = '<span class="local-dot"></span>Saved locally';
  } catch {
    saveFailed = true;
    $('#save-status').textContent = 'Export to save';
    notice('Browser storage is unavailable or full. Your reviews are still here for this session. Export reviews to save a copy.');
  }
}
function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE));
    if (!saved || !Array.isArray(saved.records) || !saved.records.length) return false;
    if (!saved.records.every(record => typeof record.id === 'string' && typeof record.title === 'string' && typeof record.assetPath === 'string' && Array.isArray(record.fields) && STATUS[record.status] && record.original)) return false;
    records = saved.records;
    settings = saved.settings || settings;
    name = saved.name || 'Imported spreadsheet';
    isSample = Boolean(saved.isSample);
    key = datasetKey(records);
    selectedId = records.some(record => record.id === saved.selectedId) ? saved.selectedId : records[0].id;
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
  navigation.innerHTML = Object.entries(STATUS).map(([status, meta], index) => {
    const items = queueRecords(status), count = records.filter(record => record.status === status).length;
    const paged = paginate(items, queues[status].page, queues[status].size);
    queues[status].page = paged.page;
    const open = expanded === status;
    return `${index === 1 ? '<div class="queue-label">REVIEWED ASSETS</div>' : ''}<div class="queue"><button class="queue-toggle" data-queue="${status}" aria-expanded="${open}" aria-controls="queue-${status}"><span class="queue-symbol ${status}">${icon(meta.icon)}</span><span class="queue-name">${meta.label}</span><span class="queue-count">${count}</span>${icon('right', 'chevron')}</button><div class="queue-panel" id="queue-${status}" ${open ? '' : 'hidden'}><div class="page-size"><span>Assets per page</span><div class="size-buttons" role="group" aria-label="${meta.label} assets per page">${[1, 10, 50].map(size => `<button data-size="${size}" data-status="${status}" aria-pressed="${queues[status].size === size}" aria-label="Show ${size} ${meta.label.toLowerCase()} assets per page">${size}</button>`).join('')}</div></div><div class="asset-list">${paged.items.length ? paged.items.map((record, offset) => `<button class="asset-item" data-record="${escapeHtml(record.id)}" aria-current="${selectedId === record.id}" title="${escapeHtml(record.title)}"><span class="asset-index">${String((paged.page - 1) * queues[status].size + offset + 1).padStart(2, '0')}</span><span class="asset-item-copy"><strong>${escapeHtml(record.title)}</strong><small>${escapeHtml(record.id)} · ${record.fields.length} fields</small></span></button>`).join('') : '<div class="list-empty">No matching assets</div>'}</div><div class="pagination"><button data-page-change="-1" data-status="${status}" aria-label="Previous ${meta.label.toLowerCase()} list page" ${paged.page <= 1 ? 'disabled' : ''}>${icon('left')}</button><span>Page <select data-page-select="${status}" aria-label="${meta.label} list page">${Array.from({ length: paged.totalPages }, (_, index) => `<option value="${index + 1}" ${paged.page === index + 1 ? 'selected' : ''}>${index + 1}</option>`).join('')}</select> of ${paged.totalPages}</span><button data-page-change="1" data-status="${status}" aria-label="Next ${meta.label.toLowerCase()} list page" ${paged.page >= paged.totalPages ? 'disabled' : ''}>${icon('right')}</button></div></div></div>`;
  }).join('');
}
function renderProgress() {
  const reviewed = records.filter(record => record.status !== 'pending').length;
  const accepted = records.filter(record => record.status === 'accepted').length;
  const rejected = records.filter(record => record.status === 'rejected').length;
  const inconclusive = records.filter(record => record.status === 'inconclusive').length;
  const percent = records.length ? Math.round(reviewed / records.length * 100) : 0;
  $('#reviewed-count').textContent = reviewed;
  $('#total-count').textContent = records.length;
  $('#remaining-count').textContent = records.length - reviewed;
  $('#progress-percent').textContent = `${percent}%`;
  $('#progress-fill').style.width = `${percent}%`;
  $('#progress-track').setAttribute('aria-valuenow', percent);
  $('#progress-description').textContent = reviewed ? `${accepted} accepted · ${rejected} rejected · ${inconclusive} inconclusive` : 'Every review brings the data into focus.';
  $('#export-button').disabled = records.length === 0;
  $('#dataset-label').textContent = name;
  $('#dataset-label').title = name;
  $('#dataset-meta').textContent = `${records.length} assets · ${isSample ? 'Repository sample' : 'Imported spreadsheet'}`;
  $('#sample-badge').hidden = !isSample;
}
function neighbor(direction) {
  const items = queueRecords();
  if (!items.length) return null;
  const index = items.findIndex(record => record.id === selectedId);
  if (index >= 0) return items[index + direction] || null;
  const globalIndex = records.findIndex(record => record.id === selectedId);
  return direction > 0 ? items.find(record => records.indexOf(record) > globalIndex) || null : [...items].reverse().find(record => records.indexOf(record) < globalIndex) || null;
}
function renderDecision() {
  const record = current();
  if (!record) return;
  $('#current-status').textContent = STATUS[record.status].pill;
  $('#current-status').className = `status-pill ${record.status}`;
  document.querySelectorAll('[data-rate]').forEach(button => button.setAttribute('aria-pressed', button.dataset.rate === record.status));
  $('#clear-rating').disabled = record.status === 'pending';
  $('#decision-hint').textContent = record.status === 'pending' ? 'Choose the result that best fits the evidence.' : 'Decision saved. You can change it or move to another asset.';
  $('#previous-asset').disabled = !neighbor(-1);
  $('#next-asset').disabled = !neighbor(1);
}
function filename(path) {
  try { return decodeURIComponent(String(path).split(/[?#]/)[0].split('/').pop()).toLowerCase(); }
  catch { return String(path).split('/').pop().toLowerCase(); }
}
function imageUrl(record) {
  const attached = localFiles.get(record.assetPath) || localFiles.get(filename(record.assetPath));
  if (attached) return attached;
  return resolveAssetUrl(record.assetPath, { ...settings, ...(record.assetPath.startsWith('./') ? { baseUrl: new URL('.', location.href).href } : {}) });
}
function imageState(title, description) {
  $('#image-state').hidden = false;
  $('#image-state strong').textContent = title;
  $('#image-state p').textContent = description;
}
function loadImage(record) {
  const img = $('#evidence-image');
  img.hidden = true;
  img.removeAttribute('src');
  img.alt = `Captured screenshot for ${record.title}`;
  $('#image-path').textContent = record.assetPath;
  $('#image-path').title = record.assetPath;
  $('#expand-image').disabled = true;
  imageState('Loading screenshot…', 'Opening the image linked in this spreadsheet row.');
  try {
    const url = imageUrl(record);
    img.onload = () => {
      img.hidden = false;
      $('#image-state').hidden = true;
      $('#expand-image').disabled = false;
    };
    img.onerror = () => imageState('Screenshot unavailable', 'Check the file path or attach the screenshot below. Private GitHub images need a local attachment or a publicly accessible image URL.');
    img.src = url;
  } catch (error) { imageState('Check the screenshot path', error.message); }
}
function setZoom(value) {
  zoom = Math.max(50, Math.min(300, value));
  $('#evidence-image').style.width = `${zoom}%`;
  $('#zoom-reset').textContent = `${zoom}%`;
  $('#zoom-out').disabled = zoom <= 50;
  $('#zoom-in').disabled = zoom >= 300;
}
function renderCurrent() {
  const record = current();
  $('#review-section').hidden = !record;
  $('#empty-state').hidden = Boolean(record);
  if (!record) return;
  $('#asset-id').textContent = record.id;
  $('#row-label').textContent = `Row ${record.rowNumber}`;
  $('#asset-title').textContent = record.title;
  $('#asset-position').textContent = `${records.indexOf(record) + 1} / ${records.length}`;
  $('#field-count').textContent = `${record.fields.length} fields`;
  $('#claim-fields').innerHTML = record.fields.length ? record.fields.map(field => `<div><dt>${escapeHtml(field.name.replaceAll('_', ' '))}</dt><dd>${escapeHtml(field.value || '—')}</dd></div>`).join('') : '<div><dd>No claim fields were supplied in this row.</dd></div>';
  const source = safeSourceUrl(record.sourceUrl);
  $('#source-link').hidden = !source;
  if (source) $('#source-link').href = source;
  else $('#source-link').removeAttribute('href');
  $('#review-notes').value = record.notes || '';
  $('#image-viewport').scrollTo(0, 0);
  setZoom(100);
  loadImage(record);
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
  record.status = status;
  record.reviewedAt = status === 'pending' ? '' : new Date().toISOString();
  persist(); renderProgress(); renderNavigation(); renderDecision();
  notify(status === 'pending' ? 'Decision cleared. Asset is back in To verify.' : `${STATUS[status].pill} · ${saveFailed ? 'export to save your review' : 'review saved'}`);
  if ($('#auto-advance').checked && next && status !== 'pending') selectAsset(next.id, { alignPage: true });
}
function revokeLocalImages() {
  localUrls.forEach(url => URL.revokeObjectURL(url));
  localUrls = new Set(); localFiles = new Map();
}
function openDataset(importedRecords, { datasetName, sample = false, repository = settings.repository, ref = settings.ref } = {}) {
  revokeLocalImages();
  records = importedRecords;
  key = datasetKey(records);
  // Explicit decisions in an imported review export take precedence over an older local draft.
  const includesReviews = records.some(record => Object.keys(record.original).some(column => column.trim().toLowerCase().replace(/[\s-]+/g, '_') === 'review_status'));
  if (!includesReviews) {
    try {
      const draft = JSON.parse(localStorage.getItem(key));
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
  settings = { repository, ref }; query = '';
  $('#asset-search').value = '';
  Object.values(queues).forEach(queue => { queue.page = 1; });
  notice(''); persist(); renderAll();
}
async function loadSample() {
  try {
    const response = await fetch(new URL('./samples/evidence.csv', import.meta.url));
    if (!response.ok) throw new Error(`Could not load the sample (${response.status}).`);
    openDataset(normalizeRows(parseDelimited(await response.text()).rows), { datasetName: 'Repository evidence', sample: true });
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
$('#zoom-in').addEventListener('click', () => setZoom(zoom + 25));
$('#zoom-out').addEventListener('click', () => setZoom(zoom - 25));
$('#zoom-reset').addEventListener('click', () => setZoom(100));
$('#expand-image').addEventListener('click', () => {
  if (!current() || $('#evidence-image').hidden) return;
  $('#expanded-image').src = $('#evidence-image').src;
  $('#expanded-title').textContent = current().title;
  $('#image-dialog').showModal();
});
$('#attach-button').addEventListener('click', () => $('#screenshot-files').click());
$('#screenshot-files').addEventListener('change', event => {
  let matched = 0, ambiguous = 0;
  const files = Array.from(event.target.files);
  const counts = new Map();
  files.forEach(file => counts.set(file.name.toLowerCase(), (counts.get(file.name.toLowerCase()) || 0) + 1));
  for (const file of files) {
    if (!file.type.startsWith('image/') || counts.get(file.name.toLowerCase()) > 1) continue;
    const matching = records.filter(record => filename(record.assetPath) === file.name.toLowerCase());
    if (!matching.length) continue;
    if (new Set(matching.map(record => record.assetPath)).size > 1) { ambiguous++; continue; }
    const url = URL.createObjectURL(file); localUrls.add(url);
    matching.forEach(record => { localFiles.set(record.assetPath, url); matched++; });
  }
  if (current()) loadImage(current());
  notify(ambiguous ? `Skipped ${ambiguous} ambiguous filenames. Give screenshots in different folders unique filenames. ${matched} assets attached.` : matched ? `Attached screenshots for ${matched} assets. Reattach after refreshing.` : 'No filenames matched. Use the same image filename as the spreadsheet.');
  event.target.value = '';
});
function download(content, filename, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('#export-button').addEventListener('click', () => {
  try { download(toCsv(records), `${name.replace(/\.[^.]+$/, '').replace(/[^\w\s.-]/g, '_')}-reviewed.csv`, 'text/csv;charset=utf-8'); notify('Review export downloaded.'); }
  catch (error) { notice(error.message); }
});
function importError(message = '') { $('#import-error').textContent = message; $('#import-error').hidden = !message; }
function showImport() {
  $('#repository-input').value = settings.repository; $('#ref-input').value = settings.ref;
  $('#import-dialog').showModal();
}
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
  function options(selector, aliases, optional) {
    const select = $(selector);
    select.replaceChildren();
    if (optional) select.add(new Option('Generate from row', ''));
    else select.add(new Option('Select screenshot column', ''));
    table.headers.forEach(header => select.add(new Option(header, header)));
    const match = aliases.map(alias => table.headers.find(header => normalized(header) === alias)).find(Boolean);
    select.value = match || '';
  }
  options('#asset-column', ['review_asset_path', 'asset_path', 'screenshot_path', 'github_path', 'filepath', 'file_path', 'screenshot', 'screenshot_url', 'asset_url', 'image_path', 'image_url', 'asset'], false);
  options('#title-column', ['review_asset_title', 'title', 'name', 'facility_name', 'hospital_name', 'document_title'], true);
  options('#id-column', ['review_asset_id', 'id', 'asset_id', 'record_id'], true);
  $('#import-settings').hidden = false;
  $('#import-summary').textContent = `${table.rows.length.toLocaleString()} assets · ${table.headers.length} columns · all other fields will appear as scraped claims.`;
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
    const repository = $('#repository-input').value.trim(), ref = $('#ref-input').value.trim();
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Enter the GitHub repository as owner/repository.');
    if (!ref) throw new Error('Enter a branch or commit.');
    const imported = normalizeRows(pendingImport.rows, { assetColumn: $('#asset-column').value, titleColumn: $('#title-column').value, idColumn: $('#id-column').value });
    openDataset(imported, { datasetName: loadedFileName, repository, ref });
    $('#import-dialog').close(); notify(`Loaded ${records.length} assets. Ready for a human check.`);
  } catch (error) { importError(error.message); }
});
document.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || document.querySelector('dialog[open]') || event.target.closest('input,textarea,select,[contenteditable="true"]')) return;
  if (['1', '2', '3'].includes(event.key)) { event.preventDefault(); rate({ 1: 'rejected', 2: 'inconclusive', 3: 'accepted' }[event.key]); }
  if (event.key === 'ArrowLeft') { event.preventDefault(); navigate(-1); }
  if (event.key === 'ArrowRight') { event.preventDefault(); navigate(1); }
});

if (restore()) renderAll();
else await loadSample();
