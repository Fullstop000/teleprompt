try {
  importScripts('notion-provider.js');
} catch (error) {
  console.error('Failed to load notion provider script:', error);
}
try {
  importScripts('webhook-provider.js');
} catch (error) {
  console.error('Failed to load webhook provider script:', error);
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
const MESSAGE_RETRY_LIMIT = 8;
const MESSAGE_RETRY_DELAY_MS = 600;
const SYNC_RETRY_ALARM_NAME = 'omnistitch_sync_retry_alarm';
const SYNC_RETRY_DELAY_MINUTES = 5;
const SYNC_RETRY_MAX_ATTEMPTS = 20;
const BG_LOG_PREFIX = '[omnistitch][bg]';
const SYNC_PROVIDER_IDS = {
  DISABLED: 'disabled',
  NOTION: 'notion',
  WEBHOOK: 'webhook'
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
    targetSites: ['chatgpt', 'kimi', 'deepseek', 'gemini']
  };
}

/**
 * Creates the default sync-target settings.
 * disabled means capture is enabled but no external sync provider is active.
 * @returns {{provider:string,autoSync:boolean,retryEnabled:boolean,notionToken:string,notionDatabaseId:string,webhookUrl:string,webhookAuthToken:string}}
 */
function createDefaultSyncTargetSettings() {
  return {
    provider: SYNC_PROVIDER_IDS.DISABLED,
    autoSync: true,
    retryEnabled: true,
    notionToken: '',
    notionDatabaseId: '',
    webhookUrl: '',
    webhookAuthToken: ''
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
    provider === SYNC_PROVIDER_IDS.NOTION ||
    provider === SYNC_PROVIDER_IDS.WEBHOOK
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
 * @returns {{provider:string,autoSync:boolean,retryEnabled:boolean,notionToken:string,notionDatabaseId:string,webhookUrl:string,webhookAuthToken:string}}
 */
function normalizeSyncTargetSettings(settings) {
  const defaults = createDefaultSyncTargetSettings();
  const data = settings && typeof settings === 'object' ? settings : {};

  const rawProvider = typeof data.provider === 'string' ? data.provider.trim() : '';
  const notionToken =
    typeof data.notionToken === 'string' ? data.notionToken.trim() : defaults.notionToken;
  const notionDatabaseId =
    typeof data.notionDatabaseId === 'string' ? data.notionDatabaseId.trim() : defaults.notionDatabaseId;
  const webhookUrl = typeof data.webhookUrl === 'string' ? data.webhookUrl.trim() : defaults.webhookUrl;
  const webhookAuthToken =
    typeof data.webhookAuthToken === 'string' ? data.webhookAuthToken.trim() : defaults.webhookAuthToken;
  const autoSync = typeof data.autoSync === 'boolean' ? data.autoSync : defaults.autoSync;
  const retryEnabled = typeof data.retryEnabled === 'boolean' ? data.retryEnabled : defaults.retryEnabled;

  const provider = isValidProvider(rawProvider) ? rawProvider : defaults.provider;

  return {
    provider,
    autoSync,
    retryEnabled,
    notionToken,
    notionDatabaseId,
    webhookUrl,
    webhookAuthToken
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
 * @returns {Promise<{provider:string,autoSync:boolean,retryEnabled:boolean,notionToken:string,notionDatabaseId:string,webhookUrl:string,webhookAuthToken:string}>}
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
      raw.notionToken === normalized.notionToken &&
      raw.notionDatabaseId === normalized.notionDatabaseId &&
      raw.webhookUrl === normalized.webhookUrl &&
      raw.webhookAuthToken === normalized.webhookAuthToken;

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
 * @returns {Promise<Array<{id:string,payload:{taskId:string,targetSite:string,sourceUrl:string,aiResponse:string,capturedAt:string},providerId:string,attempts:number,lastError:string,updatedAt:string}>>}
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
 * @param {Array<{id:string,payload:{taskId:string,targetSite:string,sourceUrl:string,aiResponse:string,capturedAt:string},providerId:string,attempts:number,lastError:string,updatedAt:string}>} queue
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
 * @param {{notionToken:string,notionDatabaseId:string,webhookUrl:string}} settings
 * @param {string} providerId
 * @returns {boolean}
 */
function hasProviderCredentials(settings, providerId) {
  if (providerId === SYNC_PROVIDER_IDS.DISABLED) {
    return true;
  }

  if (providerId === SYNC_PROVIDER_IDS.NOTION) {
    return Boolean(settings.notionToken && settings.notionDatabaseId);
  }

  if (providerId === SYNC_PROVIDER_IDS.WEBHOOK) {
    return Boolean(settings.webhookUrl);
  }

  return false;
}

/**
 * Creates human-readable credential error for active provider.
 * @param {string} providerId
 * @returns {string}
 */
function buildProviderCredentialError(providerId) {
  if (providerId === SYNC_PROVIDER_IDS.NOTION) {
    return 'Notion token/databaseId is not configured.';
  }

  if (providerId === SYNC_PROVIDER_IDS.WEBHOOK) {
    return 'Webhook URL is not configured.';
  }

  return 'Sync provider is not configured.';
}

/**
 * Normalizes one AI response report payload before syncing.
 * @param {{taskId?: string, targetSite?: string, sourceUrl?: string, aiResponse?: string, capturedAt?: string}} message
 * @returns {{taskId: string, targetSite: string, sourceUrl: string, aiResponse: string, capturedAt: string}}
 */
function normalizeAiResponsePayload(message) {
  const taskId = typeof message.taskId === 'string' ? message.taskId.trim() : '';
  if (!taskId) {
    throw new Error('Missing taskId for AI response report.');
  }

  const targetSite =
    typeof message.targetSite === 'string' && message.targetSite.trim() ? message.targetSite.trim() : 'unknown';
  const sourceUrl = typeof message.sourceUrl === 'string' ? message.sourceUrl.trim() : '';
  const aiResponse = typeof message.aiResponse === 'string' ? message.aiResponse.trim() : '';
  if (!aiResponse) {
    throw new Error('AI response content is empty.');
  }

  const capturedDate = new Date(message.capturedAt || Date.now());
  const capturedAt = Number.isNaN(capturedDate.getTime()) ? new Date().toISOString() : capturedDate.toISOString();

  return {
    taskId,
    targetSite,
    sourceUrl,
    aiResponse,
    capturedAt
  };
}

/**
 * Reads Notion provider API from service worker global scope.
 * @returns {{sync: Function, clearCache: Function}}
 */
function getNotionProvider() {
  const provider = self.OmnistitchNotionProvider;
  if (!provider || typeof provider.sync !== 'function' || typeof provider.clearCache !== 'function') {
    throw new Error('Notion provider is unavailable.');
  }

  return provider;
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
 * Dispatches sync payload to active provider implementation.
 * @param {{taskId: string, targetSite: string, sourceUrl: string, aiResponse: string, capturedAt: string}} payload
 * @param {{provider:string,notionToken:string,notionDatabaseId:string,webhookUrl:string,webhookAuthToken:string}} settings
 * @param {string} providerId
 */
async function syncPayloadToProvider(payload, settings, providerId) {
  if (providerId === SYNC_PROVIDER_IDS.NOTION) {
    const notionProvider = getNotionProvider();
    await notionProvider.sync(payload, settings);
    return;
  }

  if (providerId === SYNC_PROVIDER_IDS.WEBHOOK) {
    const webhookProvider = getWebhookProvider();
    await webhookProvider.sync(payload, settings);
    return;
  }

  if (providerId === SYNC_PROVIDER_IDS.DISABLED) {
    return;
  }

  throw new Error(`Unsupported sync provider: ${providerId}`);
}

/**
 * Adds one failed payload into local retry queue.
 * @param {{taskId: string, targetSite: string, sourceUrl: string, aiResponse: string, capturedAt: string}} payload
 * @param {string} providerId
 * @param {string} lastError
 */
async function enqueueSyncRetry(payload, providerId, lastError) {
  const queue = await loadSyncRetryQueue();
  queue.push({
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    payload,
    providerId,
    attempts: 0,
    lastError,
    updatedAt: new Date().toISOString()
  });

  await saveSyncRetryQueue(queue);
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
 * @param {{taskId?: string, targetSite?: string, sourceUrl?: string, aiResponse?: string, capturedAt?: string}} message
 * @returns {Promise<{ok: boolean, queued?: boolean, skipped?: boolean, error?: string}>}
 */
async function handleAiResponseReport(message) {
  const payload = normalizeAiResponsePayload(message);
  const syncSettings = await loadSyncTargetSettings();
  const providerId = resolveActiveProvider(syncSettings);

  if (!syncSettings.autoSync || providerId === SYNC_PROVIDER_IDS.DISABLED) {
    return { ok: true, skipped: true };
  }

  if (!hasProviderCredentials(syncSettings, providerId)) {
    const error = buildProviderCredentialError(providerId);
    if (syncSettings.retryEnabled) {
      await enqueueSyncRetry(payload, providerId, error);
      return { ok: true, queued: true };
    }

    return { ok: false, error };
  }

  try {
    await syncPayloadToProvider(payload, syncSettings, providerId);
    return { ok: true };
  } catch (error) {
    console.error('Failed to sync AI response:', error);
    if (syncSettings.retryEnabled) {
      await enqueueSyncRetry(payload, providerId, String(error));
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
 * @param {{taskId: string, sourceUrl: string}} taskContext
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
      sourceUrl: taskContext.sourceUrl
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
 * @param {{taskId: string, sourceUrl: string}} taskContext
 */
function attachTaskDeliveryListener(targetSite, targetName, tabId, finalText, taskContext) {
  const handleTabUpdated = (updatedTabId, changeInfo) => {
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
 * @param {{taskId: string, sourceUrl: string}} taskContext
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
          sourceUrl: currentUrl
        };
        return openTargetAndDispatchTask(targetConfig, finalText, taskContext);
      })
    );
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

/**
 * Receives AI response capture results from content scripts.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.action !== AI_RESPONSE_REPORT_ACTION) {
    return;
  }

  handleAiResponseReport(message)
    .then((result) => {
      sendResponse(result);
    })
    .catch((error) => {
      console.error('Failed to handle AI response report:', error);
      sendResponse({ ok: false, error: String(error) });
    });

  return true;
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

  try {
    const notionProvider = getNotionProvider();
    notionProvider.clearCache();
  } catch (error) {
    console.error('Failed to clear notion provider cache:', error);
  }
  retryQueuedSync().catch((error) => {
    console.error('Failed to retry queue after sync settings changed:', error);
  });
});

logRegisteredCommands();
scheduleSyncRetryAlarm().catch((error) => {
  console.error('Failed to initialize sync retry alarm:', error);
});
