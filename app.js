/* Bluff Show — the screen flow.
   Three ways to use a device:
     mode 'local' — pass-one-device game. This device runs the rules.
     mode 'host'  — the TV/laptop in room mode. This device runs the rules and
                    sends everyone a view of the game after every change.
     mode 'phone' — a player's phone in room mode. It only shows what the host
                    sent and sends back the player's moves.
*/
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = id => (state && state.players.find(p => p.id === id) || {}).name || '?';

const CATS = ['Animals', 'History', 'Food', 'Weird Laws', 'Malaysia', 'Science'];
const LETTERS = 'ABCDEFGHIJKL';
const MIN_PLAYERS = 3, MAX_LOCAL = 8, MAX_ROOM = 10;
const PICK_SEC = 45;
const REVEAL_MS = { lie: 6000, truth: 9000, scores: 10000 };

// ---------- saved settings ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem('bluff.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('bluff.' + k, JSON.stringify(v)); } catch { } },
};
const settings = Object.assign({ rounds: 7, writeSec: 90, sound: 1, useCustom: 1, cats: CATS.slice() }, store.get('settings', {}));
let names = store.get('players', ['', '', '']);
let custom = store.get('custom', []);   // [{ q, a, by }]

let mode = null;     // 'local' | 'host' | 'phone'
let state = null;    // the engine's game state (local and host only)
let room = null;     // the open room connection
let roomCode = '';

// ---------- screens ----------
function show(id) {
  for (const s of $$('.screen')) s.hidden = s.id !== id;
  $('#' + id).scrollTop = 0;
  document.body.dataset.screen = id;
}
const current = () => document.body.dataset.screen;

function toast(msg, ms = 2600) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// Keep screens sized to the visible area when a phone keyboard opens.
function syncViewport() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--vh', h / 100 + 'px');
}
(window.visualViewport || window).addEventListener('resize', syncViewport);
syncViewport();

// Question text with its blank drawn as a line.
function questionHtml(q) {
  const parts = esc(q.q).split('____');
  let html = parts.length > 1 ? parts.join('<span class="blank">&nbsp;</span>') : esc(q.q);
  if (q.author) html += `<span class="by">Written by ${esc(nameOf(q.author) === '?' ? 'a player' : nameOf(q.author))}</span>`;
  return html;
}

// ---------- effects and sound ----------
// fx.js does the confetti, bursts and real sounds. If it never loaded, this
// stand-in answers every call with "no", and the tones below take over.
const fx = window.FX || { sound: () => false, burst() {}, confetti() {}, ring() {}, flash() {}, shake() {}, pop() {} };

// The tones are made in code. They are the fallback: they cover the first tap,
// before the browser lets a sound file play, and a browser where fx.js failed.
let audio = null;
function tone(freq, dur, { type = 'triangle', vol = 0.12, delay = 0, slide = 0 } = {}) {
  if (!settings.sound) return;
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const t = audio.currentTime + delay;
    const o = audio.createOscillator(), g = audio.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audio.destination);
    o.start(t); o.stop(t + dur + 0.05);
  } catch { }
}
const tones = {
  click: () => tone(660, 0.06, { type: 'square', vol: 0.05 }),
  pop: () => { tone(520, 0.08, { vol: 0.1 }); tone(880, 0.12, { vol: 0.1, delay: 0.07 }); },
  join: () => [523, 659, 784].forEach((f, i) => tone(f, 0.15, { delay: i * 0.08 })),
  drum: () => { for (let i = 0; i < 14; i++) tone(90 + (i % 2) * 20, 0.05, { type: 'square', vol: 0.05 + i * 0.004, delay: i * 0.045 }); },
  wah: () => [392, 370, 349, 294].forEach((f, i) => tone(f, i === 3 ? 0.7 : 0.28, { type: 'sawtooth', vol: 0.07, delay: 0.25 + i * 0.3, slide: i === 3 ? 0.9 : 1 })),
  ding: () => [784, 988, 1319].forEach((f, i) => tone(f, 0.35, { type: 'sine', vol: 0.14, delay: 0.25 + i * 0.12 })),
  fanfare: () => [523, 523, 523, 698, 880, 1047].forEach((f, i) => tone(f, i === 5 ? 0.8 : 0.16, { type: 'square', vol: 0.06, delay: i * 0.14 })),
};
tones.win = tones.fanfare;
// Each sound: the real one if fx.js can play it, otherwise its tone.
const sfx = Object.fromEntries(Object.entries(tones).map(([name, fallback]) =>
  [name, () => { if (settings.sound && !fx.sound(name)) fallback(); }]));
// The drum roll is fourteen beats of one thud, building up.
sfx.drum = () => {
  if (!settings.sound) return;
  for (let i = 0; i < 14; i++) {
    if (!fx.sound('hit', { delay: i * 0.045, volume: 0.35 + i * 0.05 })) return tones.drum();
  }
};

// ---------- keep the screen awake during a game ----------
let wakeLock = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch { }
}
document.addEventListener('visibilitychange', () => { if (mode && document.visibilityState === 'visible') keepAwake(); });

// =====================================================================
// HOME
// =====================================================================
function goHome() {
  clearTimers();
  if (room) { try { room.close(); } catch { } room = null; }
  if (mode === 'phone') store.set('lastRoom', null);
  mode = null; state = null;
  $('#net').hidden = true;
  $('#room-off').hidden = Room.isConfigured();
  show('home');
}
$$('[data-home]').forEach(b => b.addEventListener('click', goHome));
$('#go-local').onclick = () => openSetup('local');
$('#go-host').onclick = () => Room.isConfigured() ? openSetup('host') : toast('Room mode needs the Supabase address in config.js first.');
$('#go-join').onclick = () => Room.isConfigured() ? openJoin() : toast('Room mode needs the Supabase address in config.js first.');

