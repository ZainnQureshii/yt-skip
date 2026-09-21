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

  const RETRY_MS = 500;

  // How long a genuine gesture stays credible as the cause of a volume change. The player's
  // own writes arrive with no gesture behind them at all, so this is what separates the user
  // from YouTube. Nothing else can: volumechange carries no writer identity.
  const GESTURE_MS = 1000;

  const EDITABLE = /^(INPUT|TEXTAREA|SELECT)$/;

  // Only a reach for the audio counts. Any-gesture was the first version of this and it was
  // wrong twice over: an unrelated click would excuse YouTube's next reset, and our own
  // trusted skip click would excuse it too, which puts the original defect straight back.
  const VOLUME_CONTROLS = [
    '.ytp-mute-button',
    '.ytp-volume-area',
    '.ytp-volume-panel',
    '.ytp-volume-slider'
  ];

  // Diagnostics. Content scripts log into the page console, which is the only channel
  // that shows what this is doing on a real ad without attaching a debugger.
  const config = (typeof window !== 'undefined' && window.__ytSkipConfig) || {};

  // Off for daily use. Turn it on from the console with
  //   window.__ytSkipConfig = { log: true }
  // then reload the tab, if this ever needs diagnosing again.
  const LOG = config.log === true;
  const log = (...args) => { if (LOG) console.log('[YT Skip]', ...args); };

  // A click from this script can never skip. YouTube's own handler is
  //   onClick(b){ b.preventDefault(); DaZ(b,...) === 0 ? onAbnormalityDetected : onAdSkip }
  // and DaZ returns 0 when event.isTrusted is false. Verified in player build 4fd832e7.
  // So the click is asked for rather than made: the service worker dispatches it through
  // chrome.debugger, which goes via the browser's own input pipeline and arrives trusted.
  // Never dispatch a synthetic click here again. It cannot skip, and it reports an
  // abnormality to YouTube's ad blocker detection every time it is tried.
  const CLICK_SKIP = config.clickSkip !== false;

  const messaging = typeof chrome !== 'undefined' && !!chrome.runtime && !!chrome.runtime.sendMessage;

  // What does work: run the ad at speed while it is silent, because playback rate is a
  // media property rather than an event and carries no trust requirement. Measured on a
  // live ad in player build 4fd832e7: a 20 second ad caught with 9 seconds left ended in
  // under one second of wall clock, the rate held at 16 with no clamp or reset, and the
  // programme resumed by itself at normal speed.
  const SPEED_UP = config.speedUp !== false;
  const AD_RATE = config.adRate || 16;

  let player = null;
  let observer = null;
  let inAdBreak = false;
  let reportedNoButton = false;

  // One skip attempt per ad, not per button. A pod reuses and replaces these elements, so
  // keying on DOM identity would either retry one ad forever or skip only the first of them.
  // A source change is the real boundary between one ad and the next.
  let adGeneration = 0;
  let skipAttemptedFor = -1;

  // Audio ownership, tracked against the element we actually silenced rather than
  // as a global flag, because the media element can be replaced under us.
  let audioOwner = null;
  let pendingWrite = null;
  let userTookOver = false;
  let watchedMedia = null;
  let lastGestureAt = 0;

  // The single arbiter of whether a volume change was the user or the player. Used by the
  // volumechange handler and by the sweep, so the two can never disagree about who owns
  // the audio at a given moment.
  const reachedForAudio = () => Date.now() - lastGestureAt < GESTURE_MS;

  // Playback rate ownership, on the same principle as the audio: only ever restore a
  // rate we set ourselves, and let go the moment the user changes it.
  let rateOwner = null;
  let originalRate = 1;

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
    // An unmute nobody reached for is the player re-syncing its own volume model, which it
    // does at every source change and therefore at every ad inside a pod. Treating that as
    // the user is what left the whole break audible after the first ad. Only an unmute with a
    // real gesture close behind it gives up the audio.
    const byUser = reachedForAudio();
    if (audioOwner === el) {
      // Moving the volume slider is not a rejection of our mute, and surrendering here
      // would strand the user muted once the ad ends. Only unmuting is a rejection.
      if (el.muted) return;
      audioOwner = null;
      if (duringAd && byUser) userTookOver = true;
      return;
    }
    // Outside an ad break this is ordinary listening, and must not disable the next break.
    if (duringAd && !el.muted && byUser) userTookOver = true;
  }

  const onLoadStart = () => {
    adGeneration += 1;
    // A new ad gets its own diagnostic. Without this only the first ad of a pod ever
    // reported what it could see, which is the case least likely to be the broken one.
    reportedNoButton = false;
  };

  const watchMedia = (el) => {
    if (!el || el === watchedMedia) return;
    if (watchedMedia) {
      watchedMedia.removeEventListener('volumechange', onVolumeChange);
      watchedMedia.removeEventListener('loadstart', onLoadStart);
    }
    watchedMedia = el;
    watchedMedia.addEventListener('volumechange', onVolumeChange);
    watchedMedia.addEventListener('loadstart', onLoadStart);
  };

  const accelerateAd = () => {
    if (!SPEED_UP) return;
    const el = media();
    if (!el) return;
    if (rateOwner && rateOwner !== el) releaseRate();
    if (rateOwner !== el) {
      originalRate = el.playbackRate || 1;
      rateOwner = el;
      log('running the ad at', AD_RATE + 'x');
    }
    // Reapplied rather than set once, because the player resets the rate on a source
    // change and an ad pod changes source between ads. A rate change during an ad is
    // never the user: YouTube hides the speed control while an ad is playing, which is
    // why there is no takeover state here and there is one for the volume.
    if (el.playbackRate !== AD_RATE) el.playbackRate = AD_RATE;
  };

  const releaseRate = () => {
    const el = rateOwner;
    rateOwner = null;
    // Only take back a rate that is still the one we set. Anything else is not ours,
    // and writing over it would be the stranding bug the mute logic already learned.
    if (el && el.isConnected && el.playbackRate === AD_RATE) el.playbackRate = originalRate;
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
    watchMedia(el);
    if (userTookOver) return;
    // Both paths below consult reachedForAudio, so the sweep and the handler can never
    // disagree about who owns the audio. Acquiring without it re-muted him one sweep after
    // he reached for the volume, because ownership had already been dropped by then.
    if (audioOwner && audioOwner !== el) audioOwner = null;
    if (audioOwner === el) {
      // We own it and it is playing out loud, so an unmute reached us without a
      // volumechange we could act on. Take it back, unless the user just reached for the
      // volume, because his event may simply not have been delivered yet and re-muting
      // ahead of it would strand him muted for the rest of the break.
      if (!el.muted && !reachedForAudio()) setMuted(el, true);
      return;
    }
    if (el.muted) return;
    if (reachedForAudio()) return;
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

  // The point on screen the click has to land on. Resolved fresh, on demand, because the
  // service worker asks for it only after it has attached, and attaching raises Chrome's
  // debugging bar, which moves the page under any coordinate taken before that.
  const resolveSkipSpot = () => {
    if (!player || !player.classList.contains(AD_CLASS)) return null;
    const button = findSkipButton(player);
    if (!button) return null;
    const box = button.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    const x = box.left + box.width / 2;
    const y = box.top + box.height / 2;
    // Whatever actually occupies that point must be the button or part of it. Selection
    // says what we want to hit; only a hit test says what would be hit. An overlay that
    // moved in after selection would otherwise take the click, and clicking the wrong
    // player control is the one failure this extension must never have. This is true at
    // the instant it runs and no later, so it narrows the window rather than closing it.
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== button && !button.contains(hit))) return null;
    if (forbidden(hit)) return null;
    return { ok: true, x, y };
  };

  // Every attach raises Chrome's debugging bar and every detach drops it, and that reflow is
  // itself a cause of the misses being retried. Uncapped, this re-attaches twice a second for
  // the length of the ad, which is fighting a condition rather than losing an attempt.
  const MAX_SKIP_RETRIES = 3;

  let skipRetriesFor = -1;
  let skipRetries = 0;

  const requestSkip = (attemptFor) => {
    // These two spend the attempt deliberately, against the general rule. Both are permanent
    // for the life of the page rather than transient, so handing the attempt back would only
    // re-ask twice a second for an answer that cannot change. The catch below is the opposite
    // case and does hand it back.
    if (!messaging) return;
    // An orphaned content script survives an extension reload and throws out of sendMessage
    // on every ad until the page is reloaded. Nothing useful follows, so it stays quiet.
    if (!chrome.runtime.id) return;
    try {
      chrome.runtime.sendMessage({ type: 'yt-skip-request' }, (reply) => {
        // Read so Chrome does not log an unchecked error when the worker has already gone.
        if (chrome.runtime.lastError) return;
        log('skip request:', reply && reply.why);
        // The attempt is only spent if something was actually clicked. Consuming it on a
        // transient miss left the ad unskippable for the rest of its run. The worker says
        // whether to try again with a flag rather than a reason string, so rewording a
        // message on either side cannot quietly switch retrying off.
        if (!reply || !reply.retryable) return;
        if (skipAttemptedFor !== attemptFor) return;
        if (skipRetriesFor !== attemptFor) { skipRetriesFor = attemptFor; skipRetries = 0; }
        if (skipRetries >= MAX_SKIP_RETRIES) {
          log('giving up on this ad after', skipRetries, 'misses');
          return;
        }
        skipRetries += 1;
        skipAttemptedFor = -1;
      });
    } catch (err) {
      // Nothing was dispatched, so the attempt was not spent. Handing it back matters here
      // because a synchronous throw is transient, unlike the two permanent cases above.
      if (skipAttemptedFor === attemptFor) skipAttemptedFor = -1;
      log('skip request failed:', err && err.message);
    }
  };

  if (messaging && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      if (!message || message.type !== 'yt-skip-resolve') return false;
      respond(resolveSkipSpot());
      return false;
    });
  }

  const trySkip = () => {
    if (!CLICK_SKIP) return;
    if (skipAttemptedFor === adGeneration) return;
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
          deniedBy: deniedBy(el)
        })));
      }
      return;
    }
    skipAttemptedFor = adGeneration;
    log('asking for a trusted click on', typeof button.className === 'string' ? button.className : button.tagName);
    requestSkip(adGeneration);
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
        adGeneration += 1;
        reportedNoButton = false;
        log('ad started');
      }
      silenceAd();
      accelerateAd();
      trySkip();
      return;
    }
    if (inAdBreak) {
      inAdBreak = false;
      reportedNoButton = false;
      log('ad ended');
    }
    restoreAudio();
    releaseRate();
  };

  function bind() {
    const found = document.querySelector(PLAYER);
    if (found === player && observer) return;
    if (observer) observer.disconnect();
    observer = null;
    player = found;
    // A replaced player is a new context, and whatever we attempted against the old one
    // says nothing about this one. Without this, one attempt would be the last one ever.
    adGeneration += 1;
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
    watchMedia(media());
  }

  const onGesture = (event) => {
    if (!event.isTrusted) return;
    // m is YouTube's mute shortcut and it is handled at the document rather than on the
    // control, so it never has a volume control as its target. It is only the shortcut when
    // nothing is being typed into and no modifier is held: YouTube does not mute on m while
    // focus is in a text field, so counting it there opens a window on every letter of a
    // search query and hands the whole break back to the player.
    if (event.type === 'keydown' && (event.key === 'm' || event.key === 'M')) {
      // Shift is a modifier like any other and YouTube does not mute on Shift+m, so counting
      // it opens a window on a keystroke that changed nothing. 'M' is still accepted without
      // Shift, because caps lock produces it and YouTube does mute on that.
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const target = event.target;
      if (target && (target.isContentEditable || EDITABLE.test(target.tagName || ''))) return;
      lastGestureAt = Date.now();
      return;
    }
    // Every other input is judged by what it landed on, keyboard included. Tabbing to the
    // mute button and pressing Enter or Space is a reach for the audio in exactly the way a
    // click on it is, and treating only the pointer as real would re-mute him every sweep.
    const el = event.target;
    if (!el || typeof el.closest !== 'function') return;
    if (el.closest(VOLUME_CONTROLS.join(','))) lastGestureAt = Date.now();
  };
  // Capture, because the player calls stopPropagation on its own controls and a bubbling
  // listener would never see the click that worked the mute button.
  document.addEventListener('pointerdown', onGesture, true);
  document.addEventListener('keydown', onGesture, true);

  log('loaded on', location.href);
  // The observer is the fast path. This is the safety net: it rediscovers a player that
  // was replaced wholesale, and it retries a button that became eligible through a change
  // the observer does not see.
  setInterval(tick, RETRY_MS);
  document.addEventListener('yt-navigate-finish', tick, true);
  tick();
})();
