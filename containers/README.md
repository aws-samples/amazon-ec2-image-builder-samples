# Container base images on a pipeline

This kit builds container base images: on a schedule, from a managed base, with your baseline applied, verified, pushed to Amazon ECR, and rebuilt when the base updates. Application images belong in your CI - built `FROM` the image this pipeline maintains.

Three variants, one pipeline design: [cloudformation/container-pipeline.yml](cloudformation/container-pipeline.yml) (Amazon Linux 2023), [cloudformation/windows-container-pipeline.yml](cloudformation/windows-container-pipeline.yml) (Windows Server 2025 Core), and [cdk/](cdk/) - the Linux pipeline on the `@aws-cdk/aws-imagebuilder-alpha` L2 constructs.

## How container builds differ from AMI builds

**Two operating systems.** The recipe's parent image (`ParentImage`) is the container's `FROM` line. The build instance's AMI (`InstanceConfiguration.Image`) is a separate machine - the EC2 instance that runs Docker for the build. Mixing these up is the classic container-pipeline mistake, so the templates pin the build host explicitly to the ECS-optimized AMI the service would pick anyway.

**Components run inside the container.** Their changes become image layers, staged and executed through the Dockerfile template's three variables: `{{{ imagebuilder:parentImage }}}` becomes the `FROM` line, `{{{ imagebuilder:environments }}}` copies the component scripts into the build, and `{{{ imagebuilder:components }}}` runs them and removes them. Inline templates cap at 16,000 characters - larger Dockerfiles move to an S3 object via `DockerfileTemplateUri`. The parent image must provide `/bin/sh` and a package manager for the generated steps to run; distroless and similarly minimal bases fail before your commands start.

**Tests run on the build instance.** A container recipe's test phase executes in the container on the same instance that built it - AMI pipelines launch a fresh test instance instead.

**Freshness is a rebuild, not an update.** The pipeline's schedule uses the dependency-update start condition against a managed base image, so a new base release triggers a rebuild - there's no updating a container in place.

**On-disk logs vanish with the container.** Component output streams to the CloudWatch group as the build runs, and the S3 bucket receives the detailed AWSTOE log bundle (`application.log`, `detailedoutput.json`). The Linux template wires up both, because unlike an AMI build there's no instance filesystem to inspect afterward - AWSTOE ran inside the container.

## Repositories and tags

Every build pushes two fixed tags (`<version>-<build>` and `<name>-<version>-<build>`) in addition to the distribution configuration's `ContainerTags` (`latest` here). Two pipelines sharing one repository collide on the fixed tags: silently overwriting each other on a mutable repository, failing the build on an immutable one. Each template therefore owns its repository, and the repositories are mutable because `latest` has to move - the fixed tags are the stable handles, so application builds should `FROM` those (or a digest) rather than `latest`. If no distribution configuration names a repository for the build's region, the recipe's `TargetRepository` is the fallback - the Windows template relies on that and skips the distribution configuration entirely.

## Parent images from another account

An ECR parent image in a different account works once the source repository's policy grants the build account `ecr:DescribeImages` along with the pull actions - without `DescribeImages`, recipe creation fails with "You are not authorized to use the provided image":

```json
{
  "Sid": "AllowImageBuilderParentPull",
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::<build-account-id>:root" },
  "Action": [
    "ecr:BatchCheckLayerAvailability",
    "ecr:BatchGetImage",
    "ecr:DescribeImages",
    "ecr:GetDownloadUrlForLayer"
  ]
}
```

The `:root` principal trusts every principal in the build account - narrow it with an `aws:PrincipalArn` condition if the source account needs tighter scope.

Registry URI parents (Docker Hub, ECR) also need `PlatformOverride` on the recipe, and Windows parents additionally need `ImageOsVersionOverride` - the Windows template shows both.

## Cost

**These pipelines have schedules.** Once deployed, the Linux pipeline rebuilds weekly when its base has updated, and the Windows pipeline rebuilds weekly unconditionally - each run bills its build instance and adds an image to ECR. Delete the stacks (or disable the pipelines) when you're done. A Linux build runs a t3.medium about 10 minutes; a Windows build runs a c5.xlarge about 15 minutes, most of it moving multi-gigabyte base layers. ECR storage bills per GB-month - the Windows Server Core image is about 2 GB. Build logs expire automatically.

## Prerequisites

