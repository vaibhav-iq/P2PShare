const SIGNALING_ENDPOINT = "api.php";
const RTC_CONFIG = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};
const CHUNK_SIZE = 16 * 1024;
const POLL_INTERVAL_MS = 900;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

/* ---------------------------------------------------------------------------
 * Element references
 * ------------------------------------------------------------------------- */
const senderFileInput = document.getElementById("file-input");
const generatePinBtn = document.getElementById("generate-pin-btn");
const senderStatusEl = document.getElementById("sender-status");

const connectPinBtn = document.getElementById("connect-pin-btn");
const receiverStatusEl = document.getElementById("receiver-status");

// UI shell
const themeToggle = document.getElementById("theme-toggle");
const connStatusEl = document.getElementById("conn-status");
const connTextEl = connStatusEl.querySelector(".conn-text");
const tabsEl = document.querySelector(".tabs");
const tabSend = document.getElementById("tab-send");
const tabReceive = document.getElementById("tab-receive");
const panelSend = document.getElementById("panel-send");
const panelReceive = document.getElementById("panel-receive");

// Send UI
const dropZone = document.getElementById("drop-zone");
const fileChip = document.getElementById("file-chip");
const fileNameEl = document.getElementById("file-name");
const fileSizeEl = document.getElementById("file-size");
const fileRemoveBtn = document.getElementById("file-remove");
const shareSection = document.getElementById("share-section");
const pinDisplay = document.getElementById("pin-display");
const copyPinBtn = document.getElementById("copy-pin-btn");
const qrCodeEl = document.getElementById("qr-code");
const shareLinkInput = document.getElementById("share-link-input");
const copyLinkBtn = document.getElementById("copy-link-btn");
const webShareBtn = document.getElementById("web-share-btn");
const sendProgressWrap = document.getElementById("send-progress-wrap");
const sendFileLabel = document.getElementById("send-file-label");
const sendPercentEl = document.getElementById("send-percent");
const sendBar = document.getElementById("send-bar");

// Receive UI
const pinBoxes = Array.from(document.querySelectorAll(".pin-box"));
const recvProgressWrap = document.getElementById("recv-progress-wrap");
const recvFileLabel = document.getElementById("recv-file-label");
const downloadPercent = document.getElementById("download-percent");
const downloadBar = document.getElementById("download-bar");
const recvFileResult = document.getElementById("recv-file-result");
const recvFileNameEl = document.getElementById("recv-file-name");
const recvFileSizeEl = document.getElementById("recv-file-size");
const recvDownloadLink = document.getElementById("recv-download-link");

const toastContainer = document.getElementById("toast-container");

/* ---------------------------------------------------------------------------
 * Transfer state (engine — unchanged behaviour)
 * ------------------------------------------------------------------------- */
const senderState = {
  pin: "",
  peerId: "",
  pc: null,
  dataChannel: null,
  file: null,
  transferring: false,
  receiverConnected: false,
  pendingIce: [],
  pollTimer: null,
  pollInFlight: false,
};

const receiverState = {
  pin: "",
  peerId: "",
  pc: null,
  dataChannel: null,
  pendingIce: [],
  pollTimer: null,
  pollInFlight: false,
  incomingMeta: null,
  chunks: [],
  receivedSize: 0,
};

/* ===========================================================================
 * UI: theme, tabs, toasts, helpers
 * ========================================================================= */
function systemPrefersDark() {
  return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function effectiveTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") {
    return attr;
  }
  return systemPrefersDark() ? "dark" : "light";
}

