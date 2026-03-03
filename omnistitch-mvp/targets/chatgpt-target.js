/**
 * Keeps ChatGPT mode unchanged and reports a stable result shape.
 * @returns {Promise<{applied:boolean,detail:string,preview:string}>}
 */
globalThis.switchChatgptMode = async function switchChatgptMode() {
  return {
    applied: true,
    detail: 'chatgpt mode unchanged',
    preview: ''
  };
};

/**
 * Extracts ChatGPT assistant text from structured payload events.
 * @param {string} rawText
 * @returns {string}
 */
globalThis.extractChatgptResponseText = function extractChatgptResponseText(rawText) {
  const payloads = collectStructuredPayloads(rawText);
  const fragments = [];

  /**
   * Appends delta operation text from ChatGPT stream payload.
   * Supports both single op object and op array shapes.
   * @param {unknown} operations
   */
  const appendDeltaOperationsText = (operations) => {
    const opList = Array.isArray(operations) ? operations : [operations];
    for (const op of opList) {
      if (!op || typeof op !== 'object') {
        continue;
      }

      const path = typeof op.p === 'string' ? op.p : '';
      const operator = typeof op.o === 'string' ? op.o : '';
      const value = typeof op.v === 'string' ? op.v : '';
      if (!path || !operator || !value) {
        continue;
      }

      const isMessageContentPath = /^\/message\/content\/parts\/\d+$/i.test(path);
      const isTextMutation = operator === 'append' || operator === 'replace';
      if (!isMessageContentPath || !isTextMutation) {
        continue;
      }

      appendUniqueTextFragment(fragments, value);
    }
  };

  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') {
      continue;
    }

    const payloadType = typeof payload.type === 'string' ? payload.type.trim().toLowerCase() : '';
    if (payloadType === 'input_message') {
      // Skip user input echo events from ChatGPT stream payloads.
      continue;
    }

    collectAssistantTextFromMessage(payload.message, fragments);
    appendDeltaOperationsText(payload);
    appendDeltaOperationsText(payload.v);
    appendDeltaOperationsText(payload.delta);

    if (payload.v && typeof payload.v === 'object') {
      collectAssistantTextFromMessage(payload.v.message, fragments);
      appendUniqueTextFragment(fragments, payload.v.output_text);
    }

    if (Array.isArray(payload.choices)) {
      for (const choice of payload.choices) {
        if (!choice || typeof choice !== 'object') {
          continue;
        }

        appendUniqueTextFragment(fragments, choice.text);
        appendUniqueTextFragment(fragments, choice.delta && choice.delta.content);
        if (choice.message && typeof choice.message === 'object') {
          collectAssistantTextFromMessage(choice.message, fragments);
        }
      }
    }
  }

  return removeIntermediateStatusLines(fragments.join('\n'));
};

/**
 * ChatGPT target adapter object used by content runtime.
 */
globalThis.CHATGPT_TARGET_ADAPTER = {
  id: 'chatgpt',
  name: 'ChatGPT',
  responseExtractor: globalThis.extractChatgptResponseText,
  modeSwitcher: globalThis.switchChatgptMode,
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
};
