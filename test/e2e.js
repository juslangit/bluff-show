/* Plays Bluff Show through the real screens in headless Chrome:
   1. a pass-the-device game at phone, tablet and desktop sizes
   2. a room game: one host tab and three phone tabs, talking over
      BroadcastChannel (?transport=local) instead of Supabase */
const { launch, Session, sleep } = require('./cdp.js');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(60)}${extra}`); };
const BASE = 'http://localhost:8767/index.html';
const SHOTS = `${__dirname}/shots`;
fs.mkdirSync(SHOTS, { recursive: true });

async function tab(dev, url) {
  const s = await Session.open('about:blank');
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Log.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width: dev.width, height: dev.height, deviceScaleFactor: dev.scale || 1, mobile: !!dev.mobile });
  if (dev.mobile) await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s.send('Page.navigate', { url });
  await sleep(1200);
  s.click$ = sel => s.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('missing ${sel}'); el.click(); return true; })()`);
  s.val = (sel, v) => s.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  s.text = sel => s.eval(`document.querySelector(${JSON.stringify(sel)}).textContent`);
  s.screen = () => s.eval(`document.body.dataset.screen`);
  s.submit = sel => s.eval(`document.querySelector(${JSON.stringify(sel)}).requestSubmit()`);
  s.overflow = () => s.eval(`(() => { const sc = document.querySelector('#' + document.body.dataset.screen); return sc.scrollWidth - sc.clientWidth; })()`);
  s.errors = () => s.events.filter(e => (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/fonts\.g/.test(e.params.entry.url || '')) || e.method === 'Runtime.exceptionThrown');
  return s;
}
const waitFor = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(100); } return false; };

