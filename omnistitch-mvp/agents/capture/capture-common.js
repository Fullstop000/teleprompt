/**
 * Shared helpers for target-specific network capture request inspection.
 * This file runs in MAIN world before response-capture-main.js.
 */
(() => {
  const DEFAULT_URL_KEYWORDS = ['chat', 'conversation', 'assistant', 'completion', 'generate', 'response', 'stream'];
  const DEFAULT_ALLOWED_HOSTS = [
    'chatgpt.com',
    'openai.com',
    'kimi.com',
    'moonshot.cn',
    'deepseek.com',
    'gemini.google.com',
    'googleapis.com',
    'google.com'
  ];

  /**
   * Parses URL string safely.
   * @param {string} requestUrl
   * @returns {URL|null}
   */
  function parseCaptureUrl(requestUrl) {
    if (!requestUrl || typeof requestUrl !== 'string') {
      return null;
    }

    try {
      return new URL(requestUrl);
    } catch (_error) {
      return null;
    }
  }

  /**
   * Normalizes request method to upper-case token.
   * @param {string} requestMethod
   * @returns {string}
   */
  function normalizeCaptureMethod(requestMethod) {
    return String(requestMethod || '').trim().toUpperCase();
  }

  /**
   * Checks whether hostname belongs to one allowlist entry.
   * @param {string} hostname
   * @param {string[]} allowedHosts
   * @returns {boolean}
   */
  function matchesCaptureHost(hostname, allowedHosts) {
    const normalizedHostname = String(hostname || '').toLowerCase();
    if (!normalizedHostname) {
      return false;
    }

    for (const host of Array.isArray(allowedHosts) ? allowedHosts : []) {
      const normalizedHost = String(host || '').trim().toLowerCase();
      if (!normalizedHost) {
        continue;
      }
      if (normalizedHostname === normalizedHost || normalizedHostname.endsWith(`.${normalizedHost}`)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Builds one normalized inspection result object.
   * @param {{
   *   requestUrl:string,
   *   isValidUrl:boolean,
   *   isAllowedHost:boolean,
   *   hasKeyword:boolean,
   *   shouldTrack:boolean,
   *   matchLabel?:string
   * }} input
   * @returns {{
   *   requestUrl:string,
   *   isValidUrl:boolean,
   *   isAllowedHost:boolean,
   *   hasKeyword:boolean,
   *   shouldTrack:boolean,
   *   matchLabel:string
   * }}
   */
  function buildCaptureInspection(input) {
    return {
      requestUrl: typeof input.requestUrl === 'string' ? input.requestUrl : '',
      isValidUrl: Boolean(input.isValidUrl),
      isAllowedHost: Boolean(input.isAllowedHost),
      hasKeyword: Boolean(input.hasKeyword),
      shouldTrack: Boolean(input.shouldTrack),
      matchLabel: typeof input.matchLabel === 'string' ? input.matchLabel : ''
    };
  }

  /**
   * Generic host + keyword request inspector.
   * @param {string} requestUrl
   * @param {string} requestMethod
   * @param {{
   *   allowedHosts?:string[],
   *   urlKeywords?:string[],
   *   forcePathSubstrings?:string[],
   *   denyPathSubstrings?:string[],
   *   requiredMethod?:string
   * }} [options]
   * @returns {{
   *   requestUrl:string,
   *   isValidUrl:boolean,
   *   isAllowedHost:boolean,
   *   hasKeyword:boolean,
   *   shouldTrack:boolean,
   *   matchLabel:string
   * }}
   */
  function inspectGenericCaptureRequest(requestUrl, requestMethod, options = {}) {
    const parsed = parseCaptureUrl(requestUrl);
    if (!parsed) {
      return buildCaptureInspection({
        requestUrl: typeof requestUrl === 'string' ? requestUrl : '',
        isValidUrl: false,
        isAllowedHost: false,
        hasKeyword: false,
        shouldTrack: false
      });
    }

    const allowedHosts = Array.isArray(options.allowedHosts) ? options.allowedHosts : DEFAULT_ALLOWED_HOSTS;
    const urlKeywords = Array.isArray(options.urlKeywords) ? options.urlKeywords : DEFAULT_URL_KEYWORDS;
    const forcePathSubstrings = Array.isArray(options.forcePathSubstrings) ? options.forcePathSubstrings : [];
    const denyPathSubstrings = Array.isArray(options.denyPathSubstrings) ? options.denyPathSubstrings : [];
    const requiredMethod = normalizeCaptureMethod(options.requiredMethod || '');
    const normalizedMethod = normalizeCaptureMethod(requestMethod);
    const pathAndSearch = `${parsed.pathname}${parsed.search}`.toLowerCase();
    const isAllowedHost = matchesCaptureHost(parsed.hostname, allowedHosts);
    const hasKeyword =
      urlKeywords.some((keyword) => pathAndSearch.includes(String(keyword || '').toLowerCase())) ||
      forcePathSubstrings.some((token) => pathAndSearch.includes(String(token || '').toLowerCase()));
    const isDeniedPath = denyPathSubstrings.some((token) =>
      pathAndSearch.includes(String(token || '').toLowerCase())
    );
    const methodMatched = !requiredMethod || normalizedMethod === requiredMethod;
    const shouldTrack = isAllowedHost && hasKeyword && !isDeniedPath && methodMatched;

    return buildCaptureInspection({
      requestUrl: parsed.toString(),
      isValidUrl: true,
      isAllowedHost,
      hasKeyword,
      shouldTrack
    });
  }

  /**
   * Registers one target capture inspection function.
   * @param {string} targetSite
   * @param {(requestUrl:string, requestMethod:string) => {
   *   requestUrl:string,
   *   isValidUrl:boolean,
   *   isAllowedHost:boolean,
   *   hasKeyword:boolean,
   *   shouldTrack:boolean,
   *   matchLabel?:string
   * }} inspector
   */
  function registerCaptureRule(targetSite, inspector) {
    const key = String(targetSite || '').trim().toLowerCase();
    if (!key || typeof inspector !== 'function') {
      return;
    }

    const registry = (globalThis.__OMNISTITCH_CAPTURE_RULES__ =
      globalThis.__OMNISTITCH_CAPTURE_RULES__ || Object.create(null));
    registry[key] = inspector;
  }

  globalThis.buildOmnistitchCaptureInspection = buildCaptureInspection;
  globalThis.parseOmnistitchCaptureUrl = parseCaptureUrl;
  globalThis.normalizeOmnistitchCaptureMethod = normalizeCaptureMethod;
  globalThis.matchesOmnistitchCaptureHost = matchesCaptureHost;
  globalThis.inspectOmnistitchGenericCaptureRequest = inspectGenericCaptureRequest;
  globalThis.registerOmnistitchCaptureRule = registerCaptureRule;
  globalThis.OMNISTITCH_CAPTURE_DEFAULT_URL_KEYWORDS = DEFAULT_URL_KEYWORDS.slice();
})();
