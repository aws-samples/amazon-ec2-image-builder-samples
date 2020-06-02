# Windows Server 2016 Image with Visual Studio Code Installed

This is a sample template that demonstrates how to use the EC2 Image Builder CloudFormation resources to build a Windows Server 2016 Amazon Machine Image (AMI) with Visual Studio Code installed.

This template works in standard and GovCloud (US) regions.

***Internet connectivity is required in your default VPC*** to download Visual Studio Code installation files. If you do not have a default VPC, you will need to specify a subnet ID in the infrastructure configuration section of the CloudFormation template.

## How this Stack Works

First, the stack will create an [AWS::S3::Bucket](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html) resource that is used to capture logs.

By default, AWS Services do not have permission to perform actions on your instances. So, the stack will create an [AWS::IAM::Role](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html) which grants AWS Systems Manager (SSM) and EC2 Image Builder the necessary permissions to build an image.

The instance also needs access to the bucket created by the stack, so a policy is added to the newly created role that allows the instance to use ```s3:PutObject``` to save logs to the logging bucket.

Then, an [AWS::IAM::InstanceProfile](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-instanceprofile.html) is created, which passes the instance role to the EC2 instance.

Next, an [AWS::ImageBuilder::InfrastructureConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-infrastructureconfiguration.html) resource is created, and the Instance Profile is specified as one of its parameters. This parameter tells EC2 Image Builder to use the specified profile with the EC2 ]instance during the build.

To install Visual Studio Code, a custom [AWS::ImageBuilder::Component](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-component.html) is used with the PowerShell commands that download and install the application. The component includes a simple validation step, along with a test step. These steps ensure that Visual Studio Code is installed and can be run from the PowerShell command line.

The [AWS::ImageBuilder::ImageRecipe](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-imagerecipe.html) ties together the Windows Server 2016 parent image and the Visual Studio Code component.

The [AWS::ImageBuilder::Image](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-image.html) represents the built image.

Finally, the image resource is used to create an [AWS::SSM::Parameter](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ssm-parameter.html) that has the image id as the value. We could just as easily have updated a launch configuration for an Auto Scaling group, or passed the attribute to other CloudFormation resources that reference the Image Id of an AMI.

## Walkthrough

It takes approximately 30 minutes for the stack build to complete.

1. Upload the ```windows-server-2016-with-vscode.yml``` template to CloudFormation.
2. You will see a checkbox informing you that the stack creates IAM resources. Read and check the box.
3. Wait for the stack to build.
4. Note the AWS::ImageBuilder::Image resource ```WindowServer2016WithVisualStudioCode``` will show ```CREATE_IN_PROGRESS``` while the image is being created, and will later show ```CREATE_COMPLETE``` when complete.

## Troubleshooting

While the stack is building, you will see an EC2 instance running. This is the build instance. AWS Systems Manager (SSM) Automation will also run. You can observe this automation to see the steps EC2 Image Builder takes to build your image.

If the stack fails, check the CloudFormation events. These events include a description of any failed resources.

## Cleanup

To delete the resources created by the stack:

1. Delete the contents of the S3 bucket created by the stack (if the bucket is not empty, the stack deletion will fail). To keep the bucket, add a ```Retain``` deletion policy to the CloudFormation bucket resource. See https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html for more information on ```DeletionPolicy``` attributes.
2. Delete the stack in the CloudFormation console, or by using the CLI/SDK.
3. You must delete any AMIs created by the stack. You can use the EC2 console, CLI, or SDK to delete the AMIs. Note that deleting the CloudFormation stack will NOT delete the AMIs created by the stack.
