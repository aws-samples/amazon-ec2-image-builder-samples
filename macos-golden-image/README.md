# Build a macOS golden image on an EC2 Mac Dedicated Host

This kit runs an Image Builder pipeline that produces a customized macOS AMI: a managed macOS base image, a Homebrew baseline component, and an infrastructure configuration whose placement pins the build to an EC2 Mac Dedicated Host. A test phase asserts the baseline on a fresh instance from the output AMI - on the same host, once it finishes scrubbing.

Everything lives in one CloudFormation template, [macos-golden-image.yml](macos-golden-image.yml).

## The Dedicated Host comes first

Mac instances only run on Dedicated Hosts, and Image Builder never allocates one for you - a build without an available host fails at launch. Host allocation is the first hurdle, because three different things can say no:

| Error | What it means |
|---|---|
| `The requested configuration is currently not supported.` | Your account isn't entitled for that Mac instance family - request it through AWS Support |
| `You do not have a host with a matching configuration and sufficient capacity.` | No allocated host is available to the build - allocate one first, or your host is in the wrong state or zone |
| `InsufficientHostCapacity` on `allocate-hosts` | The family is entitled but the zone has no physical capacity right now - try another zone or retry later |

A Service Quotas value above zero for `Running Dedicated mac Hosts` guarantees neither entitlement nor capacity - all three checks are separate. Find the zones that offer your instance type before allocating:

```shell
aws ec2 describe-instance-type-offerings --location-type availability-zone \
  --filters Name=instance-type,Values=mac2-m2.metal --query 'InstanceTypeOfferings[].Location' --output text
```

The template allocates the host for you when `HostId` is left empty, or builds on a host you already own. To allocate one yourself:

```shell
aws ec2 allocate-hosts --instance-type mac2-m2.metal --availability-zone us-east-2a \
  --quantity 1 --query 'HostIds[0]' --output text
```

If you bring your own host, its Availability Zone (`aws ec2 describe-hosts --host-ids h-example1111 --query 'Hosts[0].AvailabilityZone'`) has to match the `SubnetId` and `AvailabilityZone` you pass.

**Know the cost model before allocating.** Mac Dedicated Hosts bill per second with a 24-hour minimum allocation period (an Apple licensing requirement) - a 30-minute build pays for 24 hours of host. Releasing also has stages: while an instance is (or was just) on the host it's `occupied` (`Client.InvalidHost.Occupied`), then the host scrubs (about 40 minutes measured on Intel, longer on Apple silicon), and inside the first 24 hours release is refused with `Client.HostMinAllocationPeriodUnexpired` naming the exact release time. If the stack allocated the host, deleting the stack inside those 24 hours fails on the host resource - retry the delete after the minimum has passed.

## One host runs the whole pipeline

A Dedicated Host runs one Mac instance at a time, and a pipeline with tests needs two instances in sequence: the build instance, then a test instance launched from the output AMI. One host still covers both, because the template pins the host in placement: Image Builder waits for the pinned host to finish scrubbing after the build instance terminates (about 40 minutes on Intel hosts, longer on Apple silicon), then launches the test instance on it. Set `TestAfterBuild=false` to skip the test phase and the scrub wait - the validate phase still asserts the baseline on the build instance either way.

The wait comes from the pin. Placement with `tenancy: host` but no `hostId` auto-places instead, and an auto-placed test launch doesn't wait for a scrubbing host - it fails with `InsufficientHostCapacity`.

## What the service already does on macOS

- **Components run as root.** Homebrew belongs to `ec2-user` on AWS macOS AMIs, so brew commands run as that user: `sudo -iu ec2-user brew install jq`.
- **The base image comes loaded.** AWS macOS AMIs ship with the SSM agent, AWS CLI, Homebrew, Xcode Command Line Tools, and EC2 macOS Init.
- **Cleanup is handled.** The workflow runs a macOS sanitize step before the snapshot - build artifacts and instance state are cleaned without a custom component.
- **The AMI is captured cold.** The instance is stopped before the snapshot.

## Traps to know

The [EC2 Mac instances guide](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html) is the reference for host behavior; the ones that bite image builds:

- **GUI permission prompts don't work headlessly.** macOS TCC permissions (screen recording, accessibility) require a human at a screen - Apple provides no headless approval path. Keep components to things that work in a shell.
- **Don't enable FileVault** - the host fails to boot.
- **Stay on the managed base.** Upgrading mid-build to a macOS version newer than the latest AWS-published AMI produces an AMI that won't boot on other hosts.
- **Match architectures.** An arm64 base image needs an Apple silicon instance type; x86 bases need `mac1.metal`.

## Cost

**The Dedicated Host dominates.** Per-second host billing with a 24-hour minimum per allocation, whether the build takes 30 minutes or 12 hours - the release rules are under "The Dedicated Host comes first" above. Each build also produces an AMI and snapshot that bill until deregistered, and the pipeline deliberately has no schedule: a scheduled build would launch onto a host you may have already released. Back-to-back builds on one host serialize - the second waits out the first's scrubbing before it can launch.

