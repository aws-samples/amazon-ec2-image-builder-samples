# AWS EC2 Image Builder CDK Example

This folder contains sample code that demonstrates how to create Amazon EC2 Image Builder resources by leveraging the capability of the [AWS Cloud Development Kit](https://aws.amazon.com/cdk/).

## Requirements

- Node v14.0.0 or above
- Npm 6.14.0 or above
- Docker 20.0.0 or above
- CDK 2.0.0 or above
- AWS account need to be bootstrapped by following the steps in the [CDK Bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html) guide.

## System Configuration

The following settings can be configured before running CDK deployment. Those settings can be found in `cdk.json`

| Configuration Key Name             | Type | Description                                                                                                                                                                                   | Default Value                          | Required |
| ---------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | -------- |
| buildCompletionNotificationEmails  | List | A list of email addresses that will get notification when build is completed                                                                                                                  | [AlejandroRosalez@example.com]         | No       |
| ImageBuilderPipelineConfigurations | List | A list of configuration settings to define the EC2 Image Building pipelines. Each entry in the list defines an Image Building Pipeline (See next Section for more information about this key) | Default settings for a sample pipeline | Yes      |

* notice `AlejandroRosalez@example.com` is a fictious email address for demo purpose, you can replace it with your own email addresses.

## Image Builder Pipeline Configuration

### Define Image Building Pipeline

`ImageBuilderPipelineConfigurations` key is a list of configuration settings that defines the EC2 Image Building Pipelines in the system. Each entry in the list defines one EC2 Image Building Pipeline which will build a particular AMI image based on the recipe. Out of the box, there is only one sample pipeline defined.

Below are the sub-keys available to each entry in `ImageBuilderPipelineConfigurations`

| Configuration Key Name                                 | Type        | Description                                                                                                                                                                                     | Default Value                                           | Required |
| ------------------------------------------------------ | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------- |
| ImageBuilderPipelineConfigurations/name                | string      | Pipeline name                                                                                                                                                                                   | sampleimg                                               | Yes      |
| ImageBuilderPipelineConfigurations/components          | string list | A string array that each entry contains either the directory path that contains the component spec files, or the arn for an AWS Managed component, or a specific path to a component spec file. | ./example-component                                     | Yes      |
| ImageBuilderPipelineConfigurations/instanceProfileName | string      | Instance profile name                                                                                                                                                                           | ImageBuilderInstanceProfile                             | Yes      |
| ImageBuilderPipelineConfigurations/cfnImageRecipeName  | string      | EC2 ImageBuilder recipe name                                                                                                                                                                    | imagebuilder-example-recipe                             | Yes      |
| ImageBuilderPipelineConfigurations/version             | string      | Version of this pipeline                                                                                                                                                                        | 1.0.0                                                   | Yes      |
| ImageBuilderPipelineConfigurations/parentImage         | Map         | Parent image AMI for each region                                                                                                                                                                | a key-value pair specify the base image for each region | Yes      |

### Region specific Parent Image AMI IDs

To update the parent image in Imaging building pipeline definition, it can be done by updating the value of the configuration key `ImageBuilderPipelineConfigurations/parentImage`. Please note that this key is a map with multiple AMI ids for different regions. The same AMI image could have different AMI IDs in different regions, please make sure to update the new AMI IDs for all regions or only specific region depends on your needs.

The follow configuration snippet shows the update of parent AMI to `ami-123` for region `ap-southeast-2`

The latest AMI IDs can be found from [Find a Linux AMI](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/finding-an-ami.html)

```
"ImageBuilderPipelineConfigurations": [
      ...
      {
          "name": "newimagebuilder",
          "components": ["arn:aws:imagebuilder:ap-southeast-2:aws:component/san-sift-linux/1.0.0"],
          "instanceProfileName": "ImageBuilderInstanceProfile",
          "cfnImageRecipeName": "testrecipe10001",
          "version": "1.0.0",
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
          "version": "1.0.7",
          "parentImage": {
              "ap-southeast-2": { "amiID": "ami-0b7dcd6e6fd797935" },
              "ap-southeast-1": { "amiID": "ami-055d15d9cfddf7bd3" },
              "us-east-1": { "amiID": "ami-04505e74c0741db8d" },
              "us-east-2": { "amiID": "ami-0fb653ca2d3203ac1" },
              "us-west-1": { "amiID": "ami-01f87c43e618bf8f0" },
              "us-west-2": { "amiID": "ami-0892d3c7ee96c0bf7" }
          }
      },
      <!-- new pipeline configuration -->
      {
          "name": "newimagebuilder",
          "components": [
                "arn:aws:imagebuilder:ap-southeast-2:aws:component/san-sift-linux/1.0.0",
                "my-component-directory-path",
                "my-other-component/my-component-spec.yaml"
            ],
          "instanceProfileName": "ImageBuilderInstanceProfile",
          "cfnImageRecipeName": "testrecipe10001",
          "version": "1.0.0",
          "parentImage": {
              "ap-southeast-2": { "amiID": "ami-0b7dcd6e6fd797935" },
              "ap-southeast-1": { "amiID": "ami-055d15d9cfddf7bd3" },
              "us-east-1": { "amiID": "ami-04505e74c0741db8d" },
              "us-east-2": { "amiID": "ami-0fb653ca2d3203ac1" },
              "us-west-1": { "amiID": "ami-01f87c43e618bf8f0" },
              "us-west-2": { "amiID": "ami-0892d3c7ee96c0bf7" }
          }
      }
  ]
```

### Managed Components for EC2 ImageBuilder

The new component script must be provided before the new image building pipeline can be added. However, AWS provides large amount of managed components that can be easily used. They can be found from [List and view component details](https://docs.aws.amazon.com/imagebuilder/latest/userguide/component-details.html). To use the AWS managed components, you can specify the ARN of the AWS Managed Component in the `components` list in the Image Builder Pipeline Configuration.

### Output of the Pipeline

After an EC2 Image Builder image pipeline is established after deploying this stack with proper configuration, it will start automatically to build the AMI based on the components specified in the configuration. The pipeline will take a while to complete and when it is completed, the ID of the new AMI that is built can be found in the following locations:

- In the EC2 Image Builder console, select `Image pipelines` from the left navigation bar, then select the pipeline created by this stack, then look under `Output images`.
- A parameter is created in AWS System Manager Parameter Store when deploying the pipeline and named as `imagebuilder_ami_<pipeline name>`. The ID of the new AMI built by the pipeline will be stored in this parameter so that it can be read by other stacks if necessary. Before the pipeline finishes building the AMI, the value of this parameter is `n/a`.

## Deployment

Make sure docker deamon is running before run the following command, also make sure you have the correct credential which is authroized to deploy cloud resource to your account. For more information please see

- `npm install` install all dependency of this sample
- `cdk deploy` deploy this stack to your default AWS account/region
- `cdk deploy -c account=<account> -c region=<region>` deploy this stack to your specific AWS account/region
