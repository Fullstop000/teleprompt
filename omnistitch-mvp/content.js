const TASK_PREFIX = 'omnistitch_task_';
const TASK_PARAM = 'omnistitch_task';
const PROMPT_PARAM = 'q';
const SOURCE_URL_PARAM = 'omnistitch_source';
const SOURCE_TITLE_PARAM = 'omnistitch_title';
const MESSAGE_ACTION = 'omnistitch_auto_send';
const AI_RESPONSE_REPORT_ACTION = 'omnistitch_ai_response_report';
const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 250;
const DEDUPE_WINDOW_MS = 15000;
const RESPONSE_CAPTURE_TIMEOUT_MS = 180000;
const MIN_RESPONSE_TEXT_LENGTH = 20;
const RESPONSE_LOG_PREVIEW_LENGTH = 100;
const CAPTURE_ACK_TIMEOUT_MS = 2000;
const CAPTURE_HARD_TIMEOUT_MS = 185000;
const CAPTURE_MAIN_EVENT_SOURCE = 'omnistitch_capture_main';
const CAPTURE_CONTENT_EVENT_SOURCE = 'omnistitch_capture_content';
const CAPTURE_EVENT_TYPES = {
  START: 'OMNISTITCH_CAPTURE_START',
  STOP: 'OMNISTITCH_CAPTURE_STOP',
  READY: 'OMNISTITCH_CAPTURE_READY',
  ACK: 'OMNISTITCH_CAPTURE_ACK',
  CHUNK: 'OMNISTITCH_CAPTURE_CHUNK',
  STREAM_END: 'OMNISTITCH_CAPTURE_STREAM_END',
  FINAL: 'OMNISTITCH_CAPTURE_FINAL',
  ERROR: 'OMNISTITCH_CAPTURE_ERROR'
};
const CONTENT_LOG_PREFIX = '[omnistitch][content]';
const TARGET_SITE_ADAPTERS = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    hostnames: ['chatgpt.com', 'chat.openai.com'],
    composerSelectors: [
      'textarea#prompt-textarea',
      'textarea[data-id="root"]',
      'textarea',
      'div[contenteditable="true"][id="prompt-textarea"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]'
    ],
    sendButtonSelectors: [
      'button[data-testid="send-button"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'button[type="submit"]'
    ]
  },
  {
    id: 'kimi',
    name: 'Kimi',
    hostnames: ['kimi.com', 'www.kimi.com'],
    composerSelectors: [
      'div.chat-input-editor[contenteditable="true"]',
      'textarea',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]'
    ],
    sendButtonSelectors: [
      'div.send-button-container',
      'div.chat-editor-action div.send-button-container',
      'button[aria-label*="发送"]',
      'button[aria-label*="Send"]',
      'button[data-testid*="send"]',
      'button[class*="send"]',
      'button[type="submit"]'
    ]
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hostnames: ['chat.deepseek.com'],
    composerSelectors: [
      'textarea[placeholder*="给 DeepSeek 发送消息"]',
      'textarea#chat-input',
      'div#chat-input[contenteditable="true"]',
      'textarea[placeholder*="DeepSeek"]',
      'textarea',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]'
    ],
    sendButtonSelectors: [
      'div[role="button"]._7436101[aria-disabled="false"]',
      'div[role="button"]._7436101:not(.ds-icon-button--disabled)',
      'button#send-message-button',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'button[data-testid*="send"]',
      'button[class*="send"]',
      'button[type="submit"]',
      'div[class*="send"]'
    ]
  },
  {
    id: 'gemini',
    name: 'Gemini',
    hostnames: ['gemini.google.com'],
    composerSelectors: [
      'div.ql-editor.textarea[contenteditable="true"]',
      'rich-textarea div[contenteditable="true"]',
      'div.input-area div[contenteditable="true"]',
      'textarea[aria-label*="Enter a prompt"]',
      'div[role="textbox"][aria-label*="Gemini"]',
      'textarea[placeholder*="prompt"]',
      'textarea',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]'
    ],
    sendButtonSelectors: [
      'button.send-button',
      'button[aria-label="发送"]',
      'button[aria-label*="Send message"]',
      'button[aria-label*="Send"]',
      'button[aria-label*="发送"]',
      'button[data-test-id*="send"]',
      'button[data-testid*="send"]',
      'button[class*="send"]',
      'button[type="submit"]',
      'div[class*="send"]'
    ]
  }
];

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
 * Detects current target site adapter from location hostname.
 * @returns {{id:string,name:string,hostnames:string[],composerSelectors:string[],sendButtonSelectors:string[]} | null}
 */
