const PROMPT_STORE_KEY = 'prompt_store_v1';
const TARGET_STORE_KEY = 'target_site_v1';
const MESSAGE_ACTION = 'omnistitch_auto_send';
const DEFAULT_TARGET_SITE = 'chatgpt';
const PROMPT_PARAM = 'q';
const MESSAGE_RETRY_LIMIT = 8;
const MESSAGE_RETRY_DELAY_MS = 600;
const BG_LOG_PREFIX = '[omnistitch][bg]';
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
  }
};

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
 * Creates the default jump-target settings.
 * @returns {{targetSites: string[]}}
 */
function createDefaultTargetSettings() {
  return {
    targetSites: [DEFAULT_TARGET_SITE]
  };
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
    normalizedSet.add(DEFAULT_TARGET_SITE);
  }

  return {
    targetSites: Array.from(normalizedSet)
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
    const hasSameShape =
      data[TARGET_STORE_KEY] &&
      Array.isArray(data[TARGET_STORE_KEY].targetSites) &&
      data[TARGET_STORE_KEY].targetSites.length === normalized.targetSites.length &&
      data[TARGET_STORE_KEY].targetSites.every((site) => normalized.targetSites.includes(site));

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
 * Builds target URL and attaches prompt query payload when supported.
 * @param {{id: string, name: string, baseUrl: string, promptParam: string|null}} targetConfig
 * @param {string} finalText
 * @returns {string}
 */
function buildTargetUrl(targetConfig, finalText) {
  try {
    const url = new URL(targetConfig.baseUrl);
    if (targetConfig.promptParam) {
      url.searchParams.set(targetConfig.promptParam, finalText);
    }

    return url.toString();
  } catch (error) {
    console.error('Failed to build target URL with prompt payload:', error);
    return targetConfig.baseUrl;
  }
}

/**
 * Sends final text payload to target tab via runtime message.
 * Retries are needed because SPA hydration can delay content script readiness.
 * @param {number} tabId
 * @param {string} targetSite
 * @param {string} finalText
 * @param {number} retry
 */
function sendTaskMessageToTab(tabId, targetSite, finalText, retry = 0) {
  logInfo('Sending runtime message to tab.', {
    tabId,
    targetSite,
    retry,
    payloadLength: finalText.length
  });
  chrome.tabs.sendMessage(
    tabId,
    {
      action: MESSAGE_ACTION,
      targetSite,
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
        sendTaskMessageToTab(tabId, targetSite, finalText, retry + 1);
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
 */
function attachTaskDeliveryListener(targetSite, targetName, tabId, finalText) {
  const handleTabUpdated = (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') {
      return;
    }

    logInfo('Target tab load complete, start task delivery.', {
      targetName,
      targetSite,
      tabId
    });
    chrome.tabs.onUpdated.removeListener(handleTabUpdated);
    sendTaskMessageToTab(tabId, targetSite, finalText);
  };

  chrome.tabs.onUpdated.addListener(handleTabUpdated);
}

/**
 * Opens target site and schedules task delivery by runtime message.
 * @param {{id: string, name: string, baseUrl: string, promptParam: string|null}} targetConfig
 * @param {string} finalText
 */
async function openTargetAndDispatchTask(targetConfig, finalText) {
  const targetUrl = buildTargetUrl(targetConfig, finalText);
  logInfo('Opening target tab with payload.', {
    targetSite: targetConfig.id,
    targetName: targetConfig.name,
    targetUrl,
    payloadLength: finalText.length
  });

  const createdTab = await chrome.tabs.create({ url: targetUrl });
  logInfo('Target tab created.', {
    targetSite: targetConfig.id,
    targetName: targetConfig.name,
    tabId: createdTab?.id ?? null
  });

  if (createdTab?.id === undefined) {
    console.error('Failed to create target tab or tab id missing.');
    return;
  }

  // Always deliver via runtime message for consistent behavior across target sites.
  attachTaskDeliveryListener(targetConfig.id, targetConfig.name, createdTab.id, finalText);
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

    const targetSettings = await loadTargetSettings();
    const targetConfigs = resolveEnabledTargetConfigs(targetSettings);
    await Promise.all(targetConfigs.map((targetConfig) => openTargetAndDispatchTask(targetConfig, finalText)));
  } catch (error) {
    console.error('Failed to trigger target auto-send flow:', error);
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
