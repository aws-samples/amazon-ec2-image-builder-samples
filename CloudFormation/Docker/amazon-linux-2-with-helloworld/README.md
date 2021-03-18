# Amazon Linux 2 Container Image Pipeline with Example "hello world" Component Document

This is a sample template that demonstrates how to use EC2 Image Builder CloudFormation resources to build an Amazon Linux 2 Docker container image with a sample "hello world" component document and then publish the image to the specified Amazon Elastic Container Registry (ECR) repository.

***Internet connectivity is required in your default VPC*** to pull the source image by digest from a Docker Hub repository. If you do not have a default VPC, or want to use a custom VPC, you will need to specify a subnet ID and one or more security group IDs in the VPC as parameters when you create a stack based on this template.

## How this Stack Works

First, the stack will create an [AWS::S3::Bucket](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html) resource that is used to capture logs.

By default, AWS Services do not have permission to perform actions on your instances. So, the stack will create an [AWS::IAM::Role](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html) which grants AWS Systems Manager (SSM) and EC2 Image Builder the necessary permissions to build an image.

The instance also needs access to the bucket created by the stack, so a policy is added to the newly created role that allows the instance to use ```s3:PutObject``` to save logs to the logging bucket.

Then, an [AWS::IAM::InstanceProfile](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-instanceprofile.html) is created, which passes the instance role to the EC2 instance.

Next, an [AWS::ImageBuilder::InfrastructureConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-infrastructureconfiguration.html) resource is created, and the Instance Profile is specified as one of its parameters. This parameter tells EC2 Image Builder to use the specified profile with the EC2 instance during the build.

The [AWS::ImageBuilder::ContainerRecipe](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-containerrecipe.html) ties together the amazonlinux:latest parent image and the sample "hello world" component. This example demonstrates using the Dockerfile template default settings, which provides variables for your parent image, environments, and components. These variables will be replaced with Image Builder generated scripts at build time.

The resource [AWS::ImageBuilder::DistributionConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-distributionconfiguration.html) allows you to specify the name and description of your output container image and settings for tagging and sharing to a target ECR repository in a specific region.

The [AWS::ImageBuilder::Image](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-image.html) represents the built image.

**Note:** *Optionally, you can uncomment the [AWS::ImageBuilder::ImagePipeline](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-imagepipeline.html), which creates an automation pipeline for your container image builds. The pipeline is associated with the container recipe and can also be associated with an infrastructure configuration and distribution configuration. You can also use a schedule to configure how often and when a pipeline will automatically create a new image. In this example, the pipeline is scheduled to run a build at 9:00AM Coordinated Universal Time (UTC) on the first day of every month.*

## Walkthrough

It takes approximately 20 minutes for the stack build to complete.

This solution can be deployed using both the AWS Management Console or the Command Line Interface (CLI). 

### AWS Management Console:
1. Upload the ```amazon-linux-2-container-image.yml``` template to CloudFormation.
2. You will see a checkbox informing you that the stack creates IAM resources. Read and check the box.
3. Wait for the stack to build.
4. Note the AWS::ImageBuilder::Image resource ```IBImage``` will show ```CREATE_IN_PROGRESS``` while the image is being created, and will later show ```CREATE_COMPLETE``` when complete.

### CLI:
1. Ensure that your YAML template and JSON parameters file are located within your current directory.
2. Modify the parameters in ```amazon-linux-2-container-image.json``` as necessary.
3. Run the following command from your terminal:
```
aws cloudformation create-stack \
--stack-name sample-ec2-ib-container-image \
--template-body file://amazon-linux-2-container-image.yml \
--parameters file://amazon-linux-2-container-image.json \
--capabilities CAPABILITY_NAMED_IAM \
--region us-east-1
```

## Troubleshooting

While the stack is building, you will see an EC2 instance running. This is either the build or test instance. AWS Systems Manager (SSM) Automation will also run. You can observe this automation to see the steps EC2 Image Builder takes to build your image.

If the stack fails, check the CloudFormation events. These events include a description of any failed resources.

## Cleanup

To delete the resources created by the stack:

1. Delete the contents of the S3 bucket created by the stack (if the bucket is not empty, the stack deletion will fail). To keep the bucket, add a ```Retain``` deletion policy to the CloudFormation bucket resource. See https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html for more information on ```DeletionPolicy``` attributes.
2. Delete the container image within your ECR repository created by the stack (if the repo is not empty, the stack deletion will fail).
3. Delete the stack in the CloudFormation console, or by using the CLI/SDK.
