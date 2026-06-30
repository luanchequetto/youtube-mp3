/**
 * YouTube to MP3 Converter — Frontend Application
 * Zero external dependencies (RNF-01): pure vanilla JS
 */

'use strict';

const WORKER_URL = 'https://youtube-mp3-worker.game-zeeraqh.workers.dev';

const MAX_DURATION_SECONDS = 7200; // 2 hours

const CONVERTING_MESSAGES = [
  'Conectando ao serviço de conversão...',
  'Extraindo áudio do YouTube...',
  'Convertendo para MP3...',
  'Finalizando download...',
];

const ERROR_MESSAGES = {
  invalidUrl:    'URL inválida. Use youtube.com/watch?v=... ou youtu.be/...',
  unavailable:   'Este vídeo não está disponível ou é privado.',
  tooLong:       'Vídeos com mais de 2 horas não são suportados.',
  rateLimit:     'Limite de conversões atingido. Tente novamente amanhã.',
  serviceDown:   'Serviço temporariamente indisponível. Tente em alguns minutos.',
  network:       'Erro de conexão. Verifique sua internet e tente novamente.',
};

// ---------------------------------------------------------------------------
// State Machine
// ---------------------------------------------------------------------------

const STATES = Object.freeze({
  IDLE:        'IDLE',
  VALIDATING:  'VALIDATING',
  PREVIEWING:  'PREVIEWING',
  PREVIEW_OK:  'PREVIEW_OK',
  CONVERTING:  'CONVERTING',
  SUCCESS:     'SUCCESS',
  ERROR:       'ERROR',
});

let currentState = STATES.IDLE;
let convertingInterval = null;
let convertingMsgIndex = 0;
let debounceTimer = null;

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/**
 * Extract an 11-character YouTube video ID from all supported URL formats.
 * Supported hostnames: youtube.com, www.youtube.com, m.youtube.com,
 *                      music.youtube.com, youtu.be
 * Supported paths:     /watch?v=, /shorts/, youtu.be/ (bare)
 * @param {string} url
 * @returns {string|null}
 */
function extractVideoId(url) {
  if (!url || typeof url !== 'string') return null;

  let parsed;
  try {
    // Allow bare IDs / paths that lack a scheme
    const normalized = url.trim();
    parsed = new URL(
      /^https?:\/\//i.test(normalized) ? normalized : 'https://' + normalized
    );
  } catch (_) {
    return null;
  }

  const hostname = parsed.hostname.replace(/^(www\.|m\.|music\.)/i, '');
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

  if (hostname === 'youtube.com') {
    // /watch?v=VIDEOID
    const v = parsed.searchParams.get('v');
    if (v && VIDEO_ID_RE.test(v)) return v;

    // /shorts/VIDEOID
    const shortsMatch = parsed.pathname.match(/^\/shorts\/([A-Za-z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];

    // /embed/VIDEOID
    const embedMatch = parsed.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/);
    if (embedMatch) return embedMatch[1];

    return null;
  }

  if (hostname === 'youtu.be') {
    const id = parsed.pathname.slice(1).split('?')[0].split('/')[0];
    if (VIDEO_ID_RE.test(id)) return id;
    return null;
  }

  return null;
}

/**
 * Validate a URL string and return its video ID, or null if invalid.
 * @param {string} url
 * @returns {string|null}
 */
function validateUrl(url) {
  return extractVideoId(url);
}

/**
 * Format a duration in seconds to "M:SS", "MM:SS", or "H:MM:SS".
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;

  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(sec).padStart(2, '0');

  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

/**
 * Fetch preview metadata from YouTube oEmbed API.
 * @param {string} videoId
 * @returns {Promise<{title: string, thumbnail_url: string, author_name: string}>}
 * @throws {Error} with .code property: 'UNAVAILABLE' | 'NETWORK'
 */
async function fetchPreview(videoId) {
  const oEmbedUrl =
    `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&format=json`;

  let response;
  try {
    response = await fetch(oEmbedUrl);
  } catch (_) {
    const err = new Error(ERROR_MESSAGES.network);
    err.code = 'NETWORK';
    throw err;
  }

  if (response.status === 404 || response.status === 401 || response.status === 403) {
    const err = new Error(ERROR_MESSAGES.unavailable);
    err.code = 'UNAVAILABLE';
    throw err;
  }

  if (!response.ok) {
    const err = new Error(ERROR_MESSAGES.network);
    err.code = 'NETWORK';
    throw err;
  }

  const data = await response.json();
  return {
    title:         data.title,
    thumbnail_url: data.thumbnail_url,
    author_name:   data.author_name,
  };
}

/**
 * Send a conversion request to the Cloudflare Worker.
 * @param {string} videoId
 * @returns {Promise<{downloadUrl: string, title: string, duration: number}>}
 * @throws {Error} with .code property
 */
async function convertVideo(videoId) {
  let response;
  try {
    response = await fetch(`${WORKER_URL}/convert`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ videoId }),
    });
  } catch (_) {
    const err = new Error(ERROR_MESSAGES.network);
    err.code = 'NETWORK';
    throw err;
  }

  if (response.status === 429) {
    const err = new Error(ERROR_MESSAGES.rateLimit);
    err.code = 'RATE_LIMIT';
    throw err;
  }

  if (response.status >= 500) {
    const err = new Error(ERROR_MESSAGES.serviceDown);
    err.code = 'SERVICE_DOWN';
    throw err;
  }

  if (!response.ok) {
    const err = new Error(ERROR_MESSAGES.serviceDown);
    err.code = 'SERVICE_DOWN';
    throw err;
  }

  const data = await response.json();

  if (data.duration && data.duration > MAX_DURATION_SECONDS) {
    const err = new Error(ERROR_MESSAGES.tooLong);
    err.code = 'TOO_LONG';
    throw err;
  }

  return {
    downloadUrl: data.downloadUrl,
    title:       data.title,
    duration:    data.duration,
  };
}

