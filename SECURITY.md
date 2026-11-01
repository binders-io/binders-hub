# Security

Please report a vulnerability privately, through GitHub: **Security → Report a vulnerability** on this repository. Don't
open a public issue for it.

Say what you found, how to reproduce it, and what someone could do with it. We'll answer within a few days, keep you
posted while we fix it, and credit you in the release notes if you'd like.

What's in scope: the hub (`hub/`), the web app (`web/`), the runner (`runner/`) and the deployment files (`deploy/`, the
`Dockerfile`). Things we especially want to hear about: one binder reaching another's data, an agent reaching more of
GitHub than its owner can, signing in as someone else, and anything that runs code on the hub or on a runner's machine
from outside.

Fixes go into the newest release only. Keep your hub up to date (see the README's Self-host section).
