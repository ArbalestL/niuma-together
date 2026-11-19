import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { wishLine } from './public/pay.mjs';

const onlineFor = 15_000;
const emptyFor = 30 * 60_000;
const states = new Set(['RestDay', 'BeforeWork', 'Working', 'Lunch', 'AfterWork', 'Overtime']);
const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/pay.mjs', ['pay.mjs', 'text/javascript; charset=utf-8']]
].map(([url, [file, type]]) => [url, [readFileSync(new URL('./public/' + file, import.meta.url)), type]]));

const secret = (bytes) => randomBytes(bytes).toString('hex');
const bounded = (n, max) => Number.isFinite(n) && n >= 0 && n <= max;
const fail = (status, code) => Object.assign(new Error(code), { status });
const validKey = value => typeof value === 'string' && /^[a-f0-9]{32,64}$/.test(value);
const safeText = (value, limit) => typeof value === 'string'
  ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, limit) : '';

function parseSnapshot(input) {
  if (input === null) return null;
  if (!input || !states.has(input.state) || !bounded(input.progress, 1) || !bounded(input.offIn, 86400)) {
    throw fail(400, 'INVALID_SNAPSHOT');
  }
  const snapshot = { state: input.state, progress: input.progress, offIn: input.offIn };
  const wish = safeText(input.wish, 160);
  if (wish) snapshot.wish = wish;
  const money = input.money;
  if (money != null) {
    if (!bounded(money.earned, Number.MAX_VALUE) || typeof money.currency !== 'string' ||
        money.currency.length > 16 || /[\x00-\x1f\x7f]/.test(money.currency)) {
      throw fail(400, 'INVALID_SNAPSHOT');
    }
    snapshot.money = { earned: money.earned, currency: money.currency };
  }
  return snapshot;
}

function parsePlan(input, snapshot, now) {
  if (input == null) return null;
  const { until, points } = input;
  if (!snapshot || !Number.isInteger(until) || until < 2 || until > 93600000 ||
      !Array.isArray(points) || points.length < 2 || points.length > 6) throw fail(400, 'INVALID_PLAN');
  let previous = -1;
  const samples = points.map((point, i) => {
    if (!point || !Number.isInteger(point.at) || point.at <= previous || point.at >= until ||
        (i === 0 && point.at !== 0) || (i === points.length - 1 && point.at !== until - 1)) {
      throw fail(400, 'INVALID_PLAN');
    }
    previous = point.at;
    const data = parseSnapshot(point.snapshot);
    if (!data) throw fail(400, 'INVALID_PLAN');
    delete data.wish;
    if (!snapshot.money) delete data.money;
    else if (!data.money || data.money.currency !== snapshot.money.currency) throw fail(400, 'INVALID_PLAN');
    return { at: point.at, data };
  });
  const item = snapshot.wish ? safeText(input.goal?.item, 48) : '';
  const eta = input.goal?.eta;
  const goal = item && (eta === null || bounded(eta, until)) ? { item, eta } : null;
  return { started: now, ends: now + until, samples, goal };
}

function estimate(plan, now) {
  const elapsed = now - plan.started;
  const next = plan.samples.findIndex(sample => sample.at > elapsed);
  const a = plan.samples[next > 0 ? next - 1 : plan.samples.length - 1];
  const b = plan.samples[next > 0 ? next : plan.samples.length - 1];
  const fraction = next > 0 ? (elapsed - a.at) / (b.at - a.at) : 0;
  const lerp = (x, y) => x + (y - x) * fraction;
  const snapshot = {
    state: a.data.state, progress: lerp(a.data.progress, b.data.progress),
    offIn: lerp(a.data.offIn, b.data.offIn)
  };
  if (a.data.money)
    snapshot.money = { earned: lerp(a.data.money.earned, b.data.money.earned), currency: a.data.money.currency };
  if (plan.goal)
    snapshot.wish = wishLine({ item: plan.goal.item, eta: plan.goal.eta === null ? null : plan.goal.eta - elapsed });
  return snapshot;
}

