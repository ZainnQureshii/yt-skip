# Working agreements for this repo

Read this before changing anything here. It is the same guidance any agent on this machine
follows, narrowed to what this project has actually learned.

## House style

- Two space indent, single quotes, semicolons.
- No em dashes anywhere, in code, comments, commits or docs.
- Comments explain why, never what. A comment restating the line it sits on gets deleted.
- No dependencies. The extension ships as plain files and the tests run on bare node.

## Hard rules this project learned

**Verify against the live player, never from memory.** Every selector in `skipper.js` was confirmed
present in a real YouTube player bundle before it was written down. YouTube ships three skip button
implementations concurrently behind rollout flags, so matching only the one you remember is how this
breaks silently.

**Never assume a fixed delay.** The player carries `skipOffsetMilliseconds` as per ad data. Five
seconds is a common case, not a rule. Nothing in this repo may count seconds to decide when to act.

**Never seek the ad.** It was considered and cut. The player instruments untrusted seek events as an
ad blocker detection signal, and a stale ad state could send that seek into the real video.

**Never guess at a click target.** Clicking the wrong control sends the user to an advertiser, which is
the worst thing this extension can do. When a container offers more than one candidate, do nothing.
Leaving an ad running is always the better failure.

**During an ad we own the audio, and only a reach for the audio takes it back.** This replaces
"never fight the user for the volume", which was the rule until 2026-09-21 and which never worked.
Measured on a live pod: the player writes `muted = false` at every source change, from `sd` inside
`h85.X_`, so inside an ad pod it happens at every ad. The old rule read that as the user and went silent
for the rest of the break, which is why the mute held on the first ad and died on all the rest.

`volumechange` carries no writer identity. Browser generated events stay trusted whether or not
script caused them, and `yt-player-volume` reports player state rather than intent, so nothing can
tell the player apart from the user at the element. The gesture clock is the substitute: an unmute
counts as his only if a trusted `pointerdown` landed on a volume control, or `m` was pressed, in the
last second. Everything else is the player and gets re-muted.

**The gesture must be specific to the audio, never just any gesture.** The first version of this
counted any trusted input, which is wrong twice: an unrelated click would excuse YouTube's next
reset, and our own trusted skip click would excuse it too, putting the original defect straight
back. Case 14 of the mute test exists to catch exactly that and fails against the any-gesture form.

**Do not re-mute ahead of a volumechange that has not been delivered.** Reclaiming an owned element
the moment it reads unmuted looks right and strands the user muted for the whole break when his own
unmute event simply had not arrived yet. The sweep and the handler both go through
`reachedForAudio()` so the two can never disagree about who owns the audio.

Four of the six defects found in the original review were in this area, and two more were found
here since. Change it only with the tests in front of you.

**A test that cannot fail is worthless.** Before trusting a new test, run it against the code it was
written to catch. One test in this repo was written, passed, and then found to pass against the old
behaviour too, which meant it proved nothing.

**A predicate is only a gate at its call site.** The whole clicking approach was built on
reading `DaZ` in isolation and concluding it was telemetry. It is the gate that decides whether
a skip happens, and the call site was one grep away. Reading a function body tells you what it
computes, never what it decides.

**Synthetic events cannot skip a YouTube ad, so the click is asked for and never made here.**
`isTrusted` is checked, and the untrusted branch reports to ad blocker detection. `skipper.js` must
never dispatch a click itself. It resolves the target and asks `background.js`, which dispatches
through `chrome.debugger` and `Input.dispatchMouseEvent`. CDP input goes through the browser's own
input pipeline and arrives trusted, which is the whole reason the service worker exists.

**Resolve the point after attaching, never before.** Attaching raises Chrome's debugging bar, which
shifts the page down, so a coordinate taken before the attach points above the button.

**Selection is not a hit test.** `findSkipButton` says what we want to hit. Only
`document.elementFromPoint` says what would actually be hit, and the answer has to be the button or
part of it, and has to survive the deny list itself. Without that check an overlay arriving after
selection takes the click.

**One attempt per ad, keyed on a generation counter and never on DOM identity.** A pod reuses and
replaces these elements. The counter moves on a break starting, on a media `loadstart` and on a
player rebind. Getting this wrong in either direction means retrying one ad forever or skipping only
the first ad of the pod, and the second of those shipped briefly during this work.

**Debugger contention is a lost attempt, not a fight.** Chrome allows one debugger client per tab,
so an open DevTools window wins and we do nothing. Detach in a `finally`.

