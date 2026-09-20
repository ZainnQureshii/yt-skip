// YT Skip
// Mutes a YouTube ad and clicks Skip as soon as the button is genuinely clickable.
// No timers decide when to act. The DOM tells us, whenever YouTube gets round to it.

(() => {
  'use strict';

  const PLAYER = '#movie_player';
  const AD_CLASS = 'ad-showing';

  // Buttons that identify themselves as the skip control by their own class.
  // All three ship concurrently behind rollout flags, so all three are matched.
  const SKIP_SELECTORS = [
    '.ytp-skip-ad-button',
    '.ytp-ad-skip-button-modern',
    '.ytp-ad-skip-button'
  ];

  // Slots the skip button lives in. Used only as a fallback for a class rename,
  // and never trusted to mean that everything inside them is a skip control.
  const CONTAINER_SELECTORS = [
    '.ytp-ad-skip-button-container',
    '.ytp-ad-skip-button-slot',
    '#videoAdUiSkipContainer',
    '.videoAdUiSkipContainer'
  ];

  // Ad controls that are emphatically not the skip button. Clicking any of these
  // takes you to the advertiser, which is the worst thing this extension could do.
  const NEVER_CLICK = [
    '.ytp-ad-visit-advertiser-button',
    '.ytp-visit-advertiser-link',
    '.ytp-ad-button-link',
    '.ytp-ad-clickable',
    '.ytp-ad-hover-text-button',
    '.ytp-ad-info-hover-text-button',
    '.ytp-ad-action-interstitial-action-button'
  ];

  // The countdown shown before skipping is allowed. A separate element from the button.
  const COUNTDOWN_SELECTORS = [
    '.preskip-component',
    '.ytp-ad-preview-container',
    '.ytp-ad-preview-slot'
  ];

  // Kept below RETRY_MS so a suppressed click is retried on the very next sweep
  // rather than waiting out a second one.
  const RECLICK_GUARD_MS = 400;
  const RETRY_MS = 500;

  // Diagnostics. Content scripts log into the page console, which is the only channel
  // that shows what this is doing on a real ad without attaching a debugger.
  const LOG = true;
  const log = (...args) => { if (LOG) console.log('[YT Skip]', ...args); };

  let player = null;
  let observer = null;
  let lastClickedAt = 0;
  let lastClickedEl = null;
  let inAdBreak = false;
  let reportedNoButton = false;

  // Audio ownership, tracked against the element we actually silenced rather than
  // as a global flag, because the media element can be replaced under us.
  let audioOwner = null;
  let pendingWrite = null;
  let userTookOver = false;
  let watchedMedia = null;

  const visible = (el) => {
    if (!el || !el.isConnected) return false;
    // checkVisibility accounts for ancestor opacity and visibility, which offsetParent does not.
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true, contentVisibilityAuto: true })) {
        return false;
      }
    } else if (el.offsetParent === null && el.getClientRects().length === 0) {
      return false;
    }
    return getComputedStyle(el).pointerEvents !== 'none';
  };

  const enabled = (el) => {
    if (el.disabled === true) return false;
    if (el.hasAttribute('hidden')) return false;
    // closest matches the element itself, so this covers the button and its ancestors.
    if (el.closest('[disabled], [aria-disabled="true"]')) return false;
    return true;
  };

  const interactive = (el) =>
    el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button';

  const deniedBy = (el) => {
    const self = NEVER_CLICK.find((sel) => el.matches(sel));
    if (self) return self;
    // A candidate nested inside an advertiser control IS that control. A candidate that
    // merely shares an overlay container with one is not, so only an interactive ancestor
    // disqualifies it. Walking every ancestor would reject the skip button for sitting in
    // the same overlay as a Donate or Visit advertiser button.
    for (const sel of NEVER_CLICK) {
      const owner = el.closest(sel);
      if (owner && owner !== el && interactive(owner)) return sel;
    }
    return COUNTDOWN_SELECTORS.find((sel) => el.closest(sel)) || null;
  };

  const forbidden = (el) => deniedBy(el) !== null;

  const clickable = (el) => !!el && visible(el) && enabled(el) && !forbidden(el);

  const findSkipButton = (root) => {
    for (const sel of SKIP_SELECTORS) {
      for (const el of root.querySelectorAll(sel)) {
        if (clickable(el)) return el;
      }
    }
    // Fallback. Acts only when a known skip slot offers exactly one candidate,
    // because clicking the wrong player control is worse than letting an ad run.
    for (const sel of CONTAINER_SELECTORS) {
      for (const container of root.querySelectorAll(sel)) {
        const found = [...container.querySelectorAll('button, [role="button"]')].filter(clickable);
        if (found.length === 1) return found[0];
      }
    }
    return null;
  };

  const media = () => (player ? player.querySelector('video') : null);

  function onVolumeChange(event) {
    const el = event.target;
    // One write produces one event. Consume it, so a later genuine change is not excused.
    // Only the muted state is compared, because that is the only thing our write changes.
    // Comparing the volume too would leave this pending write unconsumed whenever the
    // volume moved before delivery. The guard below happens to cover that case either way,
    // so this is a simplification rather than a fix for any behaviour observed here.
    if (pendingWrite && pendingWrite.el === el && el.muted === pendingWrite.muted) {
      pendingWrite = null;
      return;
    }
    const duringAd = !!player && player.classList.contains(AD_CLASS);
    if (audioOwner === el) {
      // Moving the volume slider is not a rejection of our mute, and surrendering here
      // would strand the user muted once the ad ends. Only unmuting is a rejection.
      if (el.muted) return;
      audioOwner = null;
      if (duringAd) userTookOver = true;
      return;
    }
    // Outside an ad break this is ordinary listening, and must not disable the next break.
    if (duringAd && !el.muted) userTookOver = true;
  }

  const watchVolume = (el) => {
    if (!el || el === watchedMedia) return;
    if (watchedMedia) watchedMedia.removeEventListener('volumechange', onVolumeChange);
    watchedMedia = el;
    watchedMedia.addEventListener('volumechange', onVolumeChange);
  };

  const setMuted = (el, value) => {
    // Writing the value it already holds fires no event, which would leave a
    // pending write standing that swallows the next real one.
    if (el.muted === value) return;
    pendingWrite = { el, muted: value };
    el.muted = value;
  };

  const silenceAd = () => {
    const el = media();
    if (!el) return;
    watchVolume(el);
    if (userTookOver) return;
    if (audioOwner && audioOwner !== el) audioOwner = null;
    if (audioOwner === el) return;
    if (el.muted) return;
    audioOwner = el;
    setMuted(el, true);
  };

  const restoreAudio = () => {
    const el = audioOwner;
    audioOwner = null;
    pendingWrite = null;
    userTookOver = false;
    if (el && el.isConnected && el.muted) setMuted(el, false);
  };

  // Some controls listen for the pointer and mouse pair rather than the click event.
  // A bare click() dispatches only the last of these.
  const fullClick = (el) => {
    const box = el.getBoundingClientRect();
    const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true, cancelable: true, composed: true, view: window };
    const pointer = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerover', pointer));
    el.dispatchEvent(new PointerEvent('pointerenter', pointer));
    el.dispatchEvent(new MouseEvent('mouseover', at));
    el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, button: 0, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, button: 0, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', { ...pointer, button: 0, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', { ...at, button: 0, buttons: 0 }));
    el.dispatchEvent(new MouseEvent('click', { ...at, button: 0, buttons: 0 }));
  };

  const trySkip = () => {
    const button = findSkipButton(player);
    if (!button) {
      if (!reportedNoButton) {
        reportedNoButton = true;
        const anySkipish = [...player.querySelectorAll('button, [role="button"]')].filter((el) => {
          const cls = typeof el.className === 'string' ? el.className : '';
          return /skip/i.test(cls) || /skip/i.test(el.getAttribute('aria-label') || '') || /skip/i.test(el.textContent || '');
        });
        log('no clickable skip button yet. skip-ish controls on screen:', anySkipish.map((el) => ({
          cls: typeof el.className === 'string' ? el.className : String(el.className),
          label: el.getAttribute('aria-label'),
          text: (el.textContent || '').trim().slice(0, 40),
          matchedSelector: SKIP_SELECTORS.find((sel) => el.matches(sel)) || 'NONE',
          visible: visible(el),
          enabled: enabled(el),
          deniedBy: deniedBy(el),
          pointerEvents: getComputedStyle(el).pointerEvents,
          ancestors: (() => {
            const chain = [];
            let node = el.parentElement;
            for (let i = 0; i < 5 && node; i += 1) {
              chain.push(node.tagName + '.' + (typeof node.className === 'string' ? node.className : ''));
              node = node.parentElement;
            }
            return chain;
          })()
        })));
      }
      return;
    }
    const now = Date.now();
    // Guards against clicking the same button repeatedly while it animates in.
    // The retry interval is what guarantees a suppressed click is attempted again.
    if (button === lastClickedEl && now - lastClickedAt < RECLICK_GUARD_MS) return;
    lastClickedEl = button;
    lastClickedAt = now;
    log('clicking skip:', typeof button.className === 'string' ? button.className : button.tagName);
    button.click();
    setTimeout(() => {
      if (!player || !player.classList.contains(AD_CLASS)) {
        log('plain click ended the ad');
        return;
      }
      if (!button.isConnected) return;
      log('plain click did not take, escalating to a full pointer sequence');
      fullClick(button);
      setTimeout(() => {
        const stillAd = !!player && player.classList.contains(AD_CLASS);
        log(stillAd ? 'pointer sequence did NOT end the ad either' : 'pointer sequence ended the ad');
      }, 1200);
    }, 700);
  };

  // Many mutations arrive in one task while an ad overlay animates in. Collapsing them
  // into a single sweep per task is what stops the page feeling heavy. A microtask is used
  // rather than requestAnimationFrame because rAF stops in a background tab and this path
  // has to keep working when the tab is not visible.
  let sweepScheduled = false;
  const schedule = () => {
    if (sweepScheduled) return;
    sweepScheduled = true;
    queueMicrotask(() => {
      sweepScheduled = false;
      tick();
    });
  };

  const tick = () => {
    if (!player || !player.isConnected) bind();
    if (!player) return;
    if (player.classList.contains(AD_CLASS)) {
      if (!inAdBreak) {
        inAdBreak = true;
        reportedNoButton = false;
        log('ad started');
      }
      silenceAd();
      trySkip();
      return;
    }
    if (inAdBreak) {
      inAdBreak = false;
      reportedNoButton = false;
      log('ad ended');
    }
    restoreAudio();
    lastClickedEl = null;
  };

  function bind() {
    const found = document.querySelector(PLAYER);
    if (found === player && observer) return;
    if (observer) observer.disconnect();
    observer = null;
    player = found;
    if (!player) return;
    // Mutation delivery is microtask based, so this path keeps working in a
    // background tab where Chrome throttles timers.
    observer = new MutationObserver(schedule);
    observer.observe(player, {
      attributes: true,
      // 'style' is deliberately absent. With subtree it fires on every progress bar
      // frame, and the retry sweep already catches eligibility won through inline style.
      attributeFilter: ['class', 'disabled', 'aria-disabled', 'hidden'],
      childList: true,
      subtree: true
    });
    watchVolume(media());
  }

  // The observer is the fast path. This is the safety net: it rediscovers a player that
  // was replaced wholesale, and it retries a button that became eligible through a change
  // the observer does not see.
  log('loaded on', location.href);
  setInterval(tick, RETRY_MS);
  document.addEventListener('yt-navigate-finish', tick, true);
  tick();
})();
