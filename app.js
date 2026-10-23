/* DJI-HDMI Bluetooth: set up a DJI-HDMI box from a phone, over Bluetooth
 * Low Energy (Web Bluetooth), without joining its Wi-Fi.
 *
 * The box exposes one GATT service with two characteristics: the page writes
 * a request to RX and reads the answer from TX. Messages are JSON, cut in
 * frames: 1 flag byte (0x80 last frame, 0x40 nothing ready, low 6 bits frame
 * number) then the data. The link is encrypted (the phone pairs first) and
 * the box answers nothing but the password check until it gets its Wi-Fi
 * password. Requests are those of the box's own settings page.
 */
"use strict";

(() => {
  const SERVICE = "5d1c0001-6b2e-4f3a-9c47-1d2f3a4b5c6d";
  const RX = "5d1c0002-6b2e-4f3a-9c47-1d2f3a4b5c6d";
  const TX = "5d1c0003-6b2e-4f3a-9c47-1d2f3a4b5c6d";
  const LAST = 0x80;
  const EMPTY = 0x40;
  const SEQ = 0x3f;
  const NAME_PREFIX = "DJI-HDMI";
  const REFRESH_MS = 10000;

  const $ = (id) => document.getElementById(id);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // ------------------------------------------------------------- the link --
  class PiLink {
    constructor(device) {
      this.device = device;
      this.rx = null;
      this.tx = null;
      this.frame = 20;              // bytes per written frame (MTU - 3)
      this.queue = Promise.resolve();
    }

    async open() {
      const server = await this.device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE);
      this.rx = await service.getCharacteristic(RX);
      this.tx = await service.getCharacteristic(TX);
      // First read: pairs the phone if needed, and gives the link's MTU.
      const first = await this.readFrame();
      if (first[0] & EMPTY) {
        const mtu = parseInt(decoder.decode(first.subarray(1)), 10);
        if (mtu > 23) this.frame = Math.min(512, mtu - 3);
      }
    }

    async readFrame() {
      const value = await this.tx.readValue();
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }

    /* One request, one answer; requests wait for each other. */
    call(request) {
      const run = this.queue.then(() => this.exchange(request));
      this.queue = run.catch(() => {});
      return run;
    }

    async exchange(request) {
      const data = encoder.encode(JSON.stringify(request));
      const size = this.frame - 1;
      const count = Math.max(1, Math.ceil(data.length / size));
      for (let n = 0; n < count; n++) {
        const piece = data.subarray(n * size, (n + 1) * size);
        const frame = new Uint8Array(piece.length + 1);
        frame[0] = (n & SEQ) | (n === count - 1 ? LAST : 0);
        frame.set(piece, 1);
        await this.rx.writeValueWithResponse(frame);
      }
      const parts = [];
      const deadline = Date.now() + 30000;
      for (;;) {
        const frame = await this.readFrame();
        if (frame[0] & EMPTY) {
          if (Date.now() > deadline) throw new Error("le boîtier ne répond pas");
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        parts.push(frame.subarray(1));
        if (frame[0] & LAST) break;
      }
      const total = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
      let o = 0;
      for (const p of parts) { total.set(p, o); o += p.length; }
      return JSON.parse(decoder.decode(total));
    }

    close() {
      if (this.device.gatt.connected) this.device.gatt.disconnect();
    }
  }

  // ------------------------------------------------------------------- UI --
  const state = { link: null, status: null, config: null, options: null, timer: 0 };

  function setPill(tone, text) {
    $("pill").dataset.tone = tone;
    $("pill-text").textContent = text;
  }

  function toast(message, tone = "ok") {
    const node = document.createElement("div");
    node.className = `toast toast-${tone}`;
    node.textContent = message;
    $("toasts").append(node);
    setTimeout(() => node.remove(), 4500);
  }

  function showError(id, message) {
    $(id).hidden = !message;
    $(id).textContent = message || "";
  }

  function show(step) {
    $("connect-card").hidden = step !== "connect";
    $("auth-card").hidden = step !== "auth";
    $("panel").hidden = step !== "panel";
  }

  const remembered = (name) => {
    try { return localStorage.getItem(`djihdmi-pw:${name}`) || ""; } catch (_) { return ""; }
  };
  const remember = (name, password) => {
    try {
      if (password) localStorage.setItem(`djihdmi-pw:${name}`, password);
      else localStorage.removeItem(`djihdmi-pw:${name}`);
    } catch (_) { /* private browsing: not kept */ }
  };

  /* A request to the box's settings API (through Bluetooth). */
  async function api(method, path, body) {
    const answer = await state.link.call({ op: "api", method, path, body });
    if (answer.status === 401) {
      show("auth");
      throw new Error("mot de passe requis");
    }
    if (answer.status >= 400) {
      throw new Error((answer.body && answer.body.error) || `erreur ${answer.status}`);
    }
    return answer.body;
  }

  async function connect() {
    showError("connect-error", "");
    let device;
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: NAME_PREFIX }], optionalServices: [SERVICE],
      });
    } catch (error) {
      if (error.name !== "NotFoundError") showError("connect-error", error.message);
      return;                                  // chooser closed
    }
    setPill("wait", "Connexion…");
    const link = new PiLink(device);
    try {
      await link.open();
    } catch (error) {
      setPill("", "Déconnecté");
      showError("connect-error", `Connexion impossible : ${error.message}. Rapprochez-vous du boîtier et réessayez.`);
      return;
    }
    state.link = link;
    device.addEventListener("gattserverdisconnected", disconnected);
    $("pi-name").textContent = device.name || "Boîtier";
    setPill("ok", device.name || "Connecté");
    const saved = remembered(device.name);
    if (saved && await authenticate(saved, true)) return;
    $("password").value = "";
    show("auth");
    $("password").focus();
  }

  async function authenticate(password, silent = false) {
    showError("auth-error", "");
    const answer = await state.link.call({ op: "auth", password });
    if (answer.status !== 200) {
      if (!silent) showError("auth-error", (answer.body && answer.body.error) || "refusé");
      remember(state.link.device.name, "");
      return false;
    }
    if ($("remember").checked) remember(state.link.device.name, password);
    show("panel");
    await refresh();
    clearInterval(state.timer);
    state.timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
    return true;
  }

  function disconnected() {
    clearInterval(state.timer);
    state.link = null;
    setPill("", "Déconnecté");
    show("connect");
    showError("connect-error", "Liaison perdue. Rapprochez-vous du boîtier et reconnectez-vous.");
  }

  // ---------------------------------------------------------------- panel --
  const fmtFps = (v) => (v || v === 0 ? Number(v).toFixed(0) : "—");

  /* The warnings of the box (same as the icons on its HDMI picture). */
  const ALERT_TEXT = {
    power: "Alimentation trop faible : branchez une alimentation 5,1 V / 3 A sur le GPIO.",
    heat: "Le Pi est trop chaud : mettez-le à l'air, avec un dissipateur ou un ventilateur.",
    space: "Presque plus de place pour l'enregistrement : videz la clé ou la carte, ou activez l'enregistrement en boucle.",
  };

  function renderHealth(sys, names) {
    $("f-temp").textContent = typeof sys.temperature === "number" ? `${sys.temperature.toFixed(1).replace(".", ",")} °C` : "—";
    const th = sys.throttled;
    $("f-power").textContent = !th ? "—" : th.under_voltage_now ? "trop faible" : th.under_voltage_seen ? "ok (baisse passée)" : "ok";
    const list = $("health-alerts");
    const items = names.filter((n) => ALERT_TEXT[n]).map((n) => {
      const li = document.createElement("li");
      li.textContent = `⚠ ${ALERT_TEXT[n]}`;
      return li;
    });
    list.replaceChildren(...items);
    list.hidden = !items.length;
  }

  function render() {
    const s = state.status || {};
    const usb = s.usb || {};
    const display = s.display || {};
    const rec = display.recording || {};
    const net = (s.system || {}).internet;
    $("f-video").textContent = usb.label || "Service USB arrêté";
    $("f-fps").textContent = fmtFps(display.fps_out);
    const recording = rec.state === "recording" || rec.state === "waiting";
    $("f-rec").textContent = recording ? "en cours" : rec.available === false ? "indisponible" : "arrêté";
    $("f-net").textContent = net ? `oui (${net.kind})` : "non";
    renderHealth(s.system || {}, Array.isArray(display.alerts) ? display.alerts : []);
    $("f-version").textContent = s.version || "—";
    $("f-clock").textContent = s.time ? new Date(s.time * 1000).toLocaleString("fr-FR") : "—";
    const storage = rec.storage;
    $("rec-text").textContent = recording
      ? "Enregistrement en cours."
      : storage ? `Prêt : ${storage.kind === "sd" ? "carte SD" : "clé USB"}, ${(storage.free / 1e9).toFixed(1).replace(".", ",")} Go libres.`
        : "Aucun support d'enregistrement (clé USB ou carte SD).";
    $("rec-btn").textContent = recording ? "Arrêter l'enregistrement" : "Enregistrer";
    $("rec-btn").classList.toggle("is-on", recording);
    $("rec-btn").disabled = !recording && !storage;
    $("photo-btn").disabled = !storage || (rec.photo || {}).available === false || (rec.photo || {}).busy === true;
    // The place is chosen before recording: changing it would cut the file.
    $("rec-storage").disabled = recording;
    $("rec-storage-hint").textContent = recording
      ? "Arrêtez l'enregistrement pour changer de support."
      : "Sur la carte SD, 2 Go restent toujours libres pour le système.";
    const cfg = state.config;
    if (cfg) {
      fillStorages(cfg.recording.storage);
      if (document.activeElement !== $("ssid")) $("ssid").value = cfg.network.ssid;
      if (document.activeElement !== $("wifi-password")) $("wifi-password").value = cfg.network.password;
      if (document.activeElement !== $("device-name")) $("device-name").value = cfg.device.name;
      $("pi-links").textContent = `Page complète : http://10.42.0.1 depuis le Wi-Fi « ${cfg.network.ssid} ».`;
    }
  }

  /* Where recordings go: the box's own choices (USB stick, SD card…). */
  function fillStorages(current) {
    const select = $("rec-storage");
    const choices = Object.entries((state.options || {}).recording_storages || {});
    if (select.options.length !== choices.length) {
      select.replaceChildren(...choices.map(([value, text]) => new Option(text, value)));
    }
    if (document.activeElement !== select) select.value = current;
  }

  async function refresh() {
    if (!state.link) return;
    state.status = await api("GET", "/api/status");
    if (!state.config) {
      const answer = await api("GET", "/api/config");
      state.config = answer.config;
      state.options = answer.options;
    }
    render();
  }

  async function act(button, task, done) {
    button.disabled = true;
    try {
      await task();
      if (done) toast(done);
      await refresh();
    } catch (error) {
      toast(error.message, "danger");
    } finally {
      button.disabled = false;
    }
  }

  // ---------------------------------------------------------------- start --
  if (!("bluetooth" in navigator)) {
    $("unsupported").hidden = false;
    $("connect-card").hidden = true;
  }

  $("connect-btn").addEventListener("click", connect);
  $("auth-card").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("auth-btn").disabled = true;
    try { await authenticate($("password").value); }
    catch (error) { showError("auth-error", error.message); }
    finally { $("auth-btn").disabled = false; }
  });
  $("refresh-btn").addEventListener("click", (e) => act(e.currentTarget, refresh));
  $("rec-btn").addEventListener("click", (e) => {
    const rec = ((state.status || {}).display || {}).recording || {};
    const on = rec.state === "recording" || rec.state === "waiting";
    act(e.currentTarget, () => api("POST", "/api/recording", { action: on ? "stop" : "start" }),
      on ? "Enregistrement arrêté." : "Enregistrement démarré.");
  });
  $("photo-btn").addEventListener("click", (e) => {
    act(e.currentTarget, () => api("POST", "/api/photo"), "Photo demandée.");
  });
  $("rec-storage").addEventListener("change", (e) => {
    const select = e.currentTarget;
    act(select, async () => {
      try {
        state.config = (await api("PUT", "/api/config/recording", { storage: select.value })).config;
      } finally {
        select.blur();
        render();                           // shows the saved choice again
      }
    }, "Support d'enregistrement enregistré.");
  });
  $("wifi-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const body = { ssid: $("ssid").value.trim(), password: $("wifi-password").value };
    act(event.submitter || event.currentTarget, async () => {
      state.config = (await api("PUT", "/api/config/network", body)).config;
      // The access password follows: keep the one the box now expects.
      if (remembered(state.link.device.name)) remember(state.link.device.name, body.password);
    }, "Wi-Fi enregistré : le boîtier redémarre son point d'accès.");
  });
  $("name-form").addEventListener("submit", (event) => {
    event.preventDefault();
    act(event.submitter || event.currentTarget, async () => {
      state.config = (await api("PUT", "/api/config/device", { name: $("device-name").value.trim() })).config;
    }, "Nom enregistré.");
  });
  $("clock-btn").addEventListener("click", (e) => act(e.currentTarget,
    () => api("POST", "/api/clock", { epoch: Date.now() / 1000 }), "Heure envoyée au boîtier."));
  $("video-btn").addEventListener("click", (e) => act(e.currentTarget,
    () => api("POST", "/api/actions/restart-video"), "Vidéo redémarrée."));
  $("reboot-btn").addEventListener("click", (e) => {
    if (confirm("Redémarrer le boîtier ? La liaison Bluetooth sera coupée une minute.")) {
      act(e.currentTarget, () => api("POST", "/api/actions/reboot"), "Redémarrage…");
    }
  });
  $("poweroff-btn").addEventListener("click", (e) => {
    if (confirm("Éteindre le boîtier ? Il faudra couper et remettre l'alimentation pour le rallumer.")) {
      act(e.currentTarget, () => api("POST", "/api/actions/poweroff"), "Extinction…");
    }
  });
  $("disconnect-btn").addEventListener("click", () => {
    if (state.link) state.link.close();
  });
  for (const button of document.querySelectorAll("[data-reveal]")) {
    button.addEventListener("click", () => {
      const input = $(button.dataset.reveal);
      input.type = input.type === "password" ? "text" : "password";
    });
  }

  // Works offline once opened (installed on the home screen, for instance).
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
