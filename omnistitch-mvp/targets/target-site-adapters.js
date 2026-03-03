/**
 * Registers all available target adapters so content runtime can resolve by site.
 */
(() => {
  const registeredAdapters = [
    globalThis.CHATGPT_TARGET_ADAPTER,
    globalThis.KIMI_TARGET_ADAPTER,
    globalThis.DEEPSEEK_TARGET_ADAPTER,
    globalThis.GEMINI_TARGET_ADAPTER
  ].filter(Boolean);

  const expectedCount = 4;
  if (registeredAdapters.length !== expectedCount) {
    console.error('[omnistitch][content] Target adapter registration is incomplete.', {
      expectedCount,
      actualCount: registeredAdapters.length
    });
  }

  globalThis.TARGET_SITE_ADAPTERS = registeredAdapters;
})();