// =====================================================================
// SETUP
// =====================================================================
let setupFor = 'local';
function openSetup(kind) {
  setupFor = kind;
  $('#setup-title').textContent = kind === 'local' ? 'Pass-the-device game' : 'Host a room';
  $('#players-panel').hidden = kind !== 'local';
  $('#timer-panel').hidden = kind === 'local';
  $('#start').textContent = kind === 'local' ? 'Start the show!' : 'Open the room';
  $('#setup-error').hidden = true;
  renderPlayers(); renderSettings();
  show('setup');
}

function renderPlayers() {
  while (names.length < MIN_PLAYERS) names.push('');
  $('#player-list').innerHTML = names.map((n, i) => `
    <div class="player-row">
      <input class="field" maxlength="14" placeholder="Player ${i + 1}" value="${esc(n)}" data-i="${i}" enterkeyhint="next">
      <button class="x" data-remove="${i}" aria-label="Remove player" ${names.length <= MIN_PLAYERS ? 'disabled' : ''}>×</button>
    </div>`).join('');
  $('#player-count').textContent = `(${names.length})`;
  $('#add-player').hidden = names.length >= MAX_LOCAL;
}
$('#player-list').addEventListener('input', e => {
  if (e.target.dataset.i === undefined) return;
  names[+e.target.dataset.i] = e.target.value;
  store.set('players', names);
});
$('#player-list').addEventListener('click', e => {
  const i = e.target.dataset.remove;
  if (i === undefined || names.length <= MIN_PLAYERS) return;
  names.splice(+i, 1);
  store.set('players', names);
  renderPlayers();
});
$('#add-player').onclick = () => {
  names.push('');
  renderPlayers();
  $$('#player-list input').at(-1).focus();
};

function renderSettings() {
  for (const seg of $$('.seg[data-key]')) {
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', String(settings[seg.dataset.key]) === b.dataset.v);
  }
  $('#cats').innerHTML = CATS.map(c => {
    const n = QUESTIONS.filter(q => q.cat === c).length;
    return `<button class="chip ${settings.cats.includes(c) ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)} <span class="muted">${n}</span></button>`;
  }).join('');
  const available = QUESTIONS.filter(q => settings.cats.includes(q.cat)).length;
  $('#cat-count').textContent = `(${available} questions)`;
  $('#custom-summary').textContent = custom.length
    ? `${custom.length} question${custom.length === 1 ? '' : 's'} written.${settings.useCustom ? ' They come up first.' : ''}`
    : 'None yet. Write questions about people in the room!';
}
$('#setup').addEventListener('click', e => {
  const b = e.target.closest('.seg[data-key] button');
  if (b) {
    const key = b.parentElement.dataset.key;
    settings[key] = +b.dataset.v;
    store.set('settings', settings);
    sfx.click();
    renderSettings();
  }
  const chip = e.target.closest('[data-cat]');
  if (chip) {
    const c = chip.dataset.cat;
    settings.cats = settings.cats.includes(c) ? settings.cats.filter(x => x !== c) : [...settings.cats, c];
    store.set('settings', settings);
    sfx.click();
    renderSettings();
  }
});

// Build this game's question list. Custom questions name their writer by name;
// that name is matched to a player so they sit that round out.
function chooseQuestions(players) {
  const byName = n => { const p = players.find(x => x.name.toLowerCase() === String(n || '').trim().toLowerCase()); return p ? p.id : null; };
  const mine = settings.useCustom ? custom.map(c => ({ q: c.q, a: c.a, author: byName(c.by), fact: '' })) : [];
  const qs = Engine.pickQuestions({ bank: QUESTIONS, cats: settings.cats, custom: mine, rounds: settings.rounds, seen: store.get('seen', []) });
  store.set('seen', [...store.get('seen', []), ...qs.map(q => q.q)].slice(-120));
  return qs;
}

function setupError(msg) {
  $('#setup-error').textContent = msg;
  $('#setup-error').hidden = false;
  $('#setup-error').scrollIntoView({ block: 'center', behavior: 'smooth' });
}

$('#start').onclick = () => {
  const poolSize = QUESTIONS.filter(q => settings.cats.includes(q.cat)).length + (settings.useCustom ? custom.length : 0);
  if (!poolSize) return setupError('Pick at least one category.');
  if (setupFor === 'host') return openRoom();

  const clean = names.map(n => n.trim()).filter(Boolean);
  if (clean.length < MIN_PLAYERS) return setupError(`You need at least ${MIN_PLAYERS} players.`);
  if (new Set(clean.map(n => n.toLowerCase())).size !== clean.length) return setupError('Two players have the same name.');
  const players = clean.map((name, i) => ({ id: 'p' + i, name }));
  mode = 'local';
  state = Engine.newGame({ players, questions: chooseQuestions(players) });
  if (state.rounds < settings.rounds) toast(`Only ${state.rounds} questions in those categories, so ${state.rounds} rounds.`);
  keepAwake();
  sfx.fanfare();
  nextRound();
};

