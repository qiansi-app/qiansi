# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

This policy applies to the Windows builds of 牵丝 / Qiansi published from this repository.

## Team roles

- Committers and reviewers: <!-- Replace with your GitHub handle or team link, e.g. [@your-handle](https://github.com/your-handle) -->
- Approvers: <!-- Replace with the people allowed to approve a signing request -->

All maintainers use multi-factor authentication for both GitHub and SignPath.

## Build and release

- Builds are produced by GitHub Actions on GitHub-hosted Windows runners.
- Signed releases are built from the tagged commit; the workflow and artifact configuration live in this repository under `.github/workflows/` and `.signpath/`.
- Upstream third-party binaries (Electron, Node) are included as-is and are not re-signed with this project's certificate.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

Model requests are sent only to the endpoints the user configures. The local service listens on `127.0.0.1` and does not upload telemetry. Feedback is written to a local file unless the user chooses to submit it elsewhere.
