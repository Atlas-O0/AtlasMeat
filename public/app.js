/* AtlasMeat client — voice + screen share over WebRTC mesh */
'use strict';

/* ---------------- helpers ---------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
function timeStr(ts) {
  try { return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }); }
  catch (_) { return ''; }
}
function avatarHue(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return h;
}
const ICON_PATHS = {
  speaker: '<path d="M4 9h3l4-4v14l-4-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7"/>',
  volume: '<path d="M4 9h3l4-4v14l-4-4H4z"/><path d="M16 8.5a5 5 0 0 1 0 7"/>',
  micOff: '<path d="M4 4l16 16"/><path d="M9 9v3a3 3 0 0 0 4.6 2.5"/><path d="M15 11V6a3 3 0 0 0-5.7-1.3"/><path d="M5 11a7 7 0 0 0 10.4 6.1"/><path d="M12 18v3"/>',
  screen: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  pencil: '<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="M14 6l4 4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>',
  lock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  unlock: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 7.5-2"/>',
};
function ic(name, size = 14, cls = '') {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}"${cls ? ` class="${cls}"` : ''} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] || ''}</svg>`;
}
function toast(msg, isErr) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s'; el.style.opacity = '0';
    setTimeout(() => el.remove(), 350);
  }, 3200);
}

/* ---------------- state ---------------- */
const state = {
  myName: null,
  joined: false,
  users: [],       // roster from server
  channels: [],
  channelId: null,
  muted: false,
  deafened: false,
  speaking: new Map(), // userId -> bool
  prevMembers: [],
  peers: new Map(),    // peerId -> peer record
  vols: {},            // peerName -> 0..2
};
let myId = null;
let ws = null;
let wsGeneration = 0;
let reconnectAttempts = 0;
let reconnectTimer = null;
const clientId = (() => {
  try {
    let v = sessionStorage.getItem('atlasmeat:clientId');
    if (!v) {
      v = (window.crypto && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'cid_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      sessionStorage.setItem('atlasmeat:clientId', v);
    }
    return v;
  } catch (_) {
    return 'cid_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
})();

/* channel passwords are kept in memory only for the current page/session */
const channelPasswords = new Map();
let pendingJoinChannelId = null;
let pendingJoinPassword = '';
let pendingCreatedPassword = null; // null = no create pending, '' = created without a password
let passModalChannelId = null;
let passModalMode = 'join'; // 'join' | 'set'

/* media */
let audioCtx = null;
let micStream = null;
let micTrack = null;
let micAnalyser = null;
let micAnalyserData = null;
let vadTimer = null;
let localSpeaking = false;
let screenStream = null;
let screenVideoTrack = null;
let screenAudioTrack = null;

/* ui caches */
const tileEls = new Map();  // memberId -> element
const shareEls = new Map(); // 'me' | peerId -> { card, video }
let volEditing = false;
let tilesDirty = false;

try { state.vols = JSON.parse(localStorage.getItem('atlasmeat:vols') || '{}'); } catch (_) { state.vols = {}; }
function saveVols() { try { localStorage.setItem('atlasmeat:vols', JSON.stringify(state.vols)); } catch (_) {} }
function getVolume(name) {
  const v = Number(state.vols[name]);
  return Number.isFinite(v) ? Math.min(4, Math.max(0, v)) : 1;
}
function quality() {
  try {
    const q = JSON.parse(localStorage.getItem('atlasmeat:quality') || '{}');
    return {
      res: q.res || '1920x1080',
      fps: Number(q.fps) || 30,
      bitrate: Number(q.bitrate) || 6000, // kbps
    };
  } catch (_) { return { res: '1920x1080', fps: 30, bitrate: 6000 }; }
}
function saveQuality(q) { try { localStorage.setItem('atlasmeat:quality', JSON.stringify(q)); } catch (_) {} }
function audioProc() {
  try {
    const p = JSON.parse(localStorage.getItem('atlasmeat:audioProc') || '{}');
    return {
      echoCancellation: p.echoCancellation === true,
      noiseSuppression: p.noiseSuppression === true,
      autoGainControl: p.autoGainControl === true,
    };
  } catch (_) { return { echoCancellation: false, noiseSuppression: false, autoGainControl: false }; }
}
function saveAudioProc(p) { try { localStorage.setItem('atlasmeat:audioProc', JSON.stringify(p)); } catch (_) {} }
function hotkeysCfg() {
  try {
    const h = JSON.parse(localStorage.getItem('atlasmeat:hotkeys') || '{}');
    return {
      mute: { enabled: !!h.mute?.enabled, key: h.mute?.key || '' },
      deafen: { enabled: !!h.deafen?.enabled, key: h.deafen?.key || '' },
      ptt: { enabled: !!h.ptt?.enabled, key: h.ptt?.key || '' },
    };
  } catch (_) { return { mute:{enabled:false,key:''}, deafen:{enabled:false,key:''}, ptt:{enabled:false,key:''} }; }
}
function saveHotkeys(h) { try { localStorage.setItem('atlasmeat:hotkeys', JSON.stringify(h)); } catch (_) {} }
function notifEnabled() {
  try { const v = localStorage.getItem('atlasmeat:notifSound'); return v == null ? true : v === '1'; } catch (_) { return true; }
}
function saveNotifEnabled(v) { try { localStorage.setItem('atlasmeat:notifSound', v ? '1':'0'); } catch (_) {} }
function formatHotkey(e) {
  const parts=[];
  if(e.ctrlKey) parts.push('Ctrl');
  if(e.altKey) parts.push('Alt');
  if(e.shiftKey) parts.push('Shift');
  if(e.metaKey) parts.push('Meta');
  let key = e.code || e.key;
  // Normalize: use code for letters (KeyA) -> A, Digits -> 1, etc. Keep as is for F keys, Space, etc.
  if(key.startsWith('Key')) key = key.slice(3);
  else if(key.startsWith('Digit')) key = key.slice(5);
  else if(key===' ') key='Space';
  // Don't include modifier keys themselves as main key
  if(['Control','Shift','Alt','Meta'].includes(e.key)) return parts.join('+');
  if(!parts.includes(key)) parts.push(key);
  return parts.join('+');
}
function hotkeyMatches(e, savedKey) {
  if(!savedKey) return false;
  return formatHotkey(e) === savedKey;
}
let pttActive = false;
let pttPrevEnabled = null;
function playNotifSound() {
  try {
    const ctx = ensureAudio();
    if(!ctx) return;
    if(ctx.state==='suspended') ctx.resume().catch(()=>{});
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type='sine'; o.frequency.value=880;
    g.gain.value=0.12;
    o.connect(g); g.connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+0.22);
    o.stop(ctx.currentTime+0.23);
  } catch(_){}
}

/* ---------------- audio ---------------- */
let pendingAudios = [];
function ensureAudio() {
  if (!audioCtx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}
function unlockAudio() {
  ensureAudio();
  const all = [...document.querySelectorAll('#remoteAudios audio'), ...pendingAudios];
  all.forEach((a) => {
    if (a.paused) a.play().catch(() => {});
  });
  // Keep only still-paused ones in pending
  pendingAudios = pendingAudios.filter((a) => a.paused && document.body.contains(a));
  // Also clear the hint toast if audio now playing
  if (all.some((a) => !a.paused)) {
    const hint = document.querySelector('.toast-audio-hint');
    if (hint) hint.remove();
  }
}
['pointerdown', 'click', 'keydown', 'touchstart'].forEach((ev) =>
  document.addEventListener(ev, unlockAudio, { passive: true })
);
window.addEventListener('pointerup', () => {
  if (volEditing) { volEditing = false; if (tilesDirty) renderTiles(); }
}, { passive: true });

/* ---------------- websocket ---------------- */
function wsUrl() {
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
}
function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function connect(name) {
  state.myName = name;
  const gen = ++wsGeneration;
  const sock = new WebSocket(wsUrl());
  ws = sock;

  sock.onopen = () => {
    if (gen !== wsGeneration) return;
    reconnectAttempts = 0;
    send({ type: 'join', name, clientId });
    pushUpdate();
  };
  sock.onmessage = (ev) => {
    if (gen !== wsGeneration) return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    route(msg);
  };
  sock.onclose = (ev) => {
    if (gen !== wsGeneration) return;
    if (!state.joined && !state.myName) return;
    if (ev && ev.code === 4001) {
      returnToJoin('This session was opened somewhere else.');
      return;
    }
    cleanupPeers();
    scheduleReconnect();
  };
  sock.onerror = () => { try { sock.close(); } catch (_) {} };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectAttempts++;
  const wait = Math.min(15000, 2000 * reconnectAttempts);
  toast(`Reconnecting in ${Math.round(wait / 1000)}s`, true);
  reconnectTimer = setTimeout(() => {
    if (state.myName) connect(state.myName);
  }, wait);
}

function releaseMic() {
  try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
  try { stopVAD(); } catch (_) {}
  micStream = null;
  micTrack = null;
}

function returnToJoin(message) {
  state.joined = false;
  state.myName = null;
  try { leaveChannel(true); } catch (_) {}
  releaseMic();
  $('#app').classList.add('hidden');
  $('#joinScreen').classList.remove('hidden');
  $('#joinError').textContent = message || '';
  $('#joinBtn').disabled = false;
  try { if (ws) ws.close(); } catch (_) {}
}

function route(msg) {
  switch (msg.type) {
    case 'welcome':
      myId = msg.id;
      state.joined = true;
      if (msg.name) state.myName = msg.name;
      state.users = msg.users || [];
      state.channels = msg.channels || [];
      $('#joinError').textContent = '';
      enterApp();
      ensureMic().then(() => refreshMicList()).catch(() => {});
      if (state.channelId) {
        send({
          type: 'join-channel',
          channelId: state.channelId,
          password: channelPasswords.get(state.channelId) || '',
        });
      }
      renderAll();
      break;
    case 'state':
      state.users = msg.users || [];
      state.channels = msg.channels || [];
      renderAll();
      detectMemberChanges();
      break;
    case 'channel-joined':
      if (pendingCreatedPassword !== null) {
        if (pendingCreatedPassword) channelPasswords.set(msg.channelId, pendingCreatedPassword);
        pendingCreatedPassword = null;
      }
      if (pendingJoinChannelId === msg.channelId && pendingJoinPassword) {
        channelPasswords.set(msg.channelId, pendingJoinPassword);
      }
      pendingJoinChannelId = null;
      pendingJoinPassword = '';
      if (passModalMode === 'join' && passModalChannelId === msg.channelId) closeChannelPassword();
      state.channelId = msg.channelId;
      state.speaking.clear();
      setMessages(msg.history || []);
      (msg.peers || []).forEach((p) => getPeer(p.id, p.name));
      renderAll();
      startConnPoll();
      break;
    case 'peer-joined':
      getPeer(msg.peer.id, msg.peer.name);
      sysMsg(`${msg.peer.name} joined the channel`);
      renderAll();
      startConnPoll();
      break;
    case 'peer-left': {
      const p = state.peers.get(msg.peerId);
      if (p) { sysMsg(`${p.name || 'Someone'} left the channel`); closePeer(msg.peerId); }
      if (state.peers.size === 0) stopConnPoll();
      break;
    }
    case 'signal':
      onSignal(msg.from, msg.data);
      break;
    case 'speaking':
      state.speaking.set(msg.userId, !!msg.speaking);
      updatePresence();
      break;
    case 'chat':
      if (msg.channelId === state.channelId) {
        appendMsg(msg.message);
        // Notification sound if tab is in background and it's not our own message
        if (msg.message.userId !== myId && notifEnabled() && (document.hidden || !document.hasFocus())) {
          playNotifSound();
          // Also flash title
          const orig = document.title;
          document.title = `${msg.message.name}: ${msg.message.text.slice(0,20)} — AtlasMeat`;
          setTimeout(()=>{ document.title = orig; }, 3000);
        }
      }
      break;
    case 'channel-deleted': {
      channelPasswords.delete(msg.channelId);
      if (passModalChannelId === msg.channelId) closeChannelPassword();
      // If we were in the deleted channel, leave it
      if (state.channelId === msg.channelId) {
        toast('Channel was deleted.', true);
        leaveChannel(true);
      }
      break;
    }
    case 'channel-join-error':
      if (passModalMode === 'join' && passModalChannelId === msg.channelId) {
        $('#channelPassError').textContent = msg.message || 'Could not join this channel.';
        $('#channelPassInput').select();
      } else {
        toast(msg.message || 'Could not join this channel.', true);
        if (state.channelId === msg.channelId) leaveChannel(true);
      }
      pendingJoinChannelId = null;
      pendingJoinPassword = '';
      break;
    case 'channel-password-set':
      if (passModalMode === 'set' && passModalChannelId === msg.channelId) {
        closeChannelPassword();
        toast(msg.locked ? 'Channel password set.' : 'Channel password removed.');
      }
      break;
    case 'join-error':
      returnToJoin(msg.message || 'Unable to join.');
      break;
    case 'session-replaced':
      returnToJoin(msg.message || 'This session was opened somewhere else.');
      break;
    case 'error':
      toast(msg.message || 'Something went wrong.', true);
      break;
    default:
      break;
  }
}

/* ---------------- join ---------------- */
function doJoin() {
  const input = $('#nameInput');
  const name = input.value.trim().replace(/\s+/g, ' ').slice(0, 24) || 'Anonymous';
  $('#joinBtn').disabled = true;
  $('#joinError').textContent = '';
  if (!('RTCPeerConnection' in window)) {
    $('#joinError').textContent = 'Your browser does not support WebRTC.';
    $('#joinBtn').disabled = false;
    return;
  }
  unlockAudio();
  connect(name);
}
$('#joinBtn').addEventListener('click', doJoin);
$('#nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });

function enterApp() {
  $('#joinScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#meName').textContent = state.myName;
  const av = $('#meAvatar');
  av.textContent = state.myName.trim().charAt(0) || '?';
  av.style.background = `hsl(${avatarHue(state.myName)}, 60%, 45%)`;
  $('#joinBtn').disabled = false;
  refreshMicList();
}

/* ---------------- channels ---------------- */
function myMembers() {
  if (!state.channelId) return [];
  return state.users.filter((u) => u.channelId === state.channelId);
}

function renderChannels() {
  const list = $('#channelList');
  list.innerHTML = '';
  const membersByChannel = new Map();
  state.users.forEach((u) => {
    if (!u.channelId) return;
    if (!membersByChannel.has(u.channelId)) membersByChannel.set(u.channelId, []);
    membersByChannel.get(u.channelId).push(u);
  });
  state.channels.forEach((ch) => {
    const members = membersByChannel.get(ch.id) || [];
    const div = document.createElement('div');
    div.className = 'channel' + (state.channelId === ch.id ? ' active' : '');
    let html = `<div class="channel-name"><span class="ch-name">${ic('speaker', 16, 'ch-ico')}${escapeHtml(ch.name)}</span>` +
      (ch.locked ? `<span class="ch-lock" title="Password protected">${ic('lock', 12)}</span>` : '') +
      `<span class="channel-count">${members.length}</span></div>`;
    if (members.length) {
      html += '<div class="channel-members">' + members.map((m) => {
        const speaking = state.speaking.get(m.id) || (m.id === myId && localSpeaking);
        return `<div class="ch-member${m.id === myId ? ' me' : ''}${speaking ? ' speaking' : ''}" data-mid="${m.id}">` +
          `<span class="mini-av" style="background:hsl(${avatarHue(m.name)},50%,42%)">${escapeHtml(m.name.trim().charAt(0) || '?')}</span>` +
          `<span class="ch-mname">${escapeHtml(m.name)}</span>` +
          `<span class="mic-state">${(m.muted || m.deafened) ? `<span class="state-muted">${ic('micOff', 12)}</span>` : ''}${m.sharing ? ic('screen', 12) : ''}</span></div>`;
      }).join('') + '</div>';
    }
    // Build channel row with hover actions (password / rename / delete)
    const actions = document.createElement('div');
    actions.className = 'ch-actions';
    if (state.channelId === ch.id) {
      const lockBtn = document.createElement('button');
      lockBtn.className = 'icon-btn ch-act';
      lockBtn.innerHTML = ic(ch.locked ? 'unlock' : 'lock', 13);
      lockBtn.title = ch.locked ? 'Change or remove password' : 'Set password';
      lockBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openChannelPassword(ch.id, 'set');
      });
      actions.appendChild(lockBtn);
    }
    const renameBtn = document.createElement('button');
    renameBtn.className = 'icon-btn ch-act';
    renameBtn.innerHTML = ic('pencil', 13);
    renameBtn.title = 'Rename channel';
    renameBtn.addEventListener('click', (e) => { e.stopPropagation(); startRenameChannel(ch.id, ch.name); });
    const delBtn = document.createElement('button');
    delBtn.className = 'icon-btn ch-act ch-del';
    delBtn.innerHTML = ic('trash', 13);
    delBtn.title = 'Delete channel';
    delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteChannel(ch.id, ch.name); });
    actions.appendChild(renameBtn);
    actions.appendChild(delBtn);

    // Rebuild innerHTML then append actions (so actions stay as real elements)
    div.innerHTML = html;
    const nameRow = div.querySelector('.channel-name');
    if (nameRow) nameRow.appendChild(actions);
    div.addEventListener('click', () => joinChannel(ch.id));
    list.appendChild(div);
  });
}

