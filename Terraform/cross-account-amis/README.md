# Cross-account AMI distribution (Terraform)

The Terraform twin of the CloudFormation [cross-account distribution sample](../../distribution/cross-account-amis/): a source account builds an Amazon Linux 2023 image encrypted with a customer managed KMS key and distributes an owned copy of the AMI to target accounts, with each account's AMI ID published to an SSM parameter in that account. The distribution mechanics - the key policy, the fixed-name target role, the share-vs-copy distinction - are documented in that sample's README and apply here unchanged. This README covers what's Terraform-specific.

Two root modules, applied with each account's own credentials:

- [source-account/](source-account/) - the pipeline, KMS key, and distribution configuration.
- [target-account/](target-account/) - the `EC2ImageBuilderDistributionCrossAccountRole`, deployed once per target account.

Running both from a single apply with [provider aliases](https://developer.hashicorp.com/terraform/language/providers/configuration#alias-multiple-provider-configurations) works too; separate modules keep the sample free of assumptions about your cross-account credential setup.

## Terraform-specific patterns

**Component documents load with `file()`.** It passes the document through byte-for-byte with no interpolation - multi-line commands survive untouched and shell `$` syntax needs no escaping. If you need variables inside a document, `templatefile()` works but every literal `${...}` the shell should see must be escaped as `$${...}`.

**Versions are content-hash-derived.** A component or recipe is registered under a fixed name + version pair, so the sample derives a numeric patch version from a content hash:

```hcl
component_version = "1.0.${parseint(substr(sha256(local.component_document), 0, 4), 16)}"
```

The version changes when the hashed inputs change, `create_before_destroy` makes the replacement safe (the new name+version pair differs from the old one), and the pipeline follows the new recipe ARN with an in-place update. To retain superseded component versions instead of deleting them, set `skip_destroy = true` on the component. Recipes are immutable, so the recipe version's hash must cover every recipe-shaping argument - the sample hashes the component version and parent image name; extend it if you change other arguments, or bump the version by hand. Wildcard references (the recipe's `x.x.x` parent image) resolve to the latest release at build time.

## Cost

Each run bills one EC2 build instance and one test instance for the build duration (typically 15 to 30 minutes) at standard EC2 rates, plus AMI/snapshot storage in the source account and every target account (copies are full, owned AMIs). The KMS key bills at the standard monthly key rate and enters a 7-day deletion window on destroy.

## Prerequisites

- Terraform >= 1.5 and AWS provider >= 6.0.
- Credentials for the source account and each target account.
- A default VPC in the source account's build region (or set `subnet_id`/`security_group_ids` on the infrastructure configuration).

## Deploy

Order matters: the target-account role must exist before the pipeline's first run, and the source module's key ARN is an input to the target module.

1. Source account:

```shell
cd source-account
terraform init
terraform apply -var 'target_account_ids=["<target account id>"]'
```

2. Each target account (with that account's credentials):

```shell
cd ../target-account
terraform init
terraform apply \
  -var 'source_account_id=<source account id>' \
  -var 'source_kms_key_arn=<kms_key_arn output from step 1>'
```

Keep `source_account_id` pinned to the one account that runs the pipeline: the role can copy AMIs into this account and write its SSM parameters, so don't widen its trust to `*` or an organization path.

If the target account already has an `EC2ImageBuilderDistributionCrossAccountRole` (the name is fixed by the service - one per account), reuse it: make sure its trust covers your source account and its inline policy covers this key ARN, and skip the target module.

3. Run the pipeline (source account):

```shell
aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn "$(terraform -chdir=../source-account output -raw image_pipeline_arn)"
```

## Testing

The build typically takes 15 to 30 minutes. When the image reaches `AVAILABLE`, distribution copies the AMI to each target account and writes the SSM parameters:

- Source account: `/imagebuilder/cross-account-sample-tf/source-ami` holds the source AMI ID.
- Target account: `/imagebuilder/cross-account-sample-tf/target-ami` holds that account's own copy's AMI ID - written in the target account, through the distribution role.
- In the target account, `aws ec2 describe-images --owners self --filters "Name=name,Values=cross-account-sample-tf-*"` shows the owned copy, and its snapshot reports `Encrypted: true` with the source account's key.

The [CloudFormation sample's README](../../distribution/cross-account-amis/README.md#common-errors) has the common-errors table - the failure modes are identical.

## Cleanup

Distribution outputs aren't Terraform resources, so both accounts need manual steps before destroy:

1. In each target account: deregister the `cross-account-sample-tf-*` AMIs, delete their snapshots, and delete the `/imagebuilder/cross-account-sample-tf/target-ami` parameter.
2. In the source account: delete the Image Builder image build versions (`aws imagebuilder delete-image`), deregister the source AMIs and delete their snapshots, and delete the `/imagebuilder/cross-account-sample-tf/source-ami` parameter.
3. `terraform destroy` in target-account, then in source-account (the key enters its 7-day deletion window - anything still encrypted with it becomes unrecoverable after that, which is why the AMIs go first).
4. If a build ran recently, the log group can reappear after destroy while late log deliveries land - delete it again before re-applying, or the apply fails on the name conflict.
