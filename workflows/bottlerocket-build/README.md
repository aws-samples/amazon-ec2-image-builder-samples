# Build Bottlerocket AMIs with Image Builder

[Bottlerocket](https://bottlerocket.dev/) is a Linux distribution for running containers. It has no package manager and no shell on the host, and its root filesystem is read-only - so there's nothing for Image Builder components to customize on a running Bottlerocket instance. You change a Bottlerocket image by building it from source, with a different variant definition. This sample runs that build - the same `cargo make` build you'd run on your own workstation - as the build stage of an Image Builder pipeline, then puts the result through a Bottlerocket-aware test stage and distribution like any other Image Builder output, and [lifecycle policies](../../lifecycle/) manage it the same way. Everything lives in one CloudFormation template ([bottlerocket-build.yml](bottlerocket-build.yml)), plus an optional overlay ([bottlerocket/](bottlerocket/)) that defines a custom variant.

A custom build workflow runs the Bottlerocket build: it builds the disk images, writes them into EBS snapshots through the EBS direct APIs, and registers an AMI from those snapshots. The workflow then hands the AMI's ID to the service through its `ImageId` output.

## How the service adopts a Bottlerocket AMI

A build workflow tells the service which AMI it produced through a workflow output named `ImageId`. Bottlerocket images are defined by variants - `aws-ecs-2` for Amazon ECS, `aws-k8s-1.35` for Amazon EKS, and so on. A variant is a `variants/<name>/Cargo.toml` that lists the packages, kernel parameters, and image features of one image. The Bottlerocket build tool, [Twoliter](https://github.com/bottlerocket-os/twoliter), pulls a build SDK and pre-built package collections (kits) from Amazon ECR Public, assembles the variant into a disk image inside containers, and registers it as an AMI. The custom build workflow runs that build and skips `CreateImage` entirely:

1. `LaunchInstance` starts an Amazon Linux 2023 build instance. This is where the build runs, not what the AMI is made from.
2. `ExecuteComponents` runs the recipe's two components:
   - The tools component installs Docker, git, and Rust from the Amazon Linux repositories, and a pinned cargo-make release from crates.io with its lockfile.
   - The build component checks out the `v<release>` tag of [bottlerocket-os/bottlerocket](https://github.com/bottlerocket-os/bottlerocket), copies the overlay over it, and then:
     1. Builds the variant into disk images - an OS image and a data image - with `cargo make`.
     2. Writes each disk image into an EBS snapshot through the EBS direct APIs and registers an AMI from the snapshots, with `cargo make ami`. No extra instance or volume is involved.
     3. Tags the AMI and its snapshots `CreatedBy: EC2 Image Builder` and writes the AMI ID to a file.
3. A `RunCommand` step reads the file back, and the workflow's `ImageId` output hands the AMI to the service. The test stage, the distribution configuration, and lifecycle policies then operate on it like any other Image Builder output.

The build instance is x86_64 for both architectures - for `Arch=aarch64`, the build SDK cross-compiles, so `BuildInstanceType` stays an x86_64 type and `TestInstanceType` must match `Arch`. The recipe's parent image is the build host, so the pipeline turns off enhanced image metadata - it would describe the Amazon Linux build host rather than the Bottlerocket image.

One quirk to expect: the image's `outputResources` in `get-image` reports a service-generated name (`<stack name>-<build date>`), while the AMI keeps the name the build gave it. The AMI ID is the same in both places.

## How the test works

The test stage boots the new AMI, but the Amazon-managed `test-image` workflow can't run there: it runs components on the instance, and Bottlerocket has no host shell for them. Bottlerocket instead runs the SSM agent in its control container, which comes with `apiclient`, the client for the Bottlerocket API that holds all host configuration. The custom test workflow uses that:

1. `LaunchInstance` boots the AMI and waits for SSM. The instance type is a workflow parameter: `TestInstanceType`, or t3.small for x86_64 and t4g.small for aarch64 when it's empty. The step sets `userDataOverride` to TOML settings - without it, `LaunchInstance` passes the shell script it uses for Linux instances, Bottlerocket fails to parse it as TOML, stops configuring itself, and never starts its SSM agent.
2. `RunCommand` checks that `apiclient get os` reports the variant and architecture the pipeline built and that the control container is enabled.
3. `TerminateInstance` cleans up.

Extend the `VerifyImage` step with whatever your image must prove - `apiclient get settings` returns the full configuration as JSON, and `grep -q panic=10 /proc/cmdline` would prove the custom variant's kernel parameter. Kubernetes test instances aren't joined to a cluster, so their kubelet doesn't start - the test checks the image, not cluster membership.

## Two instances, two roles

Each build involves two short-lived instances: the Amazon Linux 2023 build instance, and the test instance booted from the Bottlerocket AMI. Image Builder launches both from the same infrastructure configuration, so they share one instance profile - a split that's easy to miss when adapting the template:

- The **instance profile** is what the Bottlerocket build runs under, and what the Bottlerocket test instance boots with. On top of `EC2InstanceProfileForImageBuilder` and `AmazonSSMManagedInstanceCore`, it carries what each side needs:
  - Registration: the EBS direct APIs (`ebs:StartSnapshot`, `ebs:PutSnapshotBlock`, `ebs:CompleteSnapshot`), `ec2:RegisterImage`, and the describe calls - the build registers the AMI itself, so these sit on the instance profile rather than the execution role.
  - Tagging: `ec2:CreateTags` on images and snapshots, limited to the `CreatedBy` and `BottlerocketVariant` tag keys.
  - The overlay: read access to the configuration bucket's `bottlerocket/` prefix.
  - The test instance's boot: pull access to Bottlerocket's control-container repository in ECR and, for Kubernetes variants, `ec2:DescribeInstances`, which the settings generator calls before it finishes configuring the host.
- The **execution role** is what Image Builder uses to run the workflow steps. The `EC2ImageBuilderExecutionPolicy` managed policy covers everything this sample does, including the `RunCommand` steps - no additions needed.

The test instance holds the build permissions too, so only test images you'd trust with that role. Distribution's attribute changes and lifecycle's cleanup only touch images tagged `CreatedBy: EC2 Image Builder`, which is why the build component applies that tag to the AMI and its snapshots right after registration.

## What your own variant needs

Each stack builds one variant for one architecture. Resource names derive from the stack name (3-114 characters), so deploy one stack per image you want - they build in parallel.

| Use case | Deploy with |
|---|---|
| ECS variant | the defaults (`Variant=aws-ecs-2`, `Arch=x86_64`) |
| EKS variant | `Variant=aws-k8s-1.35` (or any `aws-k8s-*` variant the release ships) |
| Graviton (arm64) | `Arch=aarch64`, with any variant |
| Custom variant | `Variant=aws-ecs-2-custom`, plus the overlay upload (see [Deploy](#deploy)) |

To run the result on ECS or EKS, put the AMI ID in a launch template with your Bottlerocket TOML user data, and use that launch template from an Auto Scaling group, ECS capacity provider, or EKS node group.

For a custom variant, files in the overlay go at the paths they have in a Bottlerocket checkout:

```text
bottlerocket/
  customize.sh                  optional - runs at the checkout root after the copy
  variants/
    aws-ecs-2-custom/
      Cargo.toml                the variant definition
      amispec.toml              AMI properties for this variant
```

The build component copies everything under the configuration bucket's `bottlerocket/` prefix over the checkout, then runs `customize.sh` if it's there. The example defines `aws-ecs-2-custom`:

- `variants/aws-ecs-2-custom/Cargo.toml` is the release's `aws-ecs-2` definition with one change: the kernel parameter `panic=10` (reboot ten seconds after a kernel panic). Edit `included-packages`, `kernel-parameters`, or `image-features` the same way.
- `variants/aws-ecs-2-custom/amispec.toml` registers the AMI IMDSv2-only with gp3 volumes.
- `customize.sh` wires the new variant into the build the way you would by hand: it adds the variant to the top-level Cargo workspace, and to the `aws-ecs-2` subpackages in `packages/settings-defaults/settings-defaults.spec` and `packages/settings-plugins/settings-plugins.spec` - the image build resolves the settings packages by variant name and fails without a match. Each edit must apply exactly once, so an upstream format change fails the build instead of silently dropping the wiring. The custom variant reports a `-dirty` build ID, because these edits change files the release tag tracks.

A variant definition is tied to the release it was copied from - when you move `BottlerocketRelease`, re-copy the base variant from that release's tag and reapply your changes. See Twoliter's [custom variant notes](https://github.com/bottlerocket-os/twoliter/blob/develop/docs/design/custom-variant-considerations.md) for what else a variant can change.

Variants without their own `amispec.toml` would register with gp2 volumes and IMDSv1 allowed, so the build component writes one that requires IMDSv2 and uses gp3. A variant that ships its own keeps it.

## Updates and signing keys

Each build generates fresh Secure Boot keys and a fresh update-repository signing key on the build instance, and the instance terminates with them. That keeps the sample self-contained, and it has two consequences to plan for before production use:

- Images signed with throwaway keys can't take in-place updates from the public Bottlerocket update repository - `apiclient update check` fails signature verification. Roll out a new AMI by replacing instances (instance refresh, node group updates, Karpenter drift), which is the model an image pipeline produces anyway. For in-place updates, host your own update repository - see the Bottlerocket [publishing guide](https://github.com/bottlerocket-os/bottlerocket/blob/develop/PUBLISHING.md).
- The Secure Boot keys change with every build, so there's no stable key to enroll or verify against. For production images, keep the Secure Boot keys in AWS KMS rather than generating them per build - the Bottlerocket repository's [sbkeys](https://github.com/bottlerocket-os/bottlerocket/tree/develop/sbkeys) directory has the scripts, and `Infra.toml` at the checkout root is where Bottlerocket's tooling reads signing-key and repository settings from.

## What the build trusts

Everything below runs as root on the build instance:

- The `v<release>` tag on GitHub, checked out over HTTPS. The build doesn't verify the tag's signature; it logs the commit it built, so you can compare it with the release's verified tag on GitHub.
- Twoliter, installed as a binary pinned by SHA-256 in the checkout's `Makefile.toml` (Bottlerocket's tooling builds it from source instead if the binary install fails), and the SDK and kit images, pinned by digest in the checkout's `Twoliter.lock`.
- cargo-make from crates.io, pinned to a version and installed with its lockfile, and packages from the Amazon Linux repositories, which dnf verifies by signature. The parent image is the latest Amazon Linux 2023 version.
- The overlay from the configuration bucket. It's copied over the checkout before the build, so it can replace `Makefile.toml` and `Twoliter.lock` - the pins above hold only while you control who can write to the bucket.

All of it runs under the instance role. The role can register AMIs and tag images and snapshots `CreatedBy: EC2 Image Builder` - the tag lifecycle policies and the execution role act on - and through `AmazonSSMManagedInstanceCore` it can read Systems Manager parameters in the account. `ec2:RegisterImage` accepts any unencrypted snapshot in the Region, so a compromised input could register an image from another workload's snapshot, and with `LaunchPermissionAccountId` set, distribution would share it. Run the pipeline in an account dedicated to image builds, so the role can't reach data or AMIs it shouldn't.

## Cost

- Each build bills a `BuildInstanceType` instance (c7i.4xlarge by default) with a 100 GiB gp3 volume for the build stage - about 12 minutes per build, including a cold Bottlerocket build of about 6 minutes for either architecture - and a test instance (t3.small or t4g.small by default), plus the output AMI's two snapshots until you deregister it.
- Registration writes the snapshots through the [EBS direct APIs](https://aws.amazon.com/ebs/pricing/), which bill per request.
- With `SubnetId`, the build's downloads - several GB of SDK and kit images - go through your NAT gateway, which bills for data processed as well as by the hour.
- The pipeline has no schedule; builds run only when you start them.

## Prerequisites

- A default VPC in the deployment region, or a subnet with outbound internet access through a NAT gateway - pass it with `SubnetId` and `SecurityGroupId` (both together; the security group needs no inbound rules). Without them, the instances use the default VPC's default security group, which allows all outbound traffic and inbound traffic from other members of that group - pass a dedicated security group with no inbound rules to avoid that. Accounts with [VPC Block Public Access](https://docs.aws.amazon.com/vpc/latest/userguide/security-vpc-bpa.html) turned on for internet gateways need the NAT-gateway subnet: instances can't reach the internet - or the Systems Manager endpoints - through the internet gateway directly.
- Outbound internet access from the build instance: GitHub for the source, Amazon ECR Public for the build SDK and kits, crates.io for cargo-make and the build's Rust dependencies.
- AWS CLI with permissions to deploy CloudFormation stacks with IAM resources.
- Run the commands below from this directory (`workflows/bottlerocket-build/`).
- The default build instance type, c7i.4xlarge, isn't offered in every Region and Availability Zone - pick another x86_64 type with `BuildInstanceType` where it's missing. To list the Availability Zones that offer it: `aws ec2 describe-instance-type-offerings --location-type availability-zone --filters Name=instance-type,Values=c7i.4xlarge --query 'InstanceTypeOfferings[].Location' --output text`.
- The build writes the AMI's snapshots through the EBS direct APIs without requesting encryption, so they're encrypted only when your account has [EBS encryption by default](https://docs.aws.amazon.com/ebs/latest/userguide/encryption-by-default.html) turned on - turn it on to keep the images encrypted at rest. With a customer managed key as the default, the instance role also needs to use that key. To share the AMI with `LaunchPermissionAccountId`, use a customer managed key the other account can use - AMIs whose snapshots use the AWS managed key can't be [shared with other accounts](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/sharingamis-explicit.html).

Bottlerocket is distributed under the Apache License 2.0 or the MIT license; the overlay's variant files are derived from Bottlerocket's and carry its MIT license notice in [THIRD-PARTY-LICENSES](THIRD-PARTY-LICENSES). NVIDIA variants need extra license configuration - see the Bottlerocket [build documentation](https://github.com/bottlerocket-os/bottlerocket/blob/develop/BUILDING.md).

## Deploy

```shell
aws cloudformation deploy \
  --template-file bottlerocket-build.yml \
  --stack-name bottlerocket-build \
  --capabilities CAPABILITY_IAM
```

For another use case, add `--parameter-overrides` with the values from [What your own variant needs](#what-your-own-variant-needs), and a different `--stack-name` to build it next to the first. For the custom variant, deploy, then upload the overlay - the next build picks it up:

```shell
aws cloudformation deploy \
  --template-file bottlerocket-build.yml \
  --stack-name bottlerocket-custom \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides Variant=aws-ecs-2-custom
BUCKET=$(aws cloudformation describe-stacks --stack-name bottlerocket-custom \
  --query "Stacks[0].Outputs[?OutputKey=='ConfigBucketName'].OutputValue" --output text)
aws s3 sync bottlerocket/ "s3://${BUCKET}/bottlerocket/" --delete
```

`sync --delete` removes overlay files you've deleted locally, so a stale `customize.sh` can't keep running. The overlay runs as root on the build instance under the instance role - control write access to this bucket. To let another account launch the finished AMI, deploy with `LaunchPermissionAccountId=<account id>` - the grantee can read the image contents, so share only with accounts you trust, and only from an account where the build role can't reach other workloads' snapshots (see [What the build trusts](#what-the-build-trusts)).

## Testing

The commands use the default stack name - substitute yours for the other use cases.

1. Start a build:

```shell
PIPELINE=$(aws cloudformation describe-stacks --stack-name bottlerocket-build \
  --query "Stacks[0].Outputs[?OutputKey=='ImagePipelineArn'].OutputValue" --output text)
aws imagebuilder start-image-pipeline-execution --image-pipeline-arn "${PIPELINE}"
```

2. Watch the workflows. The Bottlerocket build lives inside the build workflow's `ApplyBuildComponents` step - its detailed log streams to the `/aws/imagebuilder/<stack name>` log group:

```shell
aws imagebuilder list-workflow-executions --image-build-version-arn <build arn from step 1>
aws imagebuilder list-workflow-step-executions --workflow-execution-id <the BUILD entry's ID>
```

3. When the image reaches `AVAILABLE` (about 16-18 minutes end to end, including the test and distribution), confirm the adoption - the output AMI is the one the Bottlerocket build registered:

```shell
aws imagebuilder get-image --image-build-version-arn <build arn> \
  --query 'image.outputResources.amis'
aws ec2 describe-images --image-ids <that AMI ID> \
  --query 'Images[0].{name:Name,arch:Architecture,imds:ImdsSupport,tags:Tags}'
```

The first command reports the AMI ID with a service-generated name; the second shows the same AMI under its `bottlerocket-<variant>-<arch>-v<release>-<timestamp>` name, IMDSv2-only, with the `CreatedBy`, `BottlerocketVariant`, and `BuiltWith` tags.

4. Read what the test found. The `VerifyImage` step's output carries the `apiclient get os` response from the test instance:

```shell
aws imagebuilder list-workflow-step-executions --workflow-execution-id <the TEST entry's ID> \
  --query "steps[?name=='VerifyImage'].stepExecutionId"
aws imagebuilder get-workflow-step-execution --step-execution-id <that ID> --query outputs
```

5. If you deployed with `LaunchPermissionAccountId`, confirm the grant landed:

```shell
aws ec2 describe-image-attribute --image-id <that AMI ID> --attribute launchPermission
```

## Common errors

| Error | Cause | Fix |
|---|---|---|
| `The instance never registered with Systems Manager` on `LaunchTestInstance`, and the test instance's console shows `Error parsing TOML user data` | The test launch used the default user data - a shell script - which Bottlerocket can't parse, so it never starts its SSM agent. | Keep `userDataOverride` with TOML settings on the test workflow's `LaunchInstance` step. |
| `The instance never registered with Systems Manager`, and the console shows `pull of ...bottlerocket-control... failed` with `not authorized to perform: ecr:GetAuthorizationToken` | The instance profile can't pull Bottlerocket's control container image, which runs the SSM agent. | Keep the `BottlerocketTestInstanceBoot` policy on the instance profile's role - see [Two instances, two roles](#two-instances-two-roles). |
| `The instance never registered with Systems Manager` for a Kubernetes variant, and the console repeats `EC2 DescribeInstances attempt failed, will retry: code=UnauthorizedOperation` | Kubernetes variants look up their own instance at boot to derive node settings and don't finish configuring until the call succeeds. | Keep `ec2:DescribeInstances` in the `BottlerocketTestInstanceBoot` policy. |
| `Invalid value '{{ instanceType }}' for InstanceType` | A workflow document referenced a parameter with component syntax. | Workflow documents reference parameters as `$.parameters.<name>` - with `.$` on the input name for a whole value, or `{{ $.parameters.<name> }}` inside a string. |
| `The instance never registered with Systems Manager` (or `Error while calling ssm:SendCommand: InvalidInstanceId`) on `LaunchBuildInstance`, and the console shows `SSM Agent unable to acquire credentials` ending in `dial tcp ...:443: i/o timeout` | The build instance can't reach the Systems Manager endpoint - for example, VPC Block Public Access blocks the internet gateway, or the subnet has no route out. | Deploy with `SubnetId` and `SecurityGroupId` for a subnet with a NAT gateway. |
| `LaunchBuildInstance` fails with `InsufficientInstanceCapacity` | The Availability Zone of the subnet has no capacity for `BuildInstanceType` at the moment. | Deploy with another x86_64 `BuildInstanceType`, such as c6i.4xlarge, or a subnet in another Availability Zone. |
| `aws cloudformation deploy` fails with `AWS::EarlyValidation::ResourceExistenceCheck`, and the change set's events name `/aws/imagebuilder/<stack name>` | A log group from an earlier stack with the same name still exists - late log deliveries can recreate it after the stack is deleted. | Delete the log group, as in [Cleanup](#cleanup) step 5, and deploy again. |
| `Signature threshold of 1 not met for role root (0 valid signatures)` from `apiclient update check` | The image was signed with keys generated during the build, not the keys the public update repository uses. | Expected - roll out new AMIs by replacing instances, or host your own update repository. |

## Cleanup

Repeat for each stack you deployed.

1. Delete the image build versions: `aws imagebuilder delete-image --image-build-version-arn <arn>` per build.
2. Deregister the AMIs and delete their snapshots. The build names them `bottlerocket-<variant>-<arch>-v<release>-<timestamp>`:

```shell
aws ec2 describe-images --owners self --filters "Name=tag-key,Values=BottlerocketVariant" \
  --query 'Images[].[ImageId,BlockDeviceMappings[].Ebs.SnapshotId]' --output text
```

Each AMI has two snapshots - the OS volume and the data volume. The build component adds the `BottlerocketVariant` tag right after registration, so this sweep also finds AMIs from builds that failed later: the build registers the AMI before the workflow hands it to the service. A build that failed between registering and tagging leaves an untagged AMI - filter on `"Name=name,Values=bottlerocket-*-v*"` (quoted, so zsh doesn't expand it) to find it, and check each result's name and creation date before deleting, since that filter also matches Bottlerocket AMIs you built another way.

3. Empty the configuration bucket:

```shell
BUCKET=$(aws cloudformation describe-stacks --stack-name bottlerocket-build \
  --query "Stacks[0].Outputs[?OutputKey=='ConfigBucketName'].OutputValue" --output text)
aws s3 rm "s3://${BUCKET}/bottlerocket/" --recursive
```

4. Delete the stack and wait for it to finish:

```shell
aws cloudformation delete-stack --stack-name bottlerocket-build
aws cloudformation wait stack-delete-complete --stack-name bottlerocket-build
```

5. If a build ran recently, late log deliveries can recreate the log groups after the stack is gone. Delete any that reappear before you redeploy the same stack name:

```shell
aws logs delete-log-group --log-group-name /aws/imagebuilder/bottlerocket-build
aws logs delete-log-group --log-group-name /aws/imagebuilder/pipeline/bottlerocket-build
```
