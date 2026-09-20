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

**Never fight the user for the volume.** If the user touches the mute himself, we let go and do not
reclaim it for that ad break. Four of the six defects found in review were in this area, so change
it only with the tests in front of you.

**A test that cannot fail is worthless.** Before trusting a new test, run it against the code it was
written to catch. One test in this repo was written, passed, and then found to pass against the old
behaviour too, which meant it proved nothing.

## Before you call it done

    node test/mute-state.test.js
    node test/click-selection.test.js

Both must exit zero before anything is proposed for merge.
