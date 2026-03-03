const TASK_PREFIX = 'omnistitch_task_';
const TASK_PARAM = 'omnistitch_task';
const PROMPT_PARAM = 'q';
const SOURCE_URL_PARAM = 'omnistitch_source';
const SOURCE_TITLE_PARAM = 'omnistitch_title';
const CAPTURE_DUMP_PARAM = 'omnistitch_capture_dump';
const MESSAGE_ACTION = 'omnistitch_auto_send';
const AI_RESPONSE_REPORT_ACTION = 'omnistitch_ai_response_report';
const CAPTURE_NETWORK_TRACK_START_ACTION = 'omnistitch_capture_network_track_start';
const CAPTURE_NETWORK_TRACK_STOP_ACTION = 'omnistitch_capture_network_track_stop';
const CAPTURE_NETWORK_WAIT_IDLE_ACTION = 'omnistitch_capture_network_wait_idle';
const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 250;
const DEDUPE_WINDOW_MS = 15000;
const RESPONSE_CAPTURE_TIMEOUT_MS = 180000;
const MIN_RESPONSE_TEXT_LENGTH = 20;
const RESPONSE_LOG_PREVIEW_LENGTH = 100;
const CAPTURE_ACK_TIMEOUT_MS = 2000;
const CAPTURE_HARD_TIMEOUT_MS = 185000;
const CAPTURE_DUMP_FLUSH_TIMEOUT_MS = 25000;
const CAPTURE_NETWORK_IDLE_WAIT_TIMEOUT_MS = 7000;
const SEND_BUTTON_WAIT_TIMEOUT_MS = 6000;
const SEND_BUTTON_WAIT_INTERVAL_MS = 120;
const CAPTURE_MAIN_EVENT_SOURCE = 'omnistitch_capture_main';
const CAPTURE_CONTENT_EVENT_SOURCE = 'omnistitch_capture_content';
const CAPTURE_EVENT_TYPES = {
  START: 'OMNISTITCH_CAPTURE_START',
  STOP: 'OMNISTITCH_CAPTURE_STOP',
  READY: 'OMNISTITCH_CAPTURE_READY',
  ACK: 'OMNISTITCH_CAPTURE_ACK',
  OBSERVED: 'OMNISTITCH_CAPTURE_OBSERVED',
  CHUNK: 'OMNISTITCH_CAPTURE_CHUNK',
  STREAM_END: 'OMNISTITCH_CAPTURE_STREAM_END',
  FINAL: 'OMNISTITCH_CAPTURE_FINAL',
  ERROR: 'OMNISTITCH_CAPTURE_ERROR'
};
const CONTENT_LOG_PREFIX = '[omnistitch][content]';
const CAPTURE_DUMP_MAX_EVENTS = 10000;

let isRunning = false;
let lastExecutedText = '';
let lastExecutedTaskId = '';
let lastExecutedAt = 0;
const networkCaptureSessions = new Map();
let captureBridgeInitialized = false;

/**
 * Writes a content-script debug log with a stable prefix.
 * @param {...unknown} args
 */
function logInfo(...args) {
  console.log(CONTENT_LOG_PREFIX, ...args);
}

/**
 * Waits for a short duration in async flow.
 * @param {number} ms
 * @returns {Promise<void>}
 */
async function waitMs(ms) {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Sends one runtime message with callback error handling wrapped as Promise.
 * @param {object} payload
 * @returns {Promise<any>}
 */
async function sendRuntimeMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }

      resolve(response);
    });
  });
}

/**
 * Waits for background webRequest tracker to reach idle state for this task.
 * Network status is advisory and never blocks reporting indefinitely.
 * @param {string} taskId
 * @returns {Promise<void>}
 */
async function waitForBackgroundNetworkIdle(taskId) {
  if (!taskId) {
    return;
  }

  try {
    const status = await sendRuntimeMessage({
      action: CAPTURE_NETWORK_WAIT_IDLE_ACTION,
      taskId,
      timeoutMs: CAPTURE_NETWORK_IDLE_WAIT_TIMEOUT_MS
    });
    logInfo('Background network idle gate finished.', {
      taskId,
      status: status || null
    });
  } catch (error) {
    console.error('Failed to wait for background network idle gate:', error);
  }
}

/**
 * Normalizes one mode switch result to stable shape for logging.
 * @param {unknown} result
 * @param {string} fallbackDetail
 * @returns {{applied:boolean,detail:string,preview:string}}
 */
function normalizeModeSwitchResult(result, fallbackDetail) {
  if (!result || typeof result !== 'object') {
    return {
      applied: false,
      detail: fallbackDetail,
      preview: ''
    };
  }

  return {
    applied: result.applied === true,
    detail: typeof result.detail === 'string' && result.detail.trim() ? result.detail.trim() : fallbackDetail,
    preview: typeof result.preview === 'string' ? result.preview.trim() : ''
  };
}


/**
 * Appends one text fragment while removing empty/duplicate fragments.
 * @param {string[]} output
 * @param {unknown} text
 */
function appendUniqueTextFragment(output, text) {
  const sanitized = String(text === null || text === undefined ? '' : text).replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    ''
  );
  const normalized = normalizeCapturedText(sanitized);
  if (!normalized) {
    return;
  }

  const previous = output.length > 0 ? output[output.length - 1] : '';
  if (previous === normalized) {
    return;
  }

  output.push(normalized);
}

/**
 * Removes consecutive duplicate lines from captured response text.
 * @param {string} text
 * @returns {string}
 */
function dedupeConsecutiveLines(text) {
  const normalized = normalizeCapturedText(text);
  if (!normalized) {
    return '';
  }

  const lines = normalized
    .split('\n')
    .map((line) => normalizeCapturedText(line))
    .filter(Boolean);
  if (lines.length === 0) {
    return '';
  }

  const uniqueLines = [];
  let previous = '';
  for (const line of lines) {
    if (line === previous) {
      continue;
    }
    uniqueLines.push(line);
    previous = line;
  }

  return normalizeCapturedText(uniqueLines.join('\n'));
}

/**
 * Parses JSON payloads from SSE-like lines (`data: {...}`).
 * @param {string} rawText
 * @returns {Array<unknown>}
 */
function extractJsonPayloadsFromSse(rawText) {
  const payloads = [];
  const lines = String(rawText || '').split('\n');
  for (const rawLine of lines) {
    let line = String(rawLine || '').trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('data:')) {
      line = line.slice(5).trim();
    }
    if (!line || line === '[DONE]' || line === '[done]') {
      continue;
    }

    if (!line.startsWith('{') && !line.startsWith('[')) {
      continue;
    }

    try {
      payloads.push(JSON.parse(line));
    } catch (_error) {
      // Ignore malformed SSE payloads.
    }
  }

  return payloads;
}

/**
 * Extracts assistant/model text from common chat message payload shape.
 * @param {unknown} message
 * @param {string[]} output
 */
function collectAssistantTextFromMessage(message, output) {
  if (!message || typeof message !== 'object') {
    return;
  }

  const roleCandidates = [];
  const role = typeof message.role === 'string' ? message.role.trim().toLowerCase() : '';
  if (role) {
    roleCandidates.push(role);
  }
  const author = message.author && typeof message.author === 'object' ? message.author : null;
  const authorRole = author && typeof author.role === 'string' ? author.role.trim().toLowerCase() : '';
  if (authorRole) {
    roleCandidates.push(authorRole);
  }

  const hasExplicitRole = roleCandidates.length > 0;
  const isAssistantLike = roleCandidates.some((item) => item === 'assistant' || item === 'model');
  if (hasExplicitRole && !isAssistantLike) {
    return;
  }

  if (typeof message.content === 'string') {
    appendUniqueTextFragment(output, message.content);
  }

  const content = message.content && typeof message.content === 'object' ? message.content : null;
  if (content) {
    if (Array.isArray(content.parts)) {
      for (const part of content.parts) {
        if (typeof part === 'string') {
          appendUniqueTextFragment(output, part);
        } else if (part && typeof part === 'object') {
          appendUniqueTextFragment(output, part.text);
          appendUniqueTextFragment(output, part.content);
        }
      }
    }

    appendUniqueTextFragment(output, content.text);
    appendUniqueTextFragment(output, content.output_text);
  }

  if (Array.isArray(message.blocks)) {
    for (const block of message.blocks) {
      if (!block || typeof block !== 'object') {
        continue;
      }

      const text = block.text && typeof block.text === 'object' ? block.text.content : '';
      appendUniqueTextFragment(output, text);
    }
  }

  if (message.text && typeof message.text === 'object') {
    appendUniqueTextFragment(output, message.text.content);
  }
}

