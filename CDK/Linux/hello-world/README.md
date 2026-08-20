# AWS EC2 Image Builder CDK Example

This folder contains sample code that demonstrates how to create Amazon EC2 Image Builder resources by leveraging the capability of the [AWS Cloud Development Kit](https://aws.amazon.com/cdk/).

## Requirements

- Node v20.0.0 or above
- Npm 10.0.0 or above
- AWS account need to be bootstrapped by following the steps in the [CDK Bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) guide.

## System Configuration

The following settings can be configured before running CDK deployment. Those settings can be found in `cdk.json`

| Configuration Key Name             | Type | Description                                                                                                                                                                                   | Default Value                          | Required |
| ---------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------- |
| buildCompletionNotificationEmails  | List | A list of email addresses that will get notification when build is completed                                                                                                                  | [AlejandroRosalez@example.com]         | No       |
| ImageBuilderPipelineConfigurations | List | A list of configuration settings to define the EC2 Image Building pipelines. Each entry in the list defines an Image Building Pipeline (See next Section for more information about this key) | Default settings for a sample pipeline | Yes      |
| vpcId                              | String | The VPC to place build instances in. If subnetId isn't also set, the VPC's first public subnet is used. Without it, the stack uses your account's default VPC                                                                                                  | (default VPC)                          | No       |
| subnetId                           | String | The subnet for build instances. It needs a network path to Systems Manager and S3 - internet access, or the SSM and S3 VPC endpoints for private subnets. Set together with vpcId. Without it, the stack picks the first public subnet | (first public subnet)  | No       |

* notice `AlejandroRosalez@example.com` is a fictious email address for demo purpose, you can replace it with your own email addresses.

## Image Builder Pipeline Configuration

### Define Image Building Pipeline

`ImageBuilderPipelineConfigurations` key is a list of configuration settings that defines the EC2 Image Building Pipelines in the system. Each entry in the list defines one EC2 Image Building Pipeline which will build a particular AMI image based on the recipe. Out of the box, there is only one sample pipeline defined.

Below are the sub-keys available to each entry in `ImageBuilderPipelineConfigurations`

| Configuration Key Name                                 | Type        | Description                                                                                                                                                                                     | Default Value                                           | Required |
| ------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------- |
| ImageBuilderPipelineConfigurations/name                | string      | Pipeline name                                                                                                                                                                                   | sampleimg                                               | Yes      |
| ImageBuilderPipelineConfigurations/components          | string list | A string array where each entry is an AWS managed component as name/version (for example `update-linux/x.x.x`) or full ARN, a directory path containing component spec files, or a path to a single component spec file. | ./example-component                                     | Yes      |
| ImageBuilderPipelineConfigurations/instanceProfileName | string      | Instance profile name                                                                                                                                                                           | ImageBuilderInstanceProfile                             | Yes      |
| ImageBuilderPipelineConfigurations/cfnImageRecipeName  | string      | EC2 ImageBuilder recipe name                                                                                                                                                                    | imagebuilder-example-recipe                             | Yes      |
| ImageBuilderPipelineConfigurations/version             | string      | Recipe version. An `x` segment (for example `1.0.x`) auto-increments, so recipe changes deploy without a manual version bump                                                                    | 1.0.x                                                   | Yes      |
| ImageBuilderPipelineConfigurations/parentImage         | Map         | Parent image AMI for each region                                                                                                                                                                | a key-value pair specify the base image for each region | Yes      |
| ImageBuilderPipelineConfigurations/runPipelineOnDeploy | Boolean     | Run the pipeline as part of the deployment, which then waits for the image build - typically 15 to 30 minutes (see Running the Pipeline below). When false, deploying only creates the pipeline                | false                                                   | No       |
| ImageBuilderPipelineConfigurations/debug         | Boolean (False)        | Debug needed                                                                                                                                                           | Builder instance stay accessible when true(ssm)   | False      |
| ImageBuilderPipelineConfigurations/storageSize         | Number (128)        | Builder root device storage size (128 GB)                                                                                                                                                      | recommend size no less than 64GB due to the space needed for log and installation   | False      |

Note: by default the builder instance will be terminated regardless the execution result, this makes the troubleshooting very difficult if not impossible. In case you'd like to analyse the root cause for you build failure, please turn ImageBuilderPipelineConfigurations/debug to true. This will allow you to connect into the builder instance.

### Region specific Parent Image AMI IDs

The parent image each pipeline builds on comes from the configuration key `ImageBuilderPipelineConfigurations/parentImage` - a map with one entry per region, because the same image has a different identifier in every region.

The sample configuration references the Image Builder managed Ubuntu 22.04 image with an `x.x.x` wildcard version, such as `arn:aws:imagebuilder:ap-southeast-2:aws:image/ubuntu-server-22-lts-x86/x.x.x` for region `ap-southeast-2`. The wildcard resolves to the latest release of that image on every build, so the pipeline picks up new base images without configuration changes. You can also set a specific AMI ID (`ami-...`) per region if you need to pin the base image - see [Find a Linux AMI](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/finding-an-ami.html).

```
"ImageBuilderPipelineConfigurations": [
      ...
      {
          "name": "newimagebuilder",
          "components": ["san-sift-linux/x.x.x"],
          "instanceProfileName": "ImageBuilderInstanceProfile",
          "cfnImageRecipeName": "testrecipe10001",
          "version": "1.0.x",
          "parentImage": {
              "ap-southeast-2": { "amiID": "ami-123" },
                ...
          }
      }
  ]
```

### Adding More Image Building Pipelines

To add more image building pipelines so that multiple AMI images can be built in parallel, a new entry can be added in the list `ImageBuilderPipelineConfigurations`

Below are an example of the value in `ImageBuilderPipelineConfigurations` key that shows a new image building pipeline named `newimagebuilder` along with the existing sample pipeline. The new image building pipeline reads its components from the directory `./image-builder`, where the component scripts for the new pipeline is located.

```
"ImageBuilderPipelineConfigurations": [
     <!-- default pipeline configuration -->
      {
          "name": "imagebuilder-example",
          "components": ["example-component"],
          "instanceProfileName": "ImageBuilderInstanceProfile",
          "cfnImageRecipeName": "standalone-testrecipe02",
          "version": "1.0.x",
          "parentImage": {
              "ap-southeast-2": { "amiID": "arn:aws:imagebuilder:ap-southeast-2:aws:image/ubuntu-server-22-lts-x86/x.x.x" },
              "ap-southeast-1": { "amiID": "arn:aws:imagebuilder:ap-southeast-1:aws:image/ubuntu-server-22-lts-x86/x.x.x" },
              "us-east-1": { "amiID": "arn:aws:imagebuilder:us-east-1:aws:image/ubuntu-server-22-lts-x86/x.x.x" },
              "us-east-2": { "amiID": "arn:aws:imagebuilder:us-east-2:aws:image/ubuntu-server-22-lts-x86/x.x.x" },
              "us-west-1": { "amiID": "arn:aws:imagebuilder:us-west-1:aws:image/ubuntu-server-22-lts-x86/x.x.x" },
              "us-west-2": { "amiID": "arn:aws:imagebuilder:us-west-2:aws:image/ubuntu-server-22-lts-x86/x.x.x" }
          }
      },
      <!-- new pipeline configuration -->
      {
          "name": "newimagebuilder",
          "components": [
                "san-sift-linux/x.x.x",
                "my-component-directory-path",
                "my-other-component/my-component-spec.yaml"
            ],
          "instanceProfileName": "ImageBuilderInstanceProfile",
          "cfnImageRecipeName": "testrecipe10001",
          "version": "1.0.x",
          "parentImage": {
              "ap-southeast-2": { "amiID": "arn:aws:imagebuilder:ap-southeast-2:aws:image/ubuntu-server-22-lts-x86/x.x.x" },
              "ap-southeast-1": { "amiID": "arn:aws:imagebuilder:ap-southeast-1:aws:image/ubuntu-server-22-lts-x86/x.x.x" },
              "us-east-1": { "amiID": "arn:aws:imagebuilder:us-east-1:aws:image/ubuntu-server-22-lts-x86/x.x.x" },
              "us-east-2": { "amiID": "arn:aws:imagebuilder:us-east-2:aws:image/ubuntu-server-22-lts-x86/x.x.x" },
              "us-west-1": { "amiID": "arn:aws:imagebuilder:us-west-1:aws:image/ubuntu-server-22-lts-x86/x.x.x" },
              "us-west-2": { "amiID": "arn:aws:imagebuilder:us-west-2:aws:image/ubuntu-server-22-lts-x86/x.x.x" }
          }
      }
  ]
```

### Managed Components for EC2 ImageBuilder

The new component script must be provided before the new image building pipeline can be added. However, AWS provides large amount of managed components that can be easily used. They can be found from [List and view component details](https://docs.aws.amazon.com/imagebuilder/latest/userguide/component-details.html). To use the AWS managed components, you can specify the ARN of the AWS Managed Component in the `components` list in the Image Builder Pipeline Configuration. Managed component ARNs are regional - the region in the ARN must match the region you deploy the stack to.

### Running the Pipeline

By default, deploying the stack creates the pipeline but doesn't start a build - run the pipeline from the EC2 Image Builder console (Actions -> Run pipeline) or with:

```shell
aws imagebuilder start-image-pipeline-execution --image-pipeline-arn <pipeline arn>
```

Alternatively, set `runPipelineOnDeploy` to `true` in the pipeline's configuration to run the pipeline as part of the deployment. The stack then contains an `AWS::ImageBuilder::Image` resource whose `ImagePipelineExecutionSettings` references the pipeline's deployment ID, and CloudFormation waits for the build to complete before the deployment finishes - expect the deploy to take 15 to 30 minutes. Because the image sets `OnUpdate`, any later deployment that changes the pipeline's configuration (a new component version, a recipe change) runs the pipeline again and builds a fresh image, while no-op deployments don't trigger builds.

### Output of the Pipeline

The build typically takes 15 to 30 minutes. When it completes, the new AMI ID can be found in:

- The EC2 Image Builder console: select `Image pipelines` from the left navigation bar, then the pipeline created by this stack, then look under `Output images`.
- AWS Systems Manager Parameter Store, under `/imagebuilder/<pipeline name>/latest-ami`. The pipeline's distribution configuration writes the parameter on every build, so downstream stacks and launch templates can always resolve the latest AMI. The parameter path matters: the Image Builder service-linked role can only write parameters under `/imagebuilder/`.

## Deployment

Make sure your AWS credentials are set up and authorized to deploy resources to your account, then run:

- `npm install` to install the dependencies
- `npx cdk deploy` to deploy the stack to your default AWS account and region
- `npx cdk deploy -c account=<account> -c region=<region>` to deploy to a specific account and region
- Add `-c vpcId=<vpc-id> -c subnetId=<subnet-id>` to build in your own VPC instead of the default VPC

## Cleanup

Run `npx cdk destroy` to delete the stack. Resources created by pipeline builds live outside the stack and need separate cleanup:

- Images built by the pipeline: in the EC2 Image Builder console, select the pipeline's output images and delete them, or use `aws imagebuilder delete-image --image-build-version-arn <arn>` for each build.
- The AMIs and their EBS snapshots: deregister the AMIs and delete the associated snapshots in the EC2 console. Deleting the Image Builder image resource does not remove them.
- The `/imagebuilder/<pipeline name>/latest-ami` SSM parameter written by the distribution configuration.