// =====================================================================
// CUSTOM QUESTIONS
// =====================================================================
$('#edit-custom').onclick = () => { renderCustom(); show('custom'); };
$('#custom-back').onclick = () => { renderSettings(); show('setup'); };
function renderCustom() {
  $('#custom-list').innerHTML = custom.length ? custom.map((c, i) => `
    <div class="custom-item">
      <div class="txt">${esc(c.q)}<br><span class="ans">${esc(c.a)}</span> <span class="muted">${c.by ? '· by ' + esc(c.by) : ''}</span></div>
      <button class="x" data-del="${i}" aria-label="Delete question">×</button>
    </div>`).join('') : '<p class="muted">No questions yet.</p>';
}
$('#custom-list').addEventListener('click', e => {
  const i = e.target.dataset.del;
  if (i === undefined) return;
  custom.splice(+i, 1);
  store.set('custom', custom);
  renderCustom();
});
$('#custom-form').addEventListener('submit', e => {
  e.preventDefault();
  let q = $('#c-q').value.trim().replace(/_{2,}/g, '____');
  const a = $('#c-a').value.trim(), by = $('#c-by').value.trim();
  const err = m => { $('#custom-error').textContent = m; $('#custom-error').hidden = false; };
  if (q.length < 8) return err('Write the question first.');
  if (!a) return err('Add the true answer.');
  if (!q.includes('____')) q = q.replace(/[.?!]*$/, '') + ': ____.';
  custom.push({ q, a, by });
  store.set('custom', custom);
  $('#custom-error').hidden = true;
  $('#c-q').value = $('#c-a').value = '';
  sfx.pop();
  renderCustom();
  $('#c-q').focus();
});

// =====================================================================
// TIMERS (room mode) and the auto-advance during reveals
// =====================================================================
let deadline = 0, tickHandle = 0, stepHandle = 0;
function clearTimers() {
  clearInterval(tickHandle); clearTimeout(stepHandle);
  deadline = 0; tickHandle = 0; stepHandle = 0;
  $('#b-timer-row').hidden = true;
}
function startCountdown(sec, onEnd) {
  clearInterval(tickHandle);
  if (!sec) { deadline = 0; $('#b-timer-row').hidden = true; return; }
  const total = sec * 1000;
  deadline = Date.now() + total;
  $('#b-timer-row').hidden = false;
  const tick = () => {
    const left = Math.max(0, deadline - Date.now());
    $('#b-timer').style.transform = `scaleX(${left / total})`;
    $('#b-timer-num').textContent = Math.ceil(left / 1000);
    if (left <= 5000 && left > 0 && Math.ceil(left / 1000) !== tick.last) { tick.last = Math.ceil(left / 1000); tone(880, 0.05, { type: 'square', vol: 0.04 }); }
    if (!left) { clearInterval(tickHandle); tickHandle = 0; deadline = 0; onEnd(); }
  };
  tick();
  tickHandle = setInterval(tick, 250);
}
const remaining = () => (deadline ? Math.max(0, deadline - Date.now()) : 0);

// =====================================================================
// THE GAME LOOP (shared by pass-the-device and the host screen)
// =====================================================================
function nextRound() {
  Engine.startRound(state);
  if (state.phase === 'final') return showFinal();
  if (mode === 'host') startCountdown(settings.writeSec, () => { lockLies(); });
  renderBoard();
  broadcast();
}

function lockLies() {
  if (state.phase !== 'write') return;
  Engine.startPicking(state);
  sfx.drum();
  if (mode === 'host') startCountdown(settings.writeSec ? PICK_SEC : 0, () => lockPicks());
  renderBoard();
  broadcast();
}

function lockPicks() {
  if (state.phase !== 'pick') return;
  clearTimers();
  Engine.startReveal(state);
  broadcast();
  revealIndex = 0;
  showReveal();
}

function renderBoard() {
  const q = Engine.question(state);
  const active = Engine.activePlayers(state);
  $('#b-round').textContent = `ROUND ${state.round + 1} / ${state.rounds}`;
  $('#b-double').hidden = !Engine.isFinalRound(state);
  $('#b-cat').textContent = q.cat.toUpperCase();
  $('#b-question').innerHTML = questionHtml(q);
  $('#b-room-hint').hidden = mode !== 'host';
  $('#b-code').textContent = roomCode;

  const writing = state.phase === 'write';
  const doneIds = writing ? Object.keys(state.lies) : Object.keys(state.picks);
  $('#b-tiles').innerHTML = state.players.map(p => {
    const out = !active.includes(p);
    const done = doneIds.includes(p.id);
    return `<span class="tile ${done ? 'done' : ''} ${out ? 'out' : ''}"><span class="mark">${out ? '✎' : done ? '✓' : '…'}</span>${esc(p.name)}</span>`;
  }).join('');

  if (writing) {
    $('#b-heading').textContent = mode === 'host' ? 'Write your lies on your phones!' : 'Everyone writes a fake answer';
    $('#b-choices').innerHTML = '';
  } else {
    $('#b-heading').textContent = mode === 'host' ? 'Pick the truth on your phones!' : 'Which one is true?';
    $('#b-choices').innerHTML = state.choices.map((c, i) => `<div class="choice"><span class="letter">${LETTERS[i]}</span>${esc(c.text)}</div>`).join('');
  }

  const sitting = state.players.filter(p => !active.includes(p));
  $('#b-note').textContent = sitting.length ? `${sitting.map(p => p.name).join(', ')} wrote this question and sits it out.` : '';

  if (mode === 'local') {
    const next = localQueueNext();
    $('#b-go').hidden = false;
    $('#b-go').textContent = next ? `Pass to ${next.name} to ${writing ? 'write' : 'pick'} →` : 'Continue →';
    $('#b-skip').hidden = true;
  } else {
    $('#b-go').hidden = true;
    $('#b-skip').hidden = false;
    $('#b-skip').textContent = writing ? 'Stop writing now' : 'Stop picking now';
  }
  if (current() !== 'board') show('board');
}