/**
 * Trigger a file download for the given URL, using the provided title as filename.
 * Primary strategy: fetch as blob → object URL → anchor click → revoke.
 * Fallback: window.open if fetch fails (CORS, etc.).
 * @param {string} downloadUrl
 * @param {string} title
 * @returns {Promise<void>}
 */
async function triggerDownload(downloadUrl, title) {
  const safeName = title.replace(/[^\w\s.-]/g, '').trim() || 'audio';
  const filename  = `${safeName}.mp3`;

  try {
    const response = await fetch(downloadUrl);
    if (!response.ok) throw new Error('fetch failed');

    const blob      = await response.blob();
    const objectUrl = URL.createObjectURL(blob);

    const anchor    = document.createElement('a');
    anchor.href     = objectUrl;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    // Delay revoke to ensure browser has started the download
    setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
  } catch (_) {
    // Fallback: open in new tab
    window.open(downloadUrl, '_blank', 'noopener,noreferrer');
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve a DOM element by ID; throws if missing (fail-fast during dev).
 * @param {string} id
 * @returns {HTMLElement}
 */
function el(id) {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing DOM element: #${id}`);
  return element;
}

/** Show an element by removing the 'hidden' class. */
function show(element) {
  element.classList.remove('hidden');
}

/** Hide an element by adding the 'hidden' class. */
function hide(element) {
  element.classList.add('hidden');
}

/**
 * Update the aria-live status region with a message.
 * @param {string} message
 */
function announceStatus(message) {
  const region = document.getElementById('status-message');
  if (region) {
    region.textContent = '';
    // Force re-announcement for repeated identical messages
    requestAnimationFrame(() => {
      region.textContent = message;
    });
  }
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

/**
 * Transition the UI to a new application state.
 * Manages CSS classes and section visibility according to the state machine.
 * @param {string} state - One of the STATES values
 * @param {object} [payload] - Optional data for the new state
 */
function setState(state, payload = {}) {
  currentState = state;

  // Cache element references
  const urlInput       = el('url-input');
  const convertBtn     = el('convert-btn');
  const previewSection = el('preview-section');
  const successSection = el('success-section');
  const errorSection   = el('error-section');

  // Reset body state class
  document.body.dataset.state = state;

  // Default: hide transient sections
  hide(previewSection);
  hide(successSection);
  hide(errorSection);

  urlInput.removeAttribute('aria-invalid');
  convertBtn.disabled = true;

  stopConvertingMessages();

  switch (state) {
    case STATES.IDLE:
      urlInput.value = '';
      urlInput.disabled = false;
      announceStatus('');
      break;

    case STATES.VALIDATING:
      urlInput.disabled = false;
      announceStatus('Validando URL...');
      break;

    case STATES.PREVIEWING:
      urlInput.disabled = false;
      show(previewSection);
      announceStatus('Carregando informações do vídeo...');
      break;

    case STATES.PREVIEW_OK:
      urlInput.disabled = false;
      show(previewSection);
      convertBtn.disabled = false;

      if (payload.preview) {
        renderPreview(payload.preview);
      }
      announceStatus('Vídeo encontrado. Pronto para converter.');
      break;

    case STATES.CONVERTING:
      urlInput.disabled = true;
      show(previewSection);
      startConvertingMessages();
      break;

    case STATES.SUCCESS:
      urlInput.disabled = false;
      show(successSection);

      if (payload.title) {
        const titleEl = document.getElementById('success-title');
        if (titleEl) titleEl.textContent = payload.title;
      }
      if (payload.duration != null) {
        const durationEl = document.getElementById('success-duration');
        if (durationEl) durationEl.textContent = formatDuration(payload.duration);
      }
      announceStatus('Download iniciado com sucesso!');
      break;

    case STATES.ERROR:
      urlInput.disabled = false;
      urlInput.setAttribute('aria-invalid', 'true');
      show(errorSection);

      const errorMsgEl = document.getElementById('error-message');
      if (errorMsgEl) {
        errorMsgEl.textContent = payload.message || ERROR_MESSAGES.network;
      }
      announceStatus(payload.message || ERROR_MESSAGES.network);
      break;
  }
}

// ---------------------------------------------------------------------------
// Preview rendering
// ---------------------------------------------------------------------------

/**
 * Populate the preview section with video metadata.
 * @param {{title: string, thumbnail_url: string, author_name: string}} preview
 */
function renderPreview(preview) {
  const thumbEl  = document.getElementById('preview-thumbnail');
  const titleEl  = document.getElementById('preview-title');
  const authorEl = document.getElementById('preview-author');

  if (thumbEl) {
    thumbEl.src = preview.thumbnail_url || '';
    thumbEl.alt = preview.title ? `Thumbnail: ${preview.title}` : 'Video thumbnail';
  }
  if (titleEl)  titleEl.textContent  = preview.title       || '';
  if (authorEl) authorEl.textContent = preview.author_name || '';
}

// ---------------------------------------------------------------------------
// Converting status messages
// ---------------------------------------------------------------------------

function startConvertingMessages() {
  convertingMsgIndex = 0;
  updateConvertingMessage();
  convertingInterval = setInterval(() => {
    convertingMsgIndex = (convertingMsgIndex + 1) % CONVERTING_MESSAGES.length;
    updateConvertingMessage();
  }, 3000);
}

function stopConvertingMessages() {
  if (convertingInterval !== null) {
    clearInterval(convertingInterval);
    convertingInterval = null;
  }
}

function updateConvertingMessage() {
  const msgEl = document.getElementById('converting-message');
  const msg   = CONVERTING_MESSAGES[convertingMsgIndex];
  if (msgEl) msgEl.textContent = msg;
  announceStatus(msg);
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Handle URL input changes (shared by 'input' debounced and 'paste' immediate).
 * @param {string} url
 */
async function handleUrlChange(url) {
  const videoId = validateUrl(url);

  if (!url.trim()) {
    setState(STATES.IDLE);
    return;
  }

  if (!videoId) {
    setState(STATES.ERROR, { message: ERROR_MESSAGES.invalidUrl });
    return;
  }

  setState(STATES.PREVIEWING);

  try {
    const preview = await fetchPreview(videoId);
    // Attach the videoId to the button for use during conversion
    el('convert-btn').dataset.videoId = videoId;
    setState(STATES.PREVIEW_OK, { preview });
  } catch (err) {
    setState(STATES.ERROR, { message: err.message || ERROR_MESSAGES.network });
  }
}

/**
 * Handle the convert button click.
 */
async function handleConvert() {
  const videoId = el('convert-btn').dataset.videoId;
  if (!videoId) return;

  setState(STATES.CONVERTING);

  try {
    const result = await convertVideo(videoId);

    if (result.duration && result.duration > MAX_DURATION_SECONDS) {
      setState(STATES.ERROR, { message: ERROR_MESSAGES.tooLong });
      return;
    }

    await triggerDownload(result.downloadUrl, result.title || 'audio');
    setState(STATES.SUCCESS, { title: result.title, duration: result.duration });
  } catch (err) {
    setState(STATES.ERROR, { message: err.message || ERROR_MESSAGES.network });
  }
}

/**
 * Reset to IDLE state.
 */
function handleConvertAnother() {
  stopConvertingMessages();
  el('convert-btn').dataset.videoId = '';
  setState(STATES.IDLE);
  el('url-input').focus();
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', () => {
  const urlInput        = el('url-input');
  const convertBtn      = el('convert-btn');
  const convertAnotherBtn = document.getElementById('convert-another-btn');

  // Initial state
  setState(STATES.IDLE);

  // 'input' event — debounced 300 ms
  urlInput.addEventListener('input', (event) => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      handleUrlChange(event.target.value);
    }, 300);
  });

  // 'paste' event — immediate (no debounce); value not yet updated at paste time,
  // so read after a tick.
  urlInput.addEventListener('paste', () => {
    clearTimeout(debounceTimer);
    setTimeout(() => {
      handleUrlChange(urlInput.value);
    }, 0);
  });

  // Convert button
  convertBtn.addEventListener('click', () => {
    if (currentState === STATES.PREVIEW_OK) {
      handleConvert();
    }
  });

  // Convert another button
  if (convertAnotherBtn) {
    convertAnotherBtn.addEventListener('click', handleConvertAnother);
  }
});
