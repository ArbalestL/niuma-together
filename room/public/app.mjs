import { backgroundPlan, compute, localDate, planWish, wishLine } from './pay.mjs';

const byId = (id) => document.getElementById(id);
const status = byId('status');
const entry = byId('entry');
const schedule = byId('schedule');
const fields = schedule.elements;
const share = byId('share');
const background = byId('background');
const backgroundStatus = byId('background-status');
const personal = byId('personal');
const personalAmount = byId('personal-amount');
const personalState = byId('personal-state');
const personalProgress = byId('personal-progress');
const personalBar = byId('personal-bar');
const personalNote = byId('personal-note');
const defaults = {
  start: '10:00', end: '19:00', days: [1, 2, 3, 4, 5], lunch: false, lunchStart: '12:00', lunchEnd: '13:00',
  salaryMode: 'daily', amount: '', monthDays: 21.75, currency: '¥', overtime: false, overtimeRate: 1.5,
  overrideMode: 'normal', overrideDate: ''
};
const storageKey = 'niuma-room-schedule-v1';
const sessionKey = 'niuma-background-room-v1';
const profileKey = 'niuma-room-profile-v1';
const deviceKey = 'niuma-room-device-v1';
const randomKey = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
let clientKey = randomKey();
try {
  const saved = localStorage.getItem(deviceKey);
  if (saved && /^[a-f0-9]{32}$/.test(saved)) clientKey = saved;
  else localStorage.setItem(deviceKey, clientKey);
} catch { /* 本次网页仍可用 */ }
const states = {
  RestDay: '休息日', BeforeWork: '还没上班', Working: '上班中', Lunch: '午休中',
  AfterWork: '已下班', Overtime: '加班中'
};
const errors = {
  ROOM_MISSING: '房间不存在或已过期。', ROOM_FULL: '房间已满。', INVALID_NAME: '请输入 1 到 24 个字符的昵称。',
  TRY_LATER: '操作过于频繁，请稍后再试。'
};
let session = null;
let syncing = false;
let pending = false;
let leaving = false;
let connectedAt = 0;
let backgroundDay = '';
let backgroundConfirmed = false;
let config = null;
const memberStates = new Map();
try { config = JSON.parse(localStorage.getItem(storageKey)); } catch { /* 本地存储不可用 */ }

const weekday = ['日', '一', '二', '三', '四', '五', '六'].map((name, i) => {
  const label = document.createElement('label');
  label.className = 'check';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = i;
  label.append(box, name);
  byId('days').append(label);
  return box;
});

const invitation = new URLSearchParams(location.hash.slice(1)).get('room')?.slice(0, 12).toUpperCase() ?? '';
let profile = null;
try { profile = JSON.parse(localStorage.getItem(profileKey)); } catch { /* 没有可恢复的昵称 */ }
byId('name').value = profile?.name ?? '';
byId('code').value = invitation || profile?.code || '';

function rememberProfile(name, code) {
  if (profile?.name === name && profile?.code === code) return;
  profile = { name, code };
  byId('name').value = name;
  try { localStorage.setItem(profileKey, JSON.stringify(profile)); } catch { /* 本次加入仍然有效 */ }
}

function fillSchedule() {
  const saved = { ...defaults, ...config };
  if (saved.overrideDate !== localDate(new Date())) saved.overrideMode = 'normal';
  for (const [name, value] of Object.entries(saved)) {
    const field = fields.namedItem(name);
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = value;
    else field.value = value;
  }
  weekday.forEach((box, i) => { box.checked = saved.days.includes(i); });
  updateMonthDays();
}

function updateMonthDays() {
  byId('month-days').hidden = fields.salaryMode.value !== 'monthly';
}

