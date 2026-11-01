# Contributing

Thanks for wanting to help. Issues and pull requests are welcome.

- **Bugs:** open an issue with what you did, what you expected, and what happened, with the hub's version from
  Settings → This hub. Leave out tokens, keys and anything private from your logs.
- **Ideas:** open an issue first for anything big, so we can agree on the shape before you build it.
- **Security problems:** see [SECURITY.md](SECURITY.md), not an issue.

## Pull requests

This repository is published from the team's working repository, so a merged pull request arrives here as part of the
next release, with you credited as its author. Keep each one to one change, and:

1. Run the tests for what you touched: `cd hub && npm test`, `cd runner && npm test`, `cd web && npm test` (see the
   README's Tests section). `docker build --target test .` runs all of them, as a deploy does.
2. Match the code around it: its naming, its comments and its plain wording in anything a person reads.
3. Use invented names and data in tests and fixtures, never real people, companies or tokens.

By sending a pull request you agree that your contribution is licensed under the AGPL-3.0, like the rest of the code.

## Conduct

Be kind and assume good intent. Harassment, insults and personal attacks aren't welcome here, in issues, pull requests
or anywhere else the project lives. We'll remove comments and block people who don't follow this. To report something,
use GitHub's report feature or contact the maintainers through a private security report.
