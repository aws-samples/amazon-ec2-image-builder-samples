# Approve every AMI before it ships

By default, distribution runs as soon as tests pass - the AMI is copied, shared, and published before a human ever sees it. This sample moves that release behind a gate: a custom distribution workflow holds the fully built and tested image, notifies an SNS topic, and only distributes - a copy to a second region, an optional launch-permission grant, and SSM parameters with each region's AMI ID - after an explicit approval. Everything lives in one CloudFormation template: [gated-distribution.yml](gated-distribution.yml).

The [approval-gate sample](../approval-gate/) gates image *creation* - the build instance pauses mid-build for inspection. This one gates *release*: the image already exists and passed its tests, and nothing is running while it waits, so approval can take its time without billing an instance.

## The distribution stage is a workflow too

An image moves through three stages - build, test, distribution - and each runs a workflow of the matching type. Build and test workflows are the familiar ones; the distribution stage also accepts a custom workflow (exactly one, alongside one build and any number of test workflows). Without one, the service distributes through the pipeline's distribution configuration on its own. Amazon also publishes a managed `distribute-image` workflow (`aws imagebuilder list-workflows --owner Amazon` lists it) - a three-step chain of the distribution actions below, with no gate; this sample's workflow is that chain plus the approval in front.

Three AMI step actions exist only in distribution workflows (container images have their own, `DistributeContainerImage`), and they chain:

1. `DistributeImage` copies the AMI. Its `distributions` input is the per-region plan - names, tags, target accounts, KMS keys. The input is optional: provide it and it takes priority over the attached distribution configuration; omit it and the step falls back to that configuration.
2. `ModifyImageAttributes` grants launch permissions - sharing lives here, not in `DistributeImage`.
3. `ApplyImageConfigurations` handles the rest of the release: launch templates, SSM parameters, License Manager, S3 export, Fast Launch.

The second and third take `distributedImages.$` - the first step's per-region output - as their required input, so each acts on exactly the copies that succeeded. Anything else a workflow can do works in the distribution stage as well: this sample's gate is a plain `WaitForAction` step, the same action the approval-gate sample uses at build time. Only component execution and scan-findings collection are off limits - those belong to the build and test stages.

## How the gate works

1. The pipeline runs the Amazon-managed `build-image` and `test-image` workflows, then the custom distribution workflow.
2. The workflow's first step is `WaitForAction`: it publishes the approval request to the topic - carrying the image ARN, the step execution ID, and the tested AMI's ID in the payload - and pauses. The image shows `DISTRIBUTING`; the AMI exists only in the build region - without its release tag, unshared, and unpublished.
3. The approver responds:

```shell
aws imagebuilder send-workflow-step-action \
  --step-execution-id <from the notification or list-workflow-step-executions> \
  --image-build-version-arn <the build's ARN> \
  --action RESUME \
  --reason "Ship it"
```

`RESUME` releases the image: the AMI is copied to the second region, tagged, optionally shared, and each region's AMI ID lands in an SSM parameter. `STOP` fails the build with nothing distributed. No response and the step times out (3 days by default, up to 7 via `timeoutSeconds`) - the build fails, and nothing was released. The console offers the same controls on the Images page's **Waiting for action** tab.

Details worth knowing:

- **The wait costs no instance time.** Build and test instances are long terminated by the time the gate is reached - the pause bills nothing beyond the AMI's snapshot storage.
- **The build-region AMI is named before the workflow runs.** The image creation at the end of the build stage names the output AMI from the attached distribution configuration's build-region entry (or a default when there is none). The workflow's inline `distributions` name only the copies it makes - which is why this template keeps a name on the attached configuration too.
- **Per-region results are step outputs.** `DistributeImage` reports each region's AMI ID, status, and timing in its `distributedImages` output - read it with `get-workflow-step-execution`. The build-region entry completes immediately (that AMI already exists; no copy is made).
- **Failed steps don't undo copies.** Distribution actions have no rollback: if a later step fails, copies that already completed stay in place.
- **The reason travels.** The approver's RESUME reason is readable by later steps as `$.stepOutputs.ApproveRelease.reason`; a STOP reason lands in the failed image's state message. CloudTrail records each response with the caller.
- **Approval is an IAM permission.** Scope `imagebuilder:SendWorkflowStepAction` to your approver group if the gate needs real separation of duties - the [approval-gate sample](../approval-gate/) covers the response flow in more depth.

