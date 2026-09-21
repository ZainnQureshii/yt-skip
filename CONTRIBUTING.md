# Contributing

Pull requests are welcome. Nobody has push access to `main`, including through a fork, so every
change arrives the same way.

1. Fork the repository.
2. Make your change on a branch in your fork.
3. Run all three test files and make sure they exit zero.
4. Open a pull request against `main`.

The `tests` workflow runs the same three files on every pull request and has to pass. the user reviews
and merges. There is no other route in.

Before you change any behaviour, read [AGENTS.md](AGENTS.md). It is the working agreements file and
it records the rules this project learned the hard way, each one next to the defect that taught it.
Several of them look wrong until you know the failure behind them, and the tests exist to catch you
reintroducing exactly those. That applies whether you are a person or an agent.

Two things that will get a change rejected on sight:

- **A claim that was not measured against a live ad.** The README and AGENTS.md are careful about
  what has been verified and what has not. Keep that line honest rather than tidying it away.
- **A dependency.** The extension ships as plain files and the tests run on bare node. It stays that
  way.

House style is two space indent, single quotes, semicolons, no em dashes anywhere, and comments that
explain why rather than what.
