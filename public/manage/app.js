const loadForm = document.querySelector('#load-form');
const apiKeyInput = document.querySelector('#api-key');
const visibilityToggle = document.querySelector('#visibility-toggle');
const loadButton = document.querySelector('#load-button');
const message = document.querySelector('#manager-message');
const listSection = document.querySelector('#link-list');
const linksContainer = document.querySelector('#links');
const linkCount = document.querySelector('#link-count');
const loadMoreButton = document.querySelector('#load-more');
const rememberKey = document.querySelector('#remember-key');
const linkControls = document.querySelector('#link-controls');
const destinationSearch = document.querySelector('#destination-search');
const sortOrder = document.querySelector('#sort-order');
const searchButton = document.querySelector('#search-button');
const bulkDeleteMonths = document.querySelector('#bulk-delete-months');
const bulkPreviewButton = document.querySelector('#bulk-preview');
const bulkConfirmation = document.querySelector('#bulk-confirmation');
const bulkConfirmationText = document.querySelector('#bulk-confirmation-text');
const bulkCancelButton = document.querySelector('#bulk-cancel');
const bulkDeleteButton = document.querySelector('#bulk-delete');
const API_KEY_STORAGE_KEY = 'shorten-api-key';

let links = [];
let nextCursor = null;
let totalLinks = 0;
let activeSearch = '';
let activeSort = 'newest';
let pendingDeletion = null;
let pendingBulkDeletion = null;
let listRequestId = 0;

restoreApiKey();

visibilityToggle.addEventListener('click', () => {
  const isHidden = apiKeyInput.type === 'password';
  apiKeyInput.type = isHidden ? 'text' : 'password';
  visibilityToggle.setAttribute('aria-label', isHidden ? 'Hide API key' : 'Show API key');
  visibilityToggle.setAttribute('aria-pressed', String(isHidden));
});

rememberKey.addEventListener('change', persistApiKey);
apiKeyInput.addEventListener('input', () => {
  if (rememberKey.checked) persistApiKey();
});

loadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!apiKeyInput.value) {
    setMessage('Enter your API key.');
    return;
  }
  persistApiKey();
  applyListControls();
  resetList();
  await loadLinks();
});

linkControls.addEventListener('submit', async (event) => {
  event.preventDefault();
  applyListControls();
  resetList();
  await loadLinks();
});

sortOrder.addEventListener('change', async () => {
  applyListControls();
  resetList();
  await loadLinks();
});

loadMoreButton.addEventListener('click', () => loadLinks(nextCursor));

bulkPreviewButton.addEventListener('click', previewBulkDeletion);
bulkCancelButton.addEventListener('click', hideBulkConfirmation);
bulkDeleteButton.addEventListener('click', deleteOlderLinks);

