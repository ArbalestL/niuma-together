const seconds = (text) => {
  const [hour, minute] = text.split(':').map(Number);
  return hour * 3600 + minute * 60;
};

export function localDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function planWish(config, now, earned) {
  const item = config.wishItem;
  const price = config.wishPrice;
  if (earned >= price) return { item, eta: 0 };
  let right = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - 1;
  if (compute(config, new Date(right)).earned < price) return { item, eta: null };
  let left = now.getTime();
  while (right - left > 1000) {
    const mid = Math.floor((left + right) / 2);
    if (compute(config, new Date(mid)).earned >= price) right = mid;
    else left = mid;
  }
  return { item, eta: right - now.getTime() };
}

export function wishLine({ item, eta }) {
  if (eta === null) return '今天还在攒' + item + '。';
  if (eta <= 0) return '今天已赚到' + item + '。';
  const mins = Math.ceil(eta / 60000);
  const duration = (mins >= 60 ? Math.floor(mins / 60) + ' 小时 ' : '') + mins % 60 + ' 分钟';
  return '距离赚到' + item + '还要 ' + duration + '。';
}

// Sample today's changes of state. Upload no raw salary settings.
export function backgroundPlan(config, date, money) {
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const tomorrow = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1);
  const until = tomorrow - date;
  if (until <= 2 || until > 93600000) return null;
  const boundaries = [config.start, config.end, config.lunchStart, config.lunchEnd].map(time => {
    const point = new Date(startOfDay);
    point.setHours(0, 0, seconds(time), 0);
    return point - date;
  });
  const dates = [...new Set([0, ...boundaries.filter(ms => ms > 0 && ms < until - 1), until - 1])].sort((a, b) => a - b);
  return {
    until,
    points: dates.map(at => {
      const { earned, ...snapshot } = compute(config, new Date(date.getTime() + at));
      if (money) snapshot.money = { earned, currency: config.currency };
      return { at, snapshot };
    })
  };
}

export function compute(s, date) {
  const work = s.overrideDate === localDate(date) && s.overrideMode && s.overrideMode !== 'normal'
    ? s.overrideMode === 'work' : s.days.includes(date.getDay());
  if (!work) return { state: 'RestDay', progress: 0, offIn: 0, earned: 0 };
  const start = seconds(s.start);
  const end = Math.max(start + 1, seconds(s.end));
  const lunchStart = Math.max(start, seconds(s.lunchStart));
  const lunchEnd = Math.min(end, seconds(s.lunchEnd));
  const lunch = s.lunch && lunchEnd > lunchStart && lunchEnd - lunchStart < end - start;
  const overlap = (from, to, at) => Math.max(0, Math.min(to, at) - from);
  const paid = (at) => overlap(start, end, at) - (lunch ? overlap(lunchStart, lunchEnd, at) : 0);
  const now = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds() + date.getMilliseconds() / 1000;
  const elapsed = paid(now);
  const total = paid(86400);
  const daily = s.salaryMode === 'monthly' ? s.amount / s.monthDays : s.amount;
  const rate = daily / total;
  let state = 'Working';
  if (now < start) state = 'BeforeWork';
  else if (lunch && now >= lunchStart && now < lunchEnd) state = 'Lunch';
  else if (now >= end) state = s.overtime ? 'Overtime' : 'AfterWork';
  const overtime = state === 'Overtime' ? (now - end) * (rate * s.overtimeRate) : 0;
  return {
    state, progress: elapsed / total, offIn: Math.max(0, end - now),
    earned: elapsed * rate + overtime
  };
}