- AWS CLI v2 with credentials for an account and region where you can create IAM roles.
- A default VPC (the infrastructure configurations don't pin a subnet).
- For the CDK variant: Node.js 20+, and a [bootstrapped environment](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html).
- Docker locally if you want to run the output image in the Testing steps.

## Deploy

CloudFormation, Linux:

```shell
aws cloudformation deploy \
  --template-file cloudformation/container-pipeline.yml \
  --stack-name container-sample \
  --capabilities CAPABILITY_IAM
```

Windows: the same command with `windows-container-pipeline.yml` and stack name `container-sample-windows`. CDK:

```shell
cd cdk && npm install && npx cdk deploy
```

## Testing

1. Start a build and watch it to `AVAILABLE` - about 10 minutes for Linux:

   ```shell
   PIPELINE_ARN=$(aws cloudformation describe-stacks --stack-name container-sample \
     --query "Stacks[0].Outputs[?OutputKey=='ImagePipelineArn'].OutputValue" --output text)
   IMAGE_ARN=$(aws imagebuilder start-image-pipeline-execution \
     --image-pipeline-arn "$PIPELINE_ARN" --query imageBuildVersionArn --output text)
   aws imagebuilder get-image --image-build-version-arn "$IMAGE_ARN" \
     --query 'image.state' --output json
   ```

2. Prove the image. Pull it from ECR and run the baseline tool the component installed:

   ```shell
   REPO_URI=$(aws cloudformation describe-stacks --stack-name container-sample \
     --query "Stacks[0].Outputs[?OutputKey=='RepositoryUri'].OutputValue" --output text)
   aws ecr get-login-password | docker login --username AWS --password-stdin "${REPO_URI%%/*}"
   docker run --rm "${REPO_URI}:latest" jq --version
   ```

3. Multi-region replication. Create a same-named repository in a second region, redeploy with the parameter, and rerun the pipeline - the build lands in both regions:

   ```shell
   aws ecr create-repository --repository-name container-sample --region eu-west-1
   aws cloudformation deploy --template-file cloudformation/container-pipeline.yml \
     --stack-name container-sample --capabilities CAPABILITY_IAM \
     --parameter-overrides ReplicaRegion=eu-west-1
   ```

4. Scanning. Redeploy with `EnableScanning=true` (Amazon Inspector must be activated in the account first) and findings for each output image appear in Inspector after the next build.

## Common errors

| Symptom | Cause | Fix |
|---|---|---|
| Build fails at `ApplyBuildComponents`; the docker build dies fetching credentials | The infrastructure configuration requires IMDSv2 with a hop limit of 1 - Docker adds a network hop | Keep `HttpPutResponseHopLimit: 2` (the service default when unset) |
| `You must specify a platform override when using ECR Repositories as your parent image` | Registry URI parents don't declare an OS | Add `PlatformOverride` - and `ImageOsVersionOverride` for Windows |
| `The value supplied for parameter 'parentImage' is not valid. You are not authorized to use the provided image.` | Cross-account ECR parent whose repository policy lacks `ecr:DescribeImages` | Grant the policy shown above in the source account |
| Push fails or the build reports it can't replicate the image, yet the image may be in ECR | Fixed-tag collision on a shared or immutable repository, or missing ECR permissions | One repository per pipeline; check the repository's tag immutability |
| `exec: "/bin/sh": stat /bin/sh: no such file or directory` during the docker build | The parent image has no shell for the generated component steps | Build from a fuller base; produce minimal images with a multi-stage `FROM` after the component variables |

For general build triage - the failure reason on the image, the workflow execution APIs, and getting onto the build instance - see the [debugging kit](../debugging/).

## Cleanup

1. Delete the image build versions: `aws imagebuilder list-image-build-versions --image-version-arn <arn>` (from `aws imagebuilder list-images --owner Self`) enumerates them, and `aws imagebuilder delete-image --image-build-version-arn <arn>` deletes each. Repeat for `container-sample-windows` and `container-sample-cdk`.
2. Delete the stacks - `container-sample`, `container-sample-windows`, and `npx cdk destroy` for the CDK app. The repositories empty themselves on delete; the Linux and CDK log buckets need their object versions and delete markers emptied first (the S3 console's Empty button handles both):

   ```shell
   aws cloudformation delete-stack --stack-name container-sample
   ```

3. If you created a replica-region repository, delete it. If you enabled scanning without the template's `EcrConfiguration`, also delete the `image-builder-image-scanning-repository` the service creates for scan copies.
4. If a build ran recently, the log groups can reappear after deletion while late log deliveries land - delete them again before redeploying the same stack name, or the deploy fails on the name conflict.
