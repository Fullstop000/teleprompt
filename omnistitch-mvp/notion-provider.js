const NOTION_API_BASE_URL = 'https://api.notion.com/v1';
const NOTION_API_VERSION = '2022-06-28';
const NOTION_RICH_TEXT_CHUNK_SIZE = 1800;
const NOTION_PROVIDER_LOG_PREFIX = '[omnistitch][notion-provider]';

/**
 * Shared cache for Notion database schemas to reduce repeated API requests.
 * Keyed by notionDatabaseId.
 * @type {Map<string, {titlePropertyName: string, properties: Record<string, {type:string}>}>}
 */
const notionDatabaseSchemaCache = new Map();

/**
 * Writes provider debug logs with a stable prefix.
 * @param {...unknown} args
 */
function logNotionInfo(...args) {
  console.log(NOTION_PROVIDER_LOG_PREFIX, ...args);
}

/**
 * Converts plain text into Notion rich-text chunk array.
 * @param {string} text
 * @returns {Array<{type:'text',text:{content:string}}>}
 */
function buildNotionRichText(text) {
  const normalizedText = String(text || '').trim();
  const safeText = normalizedText || ' ';
  const chunks = [];

  for (let cursor = 0; cursor < safeText.length; cursor += NOTION_RICH_TEXT_CHUNK_SIZE) {
    chunks.push({
      type: 'text',
      text: {
        content: safeText.slice(cursor, cursor + NOTION_RICH_TEXT_CHUNK_SIZE)
      }
    });
  }

  if (chunks.length === 0) {
    chunks.push({
      type: 'text',
      text: {
        content: ' '
      }
    });
  }

  return chunks;
}

/**
 * Builds one Notion property payload according to actual property type.
 * @param {{type: string}} propertyDefinition
 * @param {string|number|boolean} rawValue
 * @returns {Record<string, unknown>}
 */
function buildNotionPropertyValue(propertyDefinition, rawValue) {
  if (!propertyDefinition || typeof propertyDefinition.type !== 'string') {
    throw new Error('Invalid notion property definition.');
  }

  const valueAsString = String(rawValue ?? '').trim();
  const type = propertyDefinition.type;

  if (type === 'title') {
    return {
      title: buildNotionRichText(valueAsString || 'untitled')
    };
  }

  if (type === 'rich_text') {
    return {
      rich_text: buildNotionRichText(valueAsString)
    };
  }

  if (type === 'date') {
    const date = new Date(valueAsString);
    return {
      date: {
        start: Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
      }
    };
  }

  if (type === 'select') {
    return {
      select: {
        name: valueAsString || 'unknown'
      }
    };
  }

  if (type === 'multi_select') {
    return {
      multi_select: [
        {
          name: valueAsString || 'unknown'
        }
      ]
    };
  }

  if (type === 'status') {
    return {
      status: {
        name: valueAsString || 'Unknown'
      }
    };
  }

  if (type === 'number') {
    const asNumber = Number(rawValue);
    return {
      number: Number.isFinite(asNumber) ? asNumber : Date.now()
    };
  }

  throw new Error(`Unsupported notion field type: ${type}`);
}

/**
 * Sends one request to Notion API with standard headers and error parsing.
 * @param {string} path
 * @param {'GET'|'POST'} method
 * @param {string} token
 * @param {object|undefined} body
 * @returns {Promise<any>}
 */
async function requestNotion(path, method, token, body) {
  const response = await fetch(`${NOTION_API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Notion-Version': NOTION_API_VERSION,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const responseText = await response.text();
  let parsed;
  try {
    parsed = responseText ? JSON.parse(responseText) : {};
  } catch (_error) {
    parsed = {};
  }

  if (!response.ok) {
    const message = parsed && typeof parsed.message === 'string' ? parsed.message : `HTTP ${response.status}`;
    throw new Error(message);
  }

  return parsed;
}

/**
 * Loads and caches Notion database schema for property type mapping.
 * @param {{notionToken:string,notionDatabaseId:string}} settings
 * @returns {Promise<{titlePropertyName: string, properties: Record<string, {type:string}>}>}
 */
async function getNotionDatabaseSchema(settings) {
  const cacheKey = settings.notionDatabaseId;
  if (notionDatabaseSchemaCache.has(cacheKey)) {
    return notionDatabaseSchemaCache.get(cacheKey);
  }

  const schema = await requestNotion(`/databases/${settings.notionDatabaseId}`, 'GET', settings.notionToken);
  const properties = schema && schema.properties ? schema.properties : null;
  if (!properties || typeof properties !== 'object') {
    throw new Error('Notion database schema is invalid.');
  }

  let titlePropertyName = '';
  for (const [propertyName, propertyDefinition] of Object.entries(properties)) {
    if (propertyDefinition && typeof propertyDefinition === 'object' && propertyDefinition.type === 'title') {
      titlePropertyName = propertyName;
      break;
    }
  }

  if (!titlePropertyName) {
    throw new Error('No title property found in notion database.');
  }

  const requiredFieldNames = ['AI回复', 'target', '时间', 'taskid'];
  for (const fieldName of requiredFieldNames) {
    if (!Object.prototype.hasOwnProperty.call(properties, fieldName)) {
      throw new Error(`Notion database missing field: ${fieldName}`);
    }
  }

  const mappedSchema = {
    titlePropertyName,
    properties
  };
  notionDatabaseSchemaCache.set(cacheKey, mappedSchema);
  return mappedSchema;
}

/**
 * Builds Notion page properties from one normalized AI response payload.
 * @param {{titlePropertyName: string, properties: Record<string, {type:string}>}} schema
 * @param {{taskId: string, targetSite: string, aiResponse: string, capturedAt: string}} payload
 * @returns {Record<string, unknown>}
 */
function buildNotionPageProperties(schema, payload) {
  const properties = {};
  properties[schema.titlePropertyName] = buildNotionPropertyValue(
    schema.properties[schema.titlePropertyName],
    `${payload.taskId}-${payload.targetSite}`
  );
  properties['AI回复'] = buildNotionPropertyValue(schema.properties['AI回复'], payload.aiResponse);
  properties.target = buildNotionPropertyValue(schema.properties.target, payload.targetSite);
  properties['时间'] = buildNotionPropertyValue(schema.properties['时间'], payload.capturedAt);
  properties.taskid = buildNotionPropertyValue(schema.properties.taskid, payload.taskId);
  return properties;
}

/**
 * Syncs one normalized payload to the configured Notion database.
 * @param {{taskId: string, targetSite: string, aiResponse: string, capturedAt: string}} payload
 * @param {{notionToken:string,notionDatabaseId:string}} settings
 */
async function sync(payload, settings) {
  const schema = await getNotionDatabaseSchema(settings);
  const properties = buildNotionPageProperties(schema, payload);

  await requestNotion('/pages', 'POST', settings.notionToken, {
    parent: {
      database_id: settings.notionDatabaseId
    },
    properties
  });

  logNotionInfo('Notion sync succeeded.', {
    taskId: payload.taskId,
    targetSite: payload.targetSite
  });
}

/**
 * Clears in-memory provider cache.
 */
function clearCache() {
  notionDatabaseSchemaCache.clear();
}

/**
 * Exposes Notion provider APIs for background orchestrator.
 */
self.OmnistitchNotionProvider = {
  sync,
  clearCache
};