/**
 * Merges JSON payloads from both SSE and framed transport formats.
 * @param {string} rawText
 * @returns {Array<unknown>}
 */
function collectStructuredPayloads(rawText) {
  const payloads = [];
  const ssePayloads = extractJsonPayloadsFromSse(rawText);
  for (const payload of ssePayloads) {
    payloads.push(payload);
  }

  const framedPayloads = extractJsonPayloadsFromRaw(rawText);
  for (const payload of framedPayloads) {
    payloads.push(payload);
  }

  return payloads;
}

/**
 * Runs site-specific mode switching before prompt send.
 * @param {{id:string,name:string,modeSwitcher?:Function}} adapter
 * @returns {Promise<{applied:boolean,detail:string,preview:string}>}
 */
async function runAdapterModeSwitcher(adapter) {
  if (!adapter || typeof adapter.modeSwitcher !== 'function') {
    return {
      applied: true,
      detail: 'no mode switcher configured',
      preview: ''
    };
  }

  try {
    const result = await adapter.modeSwitcher();
    return normalizeModeSwitchResult(result, 'mode switcher returned invalid result');
  } catch (error) {
    return {
      applied: false,
      detail: `mode switcher failed: ${String(error)}`,
      preview: ''
    };
  }
}

/**
 * Reads target adapters from registry scripts loaded before content runtime.
 * @returns {Array<{id:string,name:string,responseExtractor?:Function,modeSwitcher?:Function,hostnames:string[],composerSelectors:string[],sendButtonSelectors:string[]}>}
 */
function getTargetSiteAdapters() {
  const adapters = globalThis.TARGET_SITE_ADAPTERS;
  if (!Array.isArray(adapters)) {
    console.error('Target adapter registry is missing or invalid.');
    return [];
  }

  return adapters;
}

/**
 * Detects current target site adapter from location hostname.
 * @returns {{id:string,name:string,responseExtractor?:Function,modeSwitcher?:Function,hostnames:string[],composerSelectors:string[],sendButtonSelectors:string[]} | null}
 */
function detectCurrentSiteAdapter() {
  const hostname = window.location.hostname.toLowerCase();

  for (const adapter of getTargetSiteAdapters()) {
    const isMatch = adapter.hostnames.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
    if (isMatch) {
      return adapter;
    }
  }

  return null;
}

/**
 * Gets site adapter by id.
 * @param {string|undefined} siteId
 * @returns {{id:string,name:string,responseExtractor?:Function,modeSwitcher?:Function,hostnames:string[],composerSelectors:string[],sendButtonSelectors:string[]} | null}
 */
function getSiteAdapterById(siteId) {
  if (!siteId || typeof siteId !== 'string') {
    return null;
  }

  for (const adapter of getTargetSiteAdapters()) {
    if (adapter.id === siteId) {
      return adapter;
    }
  }

  return null;
}

/**
 * Tracks a just-executed payload for duplicate suppression.
 * @param {string} text
 * @param {string} taskId
 */
function markExecution(text, taskId) {
  lastExecutedText = text;
  lastExecutedTaskId = taskId;
  lastExecutedAt = Date.now();
}

/**
 * Checks whether the payload was already executed recently.
 * @param {string} text
 * @param {string|undefined} taskId
 * @returns {boolean}
 */
function isRecentlyExecuted(text, taskId) {
  if (!text || !lastExecutedText) {
    return false;
  }

  const withinWindow = Date.now() - lastExecutedAt <= DEDUPE_WINDOW_MS;
  if (!withinWindow) {
    return false;
  }

  if (taskId && lastExecutedTaskId && taskId === lastExecutedTaskId) {
    return true;
  }

  return text === lastExecutedText;
}

/**
 * Reads task id from URL query string.
 * @returns {string|null}
 */
function readTaskIdFromUrl() {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const taskId = searchParams.get(TASK_PARAM);
    return taskId || null;
  } catch (error) {
    console.error('Failed to parse task id from URL:', error);
    return null;
  }
}

/**
 * Reads source article URL from URL query string.
 * @returns {string}
 */
function readSourceUrlFromUrl() {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    return (searchParams.get(SOURCE_URL_PARAM) || '').trim();
  } catch (error) {
    console.error('Failed to parse source url from URL:', error);
    return '';
  }
}

/**
 * Reads source article title from URL query string.
 * @returns {string}
 */
function readSourceTitleFromUrl() {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    return (searchParams.get(SOURCE_TITLE_PARAM) || '').trim();
  } catch (error) {
    console.error('Failed to parse source title from URL:', error);
    return '';
  }
}

/**
 * Reads dump switch from URL query/localStorage.
 * URL value has priority to support deterministic test harness enabling.
 * @returns {boolean}
 */
function isCaptureDumpEnabled() {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const queryValue = (searchParams.get(CAPTURE_DUMP_PARAM) || '').trim().toLowerCase();
    if (queryValue) {
      return ['1', 'true', 'yes', 'on'].includes(queryValue);
    }
  } catch (error) {
    console.error('Failed to parse capture dump flag from URL:', error);
  }

  try {
    const localValue = String(window.localStorage.getItem(CAPTURE_DUMP_PARAM) || '')
      .trim()
      .toLowerCase();
    if (localValue) {
      return ['1', 'true', 'yes', 'on'].includes(localValue);
    }
  } catch (error) {
    console.error('Failed to parse capture dump flag from localStorage:', error);
  }

  return false;
}

/**
 * Reads prompt payload from URL query string.
 * @returns {string|null}
 */
function readPromptFromUrl() {
  try {
    const searchParams = new URLSearchParams(window.location.search);
    const prompt = searchParams.get(PROMPT_PARAM);
    logInfo('Read prompt from URL.', {
      source: prompt ? PROMPT_PARAM : null,
      promptLength: prompt ? prompt.length : 0
    });
    return prompt || null;
  } catch (error) {
    console.error('Failed to parse prompt from URL:', error);
    return null;
  }
}

/**
 * Removes prompt/task payload from URL to avoid duplicate sending on refresh.
 */
function clearPromptFromUrl() {
  try {
    const url = new URL(window.location.href);
    const hasCurrent = url.searchParams.has(PROMPT_PARAM);
    const hasTask = url.searchParams.has(TASK_PARAM);
    const hasSourceUrl = url.searchParams.has(SOURCE_URL_PARAM);
    const hasSourceTitle = url.searchParams.has(SOURCE_TITLE_PARAM);
    if (!hasCurrent && !hasTask && !hasSourceUrl && !hasSourceTitle) {
      return;
    }

    url.searchParams.delete(PROMPT_PARAM);
    url.searchParams.delete(TASK_PARAM);
    url.searchParams.delete(SOURCE_URL_PARAM);
    url.searchParams.delete(SOURCE_TITLE_PARAM);
    history.replaceState(null, document.title, url.toString());
    logInfo('Prompt/task params cleared from URL.');
  } catch (error) {
    console.error('Failed to clear prompt params from URL:', error);
  }
}

/**
 * Waits until a site-specific composer element is available.
 * @param {{id:string,name:string,composerSelectors:string[]}} adapter
 * @returns {Promise<HTMLElement>}
 */
