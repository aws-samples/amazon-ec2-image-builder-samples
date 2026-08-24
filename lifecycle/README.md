# Image lifecycle management

Every pipeline run leaves behind an Image Builder image resource, an AMI, and snapshots - and they bill until something deletes them. Lifecycle policies automate that cleanup, but the retention model isn't obvious from the policy shape alone. This sample is a working policy attached to a minimal pipeline ([lifecycle-policy.yml](lifecycle-policy.yml)), plus three ready-to-use policy documents for the CLI ([policies/](policies/)).

## The retention model

Getting these wrong is how policies delete too much or nothing at all:

1. **Policies act on Image Builder image resources, and only touch AMIs/snapshots if you say so.** The `Action.IncludeResources` block is the blast-radius control: without `Amis: true` and `Snapshots: true`, a DELETE removes only the Image Builder record and the actual AMI keeps billing.
2. **Counting is per recipe version.** A COUNT filter of 3 keeps the newest 3 image build versions for *each* recipe version independently - 1.0.0 and 1.0.1 each keep their own 3, and a wildcard (`x.x.x`) covers every version the same way. Failed and canceled builds never count toward retention and always qualify for deletion (exclusion tags don't protect them).
3. **For COUNT, `Value` is how many to keep** (not how many to delete). For AGE rules, `RetainAtLeast` is the floor under a DELETE - the newest N survive even past the age bar, counted per recipe version like COUNT.
4. **One policy holds up to 3 rules, evaluated deprecate -> disable -> delete, one action per image per run.** That ordering is what makes a progressive strategy (deprecate at 90 days, disable at 120, delete at 180) work as a single policy.
5. **Policies run once per day** at a time the service chooses. For on-demand cleanup, use `start-resource-state-update` (below) - it takes the same execution role.

Selection is by recipe (name + semantic version, where `x` wildcards resolve at execution time - recipe versions created after the policy are covered automatically) or by tags **on the Image Builder image resource**. The pipeline's `ImageTags` put them there: each scheduled run stamps its image with the group tag that tag-scoped policies match on. Manually started builds don't apply `ImageTags` - tag those images with `aws imagebuilder tag-resource`.

## What the actions do

- **DEPRECATE** - the image stops appearing in general searches but still launches by AMI ID; with `IncludeResources`, the AMIs get a `DeprecatedBy: EC2 Image Builder` tag. A soft migrate-away signal.
- **DISABLE** - pipelines can no longer run for the image; with `IncludeResources`, the AMIs become private, can no longer launch instances (Auto Scaling groups using them included), and accounts they were shared with lose access.
- **DELETE** - removes the image resource, and with `IncludeResources`, deregisters the AMIs and deletes the snapshots.

## The policy documents

Each file in [policies/](policies/) is a complete `--cli-input-json` input - set your `executionRole` ARN, adjust names, then:

```shell
aws imagebuilder create-lifecycle-policy --cli-input-json file://policies/keep-last-n.json
```

The same fields map 1:1 into `AWS::ImageBuilder::LifecyclePolicy` properties (camelCase to PascalCase) - the template's deployed policy shows the CloudFormation shape.

Note that this creates an *enabled* policy - the first daily run can act within 24 hours, so check the selection before pointing one at a busy recipe.

- **[keep-last-n.json](policies/keep-last-n.json)** - keep the newest 5 images per recipe version, delete the rest with their AMIs and snapshots. Wildcard `semanticVersion: x.x.x` covers every version of the recipe, present and future.
- **[progressive-age.json](policies/progressive-age.json)** - the three-stage strategy: deprecate at 90 days, disable at 120, delete at 180 with `retainAtLeast: 2` as the floor. Tag-scoped, so it manages every image resource tagged `LifecycleGroup: lifecycle-sample` - which the pipeline's `ImageTags` apply on each scheduled run.
- **[guarded-delete.json](policies/guarded-delete.json)** - deletion with every guardrail shown: skip AMIs that are public, shared with specific accounts, launched in the last 30 days (EC2's last-launched data lags up to 24 hours), distributed to regions you list (the placeholder protects `us-east-1` - adjust it), or tagged `Environment: production`. These AMI-level guards protect the AMI only - the image resource still deletes around it, leaving the AMI unmanaged. To keep the pair intact, use the image-resource pin tag (`LifecyclePin: retain`). Retention counting runs before tag exclusion, so a pinned image inside the retention window still occupies a keep slot - the pin protects images beyond the window.

## Cost

The policy itself is free. The pipeline builds weekly until you delete the stack (plus any manual runs); each build bills a t3.medium for the build duration, typically 15 to 25 minutes (the sample component is trivial), plus AMI snapshot storage per build - which is the point: the policy caps that accumulation at 3 builds.

## Prerequisites

- A default VPC in the deployment region (or add `SubnetId`/`SecurityGroupIds` to the infrastructure configuration).
- AWS CLI with permissions to deploy CloudFormation stacks with IAM resources.

## Deploy

```shell
aws cloudformation deploy \
  --template-file lifecycle-policy.yml \
  --stack-name lifecycle-sample \
  --capabilities CAPABILITY_IAM
```

This creates the execution role (trusting `imagebuilder.amazonaws.com`, carrying the `EC2ImageBuilderLifecycleExecutionPolicy` managed policy), a minimal weekly pipeline, and an enabled count-based policy scoped to the pipeline's recipe. The managed policy conditions its EC2 actions on the `CreatedBy: EC2 Image Builder` resource tag the service stamps on everything it distributes - the role can't touch AMIs the service didn't build.

## Testing

1. Run the pipeline two or three times (`aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <output>`) - each build typically takes 15 to 25 minutes and must finish before the next starts.
2. Manual runs skip the pipeline's `ImageTags`, so stamp the group tag yourself: `aws imagebuilder tag-resource --resource-arn <image build version arn> --tags LifecycleGroup=lifecycle-sample` (scheduled runs apply it automatically - confirm either with `list-tags-for-resource`).
3. The policy holds until you exceed 3 images. Rather than building 4 times, test the mechanism with a one-off state change:

```shell
aws imagebuilder start-resource-state-update \
  --resource-arn <image build version arn> \
  --state status=DEPRECATED \
  --execution-role <LifecycleExecutionRoleArn from the stack outputs> \
  --include-resources amis=true
```

The API requires `--include-resources` whenever `--execution-role` is set. Within a minute the image's status turns `DEPRECATED` and its AMI gains the `DeprecatedBy: EC2 Image Builder` tag. Track any lifecycle run with `aws imagebuilder list-lifecycle-executions --resource-arn <arn>` (the policy ARN for scheduled runs, the image build version ARN for manual ones) and `list-lifecycle-execution-resources` (per-resource SUCCESS/FAILED/SKIPPED with reasons). Those two APIs are the monitoring path for lifecycle runs.

For one-off deletion (image + AMIs + snapshots in one call):

```shell
aws imagebuilder start-resource-state-update \
  --resource-arn <image build version arn> \
  --state status=DELETED \
  --execution-role <role arn> \
  --include-resources amis=true,snapshots=true
```

Images in `FAILED` or `CANCELLED` state can only transition to `DELETED`.

## Common errors

| What you see | Likely cause | Fix |
|---|---|---|
| Policy runs but nothing is deleted | Fewer images than the COUNT value (it's a keep-count, not a delete-count), or all candidates are excluded | Check `list-lifecycle-execution-resources` - SKIPPED entries carry the reason |
| AMIs survive while image resources disappear | `IncludeResources` missing `Amis`/`Snapshots` | Add them to the DELETE rule |
| Lifecycle execution fails with access denied on EC2 actions | The AMIs lack the `CreatedBy: EC2 Image Builder` tag the managed policy's conditions require (they weren't distributed by Image Builder) | Only service-distributed AMIs are manageable with the managed policy; clean others up directly |
| Tag-scoped policy matches nothing | The tags are on the AMI, not the Image Builder image resource - or the images came from manual runs, which skip the pipeline's `ImageTags` | Scheduled runs stamp `ImageTags` on the image resource automatically; tag manual builds with `aws imagebuilder tag-resource` |
| Cross-account copies untouched | Lifecycle needs a role named `Ec2ImageBuilderCrossAccountLifecycleAccess` in each destination account | Create it there, trusting `imagebuilder.amazonaws.com` with `aws:SourceAccount` pinned to the distributing account and `aws:SourceArn` limited to `arn:*:imagebuilder:*:*:image/*/*/*` |

## Cleanup

1. Delete remaining image build versions - the one-off delete above with `--include-resources amis=true,snapshots=true` does image + AMI + snapshots per build. (Don't wait for the daily policy run to clean these up - the policy is deleted with the stack.)
2. Delete the stack: `aws cloudformation delete-stack --stack-name lifecycle-sample`.
3. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
