const loadForm = document.querySelector('#load-form');
const apiKeyInput = document.querySelector('#api-key');
const visibilityToggle = document.querySelector('#visibility-toggle');
const loadButton = document.querySelector('#load-button');
const message = document.querySelector('#manager-message');
const listSection = document.querySelector('#link-list');
const linksContainer = document.querySelector('#links');
const linkCount = document.querySelector('#link-count');
const loadMoreButton = document.querySelector('#load-more');

let links = [];
let nextCursor = null;
let pendingDeletion = null;

visibilityToggle.addEventListener('click', () => {
  const isHidden = apiKeyInput.type === 'password';
  apiKeyInput.type = isHidden ? 'text' : 'password';
  visibilityToggle.setAttribute('aria-label', isHidden ? 'Hide API key' : 'Show API key');
  visibilityToggle.setAttribute('aria-pressed', String(isHidden));
});

loadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!apiKeyInput.value) {
    setMessage('Enter your API key.');
    return;
  }
  links = [];
  nextCursor = null;
  pendingDeletion = null;
  await loadLinks();
});

loadMoreButton.addEventListener('click', () => loadLinks(nextCursor));

async function loadLinks(cursor) {
  setMessage('');
  setLoading(true);
  try {
    const parameters = new URLSearchParams({ limit: '30' });
    if (cursor) parameters.set('cursor', cursor);
    const response = await fetch(`/api/links?${parameters}`, { headers: { 'x-api-key': apiKeyInput.value } });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load links.');
    links = cursor ? [...links, ...data.links] : data.links;
    nextCursor = data.cursor;
    listSection.hidden = false;
    renderLinks();
  } catch (error) {
    listSection.hidden = links.length === 0;
    setMessage(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
}

function renderLinks() {
  linksContainer.replaceChildren();
  linkCount.textContent = `${links.length} ${links.length === 1 ? 'link' : 'links'}`;
  loadMoreButton.hidden = !nextCursor;

  if (links.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = 'No links found for this API key.';
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
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Unable to delete the link.');
    }
    links = links.filter((link) => link.slug !== slug);
    pendingDeletion = null;
    setMessage('Link deleted.', true);
    renderLinks();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
    button.disabled = false;
    button.textContent = 'Delete link';
  }
}

function setLoading(loading) {
  loadButton.disabled = loading;
  loadButton.querySelector('span').textContent = loading ? 'Loading…' : 'Load links';
  loadMoreButton.disabled = loading;
}

function setMessage(text, success = false) {
  message.textContent = text;
  message.classList.toggle('success', success);
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Unknown date' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date);
}
