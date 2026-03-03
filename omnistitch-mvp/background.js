try {
  importScripts('webhook-provider.js');
} catch (error) {
  console.error('Failed to load webhook provider script:', error);
}
try {
  importScripts('obsidian-provider.js');
} catch (error) {
  console.error('Failed to load obsidian provider script:', error);
}

const PROMPT_STORE_KEY = 'prompt_store_v1';
const TARGET_STORE_KEY = 'target_site_v1';
const SYNC_TARGET_SETTINGS_KEY = 'sync_target_settings_v1';
const SYNC_RETRY_QUEUE_KEY = 'sync_retry_queue_v1';
const MESSAGE_ACTION = 'omnistitch_auto_send';
const AI_RESPONSE_REPORT_ACTION = 'omnistitch_ai_response_report';
const DEFAULT_TARGET_SITE = 'chatgpt';
const PROMPT_PARAM = 'q';
const TASK_PARAM = 'omnistitch_task';
const SOURCE_URL_PARAM = 'omnistitch_source';
const SOURCE_TITLE_PARAM = 'omnistitch_title';
const CAPTURE_DUMP_PARAM = 'omnistitch_capture_dump';
const ENABLE_CAPTURE_DUMP_QUERY = true;
const MESSAGE_RETRY_LIMIT = 8;
const MESSAGE_RETRY_DELAY_MS = 600;
const CAPTURE_NETWORK_TRACK_START_ACTION = 'omnistitch_capture_network_track_start';
const CAPTURE_NETWORK_TRACK_STOP_ACTION = 'omnistitch_capture_network_track_stop';
const CAPTURE_NETWORK_WAIT_IDLE_ACTION = 'omnistitch_capture_network_wait_idle';
const CAPTURE_NETWORK_IDLE_WINDOW_MS = 1600;
const CAPTURE_NETWORK_WAIT_TIMEOUT_MS = 7000;
const CAPTURE_NETWORK_WAIT_POLL_MS = 200;
const DEBUGGER_PROTOCOL_VERSION = '1.3';
const DEBUGGER_CAPTURE_TIMEOUT_MS = 180000;
const DEBUGGER_CAPTURE_RETENTION_MS = 10 * 60 * 1000;
const DEBUGGER_CAPTURE_WAIT_TIMEOUT_MS = 6000;
const DEBUGGER_CAPTURE_WAIT_POLL_MS = 200;
const KIMI_CHAT_SERVICE_PATH = '/apiv2/kimi.gateway.chat.v1.chatservice/chat';
const URL_KEYWORDS = ['chat', 'conversation', 'assistant', 'completion', 'generate', 'response', 'stream'];
const SYNC_RETRY_ALARM_NAME = 'omnistitch_sync_retry_alarm';
const SYNC_RETRY_DELAY_MINUTES = 5;
const SYNC_RETRY_MAX_ATTEMPTS = 20;
const BG_LOG_PREFIX = '[omnistitch][bg]';
const SYNC_PROVIDER_IDS = {
  DISABLED: 'disabled',
  WEBHOOK: 'webhook',
  OBSIDIAN: 'obsidian'
};
const TARGET_SITE_CONFIGS = {
  chatgpt: {
    id: 'chatgpt',
    name: 'ChatGPT',
    baseUrl: 'https://chatgpt.com/',
    promptParam: PROMPT_PARAM
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi',
    baseUrl: 'https://www.kimi.com/',
    promptParam: null
  },
  deepseek: {
    id: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://chat.deepseek.com/',
    promptParam: null
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini',
    baseUrl: 'https://gemini.google.com/app',
    promptParam: null
  }
};
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
const CAPTURE_TEXT_IGNORE_HINTS = [
  'role',
  'id',
  'model',
  'type',
  'index',
  'finish_reason',
  'token',
  'created',
  'status',
  'scenario',
  'time',
  'timestamp'
];

/**
 * Active debugger capture sessions keyed by tab id.
 * @type {Map<number, {
 *   tabId:number,
 *   taskId:string,
 *   targetSite:string,
 *   startedAt:number,
 *   requestIds:Set<string>,
 *   requestUrl:string,
 *   completed:boolean,
 *   timeoutHandle:number|null
 * }>}
 */
const debuggerCaptureSessionsByTabId = new Map();

/**
 * Captured debugger fallback response text keyed by task id.
 * @type {Map<string, {
 *   taskId:string,
 *   responseText:string,
 *   captureSourceUrl:string,
 *   capturedAt:string,
 *   bodyLength:number
 * }>}
 */
const debuggerCapturedByTaskId = new Map();

/**
 * Active webRequest tracking sessions keyed by task id.
 * @type {Map<string, {
 *   taskId:string,
 *   tabId:number,
 *   targetSite:string,
 *   startedAt:number,
 *   lastActivityAt:number,
 *   matchedRequestCount:number,
 *   completedRequestCount:number,
 *   inflightRequestIds:Set<string>,
 *   requestUrlByRequestId:Map<string,string>,
 *   lastMatchedUrl:string
 * }>}
 */
const webRequestTrackingSessionsByTaskId = new Map();

/**
 * Reverse index to resolve active task id from target tab id.
 * @type {Map<number, string>}
 */
const webRequestTrackingTaskIdByTabId = new Map();

let debuggerListenersInstalled = false;

/**
 * Writes a background debug log with a stable prefix.
 * @param {...unknown} args
 */
function logInfo(...args) {
  console.log(BG_LOG_PREFIX, ...args);
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
 * Promisified wrapper for chrome.debugger.attach.
 * @param {{tabId:number}} target
 * @returns {Promise<void>}
 */
async function attachDebugger(target) {
  await new Promise((resolve, reject) => {
    chrome.debugger.attach(target, DEBUGGER_PROTOCOL_VERSION, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(undefined);
    });
  });
}

/**
 * Promisified wrapper for chrome.debugger.detach.
 * @param {{tabId:number}} target
 * @returns {Promise<void>}
 */
async function detachDebugger(target) {
  await new Promise((resolve, reject) => {
    chrome.debugger.detach(target, () => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }
      resolve(undefined);
    });
  });
}

/**
 * Promisified wrapper for chrome.debugger.sendCommand.
 * @param {{tabId:number}} target
 * @param {string} method
 * @param {Record<string, unknown>} params
 * @returns {Promise<Record<string, unknown>>}
 */
async function sendDebuggerCommand(target, method, params = {}) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message));
        return;
      }

      resolve(result || {});
    });
  });
}

/**
 * Checks whether one URL is Kimi chat service request.
 * @param {string|undefined} url
 * @returns {boolean}
 */
function isKimiChatServiceUrl(url) {
  if (typeof url !== 'string' || !url) {
    return false;
  }

  return url.toLowerCase().includes(KIMI_CHAT_SERVICE_PATH);
}

/**
 * Returns host allowlist for one target site.
 * @param {string} targetSite
 * @returns {string[]}
 */
function getCaptureHostAllowlist(targetSite) {
  if (targetSite === 'chatgpt') {
    return ['chatgpt.com', 'openai.com'];
  }
  if (targetSite === 'kimi') {
    return ['kimi.com', 'moonshot.cn'];
  }
  if (targetSite === 'deepseek') {
    return ['deepseek.com'];
  }
  if (targetSite === 'gemini') {
    return ['gemini.google.com', 'googleapis.com', 'google.com'];
  }

  return ['chatgpt.com', 'openai.com', 'kimi.com', 'moonshot.cn', 'deepseek.com', 'gemini.google.com', 'googleapis.com', 'google.com'];
}

/**
 * Checks whether one request URL should be considered AI-response traffic.
 * @param {string} requestUrl
 * @param {string} targetSite
 * @returns {boolean}
 */