function detectCurrentSiteAdapter() {
  const hostname = window.location.hostname.toLowerCase();

  for (const adapter of TARGET_SITE_ADAPTERS) {
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
 * @returns {{id:string,name:string,hostnames:string[],composerSelectors:string[],sendButtonSelectors:string[]} | null}
 */
function getSiteAdapterById(siteId) {
  if (!siteId || typeof siteId !== 'string') {
    return null;
  }

  for (const adapter of TARGET_SITE_ADAPTERS) {
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
 * Attempts to trigger send action via button click, then Enter key fallback.
 * @param {{id:string,name:string,sendButtonSelectors:string[]}} adapter
 * @param {HTMLElement} composer
 */
function triggerSend(adapter, composer) {
  const sendButton = findSendButton(adapter, composer);
  if (
    sendButton &&
    (!(sendButton instanceof HTMLButtonElement) || !sendButton.disabled) &&
    getComputedStyle(sendButton).pointerEvents !== 'none'
  ) {
    logInfo('Clicking send button.', { site: adapter.id });
    sendButton.click();
    return;
  }

  logInfo('Send button unavailable, fallback to Enter key.', { site: adapter.id });
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

  const structuredText = normalizeCapturedText(fragments.join('\n'));
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

  const regexExtractedText = normalizeCapturedText(regexExtractedFragments.join('\n'));
  if (regexExtractedText.length >= MIN_RESPONSE_TEXT_LENGTH) {
    return regexExtractedText;
  }

  return normalizeCapturedText(raw);
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
 * Clears all timers for one network capture session.
 * @param {{ackTimer:number|null,hardTimer:number|null}} session
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

  session.completed = true;
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  console.error('Network capture session failed.', {
    taskId,
    targetSite: session.targetSite,
    acked: session.acked,
    chunkCount: session.chunkCount,
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
function finalizeNetworkCaptureSession(taskId, finalPayload) {
  const session = networkCaptureSessions.get(taskId);
  if (!session || session.completed) {
    return;
  }

  const responseText = extractReadableTextFromCapture(session.chunks.join(''));
  if (responseText.length < MIN_RESPONSE_TEXT_LENGTH) {
    failNetworkCaptureSession(taskId, 'Captured response text is too short.', {
      reason: finalPayload?.reason || null,
      responseLength: responseText.length
    });
    return;
  }

  session.completed = true;
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
    captureChannel: captureMeta.captureChannel,
    captureSourceUrl: captureMeta.captureSourceUrl || null,
    durationMs: captureMeta.captureDurationMs
  });
  logResponsePreview('stabilized', responseText);

  session.resolve({
    responseText,
    captureMeta
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

    logInfo('Network capture session acknowledged.', {
      taskId,
      targetSite: session.targetSite
    });
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
    logInfo('Network capture stream-end signal received.', {
      taskId,
      targetSite: session.targetSite,
      captureChannel: typeof payload.captureChannel === 'string' ? payload.captureChannel : null,
      captureSourceUrl: typeof payload.captureSourceUrl === 'string' ? payload.captureSourceUrl : null
    });
    return;
  }

  if (type === CAPTURE_EVENT_TYPES.ERROR) {
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
 * @returns {Promise<{responseText: string, captureMeta: {captureMethod:string,captureChannel:string,captureSourceUrl:string,captureChunkCount:number,captureDurationMs:number}}>}
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
    const session = {
      taskId,
      targetSite: taskContext.targetSite,
      startedAt: Date.now(),
      chunks: [],
      chunkCount: 0,
      captureChannel: '',
      captureSourceUrl: '',
      acked: false,
      completed: false,
      ackTimer: null,
      hardTimer: null,
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

    networkCaptureSessions.set(taskId, session);
    logInfo('Network capture session started.', {
      taskId,
      targetSite: taskContext.targetSite,
      ackTimeoutMs: CAPTURE_ACK_TIMEOUT_MS,
      hardTimeoutMs: CAPTURE_HARD_TIMEOUT_MS
    });

    try {
      postCaptureControlEvent(CAPTURE_EVENT_TYPES.START, {
        taskId: session.taskId,
        targetSite: session.targetSite,
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
    logInfo('Composer ready, writing prompt.', {
      site: adapter.id,
      taskId: taskContext.taskId,
      textLength: finalText.length
    });

    fillComposer(composer, finalText);

    // Give UI state a short time to enable send action.
    await waitMs(500);
    triggerSend(adapter, composer);

    if (!capturePromise) {
      console.error('Network capture session unavailable, skip response reporting.', {
        site: adapter.id,
        taskId: taskContext.taskId
      });
      return;
    }

    const captureResult = await capturePromise;
    await reportAssistantResponse(taskContext, captureResult.responseText, captureResult.captureMeta);
    logInfo('Assistant response captured and reported via network intercept.', {
      site: adapter.id,
      taskId: taskContext.taskId,
      responseLength: captureResult.responseText.length,
      captureChannel: captureResult.captureMeta.captureChannel,
      captureChunkCount: captureResult.captureMeta.captureChunkCount
    });
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
