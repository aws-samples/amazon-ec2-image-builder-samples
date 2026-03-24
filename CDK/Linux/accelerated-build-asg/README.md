# EC2 Image Builder — ASG Warm Pool

CDK TypeScript application that provisions an accelerated EC2 Image Builder pipeline. Build instances are pre-warmed in an Auto Scaling Group, eliminating cold-start launch time.

## Architecture

```
EventBridge (rate 30 days) ──▶ AMI Update Lambda ──▶ Launch Template + ASG Refresh

Image Pipeline ──▶ WaitForAction ──▶ Builder Lambda ──▶ DynamoDB Lock ──▶ ASG Instance
                                          │
                                          ▼
                                   Build Components ──▶ Create AMI
                                          │
                                          ▼
                                   Termination Lambda ──▶ Async instance cleanup

CloudWatch Alarms: Builder errors, AMI Update errors, ASG zero-instances, DLQ depth
```

Key design decisions:

- **Direct Lambda invocation** — the Image Builder workflow calls the Builder Lambda via `lambdaFunctionName`, eliminating the SNS/KMS chain (6 fewer resources).
- **Async termination** — instance cleanup is handled by a separate Termination Lambda via `WaitForAction`, so the pipeline doesn't block on synchronous `TerminateInstance`.
- **DynamoDB instance locking** — conditional `PutItem` prevents concurrent invocations from claiming the same instance. TTL auto-expires stale locks.
- **CDK-native SSM resolution** — the Launch Template AMI and Image Recipe base image are resolved via SSM parameters at synth time, removing the custom GetLatestAmi Lambda.
- **Monthly AMI refresh** — an EventBridge rule triggers a Lambda that creates a new Launch Template version and starts an ASG instance refresh.
- **Provisioned concurrency** — all three Lambdas have provisioned concurrency of 1 via `live` aliases to eliminate cold starts.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 18.x
- [AWS CDK CLI](https://docs.aws.amazon.com/cdk/v2/guide/cli.html) (`npm install -g aws-cdk`)
- AWS credentials configured (`aws configure` or environment variables)
- A VPC with subnets that have connectivity to EC2 Image Builder and SSM

## Installation

```bash
cd CDK/Linux/accelerated-build-asg
npm install
```

## Context Parameters

| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `vpcId` | **Yes** | — | VPC ID where the ASG will be created |
| `subnetIds` | **Yes** | — | Comma-separated subnet IDs for the ASG |
| `instanceType` | No | `t3.medium` | EC2 instance type for ASG instances |
| `desiredCapacity` | No | `1` | ASG desired capacity |
| `minCapacity` | No | `1` | ASG minimum capacity |
| `maxCapacity` | No | `2` | ASG maximum capacity |

## Stack Props

| Prop | Default | Description |
|------|---------|-------------|
| `collectImageMetadata` | `false` | Include the InventoryCollection (CollectImageMetadata) step in the build workflow |

## Deploy

```bash
npx cdk deploy \
  -c vpcId=vpc-xxx \
  -c subnetIds=subnet-aaa,subnet-bbb
```

With optional overrides:

```bash
npx cdk deploy \
  -c vpcId=vpc-xxx \
  -c subnetIds=subnet-aaa,subnet-bbb \
  -c instanceType=t3.large \
  -c desiredCapacity=2 \
  -c minCapacity=1 \
  -c maxCapacity=4
```

## Preview (Synth)

```bash
npx cdk synth \
  -c vpcId=vpc-xxx \
  -c subnetIds=subnet-aaa,subnet-bbb
```

## Tests

```bash
npm test
```

Tests include Lambda unit tests (mocked SDK clients) and CDK assertion tests (template verification for security, IAM, alarms, and resource configuration).

## Lambda Functions

| Function | Memory | Timeout | Provisioned Concurrency | Purpose |
|----------|--------|---------|------------------------|---------|
| Builder | 256 MB | 60s | 1 | WaitForAction handler: find, lock, detach, tag instance |
| AMI Update | 256 MB | 60s | 1 | Monthly AMI refresh and ASG instance refresh |
| Termination | 256 MB | 120s | 1 | Async build instance cleanup |

## Stack Outputs

| Output | Description |
|--------|-------------|
| `ImagePipelineArn` | ARN of the Image Builder Pipeline |
| `LaunchTemplateId` | ID of the EC2 Launch Template |
| `AutoScalingGroupName` | Name of the Auto Scaling Group |