function isTrackableCaptureRequestUrl(requestUrl, targetSite) {
  if (!requestUrl || typeof requestUrl !== 'string') {
    return false;
  }

  try {
    const parsed = new URL(requestUrl);
    const hostname = parsed.hostname.toLowerCase();
    const pathAndSearch = `${parsed.pathname}${parsed.search}`.toLowerCase();
    const allowlist = getCaptureHostAllowlist(targetSite);
    const hostMatched = allowlist.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    if (!hostMatched) {
      return false;
    }

    if (isKimiChatServiceUrl(parsed.toString())) {
      return true;
    }

    return URL_KEYWORDS.some((keyword) => pathAndSearch.includes(keyword));
  } catch (_error) {
    return false;
  }
}

/**
 * Stops one webRequest tracking session and clears reverse indexes.
 * @param {string} taskId
 * @param {string} reason
 */
function stopWebRequestTrackingSession(taskId, reason) {
  if (!taskId || typeof taskId !== 'string') {
    return;
  }

  const session = webRequestTrackingSessionsByTaskId.get(taskId);
  if (!session) {
    return;
  }

  webRequestTrackingSessionsByTaskId.delete(taskId);
  const indexedTaskId = webRequestTrackingTaskIdByTabId.get(session.tabId);
  if (indexedTaskId === taskId) {
    webRequestTrackingTaskIdByTabId.delete(session.tabId);
  }

  logInfo('Stopped webRequest capture tracking session.', {
    taskId,
    tabId: session.tabId,
    targetSite: session.targetSite,
    reason,
    matchedRequestCount: session.matchedRequestCount,
    completedRequestCount: session.completedRequestCount,
    inflightCount: session.inflightRequestIds.size
  });
}

/**
 * Starts or replaces one webRequest tracking session.
 * @param {string} taskId
 * @param {number} tabId
 * @param {string} targetSite
 */
function startWebRequestTrackingSession(taskId, tabId, targetSite) {
  if (!taskId || !Number.isInteger(tabId)) {
    return;
  }

  const oldTaskId = webRequestTrackingTaskIdByTabId.get(tabId);
  if (oldTaskId && oldTaskId !== taskId) {
    stopWebRequestTrackingSession(oldTaskId, 'replaced_by_new_task');
  }
  if (webRequestTrackingSessionsByTaskId.has(taskId)) {
    stopWebRequestTrackingSession(taskId, 'restart');
  }

  const startedAt = Date.now();
  webRequestTrackingSessionsByTaskId.set(taskId, {
    taskId,
    tabId,
    targetSite: typeof targetSite === 'string' && targetSite ? targetSite : 'unknown',
    startedAt,
    lastActivityAt: startedAt,
    matchedRequestCount: 0,
    completedRequestCount: 0,
    inflightRequestIds: new Set(),
    requestUrlByRequestId: new Map(),
    lastMatchedUrl: ''
  });
  webRequestTrackingTaskIdByTabId.set(tabId, taskId);

  logInfo('Started webRequest capture tracking session.', {
    taskId,
    tabId,
    targetSite: typeof targetSite === 'string' && targetSite ? targetSite : 'unknown'
  });
}

/**
 * Updates one active tracking session when request starts.
 * @param {number} tabId
 * @param {string} requestId
 * @param {string} requestUrl
 */
function onTrackedRequestStarted(tabId, requestId, requestUrl) {
  const taskId = webRequestTrackingTaskIdByTabId.get(tabId);
  if (!taskId) {
    return;
  }

  const session = webRequestTrackingSessionsByTaskId.get(taskId);
  if (!session) {
    return;
  }

  if (!isTrackableCaptureRequestUrl(requestUrl, session.targetSite)) {
    return;
  }

  session.matchedRequestCount += 1;
  session.lastActivityAt = Date.now();
  session.lastMatchedUrl = requestUrl;
  if (requestId) {
    session.inflightRequestIds.add(requestId);
    session.requestUrlByRequestId.set(requestId, requestUrl);
  }

  if (session.matchedRequestCount <= 5 || session.matchedRequestCount % 20 === 0) {
    logInfo('webRequest matched request start.', {
      taskId: session.taskId,
      tabId: session.tabId,
      targetSite: session.targetSite,
      requestId,
      matchedRequestCount: session.matchedRequestCount,
      inflightCount: session.inflightRequestIds.size,
      requestUrl
    });
  }
}

/**
 * Updates one active tracking session when matched request completes or errors.
 * @param {number} tabId
 * @param {string} requestId
 */
function onTrackedRequestFinished(tabId, requestId) {
  const taskId = webRequestTrackingTaskIdByTabId.get(tabId);
  if (!taskId) {
    return;
  }

  const session = webRequestTrackingSessionsByTaskId.get(taskId);
  if (!session) {
    return;
  }

  if (!requestId || !session.inflightRequestIds.has(requestId)) {
    return;
  }

  session.inflightRequestIds.delete(requestId);
  const requestUrl = session.requestUrlByRequestId.get(requestId) || '';
  session.requestUrlByRequestId.delete(requestId);
  session.completedRequestCount += 1;
  session.lastActivityAt = Date.now();

  if (session.completedRequestCount <= 5 || session.completedRequestCount % 20 === 0) {
    logInfo('webRequest matched request finished.', {
      taskId: session.taskId,
      tabId: session.tabId,
      targetSite: session.targetSite,
      requestId,
      completedRequestCount: session.completedRequestCount,
      inflightCount: session.inflightRequestIds.size,
      requestUrl
    });
  }
}

/**
 * Waits until one task's tracked request stream becomes idle.
 * @param {string} taskId
 * @param {number} timeoutMs
 * @returns {Promise<{ok:boolean,taskId:string,timedOut:boolean,matchedRequestCount:number,completedRequestCount:number,inflightCount:number,idleForMs:number,lastMatchedUrl:string}>}
 */
async function waitForWebRequestTrackingIdle(taskId, timeoutMs = CAPTURE_NETWORK_WAIT_TIMEOUT_MS) {
  const normalizedTimeout =
    Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ? Number(timeoutMs) : CAPTURE_NETWORK_WAIT_TIMEOUT_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt <= normalizedTimeout) {
    const session = webRequestTrackingSessionsByTaskId.get(taskId);
    if (!session) {
      return {
        ok: true,
        taskId,
        timedOut: false,
        matchedRequestCount: 0,
        completedRequestCount: 0,
        inflightCount: 0,
        idleForMs: 0,
        lastMatchedUrl: ''
      };
    }

    const idleForMs = Date.now() - session.lastActivityAt;
    const inflightCount = session.inflightRequestIds.size;
    const hasMatchedRequest = session.matchedRequestCount > 0;
    const idleReached = inflightCount === 0 && idleForMs >= CAPTURE_NETWORK_IDLE_WINDOW_MS;
    const noMatchGraceReached = !hasMatchedRequest && Date.now() - session.startedAt >= CAPTURE_NETWORK_IDLE_WINDOW_MS;
    if (idleReached || noMatchGraceReached) {
      return {
        ok: true,
        taskId,
        timedOut: false,
        matchedRequestCount: session.matchedRequestCount,
        completedRequestCount: session.completedRequestCount,
        inflightCount,
        idleForMs,
        lastMatchedUrl: session.lastMatchedUrl
      };
    }

    await waitMs(CAPTURE_NETWORK_WAIT_POLL_MS);
  }

  const finalSession = webRequestTrackingSessionsByTaskId.get(taskId);
  return {
    ok: false,
    taskId,
    timedOut: true,
    matchedRequestCount: finalSession ? finalSession.matchedRequestCount : 0,
    completedRequestCount: finalSession ? finalSession.completedRequestCount : 0,
    inflightCount: finalSession ? finalSession.inflightRequestIds.size : 0,
    idleForMs: finalSession ? Date.now() - finalSession.lastActivityAt : 0,
    lastMatchedUrl: finalSession ? finalSession.lastMatchedUrl : ''
  };
}

/**
 * Handles webRequest start event to track candidate AI traffic per task.
 * @param {chrome.webRequest.WebRequestBodyDetails} details
 */
