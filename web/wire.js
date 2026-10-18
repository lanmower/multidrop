// Browser transport for the MultiDrop web app and its desktop launcher.
// AnEntrypoint/wireweave carries presence and WebRTC signalling over nostr relays;
// file bytes go over its ordered data channel as JSON control frames plus binary chunks.
//
// Two links run side by side:
//   zone    - paired devices share a secret, so they find each other from anywhere.
//   nearby  - devices behind the same public address (the same router, Wi-Fi or
//             office) find each other without pairing. ICE learns that address from
//             a STUN server, so no server of ours is involved. Like AirDrop, nearby
//             devices are visible; every transfer from them still needs an accept.
//
// Pairing: a 6-digit code names a short-lived pairing room. The host approves the
// joiner, then sends a zone secret over the encrypted data channel.
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
const STUN = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun.cloudflare.com:3478" }];
const ZONE_KEY = "multidrop-zone";
const CHUNK = 64 * 1024;                 // well under the message limit browsers accept
const WINDOW = 8 * CHUNK;                // unacknowledged bytes a sender may have in flight
const MAX_BUFFERED = 4 * 1024 * 1024;    // pause sending while the channel is this full
const PAIR_TTL_MS = 5 * 60 * 1000;       // a shown code stops working after this
const PAIR_ACK_MS = 5000;                // host waits this long for the joiner's ack
const STALE_MS = 30000;                  // a peer that has not opened by then is dropped
const NETWORK_CHECK_MS = 120000;         // re-read the network address this often
const MEMBER_FRESH_MS = 60000;           // do not rewrite a member's last-seen more often than this

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const newId = () => crypto.randomUUID().slice(0, 12);
const baseName = (p) => p.split(/[\\/]/).filter(Boolean).pop() || "file";
const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
const sha256Hex = async (text) =>
  hex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))));
const zoneRoom = (secret) => sha256Hex(`zone:${secret}`);
const nearbyRoom = (networkKey) => sha256Hex(`net:${networkKey}`);
const pairRoom = (code) => sha256Hex(`pair:${code}`);
const newZoneSecret = () => hex(crypto.getRandomValues(new Uint8Array(16)));

export const newPairCode = () => String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));

// Receiving streams straight to a folder the user picks (File System Access API);
// nothing is held in memory or stored on the page. Chromium-based browsers only.
export const canReceiveToFolder = () => typeof window.showDirectoryPicker === "function";

// A name that is free in the folder: "photo.jpg", then "photo (1).jpg", and so on.
async function freeFileHandle(dir, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let i = 0; ; i++) {
    const candidate = i ? `${stem} (${i})${ext}` : name;
    try {
      await dir.getFileHandle(candidate);
    } catch (e) {
      if (e.name === "NotFoundError") return dir.getFileHandle(candidate, { create: true });
      throw e;
    }
  }
}

export function loadZone() {
  try { return JSON.parse(localStorage.getItem(ZONE_KEY)); } catch { return null; }
}

function saveZone(zone) {
  if (zone) localStorage.setItem(ZONE_KEY, JSON.stringify(zone));
  else localStorage.removeItem(ZONE_KEY);
}

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

// The public address this network shows the internet, as a STUN server reports it.
// Devices on the same router report the same address. Null when STUN cannot be reached.
// `?network=` overrides it for testing two devices on one machine.
async function networkKey() {
  const forced = new URLSearchParams(location.search).get("network");
  if (forced) return forced;
  if (typeof RTCPeerConnection === "undefined") return null;
  return new Promise((resolve) => {
    const pc = new RTCPeerConnection({ iceServers: STUN });
    let found = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.close();
      resolve(found);
    };
    pc.onicecandidate = (e) => {
      if (!e.candidate) return finish();
      if (e.candidate.type === "srflx" && !found) {
        found = e.candidate.address || e.candidate.candidate.split(" ")[4];
      }
    };
    pc.createDataChannel("probe");
    pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(finish);
    setTimeout(finish, 4000);
  });
}

