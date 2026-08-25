# Approve every image before it exists

A standard pipeline builds and registers the image in one motion. This sample inserts a gate: a custom build workflow pauses after components run, notifies an SNS topic, and waits for an explicit approval - with the build instance still running, so the approver can inspect exactly what's about to become the image. Everything lives in one CloudFormation template: [approval-gate.yml](approval-gate.yml).

## How the gate works

1. The pipeline runs the custom build workflow instead of the default: launch, run components, then a `WaitForAction` step named `ApproveImage`.
2. The step publishes an approval request to the topic and pauses. The message carries the image ARN and the step execution ID - the two arguments the response command needs - plus the workflow's payload text as `customPayload`. It also emits an `EC2 Image Builder Workflow Step Waiting` event on the default EventBridge bus, and can invoke a Lambda directly through its `lambdaFunctionName` input - the [accelerated-build-asg sample](../../CDK/Linux/accelerated-build-asg/) drives its whole build that way.
3. The approver responds:

```shell
aws imagebuilder send-workflow-step-action \
  --step-execution-id <from the notification or list-workflow-step-executions> \
  --image-build-version-arn <the build's ARN> \
  --action RESUME \
  --reason "Looks good"
```

The console offers the same controls: the Images page's **Waiting for action** tab lists every paused step, with resume and stop actions.

`RESUME` continues to `CreateImage`; `STOP` ends the workflow and the build fails. If nobody responds, the step times out - 3 days by default, up to 7 via `timeoutSeconds` on the step - and the build fails.

Details worth knowing:

- **The notification publishes as the execution role**, so the role carries `sns:Publish` and the topic key's `kms` grant - custom workflows require an execution role either way.
- **The `reason` travels.** Whatever the approver passes with `RESUME` is readable by later steps as `$.stepOutputs.ApproveImage.reason` - a lightweight channel for passing data into the rest of the workflow. It's free text from the approver, so don't splice it into shell commands.
- **Approval is an IAM permission.** Anyone who can call `imagebuilder:SendWorkflowStepAction` on the build can respond - scope that action to your approver group if the gate needs real separation of duties. CloudTrail records each response with the caller and reason.
- **The pipeline's `Workflows` property replaces the defaults.** This pipeline names only the build workflow, so the test stage is skipped. To keep tests, add a test workflow (Amazon's managed `test-image` or your own) alongside it.

## Cost

- The build bills a t3.medium for the build duration - including the whole time the workflow waits for approval, since the instance stays running. A forgotten build bills until the step times out (3 days by default).
- Each output AMI's snapshot bills until you deregister the AMI and delete the snapshot.
- The KMS key bills at the standard monthly key rate until deleted.

## Prerequisites

- A default VPC in the deployment region (or set `SubnetId`/`SecurityGroupIds` on the infrastructure configuration).
- AWS CLI with permissions to deploy CloudFormation stacks with IAM resources.

## Deploy

```shell
aws cloudformation deploy \
  --template-file approval-gate.yml \
  --stack-name approval-gate \
  --parameter-overrides NotificationEmail=you@example.com \
  --capabilities CAPABILITY_IAM
```

## Testing

1. Start a build: `aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <ImagePipelineArn output>`.
2. After components finish (about 10 minutes), the approval request arrives on the topic and the workflow step shows `WAITING`:

```shell
aws imagebuilder list-workflow-executions --image-build-version-arn <build arn>
aws imagebuilder list-workflow-step-executions --workflow-execution-id <from above>
```

3. Inspect the build instance if you like - find it on the launch step with `aws imagebuilder list-workflow-step-executions`; it stays alive and reachable through SSM while the step waits.
4. Approve with `send-workflow-step-action --action RESUME` (above). The build continues to `AVAILABLE`.
5. Run a second build and respond with `--action STOP`: the workflow ends, the build fails with the stop reason, and the build instance is cleaned up by rollback.

## Cleanup

1. Delete the image build versions (`aws imagebuilder delete-image --image-build-version-arn <arn>` per build).
2. Deregister the `approval-gate-*` AMIs and delete their snapshots.
3. Delete the stack: `aws cloudformation delete-stack --stack-name approval-gate`. The KMS key enters its 7-day deletion window.
4. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