function startRenameChannel(id, oldName) {
  const name = prompt('Rename channel:', oldName);
  if (name == null) return;
  const trimmed = name.trim().slice(0, 32);
  if (!trimmed || trimmed === oldName) return;
  send({ type: 'rename-channel', channelId: id, name: trimmed });
}
function deleteChannel(id, name) {
  if (!confirm(`Delete #${name}? Everyone inside will be moved out.`)) return;
  send({ type: 'delete-channel', channelId: id });
}

function joinChannel(id) {
  if (state.channelId === id) return;
  unlockAudio();
  if (!micStream && !($('#micSelect') && $('#micSelect').value === 'off')) {
    toast('Microphone not ready', true);
  }
  const ch = state.channels.find((c) => c.id === id);
  if (ch && ch.locked) {
    openChannelPassword(id, 'join');
    return;
  }
  send({ type: 'join-channel', channelId: id });
}

function leaveChannel(silent) {
  closeChannelPassword();
  pendingJoinChannelId = null;
  pendingJoinPassword = '';
  stopScreen(true);
  cleanupPeers();
  stopConnPoll();
  if (!silent) send({ type: 'leave-channel' });
  state.channelId = null;
  state.speaking.clear();
  tileEls.forEach((el) => el.remove());
  tileEls.clear();
  shareEls.forEach((s) => s.card.remove());
  shareEls.clear();
  setMessages([]);
  renderAll();
}

