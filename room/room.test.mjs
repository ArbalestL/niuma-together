import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createRoomServer } from './server.mjs';
import { backgroundPlan, compute, planWish, wishLine } from './public/pay.mjs';
import { isMobileEntry, mobileEntry, readInvitation, roomInvitation } from './public/invite.mjs';

test('fixed mobile invitations preserve room and tunnel and reject unrelated endpoints', () => {
  const code = 'AFE012345678';
  const server = 'https://test-tunnel.trycloudflare.com';
  const link = new URL(roomInvitation(server, code));
  assert.equal(isMobileEntry(link), true);
  assert.deepEqual(readInvitation(link), { code, server });
  assert.deepEqual(readInvitation(new URL(`${server}/#room=${code}`)), { code, server });
  assert.equal(roomInvitation('http://127.0.0.1:8080', code), `http://127.0.0.1:8080/#room=${code}`);
  for (const invalid of ['http://test-tunnel.trycloudflare.com', 'https://test.trycloudflare.com.example.org',
    'https://api.trycloudflare.com', 'https://user@test.trycloudflare.com', 'https://test.trycloudflare.com:8080']) {
    assert.equal(readInvitation(new URL(`#room=${code}&server=${encodeURIComponent(invalid)}`, mobileEntry)), null);
  }
});

