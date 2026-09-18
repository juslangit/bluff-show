/* The effects layer (fx.js), checked in headless Chrome.

   What matters about it is mostly what it must NOT do: take a tap, cost
   anything while someone types, or break the show if Phaser is missing. So
   most of these checks are about that; the rest confirm the moments -- the
   TRUTH and LIE stamps, the scores, the winner -- actually get their effects. */
const { launch, Session, sleep } = require('./cdp.js');
const fs = require('fs');

let pass = 0, fail = 0;
const ok = (c, msg, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${msg.padEnd(58)}${extra}`); };
const URL = 'http://localhost:8767/index.html';
const SHOTS = `${__dirname}/shots`;
const RENDER = process.env.CDP_WEBGL ? 'webgl' : 'canvas';

async function open(dev, { block = [], media = [] } = {}) {
  const s = await Session.open('about:blank');
  await s.send('Page.enable'); await s.send('Runtime.enable'); await s.send('Log.enable');
  await s.send('Network.enable');
  if (block.length) await s.send('Network.setBlockedURLs', { urls: block });
  if (media.length) await s.send('Emulation.setEmulatedMedia', { features: media });
  await s.send('Emulation.setDeviceMetricsOverride', { width: dev.width, height: dev.height, deviceScaleFactor: dev.scale, mobile: dev.mobile });
  if (dev.mobile) await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s.send('Page.navigate', { url: URL });
  await sleep(1500);
  await s.eval(`localStorage.clear()`);
  s.stats = () => s.eval(`FX.stats()`);
  s.screen = () => s.eval(`document.body.dataset.screen`);
  s.click$ = sel => s.eval(`document.querySelector(${JSON.stringify(sel)}).click()`);
  s.val = (sel, v) => s.eval(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); el.value = ${JSON.stringify(v)}; el.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  s.submit = sel => s.eval(`document.querySelector(${JSON.stringify(sel)}).requestSubmit()`);
  s.centre = sel => s.eval(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()`);
  s.errors = () => s.events.filter(e => (e.method === 'Log.entryAdded' && e.params.entry.level === 'error' && !/fonts\.g/.test(e.params.entry.url || '')) || e.method === 'Runtime.exceptionThrown');
  s.asleep = async (ms = 4000) => { const end = Date.now() + ms; while (Date.now() < end) { if (!(await s.stats()).awake) return true; await sleep(100); } return false; };
  s.ready = async (ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if ((await s.stats()).ready) return true; await sleep(100); } return false; };
  return s;
}

