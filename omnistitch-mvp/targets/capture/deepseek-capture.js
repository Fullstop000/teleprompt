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
    const normalizeMethod = globalThis.normalizeOmnistitchCaptureMethod;
    const buildInspection = globalThis.buildOmnistitchCaptureInspection;
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
      requiredMethod: 'POST'
    });
    const parsed = typeof parseUrl === 'function' ? parseUrl(requestUrl) : null;
    const method = typeof normalizeMethod === 'function' ? normalizeMethod(requestMethod) : String(requestMethod || '');
    const pathAndSearch = parsed ? `${parsed.pathname}${parsed.search}`.toLowerCase() : '';
    const isCompletionRequest = pathAndSearch.includes(DEEPSEEK_COMPLETION_PATH);
    const isPostMethod = method === 'POST';
    const shouldTrack = Boolean(result.isValidUrl && result.isAllowedHost && isCompletionRequest && isPostMethod);

    if (typeof buildInspection === 'function') {
      return buildInspection({
        requestUrl: result.requestUrl || String(requestUrl || ''),
        isValidUrl: result.isValidUrl,
        isAllowedHost: result.isAllowedHost,
        hasKeyword: isCompletionRequest,
        shouldTrack,
        matchLabel: isCompletionRequest ? 'deepseek_completion' : ''
      });
    }

    return {
      requestUrl: result.requestUrl || String(requestUrl || ''),
      isValidUrl: result.isValidUrl,
      isAllowedHost: result.isAllowedHost,
      hasKeyword: isCompletionRequest,
      shouldTrack,
      matchLabel: isCompletionRequest ? 'deepseek_completion' : ''
    };
  }

  if (typeof globalThis.registerOmnistitchCaptureRule === 'function') {
    globalThis.registerOmnistitchCaptureRule('deepseek', inspectDeepseekRequest);
  }
})();
