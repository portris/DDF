// ---------- Firebase fest verdrahtet (deine Config) ----------
// Firebase Config aus externer Datei laden
if (!window.FIREBASE_CONFIG) {
  throw new Error("Firebase Config nicht geladen. Stelle sicher, dass firebase-config.js eingebunden ist.");
}
const firebaseConfig = window.FIREBASE_CONFIG;

// ---------- Hilfsfunktionen (DOM) ----------
const el = (id) => document.getElementById(id);
const show = (id) => { document.querySelectorAll(".view").forEach(v=>v.classList.add("hidden")); el(id).classList.remove("hidden"); };
const setErr = (m) => el("errors").textContent = m || "";
const fmt = (s) => { const m = Math.max(0, Math.floor(s/60)); const r = Math.max(0, Math.floor(s%60)); return `${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`; };
const genCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// ---------- Firebase Init ----------
let app, auth, db, me;
let unsubLobby = null, unsubPlayers = null;

(function initFirebase(){
  try {
    app = firebase.initializeApp(firebaseConfig, "DDF_APP");
  } catch (e) {
    // Falls schon existiert
    app = firebase.app("DDF_APP");
  }
  auth = firebase.auth();
  db = firebase.firestore();

  // Anonyme Anmeldung
  auth.signInAnonymously().catch(e=>{
    setErr("Auth-Fehler: " + (e && e.code ? e.code : e.message || String(e)));
  });
  auth.onAuthStateChanged(async (u)=>{
    if (!u) return;
    me = u;
    // autorisierte Domain-Hinweis
    // (Wichtig: <username>.github.io in Firebase Authentication → Autorisierte Domains hinzufügen!)
  });
})();

// ---------- Datenmodell ----------
// Collection: lobbies/{code}
//   fields: { code, hostUid, state, round, roundEndsAt, settings:{roundSeconds} }
//   sub: players/{uid} -> { uid, name, hearts, alive, joinedAt }
//   doc: votes (pro Runde) als Map: votes[uid]=targetUid (im lobby-doc)

