# spec-lantern 🎃

> Light up abandoned vibe-coded apps — and bring them back to life with specs.

**Status:** Work in progress for [Kiroween 2026](https://kiroween.devpost.com/) (category: Resurrection).

## What is this?

Thousands of apps were "vibe-coded" with AI and abandoned within weeks — nobody,
not even their creators, fully understands them anymore. They are the newest kind of dead technology.

spec-lantern reads an abandoned AI-generated repository and reverse-engineers:

- **Kiro specs** (requirements, design, tasks)
- **Steering docs**
- **Property-based tests** that capture what the app was supposed to do

…then uses them to revive the app as a maintainable, spec-driven project.

## Hosted demo (static site)

The public demo is a **static site** — the built Lantern_Report_UI plus
pre-generated sample report JSON. It contains **no runner** and never executes
any target code; it only serves static assets. The UI currently shows a
**"Sample data"** badge, and will keep it until the real pipeline output
replaces the sample report.

Infrastructure lives in [`packages/infra`](./packages/infra) as an AWS CDK
(TypeScript) app: a **private S3 bucket** (Block Public Access on) served only
through **CloudFront** via Origin Access Control (OAC), HTTPS-only, with
security headers and cache invalidation on every redeploy.

### Prerequisites

- AWS credentials for profile **`brightflow-sandbox-ikeda`**
  (account `402040564721`, region `ap-northeast-1`). All commands below use
  this profile; do not use any other.
- A one-time CDK bootstrap of that account/region (a human runs this after
  reviewing the diff — see the warning below):

  ```sh
  cd packages/infra
  npx cdk bootstrap --profile brightflow-sandbox-ikeda
  ```

### Deploy

```sh
# Builds the demo (export sample report + vite build → packages/ui/dist)
# then deploys the CDK stack with the required profile.
npm run deploy:demo
```

> ⚠️ **`npm run deploy:demo` performs a REAL AWS deploy.** Before running it,
> review the planned changes and approve them:
>
> ```sh
> npm run build:demo -w @spec-lantern/ui        # produce packages/ui/dist
> npm run diff -w @spec-lantern/infra           # review: cdk diff (profile brightflow-sandbox-ikeda)
> ```
>
> Only deploy once the `cdk diff` output looks right. The deploy uploads
> `packages/ui/dist` to the private bucket and invalidates the CloudFront
> cache. The public URL is printed as the `DistributionUrl` stack output.

### Destroy

```sh
npm run destroy:demo
```

This tears down the CloudFront distribution and empties/removes the bucket
(the demo bucket is throwaway, so objects are auto-deleted on destroy).

Every resource is tagged `Project=spec-lantern` and `Event=Kiroween2026`.

## License

[MIT](./LICENSE)
