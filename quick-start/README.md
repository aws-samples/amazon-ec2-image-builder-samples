# EC2 Image Builder quick start

The smallest complete Image Builder pipeline you can deploy as infrastructure as code, twice: once as a single CloudFormation template ([`cloudformation/quick-start.yml`](cloudformation/quick-start.yml)) and once as a CDK TypeScript app on the `@aws-cdk/aws-imagebuilder-alpha` L2 constructs ([`cdk/`](cdk)). Both build the same thing - an Amazon Linux 2023 AMI with OS updates applied and a small build-metadata file baked in at `/opt/quick-start/build-info.txt` - and both publish each build's AMI ID to an SSM parameter for downstream consumers. If this is your first Image Builder pipeline, start here.

The two variants use distinct resource names (`quick-start-cfn` and `quick-start-cdk`), so you can deploy both side by side to compare them.

## How the pieces relate

An image pipeline is five resources wired together:

- **Component** - a YAML document of build and test steps (shell commands, file operations, reboots). This sample's component writes the build-info file in its `build` phase, checks it on the build instance in `validate`, and checks it again in `test` - which runs on a fresh instance launched from the output AMI, proving the file actually made it into the image.
- **Image recipe** - a base image plus an ordered list of components. This sample starts from the Amazon-managed AL2023 image and runs the managed `update-linux` component, then the custom one.
- **Infrastructure configuration** - how the temporary build instance launches: instance type, instance profile, logging, and (optionally) VPC placement. This sample uses your account's default VPC, so there's nothing network-related to configure.
- **Distribution configuration** - what happens to the output AMI. This sample publishes its ID to an SSM parameter.
- **Image pipeline** - ties the four together and owns scheduling.

A build run launches an EC2 instance from the base image, executes each component's `build` and `validate` phases over Systems Manager, snapshots the instance into an AMI, launches a second instance from that AMI to run `test` phases, then distributes.

## Versioning without manual bumps

Image Builder resources are versioned, and a name + version pair can only exist once - so a changed recipe with a fixed version fails to redeploy. The `x` wildcard handles this without manual version bumps:

- The recipe's version is `1.0.x`. The `x` auto-increments the build version each time the recipe changes, so template updates deploy without touching the version.
- The component keeps a fixed version, `1.0.0`. Components don't accept wildcards; instead the service increments the build number behind the same version (`1.0.0/1`, `1.0.0/2`, ...) when the document changes.
- References to Amazon-managed images and components use `x.x.x`, which resolves to the latest version at build time - each build starts from the current AL2023 base release and the current `update-linux` component without any template change.