function waitForComposer(adapter) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      for (const selector of adapter.composerSelectors) {
        const composer = document.querySelector(selector);
        if (composer instanceof HTMLElement) {
          clearInterval(timer);
          resolve(composer);
          return;
        }
      }

      if (Date.now() - startedAt > MAX_WAIT_MS) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for ${adapter.name} composer`));
      }
    }, POLL_INTERVAL_MS);
  });
}

/**
 * Tries to find send button around composer first, then globally.
 * @param {{sendButtonSelectors:string[]}} adapter
 * @param {HTMLElement} composer
 * @returns {HTMLElement|null}
 */
function findSendButton(adapter, composer) {
  const parentForm = composer.closest('form');
  if (parentForm) {
    for (const selector of adapter.sendButtonSelectors) {
      const localButton = parentForm.querySelector(selector);
      if (localButton instanceof HTMLElement) {
        return localButton;
      }
    }
  }

  for (const selector of adapter.sendButtonSelectors) {
    const globalButton = document.querySelector(selector);
    if (globalButton instanceof HTMLElement) {
      return globalButton;
    }
  }

  return null;
}

/**
 * Checks whether one send button is currently interactable.
 * @param {HTMLElement|null} sendButton
 * @returns {boolean}
 */
function isSendButtonInteractable(sendButton) {
  if (!(sendButton instanceof HTMLElement)) {
    return false;
  }

  if (sendButton instanceof HTMLButtonElement && sendButton.disabled) {
    return false;
  }

  if (sendButton.getAttribute('aria-disabled') === 'true') {
    return false;
  }

  return getComputedStyle(sendButton).pointerEvents !== 'none';
}

/**
 * Waits for an interactable send button near composer, then globally.
 * @param {{id:string,name:string,sendButtonSelectors:string[]}} adapter
 * @param {HTMLElement} composer
 * @returns {Promise<HTMLElement|null>}
 */
async function waitForSendButton(adapter, composer) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < SEND_BUTTON_WAIT_TIMEOUT_MS) {
    const sendButton = findSendButton(adapter, composer);
    if (isSendButtonInteractable(sendButton)) {
      return sendButton;
    }

    await waitMs(SEND_BUTTON_WAIT_INTERVAL_MS);
  }

  return null;
}

/**
 * Fills text into composer and dispatches input event for framework state sync.
 * @param {HTMLElement} composer
 * @param {string} text
 */
function fillComposer(composer, text) {
  composer.focus();

  if (composer instanceof HTMLTextAreaElement) {
    composer.value = text;
    composer.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  composer.textContent = text;
  composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
}

/**
 * Attempts to trigger send action via button click, then keyboard/form fallback.
 * @param {{id:string,name:string,sendButtonSelectors:string[]}} adapter
 * @param {HTMLElement} composer
 * @returns {Promise<{method:string,buttonFound:boolean,clicked:boolean,formSubmitAttempted:boolean}>}
 */
async function triggerSend(adapter, composer) {
  const sendButton = await waitForSendButton(adapter, composer);
  if (sendButton) {
    logInfo('Clicking send button.', { site: adapter.id });
    sendButton.click();
    return {
      method: 'button_click',
      buttonFound: true,
      clicked: true,
      formSubmitAttempted: false
    };
  }

  logInfo('Send button unavailable, fallback to Enter key.', { site: adapter.id });
  composer.focus();
  composer.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      which: 13,
      keyCode: 13,
      bubbles: true,
      cancelable: true
    })
  );

  composer.dispatchEvent(
    new KeyboardEvent('keypress', {
      key: 'Enter',
      code: 'Enter',
      which: 13,
      keyCode: 13,
      bubbles: true,
      cancelable: true
    })
  );

  composer.dispatchEvent(
    new KeyboardEvent('keyup', {
      key: 'Enter',
      code: 'Enter',
      which: 13,
      keyCode: 13,
      bubbles: true,
      cancelable: true
    })
  );

  let formSubmitAttempted = false;
  const form = composer.closest('form');
  if (form instanceof HTMLFormElement) {
    formSubmitAttempted = true;
    if (typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    }
  }

  return {
    method: 'keyboard_fallback',
    buttonFound: false,
    clicked: false,
    formSubmitAttempted
  };
}

/**
 * Resolves task context from runtime payload and URL fallback.
 * @param {{id:string}} adapter
 * @param {{taskId?: string, sourceUrl?: string, sourceTitle?: string}|undefined} incomingTaskContext
 * @returns {{taskId: string, targetSite: string, sourceUrl: string, sourceTitle: string}}
 */
function resolveTaskContext(adapter, incomingTaskContext) {
  const taskIdFromMessage =
    incomingTaskContext && typeof incomingTaskContext.taskId === 'string' && incomingTaskContext.taskId
      ? incomingTaskContext.taskId.trim()
      : '';
  const taskIdFromUrl = readTaskIdFromUrl() || '';
  const taskId = taskIdFromMessage || taskIdFromUrl || `${Date.now()}_${adapter.id}`;
  const sourceUrl =
    incomingTaskContext && typeof incomingTaskContext.sourceUrl === 'string' && incomingTaskContext.sourceUrl
      ? incomingTaskContext.sourceUrl
      : '';
  const sourceTitle =
    incomingTaskContext && typeof incomingTaskContext.sourceTitle === 'string' && incomingTaskContext.sourceTitle
      ? incomingTaskContext.sourceTitle
      : '';

  return {
    taskId,
    targetSite: adapter.id,
    sourceUrl,
    sourceTitle
  };
}

/**
 * Normalizes captured response text for stable comparison and syncing.
 * @param {string} text
 * @returns {string}
 */
function normalizeCapturedText(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Removes leading prompt echo from captured assistant response text.
 * Keeps the original response when cleanup result is too short.
 * @param {string} responseText
 * @param {string} promptText
 * @returns {string}
 */
function stripPromptEcho(responseText, promptText) {
  const normalizedResponse = normalizeCapturedText(responseText);
  if (!normalizedResponse) {
    return '';
  }

  const normalizedPrompt = normalizeCapturedText(promptText);
  if (!normalizedPrompt) {
    return normalizedResponse;
  }

  const normalizedPromptLines = normalizedPrompt
    .split('\n')
    .map((line) => normalizeCapturedText(line))
    .filter(Boolean);
  if (normalizedPromptLines.length === 0) {
    return normalizedResponse;
  }

  let cleaned = normalizedResponse;
  if (cleaned.startsWith(normalizedPrompt)) {
    cleaned = normalizeCapturedText(cleaned.slice(normalizedPrompt.length));
  }

  const responseLines = cleaned
    .split('\n')
    .map((line) => normalizeCapturedText(line))
    .filter(Boolean);
  while (responseLines.length > 0 && normalizedPromptLines.includes(responseLines[0])) {
    responseLines.shift();
  }

  cleaned = normalizeCapturedText(responseLines.join('\n'));
  return cleaned.length >= MIN_RESPONSE_TEXT_LENGTH ? cleaned : normalizedResponse;
}

/**
 * Removes source URL echoes from assistant response text for stable reporting.
 * @param {string} responseText
 * @param {string} sourceUrl
 * @returns {string}
 */
function stripSourceUrlEcho(responseText, sourceUrl) {
  const normalizedResponse = normalizeCapturedText(responseText);
  const normalizedSourceUrl = normalizeCapturedText(sourceUrl);
  if (!normalizedResponse || !normalizedSourceUrl) {
    return normalizedResponse;
  }

  const withoutRawUrl = normalizeCapturedText(
    normalizedResponse.split(normalizedSourceUrl).join('')
  );
  const cleanedLines = withoutRawUrl
    .split('\n')
    .map((line) => normalizeCapturedText(line))
    .filter((line) => line && line !== normalizedSourceUrl && !line.includes(normalizedSourceUrl));
  return normalizeCapturedText(cleanedLines.join('\n'));
}

const INTERMEDIATE_STATUS_PATTERNS = [
  /^思考中(?:\.\.\.|…)?$/i,
  /^正在思考(?:\.\.\.|…)?$/i,
  /^深度思考中(?:\.\.\.|…)?$/i,
  /^搜索网页中(?:\.\.\.|…)?$/i,
  /^正在搜索(?:网页|网络)?(?:\.\.\.|…)?$/i,
  /^联网搜索中(?:\.\.\.|…)?$/i,
  /^thinking(?:\.\.\.)?$/i,
  /^searching(?: the)? web(?:\.\.\.)?$/i,
  /^analyzing(?:\.\.\.)?$/i,
  /^processing(?:\.\.\.)?$/i
];

/**
 * Checks whether one line is likely a transient model status marker.
 * @param {string} line
 * @returns {boolean}
 */
function isIntermediateStatusLine(line) {
  const normalizedLine = normalizeCapturedText(line);
  if (!normalizedLine) {
    return true;
  }

  if (normalizedLine.length > 80) {
    return false;
  }

  return INTERMEDIATE_STATUS_PATTERNS.some((pattern) => pattern.test(normalizedLine));
}

/**
 * Removes transient status-only lines (thinking/searching) from captured text.
 * @param {string} text
 * @returns {string}
 */
function removeIntermediateStatusLines(text) {
  const normalized = normalizeCapturedText(text);
  if (!normalized) {
    return '';
  }

  const lines = normalized.split('\n').map((line) => normalizeCapturedText(line));
  const filteredLines = lines.filter((line) => line && !isIntermediateStatusLine(line));
  if (filteredLines.length === 0) {
    return '';
  }

  return normalizeCapturedText(filteredLines.join('\n'));
}

/**
 * Builds a short one-line preview for debug logs.
 * @param {string} text
 * @returns {string}
 */
function buildTextPreview(text) {
  const normalized = normalizeCapturedText(text).replace(/\n/g, '\\n');
  if (normalized.length <= RESPONSE_LOG_PREVIEW_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, RESPONSE_LOG_PREVIEW_LENGTH)}...`;
}

