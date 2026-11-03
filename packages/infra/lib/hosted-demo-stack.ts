import { resolve } from "node:path";
import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  CfnOutput,
} from "aws-cdk-lib";
import type { Construct } from "constructs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";

/**
 * Absolute path to the built static site produced by
 * `npm run build:demo -w @spec-lantern/ui`, i.e. packages/ui/dist. That
 * directory holds index.html, the bundled UI assets, and dist/reports/*.json
 * (the pre-generated sample Lantern_Reports the UI fetches client-side).
 *
 * Resolved relative to this file (packages/infra/lib) so synth/deploy work
 * regardless of the current working directory.
 */
const UI_DIST_PATH = resolve(__dirname, "..", "..", "ui", "dist");

/**
 * Static Hosted_Demo infrastructure.
 *
 * - A private S3 bucket with Block Public Access fully ON — it is never a
 *   website endpoint and is reachable ONLY through CloudFront.
 * - A CloudFront distribution using Origin Access Control (OAC) to read the
 *   bucket, HTTPS-only for viewers, a default root object of index.html, and
 *   SPA-friendly 403/404 rewrites to index.html.
 * - A response-headers policy applying sensible security headers.
 * - A BucketDeployment that uploads packages/ui/dist and invalidates the
 *   CloudFront cache on every redeploy.
 *
 * The demo serves only static assets; it contains no runner and never
 * executes any Target_Repo code.
 */
export class HostedDemoStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Private origin bucket. Block Public Access ON; no public policy; served
    // exclusively via CloudFront OAC. Encrypted at rest with S3-managed keys.
    // RemovalPolicy.DESTROY + autoDeleteObjects keeps the throwaway demo easy
    // to tear down (destroy:demo) without leaving orphaned buckets.
    const siteBucket = new s3.Bucket(this, "SiteBucket", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // Sensible security headers applied to every CloudFront response.
    const responseHeadersPolicy = new cloudfront.ResponseHeadersPolicy(
      this,
      "SecurityHeadersPolicy",
      {
        comment: "spec-lantern Hosted_Demo security headers",
        securityHeadersBehavior: {
          contentTypeOptions: { override: true },
          frameOptions: {
            frameOption: cloudfront.HeadersFrameOption.DENY,
            override: true,
          },
          referrerPolicy: {
            referrerPolicy:
              cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
            override: true,
          },
          strictTransportSecurity: {
            accessControlMaxAge: Duration.days(365),
            includeSubdomains: true,
            override: true,
          },
          xssProtection: { protection: true, modeBlock: true, override: true },
          // CSP must be set here (CloudFront rejects it as a custom header).
          // The demo is a self-contained SPA that fetches its own static
          // report JSON from the same origin; no third-party scripts.
          contentSecurityPolicy: {
            contentSecurityPolicy:
              "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
            override: true,
          },
        },
      },
    );

    // CloudFront distribution. OAC origin reads the private bucket; viewers are
    // forced to HTTPS. Default root object is index.html.
    const distribution = new cloudfront.Distribution(this, "Distribution", {
      comment: "spec-lantern static Hosted_Demo",
      defaultRootObject: "index.html",
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin:
          origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy:
          cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy,
      },
      // SPA fallback: serve index.html for client-side routes / missing keys.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.minutes(5),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: "/index.html",
          ttl: Duration.minutes(5),
        },
      ],
    });

    // Upload the built UI (packages/ui/dist) and invalidate the whole
    // distribution on every redeploy so visitors always get the latest build.
    new s3deploy.BucketDeployment(this, "DeployUi", {
      sources: [s3deploy.Source.asset(UI_DIST_PATH)],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ["/*"],
      prune: true,
    });

    new CfnOutput(this, "DistributionDomainName", {
      value: distribution.distributionDomainName,
      description: "Public URL host of the Hosted_Demo (https://<this>/).",
    });
    new CfnOutput(this, "DistributionUrl", {
      value: `https://${distribution.distributionDomainName}/`,
      description: "Public HTTPS URL of the Hosted_Demo.",
    });
    new CfnOutput(this, "SiteBucketName", {
      value: siteBucket.bucketName,
      description: "Private origin bucket (reachable only via CloudFront OAC).",
    });
  }
}
