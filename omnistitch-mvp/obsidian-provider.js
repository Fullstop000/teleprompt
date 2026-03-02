const OBSIDIAN_PROVIDER_LOG_PREFIX = '[omnistitch][obsidian-provider]';

/**
 * Writes provider debug logs with a stable prefix.
 * @param {...unknown} args
 */
function logObsidianInfo(...args) {
  console.log(OBSIDIAN_PROVIDER_LOG_PREFIX, ...args);
}

/**
 * Builds one markdown note body for one AI response payload.
 * @param {{taskId: string, targetSite: string, sourceUrl: string, sourceTitle: string, aiResponse: string, capturedAt: string}} payload
 * @returns {string}
 */
function buildNoteMarkdown(payload) {
  return [
    '# OmniStitch AI Sync',
    `- taskid: ${payload.taskId}`,
    `- target: ${payload.targetSite}`,
    `- time: ${payload.capturedAt}`,
    `- sourceUrl: ${payload.sourceUrl || 'N/A'}`,
    '',
    '### AI回复',
    payload.aiResponse,
    '',
    '---',
    ''
  ].join('\n');
}

/**
 * Normalizes one path segment to avoid invalid filename characters.
 * @param {string} input
 * @returns {string}
 */
function sanitizeFilenameSegment(input) {
  return String(input || '')
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]+/g, '-')
    .replace(/\.+$/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 120);
}

/**
 * Builds date folder string with local date format: YYYY-MM-DD.
 * @param {Date} date
 * @returns {string}
 */
function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Builds one vault path for note creation:
 * Daily/OmniStitch/YYYY-MM-DD/{article title}/{target}/{timestamp}-{taskId}.md
 * @param {{taskId: string, targetSite: string, sourceUrl: string, sourceTitle: string, capturedAt: string}} payload
 * @returns {string}
 */
function buildNotePath(payload) {
  const capturedDate = new Date(payload.capturedAt || Date.now());
  const safeDate = Number.isNaN(capturedDate.getTime()) ? new Date() : capturedDate;
  const dateFolder = formatLocalDate(safeDate);
  const timePart = safeDate.toISOString().replace(/[:.]/g, '-');
  const articleTitleRaw = payload.sourceTitle || payload.sourceUrl || 'untitled';
  const articlePart = sanitizeFilenameSegment(articleTitleRaw) || 'untitled';
  const targetPart = sanitizeFilenameSegment(payload.targetSite || 'unknown') || 'unknown';
  const taskPart = sanitizeFilenameSegment(payload.taskId || Date.now().toString()) || 'unknown-task';
  const fileName = `${timePart}-${taskPart}.md`;
  return `Daily/OmniStitch/${dateFolder}/${articlePart}/${targetPart}/${fileName}`;
}

/**
 * Sends markdown content to Obsidian Local REST API and creates one new note.
 * @param {{taskId: string, targetSite: string, sourceUrl: string, sourceTitle: string, aiResponse: string, capturedAt: string}} payload
 * @param {{obsidianBaseUrl:string,obsidianApiKey:string}} settings
 */
async function sync(payload, settings) {
  let parsedBaseUrl;
  try {
    parsedBaseUrl = new URL(settings.obsidianBaseUrl);
  } catch (error) {
    throw new Error('Obsidian base URL is invalid.');
  }

  if (!/^https?:$/i.test(parsedBaseUrl.protocol)) {
    throw new Error('Obsidian base URL protocol must be http or https.');
  }

  const notePath = buildNotePath(payload);
  const endpoint = new URL(`/vault/${encodeURIComponent(notePath)}`, parsedBaseUrl.toString());
  const markdown = buildNoteMarkdown(payload);

  const response = await fetch(endpoint.toString(), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${settings.obsidianApiKey}`,
      'Content-Type': 'text/markdown',
      Accept: 'application/json, text/plain;q=0.9, */*;q=0.8'
    },
    body: markdown
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Obsidian sync failed with HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`
    );
  }

  logObsidianInfo('Obsidian note creation succeeded.', {
    taskId: payload.taskId,
    targetSite: payload.targetSite,
    notePath,
    endpoint: endpoint.origin
  });
}

/**
 * Exposes Obsidian provider API for background orchestrator.
 */
self.OmnistitchObsidianProvider = {
  sync
};