// ---------- pass-the-device turns ----------
function localQueueNext() {
  const done = state.phase === 'write' ? state.lies : state.picks;
  return Engine.activePlayers(state).find(p => !done[p.id] && !skipped.has(p.id));
}
const skipped = new Set();
let turnPlayer = null;

$('#b-go').onclick = () => {
  if (mode !== 'local') return;
  const next = localQueueNext();
  if (next) return showPass(next);
  advanceLocal();
};
$('#b-skip').onclick = () => { state.phase === 'write' ? lockLies() : lockPicks(); };

function advanceLocal() {
  skipped.clear();
  if (state.phase === 'write') lockLies();
  else if (state.phase === 'pick') lockPicks();
}

function showPass(p) {
  turnPlayer = p;
  $('#pass-name').textContent = p.name;
  $('#pass-why').textContent = state.phase === 'write' ? 'to write a fake answer' : 'to pick the true answer';
  $('#pass-go').textContent = `I'm ${p.name}, show me`;
  show('pass');
}
$('#pass-go').onclick = () => {
  sfx.click();
  if (state.phase === 'write') openWrite(Engine.question(state), turnPlayer.name, Object.values(state.lies));
  else openPick(Engine.question(state), turnPlayer.name, Engine.choicesFor(state, turnPlayer.id));
};
$('#pass-skip').onclick = () => {
  skipped.add(turnPlayer.id);
  afterLocalTurn();
};
function afterLocalTurn() {
  const next = localQueueNext();
  if (next) showPass(next);
  else advanceLocal();
}

// ---------- the private write screen ----------
let writeQuestion = null, ideaUsed = [];
function openWrite(q, who, takenLies = []) {
  writeQuestion = q;
  ideaUsed = takenLies.map(Engine.norm);
  $('#w-who').textContent = who;
  $('#w-question').innerHTML = questionHtml(q);
  $('#lie').value = '';
  $('#write-error').hidden = true;
  $('#idea').hidden = !(q.decoys && q.decoys.length) && mode !== 'phone';
  show('write');
  setTimeout(() => $('#lie').focus({ preventScroll: true }), 350);
}
$('#idea').onclick = () => {
  // Phones don't hold the question's decoys, so they ask the host for one.
  if (mode === 'phone') return send({ t: 'idea', pid: myId });
  const options = (writeQuestion.decoys || []).filter(d => !ideaUsed.includes(Engine.norm(d)));
  if (!options.length) return toast("Out of ideas, you're on your own!");
  const d = options[Math.floor(Math.random() * options.length)];
  ideaUsed.push(Engine.norm(d));
  $('#lie').value = d;
  sfx.click();
};
const LIE_ERRORS = {
  empty: 'Write something first!',
  long: 'Keep it under 60 characters.',
  truth: "That's too close to the REAL answer! Try another lie.",
  phase: 'Too late, writing time is over.',
  player: "You're sitting this one out.",
};
function writeError(reason) {
  $('#write-error').textContent = LIE_ERRORS[reason] || 'Try again.';
  $('#write-error').hidden = false;
  tone(180, 0.25, { type: 'sawtooth', vol: 0.08 });
}
$('#write-form').addEventListener('submit', e => {
  e.preventDefault();
  const text = $('#lie').value;
  if (mode === 'phone') return phoneSubmitLie(text);
  const err = Engine.submitLie(state, turnPlayer.id, text);
  if (err) return writeError(err);
  $('#lie').blur();
  sfx.pop();
  afterLocalTurn();
});

// ---------- the private pick screen ----------
let pickChoice = null;
function openPick(q, who, choices) {
  pickChoice = null;
  $('#p-who').textContent = who;
  $('#p-question').innerHTML = questionHtml(q);
  $('#p-choices').innerHTML = choices.map((c, i) => `<button class="choice" data-id="${c.id}"><span class="letter">${LETTERS[i]}</span>${esc(c.text)}</button>`).join('');
  $('#pick-lock').disabled = true;
  $('#pick-error').hidden = true;
  show('pick');
}
$('#p-choices').addEventListener('click', e => {
  const b = e.target.closest('.choice');
  if (!b) return;
  pickChoice = b.dataset.id;
  $$('#p-choices .choice').forEach(x => x.classList.toggle('on', x === b));
  $('#pick-lock').disabled = false;
  sfx.click();
});
$('#pick-lock').onclick = () => {
  if (!pickChoice) return;
  if (mode === 'phone') return phoneSubmitPick(pickChoice);
  const err = Engine.submitPick(state, turnPlayer.id, pickChoice);
  if (err) { $('#pick-error').textContent = "You can't pick your own lie!"; $('#pick-error').hidden = false; return; }
  sfx.pop();
  afterLocalTurn();
};

