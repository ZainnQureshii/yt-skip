// Harness for the audio ownership state machine in skipper.js.
// Stubs just enough DOM for the script to run, then drives ad breaks and user actions.

const fs = require('fs');
const vm = require('vm');

class Media {
  constructor() {
    this._muted = false;
    this.volume = 0.5;
    this.isConnected = true;
    this.listeners = [];
    this.queue = [];
  }
  // Writing muted queues the event rather than dispatching it, because the browser
  // delivers volumechange as a task. Tests drain the queue where they choose, so an
  // event arriving after a later tick is expressible.
  get muted() { return this._muted; }
  set muted(value) {
    if (this._muted === value) return;
    this._muted = value;
    this.queue.push(true);
  }
  addEventListener(type, fn) { if (type === 'volumechange') this.listeners.push(fn); }
  removeEventListener(type, fn) { this.listeners = this.listeners.filter((f) => f !== fn); }
  drain() {
    const pending = this.queue.length;
    this.queue = [];
    for (let i = 0; i < pending; i += 1) this.listeners.slice().forEach((fn) => fn({ target: this }));
  }
  setByUser(value) { this.muted = value; }
  setByVolume(value) { this.volume = value; this.queue.push(true); }
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

const media = new Media();
const player = new Player(media);
const timers = [];

const sandbox = {
  document: {
    querySelector: (sel) => (sel === '#movie_player' ? player : null),
    addEventListener: () => {}
  },
  getComputedStyle: () => ({ pointerEvents: 'auto', visibility: 'visible', display: 'block', opacity: '1' }),
  MutationObserver: class { observe() {} disconnect() {} },
  setInterval: (fn) => { timers.push(fn); return timers.length; },
  // The script logs diagnostics and schedules a post click check. Neither is under
  // test, so both are stubbed to keep the output readable and the clock still.
  setTimeout: () => 0,
  console: { log: () => {} },
  location: { href: 'https://www.youtube.com/watch?v=test' },
  Date
};
sandbox.window = sandbox;
// Clicking is off by default in the extension because YouTube rejects synthetic clicks.
// The selection logic is still the code that would pick a target, so it is still tested.
sandbox.__ytSkipConfig = { clickSkip: true, speedUp: false };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'skipper.js'), 'utf8'), sandbox);

const tick = () => timers.forEach((fn) => fn());
const results = [];
const check = (name, actual, expected) => {
  const ok = actual === expected;
  results.push({ name, ok, actual, expected });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${actual}, expected ${expected})`);
};

// 1. Ad starts. We silence it.
player.classList.add('ad-showing');
tick();
check('ad start mutes', media.muted, true);
media.drain();

// 2. Ad ends. We restore what we silenced.
player.classList.remove('ad-showing');
tick();
check('ad end restores audio', media.muted, false);
media.drain();

// 3. User unmutes during an ad. We must not re-mute on the next tick.
player.classList.add('ad-showing');
tick();
media.drain();
check('second ad mutes', media.muted, true);
media.setByUser(false);
tick();
tick();
check('user unmute is not reversed', media.muted, false);

// 4. Ad ends after the user took over. We must not touch their setting.
player.classList.remove('ad-showing');
tick();
check('no interference after user took over', media.muted, false);

// 5. Fresh break after the override. Ownership resets and we silence again.
player.classList.add('ad-showing');
tick();
check('next break silences again', media.muted, true);
media.drain();

// 6. User was already muted before an ad. We must not claim it, so we must not unmute later.
player.classList.remove('ad-showing');
tick();
media.drain();
media.setByUser(true);
player.classList.add('ad-showing');
tick();
player.classList.remove('ad-showing');
tick();
check('pre-existing user mute survives an ad break', media.muted, true);

// 7. A volume change while no ad is playing is ordinary listening and must not
// disable the feature for the next ad break.
media.setByUser(false);
media.drain();
media.setByVolume(0.8);
player.classList.add('ad-showing');
tick();
check('volume change outside an ad does not suppress the next break', media.muted, true);
media.drain();

// 8. A volume nudge during an ad is not a rejection of our mute. We keep it muted.
media.setByVolume(0.9);
tick();
check('volume nudge during an ad keeps the ad muted', media.muted, true);

// 9. And critically, we must still restore afterwards rather than strand them muted.
player.classList.remove('ad-showing');
tick();
check('volume nudge does not strand the user muted', media.muted, false);

// 11. Out of order delivery. Our mute event has not been dispatched yet when the user
// moves the volume slider, so both events arrive after a later tick. We must still
// recognise our own write and still restore the audio at the end of the break.
player.classList.add('ad-showing');
tick();
media.setByVolume(0.3);
tick();
media.drain();
check('a volume nudge racing our own mute does not strand the user', media.muted, true);
player.classList.remove('ad-showing');
tick();
media.drain();
check('audio is restored after a raced volume nudge', media.muted, false);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
