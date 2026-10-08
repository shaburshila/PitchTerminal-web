# Development process

PitchTerminal Web was built by one developer from May 22 to June 2, 2026. The
active development history contains 228 commits across 12 calendar days.

The work covered product definition, UX, frontend, backend, database design,
smart contracts, testing, infrastructure, and deployment.

## How AI was used

Claude was used during earlier iterations and Codex later in the project. AI
assisted with:

- breaking the product into frontend, backend, contract, and infrastructure
  work;
- drafting implementation plans and interface contracts;
- producing and revising code;
- expanding tests around failure paths;
- reviewing mismatches between layers;
- investigating deployment and runtime failures.

AI output was treated as a proposed change, not as evidence that the change
worked. Repository code, tests, contract behavior, and full user flows were the
checks used to accept or reject it.

## Work structure

The project was split by ownership:

| Area | Responsibility |
|---|---|
| Product | User states, access model, trading flows, portfolio behavior |
| Frontend | Desktop and mobile UI, wallet interaction, charts, SSE |
| Backend | REST API, SIWE, indexing, portfolio math, order storage |
| Contracts | Access payments, referrals, signatures, order execution |
| Infrastructure | Containers, reverse proxy, CI/CD, deployment, monitoring |

Interfaces were written down before parallel work crossed a boundary. Examples
included the REST route shapes, EIP-712 field order, database ownership, and
contract events.

The original detailed agent plans were useful during implementation but were
removed from the public repository after the project ended. They described
temporary task assignments rather than the final system.

## Verification

The final repository contains 94 application test files:

- 54 backend test files;
- 36 frontend test files;
- 4 project contract test files.

Checks used during active development included:

- pytest, Ruff, Black, and mypy for the backend;
- Vitest, ESLint, and Prettier for the frontend;
- Forge build, tests, and coverage for the contracts;
- Slither, Mythril, and manual contract review;
- deployment smoke checks and end-to-end user-flow checks.

CI ran the layer-specific checks before deployment. Automated deployment and CI
are now disabled because the server no longer exists.

## What the commit count means

The 228-commit figure covers the active development window and a single author.
It is included as project history, not as a quality metric on its own. The
repository, test suite, documentation, and product screenshot provide the
evidence for what was delivered.

## Current status

The product was completed for a limited operating window tied to the 2026 World
Cup. It is no longer hosted or maintained. The repository remains public as a
record of the implementation and the AI-assisted development process.