/**
 * Prints one explicit response preview line for easier console filtering.
 * @param {string} stage
 * @param {string} text
 */
function logResponsePreview(stage, text) {
  const preview = buildTextPreview(text);
  console.log(CONTENT_LOG_PREFIX, `[response_preview_100][${stage}]`, preview);
}

const CAPTURE_TEXT_FIELD_HINTS = [
  'content',
  'text',
  'delta',
  'answer',
  'response',
  'message',
  'completion',
  'output'
];
const CAPTURE_TEXT_IGNORE_HINTS = ['role', 'id', 'model', 'type', 'index', 'finish_reason', 'token', 'created'];

/**
 * Checks whether one JSON field path is likely to contain assistant text.
 * @param {string} path
 * @returns {boolean}
 */
function shouldCollectJsonTextField(path) {
  const lowerPath = path.toLowerCase();
  if (!CAPTURE_TEXT_FIELD_HINTS.some((hint) => lowerPath.includes(hint))) {
    return false;
  }

  return !CAPTURE_TEXT_IGNORE_HINTS.some((hint) => lowerPath.endsWith(hint) || lowerPath.includes(`.${hint}.`));
}

/**
 * Collects likely assistant text fragments from parsed JSON payload.
 * @param {unknown} value
 * @param {string} path
 * @param {string[]} output
 * @param {number} depth
 */
function collectJsonTextFragments(value, path, output, depth = 0) {
  if (depth > 10 || value === null || value === undefined) {
    return;
  }

  if (typeof value === 'string') {
    if (path && shouldCollectJsonTextField(path) && value.trim()) {
      output.push(value);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      collectJsonTextFragments(value[index], path ? `${path}[${index}]` : `[${index}]`, output, depth + 1);
    }
    return;
  }

  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      collectJsonTextFragments(child, path ? `${path}.${key}` : key, output, depth + 1);
    }
  }
}

/**
 * Extracts valid JSON payload blocks from mixed raw stream text.
 * This is used for framed protocols such as connect+json where each frame may
 * carry binary prefix bytes before JSON payload.
 * @param {string} raw
 * @returns {Array<unknown>}
 */
function extractJsonPayloadsFromRaw(raw) {
  const payloads = [];
  const text = String(raw || '');
  if (!text) {
    return payloads;
  }

  let startIndex = -1;
  let stack = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (startIndex === -1) {
      if (char === '{') {
        startIndex = index;
        stack = ['}'];
        inString = false;
        escaped = false;
      } else if (char === '[') {
        startIndex = index;
        stack = [']'];
        inString = false;
        escaped = false;
      }
      continue;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      stack.push('}');
      continue;
    }
    if (char === '[') {
      stack.push(']');
      continue;
    }
    if (stack.length > 0 && char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) {
        const candidate = text.slice(startIndex, index + 1);
        startIndex = -1;
        if (!candidate || candidate.length > 2 * 1024 * 1024) {
          continue;
        }

        try {
          payloads.push(JSON.parse(candidate));
        } catch (_error) {
          // Ignore non-JSON candidate fragments.
        }
      }
    }
  }

  return payloads;
}

/**
 * Extracts readable response text from raw network capture stream.
 * @param {string} rawText
 * @returns {string}
 */
function extractReadableTextFromCapture(rawText) {
  const raw = String(rawText || '').replace(/\r/g, '');
  if (!raw.trim()) {
    return '';
  }

  const fragments = [];
  const lines = raw.split('\n');
  for (const rawLine of lines) {
    let line = rawLine.trim();
    if (!line) {
      continue;
    }

    if (line.startsWith('data:')) {
      line = line.slice(5).trim();
    }
    if (!line || line === '[DONE]' || line === '[done]') {
      continue;
    }

    if (line.startsWith('{') || line.startsWith('[')) {
      try {
        const parsed = JSON.parse(line);
        const chunkTexts = [];
        collectJsonTextFragments(parsed, '', chunkTexts);
        if (chunkTexts.length > 0) {
          fragments.push(chunkTexts.join(''));
        }
      } catch (_error) {
        // Ignore malformed JSON lines, final fallback will use raw stream text.
      }
      continue;
    }

    fragments.push(line);
  }

  const structuredText = removeIntermediateStatusLines(fragments.join('\n'));
  if (structuredText.length >= MIN_RESPONSE_TEXT_LENGTH) {
    return structuredText;
  }

  const regexExtractedFragments = [];
  const jsonTextFieldPattern =
    /"(?:content|text|delta|answer|response|completion|output|output_text|message)"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let match = jsonTextFieldPattern.exec(raw);
  while (match) {
    try {
      const decoded = JSON.parse(`"${match[1]}"`);
      if (decoded && String(decoded).trim()) {
        regexExtractedFragments.push(String(decoded));
      }
    } catch (_error) {
      // Ignore malformed escaped fragments.
    }
    match = jsonTextFieldPattern.exec(raw);
  }

  const regexExtractedText = removeIntermediateStatusLines(regexExtractedFragments.join('\n'));
  if (regexExtractedText.length >= MIN_RESPONSE_TEXT_LENGTH) {
    return regexExtractedText;
  }

  const mixedPayloads = extractJsonPayloadsFromRaw(raw);
  if (mixedPayloads.length > 0) {
    const mixedFragments = [];
    for (const payload of mixedPayloads) {
      collectJsonTextFragments(payload, '', mixedFragments);
    }
    const mixedExtractedText = removeIntermediateStatusLines(mixedFragments.join('\n'));
    if (mixedExtractedText.length >= MIN_RESPONSE_TEXT_LENGTH) {
      return mixedExtractedText;
    }
  }

  return removeIntermediateStatusLines(raw);
}

/**
 * Extracts response text with per-site extractor first and generic fallback.
 * @param {string} targetSite
 * @param {string} rawText
 * @returns {{responseText:string,siteExtractedLength:number,genericExtractedLength:number,usedSiteExtractor:boolean}}
 */
