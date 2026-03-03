/**
 * DeepSeek-specific request inspection for network capture tracking.
 */
(() => {
  const DEEPSEEK_ALLOWED_HOSTS = ['deepseek.com'];
  const DEEPSEEK_COMPLETION_PATH = '/api/v0/chat/completion';

  /**
   * Inspects one DeepSeek request URL.
   * @param {string} requestUrl
   * @param {string} requestMethod
   * @returns {{
   *   requestUrl:string,
   *   isValidUrl:boolean,
   *   isAllowedHost:boolean,
   *   hasKeyword:boolean,
   *   shouldTrack:boolean,
   *   matchLabel:string
   * }}
   */
  function inspectDeepseekRequest(requestUrl, requestMethod) {
    const inspectGeneric = globalThis.inspectOmnistitchGenericCaptureRequest;
    const parseUrl = globalThis.parseOmnistitchCaptureUrl;
    if (typeof inspectGeneric !== 'function') {
      return {
        requestUrl: String(requestUrl || ''),
        isValidUrl: false,
        isAllowedHost: false,
        hasKeyword: false,
        shouldTrack: false,
        matchLabel: ''
      };
    }

    const result = inspectGeneric(requestUrl, requestMethod, {
      allowedHosts: DEEPSEEK_ALLOWED_HOSTS,
      forcePathSubstrings: [DEEPSEEK_COMPLETION_PATH],
      requiredMethod: 'POST'
    });
    const parsed = typeof parseUrl === 'function' ? parseUrl(requestUrl) : null;
    const pathAndSearch = parsed ? `${parsed.pathname}${parsed.search}`.toLowerCase() : '';
    const isCompletionRequest = pathAndSearch.includes(DEEPSEEK_COMPLETION_PATH);
    return {
      ...result,
      matchLabel: isCompletionRequest ? 'deepseek_completion' : ''
    };
  }

  if (typeof globalThis.registerOmnistitchCaptureRule === 'function') {
    globalThis.registerOmnistitchCaptureRule('deepseek', inspectDeepseekRequest);
  }
})();
