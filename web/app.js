// MultiDrop web build (GitHub Pages). The same screens as daemon/web/app.js,
// on AnEntrypoint/wireweave instead of the local daemon. Peer-supplied strings
// (device and file names, texts) are always inserted as text, never as HTML.
import { createWire, newPairCode, loadZone } from "./wire.js";
import qrcode from "qrcode-generator";

const $ = (sel) => document.querySelector(sel);
const LS_ALIAS = "multidrop-alias";
const jobs = new Map();        // job id -> {info, files: Map(name -> {done,size}), state, error}
const unchecked = new Map();   // offer id -> Set of file ids the user unticked
let offers = [];               // incoming offers, oldest first
let pendingPair = null;        // {name} while a joiner waits for approval (host side)
let devices = [];              // devices online in this zone
let wire = null;
let alias = "";

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) e.append(c instanceof Node ? c : String(c ?? ""));
  return e;
}

function human(n) {
  if (n === null || n === undefined) return "size unknown";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return i ? `${n.toFixed(1)} ${units[i]}` : `${n} B`;
}

function randomId(n, alphabet = "abcdefghjkmnpqrstuvwxyz23456789") {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => alphabet[b % alphabet.length]).join("");
}

function aliasName() {
  let name = localStorage.getItem(LS_ALIAS);
  if (!name) { name = `Browser ${randomId(4, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789")}`; localStorage.setItem(LS_ALIAS, name); }
  return name;
}

const spaced = (code) => `${code.slice(0, 3)} ${code.slice(3)}`;
const pageUrl = (params) => `${location.origin}${location.pathname}${params}`;

function showStatus(text) {
  $("#status").textContent = text;
}

// -- pairing --------------------------------------------------------------

function showPairState(text) {
  $("#pair-state").textContent = text;
}

function renderPairRequest() {
  const box = $("#pair-requests");
  box.replaceChildren();
  if (!pendingPair) return;
  box.append(el("div", { class: "card offer" },
    el("div", { class: "name" }, `${pendingPair.name} wants to pair with this device`),
    el("div", { class: "meta" }, "Accept only a device you can see in front of you."),
    el("div", { class: "row" },
      el("button", { class: "primary", type: "button", onclick: () => answerPair(true) }, "Accept"),
      el("button", { class: "danger", type: "button", onclick: () => answerPair(false) }, "Decline"))));
}

function answerPair(accept) {
  pendingPair = null;
  renderPairRequest();
  wire.answerPair(accept);
  if (accept) showPairState("Pairing …");
}

function showHostCode() {
  const code = newPairCode();
  const url = pageUrl(`#pair=${code}`);
  $("#pair-code-show").textContent = spaced(code);
  $("#pair-url").textContent = url;
  $("#pair-url").href = url;
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const svg = new DOMParser().parseFromString(qr.createSvgTag(4, 2), "image/svg+xml");
  $("#pair-qr").replaceChildren(document.importNode(svg.documentElement, true));
  $("#pair-host").hidden = false;
  showPairState("Waiting for the other device to enter this code …");
  wire.openPairing(code, "host");
}

function hideHostCode() {
  $("#pair-host").hidden = true;
  wire.closePairing();
}

function joinWithCode(raw) {
  const code = String(raw).replace(/\D/g, "");
  if (code.length !== 6) { showPairState("Enter the 6-digit code shown on the other device."); return; }
  showPairState("Connecting …");
  wire.openPairing(code, "joiner");
}

function renderZoneState() {
  const zone = loadZone();
  $("#leave-zone").hidden = !zone;
  if ($("#pair-state").textContent) return;
  showPairState(zone
    ? `Paired${zone.host ? ` via ${zone.host}` : ""}. This device stays in your zone.`
    : "Not paired yet. Show a code here, or enter the code from another device.");
}

// -- status, offers -------------------------------------------------------

