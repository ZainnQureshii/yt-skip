# YT Skip

Silences a YouTube ad the moment it starts and clicks **Skip** the moment that button becomes
clickable. Built for watching YouTube on speakers from across the room, where an ad you cannot
reach is the whole problem.

It runs only on `youtube.com`. On every other site the browser does not inject it at all.

## What it does, in order

1. An ad starts. The audio goes quiet immediately, so nothing is heard.
2. The ad is run at 16x, so it finishes in a fraction of its length.
3. Your video resumes at normal speed and the sound comes back as you had it.

Measured on a live ad: a 20 second ad caught with 9 seconds left was over in under one second.

If you muted the player yourself, it leaves your setting alone and never unmutes you.

## Why it does not click the Skip button

It used to try. It does not work, and the reason is in YouTube's own player code. The skip
button's handler is, in the shipped build 4fd832e7:

    onClick(b){ b && b.preventDefault();
      DaZ(b, {...}) === 0
        ? g.RA(this.api, "onAbnormalityDetected")
        : (super.onClick(b), g.RA(this.api, "onAdSkip"), ...) }

    DaZ = function(b, W){ var c = 1; b.isTrusted === !1 && (c = 0); ...; return c }

`isTrusted` is set by the browser and only for genuine hardware input. A click from an
extension is always untrusted, so this branch never skips the ad. Worse, it takes the other
branch, which reports an abnormality to YouTube's ad blocker detection. Retrying it once a
second, which an earlier version of this did, is therefore both useless and unwise.

Playback rate is a media property, not an event. It carries no trust requirement, which is
why the approach here works at all.

The clicking code is still present and still tested, behind `CLICK_SKIP`, which defaults to
off. It would become useful again only with a genuinely trusted input path, which in an
extension means the `chrome.debugger` API and a visible debugging banner on the tab.

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
    node test/rate-control.test.js

No runner and no dependencies. Each file exits non zero if anything fails.
