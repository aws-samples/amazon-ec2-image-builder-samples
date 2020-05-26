# Windows Server 2016 Image with Visual Studio Code Installed

This is a sample CloudFormation template that demonstrates how to use the [AWS::ImageBuilder::Image resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-imagerecipe.html) to build a Windows Server 2016 Amazon Machine Image (AMI) with Visual Studio Code installed.

## How this Stack Works

By default, AWS Services do not have permission to perform actions on your instances. So, first the stack will create an [AWS::IAM::Role]() resource which grants AWS Systems Manager (SSM) and EC2 Image Builder the necessary permissions to build an image. Then, an [AWS::IAM::InstanceProfile]() is created, which passes the instance role to the EC2 instance.

Next, an [AWS::ImageBuilder::InfrastructureConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-infrastructureconfiguration.html) resource is created, and the Instance Profile is specified as one of its parameters. This is what tells EC2 Image Builder to use that profile with the EC2 Instance during the build.

To install Visual Studio Code, we use a custom [AWS::ImageBuilder::Component](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-component.html) with the PowerShell commands that download and install the application. The Component includes a simple validation step, along with a test step. This ensures Visual Studio Code is installed and can be run from the PowerShell command line.

Finally, the [AWS::ImageBuilder::ImageRecipe]()

## Walkthrough

1. Upload the ```windows-server-2016-with-vscode.yml``` template to CloudFormation, and watch the stack build. Expect it to take approximately 30 minutes to complete.
2. The AWS::ImageBuilder::Image resource ```WindowServer2016WithVisualStudioCode``` will show ```CREATE_IN_PROGRESS``` while the image is being created, and will later show ```CREATE_COMPLETE``` once it is done.

## Cleanup

1. To delete the resources created by the stack, you can delete the stack in the CloudFormation console, or using the CLI/SDK.
2. For any AMIs created by the stack, you'll need to delete those by using the EC2 console, CLI, or SDK (Deleting the CloudFormation stack will NOT delete the AMIs created by the stack).
