import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { createRoomServer } from './room/server.mjs';

const localOnly = process.argv.includes('--local');
const managed = process.argv.includes('--managed');
const room = createRoomServer();
const shutdown = new AbortController();
let commands;
let tunnel;
let stopping = false;
let publicUrl;
let startingPublic;

function listen(port) {
  return new Promise((resolve, reject) => {
    room.once('error', reject);
    const listening = () => {
      room.removeListener('error', reject);
      resolve(room.address().port);
    };
    room.listen(port, '127.0.0.1', listening);
  });
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  shutdown.abort();
  commands?.close();
  if (managed) process.stdin.pause();
  if (tunnel && tunnel.exitCode === null) tunnel.kill();
  if (room.listening) {
    room.close();
    room.closeAllConnections();
  }
  process.exitCode = code;
}

process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

function startAttempt(localUrl) {
  return new Promise((resolve, reject) => {
    const exe = fileURLToPath(new URL('./runtime/cloudflared.exe', import.meta.url));
    const child = spawn(exe, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', localUrl], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
    });
    tunnel = child;
    let address = '';
    let connected = false;
    let ready = false;
    let failure = 'UNAVAILABLE';
    const timeout = setTimeout(() => {
      failure = 'TIMEOUT';
      child.kill();
    }, 24_000);
    function watch(stream) {
      let tail = '';
      stream.setEncoding('utf8');
      stream.on('data', chunk => {
        const text = tail + chunk;
        address ||= text.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com\b/i)?.[0] ?? '';
        connected ||= text.includes('Registered tunnel connection');
        if (/deadline exceeded|timed? out|timeout/i.test(text)) failure = 'TIMEOUT';
        if (connected && address && !ready && !stopping) {
          ready = true;
          clearTimeout(timeout);
          resolve(address);
        }
        tail = text.slice(-1024);
        process.stderr.write(chunk);
      });
    }
    watch(child.stdout);
    watch(child.stderr);
    child.once('error', error => {
      console.error(error.message);
      failure = error.code === 'ENOENT' ? 'MISSING_RUNTIME' : 'UNAVAILABLE';
    });
    child.once('close', () => {
      clearTimeout(timeout);
      if (tunnel === child) tunnel = null;
      if (!ready) reject(new Error(failure));
      else if (!stopping) {
        publicUrl = null;
        console.log('TUNNEL DOWN');
      }
    });
  });
}

function requestPublic(localUrl) {
  if (publicUrl) {
    console.log('PUBLIC URL: ' + publicUrl);
    return;
  }
  if (startingPublic || stopping) return;
  startingPublic = (async () => {
    let failure;
    for (let attempt = 1; attempt <= 3 && !stopping; attempt++) {
      console.log('TUNNEL ATTEMPT: ' + attempt + '/3');
      try {
        publicUrl = await startAttempt(localUrl);
        if (!stopping) console.log('PUBLIC URL: ' + publicUrl);
        return;
      } catch (error) {
        failure = error.message;
        if (failure === 'MISSING_RUNTIME' || attempt === 3 || stopping) break;
        await delay(attempt * 1000, undefined, { signal: shutdown.signal }).catch(() => {});
      }
    }
    if (!stopping) {
      console.log('TUNNEL ERROR: ' + (failure ?? 'UNAVAILABLE'));
      if (!managed) console.error('The local room service is still running. Use LOCAL URL for local rooms, or restart to retry Cloudflare.');
    }
  })().finally(() => { startingPublic = null; });
}

try {
  const port = await listen(managed ? 0 : 8080).catch(error => {
    if (error.code !== 'EADDRINUSE') throw error;
    return listen(0);
  });
  const localUrl = 'http://127.0.0.1:' + port;
  console.log('LOCAL URL: ' + localUrl);
  if (managed) {
    commands = createInterface({ input: process.stdin });
    commands.on('line', line => {
      if (line === 'public') requestPublic(localUrl);
      else if (line === 'stop') stop();
    });
    commands.on('close', () => stop());
  } else {
    console.log('Leave this window open. Press Ctrl+C to stop the room.');
    if (!localOnly) requestPublic(localUrl);
  }
} catch (error) {
  console.error(error.message);
  stop(1);
}
