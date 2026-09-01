# Build with Packer, manage with Image Builder

Teams with years of HashiCorp Packer templates face an either/or choice: keep Packer and build the surrounding automation themselves, or rewrite everything as components to get Image Builder's pipelines, testing, distribution, and lifecycle. This sample removes the choice - the pipeline runs your existing Packer template as its build stage, and everything after the build treats the Packer-made AMI like any other Image Builder output. Everything lives in one CloudFormation template ([packer-build.yml](packer-build.yml)), plus a small demo Packer template ([packer/al2023.pkr.hcl](packer/al2023.pkr.hcl)) that you replace with your own.

Packer is one example of the general pattern: any tool that produces an AMI - the [attestable AL2023 sample](../../CloudFormation/Linux/amazon-linux-2023-attestable-image/) does the same with kiwi-ng - can drive an Image Builder pipeline this way.

## How the service adopts an outside AMI

A build workflow tells the service which AMI it produced through a workflow output named `ImageId`. The Amazon-managed `build-image` workflow ends with exactly that output, fed from its `CreateImage` step - `aws imagebuilder list-workflows --owner Amazon` shows the current version, and `get-workflow` on it prints the document with the `outputs` section at the end. A custom build workflow can feed the same output from anywhere. This one skips `CreateImage` entirely:

1. `LaunchInstance` starts a normal build instance - this is where Packer will run, not what the AMI is made from.
2. `ExecuteComponents` runs the recipe's components: one installs a pinned Packer release, checksum-verified against the release's SHA256SUMS file (an integrity check on the download - the release site itself is the trust anchor, over TLS), and one downloads your Packer configuration from S3 and runs the build. Packer launches its own short-lived instance, provisions it, and registers the AMI - then the component tags that AMI and writes its ID to a file.
3. A `RunCommand` step reads the file back with a single `cat` - the step's `output` list carries the commands' stdout, and the workflow's `outputs` section exposes entry `[0]` as `ImageId`.
4. The service adopts that AMI as the image's output resource. The test stage boots it, the distribution configuration applies to it, and [lifecycle policies](../../lifecycle/) manage it - none of them know or care that `CreateImage` never ran.

One quirk to expect: the image's `outputResources` in `get-image` reports a service-generated name (`packer-build-<build date>`), while the actual AMI keeps the name your Packer template gave it. The AMI ID is the same in both places.

## Two instances, two roles

Each build involves two short-lived instances: the build instance (Packer's host, from the recipe's parent image - Amazon Linux 2023 here) and the instance Packer launches from your template's own source AMI. That split carries over to IAM, and mixing the two roles up is the classic failure mode:

