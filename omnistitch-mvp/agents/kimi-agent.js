/**
 * Tries to switch Kimi from thinking mode to fast mode.
 * @returns {Promise<{applied:boolean,detail:string,preview:string}>}
 */
globalThis.switchKimiMode = async function switchKimiMode() {
  const controls = collectModeControls();
  const thinkingToggle = controls.find((element) => {
    const text = readModeControlText(element).toLowerCase();
    return /深度思考|思考|thinking/.test(text) && isActiveModeControl(element);
  });
  if (thinkingToggle && clickModeControl(thinkingToggle)) {
    await waitMs(300);
    return {
      applied: true,
      detail: 'disabled active thinking toggle',
      preview: readModeControlText(thinkingToggle)
    };
  }

  const fastControl = controls.find((element) => /快速|fast|标准/.test(readModeControlText(element).toLowerCase()));
  if (fastControl && clickModeControl(fastControl)) {
    await waitMs(300);
    return {
      applied: true,
      detail: 'selected fast mode control',
      preview: readModeControlText(fastControl)
    };
  }

  return {
    applied: false,
    detail: 'no kimi fast/thinking controls matched',
    preview: controls
      .map((element) => readModeControlText(element))
      .filter(Boolean)
      .slice(0, 12)
      .join(' | ')
  };
};

/**
 * Extracts Kimi response text and keeps only latest ListChats message content.
 * @param {string} rawText
 * @returns {string}
 */
globalThis.extractKimiResponseText = function extractKimiResponseText(rawText) {
  const payloads = collectStructuredPayloads(rawText);
  const streamFragments = [];
  const snapshotFragments = [];

  /**
   * Picks latest chat message content from Kimi ListChats payload.
   * @param {Array<unknown>} chats
   * @returns {string}
   */
  const pickLatestChatMessageContent = (chats) => {
    if (!Array.isArray(chats) || chats.length === 0) {
      return '';
    }

    let bestContent = '';
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < chats.length; index += 1) {
      const chat = chats[index];
      if (!chat || typeof chat !== 'object') {
        continue;
      }

      const content = normalizeCapturedText(chat.messageContent || '');
      if (!content) {
        continue;
      }

      const updateTimeMs = Date.parse(String(chat.updateTime || chat.createTime || ''));
      const score = Number.isFinite(updateTimeMs) ? updateTimeMs : chats.length - index;
      if (score > bestScore) {
        bestScore = score;
        bestContent = content;
      }
    }

    return bestContent;
  };

  for (const payload of payloads) {
    if (!payload || typeof payload !== 'object') {
      continue;
    }

    const role =
      typeof payload.role === 'string'
        ? payload.role.trim().toLowerCase()
        : typeof payload.message?.role === 'string'
          ? payload.message.role.trim().toLowerCase()
          : '';
    if (role && role !== 'assistant' && role !== 'model') {
      continue;
    }

    const blockText =
      payload.block && payload.block.text && typeof payload.block.text === 'object' ? payload.block.text.content : '';
    appendUniqueTextFragment(streamFragments, blockText);
    collectAssistantTextFromMessage(payload.message, streamFragments);

    if (Array.isArray(payload.chats)) {
      appendUniqueTextFragment(snapshotFragments, pickLatestChatMessageContent(payload.chats));
    }
  }

  // Prefer list-chat snapshots to avoid duplicating stream fragments in sync payload.
  const preferred = removeIntermediateStatusLines(snapshotFragments.join('\n'));
  if (preferred) {
    return preferred;
  }

  // Fallback to stream fragments when snapshot payload is unavailable.
  return removeIntermediateStatusLines(streamFragments.join('\n'));
};

/**
 * Kimi agent adapter object used by content runtime.
 */
globalThis.KIMI_AGENT_ADAPTER = {
  id: 'kimi',
  name: 'Kimi',
  responseExtractor: globalThis.extractKimiResponseText,
  modeSwitcher: globalThis.switchKimiMode,
  hostnames: ['kimi.com', 'www.kimi.com'],
  composerSelectors: [
    'div.chat-input-editor[contenteditable="true"]',
    'textarea',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"]'
  ],
  sendButtonSelectors: [
    'div.send-button-container',
    'div.chat-editor-action div.send-button-container',
    'button[aria-label*="发送"]',
    'button[aria-label*="Send"]',
    'button[data-testid*="send"]',
    'button[class*="send"]',
    'button[type="submit"]'
  ]
};
