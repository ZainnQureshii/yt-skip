# Design notes

Why the extension is built the way it is. These are the findings that shaped it, kept because
several of them contradict what the code looks like it should do. AGENTS.md carries the rules;
this file carries the reasoning behind the ones that need more than a paragraph.

## A page script click cannot skip an ad

The skip button's handler in player build 4fd832e7:

    onClick(b){ b && b.preventDefault();
      DaZ(b, {...}) === 0
        ? g.RA(this.api, "onAbnormalityDetected")
        : (super.onClick(b), g.RA(this.api, "onAdSkip"), ...) }

    DaZ = function(b, W){ var c = 1; b.isTrusted === !1 && (c = 0); ...; return c }

`DaZ` was first read in isolation and taken for telemetry. It is the gate. An untrusted click does
not merely fail to skip, it takes the branch that reports an abnormality to ad blocker detection,
so the early version that retried a synthetic click once a second was worse than doing nothing.

Reading a function body tells you what it computes. Only the call site tells you what it decides.

The consequence is the whole architecture: the content script resolves a target and the service
worker dispatches through `chrome.debugger`, which goes via the browser's own input pipeline and
arrives trusted.

## Playback rate carries no trust requirement

A `playbackRate` write is a media property rather than an event, so nothing checks where it came
from. This is why the ad can be run at 16x from the page while the click cannot be made there.

It also fires no mutation, so re-applying the rate after a player reset waits on the sweep unless
some other mutation happens to intervene.

## Nothing can tell the player apart from the user at the element

Two mechanisms broke the original mute, and only one of them was the obvious one.

The player writes `muted = false` at every source change, from `sd` inside `h85.X_`, measured on a
live pod. So inside an ad pod it happens at every ad. A rule that surrenders the audio on any
foreign unmute surrenders at the first ad of the break and stays surrendered.

The subtler one is an ordering hazard that needs no assumption about YouTube at all. `volumechange`
is queued per the HTML spec, and matching a pending write against the element's *current* `muted`
state rather than the state the originating write set means that any second write landing in
between makes our own event fail its own match. Our own mute write becomes the thing that disables
muting for the rest of the break. A test covering an interleaved volume move does not exercise
this, so the suite passed throughout.

There is no writer identity available. Browser generated events stay trusted whether or not script
caused the change, the mute button attributes and `yt-player-volume` report player state rather
than user intent, and same window localStorage writes fire no `storage` event. So any fix is a
heuristic, and the gesture clock is that heuristic: an unmute is the user's only if a trusted
input landed on a volume control, or the mute shortcut was pressed, in the last second.

## The gesture must be specific to the audio

Counting any trusted input is wrong twice over. An unrelated click anywhere would excuse YouTube's
next reset, and the extension's own trusted skip click would excuse it too, which puts the original
defect straight back the first time a skip succeeds. Case 14 of the mute suite fails against the
any-gesture form.

## Do not reclaim an owned element the moment it reads unmuted

Re-muting on sight looks correct and is a defect. It races the user's own queued `volumechange`:
the sweep re-mutes, their event then arrives and latches the takeover, and they are stranded muted
for the whole break. The sweep and the handler both go through one `reachedForAudio()` predicate so
the two can never disagree about who owns the audio.

## Attach before resolving, and measure twice

Attaching raises Chrome's debugging bar, which shifts the page down, so a coordinate taken before
the attach points above the button.

Attaching first is necessary and not sufficient. The reflow reaches the page on its own schedule
rather than with the attach callback, so a single measurement can describe a layout that is already
moving. The point is resolved twice with a message round trip between, and a target whose
coordinates changed is left alone.

That double measurement is a stability check and not a guarantee. Both round trips can complete
before a pending reflow reaches the renderer, and nothing observed before the dispatch can bind
what the layout does after it. The hit test has the same limit: it establishes safety at the
instant it runs and no later. Both narrow the window. Neither closes it, and the only thing that
would is evidence from a live ad.

## Coordinate spaces are verified at default zoom only

CDP input coordinates are viewport CSS pixels, which is what `getBoundingClientRect` gives, so no
device pixel ratio or zoom correction is applied. The two spaces were confirmed to agree on a live
ad at the default browser zoom on a Retina display. A non default page zoom has never been
measured, and a click that lands off target hits a neighbouring ad control with no guard left.

This is the largest open risk in the extension. Measure it rather than reason about it.

## Scope attempts to ad generations, not DOM identity

An ad pod reuses and replaces the player's elements, so keying an attempt on a button reference
either retries one ad forever or skips only the first ad of the pod. The generation counter moves
on three signals and not one: a break starting, a media `loadstart`, and a player rebind. An
earlier version added the counter and never incremented it, which allowed exactly one skip attempt
per page load.

## Things that were considered and cut

**Seeking past the ad.** The player instruments untrusted seek events as an ad blocker detection
signal, and a stale ad state could send that seek into the real video.

**Lowering the ad's bitrate from a main world script.** Deferred until the trusted click was proven
on a live ad, and never needed once it was. Running the ad at speed already ends it in about a
second.
