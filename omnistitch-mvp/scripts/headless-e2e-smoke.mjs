#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const extensionPath = path.resolve(__dirname, '..');
const chromeForTestingPath =
  '/Users/bytedance/Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const defaultChromePath = fs.existsSync(chromeForTestingPath)
  ? chromeForTestingPath
  : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const debugPort = Number(process.env.OMNISTITCH_CDP_PORT || 9230);
const defaultUserDataDir = `/tmp/omnistitch-headless-e2e-profile-${Date.now()}`;
const userDataDir = process.env.OMNISTITCH_HEADLESS_PROFILE || defaultUserDataDir;
const sourceUrl = process.env.OMNISTITCH_TEST_SOURCE_URL || 'https://example.com/omnistitch-headless-smoke';
const sourceTitle = process.env.OMNISTITCH_TEST_SOURCE_TITLE || 'OmniStitch Headless Smoke';
const timeoutMs = Number(process.env.OMNISTITCH_TEST_TIMEOUT_MS || 45000);
const chromePath = process.env.OMNISTITCH_CHROME_PATH || defaultChromePath;
const TARGET_HOSTS = new Set(['chatgpt.com', 'www.kimi.com', 'chat.deepseek.com', 'gemini.google.com']);
const EXPECTED_EXTENSION_NAME = 'OmniStitch MVP';

/**
 * Parses command line args in --key=value form.
 * @returns {{chromePath:string,timeoutMs:number,sourceUrl:string,sourceTitle:string}}
 */
function parseArgs() {
  const result = {
    chromePath,
    timeoutMs,
    sourceUrl,
    sourceTitle
  };
  for (const arg of process.argv.slice(2)) {
    if (!arg.startsWith('--') || !arg.includes('=')) {
      continue;
    }
    const [rawKey, ...rawValueParts] = arg.slice(2).split('=');
    const value = rawValueParts.join('=');
    if (rawKey === 'chrome-path' && value) {
      result.chromePath = value;
      continue;
    }
    if (rawKey === 'timeout-ms') {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) {
        result.timeoutMs = parsed;
      }
      continue;
    }
    if (rawKey === 'source-url' && value) {
      result.sourceUrl = value;
      continue;
    }
    if (rawKey === 'source-title' && value) {
      result.sourceTitle = value;
    }
  }
  return result;
}

/**
 * Fetches JSON from one CDP HTTP endpoint.
 * @param {string} endpoint
 * @returns {Promise<unknown>}
 */