function handleWebRequestBeforeRequest(details) {
  const tabId = Number(details?.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  onTrackedRequestStarted(
    tabId,
    typeof details?.requestId === 'string' ? details.requestId : '',
    typeof details?.url === 'string' ? details.url : ''
  );
}

/**
 * Handles webRequest completion/error events to close inflight request ids.
 * @param {chrome.webRequest.WebResponseCacheDetails} details
 */
function handleWebRequestFinished(details) {
  const tabId = Number(details?.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) {
    return;
  }

  onTrackedRequestFinished(tabId, typeof details?.requestId === 'string' ? details.requestId : '');
}

/**
 * Decodes base64 payload to UTF-8 text when debugger returns encoded body.
 * @param {string} base64Text
 * @returns {string}
 */
function decodeBase64ToUtf8(base64Text) {
  try {
    const binary = atob(base64Text);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch (_error) {
    return '';
  }
}

/**
 * Determines whether one JSON path may contain assistant text.
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
 * Recursively collects text fragments from parsed JSON payload.
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
    const role = typeof value.role === 'string' ? value.role.trim().toLowerCase() : '';
    if (role && role !== 'assistant' && role !== 'model') {
      return;
    }

    for (const [key, child] of Object.entries(value)) {
      collectJsonTextFragments(child, path ? `${path}.${key}` : key, output, depth + 1);
    }
  }
}

/**
 * Extracts valid JSON payloads from mixed framed stream text.
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
          // Ignore malformed non-JSON candidate fragments.
        }
      }
    }
  }

  return payloads;
}

/**
 * Extracts assistant-like text from connect+json response body.
 * @param {string} rawBody
 * @returns {string}
 */
function extractReadableTextFromConnectBody(rawBody) {
  const payloads = extractJsonPayloadsFromRaw(rawBody);
  if (payloads.length === 0) {
    return '';
  }

  const fragments = [];
  for (const payload of payloads) {
    collectJsonTextFragments(payload, '', fragments);
  }

  return fragments.join('').replace(/\r/g, '').replace(/[ \t]{2,}/g, ' ').trim();
}

/**
 * Clears one debugger capture session and detaches debugger from target tab.
 * @param {number} tabId
 * @param {string} reason
 */
async function stopDebuggerCaptureSession(tabId, reason) {
  const session = debuggerCaptureSessionsByTabId.get(tabId);
  if (!session) {
    return;
  }

  if (session.timeoutHandle !== null) {
    clearTimeout(session.timeoutHandle);
  }
  debuggerCaptureSessionsByTabId.delete(tabId);

  try {
    await detachDebugger({ tabId });
  } catch (error) {
    logInfo('Debugger detach skipped or failed.', {
      tabId,
      taskId: session.taskId,
      reason,
      error: String(error)
    });
    return;
  }

  logInfo('Debugger capture session closed.', {
    tabId,
    taskId: session.taskId,
    reason
  });
}

/**
 * Stores debugger-captured response text for task fallback replacement.
 * @param {string} taskId
 * @param {string} responseText
 * @param {string} captureSourceUrl
 * @param {number} bodyLength
 */
function saveDebuggerCapturedResponse(taskId, responseText, captureSourceUrl, bodyLength) {
  if (!taskId || !responseText) {
    return;
  }

  const capture = {
    taskId,
    responseText,
    captureSourceUrl: captureSourceUrl || '',
    capturedAt: new Date().toISOString(),
    bodyLength
  };
  debuggerCapturedByTaskId.set(taskId, capture);

  setTimeout(() => {
    const current = debuggerCapturedByTaskId.get(taskId);
    if (current && current.capturedAt === capture.capturedAt) {
      debuggerCapturedByTaskId.delete(taskId);
    }
  }, DEBUGGER_CAPTURE_RETENTION_MS);
}

/**
 * Gets and consumes debugger capture fallback for one task.
 * @param {string} taskId
 * @returns {{taskId:string,responseText:string,captureSourceUrl:string,capturedAt:string,bodyLength:number}|null}
 */
function takeDebuggerCapturedResponse(taskId) {
  if (!taskId) {
    return null;
  }

  const capture = debuggerCapturedByTaskId.get(taskId) || null;
  if (capture) {
    debuggerCapturedByTaskId.delete(taskId);
  }
  return capture;
}

/**
 * Reads debugger capture fallback for one task without consuming it.
 * @param {string} taskId
 * @returns {{taskId:string,responseText:string,captureSourceUrl:string,capturedAt:string,bodyLength:number}|null}
 */
function peekDebuggerCapturedResponse(taskId) {
  if (!taskId) {
    return null;
  }

  return debuggerCapturedByTaskId.get(taskId) || null;
}

/**
 * Waits a short window for debugger capture to arrive for one task.
 * @param {string} taskId
 * @param {number} timeoutMs
 * @returns {Promise<{taskId:string,responseText:string,captureSourceUrl:string,capturedAt:string,bodyLength:number}|null>}
 */
async function waitForDebuggerCapturedResponse(taskId, timeoutMs = DEBUGGER_CAPTURE_WAIT_TIMEOUT_MS) {
  if (!taskId || timeoutMs <= 0) {
    return null;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const capture = peekDebuggerCapturedResponse(taskId);
    if (capture && capture.responseText) {
      return capture;
    }
    await waitMs(DEBUGGER_CAPTURE_WAIT_POLL_MS);
  }

  return peekDebuggerCapturedResponse(taskId);
}

/**
 * Processes one matching debugger request completion and extracts response text.
 * @param {number} tabId
 * @param {string} requestId
 */
async function handleDebuggerRequestCompleted(tabId, requestId) {
  const session = debuggerCaptureSessionsByTabId.get(tabId);
  if (!session || session.completed || !session.requestIds.has(requestId)) {
    return;
  }

  session.completed = true;
  let bodyText = '';
  let captureSourceUrl = session.requestUrl || '';
  try {
    const result = await sendDebuggerCommand({ tabId }, 'Network.getResponseBody', { requestId });
    const rawBody = typeof result.body === 'string' ? result.body : '';
    bodyText = result.base64Encoded === true ? decodeBase64ToUtf8(rawBody) : rawBody;
    const responseText = extractReadableTextFromConnectBody(bodyText);
    if (responseText) {
      saveDebuggerCapturedResponse(session.taskId, responseText, captureSourceUrl, bodyText.length);
      logInfo('Debugger capture extracted Kimi response.', {
        tabId,
        taskId: session.taskId,
        responseLength: responseText.length,
        bodyLength: bodyText.length,
        captureSourceUrl
      });
    } else {
      logInfo('Debugger capture received body but no readable text extracted.', {
        tabId,
        taskId: session.taskId,
        bodyLength: bodyText.length,
        captureSourceUrl
      });
    }
  } catch (error) {
    console.error('Failed to parse debugger response body:', {
      tabId,
      taskId: session.taskId,
      requestId,
      error: String(error)
    });
  } finally {
    await stopDebuggerCaptureSession(tabId, 'request_completed');
  }
}

/**
 * Handles debugger network events and routes Kimi chat service traffic to fallback capture.
 * @param {chrome.debugger.Debuggee} source
 * @param {string} method
 * @param {Record<string, unknown>} params
 */
function handleDebuggerEvent(source, method, params) {
  const tabId = Number(source?.tabId);
  if (!Number.isInteger(tabId)) {
    return;
  }

  const session = debuggerCaptureSessionsByTabId.get(tabId);
  if (!session) {
    return;
  }

  if (method === 'Network.requestWillBeSent') {
    const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
    const url = typeof params?.request?.url === 'string' ? params.request.url : '';
    if (!requestId || !isKimiChatServiceUrl(url)) {
      return;
    }

    session.requestIds.add(requestId);
    session.requestUrl = url;
    logInfo('Debugger matched Kimi chat request.', {
      tabId,
      taskId: session.taskId,
      requestId,
      url
    });
    return;
  }

  if (method === 'Network.loadingFinished') {
    const requestId = typeof params?.requestId === 'string' ? params.requestId : '';
    if (!requestId || !session.requestIds.has(requestId)) {
      return;
    }
    handleDebuggerRequestCompleted(tabId, requestId).catch((error) => {
      console.error('Failed handling debugger loadingFinished event:', error);
    });
  }
}

/**
 * Handles debugger detach events so stale sessions are cleaned up.
 * @param {chrome.debugger.Debuggee} source
 * @param {string} reason
 */
function handleDebuggerDetach(source, reason) {
  const tabId = Number(source?.tabId);
  if (!Number.isInteger(tabId)) {
    return;
  }

  const session = debuggerCaptureSessionsByTabId.get(tabId);
  if (!session) {
    return;
  }

  if (session.timeoutHandle !== null) {
    clearTimeout(session.timeoutHandle);
  }
  debuggerCaptureSessionsByTabId.delete(tabId);
  logInfo('Debugger capture session detached.', {
    tabId,
    taskId: session.taskId,
    reason
  });
}

/**
 * Ensures debugger event listeners are registered once.
 */
function ensureDebuggerListenersInstalled() {
  if (debuggerListenersInstalled) {
    return;
  }

  debuggerListenersInstalled = true;
  chrome.debugger.onEvent.addListener(handleDebuggerEvent);
  chrome.debugger.onDetach.addListener(handleDebuggerDetach);
}

/**
 * Starts one Kimi-specific debugger capture session for fallback response extraction.
 * @param {number} tabId
 * @param {{taskId:string}} taskContext
 * @param {string} targetSite
 */
async function startDebuggerCaptureForTask(tabId, taskContext, targetSite) {
  if (!Number.isInteger(tabId) || targetSite !== 'kimi') {
    return;
  }
  if (!taskContext || typeof taskContext.taskId !== 'string' || !taskContext.taskId) {
    return;
  }
  if (!chrome.debugger || typeof chrome.debugger.attach !== 'function') {
    return;
  }

  ensureDebuggerListenersInstalled();

  if (debuggerCaptureSessionsByTabId.has(tabId)) {
    await stopDebuggerCaptureSession(tabId, 'replaced');
  }

  try {
    await attachDebugger({ tabId });
  } catch (error) {
    console.error('Failed to attach debugger for Kimi capture.', {
      tabId,
      taskId: taskContext.taskId,
      error: String(error)
    });
    return;
  }

  try {
    await sendDebuggerCommand({ tabId }, 'Network.enable');
  } catch (error) {
    console.error('Failed to enable debugger Network domain.', {
      tabId,
      taskId: taskContext.taskId,
      error: String(error)
    });
    await stopDebuggerCaptureSession(tabId, 'network_enable_failed');
    return;
  }

  const timeoutHandle = setTimeout(() => {
    stopDebuggerCaptureSession(tabId, 'timeout').catch((error) => {
      console.error('Failed to stop debugger session on timeout:', error);
    });
  }, DEBUGGER_CAPTURE_TIMEOUT_MS);

  debuggerCaptureSessionsByTabId.set(tabId, {
    tabId,
    taskId: taskContext.taskId,
    targetSite,
    startedAt: Date.now(),
    requestIds: new Set(),
    requestUrl: '',
    completed: false,
    timeoutHandle
  });

  logInfo('Debugger capture session started.', {
    tabId,
    taskId: taskContext.taskId,
    targetSite
  });
}

/**
 * Logs currently registered extension commands for shortcut debugging.
 */
function logRegisteredCommands() {
  try {
    chrome.commands.getAll((commands) => {
      const err = chrome.runtime.lastError;
      if (err) {
        console.error('Failed to query registered commands:', err.message);
        return;
      }

      logInfo('Registered commands snapshot.', commands);
    });
  } catch (error) {
    console.error('Unexpected error while querying commands:', error);
  }
}

/**
 * Creates a default prompt store for first-time users.
 * @returns {{prompts: Array<{id:string,title:string,content:string}>, activePromptId: string}}
 */
function createDefaultStore() {
  const promptId = `${Date.now()}_default`;
  return {
    prompts: [
      {
        id: promptId,
        title: '博客总结',
        content: '请用中文总结这篇文章的核心观点，并给出3条可执行建议：\n'
      }
    ],
    activePromptId: promptId
  };
}

/**
 * Creates the default jump-target settings.
 * @returns {{targetSites: string[]}}
 */
function createDefaultTargetSettings() {
  return {
    targetSites: ['chatgpt', 'kimi', 'deepseek', 'gemini']
  };
}

/**
 * Creates the default sync-target settings.
 * disabled means capture is enabled but no external sync provider is active.
 * @returns {{provider:string,autoSync:boolean,retryEnabled:boolean,webhookUrl:string,webhookAuthToken:string,obsidianBaseUrl:string,obsidianApiKey:string}}
 */
function createDefaultSyncTargetSettings() {
  return {
    provider: SYNC_PROVIDER_IDS.DISABLED,
    autoSync: true,
    retryEnabled: true,
    webhookUrl: '',
    webhookAuthToken: '',
    obsidianBaseUrl: 'https://127.0.0.1:27124',
    obsidianApiKey: ''
  };
}

/**
 * Checks whether one provider id is supported by current extension build.
 * @param {string|undefined} provider
 * @returns {boolean}
 */
function isValidProvider(provider) {
  return (
    provider === SYNC_PROVIDER_IDS.DISABLED ||
    provider === SYNC_PROVIDER_IDS.WEBHOOK ||
    provider === SYNC_PROVIDER_IDS.OBSIDIAN
  );
}

/**
 * Normalizes target settings and keeps backward compatibility with old single-target schema.
 * @param {{targetSites?: string[], targetSite?: string}|undefined} settings
 * @returns {{targetSites: string[]}}
 */
function normalizeTargetSettings(settings) {
  const normalizedSet = new Set();

  if (settings && Array.isArray(settings.targetSites)) {
    for (const site of settings.targetSites) {
      if (getTargetSiteConfig(site)) {
        normalizedSet.add(site);
      }
    }
  }

  if (settings && typeof settings.targetSite === 'string' && getTargetSiteConfig(settings.targetSite)) {
    normalizedSet.add(settings.targetSite);
  }

  if (normalizedSet.size === 0) {
    for (const siteId of Object.keys(TARGET_SITE_CONFIGS)) {
      normalizedSet.add(siteId);
    }
  }

  return {
    targetSites: Array.from(normalizedSet)
  };
}

/**
 * Normalizes sync-target settings using current schema only.
 * @param {Record<string, unknown>|undefined} settings
 * @returns {{provider:string,autoSync:boolean,retryEnabled:boolean,webhookUrl:string,webhookAuthToken:string,obsidianBaseUrl:string,obsidianApiKey:string}}
 */
function normalizeSyncTargetSettings(settings) {
  const defaults = createDefaultSyncTargetSettings();
  const data = settings && typeof settings === 'object' ? settings : {};

  const rawProvider = typeof data.provider === 'string' ? data.provider.trim() : '';
  const webhookUrl = typeof data.webhookUrl === 'string' ? data.webhookUrl.trim() : defaults.webhookUrl;
  const webhookAuthToken =
    typeof data.webhookAuthToken === 'string' ? data.webhookAuthToken.trim() : defaults.webhookAuthToken;
  const obsidianBaseUrl =
    typeof data.obsidianBaseUrl === 'string' ? data.obsidianBaseUrl.trim() : defaults.obsidianBaseUrl;
  const obsidianApiKey =
    typeof data.obsidianApiKey === 'string' ? data.obsidianApiKey.trim() : defaults.obsidianApiKey;
  const autoSync = typeof data.autoSync === 'boolean' ? data.autoSync : defaults.autoSync;
  const retryEnabled = typeof data.retryEnabled === 'boolean' ? data.retryEnabled : defaults.retryEnabled;

  const provider = isValidProvider(rawProvider) ? rawProvider : defaults.provider;

  return {
    provider,
    autoSync,
    retryEnabled,
    webhookUrl,
    webhookAuthToken,
    obsidianBaseUrl,
    obsidianApiKey
  };
}

/**
 * Loads prompt store and ensures a valid active prompt exists.
 * @returns {Promise<{prompts: Array<{id:string,title:string,content:string}>, activePromptId: string}>}
 */
async function loadPromptStore() {
  try {
    const data = await chrome.storage.local.get(PROMPT_STORE_KEY);
    const store = data[PROMPT_STORE_KEY];

    if (!store || !Array.isArray(store.prompts) || store.prompts.length === 0) {
      const defaultStore = createDefaultStore();
      await chrome.storage.local.set({ [PROMPT_STORE_KEY]: defaultStore });
      return defaultStore;
    }

    const activePrompt = store.prompts.find((item) => item.id === store.activePromptId);
    if (!activePrompt) {
      store.activePromptId = store.prompts[0].id;
      await chrome.storage.local.set({ [PROMPT_STORE_KEY]: store });
    }

    return store;
  } catch (error) {
    console.error('Failed to load prompt store:', error);
    const defaultStore = createDefaultStore();
    await chrome.storage.local.set({ [PROMPT_STORE_KEY]: defaultStore });
    return defaultStore;
  }
}

/**
 * Loads target settings and ensures a valid target value.
 * @returns {Promise<{targetSites: string[]}>}
 */
async function loadTargetSettings() {
  try {
    const data = await chrome.storage.local.get(TARGET_STORE_KEY);
    const normalized = normalizeTargetSettings(data[TARGET_STORE_KEY]);
    const raw = data[TARGET_STORE_KEY];
    const hasSameShape =
      raw &&
      Array.isArray(raw.targetSites) &&
      raw.targetSites.length === normalized.targetSites.length &&
      raw.targetSites.every((site) => normalized.targetSites.includes(site));

    if (!hasSameShape) {
      await chrome.storage.local.set({ [TARGET_STORE_KEY]: normalized });
    }

    return normalized;
  } catch (error) {
    console.error('Failed to load target settings:', error);
    const defaultSettings = createDefaultTargetSettings();
    await chrome.storage.local.set({ [TARGET_STORE_KEY]: defaultSettings });
    return defaultSettings;
  }
}

/**
 * Loads sync-target settings from current schema.
 * @returns {Promise<{provider:string,autoSync:boolean,retryEnabled:boolean,webhookUrl:string,webhookAuthToken:string,obsidianBaseUrl:string,obsidianApiKey:string}>}
 */
async function loadSyncTargetSettings() {
  try {
    const data = await chrome.storage.local.get(SYNC_TARGET_SETTINGS_KEY);
    const normalized = normalizeSyncTargetSettings(data[SYNC_TARGET_SETTINGS_KEY]);
    const raw = data[SYNC_TARGET_SETTINGS_KEY];
    const hasSameShape =
      raw &&
      raw.provider === normalized.provider &&
      raw.autoSync === normalized.autoSync &&
      raw.retryEnabled === normalized.retryEnabled &&
      raw.webhookUrl === normalized.webhookUrl &&
      raw.webhookAuthToken === normalized.webhookAuthToken &&
      raw.obsidianBaseUrl === normalized.obsidianBaseUrl &&
      raw.obsidianApiKey === normalized.obsidianApiKey;

    if (!hasSameShape) {
      await chrome.storage.local.set({ [SYNC_TARGET_SETTINGS_KEY]: normalized });
    }

    return normalized;
  } catch (error) {
    console.error('Failed to load sync target settings:', error);
    const defaults = createDefaultSyncTargetSettings();
    await chrome.storage.local.set({ [SYNC_TARGET_SETTINGS_KEY]: defaults });
    return defaults;
  }
}

/**
 * Loads retry queue from current schema key.
 * @returns {Promise<Array<{id:string,payload:{taskId:string,targetSite:string,sourceUrl:string,sourceTitle:string,aiResponse:string,capturedAt:string,captureMethod:string,captureChannel:string,captureSourceUrl:string,captureChunkCount:number,captureDurationMs:number,captureDump:string},providerId:string,attempts:number,lastError:string,updatedAt:string}>>}
 */
async function loadSyncRetryQueue() {
  try {
    const data = await chrome.storage.local.get(SYNC_RETRY_QUEUE_KEY);
    if (Array.isArray(data[SYNC_RETRY_QUEUE_KEY])) {
      return data[SYNC_RETRY_QUEUE_KEY];
    }

    return [];
  } catch (error) {
    console.error('Failed to load sync retry queue:', error);
    return [];
  }
}

/**
 * Saves sync retry queue into extension storage.
 * @param {Array<{id:string,payload:{taskId:string,targetSite:string,sourceUrl:string,sourceTitle:string,aiResponse:string,capturedAt:string,captureMethod:string,captureChannel:string,captureSourceUrl:string,captureChunkCount:number,captureDurationMs:number,captureDump:string},providerId:string,attempts:number,lastError:string,updatedAt:string}>} queue
 */
async function saveSyncRetryQueue(queue) {
  try {
    await chrome.storage.local.set({ [SYNC_RETRY_QUEUE_KEY]: queue });
  } catch (error) {
    console.error('Failed to save sync retry queue:', error);
    throw error;
  }
}

/**
 * Resolves enabled target site configs from settings with defaults and dedupe.
 * @param {{targetSites: string[]}} settings
 * @returns {Array<{id: string, name: string, baseUrl: string, promptParam: string|null}>}
 */
function resolveEnabledTargetConfigs(settings) {
  const targetSites = Array.isArray(settings.targetSites) ? settings.targetSites : [DEFAULT_TARGET_SITE];
  const targetConfigs = [];
  const seenSiteIds = new Set();

  for (const siteId of targetSites) {
    const targetConfig = getTargetSiteConfig(siteId);
    if (!targetConfig || seenSiteIds.has(targetConfig.id)) {
      continue;
    }

    seenSiteIds.add(targetConfig.id);
    targetConfigs.push(targetConfig);
  }

  if (targetConfigs.length === 0) {
    targetConfigs.push(TARGET_SITE_CONFIGS[DEFAULT_TARGET_SITE]);
  }

  return targetConfigs;
}

/**
 * Builds a text payload from the active prompt template and target URL.
 * @param {string} promptTemplate
 * @param {string} url
 * @returns {string}
 */
function buildFinalText(promptTemplate, url) {
  const finalText = `${promptTemplate}${url}`;
  logInfo('Prompt assembled.', {
    promptLength: promptTemplate.length,
    url,
    finalLength: finalText.length
  });
  return finalText;
}

/**
 * Returns target site config by id.
 * @param {string|undefined} targetSite
 * @returns {{id: string, name: string, baseUrl: string, promptParam: string|null}|null}
 */
function getTargetSiteConfig(targetSite) {
  if (!targetSite || typeof targetSite !== 'string') {
    return null;
  }

  return TARGET_SITE_CONFIGS[targetSite] || null;
}

/**
 * Generates a stable task id for one target dispatch.
 * @param {string} targetSite
 * @returns {string}
 */
function generateTaskId(targetSite) {
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `${Date.now()}_${targetSite}_${randomPart}`;
}

/**
 * Builds target URL and attaches prompt query payload when supported.
 * @param {{id: string, name: string, baseUrl: string, promptParam: string|null}} targetConfig
 * @param {string} finalText
 * @param {{taskId: string}} taskContext
 * @returns {string}
 */
function buildTargetUrl(targetConfig, finalText, taskContext) {
  try {
    const url = new URL(targetConfig.baseUrl);
    if (targetConfig.promptParam) {
      url.searchParams.set(targetConfig.promptParam, finalText);
    }

    if (taskContext && typeof taskContext.taskId === 'string' && taskContext.taskId) {
      url.searchParams.set(TASK_PARAM, taskContext.taskId);
    }

    if (taskContext && typeof taskContext.sourceUrl === 'string' && taskContext.sourceUrl) {
      url.searchParams.set(SOURCE_URL_PARAM, taskContext.sourceUrl);
    }

    if (taskContext && typeof taskContext.sourceTitle === 'string' && taskContext.sourceTitle) {
      // Keep title query payload bounded to reduce URL explosion risk.
      const safeTitle = taskContext.sourceTitle.slice(0, 300);
      url.searchParams.set(SOURCE_TITLE_PARAM, safeTitle);
    }

    // Keep dump enabled in this debug phase to collect full observed streams.
    if (ENABLE_CAPTURE_DUMP_QUERY) {
      url.searchParams.set(CAPTURE_DUMP_PARAM, '1');
    }

    return url.toString();
  } catch (error) {
    console.error('Failed to build target URL with prompt payload:', error);
    return targetConfig.baseUrl;
  }
}

/**
 * Resolves the active sync provider id from settings.
 * @param {{provider: string}} settings
 * @returns {string}
 */
function resolveActiveProvider(settings) {
  if (settings && isValidProvider(settings.provider)) {
    return settings.provider;
  }

  return SYNC_PROVIDER_IDS.DISABLED;
}

/**
 * Checks whether selected sync provider has required credentials.
 * @param {{webhookUrl:string,obsidianBaseUrl:string,obsidianApiKey:string}} settings
 * @param {string} providerId
 * @returns {boolean}
 */
function hasProviderCredentials(settings, providerId) {
  if (providerId === SYNC_PROVIDER_IDS.DISABLED) {
    return true;
  }

  if (providerId === SYNC_PROVIDER_IDS.WEBHOOK) {
    return Boolean(settings.webhookUrl);
  }

  if (providerId === SYNC_PROVIDER_IDS.OBSIDIAN) {
    return Boolean(settings.obsidianBaseUrl && settings.obsidianApiKey);
  }

  return false;
}

/**
 * Creates human-readable credential error for active provider.
 * @param {string} providerId
 * @returns {string}
 */
function buildProviderCredentialError(providerId) {
  if (providerId === SYNC_PROVIDER_IDS.WEBHOOK) {
    return 'Webhook URL is not configured.';
  }

  if (providerId === SYNC_PROVIDER_IDS.OBSIDIAN) {
    return 'Obsidian baseUrl/apiKey is not configured.';
  }

  return 'Sync provider is not configured.';
}

/**
 * Normalizes one AI response report payload before syncing.
 * @param {{taskId?: string, targetSite?: string, sourceUrl?: string, sourceTitle?: string, aiResponse?: string, capturedAt?: string, captureMethod?: string, captureChannel?: string, captureSourceUrl?: string, captureChunkCount?: number|string, captureDurationMs?: number|string, captureDump?: string}} message
 * @returns {{taskId: string, targetSite: string, sourceUrl: string, sourceTitle: string, aiResponse: string, capturedAt: string, captureMethod: string, captureChannel: string, captureSourceUrl: string, captureChunkCount: number, captureDurationMs: number, captureDump: string}}
 */
function normalizeAiResponsePayload(message) {
  const taskId = typeof message.taskId === 'string' ? message.taskId.trim() : '';
  if (!taskId) {
    throw new Error('Missing taskId for AI response report.');
  }

  const targetSite =
    typeof message.targetSite === 'string' && message.targetSite.trim() ? message.targetSite.trim() : 'unknown';
  const sourceUrl = typeof message.sourceUrl === 'string' ? message.sourceUrl.trim() : '';
  const sourceTitle = typeof message.sourceTitle === 'string' ? message.sourceTitle.trim() : '';
  const aiResponse = typeof message.aiResponse === 'string' ? message.aiResponse.trim() : '';
  if (!aiResponse) {
    throw new Error('AI response content is empty.');
  }

  const capturedDate = new Date(message.capturedAt || Date.now());
  const capturedAt = Number.isNaN(capturedDate.getTime()) ? new Date().toISOString() : capturedDate.toISOString();
  const captureMethod =
    typeof message.captureMethod === 'string' && message.captureMethod.trim()
      ? message.captureMethod.trim()
      : 'unknown';
  const captureChannel =
    typeof message.captureChannel === 'string' && message.captureChannel.trim()
      ? message.captureChannel.trim()
      : 'unknown';
  const captureSourceUrl =
    typeof message.captureSourceUrl === 'string' && message.captureSourceUrl.trim()
      ? message.captureSourceUrl.trim()
      : '';
  const captureChunkCountValue = Number(message.captureChunkCount);
  const captureDurationMsValue = Number(message.captureDurationMs);
  const captureChunkCount =
    Number.isFinite(captureChunkCountValue) && captureChunkCountValue >= 0 ? captureChunkCountValue : 0;
  const captureDurationMs =
    Number.isFinite(captureDurationMsValue) && captureDurationMsValue >= 0 ? captureDurationMsValue : 0;
  const captureDump = typeof message.captureDump === 'string' ? message.captureDump : '';

  return {
    taskId,
    targetSite,
    sourceUrl,
    sourceTitle,
    aiResponse,
    capturedAt,
    captureMethod,
    captureChannel,
    captureSourceUrl,
    captureChunkCount,
    captureDurationMs,
    captureDump
  };
}

/**
 * Reads webhook provider API from service worker global scope.
 * @returns {{sync: Function}}
 */
function getWebhookProvider() {
  const provider = self.OmnistitchWebhookProvider;
  if (!provider || typeof provider.sync !== 'function') {
    throw new Error('Webhook provider is unavailable.');
  }

  return provider;
}

/**
 * Reads Obsidian provider API from service worker global scope.
 * @returns {{sync: Function}}
 */
function getObsidianProvider() {
  const provider = self.OmnistitchObsidianProvider;
  if (!provider || typeof provider.sync !== 'function') {
    throw new Error('Obsidian provider is unavailable.');
  }

  return provider;
}

/**
 * Dispatches sync payload to active provider implementation.
 * @param {{taskId: string, targetSite: string, sourceUrl: string, sourceTitle: string, aiResponse: string, capturedAt: string, captureMethod: string, captureChannel: string, captureSourceUrl: string, captureChunkCount: number, captureDurationMs: number, captureDump: string}} payload
 * @param {{provider:string,webhookUrl:string,webhookAuthToken:string,obsidianBaseUrl:string,obsidianApiKey:string}} settings
 * @param {string} providerId
 */
async function syncPayloadToProvider(payload, settings, providerId) {
  if (providerId === SYNC_PROVIDER_IDS.WEBHOOK) {
    const webhookProvider = getWebhookProvider();
    await webhookProvider.sync(payload, settings);
    return;
  }

  if (providerId === SYNC_PROVIDER_IDS.OBSIDIAN) {
    const obsidianProvider = getObsidianProvider();
    await obsidianProvider.sync(payload, settings);
    return;
  }

  if (providerId === SYNC_PROVIDER_IDS.DISABLED) {
    return;
  }

  throw new Error(`Unsupported sync provider: ${providerId}`);
}

/**
 * Adds one failed payload into local retry queue.
 * @param {{taskId: string, targetSite: string, sourceUrl: string, sourceTitle: string, aiResponse: string, capturedAt: string, captureMethod: string, captureChannel: string, captureSourceUrl: string, captureChunkCount: number, captureDurationMs: number, captureDump: string}} payload
 * @param {string} providerId
 * @param {string} lastError
 */
async function enqueueSyncRetry(payload, providerId, lastError) {
  const queue = await loadSyncRetryQueue();
  const retryItem = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    payload,
    providerId,
    attempts: 0,
    lastError,
    updatedAt: new Date().toISOString()
  };
  queue.push(retryItem);

  await saveSyncRetryQueue(queue);
  logInfo('Sync retry item enqueued.', {
    retryId: retryItem.id,
    taskId: payload.taskId,
    providerId,
    queueSize: queue.length,
    lastError
  });
  await scheduleSyncRetryAlarm();
}

/**
 * Ensures retry alarm matches current queue and sync settings.
 */
async function scheduleSyncRetryAlarm() {
  try {
    const settings = await loadSyncTargetSettings();
    const queue = await loadSyncRetryQueue();

    if (!settings.retryEnabled || queue.length === 0) {
      chrome.alarms.clear(SYNC_RETRY_ALARM_NAME);
      return;
    }

    chrome.alarms.create(SYNC_RETRY_ALARM_NAME, {
      delayInMinutes: SYNC_RETRY_DELAY_MINUTES,
      periodInMinutes: SYNC_RETRY_DELAY_MINUTES
    });
  } catch (error) {
    console.error('Failed to schedule sync retry alarm:', error);
  }
}

/**
 * Tries to flush queued payloads to current sync provider.
 */
async function retryQueuedSync() {
  const settings = await loadSyncTargetSettings();
  const queue = await loadSyncRetryQueue();
  if (queue.length === 0) {
    await scheduleSyncRetryAlarm();
    return;
  }

  if (!settings.retryEnabled) {
    await scheduleSyncRetryAlarm();
    return;
  }

  const activeProvider = resolveActiveProvider(settings);
  const nextQueue = [];
  for (const item of queue) {
    const attempts = Number.isFinite(item.attempts) ? item.attempts : 0;
    if (attempts >= SYNC_RETRY_MAX_ATTEMPTS) {
      console.error('Dropping retry item due to max attempts.', {
        taskId: item.payload?.taskId || null,
        attempts,
        providerId: item.providerId || null
      });
      continue;
    }

    const providerId = typeof item.providerId === 'string' ? item.providerId : activeProvider;
    if (providerId !== activeProvider) {
      nextQueue.push(item);
      continue;
    }

    if (activeProvider === SYNC_PROVIDER_IDS.DISABLED || !hasProviderCredentials(settings, activeProvider)) {
      nextQueue.push(item);
      continue;
    }

    try {
      const payload = normalizeAiResponsePayload(item.payload || {});
      await syncPayloadToProvider(payload, settings, activeProvider);
    } catch (error) {
      nextQueue.push({
        ...item,
        attempts: attempts + 1,
        lastError: String(error),
        updatedAt: new Date().toISOString()
      });
    }
  }

  await saveSyncRetryQueue(nextQueue);
  await scheduleSyncRetryAlarm();
}

/**
 * Handles one AI response report from content scripts.
 * @param {{taskId?: string, targetSite?: string, sourceUrl?: string, sourceTitle?: string, aiResponse?: string, capturedAt?: string, captureMethod?: string, captureChannel?: string, captureSourceUrl?: string, captureChunkCount?: number|string, captureDurationMs?: number|string, captureDump?: string}} message
 * @returns {Promise<{ok: boolean, queued?: boolean, skipped?: boolean, error?: string}>}
 */
async function handleAiResponseReport(message) {
  const payload = normalizeAiResponsePayload(message);
  stopWebRequestTrackingSession(payload.taskId, 'report_received');
  const syncSettings = await loadSyncTargetSettings();
  const providerId = resolveActiveProvider(syncSettings);

  logInfo('AI response report received.', {
    taskId: payload.taskId,
    targetSite: payload.targetSite,
    providerId,
    autoSync: syncSettings.autoSync,
    retryEnabled: syncSettings.retryEnabled,
    responseLength: payload.aiResponse.length,
    sourceUrl: payload.sourceUrl || null,
    sourceTitle: payload.sourceTitle || null,
    captureMethod: payload.captureMethod,
    captureChannel: payload.captureChannel,
    captureSourceUrl: payload.captureSourceUrl || null,
    captureChunkCount: payload.captureChunkCount,
    captureDurationMs: payload.captureDurationMs,
    captureDumpLength: payload.captureDump.length
  });

  if (!syncSettings.autoSync || providerId === SYNC_PROVIDER_IDS.DISABLED) {
    logInfo('AI response sync skipped by settings.', {
      taskId: payload.taskId,
      providerId,
      autoSync: syncSettings.autoSync
    });
    return { ok: true, skipped: true };
  }

  if (!hasProviderCredentials(syncSettings, providerId)) {
    const error = buildProviderCredentialError(providerId);
    console.error('AI response sync blocked by missing provider credentials.', {
      taskId: payload.taskId,
      providerId,
      error
    });
    if (syncSettings.retryEnabled) {
      await enqueueSyncRetry(payload, providerId, error);
      logInfo('AI response queued due to missing provider credentials.', {
        taskId: payload.taskId,
        providerId
      });
      return { ok: true, queued: true };
    }

    return { ok: false, error };
  }

  try {
    await syncPayloadToProvider(payload, syncSettings, providerId);
    logInfo('AI response sync completed.', {
      taskId: payload.taskId,
      providerId,
      targetSite: payload.targetSite,
      captureMethod: payload.captureMethod,
      captureChannel: payload.captureChannel,
      captureChunkCount: payload.captureChunkCount,
      captureDumpLength: payload.captureDump.length
    });
    return { ok: true };
  } catch (error) {
    console.error('Failed to sync AI response:', error);
    if (syncSettings.retryEnabled) {
      await enqueueSyncRetry(payload, providerId, String(error));
      logInfo('AI response queued after sync failure.', {
        taskId: payload.taskId,
        providerId,
        error: String(error)
      });
      return { ok: true, queued: true };
    }

    return { ok: false, error: String(error) };
  }
}

/**
 * Sends final text payload to target tab via runtime message.
 * Retries are needed because SPA hydration can delay content script readiness.
 * @param {number} tabId
 * @param {string} targetSite
 * @param {string} finalText
 * @param {{taskId: string, sourceUrl: string, sourceTitle: string}} taskContext
 * @param {number} retry
 */
function sendTaskMessageToTab(tabId, targetSite, finalText, taskContext, retry = 0) {
  logInfo('Sending runtime message to tab.', {
    tabId,
    targetSite,
    taskId: taskContext.taskId,
    retry,
    payloadLength: finalText.length
  });
  chrome.tabs.sendMessage(
    tabId,
    {
      action: MESSAGE_ACTION,
      targetSite,
      finalText,
      taskId: taskContext.taskId,
      sourceUrl: taskContext.sourceUrl,
      sourceTitle: taskContext.sourceTitle
    },
    (response) => {
      const err = chrome.runtime.lastError;
      if (!err) {
        logInfo('Runtime message delivered successfully.', { tabId, response: response || null });
        return;
      }

      if (retry >= MESSAGE_RETRY_LIMIT) {
        console.error('Failed to deliver task message to content script:', err.message);
        return;
      }

      setTimeout(() => {
        sendTaskMessageToTab(tabId, targetSite, finalText, taskContext, retry + 1);
      }, MESSAGE_RETRY_DELAY_MS);
    }
  );
}

/**
 * Attaches one-time tab update listener and pushes task payload when target tab is ready.
 * @param {string} targetSite
 * @param {string} targetName
 * @param {number} tabId
 * @param {string} finalText
 * @param {{taskId: string, sourceUrl: string, sourceTitle: string}} taskContext
 */
function attachTaskDeliveryListener(targetSite, targetName, tabId, finalText, taskContext) {
  const handleTabUpdated = async (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
      return;
    }

    logInfo('Target tab load complete, start task delivery.', {
      targetName,
      targetSite,
      tabId,
      taskId: taskContext.taskId
    });
    chrome.tabs.onUpdated.removeListener(handleTabUpdated);

    sendTaskMessageToTab(tabId, targetSite, finalText, taskContext);
  };

  chrome.tabs.onUpdated.addListener(handleTabUpdated);
}