$('#addChannelBtn').addEventListener('click', () => {
  $('#newChannelRow').classList.toggle('hidden');
  $('#newChannelInput').focus();
});
$('#createChannelBtn').addEventListener('click', createChannel);
$('#newChannelInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') createChannel(); });
$('#newChannelPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') createChannel(); });
function createChannel() {
  const v = $('#newChannelInput').value.trim().slice(0, 32);
  if (!v) return;
  const password = $('#newChannelPass').value;
  pendingCreatedPassword = password;
  send({ type: 'create-channel', name: v, password });
  $('#newChannelInput').value = '';
  $('#newChannelPass').value = '';
  $('#newChannelRow').classList.add('hidden');
}

/* ---------------- channel password ---------------- */
function openChannelPassword(channelId, mode) {
  const ch = state.channels.find((c) => c.id === channelId);
  if (!ch) return;
  if (mode === 'set' && state.channelId !== channelId) {
    toast('Join the channel first to change its password.', true);
    return;
  }
  passModalChannelId = channelId;
  passModalMode = mode;
  $('#channelPassTitle').textContent = `#${ch.name}`;
  $('#channelPassHint').textContent = mode === 'join'
    ? 'This channel is locked. Enter the password to join.'
    : 'Set a password for this channel. Leave it blank to remove the current one.';
  $('#channelPassInput').value = '';
  $('#channelPassError').textContent = '';
  $('#channelPassSubmit').textContent = mode === 'join' ? 'Join' : 'Save';
  $('#channelPassModal').classList.remove('hidden');
  setTimeout(() => $('#channelPassInput').focus(), 0);
}

function closeChannelPassword() {
  $('#channelPassModal').classList.add('hidden');
  passModalChannelId = null;
  passModalMode = 'join';
  $('#channelPassInput').value = '';
  $('#channelPassError').textContent = '';
}

function submitChannelPassword() {
  if (!passModalChannelId) return;
  const value = $('#channelPassInput').value;
  if (passModalMode === 'join') {
    if (!value) {
      $('#channelPassError').textContent = 'Enter the password.';
      return;
    }
    pendingJoinChannelId = passModalChannelId;
    pendingJoinPassword = value;
    $('#channelPassError').textContent = '';
    send({ type: 'join-channel', channelId: passModalChannelId, password: value });
  } else {
    send({ type: 'set-channel-password', channelId: passModalChannelId, password: value });
  }
}

$('#channelPassClose').addEventListener('click', closeChannelPassword);
$('#channelPassSubmit').addEventListener('click', submitChannelPassword);
$('#channelPassInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); submitChannelPassword(); }
});
$('#channelPassModal').addEventListener('click', (e) => {
  if (e.target.id === 'channelPassModal') closeChannelPassword();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#channelPassModal').classList.contains('hidden')) closeChannelPassword();
});

/* ---------------- mic ---------------- */
async function ensureMic() {
  if (micStream) {
    const t = micStream.getAudioTracks()[0];
    if (t && t.readyState === 'live') return;
    // Stream is stale (e.g. interrupted by screen capture) — re-acquire below.
    try { micStream.getTracks().forEach((x) => x.stop()); } catch (_) {}
    micStream = null; micTrack = null;
  }
  const savedDev = (() => { try { return localStorage.getItem('atlasmeat:mic'); } catch (_) { return null; } })();
  const proc = audioProc();
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: savedDev
        ? { deviceId: { exact: savedDev }, echoCancellation: proc.echoCancellation, noiseSuppression: proc.noiseSuppression, autoGainControl: proc.autoGainControl }
        : { echoCancellation: proc.echoCancellation, noiseSuppression: proc.noiseSuppression, autoGainControl: proc.autoGainControl },
    });
  } catch (e) {
    toast('Microphone blocked — listen only', true);
    return;
  }
  micTrack = micStream.getAudioTracks()[0];
  micTrack.enabled = !(state.muted || state.deafened);
  startVAD();
  state.peers.forEach((p) => {
    if (p.micSender) safeReplace(p.micSender, micTrack);
    else addLocalTracksToPeer(p);
  });
}

async function switchMic(deviceId) {
  try { try { localStorage.setItem('atlasmeat:mic', deviceId || ''); } catch (_) {} } catch (_) {}
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  stopVAD();
  micStream = null; micTrack = null;
  if (deviceId === 'off') {
    // Remove mic senders so the other side knows we're listen-only (renegotiates)
    state.peers.forEach((p) => {
      if (p.micSender) {
        try { p.pc.removeTrack(p.micSender); } catch (_) {}
        p.micSender = null;
      }
    });
    return;
  }
  const proc = audioProc();
  const constraints = deviceId
    ? { deviceId: { exact: deviceId }, echoCancellation: proc.echoCancellation, noiseSuppression: proc.noiseSuppression, autoGainControl: proc.autoGainControl }
    : { echoCancellation: proc.echoCancellation, noiseSuppression: proc.noiseSuppression, autoGainControl: proc.autoGainControl };
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
    micTrack = micStream.getAudioTracks()[0];
    micTrack.enabled = !(state.muted || state.deafened);
    startVAD();
    state.peers.forEach((p) => {
      if (p.micSender) safeReplace(p.micSender, micTrack);
      else addLocalTracksToPeer(p);
    });
  } catch (e) {
    toast('Could not switch microphone', true);
  }
}

async function refreshMicList() {
  const sel = $('#micSelect');
  sel.innerHTML = '';
  try {
    const devs = await navigator.mediaDevices.enumerateDevices();
    const mics = devs.filter((d) => d.kind === 'audioinput');
    const saved = (() => { try { return localStorage.getItem('atlasmeat:mic'); } catch (_) { return ''; } })() || '';
    const def = document.createElement('option');
    def.value = ''; def.textContent = 'System default';
    sel.appendChild(def);
    mics.forEach((m, i) => {
      const o = document.createElement('option');
      o.value = m.deviceId;
      o.textContent = m.label || `Microphone ${i + 1}`;
      sel.appendChild(o);
    });
    const off = document.createElement('option');
    off.value = 'off'; off.textContent = 'No microphone (listen only)';
    sel.appendChild(off);
    if (saved) sel.value = saved;
    sel.onchange = () => switchMic(sel.value);
  } catch (_) {
    sel.innerHTML = '<option value="">System default</option>';
  }
}