async function fetchJson(endpoint) {
  const response = await fetch(`http://127.0.0.1:${debugPort}${endpoint}`);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${endpoint}`);
  }
  return response.json();
}

/**
 * Waits for CDP endpoint to be reachable.
 * @param {number} waitTimeoutMs
 * @returns {Promise<void>}
 */
async function waitForCdpReady(waitTimeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < waitTimeoutMs) {
    try {
      await fetchJson('/json/version');
      return;
    } catch (_error) {
      await sleep(250);
    }
  }
  throw new Error('CDP endpoint did not become ready in time.');
}

/**
 * Reads one extension worker identity from CDP runtime context.
 * @param {string} wsUrl
 * @returns {Promise<{name:string,id:string}|null>}
 */
async function readExtensionWorkerIdentity(wsUrl) {
  const client = new CdpClient(wsUrl);
  await client.connect();
  try {
    await client.send('Runtime.enable');
    const evaluation = /** @type {{result?: {value?: {name?:string,id?:string}}}} */ (
      await client.send('Runtime.evaluate', {
        expression:
          '(() => ({ name: chrome.runtime.getManifest().name, id: chrome.runtime.id }))()',
        returnByValue: true,
        awaitPromise: true
      })
    );
    const name = evaluation?.result?.value?.name;
    const id = evaluation?.result?.value?.id;
    if (typeof name === 'string' && typeof id === 'string' && name && id) {
      return { name, id };
    }
    return null;
  } catch (_error) {
    return null;
  } finally {
    client.close();
  }
}

/**
 * Finds OmniStitch extension service worker target for this browser session.
 * @param {number} waitTimeoutMs
 * @returns {Promise<{wsUrl:string,targetUrl:string,extensionId:string}>}
 */
async function waitForExtensionWorker(waitTimeoutMs) {
  const startedAt = Date.now();
  /** @type {Array<{type:string,url:string}>} */
  let observedTargets = [];
  while (Date.now() - startedAt < waitTimeoutMs) {
    const targets = /** @type {Array<Record<string, unknown>>} */ (await fetchJson('/json/list'));
    observedTargets = targets.map((target) => ({
      type: typeof target.type === 'string' ? target.type : '',
      url: typeof target.url === 'string' ? target.url : ''
    }));
    for (const target of targets) {
      const targetType = typeof target.type === 'string' ? target.type : '';
      const targetUrl = typeof target.url === 'string' ? target.url : '';
      const wsUrl = typeof target.webSocketDebuggerUrl === 'string' ? target.webSocketDebuggerUrl : '';
      if (targetType !== 'service_worker' || !targetUrl.startsWith('chrome-extension://') || !wsUrl) {
        continue;
      }
      const identity = await readExtensionWorkerIdentity(wsUrl);
      if (!identity || identity.name !== EXPECTED_EXTENSION_NAME) {
        continue;
      }
      return {
        wsUrl,
        targetUrl,
        extensionId: identity.id
      };
    }
    await sleep(250);
  }
  throw new Error(
    `Extension service worker target was not found. Observed targets: ${JSON.stringify(
      observedTargets.slice(0, 20)
    )}`
  );
}

/**
 * Minimal CDP websocket client for one debugging target.
 */
class CdpClient {
  /**
   * @param {string} wsUrl
   */
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
  }

  /**
   * Opens websocket connection to CDP target.
   * @returns {Promise<void>}
   */
  async connect() {
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const onOpen = () => {
        ws.removeEventListener('error', onError);
        this.ws = ws;
        resolve(undefined);
      };
      const onError = (error) => {
        reject(error);
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data));
          if (!message || typeof message.id !== 'number') {
            return;
          }
          const handlers = this.pending.get(message.id);
          if (!handlers) {
            return;
          }
          this.pending.delete(message.id);
          if (message.error) {
            handlers.reject(new Error(JSON.stringify(message.error)));
            return;
          }
          handlers.resolve(message.result || {});
        } catch (_error) {
          // Ignore malformed payloads in smoke checks.
        }
      });
      ws.addEventListener('close', () => {
        for (const handlers of this.pending.values()) {
          handlers.reject(new Error('CDP websocket closed unexpectedly.'));
        }
        this.pending.clear();
      });
    });
  }

  /**
   * Sends one CDP command.
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @returns {Promise<unknown>}
   */
  async send(method, params = {}) {
    if (!this.ws) {
      throw new Error('CDP websocket is not connected.');
    }
    const id = ++this.id;
    const payload = {
      id,
      method,
      params
    };
    const responsePromise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.ws.send(JSON.stringify(payload));
    return responsePromise;
  }

  /**
   * Closes websocket connection.
   */
  close() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * Calls service-worker test API directly from CDP worker context.
 * @param {string} wsUrl
 * @param {string} triggerSourceUrl
 * @param {string} triggerSourceTitle
 * @returns {Promise<Record<string, unknown>>}
 */
async function triggerSendFlow(wsUrl, triggerSourceUrl, triggerSourceTitle) {
  const client = new CdpClient(wsUrl);
  await client.connect();
  try {
      await client.send('Runtime.enable');
    const evaluation = /** @type {{result?: {value?: Record<string, unknown>}}} */ (
      await client.send('Runtime.evaluate', {
        expression: `
          (async () => {
            try {
              const api = self.__OMNISTITCH_TEST_API__;
              if (!api || typeof api.runSendFlowFromSource !== 'function') {
                return {
                  ok: false,
                  error: 'Service worker test API is unavailable.'
                };
              }
              const result = await api.runSendFlowFromSource(
                ${JSON.stringify(triggerSourceUrl)},
                ${JSON.stringify(triggerSourceTitle)}
              );
              return {
                ok: true,
                messageResult: result || null
              };
            } catch (error) {
              return {
                ok: false,
                error: String(error)
              };
            }
          })();
        `,
        awaitPromise: true,
        returnByValue: true
      })
    );
    return evaluation?.result?.value || { ok: false, error: 'Empty evaluation result.' };
  } finally {
    client.close();
  }
}

/**
 * Polls browser targets and records which configured hosts are opened.
 * @param {number} waitTimeoutMs
 * @returns {Promise<{openedHosts:string[],latestPageUrls:string[]}>}
 */
async function waitForOpenedTargets(waitTimeoutMs) {
  const startedAt = Date.now();
  const openedHosts = new Set();
  let latestPageUrls = [];

  while (Date.now() - startedAt < waitTimeoutMs) {
    const targets = /** @type {Array<Record<string, unknown>>} */ (await fetchJson('/json/list'));
    latestPageUrls = targets
      .filter((target) => target.type === 'page' && typeof target.url === 'string')
      .map((target) => String(target.url));

    for (const pageUrl of latestPageUrls) {
      try {
        const parsed = new URL(pageUrl);
        if (TARGET_HOSTS.has(parsed.host)) {
          openedHosts.add(parsed.host);
        }
      } catch (_error) {
        // Ignore non-standard page URLs.
      }
    }

    if (openedHosts.size === TARGET_HOSTS.size) {
      break;
    }
    await sleep(400);
  }

  return {
    openedHosts: Array.from(openedHosts).sort(),
    latestPageUrls
  };
}

/**
 * Runs the headless smoke check and prints JSON result.
 * @returns {Promise<number>}
 */
async function main() {
  const args = parseArgs();
  const chromeArgs = [
    '--headless=new',
    '--disable-gpu',
    '--disable-extension-content-verification',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    'about:blank'
  ];

  const chrome = spawn(args.chromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  chrome.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  chrome.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForCdpReady(args.timeoutMs);
    const worker = await waitForExtensionWorker(args.timeoutMs);
    const triggerResult = await triggerSendFlow(worker.wsUrl, args.sourceUrl, args.sourceTitle);
    await sleep(2000);
    const openedTargetState = await waitForOpenedTargets(args.timeoutMs);

    const missingHosts = Array.from(TARGET_HOSTS).filter((host) => !openedTargetState.openedHosts.includes(host));
    const responseOk =
      triggerResult &&
      typeof triggerResult === 'object' &&
      triggerResult.ok === true &&
      triggerResult.messageResult &&
      typeof triggerResult.messageResult === 'object' &&
      triggerResult.messageResult.ok === true;
    const ok = Boolean(responseOk) && missingHosts.length === 0;

    console.log(
      JSON.stringify(
        {
          ok,
          extensionId: worker.extensionId,
          workerUrl: worker.targetUrl,
          triggerResult,
          openedTargetHosts: openedTargetState.openedHosts,
          missingTargetHosts: missingHosts,
          observedPageUrlsSample: openedTargetState.latestPageUrls.slice(0, 20),
          stdoutTail: stdout.slice(-600),
          stderrTail: stderr.slice(-600)
        },
        null,
        2
      )
    );
    return ok ? 0 : 1;
  } catch (error) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: 'runtime-error',
          error: String(error),
          stdoutTail: stdout.slice(-600),
          stderrTail: stderr.slice(-600)
        },
        null,
        2
      )
    );
    return 1;
  } finally {
    chrome.kill('SIGTERM');
    await sleep(300);
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.log(
      JSON.stringify(
        {
          ok: false,
          reason: 'unexpected-error',
          error: String(error)
        },
        null,
        2
      )
    );
    process.exitCode = 1;
  });
