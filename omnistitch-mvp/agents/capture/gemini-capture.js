/**
 * Gemini-specific request inspection for network capture tracking.
 */
(() => {
  const GEMINI_ALLOWED_HOSTS = ['gemini.google.com', 'googleapis.com', 'google.com'];

  /**
   * Inspects one Gemini request URL.
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
  function inspectGeminiRequest(requestUrl, requestMethod) {
    const inspectGeneric = globalThis.inspectOmnistitchGenericCaptureRequest;
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
      allowedHosts: GEMINI_ALLOWED_HOSTS
    });
    return {
      ...result,
      matchLabel: result.shouldTrack ? 'gemini_keyword_match' : ''
    };
  }

  if (typeof globalThis.registerOmnistitchCaptureRule === 'function') {
    globalThis.registerOmnistitchCaptureRule('gemini', inspectGeminiRequest);
  }
})();
