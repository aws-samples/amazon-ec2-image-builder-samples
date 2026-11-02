# Build on a running instance from an Auto Scaling group

By default, Image Builder launches a new EC2 instance for every build and waits for it to boot and register with Systems Manager. With a **parent instance**, Image Builder takes an instance that's already running in an Amazon EC2 Auto Scaling group instead, so builds skip the launch. This sample keeps a small pool of ready Amazon Linux 2023 instances in a group and points an image pipeline at it.

It comes twice: as a CloudFormation template ([`cloudformation/parent-instance-asg.yml`](cloudformation/parent-instance-asg.yml)) and as a CDK TypeScript app ([`cdk/`](cdk)). Both deploy the same resources under distinct names (`parent-instance-asg-cfn` and `parent-instance-asg-cdk`), so you can deploy them side by side.

It takes three pieces: `ParentInstance` on the **infrastructure configuration**, an **execution role** that can take instances from the group, and an **instance profile** in the group's **launch template**. For the full reference, see [Build on an instance from an Auto Scaling group](https://docs.aws.amazon.com/imagebuilder/latest/userguide/infra-config-parent-instance.html) in the EC2 Image Builder User Guide.

## How it works

At the start of each build, Image Builder picks a random instance in the group that's `InService`, online in Systems Manager, and the same platform and architecture as the image. It tags the instance and detaches it without lowering the desired capacity, so the group launches a replacement. After the build, Image Builder terminates the instance like one it launched.

The build instance keeps everything the group launched it with - instance type, instance profile, network, volumes, and AMI - so the **launch template** decides what the build runs on, and the recipe's parent image is only used to match the platform and architecture. The `Architecture` parameter (CDK: `-c architecture=`) switches the launch template's AMI, the instance type, and the parent image together. Test instances launch as usual from the output AMI with the infrastructure configuration's settings.

A few things in the template are easy to miss:

- The instance profile has both `EC2InstanceProfileForImageBuilder` and `AmazonSSMManagedInstanceCore`. The first has no Systems Manager permissions - without the second, the SSM Agent never comes online and Image Builder never takes the instance.
- The group's max size is twice `PoolSize`, with an instance maintenance policy and a rolling update policy, so lifetime replacements, instance refreshes, and stack updates launch the new instance before terminating the old one and the pool doesn't empty.
- The output AMI is encrypted with the launch template volume's key - the account's default EBS key here - not with encryption settings in the recipe. If that's the AWS managed key, other accounts can't use the AMI, so to share it, set a customer managed key in the launch template - [distribution/cross-account-amis](../distribution/cross-account-amis/) shows the key setup.

Because the image is built from a pool instance as it is, the pool is part of your image supply chain. Anyone who can start Session Manager sessions or run commands on pool instances, edit the launch template, or attach their own instance to the group (`autoscaling:AttachInstances`) can change what goes into the next image - limit those permissions to the people who own the pipeline.

## Execution role permissions

The service-linked role has no Auto Scaling permissions, so a pipeline that uses a parent instance needs an execution role. On top of `EC2ImageBuilderExecutionPolicy`, the role needs:

|Permission|Scope in this sample|Used to|
|---|---|---|
|`autoscaling:DescribeAutoScalingGroups`|`*` (no resource-level permissions)|Find the group's `InService` instances|
|`ec2:CreateTags`, `ec2:DeleteTags`|Instances tagged `aws:autoscaling:groupName` = the pool|Tag the instance before the detach, and remove the tags if the detach fails|
|`autoscaling:DetachInstances`|The pool's group ARN|Take the instance out of the group|

Detaching removes the `aws:autoscaling:groupName` tag, which is why Image Builder tags first - and why the tag permissions can be scoped to the pool. In commercial Regions you can also create this role from the `EC2ImageBuilderParentInstanceASGRoleTemplate` role template; this sample defines it in the template so it doesn't depend on that.

## Sizing and keeping the pool current

- **`PoolSize`** should cover the builds you start at the same time. With a pool of 1, a second build that starts right after the first waits for the replacement.
- **`CapacityWaitTimeoutSeconds`** decides what happens when the pool is empty. Image Builder keeps checking the group and fails the build if no instance is ready in time - it doesn't fall back to launching its own. With 0, the build fails right away.
- **AMI.** The launch template's `resolve:ssm:` image ID is resolved by EC2 at each launch, so every replacement starts from the current AL2023 AMI. An idle instance keeps the AMI it launched with, so the group replaces any instance older than `MaxInstanceLifetimeSeconds` (default 7 days), and the recipe's `update-linux` component patches each build instance first.
- **Launch template changes.** When a stack update changes the launch template - including the `Architecture` parameter - CloudFormation replaces the pool's instances with a rolling update. Changes made outside the stack need an [instance refresh](https://docs.aws.amazon.com/autoscaling/ec2/userguide/asg-instance-refresh.html).