function extractResponseTextBySite(targetSite, rawText) {
  const adapter = getSiteAdapterById(targetSite);
  let siteExtractedText = '';
  if (adapter && typeof adapter.responseExtractor === 'function') {
    try {
      siteExtractedText = dedupeConsecutiveLines(adapter.responseExtractor(rawText));
    } catch (error) {
      console.error('Site response extractor failed, fallback to generic extractor:', {
        targetSite,
        error: String(error)
      });
    }
  }

  const genericExtractedText = dedupeConsecutiveLines(extractReadableTextFromCapture(rawText));
  if (siteExtractedText.length >= MIN_RESPONSE_TEXT_LENGTH) {
    return {
      responseText: siteExtractedText,
      siteExtractedLength: siteExtractedText.length,
      genericExtractedLength: genericExtractedText.length,
      usedSiteExtractor: true
    };
  }

  if (siteExtractedText.length > 0) {
    return {
      responseText: siteExtractedText,
      siteExtractedLength: siteExtractedText.length,
      genericExtractedLength: genericExtractedText.length,
      usedSiteExtractor: true
    };
  }

  return {
    responseText: genericExtractedText,
    siteExtractedLength: siteExtractedText.length,
    genericExtractedLength: genericExtractedText.length,
    usedSiteExtractor: false
  };
}

/**
 * Posts one network-capture control event to page main world.
 * @param {string} type
 * @param {Record<string, unknown>} payload
 */
function postCaptureControlEvent(type, payload) {
  window.postMessage(
    {
      source: CAPTURE_CONTENT_EVENT_SOURCE,
      type,
      payload
    },
    '*'
  );
}

/**
 * Appends one capture dump event to session for offline rule analysis.
 * @param {{
 *   captureDumpEnabled:boolean,
 *   captureDumpEvents:Array<Record<string, unknown>>,
 *   captureDumpDropped:number
 * }} session
 * @param {Record<string, unknown>} event
 */
function appendCaptureDumpEvent(session, event) {
  if (!session.captureDumpEnabled) {
    return;
  }

  if (session.captureDumpEvents.length >= CAPTURE_DUMP_MAX_EVENTS) {
    session.captureDumpDropped += 1;
    return;
  }

  session.captureDumpEvents.push(event);
}

/**
 * Builds serialized capture dump blob for webhook raw payload.
 * @param {{
 *   taskId:string,
 *   targetSite:string,
 *   startedAt:number,
 *   captureDumpEnabled:boolean,
 *   captureDumpEvents:Array<Record<string, unknown>>,
 *   captureDumpDropped:number
 * }} session
 * @param {{reason?: string, captureChannel?: string, captureSourceUrl?: string, chunkCount?: number, durationMs?: number}|undefined} finalPayload
 * @returns {string}
 */
function buildCaptureDump(session, finalPayload) {
  if (!session.captureDumpEnabled) {
    return '';
  }

  try {
    return JSON.stringify({
      taskId: session.taskId,
      targetSite: session.targetSite,
      startedAt: new Date(session.startedAt).toISOString(),
      finalizedAt: new Date().toISOString(),
      finalReason: finalPayload?.reason || '',
      finalCaptureChannel: finalPayload?.captureChannel || '',
      finalCaptureSourceUrl: finalPayload?.captureSourceUrl || '',
      finalChunkCount:
        Number.isFinite(finalPayload?.chunkCount) && finalPayload?.chunkCount >= 0
          ? Number(finalPayload.chunkCount)
          : null,
      finalDurationMs:
        Number.isFinite(finalPayload?.durationMs) && finalPayload?.durationMs >= 0
          ? Number(finalPayload.durationMs)
          : null,
      droppedEventCount: session.captureDumpDropped,
      eventCount: session.captureDumpEvents.length,
      events: session.captureDumpEvents
    });
  } catch (error) {
    console.error('Failed to serialize capture dump payload:', error);
    return '';
  }
}

/**
 * Builds fallback capture metadata from in-memory session state.
 * @param {{
 *   captureChannel:string,
 *   captureSourceUrl:string,
 *   chunkCount:number,
 *   startedAt:number
 * }} session
 * @returns {{captureMethod:string,captureChannel:string,captureSourceUrl:string,captureChunkCount:number,captureDurationMs:number}}
 */
function buildFallbackCaptureMeta(session) {
  return {
    captureMethod: 'network-intercept',
    captureChannel: session.captureChannel || 'unknown',
    captureSourceUrl: session.captureSourceUrl || '',
    captureChunkCount: session.chunkCount,
    captureDurationMs: Date.now() - session.startedAt
  };
}

/**
 * Clears all timers for one network capture session.
 * @param {{ackTimer:number|null,hardTimer:number|null,dumpFlushTimer:number|null}} session
 */
function clearNetworkCaptureSessionTimers(session) {
  if (session.ackTimer !== null) {
    clearTimeout(session.ackTimer);
    session.ackTimer = null;
  }

  if (session.hardTimer !== null) {
    clearTimeout(session.hardTimer);
    session.hardTimer = null;
  }

  if (session.dumpFlushTimer !== null) {
    clearTimeout(session.dumpFlushTimer);
    session.dumpFlushTimer = null;
  }
}

/**
 * Cleans one network capture session and notifies main world to stop if needed.
 * @param {string} taskId
 * @param {string} reason
 */
function cleanupNetworkCaptureSession(taskId, reason) {
  const session = networkCaptureSessions.get(taskId);
  if (!session) {
    return;
  }

  clearNetworkCaptureSessionTimers(session);
  networkCaptureSessions.delete(taskId);

  try {
    postCaptureControlEvent(CAPTURE_EVENT_TYPES.STOP, { taskId, reason });
  } catch (error) {
    console.error('Failed to post capture stop event:', error);
  }

  sendRuntimeMessage({
    action: CAPTURE_NETWORK_TRACK_STOP_ACTION,
    taskId,
    reason: typeof reason === 'string' ? reason : ''
  }).catch((error) => {
    console.error('Failed to stop background network tracking session:', error);
  });
}

/**
 * Rejects one network capture session with contextual diagnostics.
 * @param {string} taskId
 * @param {Error|string} error
 * @param {Record<string, unknown>|undefined} extra
 */
function failNetworkCaptureSession(taskId, error, extra) {
  const session = networkCaptureSessions.get(taskId);
  if (!session || session.completed) {
    return;
  }

  appendCaptureDumpEvent(session, {
    eventType: 'content_fail',
    timestamp: Date.now(),
    error: String(error),
    extra: extra || {}
  });

  session.completed = true;
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  const captureDump = buildCaptureDump(session, undefined);
  const fallbackResponseText = normalizeCapturedText(session.chunks.join('\n'));
  const fallbackCaptureMeta = buildFallbackCaptureMeta(session);
  normalizedError.captureDump = captureDump;
  normalizedError.fallbackResponseText = fallbackResponseText || '[capture-failed-debug]';
  normalizedError.fallbackCaptureMeta = fallbackCaptureMeta;
  console.error('Network capture session failed.', {
    taskId,
    targetSite: session.targetSite,
    acked: session.acked,
    chunkCount: session.chunkCount,
    captureDumpEnabled: session.captureDumpEnabled,
    captureDumpLength: captureDump.length,
    captureDumpEventCount: session.captureDumpEvents.length,
    captureDumpDropped: session.captureDumpDropped,
    error: normalizedError.message,
    ...(extra || {})
  });

  session.reject(normalizedError);
  cleanupNetworkCaptureSession(taskId, 'failed');
}

/**
 * Finalizes one successful network capture session and resolves normalized text.
 * @param {string} taskId
 * @param {{reason?: string, captureChannel?: string, captureSourceUrl?: string, chunkCount?: number, durationMs?: number}|undefined} finalPayload
 */