function applyTheme(theme) {
  if (theme === "light" || theme === "dark") {
    document.documentElement.setAttribute("data-theme", theme);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

themeToggle.addEventListener("click", () => {
  const next = effectiveTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  try {
    localStorage.setItem("p2p-theme", next);
  } catch (e) {}
});

function switchTab(which) {
  const isSend = which === "send";
  tabsEl.dataset.active = which;
  tabSend.classList.toggle("is-active", isSend);
  tabReceive.classList.toggle("is-active", !isSend);
  tabSend.setAttribute("aria-selected", String(isSend));
  tabReceive.setAttribute("aria-selected", String(!isSend));
  panelSend.hidden = !isSend;
  panelReceive.hidden = isSend;
}

tabSend.addEventListener("click", () => switchTab("send"));
tabReceive.addEventListener("click", () => switchTab("receive"));
tabsEl.dataset.active = "send";

if (window.location.hash === "#receive") {
  switchTab("receive");
}

function setConnStatus(state, text) {
  connStatusEl.dataset.state = state;
  connTextEl.textContent = text;
}

const TOAST_ICONS = {
  success: '<path d="M20 6 9 17l-5-5"/>',
  error: '<path d="M18 6 6 18M6 6l12 12"/>',
  info: '<path d="M12 16v-5"/><path d="M12 8h.01"/><circle cx="12" cy="12" r="9"/>',
};

function showToast(message, type = "info", duration = 2800) {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.setAttribute("role", type === "error" ? "alert" : "status");
  toast.innerHTML =
    `<span class="toast-icon"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" ` +
    `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    `${TOAST_ICONS[type] || TOAST_ICONS.info}</svg></span>` +
    `<span class="toast-msg"></span>`;
  toast.querySelector(".toast-msg").textContent = message;
  toastContainer.appendChild(toast);

  const remove = () => {
    toast.classList.add("leaving");
    toast.addEventListener("animationend", () => toast.remove(), { once: true });
    setTimeout(() => toast.remove(), 400);
  };
  setTimeout(remove, duration);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      return true;
    } catch (err) {
      return false;
    }
  }
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) {
    return "";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/* ===========================================================================
 * Send UI wiring
 * ========================================================================= */
function setSelectedFile(file) {
  if (!file) {
    return;
  }
  try {
    const dt = new DataTransfer();
    dt.items.add(file);
    senderFileInput.files = dt.files;
  } catch (e) {
    // Older browsers may not allow programmatic FileList assignment; state still holds it.
  }
  senderState.file = file;

  fileNameEl.textContent = file.name;
  fileSizeEl.textContent = formatBytes(file.size);
  fileChip.hidden = false;
  generatePinBtn.disabled = false;
  setStatus(senderStatusEl, `Ready to share "${file.name}".`);
}

function clearSelectedFile() {
  senderState.file = null;
  try {
    senderFileInput.value = "";
  } catch (e) {}
  fileChip.hidden = true;
  generatePinBtn.disabled = true;
  shareSection.hidden = true;
  sendProgressWrap.hidden = true;
  setStatus(senderStatusEl, "Select a file to begin.");
}

senderFileInput.addEventListener("change", () => {
  const file = senderFileInput.files[0] || null;
  if (file) {
    setSelectedFile(file);
  }
  void maybeSendFile();
});

fileRemoveBtn.addEventListener("click", () => {
  clearSelectedFile();
});

// Drag & drop
["dragenter", "dragover"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropZone.classList.add("is-dragging");
  });
});
["dragleave", "dragend"].forEach((evt) => {
  dropZone.addEventListener(evt, (e) => {
    if (e.target === dropZone) {
      dropZone.classList.remove("is-dragging");
    }
  });
});
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("is-dragging");
  const file = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files[0] : null;
  if (file) {
    setSelectedFile(file);
  }
});
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    senderFileInput.click();
  }
});

generatePinBtn.addEventListener("click", () => {
  void startSenderSession();
});

function renderPinDisplay(pin) {
  pinDisplay.innerHTML = "";
  for (const ch of String(pin)) {
    const span = document.createElement("span");
    span.className = "pin-digit";
    span.textContent = ch;
    pinDisplay.appendChild(span);
  }
}

function buildShareLink(pin) {
  return `${window.location.origin}${window.location.pathname}?pin=${pin}`;
}

function renderQr(text) {
  if (typeof qrcode !== "function") {
    qrCodeEl.parentElement.hidden = true;
    return;
  }
  try {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    qrCodeEl.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
  } catch (e) {
    qrCodeEl.parentElement.hidden = true;
  }
}

function showShare(pin) {
  const link = buildShareLink(pin);
  renderPinDisplay(pin);
  shareLinkInput.value = link;
  renderQr(link);
  webShareBtn.hidden = typeof navigator.share !== "function";
  shareSection.hidden = false;
}

copyPinBtn.addEventListener("click", async () => {
  if (senderState.pin && (await copyText(senderState.pin))) {
    showToast("PIN copied to clipboard", "success");
  }
});
copyLinkBtn.addEventListener("click", async () => {
  if (shareLinkInput.value && (await copyText(shareLinkInput.value))) {
    showToast("Share link copied", "success");
  }
});
webShareBtn.addEventListener("click", () => {
  if (typeof navigator.share !== "function") {
    return;
  }
  navigator
    .share({
      title: "P2P Share",
      text: `Join my file transfer — PIN ${senderState.pin}`,
      url: shareLinkInput.value,
    })
    .catch(() => {});
});

function updateSenderProgress(percent) {
  const safe = Math.min(100, Math.max(0, Number(percent) || 0));
  sendBar.style.width = `${safe}%`;
  sendPercentEl.textContent = `${safe}%`;
}

/* ===========================================================================
 * Receive UI wiring (segmented PIN input)
 * ========================================================================= */
function getEnteredPin() {
  return pinBoxes.map((b) => b.value).join("");
}

function fillPinBoxes(pin) {
  const digits = String(pin).replace(/\D/g, "").slice(0, 6).split("");
  pinBoxes.forEach((box, i) => {
    box.value = digits[i] || "";
    box.classList.toggle("filled", Boolean(digits[i]));
  });
  updateConnectEnabled();
}

function clearPinBoxes() {
  pinBoxes.forEach((box) => {
    box.value = "";
    box.classList.remove("filled");
  });
  updateConnectEnabled();
}

function updateConnectEnabled() {
  connectPinBtn.disabled = !isValidPin(getEnteredPin());
}

pinBoxes.forEach((box, index) => {
  box.addEventListener("input", () => {
    box.value = box.value.replace(/\D/g, "").slice(0, 1);
    box.classList.toggle("filled", box.value !== "");
    if (box.value && index < pinBoxes.length - 1) {
      pinBoxes[index + 1].focus();
    }
    updateConnectEnabled();
    if (isValidPin(getEnteredPin())) {
      box.blur();
    }
  });

  box.addEventListener("keydown", (e) => {
    if (e.key === "Backspace" && !box.value && index > 0) {
      const prev = pinBoxes[index - 1];
      prev.focus();
      prev.value = "";
      prev.classList.remove("filled");
      updateConnectEnabled();
    } else if (e.key === "ArrowLeft" && index > 0) {
      pinBoxes[index - 1].focus();
    } else if (e.key === "ArrowRight" && index < pinBoxes.length - 1) {
      pinBoxes[index + 1].focus();
    } else if (e.key === "Enter" && isValidPin(getEnteredPin())) {
      void startReceiverSession();
    }
  });

  box.addEventListener("paste", (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData("text");
    fillPinBoxes(text);
    const next = Math.min(text.replace(/\D/g, "").length, pinBoxes.length - 1);
    pinBoxes[next].focus();
  });

  box.addEventListener("focus", () => box.select());
});

connectPinBtn.addEventListener("click", () => {
  void startReceiverSession();
});

window.addEventListener("beforeunload", () => {
  sendLeaveBeacon(senderState);
  sendLeaveBeacon(receiverState);
});

/* ===========================================================================
 * HTTPS gate + deep-link prefill
 * ========================================================================= */
if (!isHttpsAllowed()) {
  setStatus(senderStatusEl, "Open this page over HTTPS to use P2P transfer.", true);
  setStatus(receiverStatusEl, "Open this page over HTTPS to use P2P transfer.", true);
} else {
  const params = new URLSearchParams(window.location.search);
  const prefill = params.get("pin");
  if (isValidPin(prefill)) {
    switchTab("receive");
    fillPinBoxes(prefill);
    setStatus(receiverStatusEl, "PIN detected from link. Connecting...");
    setTimeout(() => {
      if (isValidPin(getEnteredPin()) && !receiverState.pin) {
        void startReceiverSession();
      }
    }, 450);
  }
}

/* ===========================================================================
 * Signaling + WebRTC engine (behaviour preserved)
 * ========================================================================= */
async function startSenderSession() {
  senderState.file = senderFileInput.files[0] || senderState.file;
  await cleanupSenderConnection();

  setConnStatus("connecting", "Creating room");
  setStatus(senderStatusEl, "Creating secure room...");

  if (!isHttpsAllowed()) {
    setStatus(senderStatusEl, "Use HTTPS (or localhost) before generating PIN.", true);
    setConnStatus("error", "HTTPS required");
    return;
  }

  const response = await apiRequest({ action: "create-room" });
  if (!response.ok) {
    setStatus(senderStatusEl, response.error, true);
    setConnStatus("error", "Failed");
    return;
  }

  const pin = response.data?.pin;
  const peerId = response.data?.peerId;
  if (!isValidPin(pin) || !isValidPeerId(peerId)) {
    setStatus(senderStatusEl, "Invalid create-room response.", true);
    setConnStatus("error", "Failed");
    return;
  }

  senderState.pin = pin;
  senderState.peerId = peerId;
  showShare(pin);

  setupSenderPeerConnection();
  startSenderPolling();
  setConnStatus("connecting", "Waiting for peer");
  setStatus(senderStatusEl, "Room created. Share the PIN and wait for the receiver...");
  showToast("Room created — share your PIN", "info");
}

async function startReceiverSession() {
  const pin = getEnteredPin().trim();
  if (!isValidPin(pin)) {
    setStatus(receiverStatusEl, "Enter a valid 6-digit numeric PIN.", true);
    return;
  }

  await cleanupReceiverConnection();
  resetReceiverDownloadState();
  recvFileResult.hidden = true;
  setConnStatus("connecting", "Joining room");
  setStatus(receiverStatusEl, "Joining secure room...");

  if (!isHttpsAllowed()) {
    setStatus(receiverStatusEl, "Use HTTPS (or localhost) before connecting.", true);
    setConnStatus("error", "HTTPS required");
    return;
  }

  const response = await apiRequest({ action: "join-room", pin });
  if (!response.ok) {
    setStatus(receiverStatusEl, response.error, true);
    setConnStatus("error", "Failed");
    showToast(response.error, "error");
    return;
  }

  const peerId = response.data?.peerId;
  if (!isValidPeerId(peerId)) {
    setStatus(receiverStatusEl, "Invalid join-room response.", true);
    setConnStatus("error", "Failed");
    return;
  }

  receiverState.pin = pin;
  receiverState.peerId = peerId;

  setupReceiverPeerConnection();
  startReceiverPolling();
  setConnStatus("connecting", "Connecting");
  setStatus(receiverStatusEl, "Joined room. Waiting for sender offer...");
}

function setupSenderPeerConnection() {
  if (senderState.pc) {
    senderState.pc.close();
  }
  senderState.pendingIce = [];

  const pc = new RTCPeerConnection(RTC_CONFIG);
  senderState.pc = pc;

  pc.onicecandidate = (event) => {
    if (!event.candidate || !senderState.pin || !senderState.peerId) {
      return;
    }
    sendSignal(senderState, "ice-candidate", event.candidate, senderStatusEl).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      setConnStatus("connected", "Connected");
      setStatus(senderStatusEl, "Peer connection established.");
    } else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      setConnStatus("error", "Disconnected");
      setStatus(senderStatusEl, `Connection state: ${pc.connectionState}`, true);
    }
  };

  const channel = pc.createDataChannel("file-transfer");
  senderState.dataChannel = channel;
  channel.binaryType = "arraybuffer";

  channel.onopen = () => {
    setStatus(senderStatusEl, "Data channel open.");
    void maybeSendFile();
  };
  channel.onerror = () => {
    setStatus(senderStatusEl, "Data channel error.", true);
  };
  channel.onclose = () => {
    setStatus(senderStatusEl, "Data channel closed.", true);
  };
}

function setupReceiverPeerConnection() {
  if (receiverState.pc) {
    receiverState.pc.close();
  }
  receiverState.pendingIce = [];

  const pc = new RTCPeerConnection(RTC_CONFIG);
  receiverState.pc = pc;

  pc.onicecandidate = (event) => {
    if (!event.candidate || !receiverState.pin || !receiverState.peerId) {
      return;
    }
    sendSignal(receiverState, "ice-candidate", event.candidate, receiverStatusEl).catch(() => {});
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "connected") {
      setConnStatus("connected", "Connected");
      setStatus(receiverStatusEl, "Peer connection established.");
    } else if (["failed", "disconnected", "closed"].includes(pc.connectionState)) {
      setConnStatus("error", "Disconnected");
      setStatus(receiverStatusEl, `Connection state: ${pc.connectionState}`, true);
    }
  };

  pc.ondatachannel = (event) => {
    const channel = event.channel;
    receiverState.dataChannel = channel;
    channel.binaryType = "arraybuffer";

    channel.onopen = () => {
      setStatus(receiverStatusEl, "Ready to receive file.");
    };
    channel.onmessage = (messageEvent) => {
      handleIncomingData(messageEvent.data);
    };
    channel.onerror = () => {
      setStatus(receiverStatusEl, "Data channel error.", true);
    };
    channel.onclose = () => {
      setStatus(receiverStatusEl, "Data channel closed.", true);
    };
  };
}

function startSenderPolling() {
  stopSenderPolling();
  const poll = async () => {
    if (!senderState.pin || !senderState.peerId) {
      return;
    }
    if (senderState.pollInFlight) {
      senderState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    senderState.pollInFlight = true;
    const response = await apiRequest({
      action: "poll",
      pin: senderState.pin,
      peerId: senderState.peerId,
    });
    senderState.pollInFlight = false;

    if (!response.ok) {
      if (isRoomMissingError(response.error)) {
        senderState.receiverConnected = false;
        setStatus(senderStatusEl, "Room closed or expired.", true);
        setConnStatus("error", "Room closed");
        stopSenderPolling();
        return;
      }
      setStatus(senderStatusEl, `Signaling error: ${response.error}`, true);
      if (senderState.pin && senderState.peerId) {
        senderState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
      return;
    }

    const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];
    for (const message of messages) {
      await handleSenderSignal(message);
    }
    if (senderState.pin && senderState.peerId) {
      senderState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  void poll();
}

function startReceiverPolling() {
  stopReceiverPolling();
  const poll = async () => {
    if (!receiverState.pin || !receiverState.peerId) {
      return;
    }
    if (receiverState.pollInFlight) {
      receiverState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }

    receiverState.pollInFlight = true;
    const response = await apiRequest({
      action: "poll",
      pin: receiverState.pin,
      peerId: receiverState.peerId,
    });
    receiverState.pollInFlight = false;

    if (!response.ok) {
      if (isRoomMissingError(response.error)) {
        setStatus(receiverStatusEl, "Sender disconnected.", true);
        setConnStatus("error", "Disconnected");
        stopReceiverPolling();
        return;
      }
      setStatus(receiverStatusEl, `Signaling error: ${response.error}`, true);
      if (receiverState.pin && receiverState.peerId) {
        receiverState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
      }
      return;
    }

    const messages = Array.isArray(response.data?.messages) ? response.data.messages : [];
    for (const message of messages) {
      await handleReceiverSignal(message);
    }
    if (receiverState.pin && receiverState.peerId) {
      receiverState.pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
    }
  };

  void poll();
}

async function handleSenderSignal(message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    return;
  }

  if (message.type === "receiver-connected") {
    senderState.receiverConnected = true;
    setConnStatus("connecting", "Negotiating");
    setStatus(senderStatusEl, "Receiver connected. Negotiating secure channel...");
    await createAndSendOffer();
    return;
  }

  if (message.type === "answer" && senderState.pc && message.payload) {
    try {
      await senderState.pc.setRemoteDescription(new RTCSessionDescription(message.payload));
      await flushPendingIce(senderState, senderStatusEl);
      setStatus(senderStatusEl, "Connected. Waiting for data channel to open...");
    } catch (err) {
      setStatus(senderStatusEl, `Failed to apply answer: ${String(err)}`, true);
    }
    return;
  }

  if (message.type === "ice-candidate" && senderState.pc && message.payload) {
    await queueOrAddIce(senderState, message.payload, senderStatusEl);
    return;
  }

  if (message.type === "peer-disconnected") {
    senderState.receiverConnected = false;
    setConnStatus("error", "Peer left");
    setStatus(senderStatusEl, "Receiver disconnected.", true);
  }
}

async function handleReceiverSignal(message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    return;
  }

  if (message.type === "offer") {
    if (!receiverState.pc) {
      setupReceiverPeerConnection();
    }
    await handleIncomingOffer(message.payload);
    return;
  }

  if (message.type === "ice-candidate" && receiverState.pc && message.payload) {
    await queueOrAddIce(receiverState, message.payload, receiverStatusEl);
    return;
  }

  if (message.type === "peer-disconnected") {
    setConnStatus("error", "Peer left");
    setStatus(receiverStatusEl, "Sender disconnected.", true);
    stopReceiverPolling();
  }
}

async function createAndSendOffer() {
  if (!senderState.pc || !senderState.pin || !senderState.peerId) {
    return;
  }

  try {
    const offer = await senderState.pc.createOffer();
    await senderState.pc.setLocalDescription(offer);
    await sendSignal(senderState, "offer", offer, senderStatusEl);
  } catch (err) {
    setStatus(senderStatusEl, `Failed to create offer: ${String(err)}`, true);
  }
}

async function handleIncomingOffer(offerPayload) {
  if (!receiverState.pc || !receiverState.pin || !receiverState.peerId) {
    return;
  }
  if (!offerPayload) {
    setStatus(receiverStatusEl, "Offer payload missing.", true);
    return;
  }

  try {
    await receiverState.pc.setRemoteDescription(new RTCSessionDescription(offerPayload));
    await flushPendingIce(receiverState, receiverStatusEl);
    const answer = await receiverState.pc.createAnswer();
    await receiverState.pc.setLocalDescription(answer);
    await sendSignal(receiverState, "answer", answer, receiverStatusEl);
    setStatus(receiverStatusEl, "Offer accepted. Finalizing connection...");
  } catch (err) {
    setStatus(receiverStatusEl, `Failed to handle offer: ${String(err)}`, true);
  }
}

async function sendSignal(state, type, payload, statusElement) {
  const response = await apiRequest({
    action: "send-signal",
    pin: state.pin,
    peerId: state.peerId,
    type,
    payload,
  });

  if (!response.ok) {
    setStatus(statusElement, `Signaling error: ${response.error}`, true);
    throw new Error(response.error);
  }
}

async function queueOrAddIce(state, candidatePayload, statusElement) {
  if (!state.pc || !candidatePayload) {
    return;
  }
  if (state.pc.remoteDescription && state.pc.remoteDescription.type) {
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(candidatePayload));
    } catch (err) {
      setStatus(statusElement, `Failed to add ICE candidate: ${String(err)}`, true);
    }
    return;
  }
  state.pendingIce.push(candidatePayload);
}

async function flushPendingIce(state, statusElement) {
  if (!state.pc) {
    state.pendingIce = [];
    return;
  }
  while (state.pendingIce.length > 0) {
    const candidatePayload = state.pendingIce.shift();
    if (!candidatePayload) {
      continue;
    }
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(candidatePayload));
    } catch (err) {
      setStatus(statusElement, `Failed to add queued ICE candidate: ${String(err)}`, true);
      break;
    }
  }
}

async function maybeSendFile() {
  const channel = senderState.dataChannel;
  if (!channel || channel.readyState !== "open") {
    return;
  }
  if (!senderState.receiverConnected || senderState.transferring) {
    return;
  }

  const file = senderFileInput.files[0] || senderState.file;
  if (!file) {
    setStatus(senderStatusEl, "Choose a file to send.");
    return;
  }

  senderState.file = file;
  await sendFileInChunks(file);
}

async function sendFileInChunks(file) {
  const channel = senderState.dataChannel;
  if (!channel || channel.readyState !== "open") {
    setStatus(senderStatusEl, "Data channel is not open.", true);
    return;
  }

  senderState.transferring = true;
  sendFileLabel.textContent = file.name;
  sendProgressWrap.hidden = false;
  updateSenderProgress(0);
  setStatus(senderStatusEl, "Preparing file...");

  try {
    const buffer = await file.arrayBuffer();
    channel.send(
      JSON.stringify({
        type: "file-meta",
        name: file.name,
        size: file.size,
      })
    );

    if (file.size === 0) {
      updateSenderProgress(100);
      setStatus(senderStatusEl, "Empty file sent.", false, true);
      showToast("File sent", "success");
      senderState.transferring = false;
      return;
    }

    let offset = 0;
    let lastPercent = -1;

    while (offset < buffer.byteLength) {
      while (channel.bufferedAmount > CHUNK_SIZE * 64) {
        await wait(10);
      }

      const end = Math.min(offset + CHUNK_SIZE, buffer.byteLength);
      channel.send(buffer.slice(offset, end));
      offset = end;

      const percent = Math.floor((offset / buffer.byteLength) * 100);
      if (percent !== lastPercent) {
        lastPercent = percent;
        updateSenderProgress(percent);
        if (percent % 5 === 0 || percent === 100) {
          setStatus(senderStatusEl, `Sending file... ${percent}%`);
        }
      }
    }

    updateSenderProgress(100);
    setStatus(senderStatusEl, "File sent successfully.", false, true);
    showToast("File sent successfully", "success");
  } catch (err) {
    setStatus(senderStatusEl, `Failed to send file: ${String(err)}`, true);
    showToast("Transfer failed", "error");
  } finally {
    senderState.transferring = false;
  }
}

function handleIncomingData(data) {
  if (typeof data === "string") {
    const parsed = parseJsonObject(data);
    if (parsed && parsed.type === "file-meta") {
      const name = typeof parsed.name === "string" ? parsed.name : "download.bin";
      const size = Number(parsed.size);
      if (!Number.isFinite(size) || size < 0) {
        setStatus(receiverStatusEl, "Invalid file metadata.", true);
        return;
      }

      receiverState.incomingMeta = { name, size };
      receiverState.chunks = [];
      receiverState.receivedSize = 0;
      recvFileResult.hidden = true;
      recvFileLabel.textContent = name;
      recvProgressWrap.hidden = false;
      updateReceiverProgress(0);
      setStatus(receiverStatusEl, `Receiving "${name}" (${formatBytes(size)})...`);

      if (size === 0) {
        completeDownload();
      }
    }
    return;
  }

  if (data instanceof ArrayBuffer) {
    appendIncomingChunk(data);
    return;
  }

  if (data instanceof Blob) {
    data
      .arrayBuffer()
      .then(appendIncomingChunk)
      .catch(() => {
        setStatus(receiverStatusEl, "Failed to read incoming chunk.", true);
      });
  }
}

function appendIncomingChunk(buffer) {
  const meta = receiverState.incomingMeta;
  if (!meta) {
    return;
  }

  receiverState.chunks.push(buffer);
  receiverState.receivedSize += buffer.byteLength;

  const percent =
    meta.size > 0
      ? Math.min(100, Math.floor((receiverState.receivedSize / meta.size) * 100))
      : 100;

  updateReceiverProgress(percent);
  setStatus(receiverStatusEl, `Receiving "${meta.name}"... ${percent}%`);

  if (receiverState.receivedSize >= meta.size) {
    completeDownload();
  }
}

function completeDownload() {
  const meta = receiverState.incomingMeta;
  if (!meta) {
    return;
  }

  const blob = new Blob(receiverState.chunks);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = meta.name;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Offer a manual "save again" control (object URL kept alive while result is shown).
  recvFileNameEl.textContent = meta.name;
  recvFileSizeEl.textContent = formatBytes(meta.size);
  recvDownloadLink.href = url;
  recvDownloadLink.download = meta.name;
  recvFileResult.hidden = false;

  updateReceiverProgress(100);
  setStatus(receiverStatusEl, `Download complete: ${meta.name}`, false, true);
  showToast(`Received "${meta.name}"`, "success");

  receiverState.incomingMeta = null;
  receiverState.chunks = [];
  receiverState.receivedSize = 0;
}

async function cleanupSenderConnection() {
  stopSenderPolling();
  await leaveRoom(senderState);

  if (senderState.dataChannel) {
    senderState.dataChannel.close();
  }
  senderState.dataChannel = null;

  if (senderState.pc) {
    senderState.pc.close();
  }
  senderState.pc = null;

  senderState.pin = "";
  senderState.peerId = "";
  senderState.pendingIce = [];
  senderState.transferring = false;
  senderState.receiverConnected = false;
}

async function cleanupReceiverConnection() {
  stopReceiverPolling();
  await leaveRoom(receiverState);

  if (receiverState.dataChannel) {
    receiverState.dataChannel.close();
  }
  receiverState.dataChannel = null;

  if (receiverState.pc) {
    receiverState.pc.close();
  }
  receiverState.pc = null;

  receiverState.pin = "";
  receiverState.peerId = "";
  receiverState.pendingIce = [];
  receiverState.incomingMeta = null;
  receiverState.chunks = [];
  receiverState.receivedSize = 0;
}

function stopSenderPolling() {
  if (senderState.pollTimer) {
    clearTimeout(senderState.pollTimer);
  }
  senderState.pollTimer = null;
  senderState.pollInFlight = false;
}

function stopReceiverPolling() {
  if (receiverState.pollTimer) {
    clearTimeout(receiverState.pollTimer);
  }
  receiverState.pollTimer = null;
  receiverState.pollInFlight = false;
}

async function leaveRoom(state) {
  if (!isValidPin(state.pin) || !isValidPeerId(state.peerId)) {
    return;
  }
  await apiRequest({
    action: "leave",
    pin: state.pin,
    peerId: state.peerId,
  });
}

function sendLeaveBeacon(state) {
  if (!isValidPin(state.pin) || !isValidPeerId(state.peerId)) {
    return;
  }

  const body = JSON.stringify({
    action: "leave",
    pin: state.pin,
    peerId: state.peerId,
  });

  if (navigator.sendBeacon) {
    const blob = new Blob([body], { type: "application/json" });
    navigator.sendBeacon(SIGNALING_ENDPOINT, blob);
    return;
  }

  fetch(SIGNALING_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
    cache: "no-store",
  }).catch(() => {});
}

function resetReceiverDownloadState() {
  receiverState.incomingMeta = null;
  receiverState.chunks = [];
  receiverState.receivedSize = 0;
  updateReceiverProgress(0);
}

function updateReceiverProgress(percent) {
  const safe = Math.min(100, Math.max(0, Number(percent) || 0));
  downloadBar.style.width = `${safe}%`;
  downloadPercent.textContent = `${safe}%`;
}

async function apiRequest(payload) {
  try {
    const response = await fetch(SIGNALING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
      credentials: "same-origin",
    });

    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.ok !== true) {
      const message =
        data && typeof data.error === "string" && data.error
          ? data.error
          : `Request failed (${response.status})`;
      return { ok: false, error: message };
    }

    return { ok: true, data: data.data || {} };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function parseJsonObject(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    return null;
  }
}

function isValidPin(pin) {
  return typeof pin === "string" && /^\d{6}$/.test(pin);
}

function isValidPeerId(peerId) {
  return typeof peerId === "string" && /^[a-f0-9]{32}$/.test(peerId);
}

function isRoomMissingError(errorText) {
  return typeof errorText === "string" && /room not found|expired|closed/i.test(errorText);
}

function isHttpsAllowed() {
  return window.location.protocol === "https:" || LOCAL_HOSTS.has(window.location.hostname);
}

function setStatus(element, text, isError = false, isSuccess = false) {
  element.textContent = text;
  element.classList.remove("error", "success");
  if (isError) {
    element.classList.add("error");
  } else if (isSuccess) {
    element.classList.add("success");
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if ("serviceWorker" in navigator && isHttpsAllowed()) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}
