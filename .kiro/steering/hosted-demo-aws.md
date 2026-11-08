---
inclusion: always
---

# Hosted_Demo AWS constraints (task 19 and any later deploy work)

- AWS: use ONLY the profile "brightflow-sandbox-ikeda" (account from the SPEC_LANTERN_AWS_ACCOUNT env var, never written to the repo;
  region ap-northeast-1). Never use any other profile. Pass --profile explicitly
  on every AWS/CDK command.
- IaC: AWS CDK in TypeScript, in a new packages/infra workspace.
- Private S3 bucket (Block Public Access on) served only through CloudFront with
  Origin Access Control; HTTPS only; default *.cloudfront.net domain
  (no custom domain); sensible security headers; cache invalidation on redeploy.
- Tag every resource: Project=spec-lantern, Event=Kiroween2026.
- Keep costs minimal (no WAF, no logging buckets unless required).
- Before any "cdk bootstrap" or "cdk deploy", show the user the "cdk diff" output
  and wait for explicit approval. Never run them without approval.
- The demo serves only pre-generated static report JSON and the built UI;
  it contains no runner and never executes target code. Keep the
  "Sample data" badge until task 20 replaces the sample report.
- Add "npm run deploy:demo" and document deploy/destroy in the README.
