import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';

const PORT = Number(process.env.FC_SERVER_PORT || process.env.PORT || 9000);
const MODEL = 'qwen3.5-omni-flash-realtime';
const MAX_BODY_BYTES = 128 * 1024;
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_WINDOW || 10);
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS || 'https://gistudio.github.io')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean),
);
const rateBuckets = new Map();

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && timingSafeEqual(left, right);
}

function requestOrigin(request) {
  return String(request.headers.origin || '').trim();
}

function isAllowedOrigin(origin) {
  return Boolean(origin && ALLOWED_ORIGINS.has(origin));
}

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    Vary: 'Origin',
  };
  if (isAllowedOrigin(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function sendJson(response, status, payload, origin) {
  response.writeHead(status, corsHeaders(origin));
  response.end(JSON.stringify(payload));
}

function clientAddress(request) {
  return String(
    request.headers['x-forwarded-for']
    || request.headers['x-real-ip']
    || request.socket.remoteAddress
    || 'unknown',
  ).split(',')[0].trim();
}

function consumeRateLimit(key) {
  const now = Date.now();
  const recent = (rateBuckets.get(key) || []).filter((timestamp) => now - timestamp < RATE_WINDOW_MS);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  rateBuckets.set(key, recent);
  return true;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('request_too_large');
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    const error = new Error('invalid_json');
    error.status = 400;
    throw error;
  }
}

function runtimeConfig() {
  const apiKey = String(process.env.DASHSCOPE_API_KEY || '').trim();
  const workspaceId = String(process.env.QWEN_WORKSPACE_ID || '').trim();
  const accessCode = String(
    process.env.LUBANNAV_ACCESS_CODE || process.env.ACCESS_CODE || '',
  ).trim();
  if (!apiKey || !accessCode || !/^[a-zA-Z0-9-]+$/.test(workspaceId)) return null;
  return { apiKey, workspaceId, accessCode };
}

async function exchangeSdp({ offerSdp, apiKey, workspaceId }) {
  const endpoint = new URL(
    `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime`,
  );
  endpoint.searchParams.set('model', MODEL);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/sdp',
      },
      body: offerSdp,
      signal: controller.signal,
    });
    const answerSdp = await response.text();
    if (!response.ok) {
      console.error(
        `[voice-gateway] upstream rejected status=${response.status}`,
        `requestId=${response.headers.get('x-request-id') || 'unknown'}`,
      );
      const error = new Error('upstream_rejected');
      error.status = 502;
      throw error;
    }
    if (!answerSdp.startsWith('v=0')) {
      const error = new Error('invalid_upstream_sdp');
      error.status = 502;
      throw error;
    }
    return answerSdp;
  } finally {
    clearTimeout(timeout);
  }
}

async function handleRequest(request, response) {
  const origin = requestOrigin(request);

  if (request.method === 'OPTIONS') {
    if (!isAllowedOrigin(origin)) return sendJson(response, 403, { error: 'origin_not_allowed' }, origin);
    response.writeHead(204, corsHeaders(origin));
    response.end();
    return;
  }

  const url = new URL(request.url, 'http://localhost');
  if (request.method !== 'POST' || url.pathname !== '/voice/session') {
    return sendJson(response, 404, { error: 'not_found' }, origin);
  }
  if (!isAllowedOrigin(origin)) {
    return sendJson(response, 403, { error: 'origin_not_allowed' }, origin);
  }

  const config = runtimeConfig();
  if (!config) {
    console.error('[voice-gateway] missing required environment configuration');
    return sendJson(response, 503, { error: 'service_not_configured' }, origin);
  }

  const rateKey = `${clientAddress(request)}:${origin}`;
  if (!consumeRateLimit(rateKey)) {
    return sendJson(response, 429, { error: 'rate_limited' }, origin);
  }

  try {
    const body = await readJsonBody(request);
    if (!safeEqual(body.accessCode, config.accessCode)) {
      return sendJson(response, 401, { error: 'invalid_access_code' }, origin);
    }
    if (typeof body.offerSdp !== 'string' || !body.offerSdp.startsWith('v=0')) {
      return sendJson(response, 400, { error: 'invalid_offer_sdp' }, origin);
    }

    const answerSdp = await exchangeSdp({
      offerSdp: body.offerSdp,
      apiKey: config.apiKey,
      workspaceId: config.workspaceId,
    });
    return sendJson(response, 200, { answerSdp }, origin);
  } catch (error) {
    if (error.name === 'AbortError') {
      return sendJson(response, 504, { error: 'upstream_timeout' }, origin);
    }
    const status = Number(error.status) || 500;
    const publicError = status >= 500 ? 'voice_gateway_failed' : error.message;
    return sendJson(response, status, { error: publicError }, origin);
  }
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error('[voice-gateway] unhandled request error', error?.name || 'Error');
    if (!response.headersSent) sendJson(response, 500, { error: 'internal_error' }, requestOrigin(request));
    else response.end();
  });
});

server.requestTimeout = 30_000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`LubanNav voice gateway listening on ${PORT}`);
});
