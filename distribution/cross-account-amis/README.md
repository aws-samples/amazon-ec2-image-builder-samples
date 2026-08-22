# Distribute AMIs to other accounts

An Image Builder pipeline in one account (the source) builds an Amazon Linux 2023 AMI encrypted with a customer managed KMS key, and the distribution configuration copies the AMI into other accounts (the targets). Each target account ends up owning its own AMI and snapshots, and gets the copied AMI's ID written to an SSM parameter in its own account - ready for launch templates or other stacks to consume with `resolve:ssm`.

Two templates:

| Template | Deploy where | What it creates |
|---|---|---|
| `source-account.yml` | The account that builds images | KMS key, build infrastructure, recipe, distribution configuration, and pipeline |
| `target-account.yml` | Every account that receives a copy | The `EC2ImageBuilderDistributionCrossAccountRole` role Image Builder assumes to deliver the copy |

Throughout this README, `111122223333` stands in for the source account and `444455556666` for a target account.

## Share vs. copy vs. launch template

Image Builder has three ways to hand an AMI to another account. This sample uses the copy mechanism (`TargetAccountIds`).

| Mechanism | Distribution setting | What the target account gets | Who can launch this AMI |
|---|---|---|---|
| Share (launch permission) | `LaunchPermissionConfiguration` | Permission to launch the source-owned AMI - no copy is made | The source account and every account (or org) granted launch permission; the AMI and its KMS key stay owned by the source |
| Copy (this sample) | `TargetAccountIds` | Its own AMI and snapshots, owned outright | Each target account launches its own copy; the source account's AMI stays private to the source |
| Launch template update | `LaunchTemplateConfigurations` | A new default version on an existing launch template | Whoever can use that launch template - but see the gotcha below |

**Launch template gotcha:** `LaunchTemplateConfigurations` in a cross-account distribution updates the launch template with the SOURCE account's AMI ID, not the target account's copy - instances launched from it in the target account then fail with an AMI permission error. To wire launch templates in target accounts, use `SsmParameterConfigurations` (as this sample does) and reference the parameter from the launch template with `resolve:ssm:/imagebuilder/cross-account-sample/target-ami` instead.

## Prerequisites

- Two AWS accounts you control, with credentials for both.
- A default VPC in the source account's build region (or set `SubnetId` in the infrastructure configuration - see the comment in `source-account.yml`).
- Permissions to create IAM roles in both accounts, so deploy with `--capabilities CAPABILITY_IAM` (source) and `--capabilities CAPABILITY_NAMED_IAM` (target - the role name is fixed by the service).

## Cost

The pipeline run launches one EC2 build instance and one test instance for the duration of the build (typically 15 to 30 minutes), billed at standard EC2 rates. The KMS key bills at the standard monthly key rate until deleted. AMI snapshots bill in BOTH accounts - the source AMI and every target copy - until you deregister the AMIs and delete their snapshots.

## Deploy

### 1. Source account: deploy the pipeline

```shell
aws cloudformation create-stack \
  --stack-name cross-account-distribution-sample \
  --template-body file://source-account.yml \
  --parameters ParameterKey=TargetAccountIds,ParameterValue=444455556666 \
  --capabilities CAPABILITY_IAM
```