**Spend the attempt on a click, not on asking for one.** Marking the generation used and then
discovering nothing was dispatched leaves that ad unskippable for its whole run. A transient miss,
meaning no target, a moved target, or another skip already in flight, hands the attempt back. A
failed attach does not, because that is contention and retrying it twice a second is fighting it.

**Per tab, never global.** The one debugger client limit is scoped to a tab. A single global
in-flight flag meant one tab's ad break blocked the skip in every other tab.

**Attaching after resolving is not enough on its own.** The debugging bar shrinks the viewport and
that reflow reaches the page on its own schedule rather than with the attach callback, so a single
measurement can describe a layout that is already moving. The point is resolved twice with a message
round trip between, and a target whose coordinates changed is left alone.

**That double measurement is a stability check and not a guarantee, so do not write it up as one.**
Both round trips can complete before a pending reflow reaches the renderer, and nothing observed
before the dispatch can bind what the layout does after it. The hit test has the same limit: it
establishes safety at the instant it runs and no later. Both narrow the window. Neither closes it,
and the only thing that would is evidence from a live ad.

**Keyboard is a reach for the audio too.** Judge a gesture by what it landed on, not by whether it
came from a pointer. Tabbing to the mute button and pressing Enter has no pointer event in it at
all, and the first version of the gesture rule read it as the player and re-muted him every sweep.
`m` is the exception, because YouTube handles it at the document and it never has a volume control
as its target.

**A shortcut key is only a shortcut where the shortcut applies.** `m` counts as a reach for the
audio only with no modifier held and no text field focused. YouTube does not mute on `m` while you
are typing, so counting it there opens a gesture window on every letter of a search query, and a
source change landing in one of those windows hands the rest of the break back to the player. That
is the original defect, reintroduced by the fix for it.

**Every path that decides ownership goes through `reachedForAudio()`, acquisition included.** The
handler dropping ownership and the sweep re-acquiring it are two decisions about the same thing, and
leaving the predicate off either one lets them disagree: the player unmutes, the handler lets go,
the user reaches for the volume, and the next sweep re-mutes him inside his own gesture window.

**Retries are capped per ad.** Every attach raises Chrome's debugging bar and every detach drops it,
and that reflow is itself a cause of the misses being retried, so an uncapped retry re-attaches
twice a second for the length of the ad. One attempt and three retries, which is four attaches at
most, then leave the ad alone.

**A modifier is every modifier.** The `m` guard checked meta, ctrl and alt and not shift, while
still accepting the `'M'` that shift is what produces. So Shift+m anywhere on the page opened a
gesture window on a keystroke YouTube ignores, which is the text field defect again in a second
costume. `'M'` still counts without shift, because caps lock produces it and YouTube does mute on
that, so the obvious fix of dropping `'M'` is wrong and case 19 fails against it.

**A stub that does not speak the shipped contract is not a test.** The worker replies
`{ clicked, retryable, why }` and the content script branches on `retryable`. The click suite's
stub replied `{ ok, why }`, so `retryable` was `undefined` on every reply, every retry was silently
declined, and the whole retry path had no coverage at all while the suite read as green. When a
contract crosses a file boundary, the stub's shape is part of what is under test.

**The retry contract is a flag, not a reason string.** Matching reason wording across the worker and
the content script meant a reword on either side would silently switch retrying off.

**The coordinate spaces are verified at default zoom only.** The click is dispatched in the
browser's space and the hit test proves what the page would hit. They agreed on a live ad at the
default browser zoom on a Retina display. Nobody has measured a non default page zoom, and the
failure there lands a click on a neighbouring ad control with no guard left. Measure it before
relying on it.

**An orphaned content script survives an extension reload** and throws out of `sendMessage` on every
ad until the page is reloaded. Guard on `chrome.runtime.id`.

## Before you call it done

    node test/mute-state.test.js
    node test/click-selection.test.js
    node test/rate-control.test.js

All three must exit zero before anything is proposed for merge.

`background.js` has no unit test. It is almost entirely `chrome.debugger` calls, and a stub of that
API would only assert that the code calls the functions it obviously calls. It is verified against a
live ad instead, and that verification is the thing to insist on before believing it works.

Live measurement beats any of this. `docs/adprobe.js` pastes into the page console and records the
player's own writes with their stack frames, the effective playback rate against the buffer, and
every class transition. It runs in the main world, so what it reports as `PAGE-SET` is YouTube
writing and never us.
