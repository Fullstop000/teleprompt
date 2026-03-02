const TASK_PREFIX = 'omnistitch_task_';
const TASK_PARAM = 'omnistitch_task';
const PROMPT_PARAM = 'q';
const MESSAGE_ACTION = 'omnistitch_auto_send';
const AI_RESPONSE_REPORT_ACTION = 'omnistitch_ai_response_report';
const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 250;
const DEDUPE_WINDOW_MS = 15000;
const RESPONSE_CAPTURE_TIMEOUT_MS = 180000;
const RESPONSE_CAPTURE_POLL_MS = 1000;
const RESPONSE_STABLE_ROUNDS = 3;
const MIN_RESPONSE_TEXT_LENGTH = 20;
const CONTENT_LOG_PREFIX = '[omnistitch][content]';
const GENERIC_RESPONSE_SELECTORS = [
  '[data-message-author-role="assistant"]',
  'div[class*="assistant-message"]',
  'div[class*="model-response"]',
  'div[class*="markdown"]'
];
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
    ],
    responseSelectors: [
      'div[data-message-author-role="assistant"]',
      'article [data-message-author-role="assistant"]',
      'main [data-message-author-role="assistant"]'
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
    ],
    responseSelectors: ['div.markdown___vuBDJ', 'div[class*="assistant"] div[class*="markdown"]', 'div.segment-content']
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
    ],
    responseSelectors: ['div.ds-markdown', 'div[class*="assistant"] div.markdown', 'div.markdown']
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
    ],
    responseSelectors: ['message-content .markdown', 'div.model-response-text', 'div[class*="response-content"]']
  }
];

let isRunning = false;
let lastExecutedText = '';
let lastExecutedTaskId = '';
let lastExecutedAt = 0;
const reportingTaskIds = new Set();
const reportedTaskIds = new Set();

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
 * @returns {{id:string,name:string,hostnames:string[],composerSelectors:string[],sendButtonSelectors:string[],responseSelectors:string[]} | null}
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
 * @returns {{id:string,name:string,hostnames:string[],composerSelectors:string[],sendButtonSelectors:string[],responseSelectors:string[]} | null}
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
    if (!hasCurrent && !hasTask) {
      return;
    }

    url.searchParams.delete(PROMPT_PARAM);
    url.searchParams.delete(TASK_PARAM);
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
 * @param {{taskId?: string, sourceUrl?: string}|undefined} incomingTaskContext
 * @returns {{taskId: string, targetSite: string, sourceUrl: string}}
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

  return {
    taskId,
    targetSite: adapter.id,
    sourceUrl
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
 * Collects assistant response texts from the current page by selector strategy.
 * @param {{responseSelectors:string[]}} adapter
 * @returns {string[]}
 */
function collectAssistantResponseTexts(adapter) {
  const selectors = [...adapter.responseSelectors, ...GENERIC_RESPONSE_SELECTORS];
  const texts = [];
  const seen = new Set();

  for (const selector of selectors) {
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (error) {
      continue;
    }

    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) {
        continue;
      }

      const normalized = normalizeCapturedText(node.innerText || node.textContent || '');
      if (!normalized || normalized.length < MIN_RESPONSE_TEXT_LENGTH || seen.has(normalized)) {
        continue;
      }

      seen.add(normalized);
      texts.push(normalized);
    }
  }

  return texts;
}

/**
 * Picks latest response candidate that was not in baseline snapshot.
 * @param {string[]} currentResponses
 * @param {Set<string>} baselineResponses
 * @returns {string|null}
 */
function pickLatestFreshResponse(currentResponses, baselineResponses) {
  const freshResponses = currentResponses.filter((item) => !baselineResponses.has(item));
  if (freshResponses.length > 0) {
    return freshResponses[freshResponses.length - 1];
  }

  return null;
}

/**
 * Waits until one fresh assistant response becomes stable across several polls.
 * @param {{id:string,responseSelectors:string[]}} adapter
 * @param {Set<string>} baselineResponses
 * @returns {Promise<string>}
 */