fillSchedule();
byId('open-config').addEventListener('click', () => {
  const settings = byId('config');
  settings.open = !settings.open;
  if (settings.open) settings.scrollIntoView({ block: 'nearest' });
});
byId('compact').addEventListener('click', (event) => {
  event.currentTarget.setAttribute('aria-pressed', personal.classList.toggle('compact'));
});
fields.salaryMode.addEventListener('change', updateMonthDays);
schedule.addEventListener('submit', (event) => {
  event.preventDefault();
  if (fields.end.value <= fields.start.value) {
    status.textContent = '计划下班时间必须晚于上班时间。';
    return;
  }
  if (fields.lunch.checked && fields.lunchEnd.value <= fields.lunchStart.value) {
    status.textContent = '午休结束时间必须晚于开始时间。';
    return;
  }
  config = {
    start: fields.start.value, end: fields.end.value, days: weekday.filter(box => box.checked).map(box => Number(box.value)),
    lunch: fields.lunch.checked, lunchStart: fields.lunchStart.value, lunchEnd: fields.lunchEnd.value,
    salaryMode: fields.salaryMode.value, amount: fields.amount.valueAsNumber, monthDays: fields.monthDays.valueAsNumber,
    currency: fields.currency.value.trim(), overtime: fields.overtime.checked, overtimeRate: fields.overtimeRate.valueAsNumber,
    overrideMode: fields.overrideMode.value, overrideDate: localDate(new Date()),
    wishItem: fields.wishItem.value.trim(), wishPrice: fields.wishPrice.valueAsNumber || null
  };
  try { localStorage.setItem(storageKey, JSON.stringify(config)); } catch { /* 本次会话仍可使用 */ }
  share.disabled = false;
  background.disabled = false;
  byId('config').open = false;
  renderPersonal();
  sync();
});

async function api(op, data, token) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetch('/api/v1/' + op, { method: 'POST', headers, body: JSON.stringify(data), signal: controller.signal });
    const result = await res.json();
    if (!res.ok) throw new Error(result.error);
    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function enter(create) {
  if (leaving) return;
  if (!entry.reportValidity()) return;
  const name = byId('name').value.trim();
  const code = byId('code').value.trim().toUpperCase();
  if (!create && !/^[A-F0-9]{12}$/.test(code)) {
    status.textContent = '请输入好友发来的 12 位房间码。';
    return;
  }
  const buttons = entry.querySelectorAll('button');
  buttons.forEach(button => { button.disabled = true; });
  status.textContent = '正在连接…';
  try {
    const joined = await api(create ? 'create' : 'join', { name, code, clientKey });
    rememberProfile(name, joined.code);
    openRoom(joined);
  } catch (error) {
    status.textContent = errors[error.message] ?? '连接失败，请稍后再试。';
  } finally {
    buttons.forEach(button => { button.disabled = false; });
  }
}

function openRoom(joined, saved = null) {
  session = { ...joined, seq: 0 };
  connectedAt = performance.now();
  byId('lobby').hidden = true;
  byId('room').hidden = false;
  byId('room-members').hidden = false;
  byId('code').value = session.code;
  byId('room-code').textContent = session.code;
  status.textContent = '';
  share.disabled = background.disabled = !config;
  const today = saved?.day === localDate(new Date());
  background.checked = Boolean(config && today && saved.background !== false);
  backgroundDay = background.checked ? saved.day : '';
  backgroundConfirmed = false;
  share.checked = !share.disabled && today && saved.money === true;
  if (!saved) rememberRoom(false);
  sync();
}

function rememberRoom(approved = backgroundConfirmed) {
  if (!session) return;
  try {
    const { code, id, token } = session;
    const day = localDate(new Date());
    const data = JSON.stringify({
      session: { code, id, token }, day, background: approved && background.checked && backgroundDay === day,
      money: share.checked
    });
    if (localStorage.getItem(sessionKey) !== data) localStorage.setItem(sessionKey, data);
  } catch { /* 存储不可用时，本次同步仍然有效 */ }
}

function forgetRoom(active) {
  if (!active) return;
  try {
    const saved = JSON.parse(localStorage.getItem(sessionKey));
    if (saved?.session.token === active.token) localStorage.removeItem(sessionKey);
  } catch { /* 无可删除的房间 */ }
}

