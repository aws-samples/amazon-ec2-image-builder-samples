# Amazon Linux 2 with the Amazon SSM Agent upgraded to the latest version

This is a sample template that demonstrates how to use the EC2 Image Builder CloudFormation resources to build an Amazon Linux 2 Amazon Machine Image (AMI) with the latest version of the Amazon SSM Agent installed.

This templated uses the [UserDataOverride](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-imagebuilder-imagerecipe-additionalinstanceconfiguration.html) capability in an Image Recipe to upgrade the Amazon SSM Agent.

***Internet connectivity is required in your default VPC*** to download the Amazon SSM Agent installation files. If you do not have a default VPC, you will need to specify a subnet ID in the infrastructure configuration section of the CloudFormation template.

## How this Stack Works

First, the stack will create an [AWS::S3::Bucket](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html) resource that is used to capture logs.

By default, AWS Services do not have permission to perform actions on your instances. So, the stack will create an [AWS::IAM::Role](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html) which grants AWS Systems Manager (SSM) and EC2 Image Builder the necessary permissions to build an image.

The instance also needs access to the bucket created by the stack, so a policy is added to the newly created role that allows the instance to use ```s3:PutObject``` to save logs to the logging bucket.

Then, an [AWS::IAM::InstanceProfile](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-instanceprofile.html) is created, which passes the instance role to the EC2 instance.

Next, an [AWS::ImageBuilder::InfrastructureConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-infrastructureconfiguration.html) resource is created, and the Instance Profile is specified as one of its parameters. This parameter tells EC2 Image Builder to use the specified profile with the EC2 ]instance during the build.

The [AWS::ImageBuilder::ImageRecipe](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-imagerecipe.html) ties together the Windows Server parent image and the customer userdata to upgrade the SSM Agent.

The [AWS::ImageBuilder::Image](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-image.html) represents the built image.

Finally, the image resource is used to create an [AWS::SSM::Parameter](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ssm-parameter.html) that has the image id as the value. We could just as easily have updated a launch configuration for an Auto Scaling group, or passed the attribute to other CloudFormation resources that reference the Image Id of an AMI.

## Walkthrough

It takes approximately 30 minutes for the stack build to complete.

1. Upload the ```amazon-linux-2-with-latest-ssm-agent.yml``` template to CloudFormation.
2. You will see a checkbox informing you that the stack creates IAM resources. Read and check the box.
3. Wait for the stack to build.
4. Note the AWS::ImageBuilder::Image resource ```AmazonLinux2WithLatestSSMAgent``` will show ```CREATE_IN_PROGRESS``` while the image is being created, and will later show ```CREATE_COMPLETE``` when complete.

## Troubleshooting

While the stack is building, you will see an EC2 instance running. This is the build instance. AWS Systems Manager (SSM) Automation will also run. You can observe this automation to see the steps EC2 Image Builder takes to build your image.

If the stack fails, check the CloudFormation events. These events include a description of any failed resources.

## Cleanup

To delete the resources created by the stack:

1. Delete the contents of the S3 bucket created by the stack (if the bucket is not empty, the stack deletion will fail). To keep the bucket, add a ```Retain``` deletion policy to the CloudFormation bucket resource. See https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html for more information on ```DeletionPolicy``` attributes.
2. Delete the stack in the CloudFormation console, or by using the CLI/SDK.
3. You must delete any AMIs created by the stack. You can use the EC2 console, CLI, or SDK to delete the AMIs. Note that deleting the CloudFormation stack will NOT delete the AMIs created by the stack.
