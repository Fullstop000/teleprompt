(function mainWorldResponseCaptureBootstrap() {
  const CAPTURE_MAIN_EVENT_SOURCE = 'omnistitch_capture_main';
  const CAPTURE_CONTENT_EVENT_SOURCE = 'omnistitch_capture_content';
  const CAPTURE_EVENT_TYPES = {
    START: 'OMNISTITCH_CAPTURE_START',
    STOP: 'OMNISTITCH_CAPTURE_STOP',
    READY: 'OMNISTITCH_CAPTURE_READY',
    ACK: 'OMNISTITCH_CAPTURE_ACK',
    OBSERVED: 'OMNISTITCH_CAPTURE_OBSERVED',
    CHUNK: 'OMNISTITCH_CAPTURE_CHUNK',
    STREAM_END: 'OMNISTITCH_CAPTURE_STREAM_END',
    FINAL: 'OMNISTITCH_CAPTURE_FINAL',
    ERROR: 'OMNISTITCH_CAPTURE_ERROR'
  };
  const CAPTURE_IDLE_TIMEOUT_MS = 2500;
  const CAPTURE_HARD_TIMEOUT_MS = 180000;
  const CAPTURE_STREAM_END_GRACE_MS = 800;
  const PRESESSION_BUFFER_MAX_EVENTS = 300;
  const PRESESSION_BUFFER_BACKLOOK_MS = 12000;
  const MAIN_LOG_PREFIX = '[omnistitch][capture-main]';

  /**
   * Writes one main-world capture debug log line.
   * @param {...unknown} args
   */
  function logMainInfo(...args) {
    console.log(MAIN_LOG_PREFIX, ...args);
  }

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
   *  observedCount:number,
   *  captureChannel:string,
   *  captureSourceUrl:string,
   *  dumpAllObserved:boolean,
   *  idleTimer:number|null,
   *  hardTimer:number|null,
   *  finalTimer:number|null,
   *  finalized:boolean
   * }}
   */
  let activeSession = null;
  /**
   * Buffered network events captured before content sends START.
   * @type {Array<{eventType:'chunk'|'stream_end',captureChannel:'fetch'|'xhr'|'websocket'|'eventsource',requestUrl:string,requestMethod:string,chunk:string,timestamp:number}>}
   */
  let preSessionBufferedEvents = [];

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
   * Normalizes capture inspection response to stable shape.
   * @param {unknown} raw
   * @param {string} fallbackRequestUrl
   * @returns {{
   *   requestUrl:string,
   *   isValidUrl:boolean,
   *   isAllowedHost:boolean,
   *   hasKeyword:boolean,
   *   shouldTrack:boolean,
   *   matchLabel:string
   * }}
   */
  function normalizeInspection(raw, fallbackRequestUrl) {
    if (!raw || typeof raw !== 'object') {
      return {
        requestUrl: fallbackRequestUrl || '',
        isValidUrl: false,
        isAllowedHost: false,
        hasKeyword: false,
        shouldTrack: false,
        matchLabel: ''
      };
    }

    return {
      requestUrl: typeof raw.requestUrl === 'string' ? raw.requestUrl : fallbackRequestUrl || '',
      isValidUrl: Boolean(raw.isValidUrl),
      isAllowedHost: Boolean(raw.isAllowedHost),
      hasKeyword: Boolean(raw.hasKeyword),
      shouldTrack: Boolean(raw.shouldTrack),
      matchLabel: typeof raw.matchLabel === 'string' ? raw.matchLabel : ''
    };
  }

  /**
   * Inspects one URL against host + keyword tracking rules.
   * @param {string} requestUrl
   * @param {string} targetSite
   * @param {string} requestMethod
   * @returns {{requestUrl:string,isValidUrl:boolean,isAllowedHost:boolean,hasKeyword:boolean,shouldTrack:boolean}}
   */
  function inspectRequestUrl(requestUrl, targetSite, requestMethod = '') {
    const normalizedSite = String(targetSite || '').trim().toLowerCase();
    const method = String(requestMethod || '').trim().toUpperCase();
    const rules = globalThis.__OMNISTITCH_CAPTURE_RULES__ || null;
    const siteRule =
      rules && typeof rules === 'object' && typeof rules[normalizedSite] === 'function'
        ? rules[normalizedSite]
        : null;
    const genericInspector =
      typeof globalThis.inspectOmnistitchGenericCaptureRequest === 'function'
        ? globalThis.inspectOmnistitchGenericCaptureRequest
        : null;
    let inspected = null;

    try {
      if (siteRule) {
        inspected = siteRule(requestUrl, method);
      } else if (genericInspector) {
        inspected = genericInspector(requestUrl, method);
      }
    } catch (_error) {
      inspected = null;
    }

    if (!inspected && genericInspector) {
      try {
        inspected = genericInspector(requestUrl, method);
      } catch (_error) {
        inspected = null;
      }
    }

    return normalizeInspection(inspected, requestUrl || '');
  }

  /**
   * Checks whether one URL should be tracked by active session filters.
   * @param {string} requestUrl
   * @param {string} targetSite
   * @param {string} requestMethod
   * @returns {boolean}
   */
  function shouldTrackRequestUrl(requestUrl, targetSite, requestMethod = '') {
    return inspectRequestUrl(requestUrl, targetSite, requestMethod).shouldTrack;
  }

  /**
   * Prunes stale pre-session buffered events.
   * @param {number} now
   */
  function prunePreSessionBufferedEvents(now) {
    const threshold = now - PRESESSION_BUFFER_BACKLOOK_MS;
    preSessionBufferedEvents = preSessionBufferedEvents.filter((item) => item.timestamp >= threshold);
    if (preSessionBufferedEvents.length > PRESESSION_BUFFER_MAX_EVENTS) {
      preSessionBufferedEvents = preSessionBufferedEvents.slice(
        preSessionBufferedEvents.length - PRESESSION_BUFFER_MAX_EVENTS
      );
    }
  }

  /**
   * Buffers one network event before active session is ready.
   * @param {'chunk'|'stream_end'} eventType
   * @param {'fetch'|'xhr'|'websocket'|'eventsource'} captureChannel
   * @param {string} requestUrl
   * @param {string} chunk
   * @param {string} requestMethod
   */
  function appendPreSessionEvent(eventType, captureChannel, requestUrl, chunk, requestMethod = '') {
    const inspected = inspectRequestUrl(requestUrl, 'unknown', requestMethod);
    if (!inspected.shouldTrack) {
      return;
    }

    const now = Date.now();
    prunePreSessionBufferedEvents(now);
    preSessionBufferedEvents.push({
      eventType,
      captureChannel,
      requestUrl: inspected.requestUrl || requestUrl || '',
      requestMethod: String(requestMethod || '').trim().toUpperCase(),
      chunk: typeof chunk === 'string' ? chunk : '',
      timestamp: now
    });
    prunePreSessionBufferedEvents(now);
  }

  /**
   * Replays recent pre-session buffered events into one started session.
   * @param {typeof activeSession} session
   */
  function flushPreSessionEventsToSession(session) {
    if (!session) {
      return;
    }

    const threshold = session.startedAt - PRESESSION_BUFFER_BACKLOOK_MS;
    const candidates = preSessionBufferedEvents.filter((item) => item.timestamp >= threshold);
    if (candidates.length === 0) {
      return;
    }

    let replayChunkCount = 0;
    let replayStreamEndCount = 0;

    for (const item of candidates) {
      emitObservedEvent(item.eventType, item.captureChannel, item.requestUrl, item.chunk, item.requestMethod);
      if (!shouldTrackRequestUrl(item.requestUrl, session.targetSite, item.requestMethod)) {
        continue;
      }

      if (item.eventType === 'chunk' && item.chunk) {
        session.chunkCount += 1;
        session.captureChannel = item.captureChannel;
        session.captureSourceUrl = item.requestUrl || session.captureSourceUrl;
        replayChunkCount += 1;
        resetIdleFinalizeTimer();
        postCaptureEvent(CAPTURE_EVENT_TYPES.CHUNK, {
          taskId: session.taskId,
          captureChannel: item.captureChannel,
          captureSourceUrl: item.requestUrl,
          chunk: item.chunk,
          timestamp: item.timestamp
        });
        continue;
      }

      if (item.eventType === 'stream_end') {
        replayStreamEndCount += 1;
        postCaptureEvent(CAPTURE_EVENT_TYPES.STREAM_END, {
          taskId: session.taskId,
          captureChannel: item.captureChannel,
          captureSourceUrl: item.requestUrl,
          timestamp: item.timestamp
        });
      }
    }

    if (replayChunkCount > 0 || replayStreamEndCount > 0) {
      logMainInfo(
        `Replayed pre-session events taskId=${session.taskId} target=${session.targetSite} replayChunkCount=${replayChunkCount} replayStreamEndCount=${replayStreamEndCount}`
      );
    }
    prunePreSessionBufferedEvents(Date.now());
  }

  /**
   * Emits one raw observed network event before strict filtering.
   * @param {'chunk'|'stream_end'} observedType
   * @param {'fetch'|'xhr'|'websocket'|'eventsource'} captureChannel
   * @param {string} requestUrl
   * @param {string|undefined} chunk
   * @param {string} requestMethod
   */
  function emitObservedEvent(observedType, captureChannel, requestUrl, chunk, requestMethod = '') {
    if (!activeSession || !activeSession.dumpAllObserved) {
      return;
    }

    if (observedType === 'chunk') {
      activeSession.observedCount += 1;
    }

    const normalizedMethod = String(requestMethod || '').trim().toUpperCase();
    const inspected = inspectRequestUrl(requestUrl, activeSession.targetSite, normalizedMethod);
    postCaptureEvent(CAPTURE_EVENT_TYPES.OBSERVED, {
      taskId: activeSession.taskId,
      observedType,
      captureChannel,
      captureSourceUrl: inspected.requestUrl || requestUrl || '',
      chunk: typeof chunk === 'string' ? chunk : '',
      chunkLength: typeof chunk === 'string' ? chunk.length : 0,
      isValidUrl: inspected.isValidUrl,
      isAllowedHost: inspected.isAllowedHost,
      hasKeyword: inspected.hasKeyword,
      passedFilter: inspected.shouldTrack,
      matchLabel: inspected.matchLabel || '',
      requestMethod: normalizedMethod,
      timestamp: Date.now()
    });

    const preview = typeof chunk === 'string' ? chunk.replace(/\n/g, '\\n').slice(0, 100) : '';
    logMainInfo(
      `Observed network event taskId=${activeSession.taskId} target=${activeSession.targetSite} type=${observedType} channel=${captureChannel} passedFilter=${inspected.shouldTrack} isAllowedHost=${inspected.isAllowedHost} hasKeyword=${inspected.hasKeyword} chunkLength=${
        typeof chunk === 'string' ? chunk.length : 0
      } method=${normalizedMethod || ''} url=${inspected.requestUrl || requestUrl || ''} preview=${JSON.stringify(preview)}`
    );

    if (inspected.matchLabel === 'kimi_chat_service') {
      logMainInfo(
        `Kimi ChatService endpoint observed taskId=${activeSession.taskId} type=${observedType} channel=${captureChannel} passedFilter=${inspected.shouldTrack} url=${inspected.requestUrl}`
      );
    }
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
      if (!activeSession) {
        return;
      }

      const hasFilteredChunks = activeSession.chunkCount > 0;
      if (!hasFilteredChunks) {
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
   * @param {{taskId?: string, targetSite?: string, dumpAllObserved?: boolean}} payload
   */
  function startSession(payload) {
    const taskId = payload && typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
    const targetSite = payload && typeof payload.targetSite === 'string' ? payload.targetSite.trim() : '';
    const dumpAllObserved = Boolean(payload && payload.dumpAllObserved === true);
    if (!taskId) {
      return;
    }

    if (activeSession && activeSession.taskId !== taskId) {
      finalizeActiveSession('replaced_by_new_session');
    }

    if (activeSession && activeSession.taskId === taskId) {
      postCaptureEvent(CAPTURE_EVENT_TYPES.ACK, {
        taskId,
        dumpAllObserved: activeSession.dumpAllObserved
      });
      return;
    }

    const session = {
      taskId,
      targetSite: targetSite || 'unknown',
      startedAt: Date.now(),
      chunkCount: 0,
      observedCount: 0,
      captureChannel: '',
      captureSourceUrl: '',
      dumpAllObserved,
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
      taskId: session.taskId,
      dumpAllObserved: session.dumpAllObserved
    });
    flushPreSessionEventsToSession(session);
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
   * @param {string} requestMethod
   */
  function handleIncomingChunk(captureChannel, requestUrl, rawChunk, requestMethod = '') {
    if (typeof rawChunk !== 'string' || rawChunk.length === 0) {
      return;
    }

    if (!activeSession) {
      appendPreSessionEvent('chunk', captureChannel, requestUrl, rawChunk, requestMethod);
      return;
    }

    emitObservedEvent('chunk', captureChannel, requestUrl, rawChunk, requestMethod);
    if (!shouldTrackRequestUrl(requestUrl, activeSession.targetSite, requestMethod)) {
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
   * @param {string} requestMethod
   */
  function handleIncomingStreamEnd(captureChannel, requestUrl, requestMethod = '') {
    if (!activeSession) {
      appendPreSessionEvent('stream_end', captureChannel, requestUrl, '', requestMethod);
      return;
    }

    emitObservedEvent('stream_end', captureChannel, requestUrl, undefined, requestMethod);
    if (!shouldTrackRequestUrl(requestUrl, activeSession.targetSite, requestMethod)) {
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
   * Decodes one websocket message payload into UTF-8 text when possible.
   * @param {unknown} data
   * @returns {Promise<string>}
   */
  async function decodeWebSocketData(data) {
    if (typeof data === 'string') {
      return data;
    }

    try {
      if (data instanceof ArrayBuffer) {
        return new TextDecoder().decode(new Uint8Array(data));
      }

      if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
        return new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      }

      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        const arrayBuffer = await data.arrayBuffer();
        return new TextDecoder().decode(new Uint8Array(arrayBuffer));
      }
    } catch (_error) {
      return '';
    }

    return '';
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
      const methodFromRequest =
        args[0] instanceof Request
          ? String(args[0].method || 'GET')
          : args[1] && typeof args[1] === 'object' && typeof args[1].method === 'string'
            ? args[1].method
            : 'GET';
      const requestMethod = String(methodFromRequest || 'GET').trim().toUpperCase();
      const response = await nativeFetch.apply(this, args);

      try {
        const shouldMirrorWithoutSession = inspectRequestUrl(requestUrl, 'unknown', requestMethod).shouldTrack;
        if (activeSession || shouldMirrorWithoutSession) {
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
                handleIncomingChunk('fetch', requestUrl, chunk, requestMethod);
              }
            }
          } else {
            const text = await clone.text();
            handleIncomingChunk('fetch', requestUrl, text, requestMethod);
          }

          handleIncomingStreamEnd('fetch', requestUrl, requestMethod);
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
      this.__omniCaptureMethod = String(method || 'GET').trim().toUpperCase();
      return nativeOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function wrappedSend(...args) {
      this.addEventListener('progress', () => {
        try {
          if (typeof this.responseText !== 'string') {
            return;
          }

          const total = this.responseText;
          const consumed = Number.isFinite(this.__omniCaptureLength) ? this.__omniCaptureLength : 0;
          if (total.length <= consumed) {
            return;
          }

          const chunk = total.slice(consumed);
          this.__omniCaptureLength = total.length;
          handleIncomingChunk('xhr', this.__omniCaptureUrl || '', chunk, this.__omniCaptureMethod || '');
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
        handleIncomingStreamEnd('xhr', this.__omniCaptureUrl || '', this.__omniCaptureMethod || '');
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

      socket.addEventListener('message', async (event) => {
        try {
          const decoded = await decodeWebSocketData(event.data);
          if (decoded) {
            handleIncomingChunk('websocket', requestUrl, decoded);
          }
        } catch (error) {
          if (activeSession) {
            postCaptureEvent(CAPTURE_EVENT_TYPES.ERROR, {
              taskId: activeSession.taskId,
              captureChannel: 'websocket',
              captureSourceUrl: requestUrl,
              error: String(error)
            });
          }
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