// ---------- the reveal ----------
let revealIndex = 0;
function showReveal() {
  const q = Engine.question(state);
  const step = state.steps[revealIndex];
  const last = revealIndex === state.steps.length - 1;
  $('#r-round').textContent = `ROUND ${state.round + 1} / ${state.rounds}`;
  $('#r-count').textContent = `${revealIndex + 1} OF ${state.steps.length}`;
  $('#r-question').innerHTML = questionHtml(q);

  const names = ids => ids.map(nameOf);
  const list = arr => arr.length <= 2 ? arr.join(' and ') : arr.slice(0, -1).join(', ') + ' and ' + arr.at(-1);
  $('#r-spot').innerHTML = `<div class="answer-card ${step.truth ? 'truth' : ''}">${esc(step.text)}
    <span class="stamp ${step.truth ? 'true' : 'lie'}" style="animation-delay:1.6s">${step.truth ? 'TRUTH!' : 'LIE!'}</span></div>`;

  let detail = '';
  if (step.pickers.length) {
    detail += `<p class="center muted later" style="animation-delay:.5s">${step.truth ? 'Found by' : 'Fell for it'}</p>
      <div class="pickers">${names(step.pickers).map((n, i) => `<span class="tile" style="animation-delay:${0.7 + i * 0.15}s">${esc(n)}</span>`).join('')}</div>`;
  } else if (step.truth) {
    detail += `<p class="verdict later" style="animation-delay:.5s">Nobody found the truth!</p>`;
  }
  if (step.truth) {
    if (step.pickers.length) detail += `<p class="verdict later" style="animation-delay:2s"><span class="plus">+${step.points}</span> each</p>`;
    if (q.fact) detail += `<p class="fact later" style="animation-delay:2.4s">${esc(q.fact)}</p>`;
  } else if (step.house) {
    detail += `<p class="verdict later" style="animation-delay:2s">A <b>house lie</b>, written by the Bluff Show itself!</p>`;
  } else {
    detail += `<p class="verdict later" style="animation-delay:2s">Written by <b>${esc(list(names(step.authors)))}</b> <span class="plus">+${step.points}</span></p>`;
  }
  $('#r-detail').innerHTML = detail;
  $('#r-next').textContent = last ? 'See the scores →' : 'Next answer →';
  $('#r-next').hidden = false;
  show('reveal');
  sfx.drum();
  setTimeout(() => (step.truth ? sfx.ding : sfx.wah)(), 1300);

  // The stamp lands at 1.6 s. TRUTH gets a golden flash and a shower of stars;
  // a LIE gets the card shaken and a red spray. Skipped if the host has
  // already moved on to the next answer.
  const shown = revealIndex;
  setTimeout(() => {
    if (revealIndex !== shown || current() !== 'reveal') return;
    const stamp = $('#r-spot .stamp');
    if (step.truth) {
      fx.flash('#ffc53d', 0.22);
      fx.burst(stamp, { kind: 'star', colors: ['#ffc53d', '#fff4b8', '#1fd6c6'], count: 36 });
    } else {
      fx.shake($('#r-spot .answer-card'), 12);
      fx.burst(stamp, { colors: ['#ff4655', '#ff3d8b'], count: 26 });
    }
  }, 1600);
  // ...and the points, when they appear at 2 s: a pop and a ring rather than
  // sparks, because sparks on the badge would hide the number being announced.
  setTimeout(() => {
    if (revealIndex !== shown || current() !== 'reveal') return;
    $$('#r-detail .plus').forEach(el => { fx.pop(el); fx.ring(el, '#ffc53d'); });
  }, 2050);

  if (mode === 'host') {
    broadcast({ step: revealIndex });
    clearTimeout(stepHandle);
    stepHandle = setTimeout(revealNext, step.truth ? REVEAL_MS.truth : REVEAL_MS.lie);
  }
}
function revealNext() {
  clearTimeout(stepHandle);
  if (revealIndex < state.steps.length - 1) { revealIndex++; return showReveal(); }
  showScores();
}
$('#r-next').onclick = revealNext;

function showScores() {
  clearTimeout(stepHandle);
  Engine.showScores(state);
  const lastRound = state.round === state.rounds - 1;
  $('#s-title').textContent = lastRound ? 'FINAL SCORES' : `AFTER ROUND ${state.round + 1}`;
  $('#s-list').innerHTML = scoreRows(Engine.standings(state), state.lastGain);
  $('#s-next').textContent = lastRound ? 'And the winner is… →' : 'Next round →';
  show('scores');
  sfx.pop();
  // A pop and a ring on every score that went up, as its row slides in --
  // around the number, never over it.
  $$('#s-list .score-row').forEach((row, i) => {
    const gain = row.querySelector('.gain');
    if (gain) setTimeout(() => { if (current() === 'scores') { fx.pop(gain); fx.ring(gain, '#1fd6c6'); } }, 450 + i * 80);
  });
  broadcast();
  if (mode === 'host') stepHandle = setTimeout(scoresNext, REVEAL_MS.scores);
}
function scoreRows(list, gain = {}, rankOffset = 0) {
  const top = Math.max(1, ...list.map(p => p.score));
  return list.map((p, i) => `
    <div class="score-row ${i + rankOffset === 0 && p.score > 0 ? 'first' : ''}" style="animation-delay:${i * 0.08}s">
      <span class="rank">${i + rankOffset + 1}</span>
      <div><div class="who">${esc(p.name)}</div><div class="bar" style="width:${Math.max(3, p.score / top * 100)}%"></div></div>
      <span class="pts">${p.score}${gain[p.id] ? `<span class="gain">+${gain[p.id]}</span>` : ''}</span>
    </div>`).join('');
}
function scoresNext() {
  clearTimeout(stepHandle);
  nextRound();
}
$('#s-next').onclick = scoresNext;

