import pool from '../config/database.js';

const VALID_ROLES = new Set(['USER', 'ASSISTANT', 'SYSTEM']);
const VALID_STATUSES = new Set(['PENDING', 'COMPLETED', 'ERROR']);
const UPDATABLE_FIELDS = new Set([
  'role',
  'content',
  'model',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'latency_ms',
  'status'
]);

export const normalizeChatMessage = (row) => ({
  message_id: Number(row.message_id),
  project_id: Number(row.project_id),
  user_id: row.user_id,
  role: row.role,
  content: row.content,
  model: row.model,
  prompt_tokens: row.prompt_tokens ?? 0,
  completion_tokens: row.completion_tokens ?? 0,
  total_tokens: row.total_tokens ?? 0,
  latency_ms: row.latency_ms,
  status: row.status,
  created_at: row.created_at
});

const normalizePositiveInteger = (value, fallback, max = 100) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
};

const normalizeNonNegativeInteger = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) return fallback;
  return parsed;
};

const normalizeInteger = (value, fallback = 0) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return parsed;
};

const validateRole = (role) => {
  if (!VALID_ROLES.has(role)) {
    throw new Error(`Invalid chat message role: ${role}`);
  }
};

const validateStatus = (status) => {
  if (!VALID_STATUSES.has(status)) {
    throw new Error(`Invalid chat message status: ${status}`);
  }
};

export const createChatMessage = async ({
  projectId,
  userId,
  role,
  content,
  model = null,
  promptTokens = 0,
  completionTokens = 0,
  totalTokens = 0,
  latencyMs = null,
  status = 'COMPLETED'
}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!userId) throw new Error('userId is required');
  if (!content) throw new Error('content is required');

  validateRole(role);
  validateStatus(status);

  const query = `
    INSERT INTO "Project_Chat_Message" (
      project_id,
      user_id,
      role,
      content,
      model,
      prompt_tokens,
      completion_tokens,
      total_tokens,
      latency_ms,
      status
    )
    VALUES ($1, $2::uuid, $3::message_role, $4, $5, $6, $7, $8, $9, $10::message_status)
    RETURNING *;
  `;

  const values = [
    projectId,
    userId,
    role,
    content,
    model,
    normalizeInteger(promptTokens),
    normalizeInteger(completionTokens),
    normalizeInteger(totalTokens),
    latencyMs === null || latencyMs === undefined ? null : normalizeInteger(latencyMs, null),
    status
  ];

  const result = await pool.query(query, values);
  return normalizeChatMessage(result.rows[0]);
};

export const getProjectChatMessages = async (projectId, userId, options = {}) => {
  if (!projectId) throw new Error('projectId is required');
  if (!userId) throw new Error('userId is required');

  const limit = normalizePositiveInteger(options.limit, 50, 100);
  const offset = normalizeNonNegativeInteger(options.offset, 0);
  const order = String(options.order || 'asc').toLowerCase() === 'desc' ? 'DESC' : 'ASC';

  const query = `
    SELECT *
    FROM "Project_Chat_Message"
    WHERE project_id = $1
      AND user_id = $2::uuid
    ORDER BY created_at ${order}, message_id ${order}
    LIMIT $3 OFFSET $4;
  `;

  const result = await pool.query(query, [projectId, userId, limit, offset]);
  return result.rows.map(normalizeChatMessage);
};

export const getChatMessageById = async (messageId, projectId, userId) => {
  const query = `
    SELECT *
    FROM "Project_Chat_Message"
    WHERE message_id = $1
      AND project_id = $2
      AND user_id = $3::uuid
    LIMIT 1;
  `;

  const result = await pool.query(query, [messageId, projectId, userId]);
  return result.rows[0] ? normalizeChatMessage(result.rows[0]) : null;
};

const mapPayloadToDbFields = (payload) => {
  const fieldMap = {
    role: 'role',
    content: 'content',
    model: 'model',
    promptTokens: 'prompt_tokens',
    prompt_tokens: 'prompt_tokens',
    completionTokens: 'completion_tokens',
    completion_tokens: 'completion_tokens',
    totalTokens: 'total_tokens',
    total_tokens: 'total_tokens',
    latencyMs: 'latency_ms',
    latency_ms: 'latency_ms',
    status: 'status'
  };

  const updates = {};
  for (const [key, value] of Object.entries(payload || {})) {
    const dbField = fieldMap[key];
    if (dbField && UPDATABLE_FIELDS.has(dbField)) {
      updates[dbField] = value;
    }
  }

  return updates;
};

export const updateChatMessage = async (messageId, projectId, userId, payload = {}) => {
  const updates = mapPayloadToDbFields(payload);

  if (updates.role) validateRole(updates.role);
  if (updates.status) validateStatus(updates.status);

  const entries = Object.entries(updates);
  if (entries.length === 0) {
    return getChatMessageById(messageId, projectId, userId);
  }

  const setClauses = [];
  const values = [];

  entries.forEach(([field, value], index) => {
    values.push(value);
    const paramIndex = index + 1;
    if (field === 'role') {
      setClauses.push(`${field} = $${paramIndex}::message_role`);
    } else if (field === 'status') {
      setClauses.push(`${field} = $${paramIndex}::message_status`);
    } else if (['prompt_tokens', 'completion_tokens', 'total_tokens', 'latency_ms'].includes(field)) {
      setClauses.push(`${field} = $${paramIndex}::integer`);
    } else {
      setClauses.push(`${field} = $${paramIndex}`);
    }
  });

  values.push(messageId, projectId, userId);

  const query = `
    UPDATE "Project_Chat_Message"
    SET ${setClauses.join(', ')}
    WHERE message_id = $${values.length - 2}
      AND project_id = $${values.length - 1}
      AND user_id = $${values.length}::uuid
    RETURNING *;
  `;

  const result = await pool.query(query, values);
  return result.rows[0] ? normalizeChatMessage(result.rows[0]) : null;
};

export const deleteChatMessage = async (messageId, projectId, userId) => {
  const query = `
    DELETE FROM "Project_Chat_Message"
    WHERE message_id = $1
      AND project_id = $2
      AND user_id = $3::uuid;
  `;

  const result = await pool.query(query, [messageId, projectId, userId]);
  return { deleted_count: result.rowCount };
};

export const deleteProjectChatMessages = async (projectId, userId) => {
  const query = `
    DELETE FROM "Project_Chat_Message"
    WHERE project_id = $1
      AND user_id = $2::uuid;
  `;

  const result = await pool.query(query, [projectId, userId]);
  return { deleted_count: result.rowCount };
};