## Staged rollouts

The gate doesn't have to come first. A distribution workflow can carry several `DistributeImage` steps - copy to a staging region, `WaitForAction`, then copy everywhere else - chaining each copy step's own `distributedImages` output into its follow-up actions. The same `send-workflow-step-action` flow drives every gate; only the step order changes.

## Cost

- Each build bills a t3.medium build instance, then a t3.medium test instance - about 15 minutes of combined instance time with this template's minimal component. The approval wait itself bills no instance time.
- Each AMI's snapshots bill in BOTH regions until you deregister the AMIs and delete the snapshots.
- The KMS key bills at the standard monthly key rate until deleted.

## Prerequisites

- A default VPC in the deployment region (or set `SubnetId`/`SecurityGroupIds` on the infrastructure configuration).
- AWS CLI with permissions to deploy CloudFormation stacks with IAM resources.

## Deploy

```shell
aws cloudformation deploy \
  --template-file gated-distribution.yml \
  --stack-name gated-distribution \
  --parameter-overrides NotificationEmail=you@example.com \
  --capabilities CAPABILITY_IAM
```

Confirm the SNS subscription from the email before starting a build, or the approval requests never arrive. `SecondRegion` defaults to us-east-1 and must differ from the deployment region - the stack refuses to deploy otherwise, so override it when deploying in us-east-1. To also share the second-region copy with another account, add `LaunchPermissionAccountId=<account id>` - the workflow's conditional skips the sharing step when it's empty, and the grantee can read the image contents, so share only with accounts you trust.

## Testing

1. Start a build: `aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <ImagePipelineArn output>`.
2. After the build and test stages (about 10 minutes with fresh base images), the approval request arrives on the topic and the image sits in `DISTRIBUTING` with the workflow step `WAITING`:

```shell
aws imagebuilder list-workflow-executions --image-build-version-arn <build arn>
aws imagebuilder list-workflow-step-executions --workflow-execution-id <the DISTRIBUTION entry's ID>
```

3. Confirm nothing has shipped yet: the AMI exists in the build region only, and `aws ssm get-parameter --name /imagebuilder/gated-distribution/ami` returns `ParameterNotFound` in both regions.
4. Approve with `send-workflow-step-action --action RESUME` (above). The remaining steps run - the cross-region copy takes a few minutes - and the build reaches `AVAILABLE`.
5. Verify the release:

```shell
aws imagebuilder get-workflow-step-execution --step-execution-id <the DistributeCopies ID> --query outputs
aws ssm get-parameter --name /imagebuilder/gated-distribution/ami --query Parameter.Value
aws ssm get-parameter --name /imagebuilder/gated-distribution/ami --query Parameter.Value --region <SecondRegion>
```

The step outputs list both regions' AMI IDs with per-region status, and each parameter holds its own region's ID. The second-region copy carries the `Release: approved` tag and the `gated-distribution-<timestamp>` name from the workflow's inline distributions.

6. Run a second build and respond with `--action STOP`: the workflow ends, the build fails with the stop reason in its state message, and nothing was distributed - the same checks from step 3 still hold. The build-region AMI from the build stage still exists - a rejected release keeps the evidence, and cleanup covers it like any other build.

## Cleanup

1. Delete the image build versions (`aws imagebuilder delete-image --image-build-version-arn <arn>` per build).
2. Deregister the `gated-distribution-*` AMIs and delete their snapshots - in BOTH regions.
3. Delete the SSM parameters in both regions: `aws ssm delete-parameter --name /imagebuilder/gated-distribution/ami`, then the same command with `--region <SecondRegion>`.
4. Delete the stack: `aws cloudformation delete-stack --stack-name gated-distribution`. The KMS key enters its 7-day deletion window.
5. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