function showFinal() {
  clearTimers();
  const list = Engine.standings(state);
  const order = [1, 0, 2];
  $('#f-podium').innerHTML = order.filter(i => list[i]).map(i => `
    <div class="step p${i + 1}"><div class="who">${esc(list[i].name)}</div><div class="muted">${list[i].score}</div><div class="block">${i + 1}</div></div>`).join('');
  const aw = Engine.awards(state);
  $('#f-awards').innerHTML = [
    aw.liar && `<div class="award"><span class="icon">🤥</span><div><b>Master Liar: ${esc(aw.liar.name)}</b><br><span class="muted">fooled players ${aw.liar.count} time${aw.liar.count === 1 ? '' : 's'}</span></div></div>`,
    aw.detective && `<div class="award"><span class="icon">🔍</span><div><b>Truth Detective: ${esc(aw.detective.name)}</b><br><span class="muted">found the truth ${aw.detective.count} time${aw.detective.count === 1 ? '' : 's'}</span></div></div>`,
  ].filter(Boolean).join('') || '<p class="muted center">No awards this time!</p>';
  $('#f-rest').innerHTML = scoreRows(list.slice(3), {}, 3);
  $('#again').textContent = mode === 'host' ? 'Play again (same room)' : 'Play again';
  show('final');
  sfx.win();
  fx.confetti({ count: 90 });
  // Stars over the winner's step once the podium has risen.
  setTimeout(() => current() === 'final' && fx.burst('#f-podium .p1', { kind: 'star', colors: ['#ffc53d', '#fff4b8'], count: 40 }), 700);
  broadcast();
}
$('#again').onclick = () => {
  const players = state.players.map(p => ({ id: p.id, name: p.name }));
  if (mode === 'local') {
    // rotate who goes first so the same person doesn't always start
    players.push(players.shift());
  }
  state = Engine.newGame({ players, questions: chooseQuestions(players) });
  nextRound();
};

// =====================================================================
// ROOM MODE — HOST
// =====================================================================
let heartbeat = 0;
async function openRoom() {
  mode = 'host';
  roomCode = Room.makeCode();
  state = Engine.newGame({ players: [], questions: [] });
  const url = location.origin + location.pathname;
  const joinLink = url + '?room=' + roomCode + location.search.replace(/^\?/, '&');
  $('#join-url').textContent = url.replace(/^https?:\/\//, '').replace(/index\.html$/, '');
  $('#room-code').textContent = roomCode;
  renderLobby();
  show('lobby');
  Room.qrSvg(joinLink).then(svg => { $('#qr').innerHTML = svg; }).catch(() => { $('#qr').hidden = true; });
  try {
    room = await Room.join(roomCode, onHostMessage, netStatus);
  } catch (err) {
    toast('Could not open the room: ' + err.message, 5000);
    return goHome();
  }
  clearInterval(heartbeat);
  heartbeat = setInterval(() => mode === 'host' ? broadcast() : clearInterval(heartbeat), 3000);
  keepAwake();
}

function netStatus(s) { $('#net').hidden = s === 'connected'; }

function renderLobby() {
  const ps = state.players;
  $('#lobby-count').textContent = `(${ps.length}/${MAX_ROOM})`;
  $('#lobby-players').innerHTML = ps.length
    ? ps.map((p, i) => `<span class="tile done">${i === 0 ? '⭐ ' : ''}${esc(p.name)}<button data-kick="${p.id}" aria-label="Remove">×</button></span>`).join('')
    : '<p class="muted">Nobody yet.</p>';
  $('#lobby-start').disabled = ps.length < MIN_PLAYERS;
  $('#lobby-hint').textContent = ps.length < MIN_PLAYERS
    ? `Waiting for at least ${MIN_PLAYERS} players… (⭐ can start the game from their phone)`
    : 'Everyone in? Start the show! Tap × to remove a player.';
}
$('#lobby-players').addEventListener('click', e => {
  const id = e.target.dataset.kick;
  if (!id) return;
  Engine.removePlayer(state, id);
  send({ t: 'reject', pid: id, reason: 'kicked' });
  renderLobby();
  broadcast();
});
$('#lobby-start').onclick = startHostGame;

function startHostGame() {
  if (state.phase !== 'lobby' || state.players.length < MIN_PLAYERS) return;
  const players = state.players.map(p => ({ id: p.id, name: p.name }));
  state = Engine.newGame({ players, questions: chooseQuestions(players) });
  sfx.fanfare();
  nextRound();
}

function send(msg) { if (room) try { room.send(msg); } catch { } }

// Everything phones may know, plus a timer and the reveal position.
function broadcast(extra = {}) {
  if (mode !== 'host' || !room) return;
  send({
    t: 'state',
    v: { ...Engine.publicView(state), remaining: remaining(), vip: state.players[0] ? state.players[0].id : null, step: revealIndex, ...extra },
  });
}

function onHostMessage(msg) {
  if (!msg || !msg.pid) return;
  const player = state.players.find(p => p.id === msg.pid);
  switch (msg.t) {
    case 'hello': {
      if (!player) {
        const name = String(msg.name || '').trim().slice(0, 14);
        if (!name) return;
        if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) return send({ t: 'reject', pid: msg.pid, reason: 'name' });
        if (state.players.length >= MAX_ROOM) return send({ t: 'reject', pid: msg.pid, reason: 'full' });
        if (state.phase === 'final') return send({ t: 'reject', pid: msg.pid, reason: 'over' });
        Engine.addPlayer(state, { id: msg.pid, name });
        sfx.join();
        toast(`${name} joined!`);
        if (state.phase === 'lobby') {
          renderLobby();
          const tile = $('#lobby-players .tile:last-child');
          fx.pop(tile);
          fx.burst(tile, { kind: 'star', count: 16 });
        } else if (current() === 'board') renderBoard();
      }
      return broadcast();
    }
    case 'lie': {
      if (!player) return;
      const err = Engine.submitLie(state, msg.pid, msg.text);
      if (err) { send({ t: 'reject', pid: msg.pid, reason: err, about: 'lie' }); return broadcast(); }
      sfx.pop();
      if (Engine.allLiesIn(state)) return lockLies();
      renderBoard();
      return broadcast();
    }
    case 'pick': {
      if (!player) return;
      const err = Engine.submitPick(state, msg.pid, msg.cid);
      if (err) { send({ t: 'reject', pid: msg.pid, reason: err, about: 'pick' }); return broadcast(); }
      sfx.pop();
      if (Engine.allPicksIn(state)) return lockPicks();
      renderBoard();
      return broadcast();
    }
    case 'idea': {
      const q = Engine.question(state);
      if (!player || state.phase !== 'write' || !q) return;
      const taken = Object.values(state.lies).map(Engine.norm);
      const options = (q.decoys || []).filter(d => !taken.includes(Engine.norm(d)));
      return send({ t: 'idea', pid: msg.pid, text: options.length ? options[Math.floor(Math.random() * options.length)] : '' });
    }
    case 'start':
      if (state.players[0] && state.players[0].id === msg.pid) startHostGame();
      return;
    case 'bye':
      if (player && state.phase === 'lobby') { Engine.removePlayer(state, msg.pid); renderLobby(); broadcast(); }
      return;
  }
}

