# Debug a failed image build

This kit deploys a pipeline that fails on purpose: its one component installs a package whose name comes from a stack parameter, and the default value is a typo. The walkthrough traces that failure through every place EC2 Image Builder leaves evidence - the image's failure reason, the workflow execution APIs, CloudWatch, the S3 log bundle, and Systems Manager Run Command history - then opens a shell on the still-running build instance with Session Manager, fixes the parameter, and reruns the build to success.

Everything lives in one CloudFormation template, [debugging.yml](debugging.yml).

## Where a failed build leaves evidence

Two rules up front:

- If the synchronous `CreateImage` or `StartImagePipelineExecution` call itself fails, no build starts and no logs exist. The error goes back to the caller, and CloudTrail records it - there is nothing else to find.
- Once a build starts, expect a CloudWatch log group and stream (`/aws/imagebuilder/<image-name>`, stream `<version>/<build-number>`). The service writes the build narrative there from the first step, so even a build that never launched an instance usually leaves a log - the exceptions are log delivery being blocked (CloudWatch logging opted out, or missing `logs` permissions) and failures that land before the service writes anything. The S3 bundle is different: AWSTOE ships it from the instance, so it only appears once components actually run. An empty S3 prefix with a populated CloudWatch stream means the build died before your components started.

| The failure reason says | What happened | Where the detail is |
|---|---|---|
| `...RunInstances... in workflow step LaunchBuildInstance` | The instance never launched - quota, no default VPC, or an instance type unavailable in the subnet's zone | The CloudWatch stream carries the exact EC2 API error; CloudTrail has the `RunInstances` event, invoked by `imagebuilder.amazonaws.com` |
| `InvalidInstanceId when calling the SendCommand operation ... LaunchBuildInstance` | The instance launched but its SSM agent never registered - no network path to SSM, or a base AMI without the agent | The stream shows the verification retries. The kept instance can't be reached through SSM either - see [private-vpc-builds](../networking/private-vpc-builds/) for the endpoint fix |
| `ExpectationNotMet. ssm:ListCommandInvocations returned terminal state Failed in workflow step ApplyBuildComponents` | The command behind the step failed without AWSTOE reporting a result - it couldn't fetch AWSTOE from the regional S3 bucket, or died mid-run | The failed step's `outputs` (step 3 below) and the Run Command output (step 5) carry the real error - a fetch failure shows the download returning `HTTP status '000'`. Nothing reaches CloudWatch beyond the service's own progress lines, because AWSTOE is what ships component output there |
| `Document <component-arn> failed!` | A component step failed and AWSTOE reported it - this kit's demo | Steps 2-6 below: the real error is in CloudWatch, the S3 bundle, the Run Command output, and on the instance |
| A failure in `RunSanitizeScript` or `RunSysPrepScript` | A post-component workflow step failed | These run as Systems Manager commands like the components do, so the same Run Command trail (step 5) applies - there are no component logs for them |