entry.addEventListener('submit', (event) => { event.preventDefault(); enter(false); });
byId('create').addEventListener('click', () => enter(true));
share.addEventListener('change', () => {
  if (!share.checked) rememberRoom();
  sync();
});
background.addEventListener('change', () => {
  backgroundDay = background.checked ? localDate(new Date()) : '';
  if (!background.checked) rememberRoom(false);
  backgroundStatus.textContent = '正在同步设置…';
  sync();
});
byId('invite').addEventListener('click', async () => {
  const url = new URL('/', location.href);
  url.hash = 'room=' + session.code;
  try {
    await navigator.clipboard.writeText(url.href);
    status.textContent = '已复制邀请链接。';
  } catch {
    window.prompt('复制邀请链接', url.href);
  }
});

function showLobby(message) {
  forgetRoom(session);
  session = null;
  share.checked = false;
  memberStates.clear();
  byId('room-toasts').replaceChildren();
  background.checked = false;
  backgroundConfirmed = false;
  backgroundStatus.textContent = '';
  byId('lobby').hidden = false;
  byId('room').hidden = true;
  byId('room-members').hidden = true;
  byId('members').replaceChildren();
  status.textContent = message;
}

byId('leave').addEventListener('click', async () => {
  if (leaving || !session) return;
  leaving = true;
  const current = session;
  byId('leave').disabled = true;
  status.textContent = '正在退出房间…';
  try {
    await api('leave', {}, current.token);
    showLobby('已退出房间。');
  } catch (error) {
    if (error.message === 'SESSION_EXPIRED') showLobby('已退出房间。');
    else status.textContent = '尚未退出房间，请恢复网络后重试。';
  }
  finally {
    leaving = false;
    byId('leave').disabled = false;
  }
});

function getSnapshot(now, goal) {
  if (!config) return null;
  const { earned, ...snapshot } = compute(config, now);
  if (share.checked) snapshot.money = { earned: Number(earned.toFixed(5)), currency: config.currency };
  if (goal) snapshot.wish = wishLine(goal);
  return snapshot;
}

async function sync() {
  if (!session || leaving) return;
  if (syncing) { pending = true; return; }
  syncing = true;
  const current = session;
  try {
    const now = new Date();
    if (background.checked && backgroundDay !== localDate(now)) background.checked = false;
    const goal = config?.wishItem && config?.wishPrice ? planWish(config, now, compute(config, now).earned) : null;
    const plan = background.checked && config ? backgroundPlan(config, now, share.checked) : null;
    if (plan && goal) plan.goal = goal;
    current.seq = Math.max(current.seq + 1, now.getTime());
    const { members, backgroundEnabled, host } = await api('sync',
      { seq: current.seq, snapshot: getSnapshot(now, goal), plan }, current.token);
    if (session !== current || leaving) return;
    connectedAt = performance.now();
    const own = members.find(member => member.id === current.id);
    if (own) rememberProfile(own.name, current.code);
    if (status.textContent === '连接中断，正在重连…') status.textContent = '';
    if (!pending) {
      backgroundConfirmed = backgroundEnabled === true;
      if (background.checked && plan && !backgroundConfirmed) {
        backgroundStatus.textContent = '房间服务需要更新后才能继续同步。';
      } else {
        backgroundStatus.textContent = backgroundConfirmed ? '已开启，关页后仍会更新今天的进度。' : '';
      }
      rememberRoom();
    }
    render(members, host);
  } catch (error) {
    if (session !== current || leaving) return;
    if (error.message === 'SESSION_EXPIRED') showLobby('已离开房间或连接已过期。');
    else {
      status.textContent = '连接中断，正在重连…';
      if (background.checked !== backgroundConfirmed)
        backgroundStatus.textContent = '设置尚未确认，请保持页面打开。';
      if (performance.now() - connectedAt >= 15000) byId('members').replaceChildren();
    }
  } finally {
    syncing = false;
    if (pending) { pending = false; sync(); }
  }
}

function duration(seconds) {
  const remaining = Math.ceil(seconds);
  const h = Math.floor(remaining / 3600);
  const m = Math.floor(remaining / 60) % 60;
  return (h ? h + ' 小时 ' : '') + (h || m ? m + ' 分 ' : '') + remaining % 60 + ' 秒';
}

function progressText(data) {
  return (data.progress * 100).toFixed(1) + '%' +
    (data.offIn > 0 ? ' · 距计划下班 ' + duration(data.offIn) : '');
}

