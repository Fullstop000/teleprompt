const TASK_PREFIX = 'omnistitch_task_';
const TASK_PARAM = 'omnistitch_task';
const PROMPT_PARAM = 'q';
const LEGACY_PROMPT_PARAM = 'omnistitch_prompt';
const MESSAGE_ACTION = 'omnistitch_auto_send';
const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 250;
const DEDUPE_WINDOW_MS = 15000;
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
let lastExecutedAt = 0;

/**
 * Writes a content-script debug log with a stable prefix.
 * @param {...unknown} args
 */
function logInfo(...args) {
  console.log(CONTENT_LOG_PREFIX, ...args);
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
 */
function markExecution(text) {
  lastExecutedText = text;
  lastExecutedAt = Date.now();
}

/**
 * Checks whether the payload was already executed recently.
 * @param {string} text
 * @returns {boolean}
 */
function isRecentlyExecuted(text) {
  if (!text || !lastExecutedText) {
    return false;
  }

  const isSameText = text === lastExecutedText;
  const withinWindow = Date.now() - lastExecutedAt <= DEDUPE_WINDOW_MS;
  return isSameText && withinWindow;
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
    const fromQ = searchParams.get(PROMPT_PARAM);
    const fromLegacy = searchParams.get(LEGACY_PROMPT_PARAM);
    const prompt = fromQ || fromLegacy;
    logInfo('Read prompt from URL.', {
      source: fromQ ? PROMPT_PARAM : fromLegacy ? LEGACY_PROMPT_PARAM : null,
      promptLength: prompt ? prompt.length : 0
    });
    return prompt || null;
  } catch (error) {
    console.error('Failed to parse prompt from URL:', error);
    return null;
  }
}

/**
 * Removes prompt payload from URL to avoid duplicate sending on refresh.
 */
function clearPromptFromUrl() {
  try {
    const url = new URL(window.location.href);
    const hasCurrent = url.searchParams.has(PROMPT_PARAM);
    const hasLegacy = url.searchParams.has(LEGACY_PROMPT_PARAM);
    if (!hasCurrent && !hasLegacy) {
      return;
    }

    url.searchParams.delete(PROMPT_PARAM);
    url.searchParams.delete(LEGACY_PROMPT_PARAM);
    history.replaceState(null, document.title, url.toString());
    logInfo('Prompt params cleared from URL.');
  } catch (error) {
    console.error('Failed to clear prompt from URL:', error);
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
 * Runs composer fill + send flow from provided text.
 * @param {string} finalText
 * @param {string|undefined} preferredSiteId
 */
async function runWithText(finalText, preferredSiteId) {
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

    if (isRecentlyExecuted(finalText)) {
      logInfo('Skip duplicate payload in dedupe window.', { textLength: finalText.length });
      return;
    }

    const adapter = getSiteAdapterById(preferredSiteId) || detectCurrentSiteAdapter();
    if (!adapter) {
      console.error('No site adapter matched for current page:', window.location.hostname);
      return;
    }

    markExecution(finalText);
    const composer = await waitForComposer(adapter);
    logInfo('Composer ready, writing prompt.', { site: adapter.id, textLength: finalText.length });
    fillComposer(composer, finalText);

    // Give UI state a short time to enable send action.
    setTimeout(() => {
      try {
        triggerSend(adapter, composer);
      } catch (error) {
        console.error('Failed to trigger send action:', error);
      }
    }, 500);
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
      console.error('Task payload not found for key:', storageKey);
      return;
    }

    await runWithText(task.finalText);
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
    logInfo('Starting URL prompt auto-send flow.');
    await runWithText(prompt);
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

  if (isRecentlyExecuted(message.finalText)) {
    logInfo('Skip duplicate runtime message payload.', {
      textLength: message.finalText ? message.finalText.length : 0
    });
    sendResponse({ ok: true, skipped: true });
    return;
  }

  const adapterFromMessage = getSiteAdapterById(message.targetSite);
  if (adapterFromMessage) {
    logInfo('Received runtime task with target site.', { targetSite: adapterFromMessage.id });
  }

  runWithText(message.finalText, message.targetSite)
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
