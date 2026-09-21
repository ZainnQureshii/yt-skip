# YT Skip

[![tests](https://github.com/ZainnQureshii/yt-skip/actions/workflows/tests.yml/badge.svg)](https://github.com/ZainnQureshii/yt-skip/actions/workflows/tests.yml)

You are across the room. An ad starts. You cannot reach the Skip button, so you sit through it.
That is the whole problem this solves, and it is the only problem it solves.

YT Skip is a Chrome and Brave extension that mutes a YouTube ad the moment it starts, runs it at
16x so it burns off in about a second, and clicks **Skip** for real the instant that button becomes
clickable. Then your video comes back at normal speed with your sound as you left it.

It is not an ad blocker. Nothing is blocked, nothing is filtered, and no network request is
touched. The ad plays. It just plays silent, fast, and without you.

It runs only on `youtube.com`. Everywhere else the browser does not inject it at all.

> **Reading this as an agent or a contributor?** Read [AGENTS.md](AGENTS.md) before changing
> anything. It is the working agreements file: every rule in it sits next to the defect that taught
> it, and several of them look wrong until you know the failure behind them. The
> [Repository map](#repository-map) and [How the two halves talk](#how-the-two-halves-talk) sections
> below tell you where everything is and what the contract between the pieces is.

## Contents

- [What it does, in order](#what-it-does-in-order)
- [What it asks of your browser](#what-it-asks-of-your-browser)
- [Install](#install)
- [Updating](#updating)
- [Known limits](#known-limits)
- [How it skips the button](#how-it-skips-the-button)
- [How it finds the button](#how-it-finds-the-button)
- [How it handles the sound](#how-it-handles-the-sound)
- [Repository map](#repository-map)
- [How the two halves talk](#how-the-two-halves-talk)
- [Tests](#tests)
- [When it stops working](#when-it-stops-working)
- [Diagnosing it live](#diagnosing-it-live)
- [Contributing](#contributing)
- [License](#license)

## What it does, in order

1. An ad starts. The audio goes quiet immediately, so nothing is heard.
2. The ad runs at 16x, so it finishes in a fraction of its length.
3. The moment a skip button is genuinely clickable, it is clicked for real and the ad ends.
4. Your video resumes at normal speed and the sound comes back as you had it.

If you muted the player yourself, it leaves your setting alone and never unmutes you. It gives the
audio back the moment you reach for the volume, and it does not give it back when YouTube's player
resets it, which the player does at every single ad inside an ad pod.

## What it asks of your browser

**Read this before you install it.** This extension requests Chrome's `debugger` permission, and
that is a large permission. You should know exactly what it means before you grant it.

**What the permission allows.** `debugger` gives an extension access to the Chrome DevTools
Protocol on tabs it attaches to. That is powerful: the protocol can modify a page, run JavaScript
in it, and observe its network traffic. The permission is not scoped to YouTube. The fact that the
content script only matches `youtube.com` does not narrow what the permission itself grants.

**What this extension actually does with it.** `background.js` is just over 100 lines and you can read all of
it. When the content script asks for a skip, the worker attaches to that one tab, asks the page
twice for the button's coordinates, checks the two answers agree, dispatches a mouse move, press
and release at that point, and detaches. That is the entire use. It does not enumerate your other
tabs, read your network traffic, run JavaScript in the page through the protocol, read page
contents, or send anything anywhere. The extension makes no network requests of its own and stores
nothing.

**The difference matters.** Those are limits of how the code is written, not limits the permission
imposes. You are trusting the code, not the permission. That is why the code is short, why it is
here to read, and why it is worth reading before you install.

**What you will see.** While the worker is attached, Chrome shows a bar saying YT Skip started
debugging this browser. It appears during a skip attempt and goes when the worker detaches. Its
duration is not something the code pins down, so treat "it appears during ads and then goes" as the
honest description rather than any specific number of seconds.

## Install

This is a manual desktop install. The extension is not on the Chrome Web Store, so there is no one
click option and there is developer mode friction. The steps are the same on Chrome and Brave,
since Brave is Chromium underneath.

1. Download the ZIP from the [latest release](../../releases/latest).
2. Extract it.
3. **Move the extracted folder somewhere permanent**, for example your home directory or Documents.
   Do not leave it in Downloads.
4. Open `chrome://extensions`, or `brave://extensions` in Brave.
5. Turn on **Developer mode**, top right.
6. Click **Load unpacked**.
7. Select the folder that directly contains `manifest.json`. If the ZIP extracted into a wrapper
   folder, go one level in. Picking the wrapper is the most common mistake here and the browser will
   tell you it found no manifest.
8. Refresh any YouTube tabs you already have open. The content script is injected at page load, so
   a tab opened before the install will not have it.

**The browser runs the extension from that folder every time it starts.** Keep the folder where it
is for as long as you have the extension installed. Moving or deleting it stops the extension
loading and the browser reports it as an error. You can delete the ZIP.

Chrome may show a bubble about disabling developer mode extensions on some startups. If it appears,
dismiss it. Afterwards check `chrome://extensions` and confirm YT Skip still shows as enabled; if
its toggle is off, turn it back on. The only way to remove that prompt entirely is to publish to the
Web Store or install an enterprise policy, and neither is worth it for a personal tool.

## Updating

There is no automatic updater. To update: download the new release, extract it, replace the
contents of the folder you installed from, then open the extensions page and click the reload icon
on YT Skip. Refresh your YouTube tabs afterwards.

Reloading the extension orphans the content script in any tab that was already open. That is
handled and it fails quietly rather than throwing, but the tab will not skip anything until you
refresh it.

## Known limits

- **DevTools wins.** Chrome allows one debugger client per tab. While you have DevTools open on a
  YouTube tab, the click cannot happen. The mute and the speed up still work, so the ad is ridden
  out silently and fast instead.
- **Page zoom is unverified.** The click is dispatched in viewport CSS pixels, which is what the
  page reports. Those two spaces were confirmed to agree on a live ad at the default browser zoom
  on a Retina display. Nobody has measured a non default page zoom, and if they disagree there the
  click lands somewhere near the button rather than on it. If you keep YouTube at a custom zoom,
  this has not been tested for you.
- **It skips once per ad, three attempts at most.** If those miss, the ad is left alone. It is still
  silent and still at 16x.
- **Nothing counts seconds.** The player carries the skip delay as per ad data, so five seconds is a
  common case and not a rule. The extension waits for the button to be real, never for a timer.
- **It is unpacked and unsigned.** That is what developer mode means. It also means you can read
  every line of what you installed, which a Web Store extension does not give you.

## How it skips the button

Not from the page. A click made by page script cannot skip anything, and the reason is in YouTube's
own player code. The skip button's handler is, in the shipped build 4fd832e7:

    onClick(b){ b && b.preventDefault();
      DaZ(b, {...}) === 0
        ? g.RA(this.api, "onAbnormalityDetected")
        : (super.onClick(b), g.RA(this.api, "onAdSkip"), ...) }

    DaZ = function(b, W){ var c = 1; b.isTrusted === !1 && (c = 0); ...; return c }

`isTrusted` is set by the browser and only for genuine hardware input. A click dispatched by page
script is always untrusted, so that branch never skips the ad, and worse, it takes the other branch,
which reports an abnormality to YouTube's ad blocker detection. An earlier version of this retried
exactly that once a second, which was both useless and unwise.

So the content script never clicks. It picks the target, checks that the point it wants is really
occupied by that button, and hands the coordinates to the service worker, which dispatches through
`chrome.debugger` and `Input.dispatchMouseEvent`. That goes through the browser's own input
pipeline, so the event arrives with `isTrusted` set and the player's own handler takes the skip
branch. This is the only reason the service worker and the `debugger` permission exist.

Playback rate is a media property rather than an event, so it carries no trust requirement. That is
why speeding the ad up works from the page and clicking does not.

## How it finds the button

YouTube ships three skip button implementations at once, behind rollout flags. Reading the player
bundle confirms all three are live, and that YouTube's own code resolves the control by checking
`videoAdUiSkipContainer`, then `ytp-ad-skip-button-container`, then `ytp-skip-ad-button`.

This extension matches the same three implementations but tries them in its own order, by the
button's own class first: `ytp-skip-ad-button`, `ytp-ad-skip-button-modern`, `ytp-ad-skip-button`.
Nothing in the bundle establishes which of these is newest, so that ordering is a preference and not
a claim about YouTube's rollout.

If all three class names are renamed at once, there is a structural fallback that looks inside the
known container slots. It acts only when a slot offers exactly one candidate, and it refuses
outright to click anything on a deny list of advertiser controls, because sending you to an
advertiser is the worst thing this extension could do. When it is not sure, it does nothing and
lets the ad run.

Selection is not the last word. Before the coordinates go anywhere, `document.elementFromPoint` is
asked what would actually be hit at that spot, and the answer has to be the button or part of it,
and has to survive the deny list too. An overlay that arrives after selection would otherwise take
the click.

## How it handles the sound

During an ad the extension owns the audio, and only a reach for the audio takes it back.

This sounds aggressive and it is the second design. The first one was "never fight the user for the
volume", which never worked: measured on a live pod, the player writes `muted = false` at every
source change, so inside an ad pod it happens at every ad. The old rule read that as you and went
silent for the rest of the break, which is why the mute held on the first ad and died on all the
rest.

`volumechange` carries no writer identity, so nothing at the element can tell the player apart from
you. The substitute is a gesture clock: an unmute counts as yours only if a trusted `pointerdown`
landed on a volume control, or `m` was pressed with no modifier and no text field focused, in the
last second. Everything else is the player, and gets re-muted. Keyboard counts, because tabbing to
the mute button and pressing Enter has no pointer event in it at all.

Once it decides the audio is yours, it stays yours for the rest of the break. It will not unmute
you, and it will not re-mute you.

## Repository map

    manifest.json     MV3 manifest. One content script, one service worker, one permission.
    skipper.js        The content script, and where every decision is made. Ad detection, button
                      selection, the deny list, the hit test, audio ownership, playback rate, and
                      the generation counter that allows one skip attempt per ad.
    background.js     The service worker. Attaches the debugger, dispatches the click, detaches.
                      It makes no decisions. If you are adding logic, it does not go here.
    icons/            Extension icons, plus icons/proof with light and dark renders.
    test/             Three node test files. No runner, no dependencies.
    docs/adprobe.js   A console probe for watching what the real player does during an ad.
    docs/DESIGN-NOTES.md  Why the extension is built this way.
    AGENTS.md         Working agreements. The rules, each next to the defect that taught it.
    CONTRIBUTING.md   How to get a change in.

Configuration is a global you set from the console before the page loads, not a settings UI:

    window.__ytSkipConfig = { log: true, adRate: 16, speedUp: true, clickSkip: true }

`log` is off by default and turns on the `[YT Skip]` console trace. The others exist so a behaviour
can be switched off while diagnosing without editing the file.

## How the two halves talk

Two messages, both over `chrome.runtime`. This is the whole interface between the content script
and the worker.

**Content script to worker**, asking for a click:

    { type: 'yt-skip-request' }

**Worker replies:**

    { clicked: boolean, retryable: boolean, why: string }

`retryable` is the contract and `why` is for humans. The content script decides whether to try
again on the flag alone, never on the wording, because matching reason strings across two files was
one reword away from silently switching retries off. A transient miss, meaning no target, a target
that moved, or another skip already in flight, hands the attempt back. A failed attach does not,
because that is DevTools holding the tab and retrying it twice a second is fighting it.

**Worker to content script**, asking where to click:

    { type: 'yt-skip-resolve' }

**Content script replies:**

    { ok: true, x: number, y: number }    or    { ok: false }

Asked twice, after attaching and never before, with a message round trip between. Attaching raises
Chrome's debugging bar, which shifts the page, so a coordinate taken before the attach points above
the button. The two answers must agree. That is a stability check and not a guarantee: both round
trips can finish before a pending reflow reaches the renderer, so it narrows the window without
closing it.

## Tests

    node test/mute-state.test.js
    node test/click-selection.test.js
    node test/rate-control.test.js

No runner and no dependencies. Each file exits non zero if anything fails. The same three run in CI
on every pull request.

`background.js` is not unit tested. It is almost entirely `chrome.debugger` calls, and stubbing that
API would only prove the code calls the functions it plainly calls. It is checked against a real ad
instead, and that is the verification to insist on before believing a change to it works.

Passing tests are evidence about the behaviour they cover. They say nothing about live debugger
clicking or browser compatibility, and no test in here has ever seen a real ad.

## When it stops working

YouTube renames these classes from time to time. To see what changed, play a video until an ad
appears, open DevTools, and inspect the skip button. Whatever class it carries is the one to add to
`SKIP_SELECTORS` at the top of `skipper.js`.

Remember that opening DevTools is itself enough to stop the click, since it takes the debugger slot.
Once you know the class name, close DevTools before you test the fix.

## Diagnosing it live

Paste `docs/adprobe.js` into the page console and play through an ad. It records the player's own
writes with their stack frames, the effective playback rate against the buffer, and every ad class
transition. It runs in the main world, so anything it reports as `PAGE-SET` is YouTube writing and
never this extension.

Live measurement beats reasoning about this code. Most of the rules in AGENTS.md exist because
something that was obviously true turned out not to be.

## Contributing

Fork, branch, open a pull request against `main`. Nobody has push access to `main`, so that is the
only route in, and the test workflow has to pass. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).

The licence covers this code and nothing else. It is not permission from YouTube, and it says
nothing about their terms of service. Decide for yourself whether you want to run it.
