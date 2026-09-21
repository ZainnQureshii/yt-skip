// Harness for the audio ownership state machine in skipper.js.
// Stubs just enough DOM for the script to run, then drives ad breaks, player writes and
// real user actions. The clock is stubbed because ownership now turns on how recently a
// genuine gesture happened, and a real clock would make every case look like a gesture.

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
  // The player re-syncing its own volume model. Indistinguishable from a user write at the
  // element, which is the whole reason the gesture clock exists. The user's own writes go
  // through setByUser in the cases below, so every case says plainly who acted.
  setByPlayer(value) { this.muted = value; }
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
const gestureListeners = [];
let clock = 1000000;
// Comfortably past the script's gesture window, so an advance of this much makes any
// earlier gesture too old to excuse the next unmute.
const GESTURE_STALE = 5000;

const sandbox = {
  document: {
    querySelector: (sel) => (sel === '#movie_player' ? player : null),
    addEventListener: (type, fn) => {
      if (type === 'pointerdown' || type === 'keydown') gestureListeners.push(fn);
    }
  },
  getComputedStyle: () => ({ pointerEvents: 'auto', visibility: 'visible', display: 'block', opacity: '1' }),
  MutationObserver: class { observe() {} disconnect() {} },
  setInterval: (fn) => { timers.push(fn); return timers.length; },
  // Diagnostics are not under test, so logging is stubbed to keep the output readable.
  setTimeout: () => 0,
  console: { log: () => {} },
  location: { href: 'https://www.youtube.com/watch?v=test' },
  Date: { now: () => clock }
};
sandbox.window = sandbox;
// No chrome stub here, so the script's messaging is inert and these cases are purely the
// audio state machine. Click selection has its own suite.
sandbox.__ytSkipConfig = { clickSkip: true, speedUp: false };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require('path').join(__dirname, '..', 'skipper.js'), 'utf8'), sandbox);

const tick = () => timers.forEach((fn) => fn());
const advance = (ms) => { clock += ms; };
// A real hardware gesture. Untrusted events are ignored by the script, so only this counts.
const gesture = () => gestureListeners.slice().forEach((fn) => fn({
  isTrusted: true,
  type: 'pointerdown',
  target: { closest: (sel) => (sel.includes('ytp-mute-button') ? {} : null) }
}));
// Tabbing to the mute button and pressing Enter. A reach for the audio with no pointer
// anywhere in it, and the input path the pointer-only version of this rule ignored.
const keyGesture = () => gestureListeners.slice().forEach((fn) => fn({
  isTrusted: true,
  type: 'keydown',
  key: 'Enter',
  target: { closest: (sel) => (sel.includes('ytp-mute-button') ? {} : null) }
}));
// Typing the letter m into the search box. A trusted keydown of the mute shortcut key that
// is emphatically not the mute shortcut, because YouTube does not mute while you are typing.
const typedM = () => gestureListeners.slice().forEach((fn) => fn({
  isTrusted: true,
  type: 'keydown',
  key: 'm',
  target: { tagName: 'INPUT', isContentEditable: false, closest: () => null }
}));
// Shift held with the mute key. YouTube's shortcut is the bare key, so Shift+m mutes
// nothing, and treating it as a reach hands the break back on a keystroke that did nothing.
const shiftM = () => gestureListeners.slice().forEach((fn) => fn({
  isTrusted: true,
  type: 'keydown',
  key: 'M',
  shiftKey: true,
  target: { tagName: 'BODY', isContentEditable: false, closest: () => null }
}));
// Caps lock also produces 'M', with no modifier held, and YouTube does mute on that one.
const capsM = () => gestureListeners.slice().forEach((fn) => fn({
  isTrusted: true,
  type: 'keydown',
  key: 'M',
  target: { tagName: 'BODY', isContentEditable: false, closest: () => null }
}));
// A trusted gesture that is not a reach for the audio, such as our own skip click.
const unrelatedGesture = () => gestureListeners.slice().forEach((fn) => fn({
  isTrusted: true,
  type: 'pointerdown',
  target: { closest: () => null }
}));

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

// 3. User unmutes during an ad, with a gesture behind it. We must not re-mute.
player.classList.add('ad-showing');
tick();
media.drain();
check('second ad mutes', media.muted, true);
gesture();
media.setByPlayer(false);
tick();
tick();
check('user unmute is not reversed', media.muted, false);

// 4. Ad ends after the user took over. We must not touch their setting.
player.classList.remove('ad-showing');
tick();
check('no interference after user took over', media.muted, false);

// 5. Fresh break after the override. Ownership resets and we silence again.
advance(GESTURE_STALE);
player.classList.add('ad-showing');
tick();
check('next break silences again', media.muted, true);
media.drain();

// 6. User was already muted before an ad. We must not claim it, so we must not unmute later.
player.classList.remove('ad-showing');
tick();
media.drain();
gesture();
media.setByPlayer(true);
player.classList.add('ad-showing');
tick();
player.classList.remove('ad-showing');
tick();
check('pre-existing user mute survives an ad break', media.muted, true);

