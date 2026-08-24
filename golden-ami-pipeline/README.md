# The golden-AMI loop, end to end

Most Image Builder samples stop when the AMI exists. This one closes the loop: a scheduled pipeline patches your base image monthly, distribution publishes the result to an SSM parameter and promotes it to the default launch template version, and an EventBridge-triggered Lambda rolls the Auto Scaling group onto the new AMI with an instance refresh. A second Lambda turns the service's image state-change events into readable one-line summaries.

Everything lives in one CloudFormation template: [golden-ami-pipeline.yml](golden-ami-pipeline.yml).

## The loop

1. **Base in**: the recipe's parent image is `ssm:/golden-ami/base-ami` - an SSM parameter this stack owns. Update the parameter, and the next run builds from the new base. (Stack updates re-resolve `SeedAmiId` and can reset this parameter to the seed value - re-apply a custom base after updating the stack.) Public parameters work in this position too, with no extra IAM - for example Canonical's Ubuntu 26.04 parameter (`/aws/service/canonical/ubuntu/server/26.04/stable/current/amd64/hvm/ebs-gp3/ami-id`, the seed default).
2. **Patch monthly**: the pipeline runs `update-linux` on a monthly cron. The start condition is `EXPRESSION_MATCH_ONLY` on purpose: the alternative (`EXPRESSION_MATCH_AND_DEPENDENCY_UPDATES_AVAILABLE`) skips runs when no *recipe dependency* changed - but OS packages update continuously without any recipe dependency changing, so a patch pipeline must build every cycle unconditionally. Note: in-place patching fits OSes with rolling package repositories, like the Ubuntu base here. Amazon Linux 2023 delivers OS updates as new immutable releases instead - for an AL2023 fleet, patch by moving the base parameter to each new AL2023 AMI.
3. **Publish**: distribution writes the AMI ID to `/golden-ami/latest-ami` and adds a launch template version with the new AMI, promoting it to the default.
4. **Roll the fleet**: when the image reaches `AVAILABLE`, an EventBridge rule fires the refresh Lambda, which starts an Auto Scaling instance refresh onto the default template version (if a refresh is already rolling, the Lambda skips - the next build catches up). New instances launch from the group's template version; the refresh replaces the running ones.
5. **Notify**: the same state-change events feed a formatter Lambda (a second target on the `AVAILABLE` rule, plus a `FAILED` rule), which fetches the build's details and publishes a one-line pass/fail summary with the AMI IDs to an encrypted topic (set the `NotificationEmail` parameter, or subscribe anything else).

## Design notes

- **The execution role holds exactly the deltas this setup needs**: `ssm:GetParameter` on the base parameter, `ssm:PutParameter` (plus `AddTagsToResource`) on the output one (both live under `/golden-ami/`, outside the `/imagebuilder/` paths the managed execution policy covers), and CloudWatch Logs writes for the custom log group paths.
- **Auto-disable**: the schedule carries an `AutoDisablePolicy` with `FailureCount: 3` - once consecutive failed scheduled runs pass that count, the service disables the pipeline instead of letting it fail forever unattended (the default count is 5; only scheduled runs count, and any success resets the counter). The service emits an `EC2 Image Builder Image Pipeline Automatically Disabled` event when it trips - fix the failure, then set the pipeline back to `ENABLED`.
- **The EventBridge patterns filter on this pipeline's image ARN prefix.** A pattern matching every image in the account would fire for other pipelines' images too - and for rules that *start* pipelines, that's how endless build loops happen. Scope patterns to the image name prefix.
- **CloudFormation can't set `$Default` as an Auto Scaling group's launch template version** (the API can). The group deploys pinned to the initial version; the refresh Lambda passes a `DesiredConfiguration` targeting `$Default`, which rolls the instances *and* updates the group to track `$Default` from then on. Rollback (auto or manual) isn't available while the group tracks `$Default` - a failed refresh needs a cancel and a fresh run. Note that a later stack update re-pins the group to a numbered version (the template resolves `DefaultVersionNumber` again) until the next refresh moves it back.

## Cost

- The demo fleet runs `FleetSize` t3.micro instances (default 1) continuously - that's the largest ongoing cost. Set `FleetSize=0` to keep the loop without a running fleet.
- Each monthly build bills a t3.medium for the build duration, typically 15 to 30 minutes, plus AMI snapshot storage that accumulates per build - lifecycle policies can clean old builds up automatically.
- The KMS key bills at the standard monthly key rate until deleted.

## Prerequisites

- A default VPC in the deployment region. Without one, set `SubnetId`/`SecurityGroupIds` on the infrastructure configuration AND give the fleet a `VPCZoneIdentifier` - the Auto Scaling group launches into the default VPC's subnets too.
- AWS CLI with permissions to deploy CloudFormation stacks with IAM resources.

## Deploy

```shell
aws cloudformation deploy \
  --template-file golden-ami-pipeline.yml \
  --stack-name golden-ami-pipeline \
  --parameter-overrides NotificationEmail=you@example.com \
  --capabilities CAPABILITY_IAM
```

Deploying creates the pipeline and the fleet but doesn't build anything - the schedule fires monthly, or start a run now:

```shell
aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn <ImagePipelineArn from the stack outputs>
```

## Testing

A build typically takes 15 to 30 minutes. When it completes, the loop's effects are all observable:

1. `/golden-ami/latest-ami` holds the new AMI ID: `aws ssm get-parameter --name /golden-ami/latest-ami --query Parameter.Value --output text`
2. The launch template gained a version and the default moved: `aws ec2 describe-launch-templates --launch-template-ids <LaunchTemplateId output> --query 'LaunchTemplates[0].DefaultVersionNumber'`
3. An instance refresh is rolling (or done): `aws autoscaling describe-instance-refreshes --auto-scaling-group-name golden-ami-fleet`
4. Once the refresh finishes, the fleet instance's `ImageId` is the new AMI.
5. The topic delivered a readable "Image build golden-ami-loop ...: AVAILABLE" message (email if subscribed; the formatter Lambda's log group always has it).

To test the base-swap path, point the base parameter somewhere else and run the pipeline again:

```shell
aws ssm put-parameter --name /golden-ami/base-ami --overwrite \
  --value "$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)"
```

## Cleanup

Deleting the stack removes the pipeline, fleet, topic, and Lambdas - but not what builds produced. In order:

1. Delete the Image Builder image build versions (`aws imagebuilder delete-image --image-build-version-arn <arn>` per build).
2. Deregister the `golden-ami-*` AMIs and delete their snapshots.
3. Delete `/golden-ami/latest-ami` (service-written, so it outlives the stack). The base parameter is a stack resource and goes with the stack.
4. If an instance refresh is still rolling, cancel it first (`aws autoscaling cancel-instance-refresh --auto-scaling-group-name golden-ami-fleet`) - deleting the group mid-refresh can hang stack deletion.
5. Delete the stack: `aws cloudformation delete-stack --stack-name golden-ami-pipeline`. The fleet drains as part of stack deletion; the KMS key enters its 7-day deletion window.
6. If a build ran recently, the custom log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