async function main(dev) {
  const tag = `${dev.name} (${RENDER}):`;
  const s = await open(dev);
  ok(await s.ready(), `${tag} effects layer starts`);
  const st = await s.stats();
  ok(st.renderer === RENDER, `${tag} draws with ${RENDER}`, st.renderer);
  ok(st.sounds === 8, `${tag} all 8 sounds decoded`, `${st.sounds}`);
  const box = await s.eval(`(() => { const c = document.getElementById('fx-layer'); const cs = getComputedStyle(c); const r = c.getBoundingClientRect();
    return { pe: cs.pointerEvents, pos: cs.position, w: r.width, h: r.height, bw: c.width, iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio }; })()`);
  ok(box.pe === 'none', `${tag} ignores touches (pointer-events: none)`);
  ok(box.pos === 'fixed' && Math.abs(box.w - box.iw) < 1 && Math.abs(box.h - box.ih) < 1, `${tag} covers exactly the screen`, `${box.w}x${box.h}`);
  ok(box.bw === Math.round(box.iw * Math.min(box.dpr, 2)), `${tag} sharp on this screen`, `backing ${box.bw}px for ${box.iw}px`);
  ok(await s.asleep(), `${tag} sleeps when nothing is playing`);

  // a real tap, through a burst, still reaches the button
  await s.eval(`FX.burst('#go-local', { kind: 'star', count: 30 })`); await sleep(100);
  ok((await s.stats()).alive > 0, `${tag} a burst wakes it`);
  const [bx, by] = await s.centre('#go-local');
  await s.click(bx, by); await sleep(300);
  ok(await s.screen() === 'setup', `${tag} a real tap through a burst works`);
  ok(!(await s.stats()).locked && await s.eval(`FX.sound('click')`), `${tag} real samples play after the first tap`);
  ok(await s.asleep(), `${tag} back to sleep after the burst`);

  // one round, three players
  await s.eval(`(() => { const names = ['Luqman','Aina','Hafiz']; while (document.querySelectorAll('#player-list input').length < 3) document.querySelector('#add-player').click(); document.querySelectorAll('#player-list input').forEach((el, i) => { el.value = names[i]; el.dispatchEvent(new Event('input', { bubbles: true })); }); })()`);
  await s.click$('.seg[data-key=sound] button[data-v="0"]');
  await s.click$('#start'); await sleep(300);
  const active = await s.eval(`Engine.activePlayers(state).length`);
  let wokeWhileTyping = false;
  for (let i = 0; i < active; i++) {
    await s.click$(i === 0 ? '#b-go' : '#pass-go'); await sleep(i === 0 ? 150 : 60);
    if (i === 0) { await s.click$('#pass-go'); await sleep(100); }
    if (i === 0) {
      // Typing a lie, a key at a time, the way a player does.
      ok(await s.asleep(), `${tag} asleep on the writing screen`);
      await s.eval(`document.querySelector('#lie').focus()`);
      for (const ch of 'A totally real answer') {
        await s.send('Input.insertText', { text: ch }); await sleep(15);
        if ((await s.stats()).awake) wokeWhileTyping = true;
      }
      ok((await s.eval(`document.querySelector('#lie').value`)) === 'A totally real answer', `${tag} the typing arrived`);
      ok(!wokeWhileTyping, `${tag} the layer never woke while typing`);
    } else {
      await s.val('#lie', `Lie number ${i}`);
    }
    await s.submit('#write-form'); await sleep(80);
  }
  await s.click$('#b-go'); await sleep(80);
  for (let i = 0; i < active; i++) {
    await s.click$('#pass-go'); await sleep(80);
    // the first player finds the truth, the rest fall for the first lie shown
    const target = i === 0 ? `[...document.querySelectorAll('#p-choices .choice')].find(b => b.dataset.id === state.choices.find(c => c.truth).id)`
      : `[...document.querySelectorAll('#p-choices .choice')].find(b => b.dataset.id !== state.choices.find(c => c.truth).id)`;
    await s.eval(`${target}.click()`);
    await s.click$('#pick-lock'); await sleep(80);
  }
  ok(await s.screen() === 'reveal', `${tag} on to the reveal`);

  // every step: a LIE shakes and sprays red, the TRUTH flashes gold and showers
  // stars. Each burst is recorded as it fires, with the step it was fired for.
  await s.eval(`window.__fired = []; const b = FX.burst, rg = FX.ring;
    FX.burst = (t, o = {}) => { const r = b(t, o); __fired.push({ step: revealIndex, kind: o.kind || 'spark', drawn: r }); return r; };
    FX.ring = (t, c) => { const r = rg(t, c); __fired.push({ step: revealIndex, kind: 'ring', drawn: r }); return r; };`);
  const steps = await s.eval(`state.steps.map(x => !!x.truth)`);
  let lieShot = false;
  for (let k = 0; k < steps.length; k++) {
    await sleep(1750);
    if (steps[k]) await s.shot(`${SHOTS}/${dev.name}-fx-truth.png`);
    else if (!lieShot) { lieShot = true; await s.shot(`${SHOTS}/${dev.name}-fx-lie.png`); }
    await sleep(500);
    if (k < steps.length - 1) { await s.click$('#r-next'); await sleep(60); }
  }
  const fired = await s.eval(`__fired`);
  const lies = steps.map((t, i) => t ? -1 : i).filter(i => i >= 0);
  const truth = steps.indexOf(true);
  ok(lies.every(i => fired.some(f => f.step === i && f.kind === 'spark' && f.drawn)), `${tag} every LIE gets its red spray`, `${lies.length} lies`);
  ok(fired.some(f => f.step === truth && f.kind === 'star' && f.drawn), `${tag} the TRUTH gets its shower of stars`);
  ok(fired.some(f => f.step === truth && f.kind === 'ring' && f.drawn), `${tag} its points get a ring, not sparks over the number`);
  ok(!fired.some(f => f.step === truth && f.kind === 'spark'), `${tag} nothing is sprayed over the points`);
  // moving on before the stamp lands must not fire the old step's effect
  await s.click$('#r-next'); await sleep(900);
  ok(await s.screen() === 'scores', `${tag} on to the scores`);
  ok((await s.stats()).alive > 0, `${tag} scores that went up get their ring`);
  await s.shot(`${SHOTS}/${dev.name}-fx-scores.png`);

  await s.eval(`showFinal()`); await sleep(900);
  const fin = await s.stats();
  ok(fin.alive > 60, `${tag} the winner gets confetti and stars`, `${fin.alive} pieces`);
  await s.shot(`${SHOTS}/${dev.name}-fx-final.png`);
  ok(await s.asleep(6000), `${tag} it all clears and it sleeps again`);

  const errs = s.errors();
  ok(errs.length === 0, `${tag} no console errors`, errs.map(e => JSON.stringify(e.params).slice(0, 200)).join(' | '));
  await s.close();
}