test('fixed mobile origin can join and sync with the room service', async t => {
  const server = createRoomServer();
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}/api/v1/`;
  const origin = new URL(mobileEntry).origin;
  const preflight = (op, caller) => fetch(base + op, { method: 'OPTIONS', headers: {
    Origin: caller, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type'
  }});
  const allowed = await preflight('sync', origin);
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), origin);
  assert.match(allowed.headers.get('access-control-allow-headers'), /Authorization/);
  assert.equal((await preflight('sync', 'https://elsewhere.example')).headers.get('access-control-allow-origin'), null);
  assert.equal((await preflight('create', origin)).headers.get('access-control-allow-origin'), null);
  const send = (op, body, token) => fetch(base + op, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(op !== 'create' && { Origin: origin }),
      ...(token && { Authorization: 'Bearer ' + token }) }, body: JSON.stringify(body) });
  const host = await (await send('create', { name: '桌面' })).json();
  const joined = await send('join', { name: '手机', code: host.code });
  assert.equal(joined.status, 200);
  assert.equal(joined.headers.get('access-control-allow-origin'), origin);
  const phone = await joined.json();
  const synced = await send('sync', { seq: 1, snapshot: null }, phone.token);
  assert.equal(synced.status, 200);
  assert.equal(synced.headers.get('access-control-allow-origin'), origin);
  assert.equal((await synced.json()).members.length, 2);
});

test('two room members sync, hide earnings, disconnect, reconnect and leave', async (t) => {
  let now = 0;
  const server = createRoomServer(() => now);
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async (op, data, token) => {
    const res = await fetch(`${base}/api/v1/${op}`, {
      method: 'POST', headers: {'Content-Type': 'application/json', ...(token && {Authorization: `Bearer ${token}`})},
      body: JSON.stringify(data)
    });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    return [res.status, await res.json()];
  };
  const [, desktop] = await send('create', {name: '桌面'});
  const [, phone] = await send('join', {code: desktop.code, name: '手机'});
  const [, other] = await send('create', {name: '其他房间'});
  const snapshot = {state: 'Working', progress: 0.5, offIn: 9600};
  await send('sync', {seq: 1, snapshot: {...snapshot, salary: 999}}, desktop.token);
  let [, view] = await send('sync', {seq: 1, snapshot: null}, phone.token);
  let card = view.members.find(m => m.id === desktop.id);
  assert.deepEqual(card.snapshot, snapshot);
  const money = {earned: 35.12345, currency: '¥'};
  await send('sync', {seq: 2, snapshot: {...snapshot, money}}, desktop.token);
  [, view] = await send('sync', {seq: 2, snapshot}, phone.token);
  assert.equal(view.members.find(m => m.id === desktop.id).snapshot.money.earned, 35.12345);
  [, view] = await send('sync', {seq: 1, snapshot: null}, other.token);
  assert.equal(view.members.length, 1);
  await send('sync', {seq: 3, snapshot}, desktop.token);
  await send('sync', {seq: 2, snapshot: {...snapshot, money}}, desktop.token);
  [, view] = await send('sync', {seq: 3, snapshot}, phone.token);
  assert.equal(view.members.find(m => m.id === desktop.id).snapshot.money, undefined);
  assert.equal((await send('sync', {seq: 1, snapshot}, 'wrong-token'))[0], 401);
  now += 15_000;
  [, view] = await send('sync', {seq: 4, snapshot}, phone.token);
  card = view.members.find(m => m.id === desktop.id);
  assert.equal(card.online, false);
  assert.equal(card.offlineSeconds, 0);
  assert.equal(card.snapshot, null);
  [, view] = await send('sync', {seq: 4, snapshot}, desktop.token);
  assert.equal(view.members.find(m => m.id === desktop.id).online, true);
  await send('leave', {}, desktop.token);
  [, view] = await send('sync', {seq: 5, snapshot}, phone.token);
  assert.deepEqual(view.members.map(m => m.id), [phone.id]);
  now += 15_000 + 30 * 60_000;
  assert.equal((await send('join', {code: desktop.code, name: '再次加入'}))[0], 404);
  assert.equal((await fetch(base)).status, 200);
});

test('Windows v0.1.0 counting rules for mobile local time', () => {
  const cfg = {start: '09:00', end: '18:00', lunch: true, lunchStart: '12:00', lunchEnd: '13:00',
    days: [1, 2, 3, 4, 5], salaryMode: 'monthly', amount: 16000, monthDays: 20,
    overtime: true, overtimeRate: 1.5, currency: '¥'};
  const at = (day, hour, minute) => compute(cfg, new Date(2026, 10, day, hour, minute));
  assert.deepEqual(at(16, 12, 30), {state: 'Lunch', progress: 0.375, offIn: 19800, earned: 300});
  assert.deepEqual(at(16, 19, 0), {state: 'Overtime', progress: 1, offIn: 0, earned: 950});
  assert.equal(at(16, 8, 30).state, 'BeforeWork');
  assert.equal(at(17, 0, 0).earned, 0);
  assert.equal(at(22, 11, 0).state, 'RestDay');
  assert.equal(compute({...cfg, overrideDate: '2026-11-22', overrideMode: 'work'}, new Date(2026, 10, 22, 11)).state, 'Working');
  assert.equal(compute({...cfg, overtime: false}, new Date(2026, 10, 16, 18)).state, 'AfterWork');
});

test('closed mobile page keeps updating, respects lunchtime, hides money and expires', async (t) => {
  let now = 0;
  const server = createRoomServer(() => now);
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const send = async (op, data, token) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/${op}`, {
      method: 'POST', headers: {'Content-Type': 'application/json', ...(token && {Authorization: `Bearer ${token}`})},
      body: JSON.stringify(data)
    });
    assert.equal(res.status, 200);
    return res.json();
  };
  const desktop = await send('create', {name: 'Windows'});
  const mobile = await send('join', {name: '手机', code: desktop.code});
  const cfg = {start: '09:00', end: '18:00', lunch: true, lunchStart: '12:00', lunchEnd: '13:00',
    days: [1, 2, 3, 4, 5], salaryMode: 'daily', amount: 800, overtime: true, overtimeRate: 1.5, currency: '¥'};
  const noon = new Date(2026, 10, 16, 11, 59, 0);
  const { earned, ...snapshot } = compute(cfg, noon);
  const money = { earned, currency: cfg.currency };
  const plan = backgroundPlan(cfg, noon, true);
  plan.goal = planWish({...cfg, wishItem: '奶茶', wishPrice: 300}, noon, earned);
  assert.equal((await send('sync', {seq: 1,
    snapshot: {...snapshot, money, wish: wishLine(plan.goal)}, plan}, mobile.token)).backgroundEnabled, true);
  let seq = 0;
  const read = async () => (await send('sync', {seq: ++seq, snapshot: null}, desktop.token)).members.find(m => m.id === mobile.id);
  now = 30_000;
  let card = await read();
  assert.equal(card.background, true);
  assert.equal(card.backgroundSeconds, 30);
  assert.ok(card.snapshot.money.earned > earned);
  now = 30 * 60_000;
  card = await read();
  assert.equal(card.snapshot.state, 'Lunch');
  assert.equal(card.snapshot.money.earned, 300);
  assert.equal(card.snapshot.wish, '今天已赚到奶茶。');
  const current = new Date(noon.getTime() + now);
  // Even a money-bearing plan cannot publish amounts after amount sharing is off.
  await send('sync', {seq: 2, snapshot: {...card.snapshot, money: undefined, wish: undefined},
    plan: backgroundPlan(cfg, current, true)}, mobile.token);
  now = 2 * 60 * 60_000;
  card = await read();
  assert.equal(card.background, true);
  assert.equal(card.backgroundSeconds, 90 * 60);
  assert.equal(card.snapshot.state, 'Working');
  assert.equal(card.snapshot.money, undefined);
  assert.equal(card.snapshot.wish, undefined);
  now = plan.until;
  card = await read();
  assert.equal(card.online, false);
  assert.ok(card.backgroundSeconds >= 3600);
  assert.equal(card.offlineSeconds, 0);
  now += 180_000;
  assert.equal((await read()).offlineSeconds, 180);
  assert.equal(card.snapshot, null);
});

