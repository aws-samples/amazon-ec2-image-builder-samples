# A patched, verified Windows golden image

This kit runs a monthly Windows Server 2025 pipeline that patches with the managed `update-windows` component, applies machine-scope baseline configuration, and then proves the result where it counts: a test phase on a fresh instance launched from the sysprepped AMI, asserting the baseline is present and zero software updates are pending. Optional EC2 Fast Launch pre-provisioning sits behind the `EnableFastLaunch` parameter.

Everything lives in one CloudFormation template, [windows-golden-image.yml](windows-golden-image.yml). The kit stops at the verified AMI - for promoting each new AMI into a launch template, rolling a fleet onto it, and getting notified when a scheduled build fails, see the [golden AMI pipeline kit](../golden-ami-pipeline/).

## What the service already does to your Windows build

Before writing components, know what the default build workflow handles - a lot of published Windows advice duplicates or fights it:

- **Sysprep runs automatically.** The last step before the snapshot runs Microsoft Sysprep through the `AWSEC2-RunSysprep` Systems Manager document, which drives the launch agent's own sysprep flow (`EC2Launch.exe sysprep` on EC2Launch v2). That flow resets the agent state, so user data runs on instances launched from your AMI - no re-arming component needed.
- **The Administrator password is rotated.** The same `AWSEC2-RunSysprep` document sets a new random password on the built-in Administrator account (found by its RID, so renaming it doesn't opt out) and runs sysprep in that admin session - so it runs after your components, and a password set in one doesn't survive. Local account passwords belong in launch-time user data or Group Policy.
- **The AMI is captured cold.** The instance is stopped before the snapshot, so nothing boots between generalization and capture.
- **Nothing else is cleaned.** Unlike Linux builds, there's no sanitize script and no file cleanup beyond sysprep's own generalization - `C:\Windows\Temp` contents survive into the AMI, for example. What your components leave behind, the image keeps.

## Where customizations survive

Components run as `NT AUTHORITY\SYSTEM` - not as a user - and the sysprep flow's answer file enables `CopyProfile`, which copies the built-in Administrator profile over the Default profile (applied when an instance first boots from the AMI). That pair of facts decides what makes it into your image:

| You write to | On instances launched from the AMI |
|---|---|
| Machine scope - `HKLM`, `C:\ProgramData`, `Program Files` | Present. This is where baseline configuration belongs |
| The Administrator profile (`C:\Users\Administrator`) | Present for every new user profile created on the instance - `CopyProfile` makes it the Default profile template |
| A local user created during the build | Present - the account and its `C:\Users\` profile survive; sysprep regenerates the machine SID and remaps the profile to the account's new SID. Deleting accounts mid-build is the risky direction - stale profile references can fail sysprep |
| `$env:USERPROFILE` as components see it | That's the SYSTEM profile under `C:\Windows\system32\config` - it survives, but no user ever sees it |

## Reboots

Patching reboots Windows, sometimes more than once per update. The `UpdateOS` action (what the managed `update-windows` component runs) is the path the service recognizes: when Windows fires an unplanned second reboot mid-update, the build retries instead of failing. A component that reboots by exiting 3010 resumes at the same step (the [AWSTOE cookbook](../awstoe/) covers that pattern), but it doesn't get that second-reboot coverage - keep patching in `UpdateOS`, and use the `Reboot` action for deliberate restarts.

## Cost

**This pipeline has a schedule.** It builds the third Monday monthly, and only when the base image or a component has updated. Each run bills a c5.xlarge for the build and a second instance for the test phase, plus the AMI and snapshot it produces. Build time tracks base-image freshness: about 20 minutes from the current month's base, an hour or more from a stale one. With `EnableFastLaunch=true`, each enabled AMI additionally launches temporary instances and maintains pre-provisioned snapshots that bill until you disable Fast Launch on that AMI - and old AMIs stay enabled until you disable each one, so clean up as you rotate. The AMIs and their snapshots also accrete monthly until pruned - the [lifecycle kit](../lifecycle/) automates that.

## Prerequisites

- AWS CLI v2 with credentials for an account and region where you can create IAM roles.
- A default VPC (the infrastructure configuration doesn't pin a subnet).
- A region where the managed Windows Server 2025 base image is available - `aws imagebuilder list-images --owner Amazon` shows the catalog.

## Deploy

```shell
aws cloudformation deploy \
  --template-file windows-golden-image.yml \
  --stack-name windows-golden-image \
  --capabilities CAPABILITY_IAM
```

## Testing

1. Start a build and watch it to `AVAILABLE`:

   ```shell
   PIPELINE_ARN=$(aws cloudformation describe-stacks --stack-name windows-golden-image \
     --query "Stacks[0].Outputs[?OutputKey=='ImagePipelineArn'].OutputValue" --output text)
   IMAGE_ARN=$(aws imagebuilder start-image-pipeline-execution \
     --image-pipeline-arn "$PIPELINE_ARN" --query imageBuildVersionArn --output text)
   aws imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" \
     --query 'image.state' --output json
   ```

   The build already verified itself - the test phase ran on a fresh instance from the output AMI and asserted the baseline plus zero pending software updates.

2. Prove the launch contract. Launch an instance from the output AMI with user data and confirm it ran:

   ```shell
   AMI=$(aws imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" \
     --query 'image.outputResources.amis[0].image' --output text)
   cat > userdata.txt << 'EOF'
   <powershell>
   Set-Content -Path 'C:\ProgramData\golden-image\userdata-ran.txt' -Value "ran at $(Get-Date -Format o)"
   </powershell>
   EOF
   PROFILE=$(aws cloudformation describe-stacks --stack-name windows-golden-image \
     --query "Stacks[0].Outputs[?OutputKey=='InstanceProfileName'].OutputValue" --output text)
   aws ec2 run-instances --image-id "$AMI" --instance-type t3.medium \
     --iam-instance-profile "Name=$PROFILE" \
     --metadata-options HttpTokens=required --user-data file://userdata.txt \
     --query 'Instances[0].InstanceId' --output text
   ```

   Once the instance is up (Windows first boot takes a few minutes), check `C:\ProgramData\golden-image\userdata-ran.txt` over Session Manager. Terminate the instance when done.

3. Fast Launch. Redeploy with Fast Launch enabled, then rerun the pipeline (step 1):

   ```shell
   aws cloudformation deploy \
     --template-file windows-golden-image.yml \
     --stack-name windows-golden-image \
     --capabilities CAPABILITY_IAM \
     --parameter-overrides EnableFastLaunch=true
   ```

   Once the new build is `AVAILABLE`, capture its AMI as in step 2 and watch the enablement - it takes several minutes after the build:

   ```shell
   aws ec2 describe-fast-launch-images --image-ids "$AMI" \
     --query 'FastLaunchImages[0].State' --output text
   ```

   `enabling` then `enabled`. Disable it before deregistering the AMI: `aws ec2 disable-fast-launch --image-id "$AMI"`.

## Common errors

For general build triage - which failure leaves its evidence where - start with the [debugging kit](../debugging/). The rows below are the Windows-specific ones:

| Symptom | Cause | Fix |
|---|---|---|
| The build runs far longer than usual | A stale base image accumulating a large cumulative update | Keep the recipe on the managed base's `x.x.x` (this template does) - a current base means a near-empty update pass |
| `RunSysPrepScript` hangs, then the build fails with an SSM `Undeliverable` or timeout | Sysprep is blocked - an Appx package installed for a user but not provisioned for all users, or hardening that broke the SSM agent (DNS, removed COM ports) | Rerun with `TerminateInstanceOnFailure: false` on the infrastructure configuration to keep the failed instance, then check `C:\Windows\System32\Sysprep\Panther\setupact.log` on it; remove per-user packages with `-AllUsers` scope during the build |
| `Can't enable EC2 Fast Launch. The IAM credentials that you are using do not have sufficient permissions.` | The pipeline runs as the service-linked role, which can't enable Fast Launch | Set an execution role on the pipeline carrying `EC2ImageBuilderExecutionPolicy` and `EC2FastLaunchFullAccess` (this template's `EnableFastLaunch` parameter wires it) |

## Cleanup

1. If you enabled Fast Launch, disable it on every AMI this pipeline produced (`aws ec2 describe-fast-launch-images`, then `aws ec2 disable-fast-launch --image-id <id>` for each) - disabling is what deletes an AMI's pre-provisioned snapshots, so do it before deregistering.
2. Delete the image build versions: `aws imagebuilder list-image-build-versions --image-version-arn <arn>` (from `aws imagebuilder list-images --owner Self`) enumerates them, and `aws imagebuilder delete-image --image-build-version-arn <arn>` deletes each.
3. Deregister the AMIs and delete their snapshots (`aws ec2 describe-images --owners self --filters Name=name,Values='windows-golden-image-*'`).
4. Empty the log bucket, including all object versions and delete markers (the bucket is versioned - the S3 console's Empty button handles both), then delete the stack:

   ```shell
   aws cloudformation delete-stack --stack-name windows-golden-image
   ```

5. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