export function createWire({ alias, onEvent }) {
  // Relays that store and return kind-30078 events reliably (checked per relay);
  // the wireweave default list includes several that drop them.
  const ww = createWireweave({ nostrTools: NostrTools, xstate, relays: RELAYS });
  const zone = ww.ensureData({ namespace: NAMESPACE });
  const nearby = createDataSession({ fsm: ww.fsm, xstate, relayPool: ww.pool, auth: ww.auth, namespace: NAMESPACE });
  const links = [zone, nearby];
  const emit = (ev) => onEvent(ev);

  const outgoing = new Map();        // job id -> {id, pubkey, info, files: [{fid, name, file}], state, acked}
  const incoming = new Map();        // offer id -> {pubkey, files}, waiting for our answer
  const accepted = new Map();        // offer id -> {pubkey, dir, fileIds}, answered yes
  const receiving = new Map();       // pubkey -> file being written {id, fid, name, size, got, written, writable, queue}
  const queues = new Map();          // pubkey -> tail of that peer's transfer queue
  const cancelled = new Set();
  const names = new Map();           // pubkey -> name the device sent over the data channel
  let pairing = null;                // {session, role, peer, name, ttl, ack}
  let networkKeyValue = null;
  let networkState = "checking";     // checking | on | unavailable

  // The link a device is reachable on right now (zone first, then nearby).
  const linkOf = (pk) => links.find((s) => s.peers.get(pk)?.dc?.readyState === "open") || null;
  const dcOf = (pk) => linkOf(pk)?.peers.get(pk)?.dc || null;
  const nameOf = (pk) =>
    names.get(pk)
    || links.map((s) => s.participants.get("nostr-" + pk.slice(0, 12))?.identity).find(Boolean)
    || pk.slice(0, 8);

  const sendControl = (pk, msg) => {
    const s = linkOf(pk);
    if (!s || !s.send(pk, JSON.stringify(msg))) throw new Error("device is not connected");
  };
  const sendRaw = (pk, buf) => {
    const s = linkOf(pk);
    if (!s || !s.send(pk, buf)) throw new Error("device disconnected");
  };
  const announceName = (pk) => {
    try { sendControl(pk, { k: "name", name: alias }); } catch { /* the peer is gone; it asks again on reconnect */ }
  };

  const assertOpen = (pk) => {
    if (!dcOf(pk)) throw new Error("device disconnected");
  };

  const drain = async (pk) => {
    for (;;) {
      const dc = dcOf(pk);
      if (!dc) throw new Error("device disconnected");
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
          // Flow control: stop while too much is unacknowledged, so a slow disk
          // on the receiving side never has to buffer the rest of the file.
          while (done - (job.acked.get(f.fid) || 0) >= WINDOW) {
            if (cancelled.has(job.id)) throw new Error("cancelled");
            assertOpen(job.pubkey);
            await sleep(10);
          }
          const buf = await f.file.slice(off, off + CHUNK).arrayBuffer();
          sendRaw(job.pubkey, buf);
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
          id: msg.id, from: msg.from || nameOf(pk), pubkey: pk, files,
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
      case "ack": {
        const job = outgoing.get(msg.id);
        if (!job || job.pubkey !== pk) return;
        job.acked.set(msg.fid, Math.max(job.acked.get(msg.fid) || 0, msg.n));
        return;
      }
      case "file": {
        const acc = accepted.get(msg.id);
        if (!acc || acc.pubkey !== pk || !acc.fileIds.includes(msg.fid)) return;
        const rx = { id: msg.id, fid: msg.fid, name: baseName(msg.name), size: msg.size, got: 0, written: 0, error: null };
        rx.queue = (async () => {
          try {
            const handle = await freeFileHandle(acc.dir, rx.name);
            rx.writable = await handle.createWritable();
          } catch (e) { rx.error = e; }
        })();
        receiving.set(pk, rx);
        return;
      }
      case "end": {
        const rx = receiving.get(pk);
        if (!rx || rx.fid !== msg.fid) return;
        receiving.delete(pk);
        rx.queue = rx.queue.then(async () => {
          if (rx.error) throw rx.error;
          if (rx.written !== rx.size) throw new Error("incomplete");
          await rx.writable.close();
          emit({ event: "file_saved", from: nameOf(pk), file: rx.name, size: rx.size });
        }).catch((e) => failReceive(pk, rx, e));
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
      case "cancel": {
        // The receiver stopped a file we were sending.
        const job = outgoing.get(msg.id);
        if (job && job.pubkey === pk && !cancelled.has(job.id)) {
          cancelled.add(job.id);
          outgoing.delete(job.id);
          emit({ event: "job_failed", job: job.id, error: "receiver stopped" });
        }
        // The sender cancelled: drop the offer or the file being written.
        incoming.delete(msg.id);
        accepted.delete(msg.id);
        const rx = receiving.get(pk);
        if (rx?.id === msg.id) { receiving.delete(pk); abortReceive(rx); }
        emit({ event: "offer_withdrawn", id: msg.id });
        return;
      }
    }
  }

  function abortReceive(rx) {
    rx.writable?.abort().catch(() => {});                // a partial file is discarded
  }

  function failReceive(pk, rx, e) {
    if (receiving.get(pk) === rx) receiving.delete(pk);
    abortReceive(rx);
    try { sendControl(pk, { k: "cancel", id: rx.id }); } catch {}
    emit({ event: "error", message: `${rx.name}: ${e.message || e}` });
  }

  function onChunk(pk, buf) {
    const rx = receiving.get(pk);
    if (!rx) return;
    rx.got += buf.byteLength;
    if (rx.got > rx.size) {
      receiving.delete(pk);
      abortReceive(rx);
      emit({ event: "error", message: `${rx.name}: more data than announced` });
      return;
    }
    // Written in arrival order; each write is acknowledged so the sender can go on.
    rx.queue = rx.queue.then(async () => {
      if (rx.error) throw rx.error;
      await rx.writable.write(buf);
      rx.written += buf.byteLength;
      sendControl(pk, { k: "ack", id: rx.id, fid: rx.fid, n: rx.written });
    }).catch((e) => failReceive(pk, rx, e));
  }

  // A device that left (on any link) drops its offers, jobs and files in progress.
  function dropPeer(pk) {
    for (const [id, o] of incoming) if (o.pubkey === pk) { incoming.delete(id); emit({ event: "offer_withdrawn", id }); }
    for (const job of outgoing.values()) {
      if (job.pubkey !== pk) continue;
      cancelled.add(job.id);
      outgoing.delete(job.id);
      emit({ event: "job_failed", job: job.id, error: "connection closed" });
    }
    const rx = receiving.get(pk);
    if (rx) { receiving.delete(pk); abortReceive(rx); }
    for (const [id, a] of accepted) if (a.pubkey === pk) accepted.delete(id);
  }

  function attach(session) {
    session.addEventListener("data", (e) => {
      const { peerPubkey: pk, data: payload } = e.detail;
      if (typeof payload !== "string") { onChunk(pk, payload); return; }
      let msg;
      try { msg = JSON.parse(payload); } catch { return; }
      onControl(pk, msg);
    });
    session.addEventListener("participants", () => emit({ event: "devices" }));
    session.addEventListener("error", (e) => emit({ event: "error", message: e.detail.message }));
    session.addEventListener("peer-open", (e) => {
      if (e.detail.unreliable) return;
      announceName(e.detail.peerPubkey);
      emit({ event: "devices" });
    });
    session.addEventListener("peer-close", (e) => {
      const pk = e.detail.peerPubkey;
      if (e.detail.unreliable || linkOf(pk)) return;      // still reachable on the other link
      dropPeer(pk);
      emit({ event: "devices" });
    });
    // A device that reloads can leave a half-open peer behind on the other side.
    // wireweave keeps that entry, so its presence heartbeats never reconnect the
    // device. Drop any peer that has not opened within STALE_MS; the next heartbeat
    // then reconnects it. Uses wireweave's internal _closePeer, pinned with the submodule.
    const staleSince = new Map();
    setInterval(() => {
      const now = Date.now();
      for (const pk of Array.from(session.peers.keys())) {
        if (session.peers.get(pk).dc?.readyState === "open") { staleSince.delete(pk); continue; }
        const since = staleSince.get(pk) ?? now;
        staleSince.set(pk, since);
        if (now - since > STALE_MS) { staleSince.delete(pk); session._closePeer(pk); }
      }
    }, 10000);
  }
  links.forEach(attach);

  zone.addEventListener("connected", () => emit({ event: "connected" }));

  function startJob(pk, info, files) {
    const job = { id: newId(), pubkey: pk, info, files, state: "waiting", acked: new Map() };
    outgoing.set(job.id, job);
    emit({ event: "job_started", job: job.id, info });
    return job;
  }

  function onlineDevices() {
    const seen = new Map();
    for (const s of links) {
      for (const pk of s.peers.keys()) {
        if (seen.has(pk) || !linkOf(pk)) continue;
        seen.set(pk, { pubkey: pk, name: nameOf(pk), online: true });
      }
    }
    return [...seen.values()];
  }

  // -- zone: paired devices share one room and stay in it -------------------

  async function joinZone(secret) {
    await zone.disconnect();
    await zone.connect(await zoneRoom(secret), { displayName: alias });
  }

  // -- nearby: devices behind the same public address ------------------------

  async function refreshNetwork() {
    const key = await networkKey();
    if (key === networkKeyValue && networkState !== "checking") return;
    networkKeyValue = key;
    if (key) {
      networkState = "on";
      await nearby.disconnect();
      await nearby.connect(await nearbyRoom(key), { displayName: alias });
    } else {
      networkState = "unavailable";
      await nearby.disconnect();
    }
    emit({ event: "network", state: networkState });
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
    const z = loadZone() || { secret: newZoneSecret(), host: alias, joined: Date.now() };
    saveZone(z);
    rememberMember(p.peer, p.name);
    p.session.send(p.peer, JSON.stringify({ k: "zone", secret: z.secret, host: alias }));
    p.ack = setTimeout(() => { if (pairing === p) { emit({ event: "pair_done", name: p.name }); closePairing(); } }, PAIR_ACK_MS);
    await joinZone(z.secret);
  }

  return {
    pubkey: () => ww.auth.pubkey,

    async join() {
      ww.auth.loadFromStorage() || ww.auth.generateKey();
      ww.pool.connect();
      const z = loadZone();
      await Promise.all([z ? joinZone(z.secret) : null, refreshNetwork()]);
      setInterval(() => refreshNetwork().catch(() => {}), NETWORK_CHECK_MS);
    },

    leave() {
      closePairing();
      return Promise.all([zone.disconnect(), nearby.disconnect()]);
    },

    zone: loadZone,

    async leaveZone() {
      closePairing();
      saveZone(null);
      await zone.disconnect();
      emit({ event: "devices" });
    },

    openPairing,
    closePairing,
    answerPair,

    network: () => networkState,

    // Every paired device, online or not, as if it were in the room.
    members() {
      const out = new Map();
      for (const [pk, m] of Object.entries(loadZone()?.members || {})) {
        out.set(pk, { pubkey: pk, name: m.name, online: false, seen: m.seen });
      }
      for (const d of onlineDevices()) {
        const entry = out.get(d.pubkey);
        if (!entry) continue;
        const name = d.name === d.pubkey.slice(0, 8) && entry.name ? entry.name : d.name;
        out.set(d.pubkey, { pubkey: d.pubkey, name, online: true, seen: Date.now() });
        rememberMember(d.pubkey, name);
      }
      return [...out.values()];
    },

    // Devices on this network that are not paired: visible, accept each transfer.
    nearby() {
      const members = loadZone()?.members || {};
      return onlineDevices().filter((d) => !members[d.pubkey]);
    },

    // Changes the name other devices see: told to every connected device at once,
    // and republished by reconnecting the links.
    async setAlias(name) {
      alias = name;
      for (const d of onlineDevices()) announceName(d.pubkey);
      const z = loadZone();
      if (z) await joinZone(z.secret);
      if (networkKeyValue) await refreshNetwork();
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

    // dir: the folder the files are streamed into (a FileSystemDirectoryHandle).
    answer(id, accept, fileIds = [], dir = null) {
      const offer = incoming.get(id);
      if (!offer) return;
      incoming.delete(id);
      const yes = accept && fileIds.length && dir;
      if (yes) accepted.set(id, { pubkey: offer.pubkey, dir, fileIds });
      try {
        sendControl(offer.pubkey, yes ? { k: "accept", id, files: fileIds } : { k: "decline", id });
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