## Prerequisites

- AWS CLI v2 with credentials for an account and region where you can create IAM roles.
- Your account entitled for at least one Mac instance family, in a region with EC2 Mac capacity.
- A subnet and security group in the host's Availability Zone (the security group needs no inbound rules - the SSM agent connects outbound).

## Deploy

Pick the zone, subnet, and security group, then deploy - leave `HostId` empty to let the stack allocate the host (24-hour minimum starts then):

```shell
aws cloudformation deploy \
  --template-file macos-golden-image.yml \
  --stack-name macos-golden-image \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    AvailabilityZone=us-east-2a \
    SubnetId=subnet-example111 \
    SecurityGroupId=sg-example111
```

To build on a host you already allocated, add `HostId=h-example1111` and set `MacInstanceType`/`BaseImageName` to match it.

## Testing

1. Start a build and watch it to `AVAILABLE`. Mac instances boot slowly (the workflow retries its reachability checks for many minutes before components start), and with tests on the pipeline waits out the host's scrub between the build and test instances - about 70 minutes end to end on an Intel host. With `TestAfterBuild=false` it ends at the build, about 20 minutes:

   ```shell
   PIPELINE_ARN=$(aws cloudformation describe-stacks --stack-name macos-golden-image \
     --query "Stacks[0].Outputs[?OutputKey=='ImagePipelineArn'].OutputValue" --output text)
   IMAGE_ARN=$(aws imagebuilder start-image-pipeline-execution \
     --image-pipeline-arn "$PIPELINE_ARN" --query imageBuildVersionArn --output text)
   aws imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" \
     --query 'image.state' --output json
   ```

2. Confirm the baseline landed in the AMI. The test phase already asserted it on a fresh instance; to check it yourself, launch an instance from the output AMI onto an available host (Mac launches need the same host placement the build did) and inspect it over Session Manager:

   ```shell
   AMI=$(aws imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" \
     --query 'image.outputResources.amis[0].image' --output text)
   aws ec2 run-instances --image-id "$AMI" --instance-type mac2-m2.metal \
     --placement "Tenancy=host,HostId=h-example1111" \
     --subnet-id subnet-example111 --metadata-options HttpTokens=required \
     --query 'Instances[0].InstanceId' --output text
   ```

   Once it boots, `aws ssm start-session --target <instance-id>` and check `/usr/local/lib/golden-image/baseline.txt`. Terminate it when done - the host then scrubs.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| `InsufficientHostCapacity ... in workflow step LaunchTestInstance` | The placement has no `hostId` - auto-placed launches don't wait for the host to finish scrubbing after the build | Pin the host in the placement (this template does) |
| `InsufficientHostCapacity ... in workflow step LaunchBuildInstance` | No available host matches the zone and instance type | Check the host's state (`aws ec2 describe-hosts`) - a scrubbing host is `pending`, not `available` |
| The build sits in `Building` or between phases for a long time | Mac instances boot slowly, and with tests on the pipeline waits out the host's scrub between build and test | Expected; budget it into pipeline timeouts |
| `Client.InvalidHost.Occupied` on `release-hosts` | An instance is still on the host, or the host is scrubbing after one terminated | Wait for scrubbing to finish (the host shows `pending` until then) |
| `Client.HostMinAllocationPeriodUnexpired` on `release-hosts` | The host hasn't been allocated for the full 24-hour minimum yet | The message states the exact time you can release it - wait until then |

## Cleanup

1. Delete the image build versions: `aws imagebuilder list-image-build-versions --image-version-arn <arn>` (from `aws imagebuilder list-images --owner Self`) enumerates them, and `aws imagebuilder delete-image --image-build-version-arn <arn>` deletes each.
2. Deregister the AMIs and delete their snapshots (`aws ec2 describe-images --owners self --filters Name=name,Values='macos-golden-image-*'`).
3. Empty the log bucket, including all object versions and delete markers (the bucket is versioned - the S3 console's Empty button handles both), then delete the stack:

   ```shell
   aws cloudformation delete-stack --stack-name macos-golden-image
   ```

   If the stack allocated the Dedicated Host and 24 hours haven't passed since allocation, the delete fails on the host resource (`Unable to release Dedicated Host ... must be allocated ... for at least 24 hour(s)`), leaving the stack `DELETE_FAILED`. Wait until the time the message names, then delete - that releases the host with the stack. Deleting again before then can drop the host from the stack while it keeps billing, so hold off rather than forcing it. A host that just ran an instance also scrubs before it can be released.
4. Release any host you allocated yourself (the stack only releases the one it allocated): `aws ec2 release-hosts --host-ids h-example1111`. It keeps billing until you do, and the same 24-hour minimum and scrubbing rules apply.
5. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