function renderOffers() {
  const box = $("#offers");
  box.replaceChildren();
  $("#offers-section").hidden = offers.length === 0;
  for (const o of offers) {
    const selectable = o.files.length > 1;
    const off = unchecked.get(o.id) || new Set();
    unchecked.set(o.id, off);
    const items = el("ul", { class: selectable ? "files selectable" : "files" });
    for (const f of o.files) {
      const label = `${f.name} (${human(f.size)})`;
      if (!selectable) { items.append(el("li", {}, label)); continue; }
      const cb = el("input", { type: "checkbox", "data-file": f.id, onchange: (ev) => {
        if (ev.target.checked) off.delete(f.id); else off.add(f.id);
      } });
      cb.checked = !off.has(f.id);
      items.append(el("li", {}, el("label", {}, cb, " ", label)));
    }
    const answer = (accept, ids) => {
      wire.answer(o.id, accept, ids);
      offers = offers.filter((x) => x.id !== o.id);
      unchecked.delete(o.id);
      renderOffers();
    };
    const everyFile = o.files.map((f) => f.id);
    const chosen = () => everyFile.filter((id) => !off.has(id));
    box.append(el("div", { class: "card offer" },
      el("div", { class: "name" }, `${o.from} wants to send`),
      el("div", { class: "meta" }, `Browser (WebRTC) · ${human(o.total_size)}`),
      items,
      el("div", { class: "row" },
        el("button", { class: "primary", type: "button", onclick: () => answer(true, everyFile) },
           selectable ? "Accept all" : "Accept"),
        selectable ? el("button", { type: "button", "data-action": "accept-selected", onclick: () => {
          const ids = chosen();
          if (ids.length) answer(true, ids); else answer(false);
        } }, "Accept selected") : "",
        el("button", { class: "danger", type: "button", onclick: () => answer(false) }, "Decline"))));
  }
}

// -- devices and sending --------------------------------------------------

function refreshDevices() {
  devices = wire ? wire.devices() : [];
  renderDevices();
}

function renderDevices() {
  const box = $("#devices");
  box.replaceChildren();
  const select = $("#text-target");
  const previous = select.value;
  select.replaceChildren();
  for (const d of devices) {
    const card = el("div", { class: "card drop" },
      el("div", { class: "name" }, d.name),
      el("div", { class: "meta" }, "Browser (WebRTC)"),
      el("span", { class: "badge" }, "WebRTC"));
    makeDropTarget(card, (files) => sendFiles(d, files));
    box.append(card);
    select.append(el("option", { value: d.pubkey }, d.name));
  }
  if (previous) select.value = previous;
  if (!devices.length) {
    box.append(el("p", { class: "hint" }, loadZone()
      ? "No paired device is online right now. Paired devices appear here whenever their page is open."
      : "No paired devices yet. Pair one with a code or QR above."));
  }
}

function makeDropTarget(card, onFiles) {
  card.addEventListener("dragover", (ev) => { ev.preventDefault(); card.classList.add("over"); });
  card.addEventListener("dragleave", () => card.classList.remove("over"));
  card.addEventListener("drop", async (ev) => {
    ev.preventDefault();
    card.classList.remove("over");
    const files = await filesFromDrop(ev.dataTransfer);
    if (files.length) onFiles(files);
  });
  card.addEventListener("click", () => {
    const input = $("#pick-files");
    input.value = "";
    input.onchange = () => {
      const files = [...input.files].map((f) => ({ file: f, path: f.name }));
      if (files.length) onFiles(files);
    };
    input.click();
  });
}

// Folders arrive as directory entries; walk them to keep relative paths.
async function filesFromDrop(dt) {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
  if (!entries.length) return [...dt.files].map((f) => ({ file: f, path: f.name }));
  const out = [];
  async function walk(entry, prefix) {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  }
  for (const e of entries) await walk(e, "");
  return out;
}

function sendFiles(device, files) {
  const total = files.reduce((s, f) => s + f.file.size, 0);
  addLog(`Handing over ${files.length} file(s), ${human(total)} to ${device.name} …`);
  try {
    wire.sendFiles(device.pubkey, files, device.name);
  } catch (e) {
    addLog(`Sending to ${device.name} failed: ${e.message}`);
  }
}

// -- jobs -----------------------------------------------------------------

function renderJobs() {
  const box = $("#jobs");
  box.replaceChildren();
  const list = [...jobs.entries()].reverse().slice(0, 10);
  if (!list.length) box.append(el("p", { class: "hint" }, "Nothing sent yet."));
  for (const [id, j] of list) {
    let done = 0, size = 0;
    for (const f of j.files.values()) { done += f.done; size += f.size; }
    const label = { running: "running", waiting: "waiting for acceptance", done: "done",
                    failed: "failed", cancelled: "cancelled" }[j.state] || j.state;
    const row = el("div", { class: `job card ${j.state}` },
      el("span", { class: "what" }, `${j.info.items.join(", ")} → ${j.info.to}`),
      size ? el("progress", { max: size, value: done }) : "",
      el("span", { class: "state" }, j.error ? `${label}: ${j.error}` : label));
    if (["running", "waiting"].includes(j.state)) {
      row.append(el("button", { type: "button", onclick: () => wire.cancel(id) }, "Cancel"));
    }
    box.append(row);
  }
}

