# Validate the output AMI with Step Functions

Test components check an image from the inside - they run on an instance launched from it. This sample adds the other half: a test workflow whose single `ExecuteStateMachine` step hands the output AMI to a Step Functions state machine, which validates registration properties no on-instance test can see - and a failed check fails the image before anything downstream consumes it. No test instance launches for that check. A conventional on-instance test workflow runs alongside it in the same parallel group. Everything lives in one CloudFormation template: [step-functions-integration.yml](step-functions-integration.yml).

## How the validation works

1. The build workflow is a standard build with one addition: it exports the output image ID (`outputs: ImageId`). Workflows pass data across stages through outputs - the test workflow reads it as `$.workflowOutputs.ImageId`.
2. The `sfn-integration-validate-ami` test workflow is a single `ExecuteStateMachine` step. Its execution input is a JSON string with runtime values embedded through `{{ }}` dynamic variables - the AMI ID from the build workflow's output, and the root-volume limit from a workflow parameter. Inputs that carry dynamic variables take the `.$` suffix on the key - the documented chaining rule.
3. The state machine invokes a Lambda that describes the AMI and checks it against release criteria: ENA support enabled, not publicly launchable, root volume within the size limit. Any finding fails the execution, the step, and the workflow - and a failed test workflow fails the image.
4. `ExecuteStateMachine` waits for the execution to finish (6 hours by default, up to 24 via `timeoutSeconds`). The execution role carries `states:StartExecution` on the state machine and `states:DescribeExecution` on its executions - that pair is what the step needs.

The Lambda is the swap point. The shipped checks run anywhere with zero setup; this is where you'd plug in your own release bar - launch a scan, wait on findings, gate on severity.

## How the parallel tests work

- The pipeline names the build workflow plus two test workflows in its `Workflows` property. Setting that property replaces the defaults: exactly what's named runs.
- Both test workflows carry `ParallelGroup: post-build`, so they run at the same time: the OS check launches its own instance from the output AMI (in the test stage, `LaunchInstance` defaults to the image the build produced) while the AMI validation runs with no instance at all.

## Cost

- Each build bills a t3.medium build instance, then one t3.medium test instance for the OS check - the Step Functions validation launches none.
- Each output AMI's snapshot bills until you deregister the AMI and delete the snapshot.
- The state machine and Lambda bill per execution at standard rates - negligible next to the instance time.

## Prerequisites

- A default VPC in the deployment region (or set `SubnetId`/`SecurityGroupIds` on the infrastructure configuration).
- AWS CLI with permissions to deploy CloudFormation stacks with IAM resources.

## Deploy

```shell
aws cloudformation deploy \
  --template-file step-functions-integration.yml \
  --stack-name sfn-integration \
  --capabilities CAPABILITY_IAM
```

## Testing

1. Start a build: `aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <ImagePipelineArn output>`.
2. After the build stage, both test workflows run at once: `aws imagebuilder list-workflow-executions --image-build-version-arn <build arn>` shows all three workflows, and the two test entries start together.
3. Watch the validation execute: `aws stepfunctions list-executions --state-machine-arn <ValidationStateMachineArn output>`. Its input carries the AMI ID resolved from the build workflow's output - read it with `aws stepfunctions describe-execution --execution-arn <arn> --query input`.
4. The build reaches `AVAILABLE` in roughly 10 to 25 minutes end to end.

### Watch the gate fail a build

Lower the root-volume limit below the image's actual size and run again:

```shell
aws cloudformation deploy \
  --template-file step-functions-integration.yml \
  --stack-name sfn-integration \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides MaxRootVolumeGib=4
```

Start a build: the validation fails, its workflow ends in `ROLLBACK_COMPLETED` (the terminal status of a failed test workflow), the in-flight OS check is cancelled, and the image fails. The failed build still registered an AMI - the gate runs after `CreateImage` - so cleanup covers it like any other build. The findings read from the failed execution: `aws stepfunctions describe-execution --execution-arn <arn> --query cause`. Restore the gate with `--parameter-overrides MaxRootVolumeGib=16` - note that redeploying without the override keeps the previous value.

## Cleanup

1. Delete the image build versions (`aws imagebuilder delete-image --image-build-version-arn <arn>` per build).
2. Deregister the `sfn-integration-*` AMIs and delete their snapshots.
3. Delete the stack: `aws cloudformation delete-stack --stack-name sfn-integration`.
4. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
