# Build an image with the latest Amazon SSM Agent

Image Builder drives build instances through AWS Systems Manager, and the agent version baked into a base image can lag the latest release. These templates run the Amazon-managed `build-image-with-update-ssm-agent` workflow, which updates the agent (through the `AWS-UpdateSSMAgent` document) before running the recipe's components - so the resulting image ships with the latest agent, with no install commands to maintain.

Three templates, one per operating system. Each is a complete, self-contained build:

| Template | Base image |
|---|---|
| `amazon-linux-2023.yml` | Amazon Linux 2023 (latest managed image) |
| `ubuntu.yml` | Ubuntu 24.04 LTS (latest managed image) |
| `windows-server.yml` | Windows Server 2025 Full Base (latest managed image) |

## Cost

Each stack launches one EC2 build instance for the duration of the build (typically 15 to 30 minutes for Linux, 45 to 60 for Windows) and stores build logs in S3 and CloudWatch Logs. The build instance bills at standard EC2 rates while it runs. The resulting image's snapshots continue to bill until you deregister the image and delete them.

## Prerequisites

- A default VPC in the target region (or set `SubnetId` in the infrastructure configuration - see the comment in the template).
- Permissions to create IAM roles, so deploy with `--capabilities CAPABILITY_IAM`.

## Deploy

```shell
aws cloudformation create-stack \
  --stack-name latest-ssm-agent-al2023 \
  --template-body file://amazon-linux-2023.yml \
  --capabilities CAPABILITY_IAM
```

Substitute the template file for the OS you want. The stack stays in `CREATE_IN_PROGRESS` until the image build completes - the `AWS::ImageBuilder::Image` resource only signals completion when the image is `AVAILABLE`, so expect the stack to take as long as the build.

## How it works

Custom image workflows replace the default build and test workflows when you list them on the image, so each template names both the agent-update build workflow and the standard `test-image` workflow. Running workflows requires an execution role that the service assumes; the templates create one from the `EC2ImageBuilderExecutionPolicy` managed policy plus a single inline statement - the policy's `ssm:SendCommand` list doesn't include the `AWS-UpdateSSMAgent` document the workflow runs.

The recipes reference their parent images and components with `x.x.x` version wildcards, so each deployment resolves the latest managed base image and component versions at build time.

The resulting image ID is written to an SSM parameter (`/imagebuilder/samples/<os>-latest-ssm-agent`) with the `aws:ec2:image` data type, ready for launch templates or other stacks to consume.

## Testing

After the stack completes:

```shell
aws ssm get-parameter --name /imagebuilder/samples/al2023-latest-ssm-agent --query Parameter.Value --output text
```

Launch an instance from the returned image ID and confirm the agent version matches the [latest release](https://github.com/aws/amazon-ssm-agent/releases): on Amazon Linux, `amazon-ssm-agent --version`; on Ubuntu, `snap list amazon-ssm-agent`; on Windows, check the `AmazonSSMAgent` service's file version.

## Cleanup

1. Delete the contents of the stack's S3 log bucket, including all object versions and delete markers - the bucket has versioning enabled, so `aws s3 rm --recursive` alone leaves versions behind and the stack deletion fails on a non-empty bucket. The console's "Empty bucket" action removes versions for you.
2. Delete the stack.
3. Deregister the AMI the build created and delete its snapshots - they aren't stack resources and continue to bill until removed.
4. Delete the `/imagebuilder/samples/<os>-latest-ssm-agent` SSM parameter - the service writes it, so it isn't deleted with the stack.