async function readBody(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw fail(415, 'JSON_REQUIRED');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw fail(413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw fail(400, 'INVALID_JSON');
  }
}

export function createRoomServer(clock = () => performance.now(), tls) {
  const rooms = new Map();
  const sessions = new Map();
  const entryLimits = new Map();
  const options = { requestTimeout: 10_000, headersTimeout: 10_000, maxHeaderSize: 8192 };
  const server = tls ? createTlsServer({ ...options, ...tls }, handle) : createServer(options, handle);
  const cleanup = setInterval(() => expire(clock()), 5_000).unref();
  server.on('close', () => clearInterval(cleanup));
  return server;

  function remove(room, token) {
    room.members.delete(token);
    sessions.delete(token);
    if (!Array.from(room.members.values()).some(member => member.id === room.host)) {
      room.host = room.members.values().next().value?.id ?? null;
    }
  }

  function expire(now) {
    for (const [ip, limit] of entryLimits) {
      if (now >= limit.until) entryLimits.delete(ip);
    }
    for (const room of rooms.values()) {
      if (activeRoom(room, now)) clearOffline(room, now);
    }
  }

  function activeRoom(room, now) {
    if (!room) return false;
    let activeUntil = room.activeAt + (room.members.size ? onlineFor : 0);
    for (const member of room.members.values()) activeUntil = Math.max(activeUntil, member.plan?.ends ?? 0);
    if (now < activeUntil + emptyFor) return true;
    for (const token of room.members.keys()) remove(room, token);
    rooms.delete(room.code);
    return false;
  }

  function clearOffline(room, now) {
    for (const member of room.members.values()) {
      if (now - member.seen >= onlineFor) member.snapshot = null;
      if (member.plan && now >= member.plan.ends) {
        room.activeAt = Math.max(room.activeAt, member.plan.ends - onlineFor);
        member.lastPlanEnd = member.plan.ends;
        member.plan = null;
      }
    }
  }

  function enter(op, data, ip, now) {
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (name.length < 1 || name.length > 24 || /[\x00-\x1f\x7f]/.test(name)) {
      throw fail(400, 'INVALID_NAME');
    }
    if (!entryLimits.has(ip) && entryLimits.size >= 2000) throw fail(429, 'TRY_LATER');
    let limit = entryLimits.get(ip);
    if (!limit || now >= limit.until) limit = { until: now + 60_000, count: 0 };
    entryLimits.set(ip, limit);
    if (++limit.count > 60) throw fail(429, 'TRY_LATER');
    let room;
    const clientKey = validKey(data.clientKey) ? data.clientKey : null;
    if (op === 'create') {
      if (rooms.size >= 500) throw fail(503, 'TRY_LATER');
      let code;
      do { code = secret(6).toUpperCase(); } while (rooms.has(code));
      room = { code, activeAt: now, members: new Map(), host: null };
      rooms.set(code, room);
    } else {
      const code = typeof data.code === 'string' ? data.code.trim().toUpperCase() : '';
      room = rooms.get(code);
      if (!activeRoom(room, now)) throw fail(404, 'ROOM_MISSING');
      if (clientKey) {
        const match = Array.from(room.members.entries()).find(([, member]) => member.clientKey === clientKey);
        if (match) {
          const [oldToken, existing] = match;
          const token = secret(32);
          const entries = Array.from(room.members.entries());
          room.members = new Map(entries.map(([key, value]) =>
            key === oldToken ? [token, { ...value, name, seen: now, seq: 0, snapshot: null, plan: null,
              hadPlan: false, lastPlanEnd: null }] : [key, value]));
          sessions.delete(oldToken);
          sessions.set(token, room);
          room.activeAt = now;
          return { code: room.code, id: existing.id, token, host: room.host === existing.id };
        }
      }
      if (room.members.size >= 20) {
        const spare = Array.from(room.members.entries()).find(([, member]) =>
          member.id !== room.host && now - member.seen >= onlineFor && !(member.plan?.ends > now));
        if (!spare) throw fail(409, 'ROOM_FULL');
        remove(room, spare[0]);
      }
    }
    const token = secret(32);
    const id = secret(12);
    room.members.set(token, { id, name, clientKey, seen: now, snapshot: null, seq: 0 });
    room.host ??= id;
    sessions.set(token, room);
    room.activeAt = now;
    return { code: room.code, id, token, host: room.host === id };
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const reply = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && files.has(url.pathname)) {
        const [body, type] = files.get(url.pathname);
        res.writeHead(200, { 'Content-Type': type });
        res.end(body);
        return;
      }
      const op = /^\/api\/v1\/(create|join|sync|leave|kick)$/.exec(url.pathname)?.[1];
      if (req.method !== 'POST' || !op) throw fail(404, 'NOT_FOUND');
      const data = await readBody(req);
      const now = clock();
      if (op === 'create' || op === 'join') {
        reply(200, enter(op, data, req.socket.remoteAddress, now));
        return;
      }
      const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization ?? '')?.[1];
      const room = sessions.get(token);
      if (!activeRoom(room, now)) throw fail(401, 'SESSION_EXPIRED');
      const member = room.members.get(token);
      if (op === 'kick') {
        if (member.id !== room.host) throw fail(403, 'HOST_REQUIRED');
        if (typeof data.id !== 'string' || !/^[a-f0-9]{24}$/.test(data.id) || data.id === room.host)
          throw fail(400, 'INVALID_MEMBER');
        const target = Array.from(room.members.entries()).find(([, candidate]) => candidate.id === data.id);
        if (target) remove(room, target[0]);
        reply(200, {});
        return;
      }
      if (op === 'leave') {
        remove(room, token);
        if (!room.members.size) room.activeAt = now;
        reply(200, {});
        return;
      }
      clearOffline(room, now);
      if (!Number.isSafeInteger(data.seq) || data.seq < 1) throw fail(400, 'INVALID_SEQUENCE');
      if (data.seq > member.seq) {
        const snapshot = parseSnapshot(data.snapshot);
        const plan = parsePlan(data.plan, snapshot, now);
        member.snapshot = snapshot;
        member.plan = plan;
        member.lastPlanEnd = null;
        member.hadPlan = Boolean(plan);
        member.seq = data.seq;
        member.seen = now;
        room.activeAt = now;
      }
      const members = Array.from(room.members.values(), m => {
        const live = now - m.seen < onlineFor;
        return {
          id: m.id, name: m.name, online: live || Boolean(m.plan),
          background: !live && Boolean(m.plan),
          backgroundSeconds: !live && m.hadPlan ? (now - m.seen) / 1000 : null,
          offlineSeconds: !live && !m.plan ? (now - Math.max(m.seen + onlineFor, m.lastPlanEnd ?? 0)) / 1000 : null,
          snapshot: live ? m.snapshot : m.plan ? estimate(m.plan, now) : null
        };
      });
      reply(200, { members, host: member.id === room.host, backgroundEnabled: Boolean(member.plan) });
    } catch (error) {
      if (!res.destroyed) reply(error.status ?? 500, { error: error.status ? error.message : 'SERVER_ERROR' });
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { NIUMA_CERT, NIUMA_KEY, PORT = '8080', HOST = '127.0.0.1' } = process.env;
  if (Boolean(NIUMA_CERT) !== Boolean(NIUMA_KEY)) throw new Error('Set both NIUMA_CERT and NIUMA_KEY.');
  const tls = NIUMA_CERT && { cert: readFileSync(NIUMA_CERT), key: readFileSync(NIUMA_KEY) };
  const server = createRoomServer(undefined, tls);
  server.listen(Number(PORT), HOST, () => console.log(`NiuMa room: ${tls ? 'https' : 'http'}://${HOST}:${server.address().port}`));
}
