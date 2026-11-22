// AtlasMeat — signaling server (Express + WebSocket)
// Serves the frontend from ./public and relays WebRTC signaling between peers.

const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

// ---- TURN credentials (Cloudflare Realtime TURN, free tier) ----
// Set CF_TURN_KEY_ID and CF_TURN_API_TOKEN in the environment (Render → Environment).
// Without them the app still works, but only STUN is used and strict NATs may fail.
const CF_TURN_KEY_ID = process.env.CF_TURN_KEY_ID || '';
const CF_TURN_API_TOKEN = process.env.CF_TURN_API_TOKEN || '';
const TURN_TTL = 86400; // seconds
let turnCache = null; // { iceServers, expires }
let meteredCache = null; // { iceServers, expires }

app.get('/turn', async (req, res) => {
  res.set('Cache-Control', 'no-store');

  // Generic TURN relay (e.g. your own coturn on an Iranian VPS).
  // TURN_URL is a comma-separated list of turn:/turns: URLs.
  const gUrl = process.env.TURN_URL || '';
  const gUser = process.env.TURN_USERNAME || '';
  const gPass = process.env.TURN_PASSWORD || '';
  if (gUrl && gUser && gPass) {
    const urls = gUrl.split(',').map((s) => s.trim()).filter(Boolean);
    if (urls.length) {
      return res.json({ iceServers: [{ urls, username: gUser, credential: gPass }] });
    }
  }

  // Metered Open Relay (free 20 GB/month, no card). Tries a Middle East PoP
  // first so Iranian users get a much shorter relay path than Europe.
  const mKey = process.env.METERED_API_KEY || '';
  const mApp = process.env.METERED_APP || '';
  const mRegion = process.env.METERED_REGION || 'middle_east';
  if (mKey && mApp) {
    if (meteredCache && meteredCache.expires > Date.now()) {
      return res.json({ iceServers: meteredCache.iceServers });
    }
    try {
      const u = `https://${mApp}.metered.live/api/v1/turn/credentials` +
        `?apiKey=${encodeURIComponent(mKey)}&region=${encodeURIComponent(mRegion)}`;
      const r = await fetch(u);
      if (r.ok) {
        const list = await r.json();
        if (Array.isArray(list) && list.length) {
          meteredCache = { iceServers: list, expires: Date.now() + 30 * 60 * 1000 };
          return res.json({ iceServers: list });
        }
      } else {
        console.error('Metered TURN failed:', r.status, await r.text());
      }
    } catch (e) {
      console.error('Metered TURN error:', e.message);
    }
  }

  // ExpressTURN free plan (1 TB/month, email signup, no card).
  // Set EXPRESSTURN_USERNAME and EXPRESSTURN_PASSWORD in the environment.
  const eu = process.env.EXPRESSTURN_USERNAME || '';
  const ep = process.env.EXPRESSTURN_PASSWORD || '';
  if (eu && ep) {
    return res.json({
      iceServers: [
        {
          urls: [
            'turn:free.expressturn.com:3478?transport=udp',
            'turn:free.expressturn.com:3478?transport=tcp',
            'turn:free.expressturn.com:80?transport=tcp',
            'turn:free.expressturn.com:443?transport=tcp',
          ],
          username: eu,
          credential: ep,
        },
      ],
    });
  }

  if (!CF_TURN_KEY_ID || !CF_TURN_API_TOKEN) {
    return res.json({ iceServers: [] });
  }
  if (turnCache && turnCache.expires > Date.now()) {
    return res.json({ iceServers: turnCache.iceServers });
  }
  try {
    const keyUrl = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(CF_TURN_KEY_ID)}`;
    const payload = {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${CF_TURN_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: TURN_TTL }),
    };
    // Current Cloudflare API path; fall back to the older one if needed.
    let r = await fetch(`${keyUrl}/credentials/generate-ice-servers`, payload);
    if (r.status === 404) {
      r = await fetch(`${keyUrl}/credentials/generate`, payload);
    }
    if (!r.ok) {
      console.error('TURN credentials failed:', r.status, await r.text());
      return res.json({ iceServers: [] });
    }
    const data = await r.json();
    // Cloudflare returns { iceServers: [ {urls:[...]}, {urls:[...], username, credential} ] }
    const ice = data && data.iceServers ? data.iceServers : null;
    const list = ice ? (Array.isArray(ice) ? ice : [ice]) : [];
    turnCache = { iceServers: list, expires: Date.now() + (TURN_TTL - 300) * 1000 };
    res.json({ iceServers: list });
  } catch (e) {
    console.error('TURN credentials error:', e.message);
    res.json({ iceServers: [] });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---- In-memory state ----
const users = new Map();    // userId -> { id, name, ws, channelId, muted, deafened, sharing }
const channels = new Map(); // channelId -> { id, name, messages: [...] }
let idSeq = 1;

function newUserId() {
  return 'u' + (idSeq++) + '_' + Math.random().toString(36).slice(2, 7);
}
function newChannelId() {
  return 'c' + Math.random().toString(36).slice(2, 8);
}

function normalizeName(raw) {
  return String(raw || '').trim().replace(/\s+/g, ' ').slice(0, 24);
}
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const actual = crypto.scryptSync(String(password || ''), salt, 32);
    const expected = Buffer.from(hash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

// Seed channels
[
  ['c_lounge', 'Lounge'],
  ['c_gaming', 'Gaming'],
  ['c_study', 'Study'],
].forEach(([id, name]) => channels.set(id, { id, name, messages: [] }));

const MAX_CHAT = 200;

// ---- Helpers ----
function send(ws, msg) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(msg)); } catch (_) { /* ignore */ }
  }
}
function broadcast(msg) {
  const s = JSON.stringify(msg);
  for (const u of users.values()) {
    if (u.ws.readyState === 1) {
      try { u.ws.send(s); } catch (_) { /* ignore */ }
    }
  }
}
function channelMembers(channelId) {
  return [...users.values()].filter((u) => u.channelId === channelId);
}
function broadcastChannel(channelId, msg, exceptId) {
  const s = JSON.stringify(msg);
  for (const u of channelMembers(channelId)) {
    if (u.id !== exceptId && u.ws.readyState === 1) {
      try { u.ws.send(s); } catch (_) { /* ignore */ }
    }
  }
}
function publicUsers() {
  return [...users.values()].map((u) => ({
    id: u.id,
    name: u.name,
    channelId: u.channelId,
    muted: u.muted,
    deafened: u.deafened,
    sharing: u.sharing,
  }));
}
function publicChannels() {
  return [...channels.values()].map((c) => ({ id: c.id, name: c.name, locked: !!c.passwordHash }));
}
function broadcastState() {
  broadcast({ type: 'state', users: publicUsers(), channels: publicChannels() });
}

function leaveChannel(user) {
  const old = user.channelId;
  if (!old) return;
  user.channelId = null;
  user.sharing = false;
  broadcastChannel(old, { type: 'peer-left', peerId: user.id });
  broadcastState();
}

function joinChannel(user, channelId, password) {
  const ch = channels.get(channelId);
  if (!ch) {
    send(user.ws, { type: 'error', message: 'Channel not found.' });
    return;
  }
  if (user.channelId === channelId) return;
  if (ch.passwordHash) {
    const pw = String(password || '');
    if (!pw) {
      send(user.ws, { type: 'channel-join-error', channelId, message: 'This channel is locked.' });
      return;
    }
    if (!verifyPassword(pw, ch.passwordHash)) {
      send(user.ws, { type: 'channel-join-error', channelId, message: 'Wrong password.' });
      return;
    }
  }
  if (user.channelId) leaveChannel(user);
  user.channelId = channelId;
  const peers = channelMembers(channelId)
    .filter((u) => u.id !== user.id)
    .map((u) => ({ id: u.id, name: u.name }));
  send(user.ws, {
    type: 'channel-joined',
    channelId,
    history: ch.messages,
    peers,
  });
  broadcastChannel(channelId, {
    type: 'peer-joined',
    peer: { id: user.id, name: user.name },
  }, user.id);
  broadcastState();
}

// ---- Connection handling ----
wss.on('connection', (ws) => {
  const user = {
    id: newUserId(),
    name: null,
    nameKey: null,
    clientId: null,
    replaced: false,
    ws,
    channelId: null,
    muted: false,
    deafened: false,
    sharing: false,
  };
  users.set(user.id, user);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join': {
        if (user.name) {
          send(ws, { type: 'error', message: 'Already joined.' });
          break;
        }
        const name = normalizeName(msg.name);
        if (!name) {
          send(ws, { type: 'join-error', message: 'Enter a name.' });
          break;
        }
        const nameKey = name.toLowerCase();
        const clientId = String(msg.clientId || '').slice(0, 64);
        const existing = [...users.values()].find((u) => u.id !== user.id && u.nameKey === nameKey);
        if (existing) {
          // Same browser/tab reconnecting before the old socket was cleaned up:
          // let it take over. A different client must pick another name.
          if (clientId && existing.clientId && existing.clientId === clientId) {
            existing.replaced = true;
            if (existing.channelId) {
              broadcastChannel(existing.channelId, { type: 'peer-left', peerId: existing.id }, existing.id);
            }
            send(existing.ws, { type: 'session-replaced', message: 'This session was opened somewhere else.' });
            try { existing.ws.close(4001, 'session replaced'); } catch (_) {}
            users.delete(existing.id);
          } else {
            send(ws, { type: 'join-error', message: 'That name is already in use. Pick another one.' });
            break;
          }
        }
        user.name = name;
        user.nameKey = nameKey;
        user.clientId = clientId;
        send(ws, {
          type: 'welcome',
          id: user.id,
          name: user.name,
          users: publicUsers(),
          channels: publicChannels(),
        });
        broadcastState();
        break;
      }
      case 'create-channel': {
        const name = String(msg.name || '').trim().slice(0, 32);
        if (!name) break;
        const rawPassword = String(msg.password || '').slice(0, 128);
        const id = newChannelId();
        channels.set(id, {
          id,
          name,
          messages: [],
          passwordHash: rawPassword.trim() ? hashPassword(rawPassword) : null,
        });
        broadcastState();
        joinChannel(user, id, rawPassword);
        break;
      }
      case 'set-channel-password': {
        const id = String(msg.channelId || '');
        const ch = channels.get(id);
        if (!ch) { send(ws, { type: 'error', message: 'Channel not found.' }); break; }
        if (user.channelId !== id) {
          send(ws, { type: 'error', message: 'Join the channel first to change its password.' });
          break;
        }
        const rawPassword = String(msg.password || '').slice(0, 128);
        ch.passwordHash = rawPassword.trim() ? hashPassword(rawPassword) : null;
        broadcastState();
        send(ws, { type: 'channel-password-set', channelId: id, locked: !!ch.passwordHash });
        break;
      }
      case 'rename-channel': {
        const id = String(msg.channelId || '');
        const name = String(msg.name || '').trim().slice(0, 32);
        if (!id || !name) break;
        const ch = channels.get(id);
        if (!ch) { send(ws, { type: 'error', message: 'Channel not found.' }); break; }
        ch.name = name;
        broadcastState();
        // also push a system chat so everyone sees the rename
        ch.messages.push({ id: 'm' + Date.now().toString(36), userId: user.id, name: 'System', text: `Channel renamed to "${name}" by ${user.name}`, ts: Date.now() });
        broadcastChannel(id, { type: 'chat', channelId: id, message: ch.messages[ch.messages.length - 1] });
        break;
      }
      case 'delete-channel': {
        const id = String(msg.channelId || '');
        if (!id) break;
        const ch = channels.get(id);
        if (!ch) break;
        // Prevent deleting the last channel
        if (channels.size <= 1) { send(ws, { type: 'error', message: 'Cannot delete the last channel.' }); break; }
        // Kick everyone out of this channel
        for (const u of channelMembers(id)) {
          u.channelId = null;
          u.sharing = false;
          send(u.ws, { type: 'channel-deleted', channelId: id });
          // also tell peers to close
          broadcastChannel(id, { type: 'peer-left', peerId: u.id }, u.id);
        }
        channels.delete(id);
        broadcastState();
        break;
      }
      case 'join-channel': {
        if (!user.name) break;
        if (typeof msg.channelId === 'string') {
          joinChannel(user, msg.channelId, typeof msg.password === 'string' ? msg.password : '');
        }
        break;
      }
      case 'leave-channel': {
        leaveChannel(user);
        break;
      }
      case 'signal': {
        // Relay SDP / ICE to the target peer.
        if (typeof msg.to !== 'string' || !msg.data) break;
        const target = users.get(msg.to);
        if (target && target.ws.readyState === 1) {
          send(target.ws, { type: 'signal', from: user.id, data: msg.data });
        }
        break;
      }
      case 'update': {
        if (typeof msg.muted === 'boolean') user.muted = msg.muted;
        if (typeof msg.deafened === 'boolean') user.deafened = msg.deafened;
        if (typeof msg.sharing === 'boolean') user.sharing = msg.sharing;
        broadcastState();
        break;
      }
      case 'speaking': {
        if (!user.channelId) break;
        broadcastChannel(user.channelId, {
          type: 'speaking',
          userId: user.id,
          speaking: !!msg.value,
        }, user.id);
        break;
      }
      case 'chat': {
        const text = String(msg.text || '').trim().slice(0, 1000);
        if (!text || !user.channelId) break;
        const ch = channels.get(user.channelId);
        if (!ch) break;
        const message = {
          id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          userId: user.id,
          name: user.name,
          text,
          ts: Date.now(),
        };
        ch.messages.push(message);
        if (ch.messages.length > MAX_CHAT) ch.messages.splice(0, ch.messages.length - MAX_CHAT);
        broadcastChannel(user.channelId, { type: 'chat', channelId: user.channelId, message });
        break;
      }
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (user.replaced) {
      users.delete(user.id);
      return;
    }
    if (user.channelId) {
      const old = user.channelId;
      users.delete(user.id);
      broadcastChannel(old, { type: 'peer-left', peerId: user.id });
    } else {
      users.delete(user.id);
    }
    broadcastState();
  });

  ws.on('error', () => { /* handled by close */ });
});

server.listen(PORT, () => {
  console.log(`AtlasMeat running at http://localhost:${PORT}`);
});
