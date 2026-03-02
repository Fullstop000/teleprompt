(function mainWorldResponseCaptureBootstrap() {
  const CAPTURE_MAIN_EVENT_SOURCE = 'omnistitch_capture_main';
  const CAPTURE_CONTENT_EVENT_SOURCE = 'omnistitch_capture_content';
  const CAPTURE_EVENT_TYPES = {
    START: 'OMNISTITCH_CAPTURE_START',
    STOP: 'OMNISTITCH_CAPTURE_STOP',
    READY: 'OMNISTITCH_CAPTURE_READY',
    ACK: 'OMNISTITCH_CAPTURE_ACK',
    CHUNK: 'OMNISTITCH_CAPTURE_CHUNK',
    STREAM_END: 'OMNISTITCH_CAPTURE_STREAM_END',
    FINAL: 'OMNISTITCH_CAPTURE_FINAL',
    ERROR: 'OMNISTITCH_CAPTURE_ERROR'
  };
  const CAPTURE_IDLE_TIMEOUT_MS = 2500;
  const CAPTURE_HARD_TIMEOUT_MS = 180000;
  const CAPTURE_STREAM_END_GRACE_MS = 800;
  const URL_KEYWORDS = ['chat', 'conversation', 'assistant', 'completion', 'generate', 'response', 'stream'];
  const TARGET_HOST_ALLOWLIST = {
    chatgpt: ['chatgpt.com', 'openai.com'],
    kimi: ['kimi.com', 'moonshot.cn'],
    deepseek: ['deepseek.com'],
    gemini: ['gemini.google.com', 'googleapis.com', 'google.com']
  };
  const FALLBACK_HOST_ALLOWLIST = [
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
   * Posts one capture event to content world.
   * @param {string} type
   * @param {Record<string, unknown>} payload
   */
  function postCaptureEvent(type, payload) {
    window.postMessage(
      {
        source: CAPTURE_MAIN_EVENT_SOURCE,
        type,
        payload
      },
      '*'
    );
  }

  if (window.__OMNISTITCH_CAPTURE_INSTALLED__) {
    postCaptureEvent(CAPTURE_EVENT_TYPES.READY, {
      installed: true,
      reused: true
    });
    return;
  }

  window.__OMNISTITCH_CAPTURE_INSTALLED__ = true;

  /**
   * Active capture state for current tab. Only one task session is active.
   * @type {null|{
   *  taskId:string,
   *  targetSite:string,
   *  startedAt:number,
   *  chunkCount:number,
   *  captureChannel:string,
   *  captureSourceUrl:string,
   *  idleTimer:number|null,
   *  hardTimer:number|null,
   *  finalTimer:number|null,
   *  finalized:boolean
   * }}
   */
  let activeSession = null;

  /**
   * Resolves one request url input to absolute URL string.
   * @param {unknown} raw
   * @returns {string}
   */
  function toAbsoluteUrl(raw) {
    try {
      if (raw instanceof Request) {
        return raw.url || '';
      }

      if (typeof raw === 'string') {
        return new URL(raw, location.href).toString();
      }

      if (raw && typeof raw === 'object' && typeof raw.url === 'string') {
        return new URL(raw.url, location.href).toString();
      }
    } catch (_error) {
      return '';
    }

    return '';
  }

  /**
   * Checks whether one URL should be tracked by active session filters.
   * @param {string} requestUrl
   * @param {string} targetSite
   * @returns {boolean}
   */
  function shouldTrackRequestUrl(requestUrl, targetSite) {
    if (!requestUrl) {
      return false;
    }

    let parsed;
    try {
      parsed = new URL(requestUrl);
    } catch (_error) {
      return false;
    }

    const hostname = parsed.hostname.toLowerCase();
    const pathAndSearch = `${parsed.pathname}${parsed.search}`.toLowerCase();
    const allowedHosts = TARGET_HOST_ALLOWLIST[targetSite] || FALLBACK_HOST_ALLOWLIST;
    const isAllowedHost = allowedHosts.some(
      (domain) => hostname === domain || hostname.endsWith(`.${domain}`)
    );
    if (!isAllowedHost) {
      return false;
    }

    return URL_KEYWORDS.some((keyword) => pathAndSearch.includes(keyword));
  }

  /**
   * Clears all timers of current active session.
   * @param {typeof activeSession} session
   */
  function clearSessionTimers(session) {
    if (!session) {
      return;
    }

    if (session.idleTimer !== null) {
      clearTimeout(session.idleTimer);
      session.idleTimer = null;
    }
    if (session.hardTimer !== null) {
      clearTimeout(session.hardTimer);
      session.hardTimer = null;
    }
    if (session.finalTimer !== null) {
      clearTimeout(session.finalTimer);
      session.finalTimer = null;
    }
  }

  /**
   * Finalizes active capture session and emits FINAL event.
   * @param {string} reason
   */
  function finalizeActiveSession(reason) {
    if (!activeSession || activeSession.finalized) {
      return;
    }

    activeSession.finalized = true;
    const finalizedSession = activeSession;
    clearSessionTimers(finalizedSession);
    activeSession = null;

    postCaptureEvent(CAPTURE_EVENT_TYPES.FINAL, {
      taskId: finalizedSession.taskId,
      reason,
      captureChannel: finalizedSession.captureChannel || 'unknown',
      captureSourceUrl: finalizedSession.captureSourceUrl || '',
      captureChunkCount: finalizedSession.chunkCount,
      captureDurationMs: Date.now() - finalizedSession.startedAt
    });
  }

  /**
   * Resets idle finalization timer when new chunks arrive.
   */
  function resetIdleFinalizeTimer() {
    if (!activeSession) {
      return;
    }

    if (activeSession.idleTimer !== null) {
      clearTimeout(activeSession.idleTimer);
    }

    activeSession.idleTimer = setTimeout(() => {
      if (!activeSession || activeSession.chunkCount <= 0) {
        return;
      }

      finalizeActiveSession('idle_timeout');
    }, CAPTURE_IDLE_TIMEOUT_MS);
  }

  /**
   * Schedules finalization shortly after stream-end signal.
   */
  function scheduleStreamEndFinalize() {
    if (!activeSession) {
      return;
    }

    if (activeSession.finalTimer !== null) {
      clearTimeout(activeSession.finalTimer);
    }

    activeSession.finalTimer = setTimeout(() => {
      finalizeActiveSession('stream_end_grace');
    }, CAPTURE_STREAM_END_GRACE_MS);
  }

  /**
   * Starts one active session from content START command.
   * @param {{taskId?: string, targetSite?: string}} payload
   */
  function startSession(payload) {
    const taskId = payload && typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
    const targetSite = payload && typeof payload.targetSite === 'string' ? payload.targetSite.trim() : '';
    if (!taskId) {
      return;
    }

    if (activeSession && activeSession.taskId !== taskId) {
      finalizeActiveSession('replaced_by_new_session');
    }

    if (activeSession && activeSession.taskId === taskId) {
      postCaptureEvent(CAPTURE_EVENT_TYPES.ACK, { taskId });
      return;
    }

    const session = {
      taskId,
      targetSite: targetSite || 'unknown',
      startedAt: Date.now(),
      chunkCount: 0,
      captureChannel: '',
      captureSourceUrl: '',
      idleTimer: null,
      hardTimer: null,
      finalTimer: null,
      finalized: false
    };
    session.hardTimer = setTimeout(() => {
      finalizeActiveSession('hard_timeout');
    }, CAPTURE_HARD_TIMEOUT_MS);
    activeSession = session;

    postCaptureEvent(CAPTURE_EVENT_TYPES.ACK, {
      taskId: session.taskId
    });
  }

  /**
   * Stops active session from content STOP command.
   * @param {{taskId?: string}} payload
   */
  function stopSession(payload) {
    if (!activeSession) {
      return;
    }

    const taskId = payload && typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
    if (!taskId || taskId === activeSession.taskId) {
      clearSessionTimers(activeSession);
      activeSession = null;
    }
  }

  /**
   * Handles one incoming raw text chunk from network hooks.
   * @param {'fetch'|'xhr'|'websocket'|'eventsource'} captureChannel
   * @param {string} requestUrl
   * @param {string} rawChunk
   */
  function handleIncomingChunk(captureChannel, requestUrl, rawChunk) {
    if (!activeSession) {
      return;
    }

    if (!shouldTrackRequestUrl(requestUrl, activeSession.targetSite)) {
      return;
    }

    if (typeof rawChunk !== 'string' || rawChunk.length === 0) {
      return;
    }

    activeSession.chunkCount += 1;
    activeSession.captureChannel = captureChannel;
    activeSession.captureSourceUrl = requestUrl || activeSession.captureSourceUrl;
    resetIdleFinalizeTimer();

    postCaptureEvent(CAPTURE_EVENT_TYPES.CHUNK, {
      taskId: activeSession.taskId,
      captureChannel,
      captureSourceUrl: requestUrl,
      chunk: rawChunk,
      timestamp: Date.now()
    });
  }

  /**
   * Handles stream-end signal from one network channel.
   * @param {'fetch'|'xhr'|'websocket'|'eventsource'} captureChannel
   * @param {string} requestUrl
   */
  function handleIncomingStreamEnd(captureChannel, requestUrl) {
    if (!activeSession) {
      return;
    }

    if (!shouldTrackRequestUrl(requestUrl, activeSession.targetSite)) {
      return;
    }

    postCaptureEvent(CAPTURE_EVENT_TYPES.STREAM_END, {
      taskId: activeSession.taskId,
      captureChannel,
      captureSourceUrl: requestUrl,
      timestamp: Date.now()
    });

    scheduleStreamEndFinalize();
  }

  /**
   * Wraps fetch to mirror response body chunks for capture session.
   */
  function installFetchHook() {
    if (typeof window.fetch !== 'function') {
      return;
    }

    const nativeFetch = window.fetch;
    window.fetch = async function wrappedFetch(...args) {
      const requestUrl = toAbsoluteUrl(args[0]);
      const response = await nativeFetch.apply(this, args);

      try {
        if (activeSession && shouldTrackRequestUrl(requestUrl, activeSession.targetSite)) {
          const clone = response.clone();
          if (clone.body && typeof clone.body.getReader === 'function') {
            const reader = clone.body.getReader();
            const decoder = new TextDecoder();
            let finished = false;

            while (!finished) {
              const next = await reader.read();
              finished = next.done;
              if (next.value) {
                const chunk = decoder.decode(next.value, { stream: !finished });
                handleIncomingChunk('fetch', requestUrl, chunk);
              }
            }
          } else {
            const text = await clone.text();
            handleIncomingChunk('fetch', requestUrl, text);
          }

          handleIncomingStreamEnd('fetch', requestUrl);
        }
      } catch (error) {
        if (activeSession) {
          postCaptureEvent(CAPTURE_EVENT_TYPES.ERROR, {
            taskId: activeSession.taskId,
            captureChannel: 'fetch',
            captureSourceUrl: requestUrl,
            error: String(error)
          });
        }
      }

      return response;
    };
  }

  /**
   * Wraps XMLHttpRequest to mirror incremental responseText chunks.
   */
  function installXhrHook() {
    if (typeof window.XMLHttpRequest !== 'function') {
      return;
    }

    const nativeOpen = XMLHttpRequest.prototype.open;
    const nativeSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function wrappedOpen(method, url, ...rest) {
      this.__omniCaptureUrl = toAbsoluteUrl(url);
      this.__omniCaptureLength = 0;
      return nativeOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function wrappedSend(...args) {
      this.addEventListener('progress', () => {
        try {
          if (!activeSession || typeof this.responseText !== 'string') {
            return;
          }

          const total = this.responseText;
          const consumed = Number.isFinite(this.__omniCaptureLength) ? this.__omniCaptureLength : 0;
          if (total.length <= consumed) {
            return;
          }

          const chunk = total.slice(consumed);
          this.__omniCaptureLength = total.length;
          handleIncomingChunk('xhr', this.__omniCaptureUrl || '', chunk);
        } catch (error) {
          if (activeSession) {
            postCaptureEvent(CAPTURE_EVENT_TYPES.ERROR, {
              taskId: activeSession.taskId,
              captureChannel: 'xhr',
              captureSourceUrl: this.__omniCaptureUrl || '',
              error: String(error)
            });
          }
        }
      });

      this.addEventListener('loadend', () => {
        handleIncomingStreamEnd('xhr', this.__omniCaptureUrl || '');
      });

      return nativeSend.apply(this, args);
    };
  }

  /**
   * Wraps WebSocket constructor to mirror incoming text frames.
   */
  function installWebSocketHook() {
    if (typeof window.WebSocket !== 'function') {
      return;
    }

    const NativeWebSocket = window.WebSocket;

    function WrappedWebSocket(url, protocols) {
      const socket =
        protocols !== undefined ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
      const requestUrl = toAbsoluteUrl(url);

      socket.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          handleIncomingChunk('websocket', requestUrl, event.data);
        }
      });
      socket.addEventListener('close', () => {
        handleIncomingStreamEnd('websocket', requestUrl);
      });

      return socket;
    }

    WrappedWebSocket.prototype = NativeWebSocket.prototype;
    WrappedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
    WrappedWebSocket.OPEN = NativeWebSocket.OPEN;
    WrappedWebSocket.CLOSING = NativeWebSocket.CLOSING;
    WrappedWebSocket.CLOSED = NativeWebSocket.CLOSED;
    window.WebSocket = WrappedWebSocket;
  }

  /**
   * Wraps EventSource constructor to mirror server-sent event message data.
   */
  function installEventSourceHook() {
    if (typeof window.EventSource !== 'function') {
      return;
    }

    const NativeEventSource = window.EventSource;

    function WrappedEventSource(url, configuration) {
      const eventSource = new NativeEventSource(url, configuration);
      const requestUrl = toAbsoluteUrl(url);

      eventSource.addEventListener('message', (event) => {
        if (typeof event.data === 'string') {
          handleIncomingChunk('eventsource', requestUrl, event.data);
        }
      });
      eventSource.addEventListener('error', () => {
        handleIncomingStreamEnd('eventsource', requestUrl);
      });

      return eventSource;
    }

    WrappedEventSource.prototype = NativeEventSource.prototype;
    window.EventSource = WrappedEventSource;
  }

  /**
   * Handles postMessage control commands from content script.
   * @param {MessageEvent} event
   */
  function handleControlMessage(event) {
    if (event.source !== window) {
      return;
    }

    const data = event.data;
    if (!data || typeof data !== 'object' || data.source !== CAPTURE_CONTENT_EVENT_SOURCE) {
      return;
    }

    const type = typeof data.type === 'string' ? data.type : '';
    const payload = data.payload && typeof data.payload === 'object' ? data.payload : {};

    if (type === CAPTURE_EVENT_TYPES.START) {
      startSession(payload);
      return;
    }

    if (type === CAPTURE_EVENT_TYPES.STOP) {
      stopSession(payload);
    }
  }

  installFetchHook();
  installXhrHook();
  installWebSocketHook();
  installEventSourceHook();
  window.addEventListener('message', handleControlMessage);

  postCaptureEvent(CAPTURE_EVENT_TYPES.READY, {
    installed: true,
    reused: false
  });
})();
