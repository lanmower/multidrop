// Browser transport for the GitHub Pages build. AnEntrypoint/wireweave carries
// presence and WebRTC signalling over nostr relays; file bytes go over its ordered
// data channel as JSON control frames plus binary chunks.
//
// Pairing: a 6-digit code names a short-lived pairing room. The host approves the
// joiner, then sends a zone secret over the encrypted data channel. A zone is a
// room that paired devices join on every page load, so they stay in it.
import { createWireweave } from "./vendor/wireweave/src/wireweave.js";
import { createDataSession } from "./vendor/wireweave/src/data.js";
import * as NostrTools from "nostr-tools";
import * as xstate from "xstate";

const NAMESPACE = "multidrop";
const RELAYS = [
  "wss://relay.primal.net",
  "wss://nos.lol",
  "wss://offchain.pub",
  "wss://nostr-pub.wellorder.net",
  "wss://relay.snort.social",
];
const ZONE_KEY = "multidrop-zone";
const CHUNK = 64 * 1024;                 // well under the message limit browsers accept
const MAX_BUFFERED = 4 * 1024 * 1024;    // pause sending while the channel is this full
const PAIR_TTL_MS = 5 * 60 * 1000;       // a shown code stops working after this
const PAIR_ACK_MS = 5000;                // host waits this long for the joiner's ack
const STALE_MS = 30000;                  // a peer that has not opened by then is dropped

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomUUID().slice(0, 12);
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || "file";
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (text) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
const zoneRoom = (secret) => sha256Hex(`zone:${secret}`);
const pairRoom = (code) => sha256Hex(`pair:${code}`);
const newZoneSecret = () => hex(crypto.getRandomValues(new Uint8Array(16)));

export const newPairCode = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));

export function loadZone() {
  try { return JSON.parse(localStorage.getItem(ZONE_KEY)); } catch { return null; }
}

function saveZone(zone) {
  if (zone) localStorage.setItem(ZONE_KEY, JSON.stringify(zone));
  else localStorage.removeItem(ZONE_KEY);
}

const MEMBER_FRESH_MS = 60000;           // do not rewrite a member's last-seen more often than this

// Paired devices are remembered with the zone, so they stay listed while offline.
function rememberMember(pk, name) {
  const zone = loadZone();
  if (!zone) return false;
  const members = zone.members || {};
  const now = Date.now();
  if (name === pk.slice(0, 8)) return false;              // wireweave's placeholder, not a real name
  const known = members[pk];
  if (known && known.name === name && now - known.seen < MEMBER_FRESH_MS) return false;
  members[pk] = { name, seen: now };
  saveZone({ ...zone, members });
  return true;
}