- The **instance profile** is what Packer itself runs under - it needs the EC2 permissions from [Packer's amazon plugin documentation](https://developer.hashicorp.com/packer/integrations/hashicorp/amazon) (launch, snapshot, register, and the temporary key pair and security group churn), plus read access to the configuration bucket. The template carries the documented minimal set.
- The **execution role** is what Image Builder uses to run the workflow steps around Packer. The `EC2ImageBuilderExecutionPolicy` managed policy covers everything this sample does, including the `RunCommand` step - no additions needed.

The build works with an untagged AMI, but distribution's attribute changes and lifecycle's cleanup don't: their managed policies only touch images tagged `CreatedBy: EC2 Image Builder`. The run-packer component applies that tag to the AMI and its snapshots right after the build, so your template doesn't have to.

## What your own template needs

Nothing beyond two constraints - upload it in place of the demo template and the pipeline runs it unchanged. The integration reads the AMI ID from Packer's machine-readable output, and the component handles the tagging.

- **One AWS AMI per build, in the pipeline's region.** An Image Builder image maps to exactly one output AMI (the component takes the last artifact when a template produces several), and the service expects it where the pipeline runs - a template that builds in another region fails downstream rather than at the handoff.
- **The instance Packer launches must be reachable from the build instance.** The component exports `AWS_REGION`, `IMAGEBUILDER_SUBNET_ID`, and `IMAGEBUILDER_BUILD_IP` from the build instance's metadata before running Packer - the demo template's variables default to them, placing the Packer instance in the same subnet with SSH open to the build instance alone, over private IPs with no public exposure. A template with its own connectivity settings (a specific subnet, `ssh_interface = "session_manager"`, a public IP) works too, as long as the path it chooses actually exists in your account.

The demo template also stamps the AMI as IMDSv2-only (`imds_support = "v2.0"`) and requires IMDSv2 on the instances it builds with - worth keeping in your own templates.

Note that Packer needs outbound internet on the build instance: the install component downloads the release from `releases.hashicorp.com`, and `packer init` fetches plugins. Packer is distributed under the [Business Source License 1.1](https://github.com/hashicorp/packer/blob/main/LICENSE) - review it for your use; this sample downloads the binary at build time.

## Cost

- Each build bills a t3.medium build instance for the full Packer run, the t3.micro instance Packer launches (about 3 minutes with the demo template), and a t3.medium test instance - plus the output AMI's snapshot storage until you deregister it.
- The pipeline has no schedule; builds run only when you start them.

## Prerequisites

- A default VPC in the deployment region (or set `SubnetId` and `SecurityGroupIds` on the infrastructure configuration - both together).
- Outbound internet access from the build instance.
- AWS CLI with permissions to deploy CloudFormation stacks with IAM resources.

## Deploy

```shell
aws cloudformation deploy \
  --template-file packer-build.yml \
  --stack-name packer-build \
  --capabilities CAPABILITY_IAM
```

Then upload the Packer configuration - the demo template, or your own files in its place - under the bucket's `packer/` prefix:

```shell
BUCKET=$(aws cloudformation describe-stacks --stack-name packer-build \
  --query "Stacks[0].Outputs[?OutputKey=='ConfigBucketName'].OutputValue" --output text)
aws s3 cp packer/ "s3://${BUCKET}/packer/" --recursive
```

The run-packer component downloads everything under that prefix into one working directory, so scripts and var files referenced by your template belong there too. Control write access to this bucket: its contents execute on the build instance under the instance role. To let another account launch the finished AMI, deploy with `LaunchPermissionAccountId=<account id>` - the grantee can read the image contents, so share only with accounts you trust.

## Testing

1. Start a build:

```shell
PIPELINE=$(aws cloudformation describe-stacks --stack-name packer-build \
  --query "Stacks[0].Outputs[?OutputKey=='ImagePipelineArn'].OutputValue" --output text)
aws imagebuilder start-image-pipeline-execution --image-pipeline-arn "${PIPELINE}"
```

2. Watch the build workflow (the Packer run lives inside the `ApplyBuildComponents` step - its detailed log streams to the `/aws/imagebuilder/packer-build` log group):

```shell
aws imagebuilder list-workflow-executions --image-build-version-arn <build arn from step 1>
aws imagebuilder list-workflow-step-executions --workflow-execution-id <the BUILD entry's ID>
```

3. When the image reaches `AVAILABLE` (about 25 minutes), confirm the adoption - the output AMI is the one Packer registered:

```shell
aws imagebuilder get-image --image-build-version-arn <build arn> \
  --query 'image.outputResources.amis'
aws ec2 describe-images --image-ids <that AMI ID> \
  --query 'Images[0].{name:Name,tags:Tags}'
```

The first command reports the AMI ID with the service-generated name; the second shows the same AMI under its Packer-given `packer-build-<timestamp>` name, carrying the component's `CreatedBy` tag and distribution's `BuiltWith: packer` tag.

4. The passed test stage is the integration's proof: the `test-image` workflow's `COMPLETED` status means a test instance booted from the Packer-built AMI and the verify component found the marker file the Packer provisioner wrote.
5. If you deployed with `LaunchPermissionAccountId`, confirm the grant landed:

```shell
aws ec2 describe-image-attribute --image-id <that AMI ID> --attribute launchPermission
```

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `No $HOME environment variable found, required to set Config Directory` | Packer ran without `HOME` set - the case in components and RunCommand scripts, which run as root without a login environment. | Keep the `export HOME=/root` line when adapting the components. |
| `UnauthorizedOperation` on `ec2:ModifyImageAttribute` during distribution | The output AMI is missing the `CreatedBy: EC2 Image Builder` tag, so the execution policy refuses to touch it. | Keep the tagging step when adapting the run-packer component, or tag from your own tooling before the build workflow ends. |
| `Build workflow must have output named ImageId to build AMI.` | The build workflow has no `ImageId` output - the section is missing or the name differs. Rejected when the image is created, before anything runs. | Add the `outputs` section with the exact name `ImageId`. |
| `Invalid ImageId output value, must be AMI ID as a string.` | The output resolved to something that isn't a bare `ami-` ID - the `RunCommand` step printed more than the ID, so `output[0]` carries the extra text. | Make the step's final command print only the AMI ID; move everything else to a log file. |

## Cleanup

1. Delete the image build versions: `aws imagebuilder delete-image --image-build-version-arn <arn>` per build.
2. Deregister the AMIs and delete their snapshots. The demo template names them `packer-build-<timestamp>`:

```shell
aws ec2 describe-images --owners self --filters "Name=name,Values=packer-build-*" \
  --query 'Images[].[ImageId,BlockDeviceMappings[].Ebs.SnapshotId]' --output text
```

This sweep also covers builds that failed after Packer finished - Packer registers the AMI before the workflow hands it to the service, so a failed image can still have left one behind.

3. If a build failed mid-run, Packer's temporary resources may remain: check for security groups whose names start with `packer_`, and for any instance the interrupted run left behind, and delete the leftovers.
4. Empty the configuration bucket:

```shell
BUCKET=$(aws cloudformation describe-stacks --stack-name packer-build \
  --query "Stacks[0].Outputs[?OutputKey=='ConfigBucketName'].OutputValue" --output text)
aws s3 rm "s3://${BUCKET}/packer/" --recursive
```

5. Delete the stack: `aws cloudformation delete-stack --stack-name packer-build`.
6. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