/**
 * Opens target site and schedules task delivery by runtime message.
 * @param {{id: string, name: string, baseUrl: string, promptParam: string|null}} targetConfig
 * @param {string} finalText
 * @param {{taskId: string, sourceUrl: string, sourceTitle: string}} taskContext
 */
async function openTargetAndDispatchTask(targetConfig, finalText, taskContext) {
  const targetUrl = buildTargetUrl(targetConfig, finalText, taskContext);
  logInfo('Opening target tab with payload.', {
    targetSite: targetConfig.id,
    targetName: targetConfig.name,
    targetUrl,
    taskId: taskContext.taskId,
    payloadLength: finalText.length
  });

  const createdTab = await chrome.tabs.create({ url: targetUrl });
  logInfo('Target tab created.', {
    targetSite: targetConfig.id,
    targetName: targetConfig.name,
    tabId: createdTab?.id ?? null,
    taskId: taskContext.taskId
  });

  if (createdTab?.id === undefined) {
    console.error('Failed to create target tab or tab id missing.');
    return;
  }

  // Always deliver via runtime message for consistent behavior across target sites.
  attachTaskDeliveryListener(targetConfig.id, targetConfig.name, createdTab.id, finalText, taskContext);
}

/**
 * Executes the main send flow from a browser tab context.
 * @param {chrome.tabs.Tab|undefined} tab
 */
