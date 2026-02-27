const STORAGE_KEY = 'prompt_store_v1';
const TARGET_STORE_KEY = 'target_site_v1';
const VALID_TARGET_SITES = ['chatgpt', 'kimi'];

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
 * @returns {{targetSites: Array<'chatgpt'|'kimi'>}}
 */
function createDefaultTargetSettings() {
  return {
    targetSites: ['chatgpt']
  };
}

/**
 * Normalizes target settings and keeps backward compatibility with old single-target schema.
 * @param {{targetSites?: string[], targetSite?: string}|undefined} settings
 * @returns {{targetSites: Array<'chatgpt'|'kimi'>}}
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
    normalizedSet.add('chatgpt');
  }

  return {
    targetSites: Array.from(normalizedSet)
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
 * @returns {Promise<{targetSites: Array<'chatgpt'|'kimi'>}>}
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
 * @param {{targetSites: Array<'chatgpt'|'kimi'>}} settings
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
  const form = document.getElementById('create-form');
  const titleInput = document.getElementById('prompt-title');
  const contentInput = document.getElementById('prompt-content');

  if (!targetForm || targetSiteCheckboxes.length === 0 || !form || !titleInput || !contentInput) {
    console.error('Required options page nodes are missing.');
    return;
  }

  const targetSettings = await loadTargetSettings();
  for (const checkbox of targetSiteCheckboxes) {
    checkbox.checked = targetSettings.targetSites.includes(checkbox.value);
  }

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
      const targetLabels = selectedValues.map((site) => (site === 'chatgpt' ? 'ChatGPT' : 'Kimi'));
      setStatus(`已保存跳转目标：${targetLabels.join('、')}`);
    } catch (error) {
      setStatus('保存跳转目标失败，请重试。');
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