/* voice activity detection on local mic */
function startVAD() {
  const ctx = ensureAudio();
  if (!ctx || !micStream) return;
  try {
    const src = ctx.createMediaStreamSource(micStream);
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 512;
    micAnalyserData = new Uint8Array(micAnalyser.fftSize);
    src.connect(micAnalyser);
  } catch (_) { return; }
  if (vadTimer) return;
  let lastSent = false;
  let smooth = 0;
  vadTimer = setInterval(() => {
    if (!micAnalyser || !micTrack || !micTrack.enabled) {
      if (localSpeaking) setLocalSpeaking(false);
      return;
    }
    micAnalyser.getByteTimeDomainData(micAnalyserData);
    let sum = 0;
    for (let i = 0; i < micAnalyserData.length; i++) {
      const v = (micAnalyserData[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / micAnalyserData.length);
    smooth = smooth * 0.7 + rms * 0.3;
    const speaking = localSpeaking ? smooth > 0.018 : smooth > 0.035;
    if (speaking !== localSpeaking) setLocalSpeaking(speaking);
    if (speaking !== lastSent && state.channelId) {
      lastSent = speaking;
      send({ type: 'speaking', value: speaking });
    }
  }, 120);
}
function stopVAD() {
  clearInterval(vadTimer); vadTimer = null;
  micAnalyser = null;
  setLocalSpeaking(false);
}
function setLocalSpeaking(v) {
  localSpeaking = v;
  updatePresence();
}

/* ---------------- webrtc mesh ---------------- */
// More STUN servers (Google STUN is often blocked on some networks).
// A TURN relay can be added in public/rtc-config.js for symmetric NATs.
const ICE_SERVERS = [
  {
    urls: [
      'stun:stun.cloudflare.com:3478',
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.services.mozilla.com',
    ],
  },
];
if (window.ATLAS_TURN) ICE_SERVERS.push(window.ATLAS_TURN);
const RTC_CONFIG = { iceServers: ICE_SERVERS };

// Fetch TURN credentials from the server (Cloudflare TURN relay).
// Fixes "connected but no audio" when both users are behind strict NATs.
async function loadTurnServers() {
  try {
    const res = await fetch('/turn', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const list = Array.isArray(data.iceServers)
      ? data.iceServers
      : (data.iceServers ? [data.iceServers] : []);
    list.forEach((s) => { if (s && s.urls) ICE_SERVERS.push(s); });
  } catch (_) { /* relay is optional */ }
}
loadTurnServers();
function sendSignal(to, data) { send({ type: 'signal', to, data }); }
function nameOf(id) {
  const u = state.users.find((x) => x.id === id);
  return u ? u.name : 'User';
}

function preferVP9ForSender(sender) {
  try {
    const caps = RTCRtpReceiver.getCapabilities('video');
    if (!caps || !caps.codecs) return;
    const pc = sender ? null : null; // keep linter quiet
    const vp9 = caps.codecs.filter((c) => /VP9/i.test(c.mimeType));
    const h264 = caps.codecs.filter((c) => /H264/i.test(c.mimeType));
    const rest = caps.codecs.filter((c) => !/VP9|H264/i.test(c.mimeType));
    if (!vp9.length && !h264.length) return;
    // Find the transceiver that owns this sender (if any) and set prefs
    // Caller will pass transceiver directly when possible.
  } catch (_) {}
}

function getPeer(peerId, peerName) {
  let p = state.peers.get(peerId);
  if (p) { if (peerName) p.name = peerName; return p; }
  const pc = new RTCPeerConnection(RTC_CONFIG);
  p = {
    id: peerId, name: peerName || nameOf(peerId), pc,
    makingOffer: false, ignoreOffer: false,
    polite: myId ? myId > peerId : true,
    pending: [],
    micSender: null,
    screenVideoSender: null,
    screenAudioSender: null,
    // Web Audio (optional boost) + <audio> fallback (reliable)
    audioSrc: null, audioGain: null,
    shareSrc: null, shareGain: null,
    audioEl: null, shareAudioEl: null,
    videoTrack: null,
    remoteAudioTrack: null,
    remoteShareAudioTrack: null,
  };
  state.peers.set(peerId, p);

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal(peerId, { candidate: e.candidate });
  };
  pc.onnegotiationneeded = () => negotiate(p);
  pc.ontrack = (e) => onRemoteTrack(p, e);

  // Attach any local tracks that already exist (mic / screen). Uses addTrack so
  // Chrome reuses the transceiver correctly on the answerer side.
  addLocalTracksToPeer(p);
  // Fallback: some headless timing edge-cases don't fire negotiationneeded
  // synchronously. Only fire if we still have an un-negotiated transceiver.
  setTimeout(() => {
    if (p.pc.signalingState !== 'stable' || p.makingOffer) return;
    const needsOffer = p.pc.getTransceivers().some((t) => t.currentDirection == null);
    if (needsOffer) negotiate(p);
  }, 400);
  return p;
}

function addLocalTracksToPeer(p) {
  const pc = p.pc;
  try {
    if (micTrack && !p.micSender) {
      p.micSender = pc.addTrack(micTrack, new MediaStream([micTrack]));
    }
  } catch (e) { console.warn('add mic track', e); }
  try {
    if (screenVideoTrack && !p.screenVideoSender) {
      p.screenVideoSender = pc.addTrack(screenVideoTrack, new MediaStream([screenVideoTrack]));
      // Prefer VP9 for screen content (sharper text at lower bitrate)
      try {
        const caps = RTCRtpReceiver.getCapabilities('video');
        if (caps && caps.codecs) {
          const vp9 = caps.codecs.filter((c) => /VP9/i.test(c.mimeType));
          const h264 = caps.codecs.filter((c) => /H264/i.test(c.mimeType));
          const rest = caps.codecs.filter((c) => !/VP9|H264/i.test(c.mimeType));
          if (vp9.length || h264.length) {
            const tr = pc.getTransceivers().find((t) => t.sender === p.screenVideoSender);
            if (tr && tr.setCodecPreferences) tr.setCodecPreferences([...vp9, ...h264, ...rest]);
          }
        }
      } catch (_) {}
      applyVideoBitrate(p);
    }
  } catch (e) { console.warn('add video track', e); }
  try {
    if (screenAudioTrack && !p.screenAudioSender) {
      p.screenAudioSender = pc.addTrack(screenAudioTrack, new MediaStream([screenAudioTrack]));
    }
  } catch (e) { console.warn('add share-audio track', e); }
}

async function negotiate(p) {
  if (p.makingOffer) return;
  if (p.pc.signalingState !== 'stable') return;
  const isInitial = p.pc.connectionState === 'new' && p.pc.iceConnectionState === 'new';
  if (isInitial && myId && myId > p.id) return;
  try {
    p.makingOffer = true;
    await p.pc.setLocalDescription();
    sendSignal(p.id, { description: p.pc.localDescription });
  } catch (e) { console.warn('negotiate', e); }
  finally { p.makingOffer = false; }
}

async function onSignal(fromId, data) {
  const p = getPeer(fromId);
  const pc = p.pc;
  try {
    if (data.description) {
      const desc = data.description;
      const readyForOffer = !p.makingOffer &&
        (pc.signalingState === 'stable' || p.settingRemoteAnswer);
      const collision = desc.type === 'offer' && !readyForOffer;
      p.ignoreOffer = !p.polite && collision;
      if (p.ignoreOffer) return;
      p.settingRemoteAnswer = desc.type === 'answer';
      await pc.setRemoteDescription(desc);
      p.settingRemoteAnswer = false;
      while (p.pending.length) {
        const c = p.pending.shift();
        try { await pc.addIceCandidate(c); } catch (_) {}
      }
      if (desc.type === 'offer') {
        await pc.setLocalDescription();
        sendSignal(fromId, { description: pc.localDescription });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(data.candidate); } catch (_) {}
      } else {
        p.pending.push(data.candidate);
      }
    }
  } catch (e) { console.warn('signal', e); }
}

function onRemoteTrack(p, e) {
  const track = e.track;
  if (!track) return;
  if (track.kind === 'video') {
    // Replace any previous video track from this peer
    if (p.videoTrack && p.videoTrack.id === track.id) return;
    p.videoTrack = track;
    track.onended = () => { if (p.videoTrack === track) { p.videoTrack = null; renderShares(); renderTiles(); } };
    track.onmute = () => {};
    renderShares();
    renderTiles();
  } else if (track.kind === 'audio') {
    // Lower the playout buffer to cut call delay (default can be ~200 ms).
    try {
      if (e.receiver && 'jitterBufferTarget' in e.receiver) e.receiver.jitterBufferTarget = 0;
    } catch (_) {}
    // Two audio tracks max: mic + share-audio. First arrival is the mic, and its
    // slot is never taken over by the share track (that used to kill the mic).
    const isMicSlot = !!p.remoteAudioTrack && p.remoteAudioTrack.id === track.id;
    const isShareSlot = !!p.remoteShareAudioTrack && p.remoteShareAudioTrack.id === track.id;
    if (isMicSlot || isShareSlot) return;
    const isShare = !!p.remoteAudioTrack;
    if (!isShare) {
      p.remoteAudioTrack = track;
      track.onended = () => { if (p.remoteAudioTrack === track) { teardownRemoteAudio(p, false); renderTiles(); } };
      track.onunmute = () => { if (p.remoteAudioTrack === track && !p.audioEl) setupRemoteAudio(p, track, false); };
      setupRemoteAudio(p, track, false);
    } else {
      if (p.remoteShareAudioTrack) teardownRemoteAudio(p, true);
      p.remoteShareAudioTrack = track;
      track.onended = () => { if (p.remoteShareAudioTrack === track) teardownRemoteAudio(p, true); };
      track.onunmute = () => { if (p.remoteShareAudioTrack === track && !p.shareAudioEl) setupRemoteAudio(p, track, true); };
      setupRemoteAudio(p, track, true);
    }
  }
}

function releaseRemoteAudio(p, isShare) {
  // Removes playback plumbing only. Track references stay intact so the
  // mic/share slots keep their identity (clearing them makes a share-audio
  // track hijack the mic slot and the mic never comes back after sharing).
  try {
    if (isShare) {
      if (p.shareAudioEl) { try { p.shareAudioEl.pause(); p.shareAudioEl.srcObject = null; p.shareAudioEl.remove(); } catch (_) {} }
      if (p.shareSrc) { try { p.shareSrc.disconnect(); } catch (_) {} }
      try { if (p.shareGain) p.shareGain.disconnect(); } catch (_) {}
      p.shareAudioEl = null; p.shareSrc = null; p.shareGain = null;
    } else {
      if (p.audioEl) { try { p.audioEl.pause(); p.audioEl.srcObject = null; p.audioEl.remove(); } catch (_) {} }
      if (p.audioSrc) { try { p.audioSrc.disconnect(); } catch (_) {} }
      try { if (p.audioGain) p.audioGain.disconnect(); } catch (_) {}
      p.audioEl = null; p.audioSrc = null; p.audioGain = null;
    }
  } catch (_) {}
}

function teardownRemoteAudio(p, isShare) {
  releaseRemoteAudio(p, isShare);
  if (isShare) p.remoteShareAudioTrack = null; else p.remoteAudioTrack = null;
}

function setupRemoteAudio(p, track, isShare) {
  // Always use <audio> element — reliable across autoplay policies.
  // Create a persistent gain for >100% boost so slider 0-400% actually matters.
  try {
    releaseRemoteAudio(p, isShare);
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.playsInline = true;
    audio.controls = false;
    const vol = state.deafened ? 0 : getVolume(p.name);
    // Only route through Web Audio when boosting above 100%. Normal listening
    // uses the <audio> element directly, which avoids extra output latency.
    const boost = vol > 1;
    audio.volume = boost ? 1 : Math.min(1, vol);
    audio.muted = !!state.deafened;
    audio.srcObject = new MediaStream([track]);
    const container = document.getElementById('remoteAudios');
    if (container) container.appendChild(audio);
    const playPromise = audio.play();
    if (playPromise && playPromise.catch) playPromise.catch(() => {
      pendingAudios.push(audio);
      if (!document.querySelector('.toast-audio-hint')) {
        const t = document.createElement('div');
        t.className = 'toast toast-audio-hint';
        t.textContent = 'Click anywhere to enable audio';
        document.getElementById('toasts').appendChild(t);
        setTimeout(() => { t.style.opacity='0'; setTimeout(()=>t.remove(),400); }, 5000);
      }
    });
    if (isShare) p.shareAudioEl = audio;
    else p.audioEl = audio;

    // Web Audio gain is only needed for the 100–400% boost range.
    if (boost) {
      const ctx = ensureAudio();
      if (ctx) {
        try {
          if (ctx.state === 'suspended') ctx.resume().catch(()=>{});
          const src = ctx.createMediaElementSource(audio);
          const gain = ctx.createGain();
          gain.gain.value = vol;
          src.connect(gain);
          gain.connect(ctx.destination);
          audio.volume = 1;
          if (isShare) { p.shareSrc = src; p.shareGain = gain; }
          else { p.audioSrc = src; p.audioGain = gain; }
        } catch (_) {
          // If MediaElementSource fails, fall back to plain audio.volume.
          audio.volume = 1;
        }
      }
    }
  } catch (e) { console.warn('audio element', e); }
}

/* replaceTrack that is safe whether it returns a Promise or undefined */
function safeReplace(sender, track) {
  if (!sender || !sender.replaceTrack) return;
  try {
    const r = sender.replaceTrack(track);
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch (_) {}
}

function applyVideoBitrate(p) {
  // Find the active video sender (screen share) regardless of stored reference
  let sender = p.screenVideoSender;
  if (!sender || !sender.track) {
    try {
      const senders = p.pc.getSenders();
      sender = senders.find((s) => s.track && s.track.kind === 'video' && s.track === screenVideoTrack)
            || senders.find((s) => s.track && s.track.kind === 'video')
            || p.screenVideoSender;
    } catch (_) { sender = p.screenVideoSender; }
  }
  if (!sender || typeof sender.getParameters !== 'function') return;
  const bps = quality().bitrate * 1000;
  Promise.resolve()
    .then(() => sender.getParameters())
    .then((params) => {
      params.encodings = params.encodings && params.encodings.length ? params.encodings : [{}];
      params.encodings[0].maxBitrate = bps;
      return sender.setParameters(params);
    })
    .catch(() => {});
}

function closePeer(peerId) {
  const p = state.peers.get(peerId);
  if (!p) return;
  try { p.pc.close(); } catch (_) {}
  teardownRemoteAudio(p, false);
  teardownRemoteAudio(p, true);
  state.peers.delete(peerId);
  state.speaking.delete(peerId);
  const t = tileEls.get(peerId);
  if (t) { t.remove(); tileEls.delete(peerId); }
  const s = shareEls.get(peerId);
  if (s) { s.card.remove(); shareEls.delete(peerId); }
}
function cleanupPeers() {
  [...state.peers.keys()].forEach(closePeer);
}

/* ---------------- screen share ---------------- */
async function toggleScreen() {
  if (screenStream) { stopScreen(); return; }
  if (!state.channelId) { toast('Join a channel first.', true); return; }
  const q = quality();
  const [w, h] = q.res.split('x').map(Number);
  const videoBase = {
    width: { ideal: w }, height: { ideal: h },
    frameRate: { ideal: q.fps, max: 60 },
  };
  let stream = null;
  try {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoBase, audio: true,
        selfBrowserSurface: 'include', surfaceSwitching: 'include',
      });
    } catch (e1) {
      if (e1 && (e1.name === 'NotAllowedError' || e1.name === 'NotFoundError')) throw e1;
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: videoBase, audio: true });
      } catch (e2) {
        if (e2 && (e2.name === 'NotAllowedError' || e2.name === 'NotFoundError')) throw e2;
        stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      }
    }
  } catch (e) {
    if (e && e.name !== 'NotAllowedError' && e.name !== 'NotFoundError') {
      toast('Could not start screen sharing', true);
    }
    return;
  }
  screenStream = stream;
  screenVideoTrack = stream.getVideoTracks()[0] || null;
  screenAudioTrack = stream.getAudioTracks()[0] || null;

  if (screenVideoTrack) {
    try { screenVideoTrack.contentHint = 'detail'; } catch (_) {}
    try {
      await screenVideoTrack.applyConstraints({
        width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: q.fps },
      });
    } catch (_) {}
    screenVideoTrack.onended = () => stopScreen();
  }
  // Add screen tracks via addTrack (renegotiates).
  // IMPORTANT: keep mic alive — some browsers briefly mute mic when display audio is captured.
  // Re-assert mic track after adding screen tracks.
  state.peers.forEach((p) => {
    try {
      if (screenVideoTrack && !p.screenVideoSender) {
        p.screenVideoSender = p.pc.addTrack(screenVideoTrack, screenStream);
        try {
          const caps = RTCRtpReceiver.getCapabilities('video');
          if (caps && caps.codecs) {
            const vp9 = caps.codecs.filter((c) => /VP9/i.test(c.mimeType));
            const h264 = caps.codecs.filter((c) => /H264/i.test(c.mimeType));
            const rest = caps.codecs.filter((c) => !/VP9|H264/i.test(c.mimeType));
            if (vp9.length || h264.length) {
              const tr = p.pc.getTransceivers().find((t) => t.sender === p.screenVideoSender);
              if (tr && tr.setCodecPreferences) tr.setCodecPreferences([...vp9, ...h264, ...rest]);
            }
          }
        } catch (_) {}
      } else if (screenVideoTrack && p.screenVideoSender) {
        safeReplace(p.screenVideoSender, screenVideoTrack);
      }
      if (screenAudioTrack && !p.screenAudioSender) {
        p.screenAudioSender = p.pc.addTrack(screenAudioTrack, screenStream);
      } else if (screenAudioTrack && p.screenAudioSender) {
        safeReplace(p.screenAudioSender, screenAudioTrack);
      }
      // Re-assert mic sender so it doesn't get paused when screen audio is added
      if (micTrack && p.micSender) {
        safeReplace(p.micSender, micTrack);
      }
      if (screenVideoTrack) applyVideoBitrate(p);
    } catch (e) { console.warn('screen addTrack', e); }
  });
  // Extra safety: ensure local mic analyser still connected after screen capture
  // (some browsers fire 'ended' on mic when display picker is shown)
  if (micTrack && micTrack.readyState === 'live') {
    applyPttState();
  } else if (!micTrack || micTrack.readyState === 'ended') {
    // Mic was interrupted — try to re-acquire silently
    ensureMic();
  }
  send({ type: 'update', sharing: true });
  toast(screenAudioTrack ? 'Sharing screen with audio' : 'Sharing screen');
  renderAll();
}