async function runSendFlow(tab) {
  try {
    const currentUrl = tab?.url;
    const rawTitle = typeof tab?.title === 'string' ? tab.title.trim() : '';
    const sourceTitle = rawTitle || currentUrl || '';
    logInfo('Read active tab URL.', { currentUrl: currentUrl || null });
    if (!currentUrl || !/^https?:\/\//.test(currentUrl)) {
      console.error('Unsupported or empty URL:', currentUrl);
      return;
    }

    const promptStore = await loadPromptStore();
    const activePrompt = promptStore.prompts.find((item) => item.id === promptStore.activePromptId);
    const promptContent = activePrompt?.content || '请总结以下链接内容：\n';
    const finalText = buildFinalText(promptContent, currentUrl);

    const targetSettings = await loadTargetSettings();
    const targetConfigs = resolveEnabledTargetConfigs(targetSettings);

    await Promise.all(
      targetConfigs.map((targetConfig) => {
        const taskContext = {
          taskId: generateTaskId(targetConfig.id),
          sourceUrl: currentUrl,
          sourceTitle
        };
        return openTargetAndDispatchTask(targetConfig, finalText, taskContext);
      })
    );

    return {
      ok: true,
      targetCount: targetConfigs.length
    };
  } catch (error) {
    console.error('Failed to trigger target auto-send flow:', error);
    return {
      ok: false,
      error: String(error)
    };
  }
}