Distribution-stage failures have their own table in the [cross-account distribution kit](../distribution/cross-account-amis/README.md#common-errors). For iterating on component documents without burning builds at all, see the [AWSTOE local test loop](../awstoe/).

**Getting onto the instance.** The infrastructure configuration sets `TerminateInstanceOnFailure: false`, so a failed build or test instance stays running for inspection. You don't need the `KeyPair` field for that: the instance profile already carries `AmazonSSMManagedInstanceCore` (builds require it), which is exactly what Session Manager needs - `aws ssm start-session` works with no key material, no open inbound ports, and no public IP. If the build got far enough to run components, SSM reachability is already proven, because components run through SSM. Anyone in the account with `ssm:StartSession` permission can open the same shell, so terminate the instance once you have what you need - and if your account enforces KMS-encrypted sessions, the instance role also needs `kms:Decrypt` on the session key. The one class this can't reach is the `InvalidInstanceId` row above, where SSM itself is what broke; if you must inspect that instance, stop it, attach its root volume to a healthy instance, and delete the volume when you're done.

## Cost

**A failed build now leaves a t3.medium running - and billing - until you terminate it.** That's the point of the sample, and it's also the trap: nothing cleans these instances up for you, and they don't appear anywhere in the Image Builder console. Cleanup step 1 finds and terminates them. A successful build runs the instance for 10-15 minutes; a failed one runs it until you terminate it. The S3 and CloudWatch log volumes are negligible and expire automatically. The successful run at the end of the walkthrough registers an AMI and snapshot that bill until deregistered.

## Prerequisites

- AWS CLI v2 with credentials for an account and region where you can create IAM roles.
- The [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html) for the CLI (`start-session` needs it).
- A default VPC. The infrastructure configuration doesn't pin a subnet, so builds use it.

## Deploy

```shell
aws cloudformation deploy \
  --template-file debugging.yml \
  --stack-name debugging-sample \
  --capabilities CAPABILITY_IAM
```

## Walk through the failure

1. Start a build and watch it fail - about 5 minutes:

   ```shell
   PIPELINE_ARN=$(aws cloudformation describe-stacks --stack-name debugging-sample \
     --query "Stacks[0].Outputs[?OutputKey=='ImagePipelineArn'].OutputValue" --output text)
   IMAGE_ARN=$(aws imagebuilder start-image-pipeline-execution \
     --image-pipeline-arn "$PIPELINE_ARN" --query imageBuildVersionArn --output text)
   aws imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" \
     --query 'image.state' --output json
   ```

2. Read the failure reason. When the status reaches `FAILED`, `image.state.reason` says:

   ```text
   Workflow Execution ID: 'wf-...' failed with reason: Document arn:...:component/debugging-sample-install/1.0.0/1 failed!
   ```

   This names the failing component, not the cause - it's a wrapper around whatever the component actually did. The cause is a few queries away.

3. Find the failed step. The workflow APIs turn the reason's execution ID into a step-level view:

   ```shell
   WF_ID=$(aws imagebuilder list-workflow-executions --image-build-version-arn "$IMAGE_ARN" \
     --query 'workflowExecutions[0].workflowExecutionId' --output text)
   aws imagebuilder list-workflow-step-executions --workflow-execution-id "$WF_ID" \
     --query 'steps[].[name,status]' --output table
   ```

   `ApplyBuildComponents` shows `FAILED`; everything after it stayed `PENDING`. Now pull that step - its `outputs` field carries three things you'll use:

   ```shell
   STEP_ID=$(aws imagebuilder list-workflow-step-executions --workflow-execution-id "$WF_ID" \
     --query 'steps[?status==`FAILED`].stepExecutionId | [0]' --output text)
   aws imagebuilder get-workflow-step-execution --step-execution-id "$STEP_ID" \
     --query 'outputs' --output text
   ```

   The JSON contains `runCommandId` (the Systems Manager command that ran your components), the error message, and an AWSTOE summary whose `logUrl` is the exact S3 path of this build's log bundle. The `LaunchBuildInstance` step's `outputs` holds the instance ID:

   ```shell
   aws imagebuilder list-workflow-step-executions --workflow-execution-id "$WF_ID" \
     --query 'steps[?name==`LaunchBuildInstance`].outputs | [0]' --output text
   ```

4. Read the real error in CloudWatch. The build's stream mixes the service's progress messages with each component step's console output:

   ```shell
   aws logs filter-log-events --log-group-name /aws/imagebuilder/debugging-sample \
     --log-stream-names "${IMAGE_ARN##*image/debugging-sample/}" \
     --filter-pattern '?Stderr ?ExitCode' --query 'events[].message' --output text
   ```

   (The stream name is the image ARN's version and build number - `1.0.0/1` here - so the query stays scoped to this build once the log group holds several.)

   ```text
   CmdExecution: Stderr: Error: Unable to find a match: htpd
   CmdExecution: ExitCode 1
   ```

   There's the actual cause, without leaving CloudWatch.

5. The other two off-instance copies. The S3 bundle at the `logUrl` from step 3 holds `console.log` (step output), `application.log` (AWSTOE debug detail), and `detailedoutput.json` (per-step status, machine-readable). And the Run Command view:

   ```shell
   aws ssm get-command-invocation --command-id <runCommandId from step 3> \
     --instance-id <instanceId from step 3> --query StandardOutputContent --output text
   ```

   Its output ends with the same AWSTOE summary. This record outlives the instance - Run Command keeps it for 30 days - so it works even on builds that used the default terminate-on-failure setting. Output over 24,000 characters is truncated; the S3 bundle has the full copy.

6. Get on the instance. It's still running, because the infrastructure configuration kept it:

   ```shell
   aws ssm start-session --target <instanceId from step 3>
   ```

   You land as `ssm-user`. The AWSTOE working logs are root-owned, so use sudo - and note the second command names the directory from the first listing, because your shell can't expand a glob inside a directory only root can read:

   ```shell
   sudo ls /var/lib/amazon/toe/
   sudo tail /var/lib/amazon/toe/<TOE_directory_from_the_listing>/console.log
   ```

   The presence of the `toe` directory under `/var/lib/amazon/` is itself a diagnostic: it means bootstrap succeeded and your components ran. If it's missing, the failure happened earlier - start from the table above instead. Type `exit` to leave the session.

## Fix it and rerun

Terminate the kept instance, fix the parameter, and run the pipeline again:

```shell
aws ec2 terminate-instances --instance-ids <instanceId from step 3>
aws cloudformation deploy --template-file debugging.yml --stack-name debugging-sample \
  --capabilities CAPABILITY_IAM --parameter-overrides PackageName=httpd
IMAGE_ARN=$(aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn "$PIPELINE_ARN" --query imageBuildVersionArn --output text)
```

Changing the parameter replaces the immutable recipe, and its `1.0.x` version placeholder auto-increments. This build installs `httpd`, the component's validate phase confirms it with `rpm -q`, and the image reaches `AVAILABLE` in 10-15 minutes with an AMI named `debugging-sample-<date>`.

## Cleanup

1. Terminate any build instances still running from failed builds. They carry the tag the service stamps on everything it creates:

   ```shell
   aws ec2 describe-instances \
     --filters "Name=tag:Ec2ImageBuilderArn,Values=*image/debugging-sample/*" \
       "Name=instance-state-name,Values=running" \
     --query 'Reservations[].Instances[].InstanceId' --output text
   ```

   The `Ec2ImageBuilderArn` tag holds the build each instance belongs to, so this listing can't show another pipeline's instances.

   Only terminate instances from builds that have already failed. Terminating one mid-build fails the build from under the service and can leave the image version stuck.

2. Delete the image build versions (this doesn't touch the AMI):

   ```shell
   aws imagebuilder list-images --owner Self \
     --filters name=name,values=debugging-sample --query 'imageVersionList[].arn'
   aws imagebuilder delete-image --image-build-version-arn <arn>/<build-number>
   ```

3. Deregister the successful build's AMI and delete its snapshot (`aws ec2 describe-images --owners self --filters Name=name,Values='debugging-sample-*'`).

4. Empty the log bucket, including all object versions and delete markers (the bucket is versioned - the S3 console's Empty button handles both), then delete the stack:

   ```shell
   aws cloudformation delete-stack --stack-name debugging-sample
   ```

5. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
