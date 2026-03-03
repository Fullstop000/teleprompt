/**
 * ChatGPT-specific request inspection for network capture tracking.
 */
(() => {
  const CHATGPT_ALLOWED_HOSTS = ['chatgpt.com', 'openai.com'];
  const CHATGPT_ALLOW_PATHS = ['/backend-api/conversation', '/backend-anon/conversation', '/backend-api/f/conversation'];
  const CHATGPT_DENY_PATHS = [
    '/backend-api/calpico/',
    '/backend-api/conversations',
    '/backend-api/conversation/init',
    '/backend-api/f/conversation/prepare',
    '/backend-api/sentinel/',
    '/backend-api/system_hints',
    '/backend-api/accounts/check',
    '/backend-api/me',
    '/backend-api/connectors/',
    '/backend-api/images/bootstrap',
    '/backend-api/user_granular_consent',
    '/ces/',
    '/ab.chatgpt.com/'
  ];

  /**
   * Inspects one ChatGPT request URL with strict POST conversation rules.
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
  function inspectChatgptRequest(requestUrl, requestMethod) {
    const parseUrl = globalThis.parseOmnistitchCaptureUrl;
    const buildInspection = globalThis.buildOmnistitchCaptureInspection;
    const normalizeMethod = globalThis.normalizeOmnistitchCaptureMethod;
    const matchHost = globalThis.matchesOmnistitchCaptureHost;
    const defaultKeywords = globalThis.OMNISTITCH_CAPTURE_DEFAULT_URL_KEYWORDS || [];

    if (typeof parseUrl !== 'function' || typeof buildInspection !== 'function') {
      return {
        requestUrl: String(requestUrl || ''),
        isValidUrl: false,
        isAllowedHost: false,
        hasKeyword: false,
        shouldTrack: false,
        matchLabel: ''
      };
    }

    const parsed = parseUrl(requestUrl);
    if (!parsed) {
      return buildInspection({
        requestUrl: String(requestUrl || ''),
        isValidUrl: false,
        isAllowedHost: false,
        hasKeyword: false,
        shouldTrack: false
      });
    }

    const normalizedMethod = typeof normalizeMethod === 'function' ? normalizeMethod(requestMethod) : '';
    const pathname = parsed.pathname.toLowerCase();
    const pathAndSearch = `${parsed.pathname}${parsed.search}`.toLowerCase();
    const isAllowedHost = typeof matchHost === 'function' ? matchHost(parsed.hostname, CHATGPT_ALLOWED_HOSTS) : false;
    const hasAllowedPathToken = CHATGPT_ALLOW_PATHS.some((token) => pathAndSearch.includes(token));
    const isAllowedResponsePath = CHATGPT_ALLOW_PATHS.some(
      (token) => pathname === token || pathname.startsWith(`${token}/`)
    );
    const isDeniedPath = CHATGPT_DENY_PATHS.some((token) => pathAndSearch.includes(token));
    const hasKeyword =
      hasAllowedPathToken ||
      defaultKeywords.some((keyword) => pathAndSearch.includes(String(keyword || '').toLowerCase()));
    const shouldTrack = isAllowedHost && isAllowedResponsePath && hasAllowedPathToken && !isDeniedPath && normalizedMethod === 'POST';

    return buildInspection({
      requestUrl: parsed.toString(),
      isValidUrl: true,
      isAllowedHost,
      hasKeyword,
      shouldTrack,
      matchLabel: shouldTrack ? 'chatgpt_conversation' : ''
    });
  }

  if (typeof globalThis.registerOmnistitchCaptureRule === 'function') {
    globalThis.registerOmnistitchCaptureRule('chatgpt', inspectChatgptRequest);
  }
})();
