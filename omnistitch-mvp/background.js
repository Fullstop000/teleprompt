const PROMPT_STORE_KEY = 'prompt_store_v1';
const MESSAGE_ACTION = 'omnistitch_auto_send';
const CHATGPT_URL = 'https://chatgpt.com/';
const PROMPT_PARAM = 'q';
const MESSAGE_RETRY_LIMIT = 8;
const MESSAGE_RETRY_DELAY_MS = 600;
const BG_LOG_PREFIX = '[omnistitch][bg]';

/**
 * Writes a background debug log with a stable prefix.
 * @param {...unknown} args
 */
function logInfo(...args) {
  console.log(BG_LOG_PREFIX, ...args);
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
 * Builds ChatGPT target URL with encoded prompt payload in query string.
 * @param {string} finalText
 * @returns {string}
 */
function buildChatGptUrlWithPrompt(finalText) {
  try {
    const url = new URL(CHATGPT_URL);
    url.searchParams.set(PROMPT_PARAM, finalText);
    return url.toString();
  } catch (error) {
    console.error('Failed to build ChatGPT URL with prompt payload:', error);
    return CHATGPT_URL;
  }
}

/**
 * Sends final text payload to a ChatGPT tab via runtime message.
 * Retries are needed because SPA hydration can delay content script readiness.
 * @param {number} tabId
 * @param {string} finalText
 * @param {number} retry
 */
function sendTaskMessageToTab(tabId, finalText, retry = 0) {
  logInfo('Sending runtime message to tab.', {
    tabId,
    retry,
    payloadLength: finalText.length
  });
  chrome.tabs.sendMessage(
    tabId,
    {
      action: MESSAGE_ACTION,
      finalText
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
        sendTaskMessageToTab(tabId, finalText, retry + 1);
      }, MESSAGE_RETRY_DELAY_MS);
    }
  );
}

/**
 * Attaches one-time tab update listener and pushes task payload when target tab is ready.
 * @param {number} tabId
 * @param {string} finalText
 */
function attachTaskDeliveryListener(tabId, finalText) {
  const handleTabUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
      return;
    }

    logInfo('ChatGPT tab load complete, start task delivery.', { tabId });
    chrome.tabs.onUpdated.removeListener(handleTabUpdated);
    sendTaskMessageToTab(tabId, finalText);
  };

  chrome.tabs.onUpdated.addListener(handleTabUpdated);
}

/**
 * Executes the main send flow from a browser tab context.
 * @param {chrome.tabs.Tab|undefined} tab
 */
async function runSendFlow(tab) {
  try {
    const currentUrl = tab?.url;
    logInfo('Read active tab URL.', { currentUrl: currentUrl || null });
    if (!currentUrl || !/^https?:\/\//.test(currentUrl)) {
      console.error('Unsupported or empty URL:', currentUrl);
      return;
    }

    const promptStore = await loadPromptStore();
    const activePrompt = promptStore.prompts.find((item) => item.id === promptStore.activePromptId);
    const promptContent = activePrompt?.content || '请总结以下链接内容：\n';
    const finalText = buildFinalText(promptContent, currentUrl);
    const chatGptUrl = buildChatGptUrlWithPrompt(finalText);
    logInfo('Opening ChatGPT with query payload.', {
      chatGptUrl,
      payloadLength: finalText.length
    });
    const createdTab = await chrome.tabs.create({ url: chatGptUrl });
    logInfo('ChatGPT tab created.', { tabId: createdTab?.id ?? null });

    // Fallback path: push text by runtime message in case URL params are lost during redirects.
    if (createdTab?.id !== undefined) {
      attachTaskDeliveryListener(createdTab.id, finalText);
    }
  } catch (error) {
    console.error('Failed to trigger ChatGPT auto-send flow:', error);
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

logRegisteredCommands();