// =====================================================================
// ROOM MODE — PHONE
// =====================================================================
const myId = (() => {
  let id = store.get('pid', null);
  if (!id) { id = 'u' + Math.random().toString(36).slice(2, 10); store.set('pid', id); }
  return id;
})();
let view = null, myLie = { round: -1, text: '' }, pendingLie = null, pendingPick = null, // pending = { round, text | cid }
    helloTimer = 0, joinTimeout = 0, phoneTimer = 0;

function openJoin(prefill) {
  const last = store.get('lastRoom', null);
  $('#j-code').value = prefill || (last && last.code) || '';
  $('#j-name').value = store.get('myName', '');
  $('#join-error').hidden = true;
  $('#join-btn').disabled = false;
  show('join');
  ($('#j-code').value ? $('#j-name') : $('#j-code')).focus({ preventScroll: true });
}
$('#j-code').addEventListener('input', e => { e.target.value = Room.cleanCode(e.target.value); });

function joinError(msg) {
  $('#join-error').textContent = msg;
  $('#join-error').hidden = false;
  $('#join-btn').disabled = false;
  clearInterval(helloTimer); clearTimeout(joinTimeout);
  if (room) { try { room.close(); } catch { } room = null; }
  if (current() !== 'join') show('join');
}

$('#join-form').addEventListener('submit', async e => {
  e.preventDefault();
  const code = Room.cleanCode($('#j-code').value);
  const name = $('#j-name').value.trim();
  if (code.length !== 4) return joinError('The room code has 4 letters.');
  if (!name) return joinError('Type your name.');
  store.set('myName', name);
  $('#join-btn').disabled = true;
  $('#join-error').hidden = true;
  await connectPhone(code, name);
});

async function connectPhone(code, name) {
  mode = 'phone';
  roomCode = code;
  view = null;
  try {
    room = await Room.join(code, onPhoneMessage, netStatus);
  } catch (err) {
    return joinError("Couldn't reach the game server. Check your internet.");
  }
  const hello = () => send({ t: 'hello', pid: myId, name });
  hello();
  clearInterval(helloTimer);
  helloTimer = setInterval(() => {
    // keep saying hello until the host lists us, then keep resending unconfirmed moves
    if (!view || !view.players.some(p => p.id === myId)) return hello();
    resendPending();
  }, 2000);
  clearTimeout(joinTimeout);
  joinTimeout = setTimeout(() => { if (!view) joinError(`No game found with code ${code}. Check the code on the TV.`); }, 9000);
}

function resendPending() {
  if (!view) return;
  if (pendingLie && view.phase === 'write' && !view.wrote.includes(myId)) send({ t: 'lie', pid: myId, text: pendingLie.text });
  if (pendingPick && view.phase === 'pick' && !view.picked.includes(myId)) send({ t: 'pick', pid: myId, cid: pendingPick.cid });
}

function onPhoneMessage(msg) {
  if (!msg) return;
  if (msg.t === 'state') return phoneRender(msg.v);
  if (msg.pid !== myId) return;
  if (msg.t === 'idea') {
    if (!msg.text) return toast("Out of ideas, you're on your own!");
    $('#lie').value = msg.text;
    return;
  }
  if (msg.t === 'reject') {
    if (msg.about === 'lie') { pendingLie = null; show('write'); return writeError(msg.reason); }
    if (msg.about === 'pick') { pendingPick = null; $('#pick-error').textContent = msg.reason === 'own' ? "That's your own lie, pick another!" : 'Too late!'; $('#pick-error').hidden = false; return; }
    const why = { name: 'Someone in that room already has that name.', full: 'That room is full.', over: 'That game has finished.', kicked: 'The host removed you from the room.' }[msg.reason];
    store.set('lastRoom', null);
    mode = null;
    return joinError(why || "Couldn't join.");
  }
}

