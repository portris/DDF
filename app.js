// ===== Utilities =====
const el = (id) => document.getElementById(id);
const show = (id) => { document.querySelectorAll(".view").forEach(v=>v.classList.add("hidden")); el(id).classList.remove("hidden"); };
const setErr = (m) => { const e = el("errors"); if (e) e.textContent = m || ""; };
const setAuthErr = (m) => { const e = el("authError"); if (e) e.textContent = m || ""; };
const setLobbyErr = (m) => { const e = el("lobbyError"); if (e) e.textContent = m || ""; };
const fmt = (s) => { const m = Math.max(0, Math.floor(s/60)); const r = Math.max(0, Math.floor(s%60)); return `${String(m).padStart(2,"0")}:${String(r).padStart(2,"0")}`; };
const genCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();

// ===== Firebase Init (compat, robust) =====
(function initFirebase() {
  if (typeof firebase === "undefined" || !firebase?.initializeApp) {
    throw new Error("Firebase SDK nicht geladen. Prüfe <script>-Reihenfolge in index.html.");
  }
  const cfg = window.FIREBASE_CONFIG;
  if (!cfg || !cfg.apiKey || !cfg.projectId || !cfg.authDomain) {
    const msg = "Firebase Config fehlt/ist unvollständig. Stelle sicher, dass firebase-config.js VOR app.js eingebunden ist.";
    console.error(msg, { cfg });
    el("authError").textContent = msg;
    throw new Error(msg);
  }
  try {
    if (firebase.apps && firebase.apps.length) {
      window.__APP__ = firebase.app();
    } else {
      window.__APP__ = firebase.initializeApp(cfg);
    }
  } catch (e) {
    try { window.__APP__ = firebase.app(); }
    catch (e2) {
      el("authError").textContent = "Firebase Init fehlgeschlagen: " + (e?.message || String(e));
      throw e2;
    }
  }
  window.__AUTH__ = firebase.auth();
  window.__DB__ = firebase.firestore();
})();

// ===== Auth (E-Mail & Passwort) =====
let currentUser = null;

async function signUp(email, pass) {
  await __AUTH__.createUserWithEmailAndPassword(email, pass);
}
async function signIn(email, pass) {
  await __AUTH__.signInWithEmailAndPassword(email, pass);
}
async function sendReset(email) {
  await __AUTH__.sendPasswordResetEmail(email);
}
async function signOut() {
  await __AUTH__.signOut();
}

__AUTH__.onAuthStateChanged(async (u) => {
  currentUser = u || null;
  if (!u) {
    // Zurück zum Login
    show("authView");
    el("userBadge").textContent = "";
    return;
  }
  // Zeig „angemeldet als …“
  el("userBadge").textContent = `Angemeldet: ${u.email || u.uid}`;
  // Login erfolgreich → Lobby-View anzeigen
  show("lobbyView");
});

// ===== Firestore Modell =====
// lobbies/{code}
//   code, hostUid, state, round, roundEndsAt(Timestamp), settings{roundSeconds}, votes(Map<uid, targetUid>)
// lobbies/{code}/players/{uid}
//   uid, name, hearts(3), alive(bool), joinedAt

let unsubLobby = null, unsubPlayers = null;
let currentLobby = null;
let currentPlayers = [];

function watchLobby(code) {
  const ref = __DB__.collection("lobbies").doc(code);
  if (unsubLobby) { unsubLobby(); unsubLobby = null; }
  if (unsubPlayers) { unsubPlayers(); unsubPlayers = null; }

  unsubLobby = ref.onSnapshot(doc => {
    if (!doc.exists) return;
    const lobby = doc.data();
    currentLobby = lobby;
    renderLobby(lobby);
    // Timer
    const tEl = el("timer");
    if (lobby.state === "playing" && lobby.roundEndsAt) {
      const upd = () => {
        const secs = Math.ceil((lobby.roundEndsAt.toMillis() - Date.now())/1000);
        tEl.textContent = fmt(secs);
      };
      upd();
      if (!watchLobby._int) {
        watchLobby._int = setInterval(() => {
          const secs = Math.ceil((lobby.roundEndsAt.toMillis() - Date.now())/1000);
          tEl.textContent = fmt(secs);
        }, 500);
      }
    } else {
      tEl.textContent = fmt(lobby.settings?.roundSeconds || 180);
      if (watchLobby._int) { clearInterval(watchLobby._int); watchLobby._int = null; }
    }
  });

  unsubPlayers = ref.collection("players").onSnapshot(qs => {
    const arr = [];
    qs.forEach(d => arr.push(d.data()));
    currentPlayers = arr;
    renderPlayers(arr);
    updateVoteStatus();
  });
}