// ---------------------------------------------------------------- local game
async function localGame(dev) {
  const s = await tab(dev, BASE);
  await s.eval(`localStorage.clear(); location.reload()`).catch(() => {});
  await sleep(1200);
  const tag = dev.name + ':';
  const sideways = async label => { const w = await s.overflow(); ok(w <= 1, `${tag} no sideways scroll on ${label}`, w > 1 ? `${w}px` : ''); };
  const shot = n => s.shot(`${SHOTS}/${dev.name}-${n}.png`);

  ok(await s.screen() === 'home', `${tag} home screen`);
  await shot('01-home'); await sideways('home');
  await s.click$('#go-local'); await sleep(200);
  await s.eval(`(() => { const names = ['Luqman','Aina','Hafiz','Siti']; while (document.querySelectorAll('#player-list input').length < 4) document.querySelector('#add-player').click(); document.querySelectorAll('#player-list input').forEach((el, i) => { el.value = names[i]; el.dispatchEvent(new Event('input', { bubbles: true })); }); })()`);
  await s.click$('.seg[data-key=rounds] button[data-v="5"]');
  await s.click$('.seg[data-key=sound] button[data-v="0"]');
  await shot('02-setup'); await sideways('setup');

  // a custom question written by Siti: she must sit that round out
  await s.click$('#edit-custom'); await sleep(200);
  await s.val('#c-q', 'Siti once won a prize for ____.'); await s.val('#c-a', 'growing a giant pumpkin'); await s.val('#c-by', 'siti');
  await s.submit('#custom-form'); await sleep(100);
  ok(await s.eval(`document.querySelectorAll('#custom-list .custom-item').length`) === 1, `${tag} custom question added`);
  await shot('03-custom');
  await s.click$('#custom-back');
  await s.click$('#start'); await sleep(300);

  for (let round = 0; round < 5; round++) {
    ok(await s.screen() === 'board', `${tag} round ${round + 1} board`);
    const q = await s.eval(`Engine.question(state)`);
    if (round === 0) {
      ok(q.cat === 'Custom', `${tag} custom question comes first`);
      ok((await s.text('#b-note')).includes('Siti'), `${tag} board says Siti sits out`);
      await shot('04-board-write'); await sideways('board');
    }
    const active = await s.eval(`Engine.activePlayers(state).map(p => p.name)`);
    for (let i = 0; i < active.length; i++) {
      await s.click$(i === 0 ? '#b-go' : '#pass-go'); await sleep(i === 0 ? 150 : 50);
      if (i === 0) { ok(await s.screen() === 'pass', `${tag} pass screen before writing`); if (round === 0) await shot('05-pass'); await s.click$('#pass-go'); await sleep(100); }
      ok(await s.text('#w-who') === active[i], `${tag} r${round + 1} ${active[i]} writes`);
      if (i === 0) {
        await s.val('#lie', q.a.toUpperCase()); await s.submit('#write-form'); await sleep(50);
        ok(!(await s.eval(`document.querySelector('#write-error').hidden`)) && await s.screen() === 'write', `${tag} writing the real answer is refused`);
      }
      // two players write the same lie so they share credit
      await s.val('#lie', i < 2 ? 'Same lie ' + round : `Lie by ${active[i]} ${round}`);
      if (round === 0 && i === 0) await shot('06-write');
      await s.submit('#write-form'); await sleep(80);
      if (i < active.length - 1) ok(await s.screen() === 'pass', `${tag} device goes back to pass screen`);
    }
    ok(await s.screen() === 'board' && await s.eval(`state.phase`) === 'pick', `${tag} r${round + 1} answers board`);
    const n = await s.eval(`document.querySelectorAll('#b-choices .choice').length`);
    ok(n >= 3, `${tag} r${round + 1} board lists answers`, `${n}`);
    if (round === 1) { await shot('07-board-pick'); await sideways('answers board'); }

    await s.click$('#b-go'); await sleep(80);
    for (let i = 0; i < active.length; i++) {
      await s.click$('#pass-go'); await sleep(80);
      ok(await s.screen() === 'pick', `${tag} r${round + 1} ${active[i]} picks`);
      const own = await s.eval(`[...document.querySelectorAll('#p-choices .choice')].some(b => /Same lie|Lie by ${active[i]}/.test(b.textContent) && ${i < 2} ? /Same lie/.test(b.textContent) : /Lie by ${active[i]} /.test(b.textContent))`);
      ok(!own, `${tag} ${active[i]} is not offered their own lie`);
      // Luqman always finds the truth, everyone else picks the first answer they see
      const target = i === 0 ? `[...document.querySelectorAll('#p-choices .choice')].find(b => b.dataset.id === state.choices.find(c => c.truth).id)` : `document.querySelector('#p-choices .choice')`;
      await s.eval(`${target}.click()`);
      if (round === 1 && i === 0) await shot('08-pick');
      await s.click$('#pick-lock'); await sleep(80);
    }
    ok(await s.screen() === 'reveal', `${tag} r${round + 1} reveal`);
    const steps = await s.eval(`state.steps.length`);
    for (let k = 0; k < steps; k++) {
      if (round === 1 && k === 0) { await sleep(2200); await shot('09-reveal-lie'); await sideways('reveal'); }
      if (round === 1 && k === steps - 1) { await sleep(2600); await shot('10-reveal-truth'); }
      await s.click$('#r-next'); await sleep(60);
    }
    ok(await s.screen() === 'scores', `${tag} r${round + 1} scoreboard`);
    if (round === 1) { await sleep(900); await shot('11-scores'); await sideways('scores'); }
    const truthGain = await s.eval(`state.lastGain.p0`);
    ok(truthGain >= (round === 4 ? 2000 : 1000), `${tag} r${round + 1} Luqman scored for the truth`, `+${truthGain}`);
    await s.click$('#s-next'); await sleep(250);
  }
  ok(await s.screen() === 'final', `${tag} final screen`);
  ok(await s.eval(`document.querySelectorAll('#f-podium .step').length`) === 3, `${tag} podium shows top 3`);
  ok((await s.text('#f-podium .p1 .who')) === await s.eval(`Engine.standings(state)[0].name`), `${tag} podium winner matches the scoreboard`);
  await sleep(800); await shot('12-final'); await sideways('final');
  await s.click$('#again'); await sleep(200);
  ok(await s.screen() === 'board' && await s.eval(`state.players[0].name`) === 'Aina', `${tag} play again rotates who starts`);
  const errs = s.errors();
  ok(errs.length === 0, `${tag} no console errors`, errs.map(e => JSON.stringify(e.params).slice(0, 180)).join(' | '));
  await s.close();
}

