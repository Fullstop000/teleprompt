/**
 * Keeps DeepSeek mode unchanged and reports a stable result shape.
 * @returns {Promise<{applied:boolean,detail:string,preview:string}>}
 */
globalThis.switchDeepseekMode = async function switchDeepseekMode() {
  return {
    applied: true,
    detail: 'deepseek mode unchanged',
    preview: ''
  };
};

/**
 * Extracts DeepSeek assistant text from structured payload events.
 * @param {string} rawText
 * @returns {string}
 */
globalThis.extractDeepseekResponseText = function extractDeepseekResponseText(rawText) {
  const payloads = collectStructuredPayloads(rawText);
  const fragments = [];

  /**
   * Appends DeepSeek delta operations that mutate response fragment content.
   * @param {unknown} payload
   */
  const appendDeepseekDeltaOperation = (payload) => {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const path = typeof payload.p === 'string' ? payload.p.trim().toLowerCase() : '';
    const operator = typeof payload.o === 'string' ? payload.o.trim().toLowerCase() : '';
    const value = payload.v;
    if (typeof value !== 'string' || !path || !operator) {
      return;
    }

    const isFragmentContentPath = /\/?response\/fragments\/-?\d+\/content/.test(path);
    const isTextMutation = operator === 'append' || operator === 'replace';
    if (!isFragmentContentPath || !isTextMutation) {
      return;
    }

    appendUniqueTextFragment(fragments, value);
  };

  /**
   * Appends response fragment text from DeepSeek response object.
   * @param {unknown} response
   */
  const appendDeepseekResponseFragments = (response) => {
    if (!response || typeof response !== 'object' || !Array.isArray(response.fragments)) {
      return;
    }

    for (const fragment of response.fragments) {
      if (!fragment || typeof fragment !== 'object') {
        continue;
      }

      appendUniqueTextFragment(fragments, fragment.content);
      appendUniqueTextFragment(fragments, fragment.text);
    }
  };

  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') {
      continue;
    }

    appendDeepseekDeltaOperation(payload);
    collectAssistantTextFromMessage(payload.message, fragments);

    if (typeof payload.v === 'string') {
      appendUniqueTextFragment(fragments, payload.v);
    }

    if (payload.v && typeof payload.v === 'object') {
      appendUniqueTextFragment(fragments, payload.v.text);
      appendUniqueTextFragment(fragments, payload.v.content);
      collectAssistantTextFromMessage(payload.v.message, fragments);

      if (payload.v.response && typeof payload.v.response === 'object') {
        appendUniqueTextFragment(fragments, payload.v.response.text);
        appendUniqueTextFragment(fragments, payload.v.response.content);
        collectAssistantTextFromMessage(payload.v.response, fragments);
        appendDeepseekResponseFragments(payload.v.response);
      }
    }

    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        if (!choice || typeof choice !== 'object') {
          continue;
        }

        appendUniqueTextFragment(fragments, choice.delta && choice.delta.content);
        appendUniqueTextFragment(fragments, choice.text);
        collectAssistantTextFromMessage(choice.message, fragments);
      }
    }

    if (payload.response && typeof payload.response === 'object') {
      appendUniqueTextFragment(fragments, payload.response.text);
      appendUniqueTextFragment(fragments, payload.response.content);
      collectAssistantTextFromMessage(payload.response, fragments);
      appendDeepseekResponseFragments(payload.response);
    }
  }

  return removeIntermediateStatusLines(fragments.join('\n'));
};

/**
 * DeepSeek target adapter object used by content runtime.
 */
globalThis.DEEPSEEK_TARGET_ADAPTER = {
  id: 'deepseek',
  name: 'DeepSeek',
  responseExtractor: globalThis.extractDeepseekResponseText,
  modeSwitcher: globalThis.switchDeepseekMode,
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
};