function stopWatch() {
  if (unsubLobby) { unsubLobby(); unsubLobby = null; }
  if (unsubPlayers) { unsubPlayers(); unsubPlayers = null; }
  if (watchLobby._int) { clearInterval(watchLobby._int); watchLobby._int = null; }
}

// ===== Render =====
function renderLobby(lobby) {
  el("roomCode").textContent = lobby.code ? `Code: ${lobby.code}` : "";
  el("stateBadge").textContent = ({
    lobby: "Lobby",
    playing: "Runde läuft",
    voting: "Abstimmung",
    reveal: "Ergebnis",
    finale: "Finale",
    ended: "Beendet"
  })[lobby.state] || "";

  const isHost = currentUser && lobby.hostUid === currentUser.uid;
  el("hostPanel").classList.toggle("hidden", !isHost);
  el("revealBtn").classList.toggle("hidden", lobby.state !== "reveal");

  // Voting sichtbar, wenn ich lebe und state=voting
  const meDoc = currentPlayers.find(p => p.uid === currentUser?.uid);
  const canVote = !!(meDoc && meDoc.alive && lobby.state === "voting");
  el("votingPanel").classList.toggle("hidden", !canVote);

  el("finalPanel").classList.toggle("hidden", lobby.state !== "finale");
  el("endedPanel").classList.toggle("hidden", lobby.state !== "ended");
  if (lobby.state === "finale") {
    const alive = currentPlayers.filter(p => p.alive);
    el("finalNames").textContent = `${alive[0]?.name ?? "P1"} vs ${alive[1]?.name ?? "P2"} — 15 Fragen`;
  }

  show("gameView");
}

function renderPlayers(players) {
  const wrap = el("players");
  wrap.innerHTML = "";
  players.forEach(p => {
    const card = document.createElement("div");
    card.className = "player";
    card.innerHTML = `
      <div class="name">${p.name || "(ohne Name)"} ${p.uid===currentLobby?.hostUid ? "👑" : ""} ${p.uid===currentUser?.uid ? "(du)":""}</div>
      <div class="hearts">${Array.from({length:3}).map((_,i)=>`<div class="heart ${i < (3 - (p.hearts||0)) ? "dead":""}"></div>`).join("")}</div>
      <div class="muted">${p.alive ? "online" : "ausgeschieden"}</div>
    `;
    wrap.appendChild(card);
  });

  // Voting-Ziele
  const vt = el("voteTargets"); vt.innerHTML = "";
  const alive = players.filter(p => p.alive);
  alive.filter(p => p.uid !== currentUser?.uid).forEach(p => {
    const b = document.createElement("button");
    b.textContent = p.name || p.uid.slice(0,6);
    b.onclick = () => submitVote(p.uid);
    vt.appendChild(b);
  });
}

function updateVoteStatus() {
  const votes = currentLobby?.votes || {};
  const living = currentPlayers.filter(p => p.alive).length;
  const received = Object.keys(votes).filter(uid => currentPlayers.find(p => p.uid === uid && p.alive)).length;
  el("voteStatus").textContent = `Stimmen: ${received}/${living}`;
}