/**
 * Handles test-only send flow trigger for headless E2E verification.
 * This keeps production entrypoints unchanged while allowing deterministic automation.
 * @param {{sourceUrl?: string, sourceTitle?: string}} message
 * @returns {Promise<{ok:boolean,targetCount?:number,error?:string}>}
 */
async function handleTestTriggerSendFlow(message) {
  const sourceUrl = typeof message.sourceUrl === 'string' ? message.sourceUrl.trim() : '';
  const sourceTitle = typeof message.sourceTitle === 'string' ? message.sourceTitle.trim() : '';

  if (sourceUrl) {
    if (!/^https?:\/\//.test(sourceUrl)) {
      return {
        ok: false,
        error: 'Invalid sourceUrl for test trigger.'
      };
    }

    return runSendFlow({
      url: sourceUrl,
      title: sourceTitle || sourceUrl
    });
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return runSendFlow(tabs[0]);
  } catch (error) {
    return {
      ok: false,
      error: String(error)
    };
  }
}

/**
 * Installs a minimal test API on service worker global scope.
 * CDP-based harness can call this API directly in headless mode.
 */
function installServiceWorkerTestApi() {
  try {
    self.__OMNISTITCH_TEST_API__ = {
      /**
       * Runs send flow with explicit source page values.
       * @param {string} sourceUrl
       * @param {string} sourceTitle
       * @returns {Promise<{ok:boolean,targetCount?:number,error?:string}>}
       */
      runSendFlowFromSource: async (sourceUrl, sourceTitle) => {
        return handleTestTriggerSendFlow({
          sourceUrl,
          sourceTitle
        });
      },

      /**
       * Runs send flow based on current active tab context.
       * @returns {Promise<{ok:boolean,targetCount?:number,error?:string}>}
       */
      runSendFlowFromActiveTab: async () => {
        return handleTestTriggerSendFlow({});
      }
    };
  } catch (error) {
    console.error('Failed to install service worker test API:', error);
  }
}

