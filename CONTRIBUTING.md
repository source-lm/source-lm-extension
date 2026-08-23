# Contributing

Thanks for looking. Before opening a pull request, please read this — it
is short, and it matters because of how this project is licensed.

## Licensing of contributions

The code in this repository is published under [PolyForm Noncommercial
1.0.0](./LICENSE.md) (source-available, not open source). The maintainer
also distributes commercial builds of the same code (the Chrome Web Store
listing and its paid Pro tier).

By submitting a contribution (pull request, patch, or code in an issue),
you agree that:

1. You wrote it yourself, or have the right to contribute it.
2. You license your contribution to the maintainer (Mikhail Konkov) under
   the [MIT License](https://opensource.org/license/mit), so it can be
   included both in this repository under PolyForm Noncommercial 1.0.0
   and in the commercial builds.
3. You sign off each commit (`git commit -s`) as a
   [Developer Certificate of Origin](https://developercertificate.org/)
   attestation of the above.

If you are not comfortable with that, open an issue describing the change
instead of a pull request — that is genuinely useful too.

## Practical notes

- Read `DECISIONS.md` first: architecture, the "decisions that must not be
  silently reverted" list, and the working style (minimal diff, no new
  dependencies, everything in English).
- `npm install && npm test && npx tsc --noEmit && npm run build` must pass.
- Non-trivial logic gets one test in `test/convert.test.mjs`.
- Issues and pull requests are handled on a best-effort basis; there is
  no support SLA.