// ===== Aktionen =====
async function createLobby(name) {
  const code = genCode();
  const ref = __DB__.collection("lobbies").doc(code);
  await ref.set({
    code,
    hostUid: currentUser.uid,
    state: "lobby",
    round: 0,
    roundEndsAt: null,
    settings: { roundSeconds: 180 },
    votes: {},
    createdAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  await ref.collection("players").doc(currentUser.uid).set({
    uid: currentUser.uid,
    name: name || currentUser.email || "Host",
    hearts: 3,
    alive: true,
    joinedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  return code;
}

async function joinLobby(code, name) {
  const ref = __DB__.collection("lobbies").doc(code);
  const snap = await ref.get();
  if (!snap.exists) throw new Error("Lobby nicht gefunden.");
  await ref.collection("players").doc(currentUser.uid).set({
    uid: currentUser.uid,
    name: name || currentUser.email || "Spieler",
    hearts: 3,
    alive: true,
    joinedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
}

async function startGame() {
  if (!currentLobby) return;
  if (currentLobby.hostUid !== currentUser.uid) return;
  const ref = __DB__.collection("lobbies").doc(currentLobby.code);
  const roundSeconds = Math.max(30, Math.min(900, Number(el("roundSeconds").value || 180)));
  await ref.update({
    state: "playing",
    round: (currentLobby.round || 0) + 1,
    roundEndsAt: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + roundSeconds * 1000)),
    settings: { roundSeconds },
    votes: {}
  });
}

async function submitVote(targetUid) {
  if (!currentLobby) return;
  const ref = __DB__.collection("lobbies").doc(currentLobby.code);
  const field = `votes.${currentUser.uid}`;
  await ref.set({ votes: {} }, { merge: true });
  await ref.update({ [field]: targetUid });

  // Check komplett?
  const doc = await ref.get();
  const data = doc.data() || {};
  const votes = data.votes || {};
  const living = currentPlayers.filter(p => p.alive).map(p => p.uid);
  const received = Object.keys(votes).filter(uid => living.includes(uid)).length;
  if (received >= living.length && currentLobby.hostUid === currentUser.uid) {
    await ref.update({ state: "reveal" });
  }
  updateVoteStatus();
}

async function revealAndResolve(customLoserUid) {
  if (!currentLobby || currentLobby.hostUid !== currentUser.uid) return;
  const ref = __DB__.collection("lobbies").doc(currentLobby.code);

  await __DB__.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Lobby fehlt");
    const lobby = snap.data();
    const votes = lobby.votes || {};

    const playersSnap = await ref.collection("players").get();
    const players = playersSnap.docs.map(d => d.data());
    const alive = players.filter(p => p.alive);
    const ids = alive.map(p => p.uid);
    const counts = Object.fromEntries(ids.map(id => [id, 0]));
    for (const [voter, target] of Object.entries(votes)) {
      if (ids.includes(voter) && ids.includes(target)) counts[target] += 1;
    }
    let max = -1, leaders = [];
    for (const [pid, c] of Object.entries(counts)) {
      if (c > max) { max = c; leaders = [pid]; }
      else if (c === max) { leaders.push(pid); }
    }

    const loser = customLoserUid || (leaders.length === 1 ? leaders[0] : null);
    if (!loser) {
      // Gleichstand – Host entscheidet manuell
      tx.update(ref, { state: "reveal" });
      return;
    }

    const pRef = ref.collection("players").doc(loser);
    const pSnap = await tx.get(pRef);
    if (!pSnap.exists) throw new Error("Spieler fehlt");
    const p = pSnap.data();
    const newH = Math.max(0, (p.hearts || 3) - 1);
    const aliveNext = newH > 0;
    tx.update(pRef, { hearts: newH, alive: aliveNext });

    // zähle Lebende nach Update
    const aliveCount = players.reduce((acc, pl) => acc + ((pl.uid === loser ? aliveNext : pl.alive) ? 1 : 0), 0);
    if (aliveCount <= 2) {
      tx.update(ref, { state: "finale" });
    } else {
      const roundSeconds = lobby.settings?.roundSeconds || 180;
      tx.update(ref, {
        state: "playing",
        round: (lobby.round || 0) + 1,
        roundEndsAt: firebase.firestore.Timestamp.fromDate(new Date(Date.now() + roundSeconds * 1000)),
        votes: {}
      });
    }
  });
}

async function submitFinal() {
  if (!currentLobby || currentLobby.hostUid !== currentUser.uid) return;
  const alive = currentPlayers.filter(p => p.alive);
  if (alive.length !== 2) return setErr("Finale: Es müssen genau 2 Spieler leben.");
  const p1 = alive[0], p2 = alive[1];
  const p1w = Number(el("finalP1Wrong").value);
  const p2w = Number(el("finalP2Wrong").value);
  if (![p1w, p2w].every(n => Number.isFinite(n) && n >= 0 && n <= 15)) {
    setErr("Bitte Werte 0–15 eintragen.");
    return;
  }
  let loser = null;
  if (p1w !== p2w) loser = p1w > p2w ? p1.uid : p2.uid;

  const ref = __DB__.collection("lobbies").doc(currentLobby.code);
  if (loser) {
    await __DB__.runTransaction(async (tx) => {
      const pRef = ref.collection("players").doc(loser);
      const pSnap = await tx.get(pRef);
      if (!pSnap.exists) return;
      const newH = Math.max(0, (pSnap.data().hearts || 3) - 1);
      tx.update(pRef, { hearts: newH, alive: newH > 0 });
      tx.update(ref, { state: "ended" });
    });
  } else {
    await ref.update({ state: "reveal" }); // Host entscheidet manuell
  }
}

// ===== UI Wiring =====
el("loginBtn").onclick = async () => {
  setAuthErr("");
  try {
    const email = (el("authEmail").value || "").trim();
    const pass = (el("authPass").value || "").trim();
    if (!email || !pass) return setAuthErr("E-Mail und Passwort erforderlich.");
    await signIn(email, pass);
  } catch (e) {
    setAuthErr("Login fehlgeschlagen: " + (e?.code || e?.message || String(e)));
  }
};

el("signupBtn").onclick = async () => {
  setAuthErr("");
  try {
    const email = (el("authEmail").value || "").trim();
    const pass = (el("authPass").value || "").trim();
    if (!email || !pass) return setAuthErr("E-Mail und Passwort erforderlich.");
    if (pass.length < 6) return setAuthErr("Passwort muss mind. 6 Zeichen haben.");
    await signUp(email, pass);
  } catch (e) {
    setAuthErr("Registrierung fehlgeschlagen: " + (e?.code || e?.message || String(e)));
  }
};

el("resetBtn").onclick = async () => {
  setAuthErr("");
  try {
    const email = (el("authEmail").value || "").trim();
    if (!email) return setAuthErr("Bitte E-Mail für Passwort-Reset eintragen.");
    await sendReset(email);
    setAuthErr("Reset-Mail gesendet (bitte Posteingang/Spam prüfen).");
  } catch (e) {
    setAuthErr("Reset fehlgeschlagen: " + (e?.code || e?.message || String(e)));
  }
};

el("logoutBtn").onclick = async () => {
  await signOut();
};

let currentCode = null;

el("createBtn").onclick = async () => {
  setLobbyErr("");
  try {
    const name = (el("nameInput").value || "").trim() || (currentUser?.email ?? "Host");
    const code = await createLobby(name);
    currentCode = code;
    watchLobby(code);
    show("gameView");
  } catch (e) {
    setLobbyErr("Lobby konnte nicht erstellt werden: " + (e?.message || String(e)));
  }
};

el("joinBtn").onclick = async () => {
  setLobbyErr("");
  try {
    const code = (el("joinCodeInput").value || "").trim().toUpperCase();
    if (!code) return setLobbyErr("Code fehlt.");
    const name = (el("nameInput").value || "").trim() || (currentUser?.email ?? "Spieler");
    await joinLobby(code, name);
    currentCode = code;
    watchLobby(code);
    show("gameView");
  } catch (e) {
    setLobbyErr("Beitritt fehlgeschlagen: " + (e?.message || String(e)));
  }
};

el("startBtn").onclick = () => startGame();
el("applySettings").onclick = async () => {
  if (!currentLobby || currentLobby.hostUid !== currentUser.uid) return;
  const rs = Math.max(30, Math.min(900, Number(el("roundSeconds").value || 180)));
  await __DB__.collection("lobbies").doc(currentLobby.code).update({ settings: { roundSeconds: rs } });
};
el("revealBtn").onclick = async () => {
  // Client-seitig leaders bestimmen für Tie-Break Buttons
  const ref = __DB__.collection("lobbies").doc(currentLobby.code);
  const snap = await ref.get(); const lobby = snap.data() || {};
  const votes = lobby.votes || {};
  const alive = currentPlayers.filter(p => p.alive).map(p => p.uid);
  const counts = Object.fromEntries(alive.map(id => [id, 0]));
  for (const [voter, target] of Object.entries(votes)) {
    if (alive.includes(voter) && alive.includes(target)) counts[target] += 1;
  }
  let max = -1, leaders = [];
  for (const [pid, c] of Object.entries(counts)) { if (c > max) { max = c; leaders = [pid]; } else if (c === max) { leaders.push(pid); } }
  renderTiebreakButtons(leaders);
  await revealAndResolve(leaders.length === 1 ? leaders[0] : null);
};
el("finalSubmit").onclick = () => submitFinal();

function renderTiebreakButtons(leaders) {
  const t = document.getElementById("tiebreak");
  const tgt = document.getElementById("tiebreakTargets");
  t.classList.add("hidden");
  tgt.innerHTML = "";
  if (!leaders || leaders.length <= 1) return;
  t.classList.remove("hidden");
  leaders.forEach(id => {
    const p = currentPlayers.find(x => x.uid === id);
    const b = document.createElement("button");
    b.textContent = p ? p.name : id;
    b.onclick = () => revealAndResolve(id);
    tgt.appendChild(b);
  });
}

// Startansicht
show("authView");