function waitForStableAssistantResponse(adapter, baselineResponses) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let lastCandidate = '';
    let stableRounds = 0;

    const timer = setInterval(() => {
      try {
        const currentResponses = collectAssistantResponseTexts(adapter);
        const candidate = pickLatestFreshResponse(currentResponses, baselineResponses);

        if (candidate) {
          if (candidate === lastCandidate) {
            stableRounds += 1;
          } else {
            lastCandidate = candidate;
            stableRounds = 1;
          }

          if (stableRounds >= RESPONSE_STABLE_ROUNDS) {
            clearInterval(timer);
            resolve(candidate);
            return;
          }
        }

        if (Date.now() - startedAt > RESPONSE_CAPTURE_TIMEOUT_MS) {
          clearInterval(timer);
          reject(new Error(`Timed out waiting for assistant response on ${adapter.id}`));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, RESPONSE_CAPTURE_POLL_MS);
  });
}

/**
 * Reports one captured assistant response back to background for Notion syncing.
 * @param {{taskId: string, targetSite: string, sourceUrl: string}} taskContext
 * @param {string} responseText
 */
async function reportAssistantResponse(taskContext, responseText) {
  if (!taskContext.taskId || !responseText) {
    return;
  }

  await sendRuntimeMessage({
    action: AI_RESPONSE_REPORT_ACTION,
    taskId: taskContext.taskId,
    targetSite: taskContext.targetSite,
    sourceUrl: taskContext.sourceUrl,
    aiResponse: responseText,
    capturedAt: new Date().toISOString()
  });
}

/**
 * Starts async response capture and report pipeline for one dispatched task.
 * @param {{id:string,responseSelectors:string[]}} adapter
 * @param {{taskId: string, targetSite: string, sourceUrl: string}} taskContext
 * @param {Set<string>} baselineResponses
 */
function startAssistantResponseCapture(adapter, taskContext, baselineResponses) {
  if (!taskContext.taskId || reportingTaskIds.has(taskContext.taskId) || reportedTaskIds.has(taskContext.taskId)) {
    return;
  }

  reportingTaskIds.add(taskContext.taskId);
  waitForStableAssistantResponse(adapter, baselineResponses)
    .then(async (responseText) => {
      await reportAssistantResponse(taskContext, responseText);
      reportedTaskIds.add(taskContext.taskId);
      logInfo('Assistant response captured and reported.', {
        site: adapter.id,
        taskId: taskContext.taskId,
        responseLength: responseText.length
      });
    })
    .catch((error) => {
      console.error('Failed to capture assistant response:', error);
    })
    .finally(() => {
      reportingTaskIds.delete(taskContext.taskId);
    });
}

/**
 * Runs composer fill + send flow from provided text.
 * @param {string} finalText
 * @param {string|undefined} preferredSiteId
 * @param {{taskId?: string, sourceUrl?: string}|undefined} incomingTaskContext
 */
async function runWithText(finalText, preferredSiteId, incomingTaskContext) {
  if (isRunning) {
    logInfo('Auto-send already in progress, skip new payload.');
    return;
  }

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

    const taskContext = resolveTaskContext(adapter, incomingTaskContext);
    if (isRecentlyExecuted(finalText, taskContext.taskId)) {
      logInfo('Skip duplicate payload in dedupe window.', {
        textLength: finalText.length,
        taskId: taskContext.taskId
      });
      return;
    }

    const baselineResponses = new Set(collectAssistantResponseTexts(adapter));

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
    startAssistantResponseCapture(adapter, taskContext, baselineResponses);
  } catch (error) {
    console.error('Failed to run auto-send flow:', error);
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
      sourceUrl: task.sourceUrl || ''
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
    logInfo('Starting URL prompt auto-send flow.', { taskId: taskId || null });
    await runWithText(prompt, undefined, { taskId });
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
    sourceUrl: message.sourceUrl
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
