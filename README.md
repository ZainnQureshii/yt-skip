# YT Skip

Silences a YouTube ad the moment it starts and clicks **Skip** the moment that button becomes
clickable. Built for watching YouTube on speakers from across the room, where an ad you cannot
reach is the whole problem.

It runs only on `youtube.com`. On every other site the browser does not inject it at all.

## What it does, in order

1. An ad starts. The audio goes quiet immediately, so nothing is heard during the wait.
2. The instant the skip button is genuinely clickable, it is clicked.
3. Your video resumes and the sound comes back exactly as you had it.

If you muted the player yourself, it leaves your setting alone and never unmutes you.

## What it deliberately does not do

- It does not block ads, rewrite network requests, or hide anything. It clicks a button YouTube
  puts on screen and invites you to press.
- It does not seek or fast forward the ad video. YouTube instruments untrusted seek events for
  ad blocker detection, and a stale ad state could have sent that seek into the real video.
- It assumes no fixed delay. The skip offset is per ad data in YouTube's player, so five seconds
  is a common case and not a rule. Nothing here counts seconds.

## Install

Same steps in both browsers, since Brave is Chromium underneath.

**Chrome**

1. Open `chrome://extensions`
2. Turn on **Developer mode**, top right
3. Click **Load unpacked** and pick this folder
4. Open a YouTube video

**Brave**

1. Open `brave://extensions`
2. Turn on **Developer mode**, top right
3. Click **Load unpacked** and pick this folder
4. Open a YouTube video

Keep this folder where it is. The browser loads the extension from this path on every start, so
moving or deleting the folder stops it loading and the browser reports it as an error.

Chrome shows a "Disable developer mode extensions" bubble on some startups. Dismissing it is
harmless and the extension keeps working. The only way to remove that bubble entirely is to
publish to the Web Store or install an enterprise policy, and neither is worth it for a personal
tool.

## How it finds the skip button

YouTube ships three skip button implementations at once, behind rollout flags. Reading the player
bundle confirms all three are live, and that YouTube's own code resolves the control by checking
`videoAdUiSkipContainer`, then `ytp-ad-skip-button-container`, then `ytp-skip-ad-button`.

This extension matches the same three implementations but tries them in its own order, by the
button's own class first: `ytp-skip-ad-button`, `ytp-ad-skip-button-modern`, `ytp-ad-skip-button`.
Nothing in the bundle establishes which of these is newest, so that ordering is a preference and
not a claim about YouTube's rollout.

If all three class names are renamed at once, there is a structural fallback that looks inside the
known container slots. It acts only when a slot offers exactly one candidate, and it refuses
outright to click anything on a deny list of advertiser controls, because sending you to an
advertiser is the worst thing this extension could do.

## If it stops working

YouTube renames these classes from time to time. To see what changed, play a video until an ad
appears, open DevTools, and inspect the skip button. Whatever class it carries is the one to add
to `SKIP_SELECTORS` at the top of `skipper.js`.

## Tests

    node test/mute-state.test.js
    node test/click-selection.test.js

No runner and no dependencies. Each file exits non zero if anything fails.