function stopScreen(silent) {
  if (screenStream) screenStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
  const hadVideo = !!screenVideoTrack;
  const hadAudio = !!screenAudioTrack;
  screenStream = null; screenVideoTrack = null; screenAudioTrack = null;
  const meShare = shareEls.get('me');
  if (meShare) { meShare.card.remove(); shareEls.delete('me'); }
  state.peers.forEach((p) => {
    // Detach the screen tracks WITHOUT renegotiating (replaceTrack(null) keeps the
    // m-lines stable, so the microphone transceiver is never disturbed).
    if (hadVideo && p.screenVideoSender) {
      const s = p.screenVideoSender;
      try {
        if (s.replaceTrack) { const r = s.replaceTrack(null); if (r && r.catch) r.catch(() => {}); }
        else { p.pc.removeTrack(s); p.screenVideoSender = null; }
      } catch (_) {}
    }
    if (hadAudio && p.screenAudioSender) {
      const s = p.screenAudioSender;
      try {
        if (s.replaceTrack) { const r = s.replaceTrack(null); if (r && r.catch) r.catch(() => {}); }
        else { p.pc.removeTrack(s); p.screenAudioSender = null; }
      } catch (_) {}
    }
    // Re-assert the mic sender: after display audio is detached some browsers
    // leave the mic sender with a dead track, so put a live track back.
    if (micTrack && micTrack.readyState === 'live' && p.micSender) {
      safeReplace(p.micSender, micTrack);
    }
  });
  // If the mic itself died while the share was running, grab it again.
  if (!micTrack || micTrack.readyState === 'ended') {
    try { if (micStream) micStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { stopVAD(); } catch (_) {}
    micStream = null; micTrack = null;
    ensureMic();
  }
  applyPttState();
  if (!silent) {
    send({ type: 'update', sharing: false });
    toast('Screen sharing stopped.');
  }
  renderShares();
  renderTiles();
}

/* live quality change while sharing */
async function applyQualityLive() {
  const q = quality();
  if (screenVideoTrack) {
    const [w, h] = q.res.split('x').map(Number);
    try {
      await screenVideoTrack.applyConstraints({
        width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: q.fps },
      });
    } catch (_) { toast('These settings did not apply', true); }
  }
  state.peers.forEach(applyVideoBitrate);
}

