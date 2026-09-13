/* Bluff Show — room mode messenger.
   Carries small messages between the host screen and the phones in a room.
   It knows nothing about the game rules: it only delivers messages.

   Normally messages travel through Supabase Realtime (a "broadcast" channel
   named after the room code). Add ?transport=local to the address to use the
   browser's own BroadcastChannel instead — tabs in one browser can then play a
   room with no internet, which is how the automated tests run room mode. */
(function () {
  const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/dist/umd/supabase.js';
  const QR_JS = 'https://cdn.jsdelivr.net/npm/qrcode-generator@2.0.4/dist/qrcode.js';
  const LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels, so a code never spells a word

  const useLocal = () => new URLSearchParams(location.search).get('transport') === 'local';

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const found = document.querySelector(`script[src="${src}"]`);
      if (found) return found.dataset.ready ? resolve() : found.addEventListener('load', resolve);
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => { s.dataset.ready = '1'; resolve(); };
      s.onerror = () => reject(new Error('Could not load ' + src));
      document.head.appendChild(s);
    });
  }

  function isConfigured() {
    const c = window.BLUFF_CONFIG || {};
    return useLocal() || Boolean(c.supabaseUrl && c.supabaseKey);
  }

  function makeCode() {
    return Array.from({ length: 4 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join('');
  }

  const cleanCode = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  let client = null;

  /* Open the room's channel. `onMessage(msg)` receives everything the others send.
     `onStatus(text)` hears 'connected' | 'reconnecting' | 'error'.
     Returns { send(msg), close() }. */
  async function join(code, onMessage, onStatus = () => {}) {
    const name = 'bluff-show-' + cleanCode(code);

    if (useLocal()) {
      const bc = new BroadcastChannel(name);
      bc.onmessage = e => onMessage(e.data);
      onStatus('connected');
      return { send: msg => bc.postMessage(msg), close: () => bc.close() };
    }

    await loadScript(SUPABASE_JS);
    const cfg = window.BLUFF_CONFIG;
    client = client || window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
    const channel = client.channel(name, { config: { broadcast: { self: false, ack: false } } });
    channel.on('broadcast', { event: 'msg' }, ({ payload }) => onMessage(payload));

    await new Promise((resolve, reject) => {
      let settled = false;
      channel.subscribe(status => {
        if (status === 'SUBSCRIBED') {
          onStatus('connected');
          if (!settled) { settled = true; resolve(); }
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          onStatus('reconnecting');
          if (!settled) { settled = true; reject(new Error('Could not reach the room server')); }
        } else if (status === 'CLOSED') {
          onStatus('reconnecting');
        }
      });
    });

    return {
      send: msg => channel.send({ type: 'broadcast', event: 'msg', payload: msg }),
      close: () => client.removeChannel(channel),
    };
  }

  // Draw a QR code for the join link, as an SVG string.
  async function qrSvg(text) {
    await loadScript(QR_JS);
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  window.Room = { isConfigured, makeCode, cleanCode, join, qrSvg, useLocal };
})();
