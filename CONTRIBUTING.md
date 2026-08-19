Contributing to testLM

Thank you for contributing! This guide helps get new contributors productive quickly.

Quick developer setup

1. Prerequisites
 - Node.js 18+ and npm
 - PowerShell (Windows) for agent scripts
 - Docker (optional) for dev containers/local DB

2. Local setup
 - Copy .env.example to .env and fill required keys. See ENVIRONMENT.md for details.
 - Install Node deps:
   cd os-agent
   npm install

3. Run locally
 - Start local LM Studio server (if using local models) or ensure provider keys are in .env
 - Run agent:
   cd os-agent
   node index.js
 - For PowerShell maintenance scripts, run from repository root:
   .\agent\local-agent.ps1

Testing
 - Add unit tests under os-agent/tests and run with the repository's test runner (npm test in os-agent if present).
 - Run linters / formatters if configured.

Commit & PR guidelines
 - Use small, focused commits with clear messages.
 - Include tests for new functionality and update ENVIRONMENT.md if new env vars are added.
 - Open a PR against master and request a review. CI should run automatic checks.

Communicate
 - If the change affects setup or the environment, mention steps in the PR description.
 - For larger changes, open an issue first to discuss the design.

Thanks — maintainers
