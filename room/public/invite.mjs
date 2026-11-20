export const mobileEntry = 'https://arbalestl.github.io/niuma-together/';
const mobileUrl = new URL(mobileEntry);

export function isMobileEntry(url) {
  return url.origin === mobileUrl.origin && url.pathname.replace(/\/$/, '') === mobileUrl.pathname.slice(0, -1);
}

export function publicRoomServer(address) {
  try {
    const url = new URL(address);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port &&
        /^(?!api\.)[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname)) return url.origin;
  } catch { /* Invalid invitation address. */ }
  return '';
}

export function readInvitation(url) {
  const fields = new URLSearchParams(url.hash.slice(1));
  const code = (fields.get('room') ?? '').toUpperCase();
  if (!/^[A-F0-9]{12}$/.test(code)) return null;
  const server = publicRoomServer(isMobileEntry(url) ? fields.get('server') : url.href);
  return server ? { code, server } : null;
}

export function roomInvitation(server, code) {
  const publicServer = publicRoomServer(server);
  const url = new URL(publicServer ? mobileEntry : '/', server);
  url.hash = new URLSearchParams(publicServer ? { room: code, server: publicServer } : { room: code });
  return url.href;
}