async function loadLinks(cursor) {
  const requestId = ++listRequestId;
  setMessage('');
  setLoading(true);
  try {
    const parameters = new URLSearchParams({ limit: '30', sort: activeSort });
    if (activeSearch) parameters.set('search', activeSearch);
    if (cursor) parameters.set('cursor', cursor);
    const response = await fetch(`/api/links?${parameters}`, { headers: { 'x-api-key': apiKeyInput.value } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to load links.');
    if (requestId !== listRequestId) return false;

    const loadedLinks = Array.isArray(data.links) ? data.links : [];
    links = cursor ? [...links, ...loadedLinks] : loadedLinks;
    nextCursor = typeof data.cursor === 'string' ? data.cursor : null;
    totalLinks = typeof data.total === 'number' && data.total >= 0 ? data.total : links.length;
    listSection.hidden = false;
    renderLinks();
    return true;
  } catch (error) {
    if (requestId === listRequestId) {
      listSection.hidden = links.length === 0;
      setMessage(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    }
    return false;
  } finally {
    if (requestId === listRequestId) setLoading(false);
  }
}

function applyListControls() {
  activeSearch = destinationSearch.value.trim();
  activeSort = sortOrder.value === 'oldest' ? 'oldest' : 'newest';
}

function resetList() {
  listRequestId += 1;
  links = [];
  nextCursor = null;
  totalLinks = 0;
  pendingDeletion = null;
  hideBulkConfirmation();
}

function renderLinks() {
  linksContainer.replaceChildren();
  const countLabel = `${new Intl.NumberFormat().format(links.length)} of ${new Intl.NumberFormat().format(totalLinks)} ${totalLinks === 1 ? 'link' : 'links'}`;
  linkCount.textContent = activeSearch ? `Showing ${countLabel} matching` : `Showing ${countLabel}`;
  loadMoreButton.hidden = !nextCursor;

  if (links.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = activeSearch ? 'No links match this destination URL.' : 'No links found for this API key.';
    linksContainer.append(empty);
    return;
  }

  for (const link of links) {
    linksContainer.append(createLinkRow(link));
    if (pendingDeletion === link.slug) linksContainer.append(createConfirmation(link));
  }
}

function createLinkRow(link) {
  const row = document.createElement('article');
  row.className = 'link-row';

  const shortLink = document.createElement('a');
  shortLink.className = 'link-short';
  shortLink.href = link.shortUrl;
  shortLink.target = '_blank';
  shortLink.rel = 'noopener';
  shortLink.textContent = link.shortUrl;

  const destination = document.createElement('a');
  destination.className = 'link-destination';
  destination.href = link.url;
  destination.target = '_blank';
  destination.rel = 'noopener';
  destination.textContent = link.url;

  const created = document.createElement('time');
  created.className = 'link-created';
  created.dateTime = link.createdAt;
  created.textContent = formatDate(link.createdAt);

  const visits = document.createElement('span');
  visits.className = 'link-visits';
  visits.textContent = new Intl.NumberFormat().format(link.visits || 0);

  const remove = document.createElement('button');
  remove.className = 'delete-button';
  remove.type = 'button';
  remove.setAttribute('aria-label', `Delete ${link.slug}`);
  remove.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';
  remove.addEventListener('click', () => { pendingDeletion = link.slug; renderLinks(); });

  row.append(shortLink, destination, visits, created, remove);
  return row;
}

function createConfirmation(link) {
  const panel = document.createElement('section');
  panel.className = 'delete-confirmation';
  const text = document.createElement('div');
  text.innerHTML = '<h3>Delete this link?</h3><p>This cannot be undone.</p>';
  const actions = document.createElement('div');
  actions.className = 'confirmation-actions';
  const cancel = document.createElement('button');
  cancel.className = 'secondary-button';
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => { pendingDeletion = null; renderLinks(); });
  const confirm = document.createElement('button');
  confirm.className = 'danger-button';
  confirm.type = 'button';
  confirm.textContent = 'Delete link';
  confirm.addEventListener('click', () => deleteLink(link.slug, confirm));
  actions.append(cancel, confirm);
  panel.append(text, actions);
  return panel;
}

async function deleteLink(slug, button) {
  button.disabled = true;
  button.textContent = 'Deleting…';
  setMessage('');
  try {
    const response = await fetch(`/api/links/${encodeURIComponent(slug)}`, { method: 'DELETE', headers: { 'x-api-key': apiKeyInput.value } });
    const data = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to delete the link.');
    links = links.filter((link) => link.slug !== slug);
    totalLinks = Math.max(links.length, totalLinks - 1);
    pendingDeletion = null;
    setMessage('Link deleted.', true);
    renderLinks();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    button.disabled = false;
    button.textContent = 'Delete link';
  }
}

async function previewBulkDeletion() {
  const months = Number(bulkDeleteMonths.value);
  if (![1, 3, 6, 12].includes(months)) {
    setMessage('Choose 1, 3, 6, or 12 months before continuing.');
    return;
  }

  setMessage('');
  setBulkLoading(true, 'Reviewing…');
  try {
    const result = await requestBulkDeletion(months, true);
    if (result.count === 0) {
      hideBulkConfirmation();
      setMessage(`No links were created on or before ${formatDateTime(result.cutoff)}.`, true);
      return;
    }
    pendingBulkDeletion = result;
    bulkConfirmationText.textContent = `This will permanently delete ${new Intl.NumberFormat().format(result.count)} ${result.count === 1 ? 'link' : 'links'} created on or before ${formatDateTime(result.cutoff)}. This cannot be undone.`;
    bulkConfirmation.hidden = false;
    bulkDeleteButton.focus();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
  } finally {
    setBulkLoading(false);
  }
}

async function deleteOlderLinks() {
  if (!pendingBulkDeletion) return;
  setMessage('');
  setBulkLoading(true, 'Deleting…');
  try {
    let deleted = 0;
    let remaining = pendingBulkDeletion.count;
    for (let attempt = 0; remaining > 0 && attempt < 100; attempt += 1) {
      const result = await requestBulkDeletion(pendingBulkDeletion.olderThanMonths, false);
      deleted += Number(result.deleted) || 0;
      remaining = Number(result.remaining) || 0;
      if (result.deleted === 0 && remaining > 0) {
        throw new Error('Deletion stopped before all matching links could be removed. Please refresh and try again.');
      }
    }
    if (remaining > 0) throw new Error('Deletion is taking longer than expected. Please refresh and try again.');
    hideBulkConfirmation();
    resetList();
    const reloaded = await loadLinks();
    if (!reloaded) return;
    setMessage(`Deleted ${new Intl.NumberFormat().format(deleted)} ${deleted === 1 ? 'link' : 'links'}.`, true);
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
  } finally {
    setBulkLoading(false);
  }
}

async function requestBulkDeletion(months, dryRun) {
  const response = await fetch('/api/links/bulk-delete', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKeyInput.value },
    body: JSON.stringify({ olderThanMonths: months, dryRun }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to delete links.');
  return data;
}

function hideBulkConfirmation() {
  pendingBulkDeletion = null;
  bulkConfirmation.hidden = true;
}

function setBulkLoading(loading, label = 'Review deletion') {
  bulkPreviewButton.disabled = loading;
  bulkDeleteMonths.disabled = loading;
  bulkCancelButton.disabled = loading;
  bulkDeleteButton.disabled = loading;
  bulkPreviewButton.textContent = loading ? label : 'Review deletion';
  bulkDeleteButton.textContent = loading ? label : 'Delete links';
}

function setLoading(loading) {
  loadButton.disabled = loading;
  loadButton.querySelector('span').textContent = loading ? 'Loading…' : 'Load links';
  loadMoreButton.disabled = loading;
  searchButton.disabled = loading;
  destinationSearch.disabled = loading;
  sortOrder.disabled = loading;
}

function setMessage(text, success = false) {
  message.textContent = text;
  message.classList.toggle('success', success);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unknown date' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}

function formatDateTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'the selected date' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function restoreApiKey() {
  try {
    const savedKey = localStorage.getItem(API_KEY_STORAGE_KEY);
    if (!savedKey) return;
    apiKeyInput.value = savedKey;
    rememberKey.checked = true;
  } catch {
    // Storage may be disabled by the browser's privacy settings.
  }
}

function persistApiKey() {
  try {
    if (rememberKey.checked && apiKeyInput.value) {
      localStorage.setItem(API_KEY_STORAGE_KEY, apiKeyInput.value);
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
    }
  } catch {
    // The app remains usable when browser storage is unavailable.
  }
}