/* A host that moves on quickly: the effect of a step that is no longer on
   screen must not fire over the next one. */
async function skipAhead(dev) {
  const tag = `${dev.name} (${RENDER}) skipping:`;
  const s = await open(dev);
  await s.ready();
  await s.eval(`(() => {
    const names = ['A','B','C']; document.querySelector('#go-local').click();
    while (document.querySelectorAll('#player-list input').length < 3) document.querySelector('#add-player').click();
    document.querySelectorAll('#player-list input').forEach((el, i) => { el.value = names[i]; el.dispatchEvent(new Event('input', { bubbles: true })); });
  })()`);
  await s.click$('.seg[data-key=sound] button[data-v="0"]');
  await s.click$('#start'); await sleep(200);
  // fill in the round through the rules engine directly, then reveal
  await s.eval(`(() => {
    Engine.activePlayers(state).forEach((p, i) => Engine.submitLie(state, p.id, 'Skip lie ' + i));
    lockLies();
    // everyone falls for someone else's lie, so the reveal has several steps
    Engine.activePlayers(state).forEach(p => { for (const c of state.choices.filter(c => !c.truth)) if (!Engine.submitPick(state, p.id, c.id)) break; });
    lockPicks();
  })()`);
  await sleep(200);
  ok(await s.screen() === 'reveal', `${tag} on the reveal`);
  const n = await s.eval(`state.steps.length`);
  ok(n >= 3, `${tag} several steps to skip through`, `${n}`);
  await s.asleep();
  // Record which step each burst was fired for, then race past the first steps.
  await s.eval(`window.__fired = []; const b = FX.burst; FX.burst = (t, o) => { __fired.push(revealIndex); return b(t, o); }`);
  await s.eval(`revealNext(); revealNext();`);
  const at = await s.eval(`revealIndex`);
  await sleep(2400);
  const fired = await s.eval(`__fired`);
  ok(fired.length > 0 && fired.every(i => i === at), `${tag} only the step on screen fires`, `on step ${at}, fired for [${fired}]`);
  ok(!(await s.errors()).length, `${tag} no errors`);
  await s.close();
}

async function reducedMotion(dev) {
  const tag = `${dev.name} reduced motion:`;
  const s = await open(dev, { media: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await s.ready();
  ok((await s.stats()).reduceMotion, `${tag} setting is read`);
  ok(!(await s.eval(`FX.flash('#ffc53d')`)) && !(await s.eval(`FX.shake(document.body)`)), `${tag} no flash, no shake`);
  await s.eval(`FX.confetti()`); await sleep(300);
  const n = (await s.stats()).alive;
  ok(n > 0 && n <= 30, `${tag} only a little confetti`, `${n} pieces`);
  await s.close();
}

async function withoutPhaser(dev) {
  const tag = `${dev.name} without Phaser:`;
  const s = await open(dev, { block: ['*phaser.min.js'] });
  ok(await s.eval(`typeof Phaser === 'undefined'`), `${tag} Phaser really is missing`);
  ok(!(await s.eval(`FX.ready`)) && !(await s.eval(`FX.sound('click')`)), `${tag} effects say no, quietly`);
  await s.click$('#go-local'); await sleep(200);
  ok(await s.screen() === 'setup', `${tag} the show still runs`);
  await s.eval(`sfx.drum(); sfx.win(); FX.confetti(); FX.burst('#start')`);
  const errs = s.errors().filter(e => !/phaser\.min\.js/.test(JSON.stringify(e.params)));
  ok(errs.length === 0, `${tag} no errors`, errs.map(e => JSON.stringify(e.params).slice(0, 200)).join(' | '));
  await s.close();
}

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await launch();
  const phone = { name: 'phone', width: 390, height: 844, mobile: true, scale: 3 };
  const tv = { name: 'tv', width: 1920, height: 1080, mobile: false, scale: 1 };
  await main(phone);
  await main(tv);
  await skipAhead(phone);
  await reducedMotion(phone);
  await withoutPhaser(phone);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
