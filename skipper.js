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

  const RECLICK_GUARD_MS = 700;
  const RETRY_MS = 500;

  let player = null;
  let observer = null;
  let lastClickedAt = 0;
  let lastClickedEl = null;

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
    if (el.getAttribute('aria-disabled') === 'true') return false;
    if (el.hasAttribute('hidden')) return false;
    if (el.closest('[disabled], [aria-disabled="true"]')) return false;
    return true;
  };

  const forbidden = (el) =>
    NEVER_CLICK.some((sel) => el.closest(sel)) || COUNTDOWN_SELECTORS.some((sel) => el.closest(sel));

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
    if (pendingWrite && pendingWrite.el === el && el.muted === pendingWrite.muted && el.volume === pendingWrite.volume) {
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
    pendingWrite = { el, muted: value, volume: el.volume };
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

  const trySkip = () => {
    const button = findSkipButton(player);
    if (!button) return;
    const now = Date.now();
    // Guards against clicking the same button repeatedly while it animates in.
    // The retry interval is what guarantees a suppressed click is attempted again.
    if (button === lastClickedEl && now - lastClickedAt < RECLICK_GUARD_MS) return;
    lastClickedEl = button;
    lastClickedAt = now;
    button.click();
  };

  const tick = () => {
    if (!player || !player.isConnected) bind();
    if (!player) return;
    if (player.classList.contains(AD_CLASS)) {
      silenceAd();
      trySkip();
      return;
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
    observer = new MutationObserver(tick);
    observer.observe(player, {
      attributes: true,
      attributeFilter: ['class', 'disabled', 'aria-disabled', 'style', 'hidden'],
      childList: true,
      subtree: true
    });
    watchVolume(media());
  }

  // The observer is the fast path. This is the safety net: it rediscovers a player that
  // was replaced wholesale, and it retries a button that became eligible through a change
  // the observer does not see.
  setInterval(tick, RETRY_MS);
  document.addEventListener('yt-navigate-finish', tick, true);
  tick();
})();