function onJobEvent(ev) {
  if (ev.event === "job_started") {
    jobs.set(ev.job, { info: ev.info, files: new Map(), state: "waiting" });
    if (jobs.size > 50) jobs.delete(jobs.keys().next().value);
  }
  const j = jobs.get(ev.job);
  if (!j) return;
  switch (ev.event) {
    case "progress": j.state = "running"; j.files.set(ev.file, { done: ev.done, size: ev.size }); break;
    case "job_done": j.state = "done"; break;
    case "job_failed": j.state = "failed"; j.error = ev.error; break;
    case "job_cancelled": j.state = "cancelled"; break;
  }
  renderJobs();
}

// -- events and history ---------------------------------------------------

function addLog(content) {
  const log = $("#log");
  log.prepend(el("li", {}, el("time", {}, new Date().toLocaleTimeString()), content));
  while (log.children.length > 200) log.lastChild.remove();
}

function onEvent(ev) {
  switch (ev.event) {
    case "connected":
      showStatus(`Ready – visible as “${alias}”`);
      break;
    case "devices":
      refreshDevices();
      renderZoneState();
      break;
    case "pair_waiting":
      showPairState(`Connected to ${ev.name}. Waiting for it to accept …`);
      break;
    case "pair_request":
      pendingPair = { name: ev.name };
      renderPairRequest();
      addLog(`${ev.name} asked to pair`);
      break;
    case "paired":
      $("#pair-code").value = "";
      showPairState(`Paired with ${ev.name}. This device stays in your zone.`);
      renderZoneState();
      addLog(`Paired with ${ev.name}`);
      break;
    case "pair_done":
      hideHostCode();
      showPairState(`Paired with ${ev.name || "the other device"}. Devices stay in your zone.`);
      renderZoneState();
      addLog(`Paired with ${ev.name || "a device"}`);
      break;
    case "pair_declined":
      hideHostCode();
      pendingPair = null;
      renderPairRequest();
      showPairState("Pairing declined.");
      break;
    case "pair_expired":
      hideHostCode();
      showPairState("The code expired. Show a new one to pair.");
      break;
    case "pair_lost":
      showPairState("Connection to the other device was lost. Try again.");
      break;
    case "offer":
      offers.push(ev.offer);
      renderOffers();
      addLog(`${ev.offer.from} wants to send ${ev.offer.files.length} item(s)`);
      break;
    case "offer_withdrawn":
      offers = offers.filter((o) => o.id !== ev.id);
      renderOffers();
      break;
    case "file_received":
      addLog(el("span", {}, `received ${ev.file} from ${ev.from} (${human(ev.size)}) · `,
        el("a", { href: ev.url, download: ev.file }, "save")));
      break;
    case "message":
      addLog(`${ev.kind === "url" ? "Link" : "Text"} from ${ev.from}: ${ev.text}`);
      break;
    case "job_started":
    case "progress":
    case "job_done":
    case "job_failed":
    case "job_cancelled":
      onJobEvent(ev);
      if (ev.event === "job_failed") addLog(`sending failed: ${ev.error}`);
      break;
    case "error":
      addLog(`Error: ${ev.message}`);
      break;
  }
}

// -- init -----------------------------------------------------------------

function init() {
  alias = aliasName();
  document.querySelectorAll(".alias").forEach((e) => { e.textContent = `“${alias}”`; });
  showStatus("connecting …");

  $("#refresh").addEventListener("click", refreshDevices);
  $("#pair-show").addEventListener("click", showHostCode);
  $("#pair-cancel").addEventListener("click", () => { hideHostCode(); showPairState(""); renderZoneState(); });
  $("#pair-join").addEventListener("submit", (ev) => {
    ev.preventDefault();
    joinWithCode($("#pair-code").value);
  });
  $("#leave-zone").addEventListener("click", () => {
    wire.leaveZone();
    addLog("This device left its zone");
    renderZoneState();
    refreshDevices();
  });
  $("#text-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    const pk = $("#text-target").value;
    if (!pk) { addLog("No device selected"); return; }
    const select = $("#text-target");
    const label = select.selectedOptions[0].textContent;
    const text = $("#text").value.trim();
    if (!text) return;
    wire.sendText(pk, text, label);
    $("#text").value = "";
  });

  renderOffers();
  renderJobs();

  wire = createWire({ alias, onEvent });
  window.addEventListener("pagehide", () => { wire.leave(); });

  // Keys must exist before any room is joined, so join first; a pairing link (QR code)
  // then prefills the code and starts pairing at once.
  const link = location.hash.match(/pair=(\d{6})/);
  if (link) history.replaceState(null, "", location.pathname);
  wire.join()
    .then(() => {
      showStatus(`Ready – visible as “${alias}”`);
      refreshDevices();
      renderZoneState();
      if (link) {
        $("#pair-code").value = link[1];
        joinWithCode(link[1]);
      }
    })
    .catch((e) => showStatus(`Could not join: ${e.message}`));
}

init();