## Migrating from accelerated-build-asg

The earlier [CDK/Linux/accelerated-build-asg](../CDK/Linux/accelerated-build-asg/) sample built this pattern before Image Builder supported it: a custom build workflow with `WaitForAction` steps, a Builder Lambda function that picks, locks, detaches, and tags an instance, a Termination function, an AMI Update function, and a DynamoDB lock table. Image Builder does the picking, locking, detaching, and terminating itself. Make these changes in the CDK app and redeploy, rather than deleting resources by hand:

1. Give the pipeline's execution role the permissions above.
2. Switch the launch template to `ec2.MachineImage.resolveSsmParameterAtLaunch(...)` and set `maxInstanceLifetime` on the group. Its AMI is otherwise resolved once at deploy time, and the AMI Update function you remove in step 4 is what moves it forward.
3. Add `ParentInstance` to the infrastructure configuration, pointing at the group, and remove the custom workflow from the pipeline so it runs the managed build workflow.
4. Remove the custom workflow resource, the three Lambda functions, the EventBridge rule, the CloudWatch alarms, the lock table, and the dead-letter queue. Redeploy, then start an [instance refresh](https://docs.aws.amazon.com/autoscaling/ec2/userguide/asg-instance-refresh.html) so the pool runs the current AMI.

## Cost

- Pool instances run around the clock. Each t3.medium (or t4g.medium) instance and its 30 GiB gp3 volume bill whether or not a build is running, so keep `PoolSize` at the number of builds you run at the same time.
- During a build, the taken instance and its replacement both run, and the test instance runs for the test stage - 2 to 5 minutes in validation.
- The pipeline has no schedule; builds run only when you start them.
- If you set `TerminateInstanceOnCompletion` to false, each kept build instance stays stopped and bills for its volume until you terminate it. The stack doesn't track these instances.
- Each output AMI's EBS snapshot bills monthly until you deregister the AMI and delete the snapshot.

## Prerequisites

- An AWS account and the AWS CLI configured with permissions to create IAM roles, launch templates, Auto Scaling groups, CloudWatch log groups, and Image Builder resources.
- A default VPC in the target Region, with default subnets in its first two Availability Zones. Pool and test instances use the VPC's default security group - by default it allows all outbound traffic and no inbound traffic from outside the group; if yours has been changed, set your own security group as below - and get public IPs to reach Systems Manager. To use your own subnets, replace `AvailabilityZones` with `VPCZoneIdentifier` on the group (CDK: `vpcZoneIdentifier`), set `SubnetId` and `SecurityGroupIds` on the infrastructure configuration for the test instance, and set a security group in the launch template. The subnets need a route to Systems Manager - internet egress or the VPC endpoints listed in [networking/private-vpc-builds](../networking/private-vpc-builds/).
- CDK variant only: Node.js 20+, npm, and a [CDK-bootstrapped](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) account and Region.

## Deploy

### CloudFormation

```shell
aws cloudformation deploy \
  --stack-name imagebuilder-parent-instance-asg \
  --template-file cloudformation/parent-instance-asg.yml \
  --capabilities CAPABILITY_IAM
```

|Parameter|Default|Description|
|---|---|---|
|`Architecture`|`x86_64`|`x86_64` (t3.medium) or `arm64` (t4g.medium). Switches the pool AMI, instance types, and parent image together.|
|`PoolSize`|`1`|Instances kept ready in the group, 1 to 4.|
|`CapacityWaitTimeoutSeconds`|`600`|How long a build waits for a ready instance, 0 to 3600.|
|`MaxInstanceLifetimeSeconds`|`604800`|Replace pool instances older than this: `86400` (1 day), `604800` (7 days), or `2592000` (30 days). `0` turns it off.|

For example: `--parameter-overrides PoolSize=2 CapacityWaitTimeoutSeconds=900`.

### CDK

```shell
cd cdk
npm install
npx cdk deploy
```

The same settings are context values: `npx cdk deploy -c architecture=arm64 -c poolSize=2 -c capacityWaitTimeoutSeconds=900 -c maxInstanceLifetimeSeconds=86400`. The CDK app accepts any `maxInstanceLifetimeSeconds` from 86400 to 31536000, or 0. It deploys the stack `ImageBuilderParentInstanceAsgStack`; `npx cdk synth` works without credentials, and `npm test` runs jest assertions against the synthesized template.

## Testing

Start a build with the pipeline from the stack outputs. For the CDK variant, set `STACK=ImageBuilderParentInstanceAsgStack` instead:

```shell
STACK=imagebuilder-parent-instance-asg
PIPELINE_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='ImagePipelineArn'].OutputValue" --output text)
IMAGE_ARN=$(aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn "$PIPELINE_ARN" --query imageBuildVersionArn --output text)
```

If the pool's instance isn't online in Systems Manager yet, the build waits for it. In validation (Amazon Linux 2023, t3.medium, us-west-2), the instance was ready by the time the deploy finished, the build stage took about 6 minutes, and the test stage 2 to 5 minutes. Check the state with:

```shell
aws imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" \
  --query image.state.status --output text
```

### Confirm the build used a pool instance

Once the build is running, its log stream - named after the image version, such as `1.0.0/2` - records the instance it took:

```shell
LOG_GROUP=$(aws cloudformation describe-stacks --stack-name "$STACK" \
  --query "Stacks[0].Outputs[?OutputKey=='BuildLogGroupName'].OutputValue" --output text)
aws logs filter-log-events --log-group-name "$LOG_GROUP" --log-stream-names "${IMAGE_ARN#*/*/}" \
  --filter-pattern '"from the Auto Scaling group"' \
  --query 'events[].message' --output text
```

Look for `Step LaunchBuildInstance: acquired instance i-... from the Auto Scaling group`. The same instance ID is in the outputs of the `LaunchBuildInstance` step, whose action is `LaunchInstance`:

```shell
WORKFLOW_ID=$(aws imagebuilder list-workflow-executions --image-build-version-arn "$IMAGE_ARN" \
  --query "workflowExecutions[?type=='BUILD'].workflowExecutionId" --output text)
aws imagebuilder list-workflow-step-executions --workflow-execution-id "$WORKFLOW_ID" \
  --query "steps[?action=='LaunchInstance'].outputs" --output text
```

## Common errors

The build's failure reason carries these messages.

|Failure message|Cause|Fix|
|---|---|---|
|`No instance became available in Auto Scaling group '...' within the capacity wait timeout.`|Every instance was taken, or the replacement didn't come online in time|Raise `PoolSize` or `CapacityWaitTimeoutSeconds`, or space out builds|
|`... InService but its SSM agent isn't online yet. If this continues, check the instance's instance profile and network access to SSM.`|The profile lacks `AmazonSSMManagedInstanceCore`, or the subnet has no route to Systems Manager|Fix the instance profile or the subnet's routing in the stack and update it - the update replaces the pool's instances|
|`... InService instance(s) checked can't build this image: it needs Linux x86_64, but ... Linux arm64.`|The pool's AMI and the recipe's parent image don't match|Use the same `Architecture` for both - in this sample one parameter sets both, and a stack update replaces the pool|
|`The execution role is not permitted to detach instances from Auto Scaling group '...' (autoscaling:DetachInstances).` (or `... to tag instances ...`, `... to describe Auto Scaling group ...`)|A missing permission, or a scope that doesn't match the group's name|Compare the role's inline policy with [Execution role permissions](#execution-role-permissions)|

## Cleanup

Deleting the stack removes the pipeline, recipe, configurations, launch template, group and its pool instances, IAM resources, and log groups - but not what builds produced. Wait for running builds to finish, or stop them with `aws imagebuilder cancel-image-creation`. Set `STACK` as in [Testing](#testing), then:

1. Delete each image build version, its AMI, and the AMI's snapshots:

   ```shell
   PIPELINE_ARN=$(aws cloudformation describe-stacks --stack-name "$STACK" \
     --query "Stacks[0].Outputs[?OutputKey=='ImagePipelineArn'].OutputValue" --output text)
   for IMAGE_ARN in $(aws imagebuilder list-image-pipeline-images --image-pipeline-arn "$PIPELINE_ARN" \
     --query 'imageSummaryList[].arn' --output text); do
     AMI_ID=$(aws imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" \
       --query 'image.outputResources.amis[0].image' --output text)
     aws imagebuilder delete-image --image-build-version-arn "$IMAGE_ARN"
     aws ec2 deregister-image --image-id "$AMI_ID" --delete-associated-snapshots
   done
   ```

   `--delete-associated-snapshots` needs a recent AWS CLI v2; with an older one, delete the snapshots separately (`aws ec2 delete-snapshot`). A failed build has no AMI, so its `deregister-image` call fails harmlessly.

2. If you set `TerminateInstanceOnCompletion` or `TerminateInstanceOnFailure` to false, terminate the kept build instances. They're detached from the group, so deleting the stack doesn't remove them.
3. Delete the stack:

   ```shell
   aws cloudformation delete-stack --stack-name "$STACK"
   ```

   For the CDK variant, `npx cdk destroy` from `cdk/`.

4. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
