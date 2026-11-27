// AtlasMeat SFU: one uplink per client, relayed to the other members of the same
// channel. Runs inside the app's own HTTP/WS server (no extra port) and reuses
// the existing WebSocket for signaling, so it knows who is in which channel.
const { RTCPeerConnection, MediaStreamTrack } = require('werift');

const GOP_CACHE_BYTES = 4 * 1024 * 1024;
const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

// Is this packet the start of a VP8 keyframe? (RFC 7741 payload descriptor)
function vp8IsKeyframe(buf) {
  try {
    let i = 12 + 4 * (buf[0] & 0x0f);
    if (buf[0] & 0x10) i += 4 + 4 * buf.readUInt16BE(i + 2);
    const d = buf[i];
    if ((d & 0x10) === 0) return false;
    i += 1;
    if (d & 0x80) {
      const x = buf[i];
      i += 1;
      if (x & 0x80) { const picId = buf[i]; i += (picId & 0x80) ? 2 : 1; }
      if (x & 0x40) i += 1;
      if (x & 0x20) i += 1;
      if (x & 0x10) i += 1;
    }
    if (i >= buf.length) return false;
    return (buf[i] & 0x01) === 0;
  } catch (_) { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Sfu {
  constructor({ send, log }) {
    this.send = send;       // (user, msg) -> void
    this.log = log || (() => {});
    this.sessions = new Map(); // userId -> session
  }

  session(user) {
    let s = this.sessions.get(user.id);
    if (!s) {
      s = { user, pc: null, sources: [], senders: new Map(), pending: [], offerSent: false, busy: false };
      this.sessions.set(user.id, s);
    }
    return s;
  }

  ensurePc(s) {
    if (s.pc) return s.pc;
    if (!this.debugTimer && process.env.SFU_DEBUG === '1') {
      this.debugTimer = setInterval(() => {
        for (const sess of this.sessions.values()) {
          for (const src of sess.sources) {
            this.log(`dbg ${sess.user.id} ${src.key} recv=${src.recvBytes || 0} fwd=${src.fwdBytes || 0} subs=${src.subs.length}`);
          }
        }
      }, 3000);
      this.debugTimer.unref && this.debugTimer.unref();
    }
    // 'standard' pairing: a subscribing sendonly transceiver must never be paired
    // with the transceiver that already carries this client's own microphone.
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS, transceiverPairing: 'standard' });
    s.pc = pc;
    pc.onIceCandidate.subscribe((c) => {
      if (!c) return;
      const payload = c.toJSON ? c.toJSON() : c;
      if (s.offerSent) this.send(s.user, { type: 'sfu-candidate', candidate: payload });
      else s.pending.push(payload);
    });
    pc.connectionStateChange.subscribe((state) => {
      this.log(`sfu ${s.user.id} state ${state}`);
      if (state === 'failed' || state === 'closed') this.drop(s.user);
    });
    pc.onTrack.subscribe((track) => {
      const codec = track.codec;
      const source = {
        key: `${track.kind}:${track.ssrc}`,
        kind: track.kind,
        ssrc: track.ssrc,
        codec,
        owner: s,
        subs: [],
        gop: [],
        gopBytes: 0,
      };
      this.log(`sfu ${s.user.id} publishes ${source.key} ${codec && codec.mimeType}`);
      track.onReceiveRtp.subscribe((rtp) => {
        let buf;
        try { buf = Buffer.from(rtp.serialize()); } catch (_) { return; }
        if (source.kind === 'video') {
          const key = vp8IsKeyframe(buf);
          if (key) { source.gop = []; source.gopBytes = 0; }
          if (key || source.gop.length) {
            source.gop.push(buf);
            source.gopBytes += buf.length;
            if (source.gopBytes > GOP_CACHE_BYTES) { source.gop = []; source.gopBytes = 0; }
          }
        }
        source.recvBytes = (source.recvBytes || 0) + buf.length;
        for (const sub of source.subs) { try { sub.writeRtp(buf); source.fwdBytes = (source.fwdBytes || 0) + buf.length; } catch (_) {} }
      });
      s.sources.push(source);
      this.syncChannel(s.user);
    });
    return pc;
  }

  requestKeyframe(source) {
    if (source.kind !== 'video') return;
    try {
      const receivers = [...source.owner.pc.getReceivers()];
      const receiver = receivers.find((r) => r.track && r.track.ssrc === source.ssrc)
        || receivers.find((r) => r.track && r.track.kind === 'video');
      const ssrc = (receiver && receiver.track && receiver.track.ssrc) || source.ssrc;
      if (receiver && receiver.sendRtcpPLI) Promise.resolve(receiver.sendRtcpPLI(ssrc)).catch(() => {});
    } catch (_) {}
  }

  // Everyone in `user.channelId` should be subscribed to everyone else there.
  syncChannel(user) {
    if (!user || !user.channelId) return;
    for (const other of this.sessions.values()) {
      if (other.user.id === user.id) continue;
      if (other.user.channelId !== user.channelId) continue;
      for (const source of other.sources) this.subscribe(user, other, source);
    }
    const self = this.sessions.get(user.id);
    if (self) {
      for (const other of this.sessions.values()) {
        if (other === self || other.user.channelId !== user.channelId) continue;
        for (const source of self.sources) this.subscribe(other.user, self, source);
      }
    }
  }

  async subscribe(user, ownerSession, source) {
    const s = this.session(user);
    const pc = this.ensurePc(s);
    if (s.senders.has(source.key)) return;
    if (s.subscribed && s.subscribed.has(source.key)) return;
    s.subscribed = s.subscribed || new Set();
    s.subscribed.add(source.key);
    // One outbound track per viewer: each viewer needs its own keyframe start.
    const track = new MediaStreamTrack({ kind: source.kind, ssrc: source.ssrc, codec: source.codec });
    let sender = null;
    try {
      // A fresh sendonly transceiver, never the one carrying this client's own
      // microphone (addTrack would reuse it and steal the client's uplink).
      const tr = pc.addTransceiver(source.kind, { direction: 'sendonly' });
      sender = tr.sender;
      await sender.replaceTrack(track);
      s.senders.set(source.key, sender);
    } catch (e) { this.log(`sfu subscribe failed: ${e.message}`); return; }
    await this.renegotiate(user, s);
    const ok = await this.waitConnected(s);
    if (!ok) { this.log(`sfu ${user.id} never connected`); return; }
    this.requestKeyframe(source);
    if (source.kind === 'video' && source.gop.length) {
      for (const buf of source.gop) { try { track.writeRtp(buf); } catch (_) {} }
    }
    source.subs.push(track);
    // Tell the browser which publisher this incoming track belongs to. The MID
    // only exists once the offer carrying it was negotiated, so retry if needed.
    let tr = pc.getTransceivers().find((t) => t.sender === sender);
    if (!tr || tr.mid == null) {
      await this.renegotiate(user, s);
      await sleep(400);
      tr = pc.getTransceivers().find((t) => t.sender === sender);
    }
    if (tr && tr.mid != null) {
      this.send(user, {
        type: 'sfu-track',
        mid: String(tr.mid),
        publisherId: ownerSession.user.id,
        name: ownerSession.user.name,
        kind: source.kind,
      });
      this.log(`sfu ${user.id} subscribes ${source.key} as mid=${tr.mid}`);
    } else {
      this.log(`sfu ${user.id} could not announce ${source.key}`);
    }
  }

  async waitConnected(s, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      if (s.pc.connectionState === 'connected') return true;
      await sleep(100);
    }
    return false;
  }

  async renegotiate(user, s) {
    if (s.busy) return;
    // One negotiation at a time: a browser that is still answering our offer
    // cannot accept a second one that changes the m-line order.
    if (s.pc.signalingState !== 'stable') { s.pendingSync = true; return; }
    try {
      s.busy = true;
      const offer = await s.pc.createOffer();
      await s.pc.setLocalDescription(offer);
      this.send(user, { type: 'sfu-offer', sdp: (s.pc.localDescription && s.pc.localDescription.sdp) || offer.sdp });
      s.offerSent = true;
      const queued = s.pending.splice(0);
      for (const candidate of queued) this.send(user, { type: 'sfu-candidate', candidate });
    } catch (e) {
      this.log(`sfu renegotiate failed: ${e.message}`);
    } finally {
      s.busy = false;
    }
  }

  async handle(user, msg) {
    const s = this.session(user);
    const pc = this.ensurePc(s);
    try {
      if (msg.type === 'sfu-offer') {
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.send(user, { type: 'sfu-answer', sdp: (pc.localDescription && pc.localDescription.sdp) || answer.sdp });
        s.offerSent = true;
        const queued = s.pending.splice(0);
        for (const candidate of queued) this.send(user, { type: 'sfu-candidate', candidate });
      } else if (msg.type === 'sfu-answer') {
        if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      } else if (msg.type === 'sfu-candidate' && msg.candidate) {
        // Candidates from an older ICE generation are expected during
        // renegotiation and can be dropped.
        try { await pc.addIceCandidate(msg.candidate); } catch (_) {}
      }
      if (s.pendingSync && pc.signalingState === 'stable') {
        s.pendingSync = false;
        await this.renegotiate(user, s);
      }
    } catch (e) {
      this.log(`sfu ${msg.type} failed: ${e.message}`);
    }
  }

  drop(user) {
    const s = this.sessions.get(user.id);
    if (!s) return;
    this.sessions.delete(user.id);
    try { if (s.pc) s.pc.close(); } catch (_) {}
    // Other sessions keep their senders but the publisher is gone; the client
    // removes the tile from presence, so nothing else to do here.
  }
}

module.exports = { Sfu };