async function finalizeNetworkCaptureSession(taskId, finalPayload) {
  const session = networkCaptureSessions.get(taskId);
  if (!session || session.completed || session.finalizing) {
    return;
  }
  session.finalizing = true;

  appendCaptureDumpEvent(session, {
    eventType: 'content_final',
    timestamp: Date.now(),
    reason: finalPayload?.reason || '',
    captureChannel: finalPayload?.captureChannel || '',
    captureSourceUrl: finalPayload?.captureSourceUrl || '',
    chunkCount: Number(finalPayload?.chunkCount),
    durationMs: Number(finalPayload?.durationMs)
  });

  await waitForBackgroundNetworkIdle(taskId);
  if (session.completed || !networkCaptureSessions.has(taskId)) {
    return;
  }

  const rawCombinedText = normalizeCapturedText(session.chunks.join('\n'));
  const extracted = extractResponseTextBySite(session.targetSite, session.chunks.join(''));
  let responseText = extracted.responseText;
  if (responseText.length < MIN_RESPONSE_TEXT_LENGTH) {
    if (extracted.usedSiteExtractor && responseText.length > 0) {
      logInfo('Accepted short response from site-specific extractor.', {
        taskId,
        targetSite: session.targetSite,
        responseLength: responseText.length
      });
    } else if (session.captureDumpEnabled) {
      responseText = rawCombinedText || '[capture-dump-only]';
    } else {
      failNetworkCaptureSession(taskId, 'Captured response text is too short.', {
        reason: finalPayload?.reason || null,
        responseLength: responseText.length
      });
      return;
    }
  }

  session.completed = true;
  const captureDump = buildCaptureDump(session, finalPayload);
  const captureMeta = {
    captureMethod: 'network-intercept',
    captureChannel: finalPayload?.captureChannel || session.captureChannel || 'unknown',
    captureSourceUrl: finalPayload?.captureSourceUrl || session.captureSourceUrl || '',
    captureChunkCount:
      Number.isFinite(finalPayload?.chunkCount) && finalPayload?.chunkCount > 0
        ? Number(finalPayload.chunkCount)
        : session.chunkCount,
    captureDurationMs:
      Number.isFinite(finalPayload?.durationMs) && finalPayload?.durationMs > 0
        ? Number(finalPayload.durationMs)
        : Date.now() - session.startedAt
  };

  logInfo('Network capture finalized.', {
    taskId,
    targetSite: session.targetSite,
    reason: finalPayload?.reason || null,
    chunkCount: captureMeta.captureChunkCount,
    responseLength: responseText.length,
    siteExtractedLength: extracted.siteExtractedLength,
    genericExtractedLength: extracted.genericExtractedLength,
    captureChannel: captureMeta.captureChannel,
    captureSourceUrl: captureMeta.captureSourceUrl || null,
    durationMs: captureMeta.captureDurationMs,
    captureDumpEnabled: session.captureDumpEnabled,
    captureDumpLength: captureDump.length,
    captureDumpEventCount: session.captureDumpEvents.length,
    captureDumpDropped: session.captureDumpDropped
  });
  logResponsePreview('stabilized', responseText);

  session.resolve({
    responseText,
    captureMeta,
    captureDump
  });
  cleanupNetworkCaptureSession(taskId, 'finalized');
}

/**
 * Handles one postMessage event from main world response-capture script.
 * @param {MessageEvent} event
 */
function handleMainCaptureEvent(event) {
  if (event.source !== window) {
    return;
  }

  const data = event.data;
  if (!data || typeof data !== 'object' || data.source !== CAPTURE_MAIN_EVENT_SOURCE) {
    return;
  }

  const type = typeof data.type === 'string' ? data.type : '';
  const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};
  const taskId = typeof payload.taskId === 'string' ? payload.taskId : '';

  if (type === CAPTURE_EVENT_TYPES.READY) {
    logInfo('Main-world capture script is ready.');
    return;
  }

  if (!taskId) {
    return;
  }

  const session = networkCaptureSessions.get(taskId);
  if (!session) {
    return;
  }

  if (type === CAPTURE_EVENT_TYPES.ACK) {
    session.acked = true;
    if (session.ackTimer !== null) {
      clearTimeout(session.ackTimer);
      session.ackTimer = null;
    }

    appendCaptureDumpEvent(session, {
      eventType: 'main_ack',
      timestamp: Date.now(),
      dumpAllObserved: payload.dumpAllObserved === true
    });
    logInfo('Network capture session acknowledged.', {
      taskId,
      targetSite: session.targetSite,
      dumpAllObserved: payload.dumpAllObserved === true
    });
    return;
  }

  if (type === CAPTURE_EVENT_TYPES.OBSERVED) {
    const observedChunk = typeof payload.chunk === 'string' ? payload.chunk : '';
    const observedPreview = buildTextPreview(observedChunk).slice(0, 100);
    appendCaptureDumpEvent(session, {
      eventType: 'main_observed',
      timestamp: Number(payload.timestamp) || Date.now(),
      observedType: typeof payload.observedType === 'string' ? payload.observedType : '',
      captureChannel: typeof payload.captureChannel === 'string' ? payload.captureChannel : '',
      captureSourceUrl: typeof payload.captureSourceUrl === 'string' ? payload.captureSourceUrl : '',
      chunk: typeof payload.chunk === 'string' ? payload.chunk : '',
      chunkLength: Number(payload.chunkLength) || 0,
      isValidUrl: payload.isValidUrl === true,
      isAllowedHost: payload.isAllowedHost === true,
      hasKeyword: payload.hasKeyword === true,
      passedFilter: payload.passedFilter === true
    });
    logInfo(
      `Network observed data received taskId=${taskId} target=${session.targetSite} type=${
        typeof payload.observedType === 'string' ? payload.observedType : ''
      } channel=${typeof payload.captureChannel === 'string' ? payload.captureChannel : ''} passedFilter=${
        payload.passedFilter === true
      } isAllowedHost=${payload.isAllowedHost === true} hasKeyword=${payload.hasKeyword === true} chunkLength=${
        Number(payload.chunkLength) || observedChunk.length || 0
      } sourceUrl=${typeof payload.captureSourceUrl === 'string' ? payload.captureSourceUrl : ''} preview=${JSON.stringify(
        observedPreview
      )}`
    );
    return;
  }

  if (type === CAPTURE_EVENT_TYPES.CHUNK) {
    const chunk = typeof payload.chunk === 'string' ? payload.chunk : '';
    if (!chunk) {
      return;
    }

    session.chunks.push(chunk);
    session.chunkCount += 1;
    if (typeof payload.captureChannel === 'string' && payload.captureChannel) {
      session.captureChannel = payload.captureChannel;
    }
    if (typeof payload.captureSourceUrl === 'string' && payload.captureSourceUrl) {
      session.captureSourceUrl = payload.captureSourceUrl;
    }
    appendCaptureDumpEvent(session, {
      eventType: 'main_chunk',
      timestamp: Number(payload.timestamp) || Date.now(),
      captureChannel: typeof payload.captureChannel === 'string' ? payload.captureChannel : '',
      captureSourceUrl: typeof payload.captureSourceUrl === 'string' ? payload.captureSourceUrl : '',
      chunk
    });

    if (session.chunkCount === 1 || session.chunkCount % 20 === 0) {
      logInfo('Network capture chunk received.', {
        taskId,
        targetSite: session.targetSite,
        chunkCount: session.chunkCount,
        chunkLength: chunk.length,
        captureChannel: session.captureChannel || null
      });
      logResponsePreview('candidate_detected', chunk);
    }
    return;
  }

  if (type === CAPTURE_EVENT_TYPES.STREAM_END) {
    appendCaptureDumpEvent(session, {
      eventType: 'main_stream_end',
      timestamp: Number(payload.timestamp) || Date.now(),
      captureChannel: typeof payload.captureChannel === 'string' ? payload.captureChannel : '',
      captureSourceUrl: typeof payload.captureSourceUrl === 'string' ? payload.captureSourceUrl : ''
    });
    logInfo('Network capture stream-end signal received.', {
      taskId,
      targetSite: session.targetSite,
      captureChannel: typeof payload.captureChannel === 'string' ? payload.captureChannel : null,
      captureSourceUrl: typeof payload.captureSourceUrl === 'string' ? payload.captureSourceUrl : null
    });
    return;
  }

  if (type === CAPTURE_EVENT_TYPES.ERROR) {
    appendCaptureDumpEvent(session, {
      eventType: 'main_error',
      timestamp: Date.now(),
      captureChannel: typeof payload.captureChannel === 'string' ? payload.captureChannel : '',
      captureSourceUrl: typeof payload.captureSourceUrl === 'string' ? payload.captureSourceUrl : '',
      error: typeof payload.error === 'string' ? payload.error : ''
    });
    const errorMessage =
      typeof payload.error === 'string' && payload.error.trim() ? payload.error.trim() : 'Unknown capture error';
    failNetworkCaptureSession(taskId, errorMessage, {
      captureChannel: typeof payload.captureChannel === 'string' ? payload.captureChannel : null,
      captureSourceUrl: typeof payload.captureSourceUrl === 'string' ? payload.captureSourceUrl : null
    });
    return;
  }

  if (type === CAPTURE_EVENT_TYPES.FINAL) {
    finalizeNetworkCaptureSession(taskId, {
      reason: typeof payload.reason === 'string' ? payload.reason : '',
      captureChannel: typeof payload.captureChannel === 'string' ? payload.captureChannel : '',
      captureSourceUrl: typeof payload.captureSourceUrl === 'string' ? payload.captureSourceUrl : '',
      chunkCount: Number(payload.captureChunkCount),
      durationMs: Number(payload.captureDurationMs)
    }).catch((error) => {
      failNetworkCaptureSession(taskId, error instanceof Error ? error : String(error), {
        phase: 'finalize_after_main_final'
      });
    });
  }
}

