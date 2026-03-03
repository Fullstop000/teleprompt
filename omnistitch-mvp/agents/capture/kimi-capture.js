/**
 * Kimi-specific request inspection for network capture tracking.
 */
(() => {
  const KIMI_ALLOWED_HOSTS = ['kimi.com', 'moonshot.cn'];
  const KIMI_CHAT_SERVICE_PATH = '/apiv2/kimi.gateway.chat.v1.chatservice/chat';

  /**
   * Inspects one Kimi request URL.
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
  function inspectKimiRequest(requestUrl, requestMethod) {
    const inspectGeneric = globalThis.inspectOmnistitchGenericCaptureRequest;
    const buildInspection = globalThis.buildOmnistitchCaptureInspection;
    const parseUrl = globalThis.parseOmnistitchCaptureUrl;
    if (typeof inspectGeneric !== 'function' || typeof buildInspection !== 'function') {
      return {
        requestUrl: String(requestUrl || ''),
        isValidUrl: false,
        isAllowedHost: false,
        hasKeyword: false,
        shouldTrack: false,
        matchLabel: ''
      };
    }

    const genericInspection = inspectGeneric(requestUrl, requestMethod, {
      allowedHosts: KIMI_ALLOWED_HOSTS
    });
    const parsed = typeof parseUrl === 'function' ? parseUrl(requestUrl) : null;
    const pathAndSearch = parsed ? `${parsed.pathname}${parsed.search}`.toLowerCase() : '';
    const isKimiChatService = pathAndSearch.includes(KIMI_CHAT_SERVICE_PATH);
    const shouldTrack = Boolean(genericInspection.shouldTrack || (genericInspection.isAllowedHost && isKIMIChatService(pathAndSearch)));

    return buildInspection({
      requestUrl: genericInspection.requestUrl || String(requestUrl || ''),
      isValidUrl: genericInspection.isValidUrl,
      isAllowedHost: genericInspection.isAllowedHost,
      hasKeyword: genericInspection.hasKeyword || isKimiChatService,
      shouldTrack,
      matchLabel: isKimiChatService ? 'kimi_chat_service' : ''
    });
  }

  /**
   * Checks whether a parsed path token matches Kimi chat service endpoint.
   * @param {string} pathAndSearch
   * @returns {boolean}
   */
  function isKIMIChatService(pathAndSearch) {
    return String(pathAndSearch || '').includes(KIMI_CHAT_SERVICE_PATH);
  }

  if (typeof globalThis.registerOmnistitchCaptureRule === 'function') {
    globalThis.registerOmnistitchCaptureRule('kimi', inspectKimiRequest);
  }
})();
