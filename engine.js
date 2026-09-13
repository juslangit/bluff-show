/* Bluff Show — the rules of the game.
   No screen code lives here. The same rules run the pass-one-device mode and
   the room mode, where the host's screen runs them and phones only send moves.

   A game moves through phases:
     write  -> every player secretly writes a fake answer
     pick   -> everyone picks the answer they think is true
     reveal -> the lies that fooled someone are shown, then the truth
     scores -> the scoreboard; then the next round starts at "write"
     final  -> after the last round
*/
(function () {
  const POINTS = { truth: 1000, fool: 500 };

  // Make answers comparable: "The  Eiffel-Tower!" -> "eiffel tower"
  function norm(s) {
    return String(s || '')
      .toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/(\d),(?=\d)/g, '$1')
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/^\s*(a|an|the)\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function distance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  // Is this "lie" really the true answer, or a typo away from it?
  function isTooClose(text, q) {
    const t = norm(text);
    return [q.a, ...(q.alts || [])].map(norm).some(ans => {
      if (!ans) return false;
      if (t === ans) return true;
      // numbers must match exactly: "81 years" is a fine lie when the truth is "116 years"
      const digits = x => (x.match(/\d+/g) || []).join(' ');
      if (digits(t) !== digits(ans)) return false;
      const allowed = ans.length >= 9 ? 2 : ans.length >= 5 ? 1 : 0;
      return distance(t, ans) <= allowed;
    });
  }

  function shuffle(list, rng = Math.random) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /* Choose this game's questions.
     Custom questions come first (in random order), then the bank fills the rest.
     `seen` is a list of question texts played recently, so repeats come last. */
  function pickQuestions({ bank, cats, custom = [], rounds, seen = [], rng = Math.random }) {
    const pool = bank.filter(q => !cats || cats.includes(q.cat));
    const fresh = shuffle(pool.filter(q => !seen.includes(q.q)), rng);
    const stale = shuffle(pool.filter(q => seen.includes(q.q)), rng);
    const mine = shuffle(custom.map(c => ({ ...c, cat: 'Custom', decoys: [], alts: c.alts || [] })), rng);
    return [...mine, ...fresh, ...stale].slice(0, rounds);
  }

  function newGame({ players, questions, rng = Math.random }) {
    const st = {
      phase: 'lobby',
      round: -1,
      rounds: questions.length,
      players: players.map(p => ({ id: p.id, name: p.name, score: 0, fooled: 0, found: 0 })),
      questions,
      lies: {},       // playerId -> text
      picks: {},      // playerId -> choice id
      choices: [],    // [{ id, text, truth, authors: [playerId], house }]
      steps: [],      // reveal steps, built when picking ends
      lastGain: {},   // playerId -> points won this round
    };
    Object.defineProperty(st, 'rng', { value: rng, enumerable: false, writable: true });
    return st;
  }

  const question = st => st.questions[st.round];
  const isFinalRound = st => st.round === st.rounds - 1 && st.rounds >= 3;
  const multiplier = st => (isFinalRound(st) ? 2 : 1);

  // Whoever wrote a custom question already knows the answer, so they sit it out.
  function activePlayers(st) {
    const q = question(st);
    return st.players.filter(p => !(q && q.author && q.author === p.id));
  }

  function addPlayer(st, p) {
    if (st.players.some(x => x.id === p.id)) return false;
    st.players.push({ id: p.id, name: p.name, score: 0, fooled: 0, found: 0 });
    return true;
  }

  function removePlayer(st, id) {
    st.players = st.players.filter(p => p.id !== id);
    delete st.lies[id];
    delete st.picks[id];
  }

  function startRound(st) {
    st.round += 1;
    st.lies = {};
    st.picks = {};
    st.choices = [];
    st.steps = [];
    st.lastGain = {};
    st.phase = st.round >= st.rounds ? 'final' : 'write';
    return st.phase;
  }

  // Returns null when accepted, or a reason: 'phase' | 'player' | 'empty' | 'long' | 'truth'
  function submitLie(st, playerId, text) {
    if (st.phase !== 'write') return 'phase';
    if (!activePlayers(st).some(p => p.id === playerId)) return 'player';
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!norm(clean)) return 'empty';
    if (clean.length > 60) return 'long';
    if (isTooClose(clean, question(st))) return 'truth';
    st.lies[playerId] = clean;
    return null;
  }

  const allLiesIn = st => activePlayers(st).every(p => st.lies[p.id]);

  /* Lock the lies in and lay out the answer board.
     Identical lies are merged and both writers share the credit.
     If there are fewer than 4 answers, the question's decoys ("house lies") fill in. */
  function startPicking(st) {
    if (st.phase !== 'write') return;
    const q = question(st);
    const groups = new Map();
    for (const [pid, text] of Object.entries(st.lies)) {
      const key = norm(text);
      if (!groups.has(key)) groups.set(key, { text, authors: [] });
      groups.get(key).authors.push(pid);
    }
    let list = [...groups.values()].map(g => ({ text: g.text, truth: false, authors: g.authors, house: false }));
    list.push({ text: q.a, truth: true, authors: [], house: false });
    const used = new Set(list.map(c => norm(c.text)));
    for (const d of shuffle(q.decoys || [], st.rng)) {
      if (list.length >= 4) break;
      if (used.has(norm(d)) || isTooClose(d, q)) continue;
      used.add(norm(d));
      list.push({ text: d, truth: false, authors: [], house: true });
    }
    st.choices = shuffle(list, st.rng).map((c, i) => ({ id: 'c' + i, ...c }));
    st.phase = 'pick';
  }

  // Returns null when accepted, or a reason: 'phase' | 'player' | 'choice' | 'own'
  function submitPick(st, playerId, choiceId) {
    if (st.phase !== 'pick') return 'phase';
    if (!activePlayers(st).some(p => p.id === playerId)) return 'player';
    const c = st.choices.find(x => x.id === choiceId);
    if (!c) return 'choice';
    if (c.authors.includes(playerId)) return 'own';
    st.picks[playerId] = choiceId;
    return null;
  }

  // Which answers may this player pick? (Everything except their own lie.)
  const choicesFor = (st, playerId) => st.choices.filter(c => !c.authors.includes(playerId));

  const allPicksIn = st => activePlayers(st).every(p => st.picks[p.id]);

  /* Score the round and build the reveal, one step per answer somebody picked:
     least-popular lie first, the truth always last. */
  function startReveal(st) {
    if (st.phase !== 'pick') return;
    const m = multiplier(st);
    const gain = {};
    const add = (pid, n) => { gain[pid] = (gain[pid] || 0) + n; };
    const steps = [];
    const pickersOf = c => Object.keys(st.picks).filter(pid => st.picks[pid] === c.id);

    const lies = st.choices.filter(c => !c.truth && pickersOf(c).length)
      .sort((a, b) => pickersOf(a).length - pickersOf(b).length);
    for (const c of lies) {
      const pickers = pickersOf(c);
      const each = POINTS.fool * m * pickers.length;
      for (const a of c.authors) {
        add(a, each);
        const p = st.players.find(x => x.id === a);
        if (p) p.fooled += pickers.length;
      }
      steps.push({ choice: c.id, text: c.text, truth: false, house: c.house, pickers, authors: c.authors, points: c.authors.length ? each : 0 });
    }
    const truth = st.choices.find(c => c.truth);
    const finders = pickersOf(truth);
    for (const pid of finders) {
      add(pid, POINTS.truth * m);
      const p = st.players.find(x => x.id === pid);
      if (p) p.found += 1;
    }
    steps.push({ choice: truth.id, text: truth.text, truth: true, house: false, pickers: finders, authors: [], points: POINTS.truth * m });

    for (const p of st.players) p.score += gain[p.id] || 0;
    st.lastGain = gain;
    st.steps = steps;
    st.phase = 'reveal';
  }

  function showScores(st) {
    if (st.phase === 'reveal') st.phase = 'scores';
  }

  const standings = st => st.players.slice().sort((a, b) => b.score - a.score);

  // End-of-game awards. Ties go to whoever is higher on the scoreboard.
  function awards(st) {
    const top = key => {
      const best = standings(st).reduce((b, p) => (p[key] > (b ? b[key] : 0) ? p : b), null);
      return best && best[key] > 0 ? { id: best.id, name: best.name, count: best[key] } : null;
    };
    return { liar: top('fooled'), detective: top('found') };
  }

  /* What a room's phones and host screen may see. Before the reveal it hides
     who wrote which lie and which answer is true, so nothing leaks over the air. */
  function publicView(st) {
    const q = question(st);
    const revealing = st.phase === 'reveal' || st.phase === 'scores';
    return {
      phase: st.phase,
      round: st.round,
      rounds: st.rounds,
      final: isFinalRound(st),
      question: q && st.phase !== 'lobby' && st.phase !== 'final'
        ? { q: q.q, cat: q.cat, author: q.author || null, fact: revealing ? q.fact || '' : '', a: revealing ? q.a : '' }
        : null,
      players: st.players.map(p => ({ id: p.id, name: p.name, score: p.score, fooled: p.fooled, found: p.found })),
      sitting: q && q.author ? [q.author] : [],
      wrote: Object.keys(st.lies),
      picked: Object.keys(st.picks),
      choices: st.phase === 'pick' ? st.choices.map(c => ({ id: c.id, text: c.text })) : [],
      steps: revealing ? st.steps : [],
      gain: revealing || st.phase === 'final' ? st.lastGain : {},
      awards: st.phase === 'final' ? awards(st) : null,
    };
  }

  const Engine = {
    POINTS, norm, isTooClose, shuffle, pickQuestions, newGame, question, isFinalRound, multiplier,
    activePlayers, addPlayer, removePlayer, startRound, submitLie, allLiesIn, startPicking,
    submitPick, choicesFor, allPicksIn, startReveal, showScores, standings, awards, publicView,
  };
  if (typeof module !== 'undefined') module.exports = Engine;
  else window.Engine = Engine;
})();
