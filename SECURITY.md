# Security policy

Source LM runs inside your signed-in NotebookLM / Gemini Notebook tab and
talks to Google's endpoints with your session — so it matters to get
security right.

## Reporting a vulnerability

Please do **not** open a public issue for security problems. Email
**support@source-lm.com** with:

- what the issue is and where (file / function),
- steps to reproduce or a proof of concept,
- the impact as you understand it.

You will get an acknowledgement within a few days and a fix or a
decision as soon as reasonably possible. Please give a reasonable
disclosure window before publishing.

## Scope

In scope: anything in this repository and the published extension —
leaking session tokens or license keys to third parties, XSS in the
popup or injected UI, actions a web page could trigger without the
user's click, supply-chain issues in the build.

Out of scope: removing the Pro gate in your own local build (the code is
source-available; see `README.md` → License), and Google changing its
private endpoints (that is breakage, not a vulnerability — open a
regular issue).
