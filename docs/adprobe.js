// Ad probe. Paste into the YouTube tab's console, then play a video with an ad.
//
// This runs in the page's main world. The extension runs in an isolated world with its own
// copy of the DOM prototypes, so a setter patched here catches YouTube's writes and never
// ours. Anything this reports as PAGE-SET was written by the player, not by YT Skip.
//
// Dumps by itself once the programme is playing again. __ytProbe.dump() forces it early.

(() => {
  'use strict';

  if (window.__ytProbe) { window.__ytProbe.stop(); }

  const t0 = performance.now();
  const at = () => ((performance.now() - t0) / 1000).toFixed(3);
  const rows = [];
  const rec = (kind, detail) => rows.push({ t: at(), kind, detail });

  const player = document.querySelector('#movie_player');
  if (!player) { console.warn('[probe] no #movie_player, open a video first'); return; }

  const vid = () => player.querySelector('video');

  const ahead = (v) => {
    const b = v.buffered;
    for (let i = 0; i < b.length; i += 1) {
      if (b.start(i) <= v.currentTime + 0.01 && v.currentTime <= b.end(i) + 0.01) {
        return +(b.end(i) - v.currentTime).toFixed(2);
      }
    }
    return 0;
  };

  // Where the player writes the property from. Two frames is enough to tell base.js apart
  // from anything else without making the log unreadable.
  const origin = () => {
    const lines = (new Error().stack || '').split('\n').slice(3, 5);
    return lines.map((l) => l.trim().replace(/^at\s+/, '').slice(0, 60)).join(' < ');
  };

  const patched = [];
  const patch = (prop) => {
    const d = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, prop);
    if (!d || !d.set) return;
    patched.push([prop, d]);
    Object.defineProperty(HTMLMediaElement.prototype, prop, {
      configurable: true,
      enumerable: d.enumerable,
      get: d.get,
      set(value) {
        rec('PAGE-SET ' + prop, value + '  from ' + origin());
        d.set.call(this, value);
      }
    });
  };
  ['muted', 'volume', 'playbackRate'].forEach(patch);

  const MEDIA_EVENTS = ['volumechange', 'ratechange', 'loadstart', 'emptied', 'loadedmetadata',
    'waiting', 'stalled', 'playing', 'pause', 'ended', 'seeking', 'seeked', 'error'];

  let watched = null;
  const onMedia = (e) => {
    const v = e.target;
    rec(e.type, 'muted=' + v.muted + ' vol=' + v.volume.toFixed(2) + ' rate=' + v.playbackRate +
      ' t=' + v.currentTime.toFixed(2) + ' ready=' + v.readyState + ' net=' + v.networkState +
      ' ahead=' + ahead(v));
  };
  const watch = () => {
    const v = vid();
    if (!v || v === watched) return;
    if (watched) MEDIA_EVENTS.forEach((n) => watched.removeEventListener(n, onMedia, true));
    watched = v;
    MEDIA_EVENTS.forEach((n) => watched.addEventListener(n, onMedia, true));
    rec('media element', 'attached, src=' + (v.currentSrc || '').slice(0, 40));
  };
  watch();

  // Trusted input is the only evidence that a volume change was actually the user. Logged so the
  // dump can say whether a foreign unmute had a real gesture behind it or not.
  const onInput = (e) => {
    if (!e.isTrusted) return;
    const el = e.target instanceof Element ? e.target : null;
    rec('user ' + e.type, (el ? (el.className || el.tagName) : '?') + (e.key ? ' key=' + e.key : ''));
  };
  ['pointerdown', 'keydown'].forEach((n) => document.addEventListener(n, onInput, true));

  let wasAd = player.classList.contains('ad-showing');
  rec('start', 'ad-showing=' + wasAd);
  const mo = new MutationObserver(() => {
    watch();
    const isAd = player.classList.contains('ad-showing');
    if (isAd === wasAd) return;
    wasAd = isAd;
    const badge = document.querySelector('.ytp-ad-simple-ad-badge, .ytp-ad-badge, .ytp-ad-text');
    rec(isAd ? 'AD START' : 'AD END', badge ? (badge.textContent || '').trim().slice(0, 40) : '');
    if (!isAd) armDump();
  });
  mo.observe(player, { attributes: true, attributeFilter: ['class'], subtree: true, childList: true });

  // Effective rate is the number that matters. playbackRate says what was asked for, this says
  // what the pipeline delivered, and the two diverge exactly when the buffer runs dry.
  let last = null;
  const sample = setInterval(() => {
    const v = vid();
    if (!v) return;
    const now = performance.now();
    if (last && last.v === v) {
      const eff = (v.currentTime - last.t) / ((now - last.now) / 1000);
      rows.push({ t: at(), kind: 'sample', detail: 'eff=' + eff.toFixed(1) + 'x rate=' + v.playbackRate +
        ' muted=' + v.muted + ' vol=' + v.volume.toFixed(2) + ' ready=' + v.readyState +
        ' ahead=' + ahead(v) + ' ad=' + player.classList.contains('ad-showing') });
    }
    last = { v, t: v.currentTime, now };
  }, 250);

  let dumpTimer = null;
  const armDump = () => { clearTimeout(dumpTimer); dumpTimer = setTimeout(dump, 5000); };

  function dump() {
    console.log('%c[probe] ' + rows.length + ' rows', 'font-weight:bold');
    console.log(rows.map((r) => r.t.padStart(8) + '  ' + r.kind.padEnd(18) + '  ' + r.detail).join('\n'));
    // Emptied after printing. The dump fires itself 5s after an ad ends and nothing calls
    // stop(), so without this the array keeps every row for the life of the page and the
    // next ad's dump is buried under the last one's. The patches stay on deliberately, so
    // a second ad still records.
    rows.length = 0;
  }

  function stop() {
    clearInterval(sample);
    clearTimeout(dumpTimer);
    mo.disconnect();
    if (watched) MEDIA_EVENTS.forEach((n) => watched.removeEventListener(n, onMedia, true));
    ['pointerdown', 'keydown'].forEach((n) => document.removeEventListener(n, onInput, true));
    patched.forEach(([prop, d]) => Object.defineProperty(HTMLMediaElement.prototype, prop, d));
  }

  window.__ytProbe = { dump, stop, rows };
  console.log('%c[probe] recording. Play through one ad. It dumps itself 5s after the ad ends, or call __ytProbe.dump()', 'color:#0a0');
})();
