const STORAGE_KEY = 'prompt_store_v1';
const TARGET_STORE_KEY = 'target_site_v1';
const SYNC_TARGET_SETTINGS_KEY = 'sync_target_settings_v1';
const VALID_TARGET_SITES = ['chatgpt', 'kimi', 'deepseek', 'gemini'];
const TARGET_SITE_LABELS = {
  chatgpt: 'ChatGPT',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  gemini: 'Gemini'
};
const SYNC_PROVIDER_IDS = {
  DISABLED: 'disabled',
  NOTION: 'notion',
  WEBHOOK: 'webhook',
  OBSIDIAN: 'obsidian'
};

/**
 * Generates a unique id for a prompt item.
 * @returns {string}
 */
function generateId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Creates the default prompt store for first-time usage.
 * @returns {{prompts: Array<{id:string,title:string,content:string}>, activePromptId: string}}
 */
function createDefaultStore() {
  const defaultId = generateId();
  return {
    prompts: [
      {
        id: defaultId,
        title: '博客总结',
        content: '请用中文总结这篇文章的核心观点，并给出3条可执行建议：\n'
      }
    ],
    activePromptId: defaultId
  };
}

/**
 * Creates default target settings for jump destination.
 * @returns {{targetSites: Array<'chatgpt'|'kimi'|'deepseek'|'gemini'>}}
 */
function createDefaultTargetSettings() {
  return {
    targetSites: [...VALID_TARGET_SITES]
  };
}

/**
 * Creates default sync-target settings.
 * @returns {{provider:string,autoSync:boolean,retryEnabled:boolean,notionToken:string,notionDatabaseId:string,webhookUrl:string,webhookAuthToken:string,obsidianBaseUrl:string,obsidianApiKey:string}}
 */
function createDefaultSyncTargetSettings() {
  return {
    provider: SYNC_PROVIDER_IDS.DISABLED,
    autoSync: true,
    retryEnabled: true,
    notionToken: '',
    notionDatabaseId: '',
    webhookUrl: '',
    webhookAuthToken: '',
    obsidianBaseUrl: 'https://127.0.0.1:27124',
    obsidianApiKey: ''
  };
}

/**
 * Checks whether one provider id is supported.
 * @param {string|undefined} provider
 * @returns {boolean}
 */
function isValidProvider(provider) {
  return (
    provider === SYNC_PROVIDER_IDS.DISABLED ||
    provider === SYNC_PROVIDER_IDS.NOTION ||
    provider === SYNC_PROVIDER_IDS.WEBHOOK ||
    provider === SYNC_PROVIDER_IDS.OBSIDIAN
  );
}

/**
 * Normalizes target settings and keeps backward compatibility with old single-target schema.
 * @param {{targetSites?: string[], targetSite?: string}|undefined} settings
 * @returns {{targetSites: Array<'chatgpt'|'kimi'|'deepseek'|'gemini'>}}
 */
function normalizeTargetSettings(settings) {
  const normalizedSet = new Set();

  if (settings && Array.isArray(settings.targetSites)) {
    for (const site of settings.targetSites) {
      if (VALID_TARGET_SITES.includes(site)) {
        normalizedSet.add(site);
      }
    }
  }

  if (settings && typeof settings.targetSite === 'string' && VALID_TARGET_SITES.includes(settings.targetSite)) {
    normalizedSet.add(settings.targetSite);
  }

  if (normalizedSet.size === 0) {
    for (const siteId of VALID_TARGET_SITES) {
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
 * @returns {{provider:string,autoSync:boolean,retryEnabled:boolean,notionToken:string,notionDatabaseId:string,webhookUrl:string,webhookAuthToken:string,obsidianBaseUrl:string,obsidianApiKey:string}}
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
    notionToken,
    notionDatabaseId,
    webhookUrl,
    webhookAuthToken,
    obsidianBaseUrl,
    obsidianApiKey
  };
}

/**
 * Loads prompt store from extension local storage and initializes defaults if missing.
 * @returns {Promise<{prompts: Array<{id:string,title:string,content:string}>, activePromptId: string}>}
 */
async function loadStore() {
  try {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const store = data[STORAGE_KEY];

    if (!store || !Array.isArray(store.prompts) || store.prompts.length === 0) {
      const defaultStore = createDefaultStore();
      await chrome.storage.local.set({ [STORAGE_KEY]: defaultStore });
      return defaultStore;
    }

    const activeExists = store.prompts.some((item) => item.id === store.activePromptId);
    if (!activeExists) {
      store.activePromptId = store.prompts[0].id;
      await chrome.storage.local.set({ [STORAGE_KEY]: store });
    }

    return store;
  } catch (error) {
    console.error('Failed to load prompt store:', error);
    return createDefaultStore();
  }
}

/**
 * Loads target settings from extension local storage and initializes defaults if missing.
 * @returns {Promise<{targetSites: Array<'chatgpt'|'kimi'|'deepseek'|'gemini'>}>}
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
 * Loads sync-target settings from extension local storage.
 * @returns {Promise<{provider:string,autoSync:boolean,retryEnabled:boolean,notionToken:string,notionDatabaseId:string,webhookUrl:string,webhookAuthToken:string,obsidianBaseUrl:string,obsidianApiKey:string}>}
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
 * Saves prompt store to extension local storage.
 * @param {{prompts: Array<{id:string,title:string,content:string}>, activePromptId: string}} store
 * @returns {Promise<void>}
 */
async function saveStore(store) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
  } catch (error) {
    console.error('Failed to save prompt store:', error);
    throw error;
  }
}

