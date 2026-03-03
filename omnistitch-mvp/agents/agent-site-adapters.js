/**
 * Registers all available agent adapters so content runtime can resolve by site.
 */
(() => {
  const registeredAdapters = [
    globalThis.CHATGPT_AGENT_ADAPTER,
    globalThis.KIMI_AGENT_ADAPTER,
    globalThis.DEEPSEEK_AGENT_ADAPTER,
    globalThis.GEMINI_AGENT_ADAPTER
  ].filter(Boolean);

  const expectedCount = 4;
  if (registeredAdapters.length !== expectedCount) {
    console.error('[omnistitch][content] Target adapter registration is incomplete.', {
      expectedCount,
      actualCount: registeredAdapters.length
    });
  }

  globalThis.AGENT_SITE_ADAPTERS = registeredAdapters;
})();