async function createLobby(name) {
  const code = genCode();
  const ref = db.collection("lobbies").doc(code);
  await ref.set({
    code, hostUid: me.uid, state: "lobby", round: 0, roundEndsAt: null,
    settings: { roundSeconds: 180 },
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await ref.collection("players").doc(me.uid).set({
    uid: me.uid, name: name || "Host", hearts: 3, alive: true, joinedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  return code;
}

async function joinLobby(code, name) {
  const ref = db.collection("lobbies").doc(code);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Lobby nicht gefunden.");
  await ref.collection("players").doc(me.uid).set({
    uid: me.uid, name: name || "Spieler", hearts: 3, alive: true, joinedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

function watchLobby(code) {
  const ref = db.collection("lobbies").doc(code);
  unsubLobby = ref.onSnapshot(doc=>{
    if (!doc.exists) return;
    const lobby = doc.data();
    renderLobby(lobby);
    // Timeranzeige
    const tEl = el("timer");
    if (lobby.state === "playing" && lobby.roundEndsAt) {
      const upd = ()=>{
        const secs = Math.ceil((lobby.roundEndsAt.toMillis() - Date.now())/1000);
        tEl.textContent = fmt(secs);
      };
      upd();
      // leichter Poll, ohne setInterval leak
      if (!watchLobby._int) {
        watchLobby._int = setInterval(()=>{
          const s = Math.ceil((lobby.roundEndsAt.toMillis() - Date.now())/1000);
          tEl.textContent = fmt(s);
        }, 500);
      }
    } else {
      tEl.textContent = fmt(lobby.settings?.roundSeconds || 180);
      if (watchLobby._int) { clearInterval(watchLobby._int); watchLobby._int = null; }
    }
  });
  unsubPlayers = ref.collection("players").onSnapshot(qs=>{
    const arr = [];
    qs.forEach(d=>arr.push(d.data()));
    renderPlayers(arr);
    currentPlayers = arr;
  });
}

function stopWatch() {
  if (unsubLobby) { unsubLobby(); unsubLobby = null; }
  if (unsubPlayers) { unsubPlayers(); unsubPlayers = null; }
  if (watchLobby._int) { clearInterval(watchLobby._int); watchLobby._int = null; }
}

// ---------- Render ----------
let currentLobby = null;
let currentPlayers = [];

function renderLobby(lobby) {
  currentLobby = lobby;
  el("roomCode").textContent = lobby.code ? `Code: ${lobby.code}` : "";
  const badge = el("stateBadge");
  badge.textContent = ({
    lobby: "Lobby",
    playing: "Runde läuft",
    voting: "Abstimmung",
    reveal: "Ergebnis",
    finale: "Finale",
    ended: "Beendet"
  })[lobby.state] || "";

  // Host-Panel
  const isHost = me && lobby.hostUid === me.uid;
  const hp = el("hostPanel");
  hp.classList.toggle("hidden", !isHost);

  // Buttons Sichtbarkeit
  el("revealBtn").classList.toggle("hidden", lobby.state !== "reveal");

  // Voting-Panel
  const iAmAlive = currentPlayers.find(p=>p.uid===me?.uid)?.alive !== false;
  const canVote = iAmAlive && lobby.state === "voting";
  el("votingPanel").classList.toggle("hidden", !canVote);

  // Finale / Ende
  el("finalPanel").classList.toggle("hidden", lobby.state !== "finale");
  el("endedPanel").classList.toggle("hidden", lobby.state !== "ended");

  // Finale Namen
  if (lobby.state === "finale") {
    const alive = currentPlayers.filter(p=>p.alive);
    el("finalNames").textContent = `${alive[0]?.name ?? "P1"} vs ${alive[1]?.name ?? "P2"} — 15 Fragen`;
  }

  show("gameView");
}

function renderPlayers(players) {
  const wrap = el("players");
  wrap.innerHTML = "";
  players.forEach(p=>{
    const div = document.createElement("div");
    div.className="player";
    div.innerHTML = `
      <div class="name">${p.name} ${p.uid===currentLobby?.hostUid ? "👑" : ""} ${p.uid===me?.uid ? "(du)":""}</div>
      <div class="hearts">${Array.from({length:3}).map((_,i)=>`<div class="heart ${i < (3 - (p.hearts||0)) ? "dead":""}"></div>`).join("")}</div>
      <div class="muted">${p.alive ? "online" : "ausgeschieden"}</div>
    `;
    wrap.appendChild(div);
  });

  // Voting-Ziele + Status
  const vt = el("voteTargets"); vt.innerHTML="";
  const alive = players.filter(p=>p.alive);
  alive.filter(p=>p.uid!==me?.uid).forEach(p=>{
    const b = document.createElement("button");
    b.textContent = p.name;
    b.onclick = ()=> submitVote(p.uid);
    vt.appendChild(b);
  });
  updateVoteStatus();
}

// ---------- Spielaktionen ----------
async function startGame() {
  const ref = db.collection("lobbies").doc(currentLobby.code);
  // Nur Host
  if (currentLobby.hostUid !== me.uid) return;
  const roundSeconds = Number(el("roundSeconds").value || 180);
  await ref.update({
    state: "playing",
    round: (currentLobby.round || 0) + 1,
    roundEndsAt: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + roundSeconds * 1000)),
    settings: { roundSeconds }
  });
  // Votes leeren
  await ref.set({ votes: {} }, { merge: true });
}

async function submitVote(targetUid) {
  const ref = db.collection("lobbies").doc(currentLobby.code);
  const field = `votes.${me.uid}`;
  await ref.set({ votes: { } }, { merge: true }); // ensures field exists as map
  await ref.update({ [field]: targetUid });

  // Wenn alle lebenden Spieler gevotet haben -> reveal
  const doc = await ref.get();
  const data = doc.data() || {};
  const votes = data.votes || {};
  const living = currentPlayers.filter(p=>p.alive).map(p=>p.uid);
  const received = Object.keys(votes).filter(uid => living.includes(uid)).length;
  if (received >= living.length) {
    if (currentLobby.hostUid === me.uid) {
      await ref.update({ state: "reveal" });
    }
  }
  updateVoteStatus();
}

function updateVoteStatus() {
  const votes = currentLobby?.votes || {};
  const living = currentPlayers.filter(p=>p.alive).length;
  const received = Object.keys(votes).filter(uid => currentPlayers.find(p=>p.uid===uid && p.alive)).length;
  el("voteStatus").textContent = `Stimmen: ${received}/${living}`;
}

// Stimmen auswerten + Herz abziehen (nur Host)
async function revealAndResolve(optionalLoserUid) {
  const ref = db.collection("lobbies").doc(currentLobby.code);
  if (currentLobby.hostUid !== me.uid) return;

  await db.runTransaction(async (tx)=>{
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Lobby fehlt");
    const lobby = snap.data();
    const votes = lobby.votes || {};

    // Tally
    const alive = (await ref.collection("players").get()).docs.map(d=>d.data()).filter(p=>p.alive);
    const ids = alive.map(p=>p.uid);
    const counts = Object.fromEntries(ids.map(id=>[id,0]));
    for (const [voter, target] of Object.entries(votes)) {
      if (ids.includes(voter) && ids.includes(target)) counts[target] += 1;
    }
    // max + leaders
    let max = -1, leaders = [];
    for (const [pid,c] of Object.entries(counts)) {
      if (c > max) { max = c; leaders = [pid]; }
      else if (c === max) { leaders.push(pid); }
    }

    let loser = optionalLoserUid || (leaders.length === 1 ? leaders[0] : null);
    if (!loser) {
      // Gleichstand → nur Zustand aktualisieren, der Host entscheidet später im UI
      tx.update(ref, { state: "reveal" });
      return;
    }

    // Herz abziehen
    const pRef = ref.collection("players").doc(loser);
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists) throw new Error("Spieler fehlt");
    const p = pSnap.data();
    const newHearts = Math.max(0, (p.hearts||3) - 1);
    const stillAlive = newHearts > 0;
    tx.update(pRef, { hearts: newHearts, alive: stillAlive });

    // Prüfen auf Finale / nächste Runde
    const allPlayers = (await ref.collection("players").get()).docs.map(d=>d.data());
    const aliveCount = allPlayers.filter(pp=>pp.alive || pp.uid===loser && stillAlive).length + (stillAlive?0:-1);
    if (aliveCount <= 2) {
      tx.update(ref, { state: "finale" });
    } else {
      const roundSeconds = lobby.settings?.roundSeconds || 180;
      tx.update(ref, {
        state: "playing",
        round: (lobby.round||0) + 1,
        roundEndsAt: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + roundSeconds * 1000)),
        votes: {}
      });
    }
  });
}

// Finale auswerten (nur Host)
async function submitFinal() {
  if (currentLobby.hostUid !== me.uid) return;
  const alive = currentPlayers.filter(p=>p.alive);
  if (alive.length !== 2) return setErr("Finale: Es müssen genau 2 Spieler leben.");
  const p1 = alive[0], p2 = alive[1];
  const p1w = Number(el("finalP1Wrong").value);
  const p2w = Number(el("finalP2Wrong").value);
  if (![p1w,p2w].every(n=>Number.isFinite(n)&&n>=0&&n<=15)) return setErr("Bitte Werte 0–15 eintragen.");

  let loser = null;
  if (p1w !== p2w) loser = p1w > p2w ? p1.uid : p2.uid;
  // Gleichstand → Host soll manuell „Ergebnis veröffentlichen“ mit loser wählen (Tie-Break im UI)

  const ref = db.collection("lobbies").doc(currentLobby.code);
  if (loser) {
    await db.runTransaction(async (tx)=>{
      const pRef = ref.collection("players").doc(loser);
      const ps = await tx.get(pRef);
      if (!ps.exists) return;
      const newHearts = Math.max(0, (ps.data().hearts||3) - 1);
      tx.update(pRef, { hearts: newHearts, alive: newHearts>0 });
      tx.update(ref, { state: "ended" });
    });
  } else {
    await ref.update({ state: "reveal" }); // Host entscheidet
  }
}

// ---------- UI Wiring ----------
let currentCode = null;

function renderTiebreakButtons(leaders) {
  const t = document.getElementById("tiebreak");
  const tgt = document.getElementById("tiebreakTargets");
  t.classList.add("hidden");
  tgt.innerHTML = "";
  if (!leaders || leaders.length <= 1) return;
  t.classList.remove("hidden");
  leaders.forEach(id=>{
    const p = currentPlayers.find(x=>x.uid===id);
    const b = document.createElement("button");
    b.textContent = p ? p.name : id;
    b.onclick = ()=> revealAndResolve(id);
    tgt.appendChild(b);
  });
}

el("createBtn").onclick = async ()=>{
  setErr("");
  try {
    const name = (el("nameInput").value || "").trim() || "Host";
    const code = await createLobby(name);
    currentCode = code;
    watchLobby(code);
    show("gameView");
  } catch (e) {
    setErr("Lobby konnte nicht erstellt werden: " + (e.message || String(e)));
  }
};

el("joinBtn").onclick = async ()=>{
  setErr("");
  try {
    const code = (el("joinCodeInput").value || "").trim().toUpperCase();
    if (!code) return setErr("Code fehlt.");
    const name = (el("nameInput").value || "").trim() || "Spieler";
    await joinLobby(code, name);
    currentCode = code;
    watchLobby(code);
    show("gameView");
  } catch (e) {
    setErr("Beitritt fehlgeschlagen: " + (e.message || String(e)));
  }
};

el("startBtn").onclick = ()=> startGame();
el("applySettings").onclick = async ()=>{
  if (!currentLobby || currentLobby.hostUid !== me.uid) return;
  const rs = Math.max(30, Math.min(900, Number(el("roundSeconds").value||180)));
  await db.collection("lobbies").doc(currentLobby.code).update({ settings: { roundSeconds: rs }});
};

el("revealBtn").onclick = async ()=>{
  // Bei Gleichstand zeigt UI Tiebreak‑Buttons
  // Wir lesen aktuelle Votes und bauen leaders im Client (nur zur Anzeige)
  const ref = db.collection("lobbies").doc(currentLobby.code);
  const snap = await ref.get(); const lobby = snap.data()||{};
  const votes = lobby.votes || {};
  const alive = currentPlayers.filter(p=>p.alive).map(p=>p.uid);
  const counts = Object.fromEntries(alive.map(id=>[id,0]));
  for (const [voter, target] of Object.entries(votes)) {
    if (alive.includes(voter) && alive.includes(target)) counts[target] += 1;
  }
  let max=-1, leaders=[];
  for (const [pid,c] of Object.entries(counts)) { if (c>max){max=c;leaders=[pid]} else if (c===max){leaders.push(pid)} }
  renderTiebreakButtons(leaders);
  await revealAndResolve(leaders.length===1 ? leaders[0] : null);
};

el("finalSubmit").onclick = ()=> submitFinal();

// Initial
show("lobbyView");