/**
 * Initializes one-time bridge listener between content world and main world.
 */
function ensureCaptureBridgeInitialized() {
  if (captureBridgeInitialized) {
    return;
  }

  captureBridgeInitialized = true;
  window.addEventListener('message', handleMainCaptureEvent);
  logInfo('Network capture bridge initialized.');
}

/**
 * Starts one network capture session for the task and returns final result promise.
 * @param {{taskId: string, targetSite: string}} taskContext
 * @returns {Promise<{responseText: string, captureMeta: {captureMethod:string,captureChannel:string,captureSourceUrl:string,captureChunkCount:number,captureDurationMs:number}, captureDump: string}>}
 */
function startNetworkCaptureSession(taskContext) {
  ensureCaptureBridgeInitialized();

  const taskId = taskContext.taskId;
  if (!taskId) {
    throw new Error('Cannot start network capture without taskId.');
  }

  if (networkCaptureSessions.has(taskId)) {
    failNetworkCaptureSession(taskId, 'Duplicate capture session start requested.');
  }

  return new Promise((resolve, reject) => {
    const captureDumpEnabled = isCaptureDumpEnabled();
    const session = {
      taskId,
      targetSite: taskContext.targetSite,
      startedAt: Date.now(),
      chunks: [],
      chunkCount: 0,
      captureChannel: '',
      captureSourceUrl: '',
      captureDumpEnabled,
      captureDumpEvents: [],
      captureDumpDropped: 0,
      acked: false,
      completed: false,
      finalizing: false,
      ackTimer: null,
      hardTimer: null,
      dumpFlushTimer: null,
      resolve,
      reject
    };

    session.ackTimer = setTimeout(() => {
      failNetworkCaptureSession(taskId, 'Timed out waiting capture ACK.', {
        timeoutMs: CAPTURE_ACK_TIMEOUT_MS
      });
    }, CAPTURE_ACK_TIMEOUT_MS);

    session.hardTimer = setTimeout(() => {
      failNetworkCaptureSession(taskId, 'Timed out waiting capture FINAL.', {
        timeoutMs: CAPTURE_HARD_TIMEOUT_MS
      });
    }, CAPTURE_HARD_TIMEOUT_MS);

    if (captureDumpEnabled) {
      session.dumpFlushTimer = setTimeout(() => {
        failNetworkCaptureSession(taskId, 'Capture dump window elapsed.', {
          timeoutMs: CAPTURE_DUMP_FLUSH_TIMEOUT_MS
        });
      }, CAPTURE_DUMP_FLUSH_TIMEOUT_MS);
    }

    networkCaptureSessions.set(taskId, session);
    appendCaptureDumpEvent(session, {
      eventType: 'content_start',
      timestamp: Date.now(),
      targetSite: session.targetSite,
      captureDumpEnabled
    });
    logInfo('Network capture session started.', {
      taskId,
      targetSite: taskContext.targetSite,
      captureDumpEnabled,
      ackTimeoutMs: CAPTURE_ACK_TIMEOUT_MS,
      hardTimeoutMs: CAPTURE_HARD_TIMEOUT_MS,
      dumpFlushTimeoutMs: captureDumpEnabled ? CAPTURE_DUMP_FLUSH_TIMEOUT_MS : 0
    });

    sendRuntimeMessage({
      action: CAPTURE_NETWORK_TRACK_START_ACTION,
      taskId: session.taskId,
      targetSite: session.targetSite,
      startedAt: session.startedAt
    })
      .then((result) => {
        logInfo('Background network tracking session started.', {
          taskId: session.taskId,
          targetSite: session.targetSite,
          result: result || null
        });
      })
      .catch((error) => {
        console.error('Failed to start background network tracking session:', error);
      });

    try {
      postCaptureControlEvent(CAPTURE_EVENT_TYPES.START, {
        taskId: session.taskId,
        targetSite: session.targetSite,
        dumpAllObserved: captureDumpEnabled,
        startedAt: session.startedAt
      });
    } catch (error) {
      failNetworkCaptureSession(taskId, error instanceof Error ? error : String(error), {
        phase: 'post_start_event'
      });
    }
  });
}

/**
 * Reports one captured assistant response back to background for provider syncing.
 * @param {{taskId: string, targetSite: string, sourceUrl: string, sourceTitle: string}} taskContext
 * @param {string} responseText
 * @param {{captureMethod:string,captureChannel:string,captureSourceUrl:string,captureChunkCount:number,captureDurationMs:number}} captureMeta
 */
async function reportAssistantResponse(taskContext, responseText, captureMeta) {
  if (!taskContext.taskId || !responseText) {
    logInfo('Skip assistant response report due to invalid payload.', {
      taskId: taskContext.taskId || null,
      hasResponse: Boolean(responseText)
    });
    return;
  }

  const payload = {
    action: AI_RESPONSE_REPORT_ACTION,
    taskId: taskContext.taskId,
    targetSite: taskContext.targetSite,
    sourceUrl: taskContext.sourceUrl,
    sourceTitle: taskContext.sourceTitle,
    aiResponse: responseText,
    capturedAt: new Date().toISOString(),
    captureMethod: captureMeta.captureMethod,
    captureChannel: captureMeta.captureChannel,
    captureSourceUrl: captureMeta.captureSourceUrl,
    captureChunkCount: captureMeta.captureChunkCount,
    captureDurationMs: captureMeta.captureDurationMs
  };

  logInfo('Reporting assistant response to background.', {
    taskId: taskContext.taskId,
    targetSite: taskContext.targetSite,
    sourceUrl: taskContext.sourceUrl || null,
    sourceTitle: taskContext.sourceTitle || null,
    responseLength: responseText.length,
    responsePreview: buildTextPreview(responseText),
    captureMethod: captureMeta.captureMethod,
    captureChannel: captureMeta.captureChannel,
    captureSourceUrl: captureMeta.captureSourceUrl || null,
    captureChunkCount: captureMeta.captureChunkCount,
    captureDurationMs: captureMeta.captureDurationMs
  });
  logResponsePreview('reporting', responseText);

  const reportResult = await sendRuntimeMessage(payload);
  logInfo('Assistant response report acknowledged by background.', {
    taskId: taskContext.taskId,
    targetSite: taskContext.targetSite,
    result: reportResult || null
  });
}

/**
 * Runs composer fill + send flow from provided text.
 * @param {string} finalText
 * @param {string|undefined} preferredSiteId
 * @param {{taskId?: string, sourceUrl?: string, sourceTitle?: string}|undefined} incomingTaskContext
 */