function phoneRender(v) {
  const first = !view;
  view = v;
  const me = v.players.find(p => p.id === myId);
  if (!me) return; // not added yet — hello keeps trying
  // The host may jump ahead before confirming a move (the last lie starts picking
  // straight away), so a move only stays pending within its own round and phase.
  if (pendingLie && (v.phase !== 'write' || v.round !== pendingLie.round)) pendingLie = null;
  if (pendingPick && (v.phase !== 'pick' || v.round !== pendingPick.round)) pendingPick = null;
  if (first) { clearTimeout(joinTimeout); keepAwake(); sfx.join(); store.set('lastRoom', { code: roomCode }); }

  // mirror the host's timer on the phone
  clearInterval(phoneTimer);
  const ends = v.remaining ? Date.now() + v.remaining : 0;
  const drawTimer = () => {
    const txt = ends ? Math.ceil(Math.max(0, ends - Date.now()) / 1000) : '';
    for (const id of ['#w-timer-num', '#p-timer-num', '#wait-timer-num']) $(id).textContent = txt;
  };
  drawTimer();
  if (ends) phoneTimer = setInterval(drawTimer, 500);

  const q = v.question;
  const rank = v.players.slice().sort((a, b) => b.score - a.score).findIndex(p => p.id === myId) + 1;
  $('#wait-me').textContent = me.name;
  $('#w-who').textContent = me.name;
  $('#p-who').textContent = me.name;

  const wait = (emoji, title, text, score) => {
    $('#wait-emoji').textContent = emoji;
    $('#wait-title').textContent = title;
    $('#wait-text').textContent = text;
    $('#wait-score').hidden = score === undefined;
    if (score !== undefined) $('#wait-score').textContent = score;
    $('#vip-start').hidden = true;
    if (current() !== 'wait') show('wait');
  };

  if (v.phase === 'lobby') {
    wait('🎟️', "You're in!", `${v.players.length} player${v.players.length === 1 ? '' : 's'} in the room. Waiting for the show to start…`);
    $('#vip-start').hidden = !(v.vip === myId && v.players.length >= MIN_PLAYERS);
    return;
  }
  if (v.phase === 'write') {
    if (v.sitting.includes(myId)) return wait('✍️', 'Your question!', 'You wrote this one, so sit back and watch them squirm.');
    if (v.wrote.includes(myId)) { pendingLie = null; return wait('🤫', 'Lie locked in!', `Waiting for ${v.players.length - v.sitting.length - v.wrote.length} more…`); }
    if (pendingLie) return wait('📨', 'Sending…', 'Hang on a second.');
    if (current() !== 'write' || writeQuestion !== q.q) {
      openWrite({ ...q, author: null }, me.name);
      writeQuestion = q.q;
      $('#idea').hidden = q.cat === 'Custom';
    }
    return;
  }
  if (v.phase === 'pick') {
    if (v.sitting.includes(myId)) return wait('🍿', 'Watch the screen', 'Everyone is hunting for the truth about your question.');
    if (v.picked.includes(myId)) { pendingPick = null; return wait('🔒', 'Locked in!', 'Watch the screen for the reveal.'); }
    if (pendingPick) return wait('📨', 'Sending…', 'Hang on a second.');
    const key = v.round + ':' + v.choices.map(c => c.id).join();
    if (current() !== 'pick' || openPick.key !== key) {
      const mine = myLie.round === v.round ? Engine.norm(myLie.text) : null;
      openPick({ ...q, author: null }, me.name, v.choices.filter(c => Engine.norm(c.text) !== mine));
      openPick.key = key;
    }
    return;
  }
  if (v.phase === 'reveal') return wait('📺', 'Eyes on the screen!', 'The answers are being revealed.');
  if (v.phase === 'scores') {
    const g = v.gain[myId] || 0;
    return wait(g ? '🎉' : '😬', g ? `+${g} this round` : 'No points this round', `You're in place ${rank} of ${v.players.length}.`, me.score);
  }
  if (v.phase === 'final') {
    const medal = ['🏆', '🥈', '🥉'][rank - 1] || '🎙️';
    return wait(medal, rank === 1 ? 'You won!' : `You came ${ordinal(rank)}`, 'Thanks for playing Bluff Show!', me.score);
  }
}
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 >> 3 ^ 1 && n % 10) || 0] || 'th');

function phoneSubmitLie(text) {
  const clean = String(text || '').trim();
  if (!clean) return writeError('empty');
  myLie = { round: view.round, text: clean };
  pendingLie = { round: view.round, text: clean };
  $('#lie').blur();
  send({ t: 'lie', pid: myId, text: clean });
  sfx.pop();
  phoneRender(view);
}
function phoneSubmitPick(cid) {
  pendingPick = { round: view.round, cid };
  send({ t: 'pick', pid: myId, cid });
  sfx.pop();
  phoneRender(view);
}
$('#vip-start').onclick = () => send({ t: 'start', pid: myId });

// =====================================================================
// START UP
// =====================================================================
(function boot() {
  $('#room-off').hidden = Room.isConfigured();
  const code = Room.cleanCode(new URLSearchParams(location.search).get('room'));
  if (code.length === 4 && Room.isConfigured()) return openJoin(code);
  show('home');
})();