/* ---------------- rendering ---------------- */
function renderAll() {
  renderChannels();
  renderHeader();
  renderTiles();
  renderShares();
  renderControls();
  renderMePanel();
  updatePresence();
}

function renderHeader() {
  const ch = state.channels.find((c) => c.id === state.channelId);
  $('#channelTitle').textContent = ch ? ch.name : 'No channel';
  $('#chatTitle').textContent = ch ? `#${ch.name}` : 'Chat';
  const n = myMembers().length;
  const mc = $('#memberCount');
  mc.classList.toggle('hidden', !ch);
  mc.textContent = ch ? `${n} member${n === 1 ? '' : 's'}` : '';
  const anyShare = ch && myMembers().some((m) => m.id === myId ? !!screenStream : m.sharing);
  $('#shareBadge').classList.toggle('hidden', !anyShare);

  const inChannel = !!ch;
  $('#stageEmpty').classList.toggle('hidden', inChannel);
  $('#stage').classList.toggle('hidden', !inChannel);
  $('#controlBar').classList.toggle('hidden', !inChannel);
  const ci = $('#chatInput');
  ci.disabled = !inChannel;
  $('#chatSend').disabled = !inChannel;
  ci.placeholder = inChannel ? `Message #${ch.name}` : 'Select a channel';
}

function renderTiles() {
  if (volEditing) { tilesDirty = true; return; }
  tilesDirty = false;
  const members = myMembers();
  const box = $('#tiles');
  const seen = new Set();
  members.forEach((m) => {
    seen.add(m.id);
    let tile = tileEls.get(m.id);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.tid = m.id;
      box.appendChild(tile);
      tileEls.set(m.id, tile);
    }
    const isMe = m.id === myId;
    const vol = getVolume(m.name);
    const sharing = isMe ? !!screenStream : !!m.sharing;
    tile.innerHTML =
      (isMe ? '' : `<button class="vol-toggle" title="Volume">${ic('volume', 14)}</button>`) +
      `<div class="t-face">` +
        `<div class="avatar" style="background:hsl(${avatarHue(m.name)},50%,42%)">${escapeHtml(m.name.trim().charAt(0) || '?')}</div>` +
        `<div class="t-name">${escapeHtml(m.name)}${isMe ? '<span class="t-you">you</span>' : ''}</div>` +
      `</div>` +
      `<div class="t-meta">` +
        `<div class="t-flags" data-flags></div>` +
        (sharing ? '<div class="t-share-ind">Sharing screen</div>' : '') +
      `</div>` +
      (isMe ? '' :
        `<div class="vol" data-vol><span>${ic('volume', 12)}</span>` +
        `<input type="range" min="0" max="400" step="5" value="${Math.round(vol * 100)}" />` +
        `<span data-volval>${Math.round(vol * 100)}%</span></div>`);
    if (!isMe) {
      const toggle = tile.querySelector('.vol-toggle');
      const volBox = tile.querySelector('[data-vol]');
      toggle.addEventListener('click', () => volBox.classList.toggle('show'));
      const slider = tile.querySelector('input[type="range"]');
      const label = tile.querySelector('[data-volval]');
      slider.addEventListener('pointerdown', () => { volEditing = true; });
      slider.addEventListener('input', () => {
        const v = Number(slider.value) / 100;
        state.vols[m.name] = v;
        saveVols();
        label.textContent = `${slider.value}%`;
        const p = state.peers.get(m.id);
        if (p && !state.deafened) {
          // For audio elements, volume is 0..1, so scale 0-400% to 0-1 with a curve for better sensitivity
          // Use a more sensitive curve: 0-100% = 0-1 linear, 100-400% = 1 + boost via GainNode
          if (p.audioEl) {
            if (p.audioGain) {
              p.audioEl.volume = 1;
              p.audioGain.gain.value = v;
            } else if (v > 1) {
              // Try to create gain boost on the fly if not exists
              try {
                const ctx = ensureAudio();
                if (ctx && ctx.state === 'running') {
                  const src = ctx.createMediaElementSource(p.audioEl);
                  const gain = ctx.createGain();
                  gain.gain.value = v;
                  src.connect(gain); gain.connect(ctx.destination);
                  p.audioSrc = src; p.audioGain = gain;
                  p.audioEl.volume = 1;
                }
              } catch(_){}
            } else {
              p.audioEl.volume = Math.min(1, v);
            }
          }
          if (p.shareAudioEl) {
            if (p.shareGain) {
              p.shareAudioEl.volume = 1;
              p.shareGain.gain.value = v;
            } else {
              p.shareAudioEl.volume = Math.min(1, v);
            }
          }
          // Fallback for Web Audio only paths
          if (p.audioGain && !p.audioEl) p.audioGain.gain.value = v;
          if (p.shareGain && !p.shareAudioEl) p.shareGain.gain.value = v;
        }
      });
    }
  });
  [...tileEls.keys()].forEach((id) => {
    if (!seen.has(id)) { tileEls.get(id).remove(); tileEls.delete(id); }
  });
  updatePresence();
}

function updatePresence() {
  tileEls.forEach((tile, id) => {
    const m = state.users.find((u) => u.id === id);
    const speaking = state.speaking.get(id) || (id === myId && localSpeaking);
    tile.classList.toggle('speaking', !!speaking);
    const flags = tile.querySelector('[data-flags]');
    if (flags && m) {
      const muted = id === myId ? (state.muted || state.deafened) : (m.muted || m.deafened);
      const deaf = id === myId ? state.deafened : m.deafened;
      flags.textContent = muted ? (deaf ? 'Deafened' : 'Muted') : '';
    }
  });
  $$('.ch-member[data-mid]').forEach((el) => {
    const id = el.dataset.mid;
    el.classList.toggle('speaking', !!(state.speaking.get(id) || (id === myId && localSpeaking)));
  });
}

function renderShares() {
  const members = myMembers();
  const box = $('#shares');
  const seen = new Set();
  const sharers = [];
  members.forEach((m) => {
    const isMe = m.id === myId;
    const active = isMe ? !!screenStream : !!m.sharing;
    if (active) sharers.push({ key: isMe ? 'me' : m.id, name: m.name, isMe, id: m.id });
  });
  sharers.forEach((s) => {
    seen.add(s.key);
    let rec = shareEls.get(s.key);
    if (!rec) {
      const card = document.createElement('div');
      card.className = 'share-card';
      card.innerHTML = `<div class="share-tag"><span class="live"></span><span data-label></span></div>` +
        (s.isMe ? '<button class="share-stop">Stop</button>' : '') +
        `<button class="share-fs" title="Fullscreen">Fullscreen</button>`;
      const video = document.createElement('video');
      video.autoplay = true; video.playsInline = true;
      card.prepend(video);
      if (s.isMe) card.querySelector('.share-stop').addEventListener('click', () => stopScreen());
      const fsBtn = card.querySelector('.share-fs');
      fsBtn.addEventListener('click', () => toggleShareFullscreen(card, video, fsBtn));
      // Double-click video also toggles fullscreen
      video.addEventListener('dblclick', () => toggleShareFullscreen(card, video, fsBtn));
      box.appendChild(card);
      rec = { card, video, fsBtn };
      shareEls.set(s.key, rec);
    }
    rec.card.querySelector('[data-label]').textContent = s.isMe ? 'Your screen' : `${s.name}'s screen`;
    // attach track
    const track = s.isMe
      ? screenVideoTrack
      : (state.peers.get(s.id) || {}).videoTrack;
    if (track && track.readyState === 'live') {
      const stream = new MediaStream([track]);
      if (!rec.video.srcObject || rec.video.srcObject.getVideoTracks()[0] !== track) {
        rec.video.srcObject = stream;
        rec.video.play().catch(() => {});
      }
    } else if (!track && rec.video.srcObject) {
      rec.video.srcObject = null;
    }
  });
  [...shareEls.keys()].forEach((k) => {
    if (!seen.has(k)) { shareEls.get(k).card.remove(); shareEls.delete(k); }
  });
  const anyShare = sharers.length > 0;
  $('#shareBadge').classList.toggle('hidden', !anyShare);
  const stage = $('#stage');
  if (stage) stage.classList.toggle('has-share', anyShare);
}

