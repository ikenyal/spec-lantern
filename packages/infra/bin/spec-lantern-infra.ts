#!/usr/bin/env node
/**
 * CDK app entry point for the spec-lantern static Hosted_Demo.
 *
 * This stack provisions ONLY static hosting (a private S3 bucket fronted by
 * CloudFront) for the pre-generated Lantern_Report_UI build. It contains no
 * runner and never executes Target_Repo code — the demo serves static JSON
 * reports and the built UI, nothing more.
 *
 * The deploy account is read from SPEC_LANTERN_AWS_ACCOUNT (never committed)
 * and the region is pinned to ap-northeast-1. If the variable is missing or
 * malformed, synthesis stops instead of guessing an account. Every resource is
 * tagged Project=spec-lantern, Event=Kiroween2026.
 */
import { App, Tags } from "aws-cdk-lib";
import { HostedDemoStack } from "../lib/hosted-demo-stack";

const account = process.env.SPEC_LANTERN_AWS_ACCOUNT;
if (!account || !/^\d{12}$/.test(account)) {
  throw new Error(
    "Set SPEC_LANTERN_AWS_ACCOUNT to the 12-digit AWS account to deploy the demo into.",
  );
}

const app = new App();

new HostedDemoStack(app, "SpecLanternHostedDemo", {
  env: {
    account,
    region: "ap-northeast-1",
  },
  description:
    "spec-lantern static Hosted_Demo: private S3 bucket + CloudFront (OAC) serving the pre-generated Lantern_Report_UI. No runner, no target execution.",
});

// Tag every resource in the app for cost allocation / Kiroween attribution.
Tags.of(app).add("Project", "spec-lantern");
Tags.of(app).add("Event", "Kiroween2026");

app.synth();