function renderPersonal() {
  if (!config) return;
  const current = compute(config, new Date());
  const amount = config.currency + current.earned.toFixed(5);
  if (personalAmount.textContent !== amount) personalAmount.textContent = amount;
  const label = states[current.state];
  if (personalState.textContent !== label) personalState.textContent = label;
  personalProgress.hidden = current.state === 'RestDay';
  if (!personalProgress.hidden) {
    personalBar.value = current.progress;
    const note = progressText(current);
    if (personalNote.textContent !== note) personalNote.textContent = note;
  }
}

async function kick(id, button) {
  const active = session;
  if (!active) return;
  button.disabled = true;
  try {
    await api('kick', { id }, active.token);
    if (session === active) sync();
  } catch {
    if (session === active) status.textContent = '未能移除成员，请确认仍是房主并重试。';
  } finally { button.disabled = false; }
}

function render(members, host) {
  const list = byId('members');
  const existing = new Map(Array.from(list.children, card => [card.dataset.id, card]));
  const current = new Set(members.map(member => member.id));
  for (const id of memberStates.keys()) if (!current.has(id)) memberStates.delete(id);
  byId('count').textContent = members.length + (host ? ' · 你是房主' : '');
  for (const member of members) {
    const self = member.id === session.id;
    let card = existing.get(member.id);
    if (!card) {
      card = document.createElement('article');
      card.className = 'card';
      card.dataset.id = member.id;
      if (self) card.dataset.self = '';
      const header = document.createElement('header');
      header.append(document.createElement('h3'), document.createElement('span'));
      const wish = document.createElement('p');
      wish.className = 'wish-note';
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'quiet remove-member';
      remove.textContent = '移除成员';
      remove.addEventListener('click', () => kick(member.id, remove));
      card.append(header, document.createElement('p'), document.createElement('progress'), document.createElement('p'), wish, remove);
      list.append(card);
    }
    existing.delete(member.id);
    const data = member.online ? member.snapshot : null;
    if (data) {
      const previous = memberStates.get(member.id);
      if (data.state === 'AfterWork' && ['Working', 'Lunch', 'Overtime'].includes(previous)) {
        showDeparture(member.name);
      }
      memberStates.set(member.id, data.state);
    }
    const money = self ? null : data?.money;
    const [header, amount, bar, note, wish, remove] = card.children;
    header.firstElementChild.textContent = member.name + (self ? '（我）' : '');
    const workState = states[data?.state] ?? '未设置班次';
    header.lastElementChild.textContent = member.background ? workState + ' · 后台' : member.online ? workState : '离线';
    amount.textContent = money ? money.currency + money.earned.toFixed(5)
      : self ? (data && share.checked ? '正在共享金额' : '金额未共享') : data ? '金额未共享' : '';
    amount.className = money ? 'amount' : 'amount empty';
    bar.hidden = !data || data.state === 'RestDay';
    bar.setAttribute('aria-label', '已计薪工时进度');
    bar.max = 1;
    bar.value = data?.progress ?? 0;
    note.hidden = bar.hidden;
    note.className = 'progress-note';
    note.textContent = data ? progressText(data) : '';
    wish.hidden = !data?.wish;
    wish.textContent = data?.wish ?? '';
    remove.hidden = !host || self;
    remove.setAttribute('aria-label', '移除 ' + member.name);
  }
  for (const card of existing.values()) card.remove();
}

function showDeparture(name) {
  const toast = document.createElement('div');
  toast.className = 'room-toast';
  toast.textContent = '【' + name + '】下班了！拜拜了您';
  byId('room-toasts').append(toast);
  setTimeout(() => toast.remove(), 4500);
}

renderPersonal();
setInterval(() => { if (!document.hidden) renderPersonal(); }, 100);
setInterval(() => { if (!document.hidden && !syncing) sync(); }, 1000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    renderPersonal();
    if (performance.now() - connectedAt >= 15000) byId('members').replaceChildren();
    sync();
  }
});
window.addEventListener('online', sync);

try {
  const saved = JSON.parse(localStorage.getItem(sessionKey));
  if (saved?.session.token && (!invitation || invitation === saved.session.code)) {
    openRoom(saved.session, saved);
  }
} catch { /* 无可恢复的房间 */ }