// 7. A volume change while no ad is playing is ordinary listening and must not
// disable the feature for the next ad break.
gesture();
media.setByPlayer(false);
media.drain();
media.setByVolume(0.8);
advance(GESTURE_STALE);
player.classList.add('ad-showing');
tick();
check('volume change outside an ad does not suppress the next break', media.muted, true);
media.drain();

// 8. A volume nudge during an ad is not a rejection of our mute. We keep it muted.
gesture();
media.setByVolume(0.9);
tick();
check('volume nudge during an ad keeps the ad muted', media.muted, true);

// 9. And critically, we must still restore afterwards rather than strand them muted.
player.classList.remove('ad-showing');
tick();
check('volume nudge does not strand the user muted', media.muted, false);

// 10. Out of order delivery. Our mute event has not been dispatched yet when the user
// moves the volume slider, so both events arrive after a later tick. We must still
// recognise our own write and still restore the audio at the end of the break.
advance(GESTURE_STALE);
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

// 11. The defect this was all found for. The player re-syncs its own volume model at every
// source change, which inside an ad pod means at every ad. Nobody reached for anything, so
// it is not the user, and the rest of the break must not go audible.
advance(GESTURE_STALE);
player.classList.add('ad-showing');
tick();
media.drain();
media.setByPlayer(false);
media.drain();
tick();
check('a player re-sync unmute is re-muted', media.muted, true);
media.drain();

// 12. The same write, but landing before our own volumechange is delivered, so our event
// arrives reading the player's value instead of ours. Ownership must survive that too.
player.classList.remove('ad-showing');
tick();
media.drain();
player.classList.add('ad-showing');
tick();
media.setByPlayer(false);
media.drain();
tick();
check('a player unmute racing our own write is re-muted', media.muted, true);
media.drain();

// 13. A gesture does not license every later unmute. Once it is old, an unmute is the
// player again, not the person.
gesture();
advance(GESTURE_STALE);
media.setByPlayer(false);
media.drain();
tick();
check('a stale gesture does not excuse a player unmute', media.muted, true);
media.drain();
player.classList.remove('ad-showing');
tick();
media.drain();

// 14. A trusted gesture that was not a reach for the audio must not excuse anything. Our
// own skip click is exactly this, and counting it would put the original defect back the
// moment the trusted click ships.
advance(GESTURE_STALE);
player.classList.add('ad-showing');
tick();
media.drain();
unrelatedGesture();
media.setByPlayer(false);
media.drain();
tick();
check('an unrelated gesture does not excuse a player unmute', media.muted, true);
media.drain();
player.classList.remove('ad-showing');
tick();
media.drain();

// 15. A keyboard reach for the audio counts as much as a pointer one. Without this the
// keyboard path is read as the player and re-muted on the very next sweep, every sweep.
advance(GESTURE_STALE);
player.classList.add('ad-showing');
tick();
media.drain();
keyGesture();
media.setByPlayer(false);
media.drain();
tick();
tick();
check('a keyboard unmute on the mute button is not reversed', media.muted, false);
player.classList.remove('ad-showing');
tick();
media.drain();

// 16. The letter m typed into a search box is not a reach for the audio. Counting it opens
// a window on every letter of a query, and a source change landing in one of those windows
// hands the rest of the break back to the player, which is the defect this all exists for.
advance(GESTURE_STALE);
player.classList.add('ad-showing');
tick();
media.drain();
typedM();
media.setByPlayer(false);
media.drain();
tick();
check('typing m in a text field does not excuse a player unmute', media.muted, true);
media.drain();
player.classList.remove('ad-showing');
tick();
media.drain();

// 17. Reaching for the volume right after the player dropped our ownership must not be
// undone by the next sweep. The handler had already let go, so only the sweep consulting
// the same gesture clock keeps him unmuted.
advance(GESTURE_STALE);
player.classList.add('ad-showing');
tick();
media.drain();
media.setByPlayer(false);
media.drain();
gesture();
tick();
tick();
check('a reach for the volume survives the next sweep', media.muted, false);
player.classList.remove('ad-showing');
tick();
media.drain();

// 18. Shift+m is not the mute shortcut. The modifier guard checked meta, ctrl and alt but
// not shift, and 'M' is exactly what shift produces, so Shift+m anywhere on the page opened
// a gesture window on a keystroke YouTube ignores. Case 16's sibling, outside a text field.
advance(GESTURE_STALE);
player.classList.add('ad-showing');
tick();
media.drain();
shiftM();
media.setByPlayer(false);
media.drain();
tick();
check('shift and m does not excuse a player unmute', media.muted, true);
media.drain();
player.classList.remove('ad-showing');
tick();
media.drain();

// 19. But caps lock produces the same 'M' with no modifier held, and YouTube does mute on
// it, so that one is still his. Without this, fixing case 18 by dropping 'M' would look
// right and would silently stop honouring every caps lock user's mute key.
advance(GESTURE_STALE);
player.classList.add('ad-showing');
tick();
media.drain();
capsM();
media.setByPlayer(false);
media.drain();
tick();
check('caps lock m is still a reach for the audio', media.muted, false);
player.classList.remove('ad-showing');
tick();
media.drain();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
