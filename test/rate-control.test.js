// Harness for the playback rate control in skipper.js.
// Acceleration is what actually ends an ad, since YouTube refuses synthetic clicks,
// so the cases that matter are the player resetting the rate mid pod and never
// leaving the programme running fast.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

class Media {
  constructor(rate = 1) {
    this.muted = false;
    this.volume = 0.5;
    this.playbackRate = rate;
    this.isConnected = true;
  }
  addEventListener() {}
  removeEventListener() {}
}

class Player {
  constructor(media) {
    this.isConnected = true;
    this._media = media;
    this._classes = new Set();
    this.classList = {
      contains: (c) => this._classes.has(c),
      add: (c) => this._classes.add(c),
      remove: (c) => this._classes.delete(c)
    };
  }
  querySelector(sel) { return sel === 'video' ? this._media : null; }
  querySelectorAll() { return []; }
}

let media = new Media();
const player = new Player(media);
const timers = [];

const sandbox = {
  document: {
    querySelector: (sel) => (sel === '#movie_player' ? player : null),
    addEventListener: () => {}
  },
  getComputedStyle: () => ({ pointerEvents: 'auto' }),
  MutationObserver: class { observe() {} disconnect() {} },
  setInterval: (fn) => { timers.push(fn); return timers.length; },
  setTimeout: () => 0,
  console: { log: () => {} },
  location: { href: 'https://www.youtube.com/watch?v=test' },
  Date
};
sandbox.window = sandbox;
sandbox.__ytSkipConfig = { clickSkip: false, speedUp: true, adRate: 16 };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'skipper.js'), 'utf8'), sandbox);

const tick = () => timers.forEach((fn) => fn());
const results = [];
const check = (name, actual, expected) => {
  const ok = actual === expected;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${actual}, expected ${expected})`);
};

// 1. An ad runs at speed.
player.classList.add('ad-showing');
tick();
check('ad is accelerated', media.playbackRate, 16);

// 2. The programme runs at normal speed again afterwards.
player.classList.remove('ad-showing');
tick();
check('programme returns to normal speed', media.playbackRate, 1);

// 3. The player resets the rate between ads in a pod. We must reapply, not give up.
// This is the case that a takeover flag would have broken.
player.classList.add('ad-showing');
tick();
media.playbackRate = 1;
tick();
check('acceleration is reapplied after the player resets it', media.playbackRate, 16);

// 4. A non standard original rate is honoured rather than assumed to be 1.
player.classList.remove('ad-showing');
tick();
media.playbackRate = 1.5;
player.classList.add('ad-showing');
tick();
check('an ad still accelerates from a custom rate', media.playbackRate, 16);
player.classList.remove('ad-showing');
tick();
check('the custom rate is restored, not clobbered to 1', media.playbackRate, 1.5);

// 5. The media element is replaced mid ad, which happens between ads in a pod.
player.classList.add('ad-showing');
tick();
const firstMedia = media;
media = new Media();
player._media = media;
tick();
check('a replacement element is accelerated too', media.playbackRate, 16);
check('the replaced element is not left running fast', firstMedia.playbackRate, 1.5);

// 6. Nothing is touched when no ad is playing.
player.classList.remove('ad-showing');
tick();
media.playbackRate = 2;
tick();
check('a rate set outside an ad is left alone', media.playbackRate, 2);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