/**
 * Handles extension icon click.
 */
chrome.action.onClicked.addListener(async (tab) => {
  await runSendFlow(tab);
});

/**
 * Handles keyboard command and runs the same flow as extension icon click.
 */
chrome.commands.onCommand.addListener(async (command) => {
  logInfo('Command event received.', { command });
  if (command !== 'send-to-chatgpt') {
    return;
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    await runSendFlow(tabs[0]);
  } catch (error) {
    console.error('Failed to handle command send-to-chatgpt:', error);
  }
});

/**
 * Receives AI response capture results from content scripts.
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.action !== 'string') {
    return;
  }

  if (message.action === CAPTURE_NETWORK_TRACK_START_ACTION) {
    const tabId = Number(sender?.tab?.id);
    const taskId = typeof message.taskId === 'string' ? message.taskId.trim() : '';
    const targetSite = typeof message.targetSite === 'string' ? message.targetSite.trim() : 'unknown';
    if (!taskId || !Number.isInteger(tabId)) {
      sendResponse({ ok: false, error: 'Invalid taskId or sender tab id for network tracking start.' });
      return;
    }

    startWebRequestTrackingSession(taskId, tabId, targetSite);
    sendResponse({ ok: true, taskId, tabId, targetSite });
    return;
  }

  if (message.action === CAPTURE_NETWORK_TRACK_STOP_ACTION) {
    const taskId = typeof message.taskId === 'string' ? message.taskId.trim() : '';
    const reason = typeof message.reason === 'string' ? message.reason.trim() : 'content_stop';
    if (!taskId) {
      sendResponse({ ok: false, error: 'Missing taskId for network tracking stop.' });
      return;
    }

    stopWebRequestTrackingSession(taskId, reason || 'content_stop');
    sendResponse({ ok: true, taskId });
    return;
  }

  if (message.action === CAPTURE_NETWORK_WAIT_IDLE_ACTION) {
    const taskId = typeof message.taskId === 'string' ? message.taskId.trim() : '';
    const timeoutMs = Number(message.timeoutMs);
    if (!taskId) {
      sendResponse({ ok: false, error: 'Missing taskId for network idle wait.' });
      return;
    }

    waitForWebRequestTrackingIdle(taskId, timeoutMs)
      .then((status) => {
        sendResponse(status);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          taskId,
          timedOut: false,
          error: String(error)
        });
      });

    return true;
  }

  if (message.action === AI_RESPONSE_REPORT_ACTION) {
    handleAiResponseReport(message)
      .then((result) => {
        sendResponse(result);
      })
      .catch((error) => {
        console.error('Failed to handle AI response report:', error);
        sendResponse({ ok: false, error: String(error) });
      });

    return true;
  }

});

/**
 * Retries queued payloads on alarm trigger.
 */
chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== SYNC_RETRY_ALARM_NAME) {
    return;
  }

  retryQueuedSync().catch((error) => {
    console.error('Failed to retry queued sync:', error);
  });
});

/**
 * Keeps retry alarm and queue state fresh when extension starts/installs.
 */
chrome.runtime.onStartup.addListener(() => {
  scheduleSyncRetryAlarm().catch((error) => {
    console.error('Failed to refresh sync retry alarm on startup:', error);
  });
});

chrome.runtime.onInstalled.addListener(() => {
  scheduleSyncRetryAlarm().catch((error) => {
    console.error('Failed to refresh sync retry alarm on install:', error);
  });
});

/**
 * Re-evaluates queue and cache when sync settings change from options page.
 */
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !changes[SYNC_TARGET_SETTINGS_KEY]) {
    return;
  }

  retryQueuedSync().catch((error) => {
    console.error('Failed to retry queue after sync settings changed:', error);
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const taskId = webRequestTrackingTaskIdByTabId.get(tabId);
  if (!taskId) {
    return;
  }

  stopWebRequestTrackingSession(taskId, 'tab_removed');
});

if (chrome.webRequest) {
  chrome.webRequest.onBeforeRequest.addListener(handleWebRequestBeforeRequest, { urls: ['<all_urls>'] });
  chrome.webRequest.onCompleted.addListener(handleWebRequestFinished, { urls: ['<all_urls>'] });
  chrome.webRequest.onErrorOccurred.addListener(handleWebRequestFinished, { urls: ['<all_urls>'] });
} else {
  console.error('chrome.webRequest API is unavailable. Network idle gate will be skipped.');
}

logRegisteredCommands();
scheduleSyncRetryAlarm().catch((error) => {
  console.error('Failed to initialize sync retry alarm:', error);
});
installServiceWorkerTestApi();
