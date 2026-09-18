/* The effects layer: confetti, bursts, flashes and real sound, drawn by Phaser
   on a see-through canvas laid over the whole page.

   The game itself is not drawn here and never will be. Its screens, buttons,
   text boxes and drawing pad stay ordinary HTML, because that is what makes
   typing and finger-drawing feel right. This layer only adds the moments on
   top, and it is built so it can never get in their way:

   - It ignores touches. `pointer-events: none` sends every tap straight
     through to the page underneath.
   - It sleeps. When nothing is playing, Phaser's game loop is stopped and the
     canvas is hidden, so a player drawing or typing pays nothing for it.
   - It is optional. If Phaser fails to load, every call below quietly does
     nothing and returns false, and the game falls back to its own beeps.

   The same file is used by Scribble Relay and by Bluff Show. Each game keeps
   its own copy next to its own vendor/phaser.min.js and its own sound bank
   (SOUND_BANK, in sounds.js, with the per-sound settings in SOUND_SPEC).

   Calls, all safe to make at any time:
     FX.sound(name)             play a sound; false if it could not
     FX.burst(target, opts)     a spray of sparks or stars from an element
     FX.confetti(opts)          two party cannons from the bottom corners
     FX.ring(target, colour)    one ring expanding out of an element
     FX.flash(colour)           the whole screen flashes and fades
     FX.shake(element)          shakes a page element (plain HTML, no Phaser)
     FX.pop(element)            gives a page element a springy pop
     FX.stats()                 what the layer is doing, for the tests
*/
(function () {
  'use strict';

  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hex = (c) => typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16);
  // Confetti and default burst colours. A game can set its own palette by
  // defining FX_PALETTE (an array of '#rrggbb') before this file loads.
  const PARTY = (window.FX_PALETTE || ['#ff5a5f', '#ffd23f', '#43b649', '#2a9df4', '#9b5de5', '#ff85c0', '#ff8c1a']).map(hex);

  // How long the loop stays awake after the last thing started, at least.
  const LINGER_MS = 250;

  /* ---- textures, painted on plain canvases ----
     Painted at twice the size they are shown, so they stay crisp when the
     camera zooms up for a retina screen.

     Each colour is painted into its own texture rather than tinted at draw
     time, because Phaser's Canvas renderer -- the fallback when a browser has
     no WebGL -- ignores tint, and everything would come out white. White
     confetti on a light page looks like the text is being rubbed out. */
  const css = (c) => '#' + c.toString(16).padStart(6, '0');
  function canvas(w, h, paint) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    paint(c.getContext('2d'), w, h);
    return c;
  }
  // A soft dot: solid in the middle, fading out. Reads on light and dark pages.
  const sparkTex = (c) => canvas(64, 64, (x, w) => {
    const g = x.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, css(c)); g.addColorStop(0.45, css(c));
    g.addColorStop(1, css(c) + '00');
    x.fillStyle = g; x.fillRect(0, 0, w, w);
  });
  // A five-point star with a thin dark edge, so a yellow star shows on cream.
  const starTex = (c) => canvas(64, 64, (x, w) => {
    x.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? w * 0.2 : w * 0.46;
      const a = -Math.PI / 2 + i * Math.PI / 5;
      x.lineTo(w / 2 + Math.cos(a) * r, w / 2 + Math.sin(a) * r);
    }
    x.closePath(); x.fillStyle = css(c); x.fill();
    x.lineWidth = 3; x.strokeStyle = 'rgba(20,20,40,0.45)'; x.stroke();
  });
  // Confetti: one strip holding a rectangle of every party colour, each its own frame.
  const CW = 16, CH = 26;
  const confettiTex = () => canvas(CW * PARTY.length, CH, (x) => {
    PARTY.forEach((c, i) => {
      x.fillStyle = css(c); x.beginPath();
      x.roundRect ? x.roundRect(i * CW + 1, 1, CW - 2, CH - 2, 3) : x.rect(i * CW + 1, 1, CW - 2, CH - 2);
      x.fill();
    });
  });
  const ringTex = (c) => canvas(128, 128, (x, w) => {
    x.strokeStyle = css(c); x.lineWidth = 7;
    x.beginPath(); x.arc(w / 2, w / 2, w / 2 - 5, 0, Math.PI * 2); x.stroke();
  });

  // What a spray of each kind looks like. The colour is in the texture.
  const KINDS = {
    spark: { paint: sparkTex, depth: 20, config: {
      lifespan: 650, speed: { min: 80, max: 320 }, scale: { start: 0.42, end: 0 },
      alpha: { start: 1, end: 0 }, gravityY: 380, emitting: false } },
    star: { paint: starTex, depth: 30, config: {
      lifespan: 900, speed: { min: 140, max: 420 }, scale: { start: 0.5, end: 0.1 },
      alpha: { start: 1, end: 0 }, rotate: { start: 0, end: 300 }, gravityY: 520, emitting: false } },
  };

  /* ---- the scene ----
     Made inside a function, not at the top of the file: `extends Phaser.Scene`
     would throw the moment this file loads if Phaser had failed to, and the
     whole point is that a missing Phaser costs nothing but the effects. */
  const makeScene = () => class FxScene extends Phaser.Scene {
    constructor() { super({ key: 'fx' }); }

    preload() {
      if (typeof SOUND_BANK === 'undefined') return;
      for (const [name, uri] of Object.entries(SOUND_BANK)) this.load.audio('sfx-' + name, uri);
    }

    create() {
      const tex = this.textures.addCanvas('confetti', confettiTex());
      PARTY.forEach((_, i) => tex.add(i, 0, i * CW, 0, CW, CH));
      const frames = PARTY.map((_, i) => i);

      // Two cannons, one per bottom corner, aimed up and in.
      const cannon = (angle) => this.add.particles(0, 0, 'confetti', {
        frame: frames, lifespan: 2600, angle, speed: { min: 520, max: 1050 }, gravityY: 820,
        scale: { min: 0.5, max: 0.9 }, rotate: { start: 0, end: 720 },
        alpha: { start: 1, end: 0, ease: 'Expo.easeIn' }, emitting: false,
      }).setDepth(10);
      this.cannonL = cannon({ min: -80, max: -55 });
      this.cannonR = cannon({ min: -125, max: -100 });
      this.emitters = [this.cannonL, this.cannonR];
      this.sprays = new Map();

      this.flashRect = this.add.rectangle(0, 0, 10, 10, 0xffffff, 1).setOrigin(0, 0).setAlpha(0).setDepth(40);

      layer.onReady(this);
    }

    // The emitter for one kind in one colour, made the first time it is asked for.
    spray(kind, color) {
      const key = kind + '-' + color.toString(16);
      let e = this.sprays.get(key);
      if (!e) {
        const k = KINDS[kind];
        this.textures.addCanvas(key, k.paint(color));
        e = this.add.particles(0, 0, key, k.config).setDepth(k.depth);
        this.sprays.set(key, e);
        this.emitters.push(e);
      }
      return e;
    }

    // A ring texture in one colour, likewise.
    ringKey(color) {
      const key = 'ring-' + color.toString(16);
      if (!this.textures.exists(key)) this.textures.addCanvas(key, ringTex(color));
      return key;
    }

    alive() {
      let n = 0;
      for (const e of this.emitters) n += e.getAliveParticleCount();
      return n + this.tweens.getTweens().length;
    }

    update(now) {
      if (this.alive() === 0 && now > layer.awakeUntil) layer.sleep();
    }
  };

  /* ---- the layer ---- */
  const layer = {
    game: null,
    scene: null,
    canvas: null,
    awake: true,
    awakeUntil: 0,
    w: 1, h: 1, dpr: 1,
    sleeps: 0,

    boot() {
      if (typeof Phaser === 'undefined') return;
      this.measure();
      try {
        this.game = new Phaser.Game({
          type: Phaser.AUTO,
          parent: document.body,
          width: this.w * this.dpr,
          height: this.h * this.dpr,
          transparent: true,
          banner: false,
          // Phaser's own input is off: this layer never takes a touch.
          input: { keyboard: false, mouse: false, touch: false, gamepad: false },
          scale: { mode: Phaser.Scale.NONE, autoRound: false },
          scene: new (makeScene())(),
        });
        // Pinned straight away, not when the scene is ready: Phaser adds the
        // canvas to the page first, and until then it would sit at the foot of
        // the page, taking up room and taking taps.
        if (this.game.canvas) this.pin(this.game.canvas);
      } catch (e) {
        console.warn('Effects layer did not start; the game plays on without it.', e);
        this.game = null;
      }
      addEventListener('resize', () => this.resize());
    },

    measure() {
      this.w = Math.max(1, innerWidth);
      this.h = Math.max(1, innerHeight);
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    },

    pin(c) {
      c.id = 'fx-layer';
      c.setAttribute('aria-hidden', 'true');
      Object.assign(c.style, {
        position: 'fixed', left: '0', top: '0', zIndex: '9999', pointerEvents: 'none',
        width: this.w + 'px', height: this.h + 'px',
      });
    },

    onReady(scene) {
      this.scene = scene;
      this.canvas = this.game.canvas;
      this.pin(this.canvas);
      this.resize();
      this.awakeUntil = performance.now() + LINGER_MS;
    },

    /* The game is sized in device pixels so the effects are sharp on a phone,
       and the camera is zoomed back so that one world unit is one CSS pixel with
       (0,0) on the top-left of the screen -- the same numbers that
       getBoundingClientRect() gives. Same technique as Auxetic Chess's board. */
    resize() {
      if (!this.scene) return;
      this.measure();
      this.scene.scale.resize(this.w * this.dpr, this.h * this.dpr);
      this.canvas.style.width = this.w + 'px';
      this.canvas.style.height = this.h + 'px';
      const cam = this.scene.cameras.main;
      cam.setZoom(this.dpr);
      cam.setScroll((this.w / 2) * (1 - this.dpr), (this.h / 2) * (1 - this.dpr));
      this.scene.flashRect.setSize(this.w, this.h);
    },

    wake(ms = 0) {
      if (!this.scene) return false;
      this.awakeUntil = Math.max(this.awakeUntil, performance.now() + Math.max(ms, LINGER_MS));
      if (!this.awake) {
        this.awake = true;
        this.canvas.style.visibility = 'visible';
        this.game.loop.wake();
      }
      return true;
    },

    sleep() {
      if (!this.awake) return;
      this.awake = false;
      this.sleeps++;
      // Hidden as well as stopped, so the browser does not even composite it.
      this.canvas.style.visibility = 'hidden';
      this.game.loop.sleep();
    },
  };

  /* Where on screen an element (or a selector, or a point) is, in CSS pixels. */
  function pointOf(target) {
    if (!target) return { x: layer.w / 2, y: layer.h / 2 };
    if (typeof target === 'string') target = document.querySelector(target);
    if (target && typeof target.x === 'number' && !(target instanceof Element)) return target;
    if (!(target instanceof Element)) return null;
    const r = target.getBoundingClientRect();
    if (!r.width && !r.height) return null;      // hidden: nothing to burst from
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }

  const FX = {
    get ready() { return !!layer.scene; },

    sound(name, opts = {}) {
      const s = layer.scene;
      if (!s || typeof SOUND_SPEC === 'undefined') return false;
      const spec = SOUND_SPEC[name];
      if (!spec || !s.cache.audio.exists('sfx-' + name)) return false;
      // Until the page has been touched the browser will not play anything.
      // Say so, so the caller's own beep gets its turn instead.
      if (s.sound.locked) return false;
      try {
        const [lo, hi] = spec.rate || [1, 1];
        const snd = s.sound.add('sfx-' + name);
        snd.once('complete', () => snd.destroy());
        snd.play({
          volume: (opts.volume ?? 1) * (spec.volume ?? 0.5),
          rate: lo + Math.random() * (hi - lo),
          delay: opts.delay || 0,
        });
        // Phaser tidies finished sounds up on its own clock, so keep it running
        // until this one is over.
        layer.wake(((opts.delay || 0) + (snd.duration || 1)) * 1000 + 100);
        return true;
      } catch (_) { return false; }
    },

    burst(target, { kind = 'spark', color, colors, count = 18 } = {}) {
      const p = pointOf(target);
      if (!p || !layer.wake()) return false;
      if (!KINDS[kind]) kind = 'spark';
      // One colour, or several -- a small spray of each.
      const list = colors ? colors.map(hex) : color != null ? [hex(color)] : PARTY;
      const each = Math.max(1, Math.round(count / list.length));
      for (const c of list) layer.scene.spray(kind, c).emitParticleAt(p.x, p.y, each);
      return true;
    },

    confetti({ count = 70 } = {}) {
      if (!layer.wake()) return false;
      const n = reduceMotion ? Math.round(count / 5) : count;
      const s = layer.scene;
      s.cannonL.emitParticleAt(0, layer.h + 10, n);
      s.cannonR.emitParticleAt(layer.w, layer.h + 10, n);
      if (!reduceMotion) {
        // A second, smaller volley a moment later, the way a real popper feels.
        s.time.delayedCall(260, () => {
          s.cannonL.emitParticleAt(0, layer.h + 10, Math.round(n / 2));
          s.cannonR.emitParticleAt(layer.w, layer.h + 10, Math.round(n / 2));
        });
        layer.wake(400);
      }
      return true;
    },

    ring(target, color = 0xffffff) {
      const p = pointOf(target);
      if (!p || !layer.wake()) return false;
      const s = layer.scene;
      const img = s.add.image(p.x, p.y, s.ringKey(hex(color))).setScale(0.15).setAlpha(0.9).setDepth(25);
      s.tweens.add({
        targets: img, scale: 0.9, alpha: 0, duration: 520, ease: 'Cubic.easeOut',
        onComplete: () => img.destroy(),
      });
      return true;
    },

    flash(color = 0xffffff, strength = 0.35) {
      if (reduceMotion || !layer.wake()) return false;
      const r = layer.scene.flashRect;
      r.setFillStyle(hex(color), 1);
      layer.scene.tweens.killTweensOf(r);
      r.setAlpha(strength);
      layer.scene.tweens.add({ targets: r, alpha: 0, duration: 420, ease: 'Quad.easeOut' });
      return true;
    },

    /* The two below move page elements, not Phaser objects -- a shake has to
       move the actual card the players are reading. Web Animations, so they
       need no Phaser at all and never touch the element's own styles. */
    shake(el, px = 9) {
      if (typeof el === 'string') el = document.querySelector(el);
      if (!el || reduceMotion || !el.animate) return false;
      el.animate([
        { transform: 'translateX(0)' }, { transform: `translateX(${-px}px)` },
        { transform: `translateX(${px}px)` }, { transform: `translateX(${-px * 0.6}px)` },
        { transform: `translateX(${px * 0.4}px)` }, { transform: 'translateX(0)' },
      ], { duration: 420, easing: 'ease-out', composite: 'add' });
      return true;
    },

    pop(el) {
      if (typeof el === 'string') el = document.querySelector(el);
      if (!el || reduceMotion || !el.animate) return false;
      el.animate([
        { transform: 'scale(1)' }, { transform: 'scale(1.14)', offset: 0.35 },
        { transform: 'scale(0.96)', offset: 0.7 }, { transform: 'scale(1)' },
      ], { duration: 380, easing: 'ease-out', composite: 'add' });
      return true;
    },

    stats() {
      const s = layer.scene;
      return {
        ready: !!s,
        awake: layer.awake,
        sleeps: layer.sleeps,
        alive: s ? s.alive() : 0,
        renderer: layer.game ? (layer.game.config.renderType === Phaser.WEBGL ? 'webgl' : 'canvas') : 'none',
        sounds: s && typeof SOUND_BANK !== 'undefined'
          ? Object.keys(SOUND_BANK).filter((k) => s.cache.audio.exists('sfx-' + k)).length : 0,
        locked: s ? s.sound.locked : true,
        reduceMotion,
      };
    },
  };

  window.FX = FX;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => layer.boot());
  else layer.boot();
})();
