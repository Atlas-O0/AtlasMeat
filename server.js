// AtlasMeat — signaling server (Express + WebSocket)
// Serves the frontend from ./public and relays WebRTC signaling between peers.

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/favicon.ico', (req, res) => res.status(204).end());

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
  return [...channels.values()].map((c) => ({ id: c.id, name: c.name }));
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

function joinChannel(user, channelId) {
  const ch = channels.get(channelId);
  if (!ch) {
    send(user.ws, { type: 'error', message: 'Channel not found.' });
    return;
  }
  if (user.channelId === channelId) return;
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
        const name = String(msg.name || '').trim().slice(0, 24) || 'User';
        user.name = name;
        send(ws, {
          type: 'welcome',
          id: user.id,
          users: publicUsers(),
          channels: publicChannels(),
        });
        broadcastState();
        break;
      }
      case 'create-channel': {
        const name = String(msg.name || '').trim().slice(0, 32);
        if (!name) break;
        const id = newChannelId();
        channels.set(id, { id, name, messages: [] });
        broadcastState();
        joinChannel(user, id);
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
        if (typeof msg.channelId === 'string') joinChannel(user, msg.channelId);
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