function toggleShareFullscreen(card, video, btn) {
  const isFs = document.fullscreenElement === card || document.fullscreenElement === video;
  if (isFs) {
    document.exitFullscreen().catch(() => {});
    return;
  }
  // Prefer card fullscreen so tag/buttons stay visible
  const target = card.requestFullscreen ? card : video;
  const p = target.requestFullscreen ? target.requestFullscreen() : video.requestFullscreen();
  if (p && p.catch) p.catch(() => video.requestFullscreen().catch(() => {}));
}
document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  document.querySelectorAll('.share-fs').forEach((b) => {
    b.textContent = isFs ? 'Exit' : 'Fullscreen';
    b.title = isFs ? 'Exit fullscreen' : 'Fullscreen';
  });
  document.querySelectorAll('.share-card').forEach((c) => c.classList.toggle('is-fs', isFs && document.fullscreenElement === c));
});

function renderControls() {
  const off = (id, isOff) => $(id).classList.toggle('off', !!isOff);
  off('#micBtn', state.muted || state.deafened);
  off('#deafenBtn', state.deafened);
  off('#meMicBtn', state.muted || state.deafened);
  off('#meDeafenBtn', state.deafened);
  $('#screenBtn').classList.toggle('on', !!screenStream);
}

function renderMePanel() {
  const ch = state.channels.find((c) => c.id === state.channelId);
  $('#meStatus').textContent = state.deafened ? 'Deafened' : ch ? `In #${ch.name}` : 'Online';
}

function pushUpdate() {
  send({
    type: 'update',
    muted: state.muted || state.deafened,
    deafened: state.deafened,
    sharing: !!screenStream,
  });
}

function detectMemberChanges() {
  // Peer join/leave lines come from the server's peer-joined / peer-left events.
  // Only keep the roster snapshot here so messages never duplicate.
  if (!state.channelId) { state.prevMembers = []; return; }
  state.prevMembers = myMembers().map((m) => m.id);
}

/* ---------------- chat ---------------- */
function msgEl(m) {
  const div = document.createElement('div');
  div.className = 'msg' + (m.sys ? ' sys' : '');
  const text = document.createElement('div');
  text.className = 'msg-text';
  text.textContent = m.text;
  if (m.sys) {
    div.appendChild(text);
    return div;
  }
  const head = document.createElement('div');
  head.className = 'msg-head';
  const name = document.createElement('span');
  name.className = 'msg-name';
  name.textContent = m.name;
  name.style.color = `hsl(${avatarHue(m.name)}, 60%, 72%)`;
  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = timeStr(m.ts);
  head.appendChild(name); head.appendChild(time);
  div.appendChild(head); div.appendChild(text);
  return div;
}
function appendMsg(m) {
  const box = $('#messages');
  box.appendChild(msgEl(m));
  while (box.children.length > 200) box.firstChild.remove();
  box.scrollTop = box.scrollHeight;
}
function sysMsg(text) {
  appendMsg({ name: '', text, ts: Date.now(), sys: true });
}
function setMessages(list) {
  const box = $('#messages');
  box.innerHTML = '';
  list.forEach(appendMsg);
}
function sendChatFromInput() {
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text || !state.channelId) return;
  send({ type: 'chat', text: text.slice(0, 1000) });
  input.value = '';
}
$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  sendChatFromInput();
});
$('#chatSend').addEventListener('click', (e) => {
  e.preventDefault();
  sendChatFromInput();
});

/* ---------------- controls ---------------- */
function toggleMute() {
  state.muted = !state.muted;
  if (micTrack) micTrack.enabled = !(state.muted || state.deafened);
  pushUpdate();
  renderControls(); renderMePanel(); updatePresence();
}
function toggleDeafen() {
  state.deafened = !state.deafened;
  if (micTrack) micTrack.enabled = !(state.muted || state.deafened);
  state.peers.forEach((p) => {
    const v = state.deafened ? 0 : getVolume(p.name);
    if (p.audioEl) { p.audioEl.volume = p.audioGain ? 1 : Math.min(1, v); p.audioEl.muted = state.deafened; }
    if (p.shareAudioEl) { p.shareAudioEl.volume = p.shareGain ? 1 : Math.min(1, v); p.shareAudioEl.muted = state.deafened; }
    if (p.audioGain) p.audioGain.gain.value = v;
    if (p.shareGain) p.shareGain.gain.value = v;
  });
  // If deafen was just disabled, try to resume/play again (autoplay may have been blocked)
  if (!state.deafened) unlockAudio();
  pushUpdate();
  renderControls(); renderMePanel(); updatePresence();
}
$('#micBtn').addEventListener('click', toggleMute);
$('#meMicBtn').addEventListener('click', toggleMute);
$('#deafenBtn').addEventListener('click', toggleDeafen);
$('#meDeafenBtn').addEventListener('click', toggleDeafen);
$('#screenBtn').addEventListener('click', toggleScreen);
$('#leaveBtn').addEventListener('click', () => leaveChannel());