/**
 * Saves target settings to extension local storage.
 * @param {{targetSites: Array<'chatgpt'|'kimi'|'deepseek'|'gemini'>}} settings
 * @returns {Promise<void>}
 */
async function saveTargetSettings(settings) {
  try {
    await chrome.storage.local.set({ [TARGET_STORE_KEY]: settings });
  } catch (error) {
    console.error('Failed to save target settings:', error);
    throw error;
  }
}

/**
 * Saves sync-target settings to extension local storage.
 * @param {{provider:string,autoSync:boolean,retryEnabled:boolean,notionToken:string,notionDatabaseId:string,webhookUrl:string,webhookAuthToken:string,obsidianBaseUrl:string,obsidianApiKey:string}} settings
 * @returns {Promise<void>}
 */
async function saveSyncTargetSettings(settings) {
  try {
    await chrome.storage.local.set({ [SYNC_TARGET_SETTINGS_KEY]: settings });
  } catch (error) {
    console.error('Failed to save sync target settings:', error);
    throw error;
  }
}

/**
 * Renders sync provider-specific fields.
 * @param {string} provider
 * @param {HTMLElement} notionFields
 * @param {HTMLElement} webhookFields
 * @param {HTMLElement} obsidianFields
 */
function renderSyncProviderFields(provider, notionFields, webhookFields, obsidianFields) {
  notionFields.hidden = provider !== SYNC_PROVIDER_IDS.NOTION;
  webhookFields.hidden = provider !== SYNC_PROVIDER_IDS.WEBHOOK;
  obsidianFields.hidden = provider !== SYNC_PROVIDER_IDS.OBSIDIAN;
}

/**
 * Renders prompt items and binds button events.
 * @param {{prompts: Array<{id:string,title:string,content:string}>, activePromptId: string}} store
 */
function renderStore(store) {
  const list = document.getElementById('prompt-list');
  const template = document.getElementById('prompt-item-template');

  if (!list || !template) {
    console.error('Prompt list or template element not found.');
    return;
  }

  list.innerHTML = '';

  for (const prompt of store.prompts) {
    const node = template.content.cloneNode(true);
    const item = node.querySelector('.prompt-item');
    const title = node.querySelector('.item-title');
    const content = node.querySelector('.item-content');
    const saveButton = node.querySelector('.btn-save');
    const activateButton = node.querySelector('.btn-activate');
    const deleteButton = node.querySelector('.btn-delete');

    if (!item || !title || !content || !saveButton || !activateButton || !deleteButton) {
      console.error('Failed to render prompt item due to missing DOM nodes.');
      continue;
    }

    title.textContent = prompt.title;
    content.value = prompt.content;

    if (prompt.id === store.activePromptId) {
      item.classList.add('active');
    }

    saveButton.addEventListener('click', async () => {
      const updatedContent = content.value.trim();
      if (!updatedContent) {
        setStatus('Prompt 内容不能为空。');
        return;
      }

      try {
        prompt.content = `${updatedContent}\n`;
        await saveStore(store);
        setStatus(`已保存：${prompt.title}`);
      } catch (error) {
        setStatus('保存失败，请重试。');
      }
    });

    activateButton.addEventListener('click', async () => {
      try {
        store.activePromptId = prompt.id;
        await saveStore(store);
        renderStore(store);
        setStatus(`已设为当前：${prompt.title}`);
      } catch (error) {
        setStatus('设置当前 Prompt 失败。');
      }
    });

    deleteButton.addEventListener('click', async () => {
      if (store.prompts.length <= 1) {
        setStatus('至少保留一个 Prompt。');
        return;
      }

      try {
        const nextPrompts = store.prompts.filter((itemData) => itemData.id !== prompt.id);
        store.prompts = nextPrompts;

        if (store.activePromptId === prompt.id) {
          store.activePromptId = nextPrompts[0].id;
        }

        await saveStore(store);
        renderStore(store);
        setStatus(`已删除：${prompt.title}`);
      } catch (error) {
        setStatus('删除失败，请重试。');
      }
    });

    list.appendChild(node);
  }
}

