# Roadmap

## Live today

- Composed single-process deployment of ehr-bridge + all four sentinel
  modules, sharing one Postgres.
- The full nine-link demo scenario, runnable against a fresh clone with zero
  configuration.
- A minimal dashboard showing zone/facility risk bands and the alert feed.
- `INFERENCE_BACKEND=mock` and mock SMS by default — Q30 holds with zero
  external accounts.

## Funded / planned

- **Hosted public demo instance** and a recorded walkthrough — infrastructure
  and recording are outside what a code repository can ship; see the parent
  project's application materials for status.
- **Local, fully-offline inference** via the `local-inference` Docker Compose
  profile (Ollama) — the profile exists in `docker-compose.yml` but has not
  been exercised end-to-end; treat it as a documented starting point.
- **Automated record transfer in the demo scenario** — `scripts/run-scenario.ts`
  currently documents this link rather than executing it, since it requires
  two already-connected partner systems in ehr-bridge. The transfer logic
  itself is tested directly in `ehr-bridge`.
- **CI** running the compose-based smoke test (build the image, bring up the
  stack, run the scenario script, assert it exits 0) — not yet wired into
  `.github/workflows`.

## Explicitly out of scope for this repo

Business logic. If you find yourself adding a service class here rather than
in `ehr-bridge` or `sentinel`, it likely belongs in one of those repos
instead — this one is deliberately composition, a demo script, and a static
dashboard.
