const WEBHOOK_PROVIDER_LOG_PREFIX = '[omnistitch][webhook-provider]';

/**
 * Writes provider debug logs with a stable prefix.
 * @param {...unknown} args
 */
function logWebhookInfo(...args) {
  console.log(WEBHOOK_PROVIDER_LOG_PREFIX, ...args);
}

/**
 * Syncs one normalized payload to configured webhook endpoint.
 * @param {{taskId: string, targetSite: string, sourceUrl: string, aiResponse: string, capturedAt: string}} payload
 * @param {{webhookUrl:string,webhookAuthToken:string}} settings
 */
async function sync(payload, settings) {
  let parsedUrl;
  try {
    parsedUrl = new URL(settings.webhookUrl);
  } catch (error) {
    throw new Error('Webhook URL is invalid.');
  }

  if (!/^https?:$/i.test(parsedUrl.protocol)) {
    throw new Error('Webhook URL protocol must be http or https.');
  }

  const headers = {
    'Content-Type': 'application/json',
    'X-Omnistitch-Source': 'teleprompt-extension'
  };

  if (settings.webhookAuthToken) {
    headers.Authorization = `Bearer ${settings.webhookAuthToken}`;
  }

  // Capture dump is test-only. Include it only when content script explicitly provides it.
  const enrichedRawPayload = {
    ...(payload || {}),
    agentSite: payload.targetSite
  };
  if (!(typeof enrichedRawPayload.captureDump === 'string' && enrichedRawPayload.captureDump.trim())) {
    delete enrichedRawPayload.captureDump;
  }

  const response = await fetch(parsedUrl.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      taskid: payload.taskId,
      agent: payload.targetSite,
      target: payload.targetSite,
      time: payload.capturedAt,
      aiResponse: payload.aiResponse,
      sourceUrl: payload.sourceUrl,
      raw: enrichedRawPayload
    })
  });

  if (!response.ok) {
    throw new Error(`Webhook sync failed with HTTP ${response.status}`);
  }

  logWebhookInfo('Webhook sync succeeded.', {
    taskId: payload.taskId,
    targetSite: payload.targetSite,
    webhookUrl: parsedUrl.origin
  });
}

/**
 * Exposes webhook provider API for background orchestrator.
 */
self.OmnistitchWebhookProvider = {
  sync
};
