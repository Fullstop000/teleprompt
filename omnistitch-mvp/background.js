const PROMPT_STORE_KEY = 'prompt_store_v1';
const MESSAGE_ACTION = 'omnistitch_auto_send';
const CHATGPT_URL = 'https://chatgpt.com/';
const MESSAGE_RETRY_LIMIT = 8;
const MESSAGE_RETRY_DELAY_MS = 600;

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
    return createDefaultStore();
  }
}

/**
 * Builds a text payload from the active prompt template and target URL.
 * @param {string} promptTemplate
 * @param {string} url
 * @returns {string}
 */
function buildFinalText(promptTemplate, url) {
  return `${promptTemplate}${url}`;
}

/**
 * Sends final text payload to a ChatGPT tab via runtime message.
 * Retries are needed because SPA hydration can delay content script readiness.
 * @param {number} tabId
 * @param {string} finalText
 * @param {number} retry
 */
function sendTaskMessageToTab(tabId, finalText, retry = 0) {
  chrome.tabs.sendMessage(
    tabId,
    {
      action: MESSAGE_ACTION,
      finalText
    },
    () => {
      const err = chrome.runtime.lastError;
      if (!err) {
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
    if (!currentUrl || !/^https?:\/\//.test(currentUrl)) {
      console.error('Unsupported or empty URL:', currentUrl);
      return;
    }

    const promptStore = await loadPromptStore();
    const activePrompt = promptStore.prompts.find((item) => item.id === promptStore.activePromptId);
    const promptContent = activePrompt?.content || '请总结以下链接内容：\n';
    const finalText = buildFinalText(promptContent, currentUrl);
    const createdTab = await chrome.tabs.create({ url: CHATGPT_URL });

    // Primary path: push text directly to content script to avoid query-param loss on redirects.
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