test('same client rejoins once, host alone can kick and transfers on leave', async (t) => {
  const server = createRoomServer();
  server.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await once(server, 'listening');
  const send = async (op, data, token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/${op}`, {
      method: 'POST', headers: {'Content-Type': 'application/json', ...(token && {Authorization: `Bearer ${token}`})},
      body: JSON.stringify(data)
    });
    return [response.status, await response.json()];
  };
  const hostKey = '1'.repeat(32);
  const guestKey = '2'.repeat(32);
  const [, host] = await send('create', {name: '房主', clientKey: hostKey});
  const [, guest] = await send('join', {name: '好友', code: host.code, clientKey: guestKey});
  const [, rejoined] = await send('join', {name: '好友', code: host.code, clientKey: guestKey});
  assert.equal(rejoined.id, guest.id);
  assert.notEqual(rejoined.token, guest.token);
  assert.equal((await send('sync', {seq: 1, snapshot: null}, guest.token))[0], 401);
  const [, another] = await send('join', {name: '好友', code: host.code, clientKey: '3'.repeat(32)});
  assert.notEqual(another.id, guest.id);
  await send('sync', {seq: 1, snapshot: {state: 'Working', progress: .4, offIn: 60,
    wish: '距离赚到奶茶还要 4 分钟。', wishPrice: 100}}, rejoined.token);
  const [, hostAgain] = await send('join', {name: '房主', code: host.code, clientKey: hostKey});
  assert.equal(hostAgain.id, host.id);
  assert.equal(hostAgain.host, true);
  const [, view] = await send('sync', {seq: 1, snapshot: null}, hostAgain.token);
  assert.equal(view.members.length, 3);
  const snapshot = view.members.find(m => m.id === guest.id).snapshot;
  assert.equal(snapshot.wish, '距离赚到奶茶还要 4 分钟。');
  assert.equal(snapshot.wishPrice, undefined);
  assert.equal((await send('kick', {id: another.id}, rejoined.token))[0], 403);
  assert.equal((await send('kick', {id: hostAgain.id}, hostAgain.token))[0], 400);
  assert.equal((await send('kick', {id: another.id}, hostAgain.token))[0], 200);
  assert.equal((await send('sync', {seq: 1, snapshot: null}, another.token))[0], 401);
  await send('leave', {}, hostAgain.token);
  const [, after] = await send('sync', {seq: 2, snapshot: null}, rejoined.token);
  assert.equal(after.host, true);
  assert.equal(after.members.length, 1);
});
