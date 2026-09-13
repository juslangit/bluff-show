/* Checks the rules on their own, without any screens. Run: node test/engine.test.js */
const E = require('../engine.js');
let pass = 0, fail = 0;
const ok = (c, msg) => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg}`); };

// answers that are really the truth get refused
const q = { cat: 'Animals', q: 'A group of crows is called a ____.', a: 'murder', alts: ['a murder'], decoys: ['parliament', 'crowd', 'gossip'], fact: 'x' };
ok(E.norm('  The Eiffel-Tower! ') === 'eiffel tower', 'norm strips articles and punctuation');
ok(E.norm('1,000 cats') === '1000 cats', 'norm treats 1,000 as 1000');
ok(E.isTooClose('Murder', q), 'exact truth is too close');
ok(E.isTooClose('a murdr', q), 'one-letter typo of truth is too close');
ok(!E.isTooClose('mother', q), 'a different word is fine');
ok(!E.isTooClose('81 years', { a: '116 years' }) && E.isTooClose('116 yeers', { a: '116 years' }), 'numbers must match exactly, words may have typos');

// a 4-player game with a seeded random so results repeat
let seed = 7; const rng = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const players = ['A', 'B', 'C', 'D'].map(n => ({ id: n, name: n }));
const qs = E.pickQuestions({ bank: [q, { ...q, q: 'Q2 ____', cat: 'History' }, { ...q, q: 'Q3 ____' }], cats: ['Animals'], custom: [{ q: 'B once ate ____.', a: 'a lizard', author: 'B' }], rounds: 3, rng });
ok(qs.length === 3 && qs[0].cat === 'Custom', 'custom questions come first');
ok(!qs.some(x => x.cat === 'History'), 'category filter works');

const st = E.newGame({ players, questions: qs, rng });
E.startRound(st);
ok(st.phase === 'write', 'round starts in write phase');
ok(E.activePlayers(st).length === 3 && !E.activePlayers(st).some(p => p.id === 'B'), 'author of a custom question sits out');
ok(E.submitLie(st, 'B', 'a frog') === 'player', 'sitting-out player cannot write');
ok(E.submitLie(st, 'A', '  ') === 'empty', 'empty lie refused');
ok(E.submitLie(st, 'A', 'A Lizard') === 'truth', 'truth as a lie refused');
ok(E.submitLie(st, 'A', 'a frog') === null, 'lie accepted');
ok(E.submitLie(st, 'C', 'Frog!') === null && E.submitLie(st, 'D', 'glue') === null, 'more lies accepted');
ok(E.allLiesIn(st), 'all lies in');
E.startPicking(st);
ok(st.phase === 'pick', 'pick phase');
const frog = st.choices.find(c => E.norm(c.text) === 'frog');
ok(frog.authors.length === 2, 'identical lies merge');
ok(st.choices.length === 3, 'custom question with no decoys is not padded');
const truth = st.choices.find(c => c.truth);
const glue = st.choices.find(c => c.text === 'glue');
ok(E.submitPick(st, 'A', frog.id) === 'own', 'cannot pick your own lie');
ok(E.choicesFor(st, 'A').every(c => c.id !== frog.id), 'own lie hidden from its author');
E.submitPick(st, 'A', glue.id); E.submitPick(st, 'C', truth.id); E.submitPick(st, 'D', frog.id);
ok(E.allPicksIn(st), 'all picks in');
const view = E.publicView(st);
ok(view.choices.every(c => !('truth' in c) && !('authors' in c)), 'public view hides truth and authors while picking');
E.startReveal(st);
ok(st.steps.at(-1).truth, 'truth is revealed last');
const score = id => st.players.find(p => p.id === id).score;
ok(score('A') === 500 && score('C') === 1500 && score('D') === 500, 'scores: fool 500, truth 1000', );
ok(score('B') === 0, 'sitting-out player scores nothing');
E.showScores(st);

// round 2: padding with house decoys, double points in the final round
E.startRound(st);
for (const id of ['A', 'B', 'C', 'D']) E.submitLie(st, id, 'crowd');
E.startPicking(st);
ok(st.choices.length === 4 && st.choices.filter(c => c.house).length === 2, 'decoys pad the board to 4 without duplicating a lie');
E.startReveal(st); E.showScores(st);
E.startRound(st);
ok(E.isFinalRound(st) && E.multiplier(st) === 2, 'last round is worth double');
['A', 'B', 'C'].forEach(id => E.submitLie(st, id, 'lie ' + id)); // D writes nothing
E.startPicking(st);
const t3 = st.choices.find(c => c.truth);
const before = score('D');
E.submitPick(st, 'D', t3.id);
E.submitPick(st, 'A', st.choices.find(c => c.text === 'lie B').id);
E.startReveal(st);
ok(score('D') - before === 2000, 'truth worth 2000 in final round');
ok(st.lastGain.B === 1000, 'fooling worth 1000 in final round');
E.showScores(st); E.startRound(st);
ok(st.phase === 'final', 'game ends after last round');
const aw = E.awards(st);
ok(aw.liar && aw.detective, 'awards given');
ok(E.publicView(st).awards, 'final view carries awards');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
