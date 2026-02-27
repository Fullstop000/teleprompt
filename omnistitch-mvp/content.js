const TASK_PREFIX = 'omnistitch_task_';
const TASK_PARAM = 'omnistitch_task';
const MESSAGE_ACTION = 'omnistitch_auto_send';
const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 250;

let isRunning = false;

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
 * Waits until a ChatGPT composer element is available.
 * Supports textarea and contenteditable composer variants.
 * @returns {Promise<HTMLElement>}
 */
function waitForComposer() {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      const composer =
        document.querySelector('textarea#prompt-textarea') ||
        document.querySelector('textarea[data-id="root"]') ||
        document.querySelector('textarea') ||
        document.querySelector('div[contenteditable="true"][id="prompt-textarea"]') ||
        document.querySelector('div[contenteditable="true"][role="textbox"]') ||
        document.querySelector('div[contenteditable="true"]');

      if (composer) {
        clearInterval(timer);
        resolve(composer);
        return;
      }

      if (Date.now() - startedAt > MAX_WAIT_MS) {
        clearInterval(timer);
        reject(new Error('Timed out waiting for ChatGPT composer'));
      }
    }, POLL_INTERVAL_MS);
  });
}

/**
 * Finds a likely send button on ChatGPT page.
 * @returns {HTMLButtonElement|null}
 */
function findSendButton() {
  return (
    document.querySelector('button[data-testid="send-button"]') ||
    document.querySelector('button[aria-label*="Send"]') ||
    document.querySelector('button[aria-label*="发送"]')
  );
}

/**
 * Fills text into ChatGPT composer and dispatches input event for framework state sync.
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
 * @param {HTMLElement} composer
 */
function triggerSend(composer) {
  const sendButton = findSendButton();
  if (sendButton && !sendButton.disabled) {
    sendButton.click();
    return;
  }

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
 */
async function runWithText(finalText) {
  if (isRunning) {
    return;
  }

  isRunning = true;
  try {
    if (!finalText || typeof finalText !== 'string') {
      console.error('Invalid finalText payload.');
      return;
    }

    const composer = await waitForComposer();
    fillComposer(composer, finalText);

    // Give UI state a short time to enable send action.
    setTimeout(() => {
      try {
        triggerSend(composer);
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
 * Primary path: receive payload directly from background service worker.
 */
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.action !== MESSAGE_ACTION) {
    return;
  }

  runWithText(message.finalText).catch((error) => {
    console.error('Failed to handle runtime task message:', error);
  });
});

runFromTaskId();
