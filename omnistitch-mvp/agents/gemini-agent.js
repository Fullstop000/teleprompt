/**
 * Tries to switch Gemini to fast/flash mode.
 * @returns {Promise<{applied:boolean,detail:string,preview:string}>}
 */
globalThis.switchGeminiMode = async function switchGeminiMode() {
  const clickByRegex = (regex) => {
    const controls = collectModeControls();
    const matched = controls.find((element) => regex.test(readModeControlText(element)));
    if (!matched || !clickModeControl(matched)) {
      return '';
    }

    return readModeControlText(matched);
  };

  const directFast = clickByRegex(/flash|快速|fast/i);
  if (directFast) {
    await waitMs(500);
    return {
      applied: true,
      detail: 'selected fast/flash mode directly',
      preview: directFast
    };
  }

  const modelPicker = clickByRegex(/gemini|模型|model|pro|thinking|思考/i);
  if (modelPicker) {
    await waitMs(800);
    const flashAfterOpen = clickByRegex(/flash|快速|fast/i);
    if (flashAfterOpen) {
      await waitMs(500);
      return {
        applied: true,
        detail: 'opened model picker then selected fast/flash',
        preview: flashAfterOpen
      };
    }

    return {
      applied: false,
      detail: 'model picker clicked but no fast/flash option found',
      preview: modelPicker
    };
  }

  const controls = collectModeControls();
  return {
    applied: false,
    detail: 'no gemini fast/thinking controls matched',
    preview: controls
      .map((element) => readModeControlText(element))
      .filter(Boolean)
      .slice(0, 12)
      .join(' | ')
  };
};

/**
 * Extracts Gemini assistant text from candidate/content payload fields.
 * @param {string} rawText
 * @returns {string}
 */
globalThis.extractGeminiResponseText = function extractGeminiResponseText(rawText) {
  const payloads = collectStructuredPayloads(rawText);
  const fragments = [];

  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') {
      continue;
    }

    if (Array.isArray(payload.candidates)) {
      for (const candidate of payload.candidates) {
        if (!candidate || typeof candidate !== 'object') {
          continue;
        }

        if (candidate.content && typeof candidate.content === 'object' && Array.isArray(candidate.content.parts)) {
          for (const part of candidate.content.parts) {
            if (!part || typeof part !== 'object') {
              continue;
            }
            appendUniqueTextFragment(fragments, part.text);
            appendUniqueTextFragment(fragments, part.content);
          }
        }

        appendUniqueTextFragment(fragments, candidate.output_text);
        appendUniqueTextFragment(fragments, candidate.text);
      }
    }

    collectAssistantTextFromMessage(payload.message, fragments);
    appendUniqueTextFragment(fragments, payload.output_text);
  }

  return removeIntermediateStatusLines(fragments.join('\n'));
};

/**
 * Gemini agent adapter object used by content runtime.
 */
globalThis.GEMINI_AGENT_ADAPTER = {
  id: 'gemini',
  name: 'Gemini',
  responseExtractor: globalThis.extractGeminiResponseText,
  modeSwitcher: globalThis.switchGeminiMode,
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
};
