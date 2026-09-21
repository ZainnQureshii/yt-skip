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
    this.box = 0;
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
  contains(other) {
    let node = other;
    while (node) {
      if (node === this) return true;
      node = node.parent;
    }
    return false;
  }
  // Every element gets its own strip of the viewport, so a point identifies exactly one of
  // them and the hit test in skipper.js has something real to disagree with.
  getBoundingClientRect() {
    return { left: this.box * 100, top: 0, width: 50, height: 20 };
  }
  click() { this.clicks += 1; }
}

const button = (classes, attrs = {}) => new El('button', { classes, attrs });

// The player is rebuilt per case so each scenario starts clean.
let player;
const timers = [];
const sandbox = {
  document: {
    querySelector: (sel) => (sel === '#movie_player' ? player : null),
    addEventListener: () => {},
    elementFromPoint: (x, y) => {
      if (!player) return null;
      return [player, ...player.descendants()].find((el) => {
        const box = el.getBoundingClientRect();
        return x >= box.left && x < box.left + box.width && y >= box.top && y < box.top + box.height;
      }) || null;
    }
  },
  getComputedStyle: () => ({ pointerEvents: 'auto' }),
  MutationObserver: class { observe() {} disconnect() {} },
  setInterval: (fn) => { timers.push(fn); return timers.length; },
  // Diagnostics are not under test, so logging is stubbed to keep the output readable.
  setTimeout: () => 0,
  console: { log: () => {} },
  location: { href: 'https://www.youtube.com/watch?v=test' },
  Date
};
sandbox.window = sandbox;
const pageListeners = [];
// Counted so the retry cap can be asserted on what was asked for, not only on what landed.
let skipRequests = 0;
sandbox.chrome = {
  runtime: {
    lastError: null,
    onMessage: { addListener: (fn) => pageListeners.push(fn) },
    id: 'stub-extension-id',
    sendMessage: (message, respond) => {
      if (!message || message.type !== 'yt-skip-request') return;
      skipRequests += 1;
      // background.js resolves the point twice and requires the two answers to agree before
      // it dispatches. The stub does the same, or the suite would not be exercising the
      // settling check at all.
      const ask = () => {
        let answer = null;
        pageListeners.slice().forEach((fn) => fn({ type: 'yt-skip-resolve' }, {}, (spot) => { answer = spot; }));
        return answer;
      };
      const first = ask();
      const second = ask();
      const agreed = first && first.ok && second && second.ok && first.x === second.x && first.y === second.y;
      if (agreed) {
        const hit = sandbox.document.elementFromPoint(second.x, second.y);
        if (hit) hit.click();
      }
      // The shipped worker replies { clicked, retryable, why } and skipper.js branches on
      // retryable alone. A stub replying some other shape cannot fail when that contract
      // breaks, which is the whole reason this shape is spelled out here.
      if (respond) {
        respond(agreed
          ? { clicked: true, retryable: false, why: 'clicked' }
          : { clicked: false, retryable: true, why: 'no target after attach' });
      }
    }
  }
};
// The script never clicks anything itself: it resolves a point and the service worker
// dispatches a trusted click at it. The stub above stands in for the worker, so what these
// cases measure is the real selection and hit testing that ships.
sandbox.__ytSkipConfig = { clickSkip: true, speedUp: false };
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
  // The player itself is given no box, so a point only ever resolves to a control.
  player.box = -100;
  player.descendants().forEach((el, i) => { el.box = i + 1; });
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

// 13. Selection says what we want to hit. Only a hit test says what would actually be hit.
// An overlay that arrives over the skip button after selection must cancel the click, not
// take it, because a click that lands on the wrong control is the worst thing we can do.
const covered = button(['ytp-skip-ad-button']);
const overlay = new El('div', { classes: ['ytp-ad-overlay'] });
buildPlayer([overlay, covered]);
overlay.box = covered.box;
tick();
// The assertion is on the overlay, not on the skip button. The dispatch lands wherever the
// browser says the point is, so "the skip button was not clicked" would also be true if we
// had fired blindly and hit the overlay. What must be true is that nothing was fired.
check('an overlay covering the skip button cancels the click', overlay.clicks + covered.clicks, 0);

// 14. And the same button with nothing on top of it is still clicked, so case 13 is
// measuring the overlay and not some other reason the click went nowhere.
const clear = button(['ytp-skip-ad-button']);
buildPlayer([clear]);
tick();
check('the same button with nothing over it is still clicked', clear.clicks, 1);

// 15. A miss hands the attempt back. The overlay cancels the first click, and once it moves
// off the button the very next sweep must click, within the same ad. Before the retry
// contract was wired through, one miss made the ad unskippable for its whole run.
const retried = button(['ytp-skip-ad-button']);
const blocker = new El('div', { classes: ['ytp-ad-overlay'] });
buildPlayer([blocker, retried]);
blocker.box = retried.box;
tick();
check('a covered button is not clicked on the first sweep', retried.clicks, 0);
blocker.box = 90;
tick();
check('the attempt is handed back, so the next sweep clicks the same ad', retried.clicks, 1);

// 16. And the hand-back is capped. Every attach raises the debugging bar and every detach
// drops it, so an uncapped retry re-attaches for the length of the ad. One attempt and
// three retries, then the ad is left alone however many sweeps follow.
const neverHit = button(['ytp-skip-ad-button']);
const permanent = new El('div', { classes: ['ytp-ad-overlay'] });
buildPlayer([permanent, neverHit]);
permanent.box = neverHit.box;
skipRequests = 0;
for (let i = 0; i < 8; i += 1) tick();
check('retries are capped at one attempt plus three', skipRequests, 4);
check('and nothing was clicked through the overlay', permanent.clicks + neverHit.clicks, 0);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