// ---------------------------------------------------------------- room game
async function roomGame() {
  const tag = 'room:';
  const host = await tab({ name: 'tv', width: 1920, height: 1080 }, BASE + '?transport=local');
  await host.eval(`localStorage.clear(); location.reload()`).catch(() => {});
  await sleep(1200);
  await host.click$('#go-host'); await sleep(150);
  ok(await host.eval(`document.querySelector('#players-panel').hidden`), `${tag} host setup hides the player list`);
  await host.click$('.seg[data-key=rounds] button[data-v="5"]');
  await host.click$('.seg[data-key=sound] button[data-v="0"]');
  await host.click$('.seg[data-key=writeSec] button[data-v="60"]');
  await host.click$('#start'); await sleep(900);
  ok(await host.screen() === 'lobby', `${tag} lobby opens`);
  const code = await host.text('#room-code');
  ok(/^[A-Z]{4}$/.test(code), `${tag} room code`, code);
  ok(await waitFor(() => host.eval(`!!document.querySelector('#qr svg')`), 8000), `${tag} QR code drawn`);
  await host.eval(`REVEAL_MS.lie = 400; REVEAL_MS.truth = 500; REVEAL_MS.scores = 600;`);

  const names = ['Aina', 'Hafiz', 'Siti'];
  const phones = [];
  for (const [i, name] of names.entries()) {
    const p = await tab({ name: 'phone' + i, width: 390, height: 844, mobile: true, scale: 3 }, `${BASE}?transport=local&room=${code}`);
    await p.eval(`localStorage.clear()`);
    await p.eval(`location.reload()`).catch(() => {}); await sleep(1000);
    ok(await p.screen() === 'join' && (await p.eval(`document.querySelector('#j-code').value`)) === code, `${tag} QR link opens join with code filled in`);
    await p.val('#j-name', i === 2 ? 'aina' : name);
    await p.submit('#join-form');
    phones.push(p);
    await sleep(700);
  }
  // Siti tried to join as "aina", which is taken
  ok(await waitFor(async () => !(await phones[2].eval(`document.querySelector('#join-error').hidden`))), `${tag} duplicate name is refused`);
  await phones[2].val('#j-name', 'Siti'); await phones[2].submit('#join-form');
  ok(await waitFor(async () => (await host.eval(`state.players.length`)) === 3), `${tag} three players in the lobby`);
  await phones[0].shot(`${SHOTS}/room-phone-lobby.png`);
  await host.shot(`${SHOTS}/room-tv-lobby.png`);
  ok(await waitFor(async () => !(await phones[0].eval(`document.querySelector('#vip-start').hidden`))), `${tag} first player can start from their phone`);
  ok(await phones[1].eval(`document.querySelector('#vip-start').hidden`), `${tag} other players cannot`);
  await phones[0].click$('#vip-start');
  ok(await waitFor(async () => (await host.screen()) === 'board'), `${tag} game starts on the TV`);

  for (let round = 0; round < 5; round++) {
    ok(await waitFor(async () => (await host.eval(`state.round === ${round} && state.phase === 'write'`))), `${tag} r${round + 1} starts on the TV`);
    const q = await host.eval(`Engine.question(state)`);
    ok(await waitFor(async () => (await phones[2].screen()) === 'write'), `${tag} r${round + 1} phones show the write screen`);
    if (round === 0) {
      await phones[0].val('#lie', q.a); await phones[0].submit('#write-form');
      ok(await waitFor(async () => !(await phones[0].eval(`document.querySelector('#write-error').hidden`))), `${tag} truth refused on the phone`);
      await phones[0].click$('#idea');
      ok(await waitFor(async () => (await phones[0].eval(`document.querySelector('#lie').value`)) !== q.a), `${tag} "Need an idea?" fills a decoy from the host`);
      await phones[0].shot(`${SHOTS}/room-phone-write.png`);
    }
    const writers = round === 1 ? phones.slice(0, 2) : phones; // round 2: Siti never writes, timer runs out
    for (const [i, p] of writers.entries()) { await p.val('#lie', `Phone lie ${i} r${round}`); await p.submit('#write-form'); }
    if (round === 1) {
      ok(await waitFor(async () => (await host.eval(`Object.keys(state.lies).length`)) === 2), `${tag} host received two lies`);
      await host.shot(`${SHOTS}/room-tv-write.png`);
      ok((await host.eval(`state.phase`)) === 'write', `${tag} host keeps waiting for the missing lie`);
      await host.eval(`deadline = Date.now() + 50`);
    }
    ok(await waitFor(async () => (await host.eval(`state.phase`)) === 'pick'), `${tag} r${round + 1} host moves to picking`);
    ok(await waitFor(async () => (await phones[0].screen()) === 'pick'), `${tag} r${round + 1} phones show answers`);
    const offered = await phones[0].eval(`[...document.querySelectorAll('#p-choices .choice')].map(b => b.textContent)`);
    ok(!offered.some(t => t.includes('Phone lie 0')), `${tag} r${round + 1} own lie hidden on the phone`);
    if (round === 1) { await host.shot(`${SHOTS}/room-tv-pick.png`); await phones[0].shot(`${SHOTS}/room-phone-pick.png`); }
    // Aina picks the truth, the rest pick the first option
    const truthText = q.a;
    const found = await phones[0].eval(`(() => { const b = [...document.querySelectorAll('#p-choices .choice')].find(b => b.textContent.endsWith(${JSON.stringify(truthText)})); if (b) b.click(); return !!b; })()`);
    ok(found, `${tag} r${round + 1} the truth is among the phone's answers`);
    await phones[0].click$('#pick-lock');
    for (const p of phones.slice(1)) {
      await waitFor(async () => (await p.screen()) === 'pick');
      await p.eval(`document.querySelector('#p-choices .choice').click()`); await p.click$('#pick-lock');
    }
    ok(await waitFor(async () => ['reveal', 'scores', 'board', 'final'].includes(await host.screen())), `${tag} r${round + 1} reveal plays on the TV`);
    if (round === 0) { await sleep(150); await host.shot(`${SHOTS}/room-tv-reveal.png`); }
    ok(await waitFor(async () => (await phones[0].eval(`view.phase`)) !== 'pick'), `${tag} r${round + 1} phones leave the pick screen`);
    ok(await waitFor(async () => (await host.eval(`state.phase`)) === 'scores', 8000), `${tag} r${round + 1} scoreboard follows automatically`);
    ok(await waitFor(async () => (await phones[0].text('#wait-score')) === String(await host.eval(`state.players.find(p => p.name === 'Aina').score`))), `${tag} r${round + 1} phone shows the same score as the TV`);
    if (round === 0) await phones[0].shot(`${SHOTS}/room-phone-scores.png`);
    if (round === 2) {
      // Hafiz's phone reloads mid-game and rejoins with the same identity
      // tabs share storage in one browser; a real phone keeps its own id, so restore it first
      await phones[1].eval(`localStorage.setItem('bluff.pid', JSON.stringify(myId)); window.__id = myId`);
      const hafizId = await phones[1].eval(`myId`);
      await phones[1].eval(`location.reload()`).catch(() => {}); await sleep(1200);
      ok(await phones[1].eval(`myId`) === hafizId, `${tag} reloaded phone keeps its player id`);
      await phones[1].submit('#join-form');
      ok(await waitFor(async () => (await phones[1].eval(`view && view.players.length`)) === 3), `${tag} reloaded phone rejoins as the same player`);
    }
  }
  ok(await waitFor(async () => (await host.screen()) === 'final', 8000), `${tag} TV shows the winner`);
  ok(await waitFor(async () => /won|came/.test(await phones[0].text('#wait-title'))), `${tag} phones show final place`, await phones[0].text('#wait-title'));
  await sleep(800);
  await host.shot(`${SHOTS}/room-tv-final.png`); await phones[0].shot(`${SHOTS}/room-phone-final.png`);
  for (const s of [host, ...phones]) {
    const errs = s.errors();
    ok(errs.length === 0, `${tag} no console errors (${s === host ? 'tv' : 'phone'})`, errs.map(e => JSON.stringify(e.params).slice(0, 180)).join(' | '));
    await s.close();
  }
}

(async () => {
  await launch();
  const only = process.argv[2];
  try {
    if (only !== 'room') for (const dev of [
      { name: 'phone', width: 390, height: 844, mobile: true, scale: 3 },
      { name: 'phone-landscape', width: 844, height: 390, mobile: true, scale: 3 },
      { name: 'tablet', width: 820, height: 1180, mobile: true, scale: 2 },
      { name: 'desktop', width: 1440, height: 900 },
    ]) await localGame(dev);
    if (only !== 'local') await roomGame();
  } catch (e) { fail++; console.log('FAIL  crashed: ' + e.stack); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