/* user panel → settings menu */
function closeMeMenu() { $('#meMenu').classList.add('hidden'); }
$('#mePanel').addEventListener('click', (e) => {
  if (e.target.closest('#meMicBtn') || e.target.closest('#meDeafenBtn') || e.target.closest('#meMenu')) return;
  $('#meMenu').classList.toggle('hidden');
});
$('#meMenuSettings').addEventListener('click', (e) => {
  e.stopPropagation();
  closeMeMenu();
  openQuality();
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#mePanel')) closeMeMenu();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMeMenu();
});
// Hotkeys (disabled by default, user sets them in Settings)
function isTypingTarget(el) {
  return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
}
let hkCapture = null; // 'mute'|'deafen'|'ptt' when waiting for key
document.addEventListener('keydown', (e) => {
  // Capture mode for setting hotkey
  if (hkCapture) {
    e.preventDefault(); e.stopPropagation();
    const key = formatHotkey(e);
    if (!key || ['Control','Shift','Alt','Meta'].includes(e.key)) return;
    const cfg = hotkeysCfg();
    cfg[hkCapture].key = key;
    cfg[hkCapture].enabled = true;
    saveHotkeys(cfg);
    updateHotkeysUI();
    hkCapture = null;
    toast(`Hotkey for ${e.key} set to ${key}`);
    return;
  }
  if (isTypingTarget(e.target)) return;
  if ($('#app').classList.contains('hidden')) return;
  const cfg = hotkeysCfg();
  // Push-to-talk: hold to talk
  if (cfg.ptt.enabled && hotkeyMatches(e, cfg.ptt.key) && !pttActive) {
    if (e.repeat) return;
    e.preventDefault();
    pttActive = true;
    pttPrevEnabled = micTrack ? micTrack.enabled : true;
    if (micTrack) micTrack.enabled = !state.muted && !state.deafened;
    // Visual feedback
    $('#micBtn').classList.add('ptt-active');
  }
  // Mute / Deafen are toggles on keydown (not repeat)
  if (e.repeat) return;
  if (cfg.mute.enabled && hotkeyMatches(e, cfg.mute.key)) {
    e.preventDefault(); toggleMute();
  } else if (cfg.deafen.enabled && hotkeyMatches(e, cfg.deafen.key)) {
    e.preventDefault(); toggleDeafen();
  } else if (!cfg.mute.enabled && !cfg.deafen.enabled && !cfg.ptt.enabled) {
    // Fallback default: Ctrl+M for mute when no hotkeys set
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'm') {
      e.preventDefault(); toggleMute();
    }
  }
});
document.addEventListener('keyup', (e) => {
  const cfg = hotkeysCfg();
  if (cfg.ptt.enabled && pttActive && hotkeyMatches(e, cfg.ptt.key)) {
    e.preventDefault();
    pttActive = false;
    if (micTrack) micTrack.enabled = false;
    // Restore previous if it was muted/deafened, keep muted
    $('#micBtn').classList.remove('ptt-active');
    updatePresence();
  }
  // Also handle case where PTT was active and user released any key that was the PTT key (match via code)
  if (pttActive && cfg.ptt.enabled) {
    // If the released key is part of the combo, also end PTT
    const saved = cfg.ptt.key;
    // If saved key contains the released code, consider it released
    if (saved && saved.includes(e.code.replace('Key','').replace('Digit',''))) {
      // Fallback: end PTT on any keyup when PTT was active and no longer held
      // Check if the hotkey is no longer considered pressed (we don't have full state, so just end)
      // This handles cases where formatHotkey on keyup may differ
    }
  }
});
// When PTT is enabled, keep mic muted by default (unless pushing)
function applyPttState() {
  const cfg = hotkeysCfg();
  if (cfg.ptt.enabled) {
    if (!pttActive && micTrack) micTrack.enabled = false;
  } else {
    if (micTrack) micTrack.enabled = !(state.muted || state.deafened);
  }
}
function updateHotkeysUI() {
  const cfg = hotkeysCfg();
  const set = (id, key, enabled) => {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = key || 'Not set';
      el.style.opacity = enabled ? '1' : '0.5';
    }
  };
  set('hkMuteKey', cfg.mute.key, cfg.mute.enabled);
  set('hkDeafenKey', cfg.deafen.key, cfg.deafen.enabled);
  set('hkPttKey', cfg.ptt.key, cfg.ptt.enabled);
  const m = document.getElementById('hkMuteEn');
  const d = document.getElementById('hkDeafenEn');
  const p = document.getElementById('hkPttEn');
  const n = document.getElementById('notifSoundEn');
  if (m) m.checked = cfg.mute.enabled;
  if (d) d.checked = cfg.deafen.enabled;
  if (p) {
    const was = p.checked;
    p.checked = cfg.ptt.enabled;
    if (was !== cfg.ptt.enabled) applyPttState();
  }
  if (n) n.checked = notifEnabled();
}
// Wire hotkey Set buttons and checkboxes (once)
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('.hk-set').forEach((btn) => {
    btn.addEventListener('click', () => {
      const hk = btn.dataset.hk;
      hkCapture = hk;
      btn.textContent = 'Press key…';
      toast('Press your desired hotkey now');
      setTimeout(() => {
        if (hkCapture === hk) {
          hkCapture = null;
          btn.textContent = 'Set';
          updateHotkeysUI();
        }
      }, 5000);
    });
  });
  ['hkMuteEn','hkDeafenEn','hkPttEn','notifSoundEn'].forEach((id)=>{
    const el=document.getElementById(id);
    if(el) el.addEventListener('change', ()=>{
      const cfg=hotkeysCfg();
      if(id==='hkMuteEn') cfg.mute.enabled = el.checked;
      if(id==='hkDeafenEn') cfg.deafen.enabled = el.checked;
      if(id==='hkPttEn') { cfg.ptt.enabled = el.checked; pttActive=false; }
      if(id==='notifSoundEn') { saveNotifEnabled(el.checked); updateHotkeysUI(); return; }
      saveHotkeys(cfg);
      updateHotkeysUI();
      applyPttState();
      updatePresence();
    });
  });
});
// Also wire immediately in case DOM already loaded
(() => {
  const w = () => {
    document.querySelectorAll('.hk-set').forEach((btn) => {
      if (btn._hkWired) return; btn._hkWired=true;
      btn.addEventListener('click', () => {
        const hk = btn.dataset.hk;
        hkCapture = hk;
        btn.textContent = 'Press key…';
        toast('Press your desired hotkey now');
      });
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', w);
  else w();
})();

/* ---------------- connection indicator ---------------- */
let connPoll = null;
function startConnPoll(){
  if(connPoll) return;
  connPoll = setInterval(async ()=>{
    for(const p of state.peers.values()){
      try{
        const stats = await p.pc.getStats();
        let rtt=null, loss=0, recv=0, jitter=0, bitrate=0;
        let packetsReceived=0, packetsLost=0;
        let inboundBytes=0, outboundBytes=0;
        let last = p._lastStats || {};
        const now = Date.now();
        stats.forEach(s=>{
          if(s.type==='candidate-pair' && s.state==='succeeded' && s.currentRoundTripTime!=null) rtt=s.currentRoundTripTime*1000;
          if(s.type==='inbound-rtp' && !s.isRemote){
            if(s.kind==='audio' || s.mediaType==='audio'){
              packetsReceived+=s.packetsReceived||0;
              packetsLost+=s.packetsLost||0;
              if(s.jitter!=null) jitter=Math.max(jitter, s.jitter*1000);
              if(s.bytesReceived!=null) inboundBytes+=s.bytesReceived;
            }
            if(s.kind==='video' && s.framesDropped!=null) p._framesDropped=s.framesDropped;
          }
          if(s.type==='outbound-rtp' && !s.isRemote && s.bytesSent!=null) outboundBytes+=s.bytesSent;
        });
        // compute loss rate
        const total = packetsReceived+packetsLost;
        loss = total ? (packetsLost/total)*100 : 0;
        // bitrate (kbps) from delta
        if(last.ts && last.inboundBytes!=null){
          const dt = (now - last.ts)/1000;
          if(dt>0) bitrate = ((inboundBytes - last.inboundBytes)*8/1000)/dt;
        }
        p._lastStats = {ts:now, inboundBytes, outboundBytes};
        // quality 0-4
        let q=4;
        const conn = p.pc.connectionState;
        const ice = p.pc.iceConnectionState;
        if(conn==='failed' || conn==='disconnected' || ice==='failed' || ice==='disconnected') q=0;
        else if(conn==='connecting' || ice==='checking' || ice==='new') q=1;
        else {
          if(loss>5) q=Math.min(q,1);
          else if(loss>2) q=Math.min(q,2);
          else if(loss>0.5) q=Math.min(q,3);
          if(rtt!=null && rtt>400) q=Math.min(q,1);
          else if(rtt!=null && rtt>200) q=Math.min(q,2);
          else if(rtt!=null && rtt>120) q=Math.min(q,3);
          if(jitter>40) q=Math.min(q,2);
          else if(jitter>20) q=Math.min(q,3);
          if(p._framesDropped!=null && p._framesDropped>30) q=Math.min(q,2);
        }
        p._connQuality=q;
        p._connDetail={rtt: rtt!=null?Math.round(rtt)+'ms':'—', loss: total?loss.toFixed(1)+'%':'0%', jitter: jitter?Math.round(jitter)+'ms':'—', bitrate: bitrate?Math.round(bitrate)+' kbps':'—'};
        // Update tile indicator if exists
        const tile = tileEls.get(p.id);
        if(tile){
          let ind = tile.querySelector('.conn-ind');
          if(!ind){
            ind=document.createElement('div');
            ind.className='conn-ind';
            ind.innerHTML='<span class="bar"></span><span class="bar"></span><span class="bar"></span><span class="bar"></span>';
            tile.appendChild(ind);
          }
          ind.className='conn-ind conn-'+q;
          ind.title=`RTT ${p._connDetail.rtt} • Loss ${p._connDetail.loss} • Jitter ${p._connDetail.jitter} • ${p._connDetail.bitrate}`;
        }
      }catch(_){}
    }
    // Also update local (no peer) - show nothing
  }, 2500);
}
function stopConnPoll(){ if(connPoll){ clearInterval(connPoll); connPoll=null; } }

/* ---------------- quality modal ---------------- */
function fmtBitrate(kbps) {
  if (kbps >= 1000) {
    const mb = kbps / 1000;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} Mbps`;
  }
  return `${kbps} Kbps`;
}
function openQuality() {
  const q = quality();
  $('#qualityRes').value = q.res;
  $('#qualityFps').value = String(q.fps);
  $('#qualityBitrate').value = String(q.bitrate);
  $('#bitrateVal').textContent = fmtBitrate(q.bitrate);
  const proc = audioProc();
  $('#procEC').checked = proc.echoCancellation;
  $('#procNS').checked = proc.noiseSuppression;
  $('#procAGC').checked = proc.autoGainControl;
  updateHotkeysUI();
  $('#qualityModal').classList.remove('hidden');
}
$('#qualityClose').addEventListener('click', () => $('#qualityModal').classList.add('hidden'));
$('#qualityModal').addEventListener('click', (e) => {
  if (e.target.id === 'qualityModal') $('#qualityModal').classList.add('hidden');
});
$('#qualityBitrate').addEventListener('input', (e) => {
  $('#bitrateVal').textContent = fmtBitrate(Number(e.target.value));
});
$('#qualityApply').addEventListener('click', async () => {
  const q = {
    res: $('#qualityRes').value,
    fps: Number($('#qualityFps').value),
    bitrate: Number($('#qualityBitrate').value),
  };
  saveQuality(q);
  const newProc = {
    echoCancellation: $('#procEC').checked,
    noiseSuppression: $('#procNS').checked,
    autoGainControl: $('#procAGC').checked,
  };
  const oldProc = audioProc();
  const procChanged = newProc.echoCancellation !== oldProc.echoCancellation ||
                      newProc.noiseSuppression !== oldProc.noiseSuppression ||
                      newProc.autoGainControl !== oldProc.autoGainControl;
  saveAudioProc(newProc);
  $('#qualityModal').classList.add('hidden');
  toast('Settings saved.');
  if (screenStream) await applyQualityLive();
  if (procChanged && micStream) {
    const dev = (() => { try { return localStorage.getItem('atlasmeat:mic'); } catch (_) { return ''; } })() || '';
    // Re-acquire mic with new processing flags
    toast('Restarting mic with new audio settings…');
    await switchMic(dev || '');
    // If switchMic turned mic off (dev==off case), re-enable with new proc
    if (!micStream && dev !== 'off') {
      micStream = null; micTrack = null;
      await ensureMic();
    }
  }
});

window.addEventListener('beforeunload', () => {
  try { if (ws && ws.readyState === 1) ws.close(); } catch (_) {}
});
