const form = document.querySelector('#shorten-form');
const destinationInput = document.querySelector('#destination');
const slugInput = document.querySelector('#slug');
const apiKeyInput = document.querySelector('#api-key');
const submitButton = document.querySelector('#submit-button');
const message = document.querySelector('#form-message');
const result = document.querySelector('#result');
const shortUrl = document.querySelector('#short-url');
const destinationUrl = document.querySelector('#destination-url');
const openLink = document.querySelector('#open-link');
const copyButton = document.querySelector('#copy-button');
const visibilityToggle = document.querySelector('#visibility-toggle');
const rememberKey = document.querySelector('#remember-key');
const API_KEY_STORAGE_KEY = 'shorten-api-key';

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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  setMessage('');
  result.hidden = true;

  const destination = destinationInput.value.trim();
  const apiKey = apiKeyInput.value;
  if (!destination || !apiKey) {
    setMessage('Enter a destination URL and API key.');
    return;
  }

  persistApiKey();

  setLoading(true);
  try {
    const response = await fetch('/api/shorten', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify({ url: destination, slug: slugInput.value.trim() }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to create the link.');

    shortUrl.href = data.shortUrl;
    shortUrl.textContent = data.shortUrl;
    destinationUrl.href = data.destination;
    destinationUrl.textContent = data.destination;
    openLink.href = data.shortUrl;
    result.hidden = false;
    setMessage('Your short link was created.', true);
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    setMessage(error instanceof Error ? error.message : 'Something went wrong. Please try again.');
  } finally {
    setLoading(false);
  }
});

copyButton.addEventListener('click', async () => {
  const value = shortUrl.textContent;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    copyButton.querySelector('span').textContent = 'Copied';
    window.setTimeout(() => { copyButton.querySelector('span').textContent = 'Copy'; }, 1800);
  } catch {
    setMessage('Unable to copy automatically. Please copy the link manually.');
  }
});

function setLoading(loading) {
  submitButton.disabled = loading;
  submitButton.querySelector('span').textContent = loading ? 'Creating…' : 'Create link';
}

function setMessage(text, success = false) {
  message.textContent = text;
  message.classList.toggle('success', success);
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