See [Caveats](#caveats) for when you would still pin versions.

## Prerequisites

- An AWS account and the AWS CLI configured with permissions to create IAM roles, S3 buckets, CloudWatch log groups, and Image Builder resources.
- A default VPC in the target region. The build instance launches there; to use your own network instead, set a subnet and security groups (the template comments and the CDK construct's `vpc`/`subnetSelection` props show where).
- CDK variant only: Node.js 20+, npm, and a [CDK-bootstrapped](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) account and region.

## Deploy

### CloudFormation

```shell
aws cloudformation deploy \
  --stack-name imagebuilder-quick-start \
  --template-file cloudformation/quick-start.yml \
  --capabilities CAPABILITY_IAM
```

For an arm64/Graviton image, add `--parameter-overrides Architecture=arm64` - the one parameter switches the parent image and the build instance type (t4g.medium instead of t3.medium) together.

### CDK

```shell
cd cdk
npm install
npx cdk deploy
```

For arm64/Graviton: `npx cdk deploy -c architecture=arm64`.

The app doesn't pin an account or region, so `npx cdk synth` works without credentials and `npx cdk deploy` targets your CLI's default account and region. `npm test` runs jest assertions against the synthesized template.

## Run the pipeline

Deploying creates the pipeline but doesn't build anything. Start a build with the pipeline ARN from the stack outputs:

```shell
aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn <ImagePipelineArn output>
```

The build typically takes 15 to 30 minutes. Watch it in the Image Builder console (Image pipelines -> quick-start-cfn or quick-start-cdk), or poll:

```shell
aws imagebuilder list-image-pipeline-images --image-pipeline-arn <ImagePipelineArn output>
```

The pipeline in this sample has no schedule, so it only builds on demand. The CloudFormation template includes a commented-out weekly schedule whose start condition skips runs when nothing changed (no new base image release or component version), so a schedule doesn't rebuild identical images.

### Building at deploy time instead

If you want the deployment itself to produce an AMI, add an `AWS::ImageBuilder::Image` resource with `ImagePipelineExecutionSettings` referencing the pipeline. The deploy then waits for the build to finish (typically 15 to 30 minutes), and because the settings include `OnUpdate`, any later deployment that changes the pipeline's configuration rebuilds the image while no-op deployments don't. The [CDK/Linux/hello-world](../CDK/Linux/hello-world) sample implements this behind its `runPipelineOnDeploy` flag.

Which to pick:

- **Pipeline you run or schedule** (this sample): the image has a maintenance lifecycle - you rebuild on a cadence, on demand, or when dependencies update, and deployments stay fast because they never wait on a build.
- **One-shot `Image` resource**: the AMI is a build artifact of the stack - you want it to exist the moment the deploy completes, and you accept the longer deployment.

## Use the output AMI

After each successful build, the distribution configuration writes the new AMI ID to an SSM parameter - `/imagebuilder/quick-start-cfn/latest-ami` or `/imagebuilder/quick-start-cdk/latest-ami` (also in the stack outputs). That parameter is the handoff to everything downstream:

```shell
aws ssm get-parameter \
  --name /imagebuilder/quick-start-cfn/latest-ami \
  --query Parameter.Value --output text
```

- **Launch templates** can reference it directly: `"ImageId": "resolve:ssm:/imagebuilder/quick-start-cfn/latest-ami"`.
- **Other CloudFormation stacks** can consume it through a parameter of type `AWS::SSM::Parameter::Value<AWS::EC2::Image::Id>`.

The parameter uses the `aws:ec2:image` data type, so SSM validates that the value is a real AMI ID in the region before accepting it. The `/imagebuilder/` path prefix is required: the Image Builder service-linked role that writes the parameter only has `ssm:PutParameter` on that path, so a parameter name outside it fails distribution.

## Test the result

1. Read the SSM parameter (above) - it holds an `ami-...` value after the first successful build.
2. Launch an instance from that AMI and check the baked-in file:

   ```shell
   cat /opt/quick-start/build-info.txt
   ```

   It contains the build timestamp and the OS release the build ran on.

The component's `test` phase already did this check on a fresh instance during the build, so a green build is itself evidence the customization landed.

## Costs

- The build instance (t3.medium, or t4g.medium for arm64) bills for the build duration, typically 15 to 30 minutes per run - the test instance for a few minutes more.
- Each output AMI's EBS snapshot bills monthly until you deregister the AMI and delete the snapshot.
- Logs are minor: the S3 build logs expire after 90 days and the CloudWatch log groups keep 7 days.

## Caveats

- **When you'd still pin versions.** Replace the `x` segments with explicit versions when you need reproducible builds for compliance or audit, when identical images must come out of multiple regions or accounts, or when you want to stage a base-image upgrade deliberately instead of picking up new AL2023 releases as they ship.

## Cleanup

Deleting the stack removes the pipeline, recipe, component, configurations, IAM resources, and log groups - but not what builds produced. In order:

Note: if a build ran recently, Image Builder can recreate the log groups shortly after stack deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.

1. Delete the Image Builder image build versions (this is the build history under the pipeline):

   ```shell
   aws imagebuilder delete-image --image-build-version-arn <arn>
   ```

2. Deregister the output AMIs and delete their EBS snapshots in the EC2 console (or `aws ec2 deregister-image` / `aws ec2 delete-snapshot`). Deleting the Image Builder resources does not remove them.
3. Delete the SSM parameter - it's written by the service, not the stack, so stack deletion leaves it behind:

   ```shell
   aws ssm delete-parameter --name /imagebuilder/quick-start-cfn/latest-ami   # or .../quick-start-cdk/latest-ami
   ```

4. Empty the log bucket, including all object versions and delete markers (the bucket is versioned), then delete the stack:

   ```shell
   aws cloudformation delete-stack --stack-name imagebuilder-quick-start
   ```

   For the CDK variant, `npx cdk destroy` after emptying the bucket.

## Common first-build failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| Build fails within minutes; the image's failure reason mentions `VPCIdNotSpecified` or "No default VPC" | The region has no default VPC and the infrastructure configuration doesn't set a subnet | Set a subnet and security groups in the infrastructure configuration (see the template comments / the construct's `vpc` prop), or create a new default VPC |
| The very first build fails with an invalid instance profile error | The IAM instance profile was created seconds before the build and hasn't propagated yet | Start the pipeline again - propagation usually completes within a minute |
| Build sits in `Building` for a long time, then fails with an SSM timeout ("SSM execution timed out" / the instance never registered with Systems Manager) | The build instance can't reach Systems Manager - typically a private subnet without internet egress or VPC endpoints | Build in a subnet with a route to the internet, or add SSM, EC2 messages, and S3 VPC endpoints to the build subnet |
