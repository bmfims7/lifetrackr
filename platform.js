/* LifeTrackr standalone platform layer.
   Gives the app the same interfaces it uses inside claude.ai (db, sample, assets, downloads),
   backed by Supabase: Postgres for data, Storage for photos, an Edge Function for AI. */
(function () {
  "use strict";
  const LS_CFG = "ta-config", LS_QUEUE = "ta-queue", LS_SERVER = "ta-server", LS_ASIDE = "ta-aside";
  const cfg = Object.assign({}, window.TA_CONFIG || {});
  try { const saved = JSON.parse(localStorage.getItem(LS_CFG) || "null"); if (saved && !cfg.url) Object.assign(cfg, saved); } catch (e) {}
  const P = window.PLATFORM = { mode: "pwa", cfg, loadsApp: true };
  let sb = null, user = null, readyResolve;
  const ready = new Promise(r => { readyResolve = r; });

  /* ---------- App code ----------
     The public site is only this shell. The app itself comes from the database after sign-in and is kept on
     this device, so it opens instantly and offline, and nothing personal sits on the public site.
     Builds without LT_APP_VERSION load app.js with a script tag (tests, local preview). */
  const LS_APP = "lt-app", appWaiters = [], earlyCalls = [];
  let appReady = false;
  const onApp = fn => { if (appReady) fn(); else appWaiters.push(fn); };
  function appIsIn(){
    appReady = true;
    appWaiters.splice(0).forEach(f => { try { f(); } catch (e) { console.error(e); } });
    earlyCalls.splice(0).forEach(([name, args]) => { try { window[name](...args); } catch (e) { console.error(e); } });
  }
  if (window.LT_APP_VERSION) ["openSheet", "closeSheet"].forEach(name => { window[name] = (...args) => { earlyCalls.push([name, args]); }; });
  async function loadApp(){
    const want = window.LT_APP_VERSION;
    let cached = null, js = null;
    try { cached = JSON.parse(localStorage.getItem(LS_APP) || "null"); } catch (e) {}
    if (cached && cached.v === want) js = cached.js;
    else if (sb && user) {
      try {
        const { data, error } = await sb.rpc("get_app_bundle", { p_version: want });
        if (!error && data && data.js) { js = data.js; try { localStorage.setItem(LS_APP, JSON.stringify({ v: want, js })); } catch (e) {} }
      } catch (e) {}
    }
    if (!js && cached) js = cached.js; // Offline on a newer shell: run the last copy until it can update.
    if (!js) {
      const g = gate(`<p>Connect to the internet and sign in once to finish loading LifeTrackr.</p><button class="btn primary big" id="g-retry">Try again</button>`);
      g.querySelector("#g-retry").onclick = () => location.reload();
      return;
    }
    const s = document.createElement("script"); s.text = js; document.body.appendChild(s);
    appIsIn();
  }
  if (window.LT_APP_VERSION) ready.then(loadApp);
  else window.addEventListener("load", appIsIn);

  /* ---------- UI: setup + login overlay ---------- */
  const css = `.gate{position:fixed;inset:0;z-index:80;background:var(--bg,#0e1115);display:flex;align-items:center;justify-content:center;padding:24px max(20px,env(safe-area-inset-left,0px))}
  .gate-card{width:100%;max-width:380px;display:flex;flex-direction:column;gap:12px}
  .gate h1{font-family:"Saira Condensed","Arial Narrow",sans-serif;font-weight:800;font-size:44px;letter-spacing:.04em;text-transform:uppercase;margin:0 0 4px;line-height:1;color:#e8ebee}
  .gate h1 i{font-style:normal;color:#5c9ce5}
  .gate p{margin:0;color:#9aa3ad;font-size:14px}
  .gate label{display:flex;flex-direction:column;gap:6px;font-size:13px;font-weight:600;color:#9aa3ad}
  .gate input{font-size:16px}
  .gate .err{color:#e66a5f;font-size:13.5px;min-height:18px}
  .gate .links{display:flex;justify-content:space-between;gap:10px;font-size:13px}
  .gate .links button{background:none;border:0;color:#5c9ce5;padding:0;font:inherit;cursor:pointer}`;
  function injectCss(){ const s = document.createElement("style"); s.textContent = css; document.head.appendChild(s); }
  function gate(html){ let g = document.getElementById("gate"); if (!g) { g = document.createElement("div"); g.id = "gate"; g.className = "gate"; document.body.appendChild(g); } g.innerHTML = `<div class="gate-card"><h1>Life<i>Trackr</i></h1>${html}</div>`; g.hidden = false; return g; }
  function closeGate(){ const g = document.getElementById("gate"); if (g) g.remove(); }
  function showSetup(){
    const g = gate(`<p>First-time setup on this device. Paste your Supabase Project URL and anon public key (Supabase → Project Settings → API).</p>
      <label>Project URL<input id="g-url" placeholder="https://xxxx.supabase.co" autocomplete="off"></label>
      <label>Anon public key<input id="g-key" placeholder="eyJ…" autocomplete="off"></label>
      <div class="err" id="g-err"></div><button class="btn primary big" id="g-save">Continue</button>`);
    g.querySelector("#g-save").onclick = () => {
      const url = g.querySelector("#g-url").value.trim().replace(/\/$/, ""), key = g.querySelector("#g-key").value.trim();
      if (!/^https:\/\/.+\.supabase\.co$/.test(url) || key.length < 40) { g.querySelector("#g-err").textContent = "Check the URL (ends in .supabase.co) and the key."; return; }
      cfg.url = url; cfg.anonKey = key; try { localStorage.setItem(LS_CFG, JSON.stringify({ url, anonKey: key })); } catch (e) {}
      init();
    };
  }
  function showLogin(msg){
    let mode = "in";
    const draw = () => {
      const g = gate(`<p>${mode === "in" ? "Sign in to sync across your phone and computer." : "Create your account. This app allows one account, so this is a one-time step."}</p>
        <label>Email<input id="g-email" type="email" autocomplete="email" inputmode="email"></label>
        <label>Password<input id="g-pass" type="password" autocomplete="${mode === "in" ? "current-password" : "new-password"}"></label>
        <div class="err" id="g-err">${msg || ""}</div>
        <button class="btn primary big" id="g-go">${mode === "in" ? "Sign in" : "Create account"}</button>
        <div class="links"><button id="g-mode">${mode === "in" ? "First time? Create account" : "Have an account? Sign in"}</button><button id="g-offline">Use offline</button></div>`);
      g.querySelector("#g-mode").onclick = () => { mode = mode === "in" ? "up" : "in"; msg = ""; draw(); };
      g.querySelector("#g-offline").onclick = () => { closeGate(); readyResolve(false); };
      const go = async () => {
        const email = g.querySelector("#g-email").value.trim(), password = g.querySelector("#g-pass").value, err = g.querySelector("#g-err");
        if (!email || password.length < 8) { err.textContent = "Enter your email and a password of 8+ characters."; return; }
        err.textContent = mode === "in" ? "Signing in…" : "Creating…";
        let res = mode === "in" ? await sb.auth.signInWithPassword({ email, password }) : await sb.auth.signUp({ email, password });
        if (res.error) {
          const m = res.error.message || "";
          err.textContent = /database error|sign-?ups/i.test(m) ? "This app already has its account. Sign in instead." : /invalid login/i.test(m) ? "Wrong email or password." : m;
          return;
        }
        if (!res.data.session) {
          res = await sb.auth.signInWithPassword({ email, password });
          if (res.error || !res.data.session) { err.textContent = "Account created. Now sign in."; mode = "in"; return; }
        }
        user = res.data.session.user; closeGate(); readyResolve(true);
      };
      g.querySelector("#g-go").onclick = go;
      g.querySelector("#g-pass").onkeydown = e => { if (e.key === "Enter") go(); };
    };
    draw();
  }
  // The session supabase-js keeps on this device. If it's still here when getSession() comes back empty,
  // the refresh failed for network reasons (a bad sign-in clears it), so we can keep working offline.
  function storedUser(){ try { const s = JSON.parse(localStorage.getItem("ta-auth") || "null"); return (s && (s.user || (s.currentSession && s.currentSession.user))) || null; } catch (e) { return null; } }
  async function init(){
    if (!cfg.url || !cfg.anonKey) return showSetup();
    sb = window.supabase.createClient(cfg.url, cfg.anonKey, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "ta-auth" } });
    P.sb = sb;
    let session = null;
    try { const { data } = await sb.auth.getSession(); session = data.session; } catch (e) {}
    if (session) { user = session.user; closeGate(); readyResolve(true); }
    else if (storedUser()) { user = storedUser(); P.offlineAuth = true; closeGate(); readyResolve(true); }
    else if (navigator.onLine === false) readyResolve(false);
    else showLogin();
    sb.auth.onAuthStateChange((ev, s) => {
      if (s && s.user) { user = s.user; if (P.offlineAuth) { P.offlineAuth = false; kick(); syncChanged(); } }
      if (ev === "SIGNED_OUT" && !s) { user = null; }
    });
  }
  document.addEventListener("DOMContentLoaded", () => { injectCss(); if (!window.supabase) { readyResolve(false); return; } init(); });

  /* ---------- db: documents in public.docs (user_id, col, id, data) ----------
     Saves send only what changed (a patch), and the server deep-merges it, so the phone, the PC
     and the Watch sync never overwrite each other's fields. Patches wait on this device while offline. */
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const isDel = v => isObj(v) && v.$del === true && Object.keys(v).length === 1;
  const isSet = v => isObj(v) && "$set" in v && Object.keys(v).length === 1;
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  function diff(a, b){
    a = isObj(a) ? a : {}; const p = {}; let any = false;
    for (const k of Object.keys(b)) {
      const av = a[k], bv = b[k]; if (bv === undefined) continue;
      if (isObj(av) && isObj(bv)) { const sp = diff(av, bv); if (sp) { p[k] = sp; any = true; } }
      else if (!same(av, bv)) { p[k] = isObj(bv) && isObj(av) === false && av !== undefined ? { $set: copy(bv) } : copy(bv); any = true; }
    }
    for (const k of Object.keys(a)) if (b[k] === undefined && a[k] !== undefined) { p[k] = { $del: true }; any = true; }
    return any ? p : null;
  }
  function applyPatch(base, p){
    if (isSet(p)) return copy(p.$set);
    if (!isObj(p)) return copy(p);
    const out = isObj(base) ? Object.assign({}, base) : {};
    for (const k of Object.keys(p)) { const v = p[k]; if (isDel(v)) delete out[k]; else if (isObj(v)) out[k] = applyPatch(out[k], v); else out[k] = copy(v); }
    return out;
  }
  function mergePatch(p1, p2){
    if (!p1) return p2; if (!p2) return p1;
    const out = Object.assign({}, p1);
    for (const k of Object.keys(p2)) {
      const a = out[k], b = p2[k];
      if (isObj(b) && !isDel(b) && !isSet(b)) {
        if (isObj(a) && !isDel(a) && !isSet(a)) out[k] = mergePatch(a, b);
        else if (isDel(a)) out[k] = { $set: applyPatch({}, b) };
        else if (isSet(a)) out[k] = { $set: applyPatch(a.$set, b) };
        else out[k] = b;
      } else out[k] = b;
    }
    return out;
  }
  P.patch = { diff, applyPatch, mergePatch };

  const view = {}, server = {}, serverTs = {}, seen = {}, listeners = {};
  const split = key => { const i = key.indexOf("/"); return [key.slice(0, i), key.slice(i + 1)]; };
  const getIn = (m, key) => { const [c, id] = split(key); return m[c] ? m[c][id] : undefined; };
  const setIn = (m, key, v) => { const [c, id] = split(key); if (v === undefined) { if (m[c]) delete m[c][id]; } else (m[c] = m[c] || {})[id] = v; };
  let pend = (() => { try { return JSON.parse(localStorage.getItem(LS_QUEUE) || "{}"); } catch (e) { return {}; } })();
  for (const k of Object.keys(pend)) if (pend[k] && pend[k].op === "set") pend[k] = { op: "patch", patch: pend[k].data }; // older queue format
  let syncT = null;
  const syncChanged = () => { clearTimeout(syncT); syncT = setTimeout(() => P.syncChanged && P.syncChanged(), 0); };
  const saveQueue = () => { try { localStorage.setItem(LS_QUEUE, JSON.stringify(pend)); } catch (e) {} syncChanged(); };
  P.pending = () => Object.keys(pend).length;
  // What the server last confirmed, kept on this device so a relaunch can tell which local edits never left it.
  let srvT = null;
  const saveServer = () => { clearTimeout(srvT); srvT = setTimeout(() => { try { const o = {}; for (const c of Object.keys(server)) for (const id of Object.keys(server[c])) o[c + "/" + id] = server[c][id]; localStorage.setItem(LS_SERVER, JSON.stringify(o)); } catch (e) {} }, 400); };
  // Base for diffs. Seeded from confirmed server data; any local doc that differs was edited and not sent
  // (the app was closed inside the save delay), so queue that difference now instead of losing it.
  try {
    const srv = JSON.parse(localStorage.getItem(LS_SERVER) || "null"), j = JSON.parse(localStorage.getItem("turnaround-v2") || "null") || {};
    if (!srv) { for (const c of Object.keys(j)) for (const id of Object.keys(j[c] || {})) seen[c + "/" + id] = j[c][id]; } // first run of this version
    else {
      for (const key of Object.keys(srv)) seen[key] = srv[key];
      let n = 0;
      for (const c of Object.keys(j)) for (const id of Object.keys(j[c] || {})) {
        const key = c + "/" + id, p = diff(seen[key], j[c][id]); if (!p) continue;
        const old = pend[key];
        pend[key] = !old ? { op: "patch", patch: p } : old.op === "patch" ? { op: "patch", patch: mergePatch(old.patch, p) } : { op: "put", data: copy(j[c][id]) };
        seen[key] = copy(j[c][id]); n++;
      }
      if (n) saveQueue();
    }
  } catch (e) {}
  const appDirty = key => { try { return typeof dirty !== "undefined" && dirty.has(key); } catch (e) { return false; } };

  function withPending(key, base){ const pd = pend[key]; if (!pd) return base; if (pd.op === "delete") return undefined; if (pd.op === "put") return copy(pd.data); return applyPatch(base || {}, pd.patch); }
  const emitQ = new Set(); let emitT = null;
  function queueEmit(col){ emitQ.add(col); if (!emitT) emitT = setTimeout(() => { emitT = null; const cols = [...emitQ]; emitQ.clear(); cols.forEach(emit); }, 0); }
  function emit(col){
    const docs = Object.entries(view[col] || {}).map(([id, data]) => ({ id, exists: true, data: () => data, metadata: { fromCache: false, hasPendingWrites: !!pend[col + "/" + id] } }));
    (listeners[col] || []).forEach(l => { try { l.next({ docs, size: docs.length, empty: !docs.length }); } catch (e) { console.error(e); } });
    if (col === "push" && P.onPushDocs) P.onPushDocs();
  }
  // A server version arrived (load, realtime, or the reply to our own write).
  function serverIn(key, data, ts){
    if (ts && serverTs[key] && ts < serverTs[key]) return false; // older echo
    if (ts) serverTs[key] = ts;
    setIn(server, key, data); saveServer();
    const v = withPending(key, data);
    if (same(getIn(view, key), v)) return false;
    setIn(view, key, v);
    if (!appDirty(key)) { if (v === undefined) delete seen[key]; else seen[key] = copy(v); }
    return true;
  }

  let loaded = false, loading = null;
  async function loadAll(){
    const fresh = {}; let from = 0;
    for (;;) {
      const { data, error } = await sb.from("docs").select("col,id,data,updated_at").range(from, from + 999);
      if (error) throw error;
      data.forEach(r => { fresh[r.col + "/" + r.id] = r; });
      if (data.length < 1000) break; from += 1000;
    }
    const keys = new Set([...Object.keys(fresh), ...Object.keys(pend)]);
    for (const c of Object.keys(server)) for (const id of Object.keys(server[c])) keys.add(c + "/" + id);
    for (const c of Object.keys(view)) for (const id of Object.keys(view[c])) keys.add(c + "/" + id);
    for (const key of keys) { const r = fresh[key]; serverTs[key] = undefined; serverIn(key, r ? r.data : undefined, r ? r.updated_at : null); }
    firstSyncUpload(fresh);
    loaded = true; Object.keys(listeners).forEach(emit); if (P.onPushDocs) P.onPushDocs();
  }
  // First sign-in on a device that was used offline: send up anything the account doesn't have yet. Never overwrites.
  function firstSyncUpload(fresh){
    const flagKey = "ta-uploaded-" + user.id; try { if (localStorage.getItem(flagKey)) return; } catch (e) { return; }
    let n = 0;
    try {
      const j = JSON.parse(localStorage.getItem("turnaround-v2") || "null") || {};
      for (const c of Object.keys(j)) for (const id of Object.keys(j[c] || {})) {
        const key = c + "/" + id; if (fresh[key] || pend[key]) continue;
        pend[key] = { op: "patch", patch: copy(j[c][id]) }; setIn(view, key, copy(j[c][id])); n++;
      }
      localStorage.setItem(flagKey, "1");
    } catch (e) {}
    if (n) { saveQueue(); kick(); }
  }
  function ensureLoaded(){ if (!loading) loading = loadAll().catch(e => { loading = null; throw e; }); return loading; }
  let channel = null;
  function subscribe(){
    if (channel || !user) return;
    channel = sb.channel("docs-" + user.id).on("postgres_changes", { event: "*", schema: "public", table: "docs", filter: "user_id=eq." + user.id }, p => {
      if (p.eventType === "DELETE") { const o = p.old || {}; if (o.user_id && o.user_id !== user.id) return; if (!o.col) return; const key = o.col + "/" + o.id; if (serverIn(key, undefined, null)) queueEmit(o.col); }
      else { const r = p.new; const key = r.col + "/" + r.id; if (serverIn(key, r.data, r.updated_at)) queueEmit(r.col); }
    }).subscribe(status => { if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") { try { sb.removeChannel(channel); } catch (e) {} channel = null; setTimeout(() => { if (navigator.onLine) subscribe(); }, 5000); } });
  }

  let rpcMissing = false;
  async function send(key, it){
    const [col, id] = split(key);
    if (it.op === "delete") { const { error } = await sb.from("docs").delete().match({ user_id: user.id, col, id }); if (error) throw error; return { data: undefined, ts: null }; }
    if (it.op === "patch" && !rpcMissing) {
      const { data, error } = await sb.rpc("patch_doc", { p_col: col, p_id: id, p_patch: it.patch });
      if (!error) return data && data.data !== undefined ? { data: data.data, ts: data.ts } : { data, ts: null };
      if (!/PGRST202|function|not find|404/i.test((error.code || "") + " " + (error.message || ""))) throw error;
      rpcMissing = true; // database update not applied yet: fall back to whole-document saves
    }
    const full = it.op === "put" ? it.data : applyPatch(getIn(server, key) || {}, it.patch);
    const { data, error } = await sb.from("docs").upsert({ user_id: user.id, col, id, data: full, updated_at: new Date().toISOString() }).select("data,updated_at").single();
    if (error) throw error; return { data: data.data, ts: data.updated_at };
  }
  let flushing = false, flushAgain = false;
  const fails = {}; // key -> { n, next }
  P.asideCount = () => { try { return Object.keys(JSON.parse(localStorage.getItem(LS_ASIDE) || "{}")).length; } catch (e) { return 0; } };
  function setAside(key, it, err){
    try { const a = JSON.parse(localStorage.getItem(LS_ASIDE) || "{}"); a[key] = { it, err: String(err && (err.message || err.code) || err), at: new Date().toISOString() }; localStorage.setItem(LS_ASIDE, JSON.stringify(a)); } catch (e) {}
    delete pend[key]; delete fails[key]; saveQueue();
    if (typeof flag === "function") flag("One change couldn't sync after several tries and was set aside on this device. Download a backup in Settings before clearing app data.");
  }
  async function flush(){
    if (!user || P.offlineAuth || navigator.onLine === false) return;
    if (flushing) { flushAgain = true; return; }
    flushing = true;
    try {
      for (const key of Object.keys(pend)) {
        const it = pend[key], f = fails[key];
        if (f && f.next > Date.now()) continue;
        try {
          const res = await send(key, it);
          delete fails[key];
          if (pend[key] === it) { delete pend[key]; saveQueue(); }
          if (serverIn(key, res.data, res.ts)) queueEmit(split(key)[0]);
        } catch (e) {
          console.warn("sync later", key, e && (e.message || e.code));
          if (navigator.onLine === false || /fetch|network|timeout/i.test(String(e && (e.message || e)))) break; // connection problem: everything waits
          const n = (f ? f.n : 0) + 1;
          if (n >= 6 && pend[key] === it) setAside(key, it, e); else fails[key] = { n, next: Date.now() + Math.min(600000, 5000 * 2 ** n) };
        }
      }
    } finally { flushing = false; syncChanged(); if (flushAgain) { flushAgain = false; setTimeout(flush, 50); } }
  }
  P.syncState = () => {
    const n = Object.keys(pend).length, w = n === 1 ? "1 change" : n + " changes";
    if (!user) return { dot: "warn", text: "Not signed in. Saving on this device only." };
    if (P.offlineAuth) return { dot: "warn", text: `Can't reach your account. ${n ? w + " saved here. " : ""}Sign in again in Settings if this lasts.`, show: true };
    if (navigator.onLine === false) return { dot: "warn", text: `Offline. ${n ? w + " will sync when you're back online." : "Changes sync when you're back online."}` };
    if (n) return { dot: "", text: w + " waiting to sync" };
    return { dot: "on", text: "All changes synced" };
  };
  let kickT = null;
  function kick(){ clearTimeout(kickT); kickT = setTimeout(flush, 30); }
  function resync(){ if (!user || navigator.onLine === false) return; flush(); loading = null; ensureLoaded().then(() => { subscribe(); flush(); }).catch(() => {}); }
  window.addEventListener("online", resync);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") resync(); });
  setInterval(() => { if (Object.keys(pend).length) flush(); }, 30000);

  const db = {
    doc(key){
      return {
        async set(data){
          const p = diff(seen[key], data);
          seen[key] = copy(data); setIn(view, key, copy(data));
          if (!p) return;
          const old = pend[key];
          pend[key] = !old ? { op: "patch", patch: p } : old.op === "patch" ? { op: "patch", patch: mergePatch(old.patch, p) } : { op: "put", data: copy(data) };
          saveQueue(); kick();
        },
        async delete(){
          delete seen[key]; setIn(view, key, undefined);
          pend[key] = { op: "delete" }; saveQueue(); kick();
        },
        get(){ return copy(getIn(view, key)); }
      };
    },
    collection(col){
      return { onSnapshot(next, error){ const l = { next, error }; (listeners[col] = listeners[col] || []).push(l);
        if (loaded) emit(col);
        ensureLoaded().then(() => { emit(col); subscribe(); flush(); }).catch(e => { console.warn("load failed", e); });
        return () => { listeners[col] = (listeners[col] || []).filter(x => x !== l); }; } };
    },
    all(col){ return copy(view[col] || {}); }
  };
  P.db = db;

  /* ---------- AI via Edge Function "ai" ---------- */
  async function toImage(blob){
    try { const bmp = await createImageBitmap(blob, { imageOrientation: "from-image" }); const s = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas"); c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.85); return { media_type: "image/jpeg", data: url.split(",")[1] };
    } catch (e) { const buf = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return { media_type: blob.type || "image/jpeg", data: btoa(s) }; }
  }
  async function callAI(payload, signal){
    if (!navigator.onLine) throw { code: "upstream_error", message: "offline" };
    const { data } = await sb.auth.getSession(); if (!data.session) throw { code: "session_expired" };
    let r; try { r = await fetch(cfg.url + "/functions/v1/ai", { method: "POST", signal, headers: { "Content-Type": "application/json", Authorization: "Bearer " + data.session.access_token, apikey: cfg.anonKey }, body: JSON.stringify(payload) }); }
    catch (e) { if (e && e.name === "AbortError") throw { code: "cancelled" }; throw { code: "upstream_error", message: String(e) }; }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw { code: r.status === 429 ? "rate_limited" : r.status === 401 ? "session_expired" : r.status === 400 ? "refused" : "upstream_error", message: JSON.stringify(j).slice(0, 300) };
    return j;
  }
  function sample(input, opts){
    opts = opts || {};
    return (async () => {
      const images = opts.images ? await Promise.all(Array.from(opts.images).slice(0, 3).map(toImage)) : [];
      const res = await callAI({ input, images, tier: opts.modelTier || "default" }, opts.signal);
      if (!res.text) throw { code: "empty_completion" };
      if (opts.onText) try { opts.onText({ text: res.text, delta: res.text }); } catch (e) {}
      return { text: res.text, truncated: !!res.truncated, modelTierApplied: opts.modelTier || "default" };
    })();
  }
  function parseJson(t){
    try { return JSON.parse(t); } catch (e) {}
    const f = t.match(/```(?:json)?\s*([\s\S]*?)```/); if (f) try { return JSON.parse(f[1]); } catch (e) {}
    const a = Math.min(...["{", "["].map(c => t.indexOf(c)).filter(i => i >= 0)), b = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
    if (a >= 0 && b > a) try { return JSON.parse(t.slice(a, b + 1)); } catch (e) {}
    throw { code: "invalid_json", text: t };
  }
  sample.json = async (input, opts) => {
    const tail = "\n\nReply with only the JSON value, no other text.";
    const inp = typeof input === "string" ? input + tail : input.map((m, i) => i === input.length - 1 ? { role: m.role, content: m.content + tail } : m);
    const { text } = await sample(inp, opts); return parseJson(text);
  };
  sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 3, maxInputBytes: 20 * 1024 * 1024, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] }, modelTiers: ["default", "quick", "complex"] });

  /* ---------- assets: private Storage bucket "photos" ---------- */
  const signed = {}, pending = new Set(); let signTimer = null;
  const BLANK = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
  P.blobSrc = id => {
    const s = signed[id]; if (s && s.exp > Date.now()) return s.url;
    if (sb && user) { pending.add(id); clearTimeout(signTimer); signTimer = setTimeout(signPending, 30); }
    return BLANK;
  };
  async function signPending(){
    const ids = [...pending]; pending.clear(); if (!ids.length) return;
    const { data, error } = await sb.storage.from("photos").createSignedUrls(ids, 3600);
    if (error || !data) return;
    data.forEach(d => { if (d.signedUrl) signed[d.path] = { url: d.signedUrl, exp: Date.now() + 3300 * 1000 }; });
    if (typeof softRender === "function") softRender();
  }
  P.blobGet = async id => { const { data, error } = await sb.storage.from("photos").download(id); if (error || !data) throw { code: "image_rejected" }; return data; };
  const assets = {
    async upload(blob, o){ const ext = /png/.test((o && o.type) || blob.type) ? "png" : "jpg", path = user.id + "/" + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)) + "." + ext;
      const { error } = await sb.storage.from("photos").upload(path, blob, { contentType: (o && o.type) || blob.type || "image/jpeg", upsert: false });
      if (error) throw { code: /size|large/i.test(error.message) ? "too_large" : /quota|limit/i.test(error.message) ? "quota_or_state" : "upstream_error", message: error.message };
      return { id: path, url: P.blobSrc(path), sizeBytes: blob.size, contentType: blob.type }; },
    async delete(id){ const { error } = await sb.storage.from("photos").remove([id]); return { deleted: !error }; },
    async list(){ return { assets: [], usage: {} }; }
  };

  /* ---------- downloads: share sheet on iPhone, normal download elsewhere ---------- */
  const downloads = {
    async save({ filename, data }){
      const type = /\.pdf$/i.test(filename) ? "application/pdf" : /\.png$/i.test(filename) ? "image/png" : /\.json$/i.test(filename) ? "application/json" : "application/octet-stream";
      const blob = data instanceof Blob ? new Blob([data], { type }) : new Blob([data], { type });
      const file = typeof File === "function" ? new File([blob], filename, { type }) : null;
      const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      if (ios && file && navigator.canShare && navigator.canShare({ files: [file] })) {
        try { await navigator.share({ files: [file], title: filename }); return { status: "saved" }; }
        catch (e) { if (e && e.name === "AbortError") throw { code: "declined" }; }
      }
      const url = URL.createObjectURL(blob), a = document.createElement("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { status: "saved" };
    }
  };

  /* ---------- claude.use() shim ---------- */
  window.claude = { use(name){
    if (name === "downloads") return Promise.resolve(downloads);
    return ready.then(ok => { if (!ok || !sb || !user) return null; if (name === "db") return db; if (name === "sample") return sample; if (name === "assets") return assets; return null; });
  } };
  P.healthSync = true;

  /* ---------- Reminders: Web Push ----------
     The app writes the next few days of reminders to push/schedule (it already knows the whole day plan).
     A server job checks every 5 minutes and sends what's due, skipping anything already done. */
  const CATS = [
    ["key", "Key moments", "Weigh-in, caffeine cutoff, leave for the gym, lift, wind-down, bed"],
    ["meds", "Meds and supplements", "Your daily meds and supplements"],
    ["meals", "Meals", "A nudge at each planned meal so you log it"],
    ["logs", "Logging", "Sleep in the morning, Watch numbers at night"],
    ["habits", "Habits", "Skin, brushing, flossing, walks, your own habits"],
    ["evening", "Evening check", "One summary: protein left, steps, what's still open"]
  ];
  const DEF_PUSH = { cats: { key: true, meds: true, meals: true, logs: true, habits: false, evening: true }, evening: "20:30" };
  const pushSettings = () => { const s = (view.push && view.push.settings) || {}; return { cats: Object.assign({}, DEF_PUSH.cats, s.cats || {}), evening: s.evening || DEF_PUSH.evening }; };
  function catFor(it){
    if (it.kind === "work") return null;
    if (it.kind === "bed") return "key";
    if (it.act === "game") return null;
    if (it.act === "sleep" || it.act === "watch") return "logs";
    if (it.act) return "key";
    if (it.h && MED_HABITS.has(it.h)) return "meds";
    if (it.h && KEY_HABITS.has(it.h)) return "key";
    if (it.h) return "habits";
    if (it.meal) return QUIET_MEALS.has(it.meal) ? null : "meals";
    return "key";
  }
  function chkFor(it, s){
    const d = (path) => ({ col: "days", id: s, path });
    if (it.h) return [d(["habits", it.h])];
    if (it.meal) return [d(["meals", it.meal])];
    if (it.act === "weigh") return [d(["weight"])];
    if (it.act === "sleep") return [d(["sleep"]), d(["wake"])];
    if (it.act === "watch") return [d(["steps"])];
    if (it.act === "lift") return [{ col: "workouts", where: { date: s }, path: ["done"] }];
    if (it.act === "cardio") return [d(["cardio", "0"]), d(["cardioMin"])];
    if (it.act === "prep" && it.task) return [{ col: "weekly", id: "w" + Math.max(1, weekOf(s)), path: ["tasks", it.task] }];
    return [];
  }
  const atLocal = (s, min) => { const [y, m, dd] = s.split("-").map(Number); return new Date(y, m - 1, dd, 0, min).getTime(); };
  function buildSchedule(){
    if (typeof blocksFor !== "function" || typeof TODAY === "undefined") return null;
    const now = Date.now(), items = [], ps = pushSettings();
    for (let i = 0; i < 4; i++) {
      const s = addDays(TODAY, i);
      for (const b of blocksFor(s)) for (const it of b.items) {
        if (it.t == null) continue;
        const cat = catFor(it); if (!cat) continue;
        const at = atLocal(s, it.t); if (at < now - 60000) continue;
        if (i === 0 && typeof itemDone === "function" && itemDone(it, s) === true) continue;
        const key = itemKey(it); if (i === 0 && S.skip && S.skip[key]) continue;
        items.push({ k: s + "|" + key, at, cat, title: it.l, body: it.sub || "", chk: chkFor(it, s), date: s });
      }
      const ev = atLocal(s, hm2m(ps.evening)); if (ev >= now - 60000) items.push({ k: s + "|evening", at: ev, cat: "evening", dyn: "evening", title: "Evening check", body: "", chk: [], date: s });
    }
    items.sort((a, b) => a.at - b.at);
    return { items, tz: Intl.DateTimeFormat().resolvedOptions().timeZone };
  }
  function buildSummary(){
    if (typeof dayTotals !== "function" || typeof TODAY === "undefined") return null;
    const d = day(TODAY), tot = dayTotals(d), pl = plan(), now = nowMin();
    const open = todoItems(TODAY).filter(it => it.act !== "game" && it.t <= now + 120).map(it => it.l);
    return { date: TODAY, p: Math.round(tot.p || 0), pt: pl.targets.proteinMin, kcal: Math.round(tot.kcal || 0), kt: pl.targets.kcal, water: n(d.water), open: open.slice(0, 6), openCount: open.length, lift: isLift(sessionForDate(TODAY)) && !wkDone(TODAY) };
  }
  const devices = () => (view.push && view.push.devices) || {};
  let lastSched = "", lastSum = "", lastVer = -1, schedT = null;
  function syncPushDocs(force){
    if (!user || !loaded || !Object.keys(devices()).length) return;
    if (typeof S === "undefined") return;
    if (!force && S.ver === lastVer) return; lastVer = S.ver;
    clearTimeout(schedT);
    schedT = setTimeout(() => {
      try {
        const sch = buildSchedule(), sum = buildSummary();
        const sj = JSON.stringify(sch && sch.items.map(x => [x.k, x.at, x.cat, x.title]));
        if (sch && (force || sj !== lastSched)) { lastSched = sj; db.doc("push/schedule").set(Object.assign({ gen: new Date().toISOString() }, sch)); }
        const mj = JSON.stringify(sum);
        if (sum && mj !== lastSum) { lastSum = mj; db.doc("push/summary").set(sum); }
      } catch (e) { console.warn("reminder schedule", e); }
    }, 2500);
  }
  setInterval(() => syncPushDocs(false), 5000);
  setInterval(() => syncPushDocs(true), 30 * 60 * 1000);
  P.onPushDocs = () => { if (typeof SHEET !== "undefined" && SHEET && SHEET.type === "settings" && typeof renderSheet === "function") renderSheet(); };

  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone = () => (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true;
  const deviceName = () => { const u = navigator.userAgent; return /iPhone/.test(u) ? "iPhone" : /iPad/.test(u) || isIOS() ? "iPad" : /Android/.test(u) ? "Android" : /Windows/.test(u) ? "Windows PC" : /Mac/.test(u) ? "Mac" : "This device"; };
  async function hashId(s){ const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))); return Array.from(b.slice(0, 8)).map(x => x.toString(16).padStart(2, "0")).join(""); }
  const fromB64u = s => { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; const bin = atob(s), out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };
  let pushState = { here: null, busy: false, msg: "" };
  async function refreshPushHere(){
    try { if (!pushSupported()) { pushState.here = null; return; } const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && await reg.pushManager.getSubscription(); pushState.here = sub ? await hashId(sub.endpoint) : null; } catch (e) { pushState.here = null; }
  }
  async function pushOn(){
    if (!cfg.vapidPublic) throw new Error("Reminders aren't set up on the server yet.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error(perm === "denied" ? "Notifications are blocked. Turn them on for LifeTrackr in your device settings, then try again." : "Notifications weren't allowed.");
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64u(cfg.vapidPublic) });
    const j = sub.toJSON(), id = await hashId(j.endpoint);
    const all = Object.assign({}, devices()); all[id] = { endpoint: j.endpoint, keys: j.keys, name: deviceName(), added: new Date().toISOString() };
    const doc = Object.assign({}, (view.push && view.push.devices) || {}, all);
    await db.doc("push/devices").set(doc);
    pushState.here = id; lastVer = -1; syncPushDocs(true);
  }
  async function pushOff(){
    const reg = await navigator.serviceWorker.getRegistration(); const sub = reg && await reg.pushManager.getSubscription();
    const id = sub ? await hashId(sub.endpoint) : pushState.here;
    if (sub) await sub.unsubscribe().catch(() => {});
    if (id) { const doc = Object.assign({}, devices()); delete doc[id]; await db.doc("push/devices").set(doc); }
    pushState.here = null;
  }
  async function pushTest(){
    const { data } = await sb.auth.getSession(); if (!data.session) throw new Error("Sign in again first.");
    const r = await fetch(cfg.url + "/functions/v1/notify", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + data.session.access_token, apikey: cfg.anonKey }, body: JSON.stringify({ action: "test" }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || "The reminder server didn't answer.");
    return j;
  }
  function remindersCard(){
    if (!user) return "";
    const ps = pushSettings(), devs = devices(), here = pushState.here && devs[pushState.here];
    let status;
    if (!pushSupported()) status = isIOS() && !standalone() ? `<div class="small">On iPhone, reminders need the app on your Home Screen: open this page in Safari, tap <b>Share</b>, then <b>Add to Home Screen</b>. Open it from the icon and come back here.</div>` : `<div class="small muted">This browser can't receive reminders. Use the installed app on your iPhone, or Chrome or Edge on your PC.</div>`;
    else if (here) status = `<div class="row between wrapgap"><span class="small"><b style="color:var(--good)">On</b> for this ${esc(here.name)}</span><span class="row wrapgap"><button class="btn small" data-act="ta-push-test" ${pushState.busy ? "disabled" : ""}>Send a test</button><button class="btn small" data-act="ta-push-off" ${pushState.busy ? "disabled" : ""}>Turn off here</button></span></div>`;
    else status = `<button class="btn primary" data-act="ta-push-on" ${pushState.busy ? "disabled" : ""}>Turn on reminders${deviceName() === "This device" ? " here" : " on this " + esc(deviceName())}</button>`;
    const others = Object.entries(devs).filter(([id]) => id !== pushState.here);
    return `<div class="label">Reminders</div><div class="card stack small">
      ${status}
      ${pushState.msg ? `<div class="small">${esc(pushState.msg)}</div>` : ""}
      ${others.length ? `<div class="xs muted">Also on: ${others.map(([, d]) => esc(d.name || "device")).join(", ")}</div>` : ""}
      <div class="checks">${CATS.map(([k, label, sub]) => `<button class="check" data-act="ta-push-cat" data-id="${k}" aria-pressed="${!!ps.cats[k]}"><span class="box"></span><span class="t">${label}<span class="xs muted" style="display:block">${sub}</span></span></button>`).join("")}</div>
      <label class="setting"><span><b>Evening check time</b><div class="xs muted">Protein left, steps and what's still open</div></span><input type="time" data-ch="ta-push-evening" value="${ps.evening}"></label>
      <div class="xs muted">Reminders skip anything you've already logged. They follow the schedule above, including travel days.</div>
    </div>`;
  }

  /* ---------- Backup import ---------- */
  async function importBackup(file){
    const j = JSON.parse(await file.text());
    let data = j && (j.data || j);
    if (Array.isArray(data)) { // The nightly backup's docs.json is a list of database rows.
      const rows = data; data = {};
      for (const r of rows) if (r && r.col && r.id) (data[r.col] = data[r.col] || {})[r.id] = r.data;
    }
    if (!data || typeof data !== "object") throw new Error("That file isn't a LifeTrackr backup.");
    let added = 0, skipped = 0;
    for (const col of (typeof COLS !== "undefined" ? COLS : Object.keys(data))) {
      for (const [id, doc] of Object.entries(data[col] || {})) {
        if (S[col] && S[col][id]) { skipped++; continue; }
        save(col, id, doc); added++;
      }
    }
    return { added, skipped };
  }

  /* ---------- Settings additions ---------- */
  onApp(() => {
    if (typeof SHEETS === "undefined") return;
    const base = SHEETS.settings;
    SHEETS.settings = function (d){
      const sync = !user ? "Not signed in. Everything saves on this device only." : P.offlineAuth || navigator.onLine === false ? "Offline. Changes are saved here and sync when you're back online." : Object.keys(pend).length ? Object.keys(pend).length + " change(s) waiting to sync…" : "All changes synced.";
      return base(d) + remindersCard() + `<div class="label">Account and data</div><div class="card stack small"><div><b>Account:</b> ${user ? esc(user.email || "signed in") : "not signed in"}</div><div class="xs muted">${sync}</div>
      <div class="row wrapgap">${user ? `<button class="btn small" data-act="ta-signout">Sign out</button>` : `<button class="btn small primary" data-act="ta-signin">Sign in</button>`}<button class="btn small" data-act="ta-reload">Check for updates</button>${user ? `<label class="btn small" style="cursor:pointer">Import a backup<input type="file" accept="application/json,.json" data-ch="ta-import" hidden></label>` : ""}</div>
      <div class="xs muted">Your data is also backed up on the server every night (last 14 days). Download a copy any time from Reports.</div></div>`;
    };
    refreshPushHere().then(() => { if (typeof SHEET !== "undefined" && SHEET && SHEET.type === "settings") renderSheet(); });
  });
  const rerender = () => { if (typeof renderSheet === "function" && typeof SHEET !== "undefined" && SHEET) renderSheet(); };
  document.addEventListener("click", async e => {
    const el = e.target.closest("[data-act]"); if (!el) return;
    const a = el.dataset.act;
    if (a === "ta-signout") { if (Object.keys(pend).length && !confirmSignOut()) return; await sb.auth.signOut(); try { localStorage.removeItem(LS_APP); localStorage.removeItem("turnaround-v2"); localStorage.removeItem(LS_QUEUE); } catch (x) {} location.reload(); }
    if (a === "ta-signin") location.reload();
    if (a === "ta-reload") { if (navigator.serviceWorker) { const r = await navigator.serviceWorker.getRegistration(); if (r) await r.update().catch(() => {}); } location.reload(); }
    if (a === "ta-push-on" || a === "ta-push-off" || a === "ta-push-test") {
      pushState.busy = true; pushState.msg = a === "ta-push-test" ? "Sending…" : ""; rerender();
      try {
        if (a === "ta-push-on") { await pushOn(); pushState.msg = "Reminders are on. Try “Send a test”."; }
        if (a === "ta-push-off") { await pushOff(); pushState.msg = "Reminders are off on this device."; }
        if (a === "ta-push-test") { const r = await pushTest(); pushState.msg = r.sent ? "Sent. It should pop up in a few seconds." : "No device took it. Turn reminders off and on again here."; }
      } catch (x) { pushState.msg = (x && x.message) || "That didn't work. Try again."; }
      pushState.busy = false; rerender();
    }
    if (a === "ta-push-cat") {
      const ps = pushSettings(), k = el.dataset.id; ps.cats[k] = !ps.cats[k];
      await db.doc("push/settings").set(ps); lastVer = -1; syncPushDocs(true); rerender();
    }
  });
  // Signing out with unsynced changes would lose them.
  function confirmSignOut(){ toastMsg("Some changes haven't synced yet. Get online first, then sign out."); return false; }
  function toastMsg(m){ try { if (typeof toast === "function") toast(m); } catch (e) {} }
  document.addEventListener("change", async e => {
    const el = e.target;
    if (el.dataset && el.dataset.ch === "ta-push-evening") { const ps = pushSettings(); ps.evening = el.value || DEF_PUSH.evening; await db.doc("push/settings").set(ps); lastVer = -1; syncPushDocs(true); }
    if (el.dataset && el.dataset.ch === "ta-import" && el.files && el.files[0]) {
      try { const r = await importBackup(el.files[0]); toastMsg(`Imported ${r.added} item(s). ${r.skipped ? r.skipped + " already here, kept yours." : ""}`); }
      catch (x) { toastMsg((x && x.message) || "Couldn't read that file."); }
      el.value = "";
    }
  });

  /* ---------- Home Screen badge + notification taps ---------- */
  function badge(){
    try {
      if (!("setAppBadge" in navigator) || typeof overdueItems !== "function") return;
      const nOver = overdueItems().length;
      if (nOver) navigator.setAppBadge(nOver).catch(() => {}); else navigator.clearAppBadge().catch(() => {});
    } catch (e) {}
  }
  setInterval(badge, 60000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return; setTimeout(badge, 1500);
    if (navigator.serviceWorker) navigator.serviceWorker.getRegistration().then(r => r && r.getNotifications && r.getNotifications().then(ns => ns.forEach(x => x.close()))).catch(() => {});
  });
  if (navigator.serviceWorker) navigator.serviceWorker.addEventListener("message", e => {
    const d = e.data || {}; if (d.type === "open" && d.hash) { if (location.hash !== d.hash) location.hash = d.hash; }
  });
  onApp(() => setTimeout(badge, 3000));
})();
