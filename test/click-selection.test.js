// Harness for the click target selection in skipper.js.
// This is the half that matters most: getting it wrong means clicking through to an
// advertiser instead of skipping. The mute machine is the forgiving half.
//
// A minimal DOM is stubbed rather than pulled in, so the suite has no dependencies.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Supports only the selector forms skipper.js actually uses:
// comma lists, tag names, .class, #id, [attr] and [attr="value"].
const matchesOne = (el, sel) => {
  sel = sel.trim();
  if (sel.startsWith('.')) return el.classes.has(sel.slice(1));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  if (sel.startsWith('[')) {
    const body = sel.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq === -1) return el.attrs[body] !== undefined;
    const name = body.slice(0, eq);
    const want = body.slice(eq + 1).replace(/^["']|["']$/g, '');
    return el.attrs[name] === want;
  }
  return el.tagName.toLowerCase() === sel.toLowerCase();
};

const matches = (el, selector) => selector.split(',').some((s) => matchesOne(el, s));

class El {
  constructor(tagName, { classes = [], id = null, attrs = {}, children = [] } = {}) {
    this.tagName = tagName.toUpperCase();
    this.classes = new Set(classes);
    this.id = id;
    this.attrs = { ...attrs };
    this.children = [];
    this.parent = null;
    this.isConnected = true;
    this.clicks = 0;
    this.disabled = attrs.disabled !== undefined;
    children.forEach((c) => this.append(c));
  }
  append(child) { child.parent = this; this.children.push(child); return this; }
  get classList() { return { contains: (c) => this.classes.has(c) }; }
  getAttribute(name) { return this.attrs[name] === undefined ? null : this.attrs[name]; }
  hasAttribute(name) { return this.attrs[name] !== undefined; }
  closest(selector) {
    let node = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }
  descendants() {
    return this.children.flatMap((c) => [c, ...c.descendants()]);
  }
  querySelectorAll(selector) {
    return this.descendants().filter((el) => matches(el, selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  matches(selector) { return matches(this, selector); }
  checkVisibility() { return this.attrs['data-invisible'] === undefined; }
  click() { this.clicks += 1; }
}

const button = (classes, attrs = {}) => new El('button', { classes, attrs });

// The player is rebuilt per case so each scenario starts clean.
let player;
const timers = [];
const sandbox = {
  document: {
    querySelector: (sel) => (sel === '#movie_player' ? player : null),
    addEventListener: () => {}
  },
  getComputedStyle: () => ({ pointerEvents: 'auto' }),
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
vm.createContext(sandbox);

const results = [];
const check = (name, actual, expected) => {
  const ok = actual === expected;
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  (got ${actual}, expected ${expected})`);
};

// Building the player before loading the script, because the script binds on load.
const media = new El("video");
media.muted = false;
media.volume = 0.5;
media.addEventListener = () => {};
media.removeEventListener = () => {};

const buildPlayer = (adControls) => {
  // A replaced player is detached in a real page, and the script relies on that
  // to know its binding is stale. The stub has to say so too.
  if (player) {
    player.isConnected = false;
    player.descendants().forEach((el) => { el.isConnected = false; });
  }
  player = new El('div', { id: 'movie_player' });
  player.classes.add('ad-showing');
  player.append(media);
  adControls.forEach((el) => player.append(el));
  return player;
};

buildPlayer([]);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'skipper.js'), 'utf8'), sandbox);
const tick = () => timers.forEach((fn) => fn());

// 1. The plain case. A button that names itself as the skip control gets clicked.
const skip1 = button(['ytp-skip-ad-button']);
buildPlayer([skip1]);
tick();
check('clicks a button that identifies itself as skip', skip1.clicks, 1);

// 2. The case that must never happen. An advertiser link is the only thing on screen.
const advertiser = button(['ytp-ad-visit-advertiser-button']);
buildPlayer([new El('div', { classes: ['ytp-ad-skip-button-container'], children: [advertiser] })]);
tick();
check('never clicks a visit advertiser control', advertiser.clicks, 0);

// 3. Two unrecognised buttons in a skip slot. Neither identifies itself and neither is
// deny listed, so there is nothing to choose between them and we must not choose.
const unknownA = button(['some-renamed-class']);
const unknownB = button(['another-renamed-class']);
buildPlayer([new El('div', { classes: ['ytp-ad-skip-button-container'], children: [unknownA, unknownB] })]);
tick();
check('refuses to guess when a slot offers two candidates', unknownA.clicks + unknownB.clicks, 0);

// 4. The fallback earning its keep. One unrecognised button alone in a known slot.
const renamed = button(['ytp-totally-new-name']);
buildPlayer([new El('div', { classes: ['ytp-ad-skip-button-container'], children: [renamed] })]);
tick();
check('falls back to a sole candidate in a known skip slot', renamed.clicks, 1);

// 5. A deny listed sibling must not make a sole real candidate ambiguous.
const skip5 = button(['ytp-unknown-skip']);
const sibling = button(['ytp-ad-clickable']);
buildPlayer([new El('div', { classes: ['ytp-ad-skip-button-container'], children: [sibling, skip5] })]);
tick();
check('a deny listed sibling does not block the real candidate', skip5.clicks, 1);

// 6. The countdown is not the button. Clicking it would do nothing useful and is a bug.
const countdownButton = button(['ytp-ad-skip-button']);
buildPlayer([new El('div', { classes: ['preskip-component'], children: [countdownButton] })]);
tick();
check('never clicks inside the preskip countdown', countdownButton.clicks, 0);

// 7. A disabled skip button is not yet eligible, however present it is.
const notYet = button(['ytp-skip-ad-button'], { 'aria-disabled': 'true' });
buildPlayer([notYet]);
tick();
check('waits while the skip button is still disabled', notYet.clicks, 0);

// 8. An invisible button is not a real target.
const hidden = button(['ytp-skip-ad-button'], { 'data-invisible': '1' });
buildPlayer([hidden]);
tick();
check('ignores a skip button that is not visible', hidden.clicks, 0);

// 9. No ad in progress means nothing is clicked at all.
const idle = button(['ytp-skip-ad-button']);
buildPlayer([idle]);
player.classes.delete('ad-showing');
tick();
check('does nothing when no ad is showing', idle.clicks, 0);

// 10. Back to back ads. A second button in the same break is still clicked,
// which is what having no permanent already-clicked flag buys.
const first = button(['ytp-skip-ad-button']);
buildPlayer([first]);
tick();
const second = button(['ytp-skip-ad-button']);
buildPlayer([second]);
tick();
check('clicks the skip button of a second ad in the same break', second.clicks, 1);

// 11. The live failure this was written for. The skip button sits in the same ad overlay
// as a Donate or Visit advertiser control. Sharing a container must not disqualify it.
const realSkip = button(['ytp-skip-ad-button']);
const donate = button(['ytp-ad-visit-advertiser-button']);
// The container itself carries a deny listed class, which is the shape that made the
// original ancestor walk reject the skip button.
buildPlayer([new El('div', { classes: ['ytp-ad-player-overlay-layout', 'ytp-ad-clickable'], children: [donate, realSkip] })]);
tick();
check('skip button sharing an overlay with an advertiser control is still clicked', realSkip.clicks, 1);

// 12. But genuinely nested inside an advertiser button, it is that button, and is refused.
const nested = button(['ytp-skip-ad-button']);
const advertiserButton = new El('button', { classes: ['ytp-ad-visit-advertiser-button'], children: [nested] });
buildPlayer([advertiserButton]);
tick();
check('a candidate nested inside an advertiser button is refused', nested.clicks, 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
