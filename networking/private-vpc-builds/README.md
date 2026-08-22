# Image Builder builds in a private VPC with no internet access

Building images in a subnet with no internet path is the classic first-build failure: the build instance can't reach Systems Manager, the build sits in `Building` for most of an hour, then dies with an SSM timeout. This sample is the working reference - an isolated VPC (no internet gateway, no NAT) where every dependency of a build arrives through VPC endpoints, and a complete Amazon Linux 2023 pipeline that builds inside it.

Two equivalent variants: a single CloudFormation template ([cloudformation/private-vpc-build.yml](cloudformation/private-vpc-build.yml)) and a CDK app ([cdk/](cdk/)). They use distinct resource names, so both can exist in one account.

## What a build needs when there's no internet

| Endpoint | What travels through it | What breaks without it |
|---|---|---|
| `ssm` (interface) | Instance registration, Run Command | The build never starts executing - it times out "verifying the Systems Manager Agent availability on the target instance(s)" |
| `ssmmessages` (interface) | The SSM Agent's control channel | Same timeout as above - the agent can't open its channel |
| `ec2messages` (interface) | The agent's older command channel - the SSM docs call for both | Agent communication failures on older agent versions |
| `imagebuilder` (interface) | AWSTOE on the build instance fetches component documents (`GetComponent`) | The build fails after SSM connects, when the orchestrator can't download components |
| `logs` (interface) | Build logs to the CloudWatch log groups | Builds succeed but the log groups stay empty |
| `kms` (interface) | Components decrypting KMS-encrypted values (SecureString parameters, Secrets Manager secrets) | Decryption steps fail; harmless until a component needs it |
| `s3` (gateway) | Everything below | Multiple failure modes - see the bucket table |

The S3 gateway endpoint carries the build's downloads, and its policy allowlists exactly the buckets involved:

| Bucket | Purpose | What breaks without it |
|---|---|---|
| `ec2imagebuilder-toe-<region>-prod` | The AWSTOE orchestrator binary itself | The build fails early - the instance can't bootstrap the component manager |
| `ec2imagebuilder-managed-resources-<region>-prod/components` | Amazon-managed component content (`simple-boot-test-linux` here) | Managed components fail to download |
| `amazon-ssm-<region>` | SSM Agent install packages - Image Builder's default Linux user data installs the agent from here when the base image doesn't ship it (AL2023 does, so this build never touches it) | Agent-less base images (some RHEL/Debian builds) never register with SSM |
| `al2023-repos-<region>-de612dc2` | Amazon Linux 2023 package repositories | The sample's `dnf install` component fails - AL2023 resolves its repos to regional S3 buckets |
| The stack's own log bucket (`s3:PutObject`) | Detailed build logs | Builds succeed but the S3 log bucket stays empty |

Windows note: Image Builder does not install the SSM Agent on Windows build instances - Windows base images must ship it (the Amazon-provided ones do).

## Cost

The six interface endpoints bill at standard AWS PrivateLink rates per AZ-hour plus data, whether or not a build is running. Builds add the usual t3.medium instance time. Delete the stack when you're done experimenting.

## Prerequisites

- AWS CLI configured with permissions to deploy CloudFormation stacks with IAM resources.
- CDK variant only: Node.js 20+, npm, and a CDK-bootstrapped account and region.
- Nothing else - the sample creates its own VPC and everything in it.

## Deploy

CloudFormation:

```shell
aws cloudformation deploy \
  --template-file cloudformation/private-vpc-build.yml \
  --stack-name private-vpc-build \
  --capabilities CAPABILITY_IAM
```

CDK (from the `cdk/` directory):

```shell
npm install
npx cdk deploy
```

Deploying creates the network and the pipeline but doesn't build anything.

## Run a build

```shell
aws imagebuilder start-image-pipeline-execution \
  --image-pipeline-arn <ImagePipelineArn from the stack outputs>
```

The build typically takes around 15 minutes. The build instance launches in the isolated subnet with no public IP - you can watch it in the EC2 console and confirm it still reaches `AVAILABLE`.

## Testing

After the build completes:

1. The output AMI ID lands in the stack's SSM parameter (`/imagebuilder/private-vpc-build-cfn/latest-ami` or `.../private-vpc-build-cdk/latest-ami`).
2. Detailed logs appear in the S3 log bucket and the CloudWatch log group - both fed exclusively through endpoints.
3. `aws ec2 describe-instances` during the build shows the instance with no public IP address.

## Common errors

| What you see | Likely cause | Fix |
|---|---|---|
| Build times out with `Step timed out while step is verifying the Systems Manager Agent availability on the target instance(s)` | The instance can't reach Systems Manager - missing `ssm`/`ssmmessages` endpoint, endpoint security group not admitting the instance, or private DNS disabled | Verify all three SSM-family endpoints exist with private DNS enabled, and the endpoint security group allows 443 from the build instance's security group |
| Build fails after SSM connects, while downloading or running components | Missing `imagebuilder` endpoint, or the S3 endpoint policy doesn't include the TOE / managed-resources buckets | Check the `imagebuilder` endpoint and the first two bucket entries in the S3 endpoint policy |
| `dnf` steps fail with repository errors | The S3 endpoint policy doesn't include the AL2023 repository bucket | Keep the `al2023-repos-<region>-de612dc2` entry in the S3 endpoint policy |
| Build succeeds but the S3 log bucket is empty, or logs show `AccessDenied: Access Denied status code: 403` | The S3 endpoint policy is missing the log bucket `PutObject` entry, or the instance profile lost its logging statement | Both grants matter: the endpoint policy AND the instance role need the log bucket write |
| Build succeeds but CloudWatch log groups are empty | Missing `logs` endpoint | Add the `logs` interface endpoint |

## Cleanup

Deleting the stack removes the VPC, endpoints, pipeline, and log groups - but not what builds produced. In order:

1. Delete the Image Builder image build versions (`aws imagebuilder delete-image --image-build-version-arn <arn>` per build).
2. Deregister the output AMIs and delete their snapshots.
3. Delete the SSM parameter the distribution wrote (`/imagebuilder/private-vpc-build-cfn/latest-ami` or the CDK twin's).
4. Empty the versioned log bucket (object versions and delete markers), then delete the stack (`aws cloudformation delete-stack` or `npx cdk destroy`).

Note: if a build ran recently, Image Builder can recreate the log groups shortly after stack deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