For multiple targets, pass a comma-delimited list (the backslash escapes the comma for the CLI's shorthand parser; the quotes keep the shell from eating the backslash): `ParameterValue='444455556666\,777788889999'`. Note that the sample's `SsmParameterConfigurations` writes the target-side parameter for the first account in the list - duplicate that entry in the template for each additional target.

When the stack completes, note the two outputs:

```shell
aws cloudformation describe-stacks \
  --stack-name cross-account-distribution-sample \
  --query 'Stacks[0].Outputs'
```

- `KmsKeyArn` - the key ARN target accounts need
- `ImagePipelineArn` - the pipeline to run in step 3

### 2. Target account: deploy the distribution role

Using target-account credentials, in the same region:

```shell
aws cloudformation create-stack \
  --stack-name cross-account-distribution-role \
  --template-body file://target-account.yml \
  --parameters \
      ParameterKey=SourceAccountId,ParameterValue=111122223333 \
      ParameterKey=SourceKmsKeyArn,ParameterValue=<KmsKeyArn from step 1> \
  --capabilities CAPABILITY_NAMED_IAM
```

Deploy this once per target account (a CloudFormation StackSet works - the template takes the same parameter values in every account). Keep `SourceAccountId` pinned to the one account that runs the pipeline: the role can copy AMIs into your account and write your SSM parameters, so don't widen its trust policy to `*` or an organization path.

### 3. Source account: run the pipeline

```shell
aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn <ImagePipelineArn from step 1>
```

The build typically takes 15 to 30 minutes. When the image reaches `AVAILABLE`, distribution copies the AMI to each target account and writes the SSM parameters.

## Testing

Verify in the TARGET account (target credentials, same region) that the copy arrived and is owned by that account:

```shell
aws ec2 describe-images --owners self \
  --filters Name=name,Values='cross-account-sample-*' \
  --query 'Images[].{Id:ImageId,Name:Name,Owner:OwnerId}'
```

`Owner` should be the target account ID - that's the difference from sharing, where the AMI would still belong to the source account. Then check the parameter:

```shell
aws ssm get-parameter \
  --name /imagebuilder/cross-account-sample/target-ami \
  --query Parameter.Value --output text
```

It should return the same AMI ID as `describe-images`. In the source account, `/imagebuilder/cross-account-sample/source-ami` holds the source AMI's ID. To go end to end, launch an instance in the target account from the copied AMI and check for the `/etc/cross-account-sample-release` marker file the build component writes.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Distribution fails with `AccessDenied` on `sts:AssumeRole` for `EC2ImageBuilderDistributionCrossAccountRole` | The role doesn't exist in the target account, has a different name, or doesn't trust the source account | Deploy `target-account.yml` in the target account with the correct `SourceAccountId` |
| Distribution fails with `AccessDenied` on `kms:CreateGrant` or `kms:DescribeKey` | The target role's inline policy doesn't cover the key, or the key policy is missing the target-account statements | Confirm `SourceKmsKeyArn` matches the `KmsKeyArn` output, and that the target account ID is in `TargetAccountIds` |
| Target AMI lands in `failed` state with `AMI snapshot copy failed with error: The specified keyId ... is invalid` | The distribution configuration's `KmsKeyId` holds a bare key ID, which only resolves in the source account | Reference the key by full ARN in the distribution configuration |
| AMI arrives in the target account but the SSM parameter never appears | The target role can't write the parameter (`ssm:PutParameter` scoped elsewhere, or the parameter name moved outside `/imagebuilder/`) | Keep parameter names under `/imagebuilder/` or widen the role's `WriteImageBuilderParameters` statement to match |

## Cleanup

Distribution outputs aren't stack resources, so both accounts need manual steps.

In each TARGET account:

1. Deregister the copied AMIs (name `cross-account-sample-*`) and delete their snapshots.
2. Delete the `/imagebuilder/cross-account-sample/target-ami` SSM parameter - the service writes it, so it isn't deleted with any stack.
3. Delete the `cross-account-distribution-role` stack.

In the SOURCE account:

1. Deregister the source AMIs (name `cross-account-sample-*`) and delete their snapshots.
2. Delete the `/imagebuilder/cross-account-sample/source-ami` SSM parameter.
3. Delete the Image Builder image versions the pipeline runs created (`aws imagebuilder delete-image`) - pipeline output images aren't stack resources.
4. Delete the `cross-account-distribution-sample` stack. This schedules the KMS key for deletion with the template's 7-day `PendingWindowInDays` (KMS allows 7-30 days); the key stops billing once deleted, and anything still encrypted with it becomes unrecoverable - which is why the AMIs and snapshots go first.
