// YT Skip service worker.
//
// This exists for one reason: a content script cannot produce an input event the page will
// accept. YouTube's skip handler checks event.isTrusted, which only the browser can set, and
// takes its abnormality branch when the check fails. chrome.debugger dispatches through the
// browser's own input pipeline, so the click arrives trusted and the skip goes through.
//
// Nothing else belongs in here. The content script owns every decision about what to click.

(() => {
  'use strict';

  const PROTOCOL = '1.3';

  // One attempt at a time per tab, and per tab is the point: Chrome's one debugger client
  // limit is scoped to a tab, not to the browser, and two YouTube tabs in an ad break at once
  // is ordinary. A single global flag made one tab's ad block every other tab's skip.
  const busy = new Set();

  const attach = (target) => new Promise((resolve, reject) => {
    chrome.debugger.attach(target, PROTOCOL, () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });

  // Never rejects. A failed detach must not mask the outcome of the click itself, and the
  // session is gone either way once the tab or the worker goes.
  const detach = (target) => new Promise((resolve) => {
    chrome.debugger.detach(target, () => { void chrome.runtime.lastError; resolve(); });
  });

  const send = (target, method, params) => new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });

  const askPage = (tabId, message) => new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (reply) => {
      void chrome.runtime.lastError;
      resolve(reply || null);
    });
  });

  // The content script decides whether to try again, and it decides on this flag rather than
  // on the wording of a reason. Four matching string literals across two files was one reword
  // away from silently disabling every retry.
  const miss = (why) => ({ clicked: false, retryable: true, why });
  const lost = (why) => ({ clicked: false, retryable: false, why });

  async function clickSkip(tabId) {
    const target = { tabId };
    try {
      await attach(target);
    } catch (err) {
      // Almost always DevTools owning the tab. Contention is not ours to win, and handing
      // the attempt back would mean re-attaching twice a second for the length of the ad.
      return lost('attach failed: ' + err.message);
    }
    try {
      // Resolved after attaching, never before. Attaching raises the debugging bar, which
      // shifts the page down, so a coordinate taken beforehand points above the button.
      // Asked twice, and the answers have to agree. Attaching raises Chrome's debugging bar
      // and that reflow reaches the page on its own schedule, not with the attach callback,
      // so a single measurement can describe a layout that is already moving. The round trip
      // between these two calls is the settling time, and a target that moved is left alone.
      const first = await askPage(tabId, { type: 'yt-skip-resolve' });
      if (!first || !first.ok) return miss('no target after attach');
      const spot = await askPage(tabId, { type: 'yt-skip-resolve' });
      if (!spot || !spot.ok) return miss('no target on the second ask');
      if (spot.x !== first.x || spot.y !== first.y) return miss('target moved after attach');
      // Viewport CSS pixels, which is what getBoundingClientRect gives. Verified working on
      // a live ad at the default browser zoom on a Retina display. Whether the two spaces
      // still agree at a non default page zoom has NOT been measured, and a click that lands
      // off target hits a neighbouring ad control with no guard left, so measure it before
      // relying on it rather than reasoning about it.
      const at = { x: spot.x, y: spot.y, button: 'left', clickCount: 1 };
      // A move with nothing held is button 'none'. Pairing 'left' with buttons: 0 says two
      // contradictory things about the same event.
      await send(target, 'Input.dispatchMouseEvent', { ...at, type: 'mouseMoved', button: 'none', buttons: 0 });
      await send(target, 'Input.dispatchMouseEvent', { ...at, type: 'mousePressed', buttons: 1 });
      await send(target, 'Input.dispatchMouseEvent', { ...at, type: 'mouseReleased', buttons: 0 });
      return { clicked: true, retryable: false, why: 'clicked' };
    } catch (err) {
      // A dispatch that threw clicked nothing, so the attempt goes back rather than being
      // spent. Only the attach failure above is a deliberate loss.
      return miss('dispatch failed: ' + err.message);
    } finally {
      await detach(target);
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message || message.type !== 'yt-skip-request') return false;
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') return false;
    if (busy.has(tabId)) { respond(miss('another skip in flight')); return false; }
    busy.add(tabId);
    // The catch goes on clickSkip and not after .then(respond). Chained, a respond that
    // throws on a closed port would be called a second time from inside the catch, and the
    // second throw has nothing to catch it.
    clickSkip(tabId)
      .catch((err) => lost('worker error: ' + err.message))
      .then(respond)
      .catch(() => {})
      .finally(() => { busy.delete(tabId); });
    // The listener returns true so the channel stays open for the async reply.
    return true;
  });
})();