/**
 * Sets feedback message in page status area.
 * @param {string} message
 */
function setStatus(message) {
  const statusNode = document.getElementById('status');
  if (!statusNode) {
    console.error('Status node not found.');
    return;
  }

  statusNode.textContent = message;
}

/**
 * Initializes options page and event handlers.
 */
async function init() {
  const targetForm = document.getElementById('target-form');
  const targetSiteCheckboxes = document.querySelectorAll('input[name="target-sites"]');
  const syncForm = document.getElementById('sync-form');
  const syncProviderSelect = document.getElementById('sync-provider');
  const syncAutoSyncInput = document.getElementById('sync-auto-sync');
  const syncRetryEnabledInput = document.getElementById('sync-retry-enabled');
  const syncWebhookUrlInput = document.getElementById('sync-webhook-url');
  const syncWebhookAuthTokenInput = document.getElementById('sync-webhook-auth-token');
  const syncObsidianBaseUrlInput = document.getElementById('sync-obsidian-base-url');
  const syncObsidianApiKeyInput = document.getElementById('sync-obsidian-api-key');
  const syncNotionTokenInput = document.getElementById('sync-notion-token');
  const syncNotionDatabaseIdInput = document.getElementById('sync-notion-database-id');
  const syncWebhookFields = document.getElementById('sync-webhook-fields');
  const syncObsidianFields = document.getElementById('sync-obsidian-fields');
  const syncNotionFields = document.getElementById('sync-notion-fields');
  const form = document.getElementById('create-form');
  const titleInput = document.getElementById('prompt-title');
  const contentInput = document.getElementById('prompt-content');

  if (
    !targetForm ||
    targetSiteCheckboxes.length === 0 ||
    !(syncForm instanceof HTMLFormElement) ||
    !(syncProviderSelect instanceof HTMLSelectElement) ||
    !(syncAutoSyncInput instanceof HTMLInputElement) ||
    !(syncRetryEnabledInput instanceof HTMLInputElement) ||
    !(syncWebhookUrlInput instanceof HTMLInputElement) ||
    !(syncWebhookAuthTokenInput instanceof HTMLInputElement) ||
    !(syncObsidianBaseUrlInput instanceof HTMLInputElement) ||
    !(syncObsidianApiKeyInput instanceof HTMLInputElement) ||
    !(syncNotionTokenInput instanceof HTMLInputElement) ||
    !(syncNotionDatabaseIdInput instanceof HTMLInputElement) ||
    !(syncWebhookFields instanceof HTMLElement) ||
    !(syncObsidianFields instanceof HTMLElement) ||
    !(syncNotionFields instanceof HTMLElement) ||
    !form ||
    !titleInput ||
    !contentInput
  ) {
    console.error('Required options page nodes are missing.');
    return;
  }

  const targetSettings = await loadTargetSettings();
  for (const checkbox of targetSiteCheckboxes) {
    checkbox.checked = targetSettings.targetSites.includes(checkbox.value);
  }

  const syncSettings = await loadSyncTargetSettings();
  syncProviderSelect.value = isValidProvider(syncSettings.provider)
    ? syncSettings.provider
    : SYNC_PROVIDER_IDS.DISABLED;
  syncAutoSyncInput.checked = syncSettings.autoSync;
  syncRetryEnabledInput.checked = syncSettings.retryEnabled;
  syncWebhookUrlInput.value = syncSettings.webhookUrl;
  syncWebhookAuthTokenInput.value = syncSettings.webhookAuthToken;
  syncObsidianBaseUrlInput.value = syncSettings.obsidianBaseUrl;
  syncObsidianApiKeyInput.value = syncSettings.obsidianApiKey;
  syncNotionTokenInput.value = syncSettings.notionToken;
  syncNotionDatabaseIdInput.value = syncSettings.notionDatabaseId;
  renderSyncProviderFields(syncProviderSelect.value, syncNotionFields, syncWebhookFields, syncObsidianFields);

  syncProviderSelect.addEventListener('change', () => {
    renderSyncProviderFields(syncProviderSelect.value, syncNotionFields, syncWebhookFields, syncObsidianFields);
  });

  targetForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const selectedValues = Array.from(targetSiteCheckboxes)
      .filter((checkbox) => checkbox.checked)
      .map((checkbox) => checkbox.value)
      .filter((site) => VALID_TARGET_SITES.includes(site));

    if (selectedValues.length === 0) {
      setStatus('请至少选择一个发送目标。');
      return;
    }

    try {
      await saveTargetSettings({ targetSites: selectedValues });
      const targetLabels = selectedValues.map((site) => TARGET_SITE_LABELS[site] || site);
      setStatus(`已保存跳转目标：${targetLabels.join('、')}`);
    } catch (error) {
      setStatus('保存跳转目标失败，请重试。');
    }
  });

  syncForm.addEventListener('submit', async (event) => {
    event.preventDefault();

    const provider = isValidProvider(syncProviderSelect.value)
      ? syncProviderSelect.value
      : SYNC_PROVIDER_IDS.DISABLED;
    const notionToken = syncNotionTokenInput.value.trim();
    const notionDatabaseId = syncNotionDatabaseIdInput.value.trim();
    const webhookUrl = syncWebhookUrlInput.value.trim();
    const webhookAuthToken = syncWebhookAuthTokenInput.value.trim();
    const obsidianBaseUrl = syncObsidianBaseUrlInput.value.trim();
    const obsidianApiKey = syncObsidianApiKeyInput.value.trim();
    const autoSync = syncAutoSyncInput.checked;
    const retryEnabled = syncRetryEnabledInput.checked;

    if (provider === SYNC_PROVIDER_IDS.NOTION && (!notionToken || !notionDatabaseId)) {
      setStatus('使用 Notion 同步时，请填写 Notion Token 与 Database ID。');
      return;
    }

    if (provider === SYNC_PROVIDER_IDS.WEBHOOK) {
      if (!webhookUrl) {
        setStatus('使用 Webhook 同步时，请填写 Webhook URL。');
        return;
      }

      try {
        const parsed = new URL(webhookUrl);
        if (!/^https?:$/i.test(parsed.protocol)) {
          setStatus('Webhook URL 仅支持 http/https 协议。');
          return;
        }
      } catch (error) {
        setStatus('Webhook URL 格式不正确。');
        return;
      }
    }

    if (provider === SYNC_PROVIDER_IDS.OBSIDIAN) {
      if (!obsidianBaseUrl || !obsidianApiKey) {
        setStatus('使用 Obsidian 同步时，请填写 API Base URL 与 API Key。');
        return;
      }

      try {
        const parsed = new URL(obsidianBaseUrl);
        if (!/^https?:$/i.test(parsed.protocol)) {
          setStatus('Obsidian Base URL 仅支持 http/https 协议。');
          return;
        }
      } catch (error) {
        setStatus('Obsidian Base URL 格式不正确。');
        return;
      }
    }

    try {
      const normalized = normalizeSyncTargetSettings({
        provider,
        autoSync,
        retryEnabled,
        notionToken,
        notionDatabaseId,
        webhookUrl,
        webhookAuthToken,
        obsidianBaseUrl,
        obsidianApiKey
      });
      await saveSyncTargetSettings(normalized);
      setStatus('已保存同步目标配置。');
    } catch (error) {
      setStatus('保存同步目标配置失败，请重试。');
    }
  });

  const store = await loadStore();
  renderStore(store);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const title = titleInput.value.trim();
    const content = contentInput.value.trim();

    if (!title || !content) {
      setStatus('标题和内容都不能为空。');
      return;
    }

    try {
      store.prompts.unshift({
        id: generateId(),
        title,
        content: `${content}\n`
      });

      await saveStore(store);
      renderStore(store);
      setStatus(`已新增：${title}`);

      titleInput.value = '';
      contentInput.value = '';
    } catch (error) {
      setStatus('新增失败，请重试。');
    }
  });
}

init();