async function runWithText(finalText, preferredSiteId, incomingTaskContext) {
  if (isRunning) {
    logInfo('Auto-send already in progress, skip new payload.');
    return;
  }

  let taskContext = null;
  isRunning = true;
  try {
    if (!finalText || typeof finalText !== 'string') {
      console.error('Invalid finalText payload.');
      return;
    }

    const adapter = getSiteAdapterById(preferredSiteId) || detectCurrentSiteAdapter();
    if (!adapter) {
      console.error('No site adapter matched for current page:', window.location.hostname);
      return;
    }

    taskContext = resolveTaskContext(adapter, incomingTaskContext);
    if (isRecentlyExecuted(finalText, taskContext.taskId)) {
      logInfo('Skip duplicate payload in dedupe window.', {
        textLength: finalText.length,
        taskId: taskContext.taskId
      });
      return;
    }

    let capturePromise = null;
    try {
      capturePromise = startNetworkCaptureSession(taskContext);
    } catch (error) {
      console.error('Failed to start network capture session:', error);
    }

    markExecution(finalText, taskContext.taskId);
    const composer = await waitForComposer(adapter);
    const modeSwitchResult = await runAdapterModeSwitcher(adapter);
    logInfo('Site mode switcher completed.', {
      site: adapter.id,
      taskId: taskContext.taskId,
      applied: modeSwitchResult.applied,
      detail: modeSwitchResult.detail,
      preview: modeSwitchResult.preview
    });

    logInfo('Composer ready, writing prompt.', {
      site: adapter.id,
      taskId: taskContext.taskId,
      textLength: finalText.length
    });

    fillComposer(composer, finalText);

    // Give UI state a short time to enable send action.
    await waitMs(500);
    const sendResult = await triggerSend(adapter, composer);
    logInfo('Trigger send finished.', {
      site: adapter.id,
      taskId: taskContext.taskId,
      method: sendResult.method,
      buttonFound: sendResult.buttonFound,
      clicked: sendResult.clicked,
      formSubmitAttempted: sendResult.formSubmitAttempted
    });

    if (!capturePromise) {
      console.error('Network capture session unavailable, skip response reporting.', {
        site: adapter.id,
        taskId: taskContext.taskId
      });
      return;
    }

    try {
      const captureResult = await capturePromise;
      const promptStrippedResponseText = stripPromptEcho(captureResult.responseText, finalText);
      const sanitizedResponseText = stripSourceUrlEcho(promptStrippedResponseText, taskContext.sourceUrl);
      if (sanitizedResponseText !== captureResult.responseText) {
        logInfo('Prompt echo removed from captured response.', {
          site: adapter.id,
          taskId: taskContext.taskId,
          beforeLength: captureResult.responseText.length,
          afterLength: sanitizedResponseText.length
        });
      }

      await reportAssistantResponse(
        taskContext,
        sanitizedResponseText,
        captureResult.captureMeta
      );
      logInfo('Assistant response captured and reported via network intercept.', {
        site: adapter.id,
        taskId: taskContext.taskId,
        responseLength: sanitizedResponseText.length,
        captureChannel: captureResult.captureMeta.captureChannel,
        captureChunkCount: captureResult.captureMeta.captureChunkCount,
        captureDumpLength: typeof captureResult.captureDump === 'string' ? captureResult.captureDump.length : 0
      });
    } catch (captureError) {
      const fallbackCaptureDump =
        captureError && typeof captureError.captureDump === 'string' ? captureError.captureDump : '';
      const fallbackRawResponseText =
        captureError && typeof captureError.fallbackResponseText === 'string'
          ? captureError.fallbackResponseText
          : '[capture-failed-debug]';
      const fallbackPromptStripped = stripPromptEcho(fallbackRawResponseText, finalText);
      const fallbackResponseText = stripSourceUrlEcho(fallbackPromptStripped, taskContext ? taskContext.sourceUrl : '');
      const fallbackCaptureMeta =
        captureError && captureError.fallbackCaptureMeta && typeof captureError.fallbackCaptureMeta === 'object'
          ? captureError.fallbackCaptureMeta
          : {
              captureMethod: 'network-intercept',
              captureChannel: 'unknown',
              captureSourceUrl: '',
              captureChunkCount: 0,
              captureDurationMs: 0
            };

      if (fallbackCaptureDump) {
        await reportAssistantResponse(taskContext, fallbackResponseText, fallbackCaptureMeta);
        logInfo('Capture failure fallback report sent with dump.', {
          site: adapter.id,
          taskId: taskContext.taskId,
          fallbackResponseLength: fallbackResponseText.length,
          captureDumpLength: fallbackCaptureDump.length
        });
        return;
      }

      throw captureError;
    }
  } catch (error) {
    console.error('Failed to run auto-send flow:', error);
    if (taskContext && taskContext.taskId) {
      cleanupNetworkCaptureSession(taskContext.taskId, 'send_flow_failed');
    }
  } finally {
    // Avoid duplicate sends while still allowing subsequent tasks later.
    setTimeout(() => {
      isRunning = false;
    }, 1500);
  }
}

/**
 * Fallback path: read payload from storage using query task id.
 */
async function runFromTaskId() {
  const taskId = readTaskIdFromUrl();
  if (!taskId) {
    return;
  }

  const storageKey = `${TASK_PREFIX}${taskId}`;

  try {
    const data = await chrome.storage.local.get(storageKey);
    const task = data[storageKey];

    if (!task || !task.finalText) {
      return;
    }

    await runWithText(task.finalText, task.targetSite, {
      taskId: task.taskId || taskId,
      sourceUrl: task.sourceUrl || '',
      sourceTitle: task.sourceTitle || ''
    });
    await chrome.storage.local.remove(storageKey);
  } catch (error) {
    console.error('Failed to execute fallback auto-send task:', error);
  }
}

/**
 * Primary path: read prompt payload directly from URL query string.
 */
async function runFromUrlPrompt() {
  const prompt = readPromptFromUrl();
  if (!prompt) {
    logInfo('No URL prompt payload found.');
    return;
  }

  try {
    const taskId = readTaskIdFromUrl() || undefined;
    if (taskId) {
      logInfo('Skip URL prompt auto-send when taskId exists; waiting runtime delivery.', { taskId });
      return;
    }

    const sourceUrl = readSourceUrlFromUrl();
    const sourceTitle = readSourceTitleFromUrl();
    logInfo('Starting URL prompt auto-send flow.', {
      taskId: taskId || null,
      sourceUrl: sourceUrl || null,
      sourceTitle: sourceTitle || null
    });
    await runWithText(prompt, undefined, { taskId, sourceUrl, sourceTitle });
    clearPromptFromUrl();
  } catch (error) {
    console.error('Failed to execute URL prompt auto-send task:', error);
  }
}

/**
 * Primary path: receive payload directly from background service worker.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.action !== MESSAGE_ACTION) {
    return;
  }

  if (isRecentlyExecuted(message.finalText, message.taskId)) {
    logInfo('Skip duplicate runtime message payload.', {
      textLength: message.finalText ? message.finalText.length : 0,
      taskId: message.taskId || null
    });
    sendResponse({ ok: true, skipped: true });
    return;
  }

  const adapterFromMessage = getSiteAdapterById(message.targetSite);
  if (adapterFromMessage) {
    logInfo('Received runtime task with target site.', {
      targetSite: adapterFromMessage.id,
      taskId: message.taskId || null
    });
  }

  runWithText(message.finalText, message.targetSite, {
    taskId: message.taskId,
    sourceUrl: message.sourceUrl,
    sourceTitle: message.sourceTitle
  })
    .then(() => {
      sendResponse({ ok: true });
    })
    .catch((error) => {
      console.error('Failed to handle runtime task message:', error);
      sendResponse({ ok: false, error: String(error) });
    });

  return true;
});

runFromUrlPrompt()
  .then(() => runFromTaskId())
  .catch((error) => {
    console.error('Failed to bootstrap content auto-send flow:', error);
  });