export function createWire({ alias, onEvent }) {
  // Relays that store and return kind-30078 events reliably (checked per relay);
  // the wireweave default list includes several that drop them.
  const ww = createWireweave({ nostrTools: NostrTools, xstate, relays: RELAYS });
  const data = ww.ensureData({ namespace: NAMESPACE });   // the zone session
  const emit = (ev) => onEvent(ev);

  const outgoing = new Map();        // job id -> {id, pubkey, info, files: [{fid, name, file}], state}
  const incoming = new Map();        // offer id -> {pubkey, files}
  const receiving = new Map();       // pubkey -> file currently arriving {id, fid, name, size, parts, got}
  const queues = new Map();          // pubkey -> tail of that peer's transfer queue
  const cancelled = new Set();
  let pairing = null;                // {session, role, peer, name, ttl, ack}

  // Names come straight from the device over the data channel (sent on connect and on
  // rename); wireweave's presence name is only a fallback, as it is set once per device.
  const names = new Map();
  const nameOf = (pk) =>
    names.get(pk) || data.participants.get("nostr-" + pk.slice(0, 12))?.identity || pk.slice(0, 8);
  const announceName = (pk) => {
    try { sendControl(pk, { k: "name", name: alias }); } catch { /* the peer is gone; it asks again on reconnect */ }
  };

  const sendControl = (pk, msg) => {
    if (!data.send(pk, JSON.stringify(msg))) throw new Error("device is not connected");
  };

  const drain = async (pk) => {
    for (;;) {
      const dc = data.peers.get(pk)?.dc;
      if (!dc || dc.readyState !== "open") throw new Error("device disconnected");
      if (dc.bufferedAmount <= MAX_BUFFERED) return;
      await sleep(25);
    }
  };

  const enqueue = (pk, task) => {
    const next = (queues.get(pk) || Promise.resolve()).then(task);
    queues.set(pk, next.catch(() => {}));
    return next;
  };

  async function transfer(job, files) {
    job.state = "running";
    try {
      for (const f of files) {
        sendControl(job.pubkey, { k: "file", id: job.id, fid: f.fid, name: f.name, size: f.file.size });
        let done = 0;
        for (let off = 0; off < f.file.size; off += CHUNK) {
          if (cancelled.has(job.id)) throw new Error("cancelled");
          await drain(job.pubkey);
          const buf = await f.file.slice(off, off + CHUNK).arrayBuffer();
          if (!data.send(job.pubkey, buf)) throw new Error("device disconnected");
          done += buf.byteLength;
          emit({ event: "progress", job: job.id, file: f.name, done, size: f.file.size });
        }
        sendControl(job.pubkey, { k: "end", id: job.id, fid: f.fid });
      }
      emit({ event: "job_done", job: job.id, info: job.info });
    } catch (e) {
      if (cancelled.has(job.id)) emit({ event: "job_cancelled", job: job.id });
      else emit({ event: "job_failed", job: job.id, error: e.message });
    } finally {
      outgoing.delete(job.id);
      cancelled.delete(job.id);
    }
  }

  function onControl(pk, msg) {
    switch (msg.k) {
      case "offer": {
        incoming.set(msg.id, { pubkey: pk, files: msg.files });
        const files = msg.files.map((f) => ({ id: f.id, name: baseName(f.name), size: f.size }));
        emit({ event: "offer", offer: {
          id: msg.id, from: msg.from || nameOf(pk), files,
          total_size: files.reduce((s, f) => s + f.size, 0),
        } });
        return;
      }
      case "accept": {
        const job = outgoing.get(msg.id);
        if (!job || job.pubkey !== pk) return;
        const chosen = job.files.filter((f) => msg.files.includes(f.fid));
        if (!chosen.length) { outgoing.delete(job.id); emit({ event: "job_failed", job: job.id, error: "nothing accepted" }); return; }
        enqueue(pk, () => transfer(job, chosen));
        return;
      }
      case "decline": {
        const job = outgoing.get(msg.id);
        if (!job || job.pubkey !== pk) return;
        outgoing.delete(msg.id);
        emit({ event: "job_failed", job: msg.id, error: "declined by receiver" });
        return;
      }
      case "file":
        receiving.set(pk, { id: msg.id, fid: msg.fid, name: baseName(msg.name), size: msg.size, parts: [], got: 0 });
        return;
      case "end": {
        const rx = receiving.get(pk);
        receiving.delete(pk);
        if (!rx || rx.fid !== msg.fid) return;
        const blob = new Blob(rx.parts, { type: "application/octet-stream" });
        emit({ event: "file_received", from: nameOf(pk), file: rx.name, size: blob.size, url: URL.createObjectURL(blob) });
        return;
      }
      case "name": {
        const name = typeof msg.name === "string" ? msg.name.trim().slice(0, 40) : "";
        if (!name) return;
        names.set(pk, name);
        rememberMember(pk, name);
        emit({ event: "devices" });
        return;
      }
      case "text":
        emit({ event: "message", from: nameOf(pk), kind: /^https?:\/\//i.test(msg.text) ? "url" : "text", text: msg.text });
        return;
      case "cancel":
        incoming.delete(msg.id);
        if (receiving.get(pk)?.id === msg.id) receiving.delete(pk);
        emit({ event: "offer_withdrawn", id: msg.id });
        return;
    }
  }

  function onChunk(pk, buf) {
    const rx = receiving.get(pk);
    if (!rx) return;
    rx.parts.push(buf);
    rx.got += buf.byteLength;
    if (rx.got > rx.size) {
      receiving.delete(pk);
      emit({ event: "error", message: `${rx.name}: more data than announced` });
    }
  }

  data.addEventListener("data", (e) => {
    const { peerPubkey: pk, data: payload } = e.detail;
    if (typeof payload !== "string") { onChunk(pk, payload); return; }
    let msg;
    try { msg = JSON.parse(payload); } catch { return; }
    onControl(pk, msg);
  });

  data.addEventListener("connected", () => emit({ event: "connected" }));
  data.addEventListener("participants", () => emit({ event: "devices" }));
  data.addEventListener("error", (e) => emit({ event: "error", message: e.detail.message }));
  data.addEventListener("peer-open", (e) => {
    if (e.detail.unreliable) return;
    announceName(e.detail.peerPubkey);
    emit({ event: "devices" });
  });
  data.addEventListener("peer-close", (e) => {
    const pk = e.detail.peerPubkey;
    if (e.detail.unreliable) return;
    for (const [id, o] of incoming) if (o.pubkey === pk) { incoming.delete(id); emit({ event: "offer_withdrawn", id }); }
    for (const job of outgoing.values()) {
      if (job.pubkey !== pk) continue;
      cancelled.add(job.id);
      outgoing.delete(job.id);
      emit({ event: "job_failed", job: job.id, error: "connection closed" });
    }
    receiving.delete(pk);
    emit({ event: "devices" });
  });

  function onlineDevices() {
    return [...data.peers.keys()]
      .filter((pk) => data.peers.get(pk).dc?.readyState === "open")
      .map((pk) => ({ pubkey: pk, name: nameOf(pk) }));
  }

  function startJob(pk, info, files) {
    const job = { id: newId(), pubkey: pk, info, files, state: "waiting" };
    outgoing.set(job.id, job);
    emit({ event: "job_started", job: job.id, info });
    return job;
  }

  // -- zone: paired devices share one room and stay in it -------------------

  // A device that reloads can leave a half-open peer behind on the other side.
  // wireweave keeps that entry, so its presence heartbeats never reconnect the
  // device. Drop any peer that has not opened within STALE_MS; the next heartbeat
  // then reconnects it. Uses wireweave's internal _closePeer, pinned with the submodule.
  const staleSince = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const pk of Array.from(data.peers.keys())) {
      if (data.peers.get(pk).dc?.readyState === "open") { staleSince.delete(pk); continue; }
      const since = staleSince.get(pk) ?? now;
      staleSince.set(pk, since);
      if (now - since > STALE_MS) { staleSince.delete(pk); data._closePeer(pk); }
    }
  }, 10000);

  async function joinZone(secret) {
    await data.disconnect();
    await data.connect(await zoneRoom(secret), { displayName: alias });
  }

  // -- pairing: a short-lived room per code, host approves the joiner -------

  function closePairing() {
    const p = pairing;
    if (!p) return;
    pairing = null;
    clearTimeout(p.ttl);
    clearTimeout(p.ack);
    p.session.disconnect().catch(() => {});
  }

  function onPairMessage(p, pk, raw) {
    if (typeof raw !== "string") return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.k === "hello") {
      if (p.peer) return;                       // one device per pairing code
      p.peer = pk;
      p.name = msg.name;
      emit(p.role === "host"
        ? { event: "pair_request", name: msg.name }
        : { event: "pair_waiting", name: msg.name });
      return;
    }
    if (pk !== p.peer) return;
    if (msg.k === "zone" && p.role === "joiner") {
      p.paired = true;                          // the close that follows is not a lost connection
      saveZone({ secret: msg.secret, host: msg.host, joined: Date.now() });
      rememberMember(pk, msg.host);
      p.session.send(pk, JSON.stringify({ k: "paired" }));
      emit({ event: "paired", name: msg.host });
      joinZone(msg.secret).catch((e) => emit({ event: "error", message: `zone: ${e.message}` }));
      setTimeout(() => { if (pairing === p) closePairing(); }, 1000);
    } else if (msg.k === "paired" && p.role === "host") {
      p.paired = true;
      emit({ event: "pair_done", name: p.name });
      closePairing();
    } else if (msg.k === "declined" && p.role === "joiner") {
      emit({ event: "pair_declined" });
      closePairing();
    }
  }

  async function openPairing(code, role) {
    closePairing();
    const session = createDataSession({ fsm: ww.fsm, xstate, relayPool: ww.pool, auth: ww.auth, namespace: NAMESPACE });
    const p = { session, role, peer: null, name: "", ttl: null, ack: null };
    pairing = p;
    p.ttl = setTimeout(() => { if (pairing === p) { closePairing(); emit({ event: "pair_expired" }); } }, PAIR_TTL_MS);
    session.addEventListener("peer-open", (e) => {
      if (e.detail.unreliable || pairing !== p) return;
      session.send(e.detail.peerPubkey, JSON.stringify({ k: "hello", name: alias, role }));
    });
    session.addEventListener("data", (e) => onPairMessage(p, e.detail.peerPubkey, e.detail.data));
    session.addEventListener("peer-close", (e) => {
      if (pairing === p && !p.paired && !e.detail.unreliable && e.detail.peerPubkey === p.peer) emit({ event: "pair_lost" });
    });
    try {
      await session.connect(await pairRoom(code), { displayName: alias });
    } catch (e) {
      if (pairing === p) closePairing();
      emit({ event: "error", message: `pairing: ${e.message}` });
    }
  }

  async function answerPair(accept) {
    const p = pairing;
    if (!p || p.role !== "host" || !p.peer) return;
    if (!accept) {
      p.session.send(p.peer, JSON.stringify({ k: "declined" }));
      closePairing();
      emit({ event: "pair_declined" });
      return;
    }
    const zone = loadZone() || { secret: newZoneSecret(), host: alias, joined: Date.now() };
    saveZone(zone);
    rememberMember(p.peer, p.name);
    p.session.send(p.peer, JSON.stringify({ k: "zone", secret: zone.secret, host: alias }));
    p.ack = setTimeout(() => { if (pairing === p) { emit({ event: "pair_done", name: p.name }); closePairing(); } }, PAIR_ACK_MS);
    await joinZone(zone.secret);
  }

  return {
    pubkey: () => ww.auth.pubkey,

    async join() {
      ww.auth.loadFromStorage() || ww.auth.generateKey();
      ww.pool.connect();
      const zone = loadZone();
      if (zone) await joinZone(zone.secret);
    },

    leave() {
      closePairing();
      return data.disconnect();
    },

    zone: loadZone,

    async leaveZone() {
      closePairing();
      saveZone(null);
      await data.disconnect();
      emit({ event: "devices" });
    },

    openPairing,
    closePairing,
    answerPair,

    devices: onlineDevices,

    // Every paired device, online or not, as if it were in the room.
    members() {
      const out = new Map();
      for (const [pk, m] of Object.entries(loadZone()?.members || {})) {
        out.set(pk, { pubkey: pk, name: m.name, online: false, seen: m.seen });
      }
      for (const d of onlineDevices()) {
        const remembered = out.get(d.pubkey)?.name;
        const name = d.name === d.pubkey.slice(0, 8) && remembered ? remembered : d.name;
        out.set(d.pubkey, { pubkey: d.pubkey, name, online: true, seen: Date.now() });
        rememberMember(d.pubkey, name);
      }
      return [...out.values()];
    },

    // Changes the name other devices see: told to every connected device at once,
    // and used for later presence and pairing messages.
    setAlias(name) {
      alias = name;
      data.displayName = name;
      for (const d of onlineDevices()) announceName(d.pubkey);
    },

    sendFiles(pk, entries, label) {
      const files = entries.map((e, i) => ({ fid: String(i), name: e.path, file: e.file }));
      const job = startJob(pk, { items: files.map((f) => f.name), to: label }, files);
      try {
        sendControl(pk, { k: "offer", id: job.id, from: alias, files: files.map((f) => ({ id: f.fid, name: f.name, size: f.file.size })) });
      } catch (e) {
        outgoing.delete(job.id);
        emit({ event: "job_failed", job: job.id, error: e.message });
      }
      return job.id;
    },

    sendText(pk, text, label) {
      const job = startJob(pk, { items: [text.slice(0, 60)], to: label }, []);
      outgoing.delete(job.id);
      try {
        sendControl(pk, { k: "text", text });
        emit({ event: "job_done", job: job.id, info: job.info });
      } catch (e) {
        emit({ event: "job_failed", job: job.id, error: e.message });
      }
    },

    answer(id, accept, fileIds = []) {
      const offer = incoming.get(id);
      if (!offer) return;
      incoming.delete(id);
      try {
        sendControl(offer.pubkey, accept && fileIds.length ? { k: "accept", id, files: fileIds } : { k: "decline", id });
      } catch (e) {
        emit({ event: "error", message: `answer failed: ${e.message}` });
      }
    },

    cancel(id) {
      const job = outgoing.get(id);
      if (!job) return;
      cancelled.add(id);
      try { sendControl(job.pubkey, { k: "cancel", id }); } catch {}
      if (job.state === "waiting") {
        outgoing.delete(id);
        cancelled.delete(id);
        emit({ event: "job_cancelled", job: id });
      }
    },
  };
}
