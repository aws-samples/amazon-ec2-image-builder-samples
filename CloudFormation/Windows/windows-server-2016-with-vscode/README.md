# Windows Server 2016 Image with Visual Studio Code Installed

This is a sample template that demonstrates how to use the EC2 Image Builder CloudFormation resources to build a Windows Server 2016 Amazon Machine Image (AMI) with Visual Studio Code installed.

This template works in standard, China, and GovCloud (US) regions.

***Internet connectivity is required in your default VPC*** to download Visual Studio Code installation files. If you do not have a default VPC, you will need to specify a subnet ID in the infrastructure configuration section of the CloudFormation template.

## How this Stack Works

First, the stack will create an [AWS::S3::Bucket](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html) resource that we will use to capture logs.

By default, AWS Services do not have permission to perform actions on your instances. So, the stack will create an [AWS::IAM::Role](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html) which grants AWS Systems Manager (SSM) and EC2 Image Builder the necessary permissions to build an image.

The instance also needs access to the bucket created by the stack, so we will add a policy to the newly created role, which will allow the instance to use ```s3:PutObject``` to save logs to our logging bucket.

Then, an [AWS::IAM::InstanceProfile](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-instanceprofile.html) is created, which passes the instance role to the EC2 instance.

Next, an [AWS::ImageBuilder::InfrastructureConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-infrastructureconfiguration.html) resource is created, and the Instance Profile is specified as one of its parameters. This is what tells EC2 Image Builder to use that profile with the EC2 Instance during the build.

To install Visual Studio Code, we use a custom [AWS::ImageBuilder::Component](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-component.html) with the PowerShell commands that download and install the application. The Component includes a simple validation step, along with a test step. This ensures Visual Studio Code is installed and can be run from the PowerShell command line.

The [AWS::ImageBuilder::ImageRecipe](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-imagerecipe.html) ties together the Windows Server 2016 parent image and the Visual Studio Code component.

The [AWS::ImageBuilder::Image](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-image.html) represents the image we have built.

Finally, we will use the Image resource to create an [AWS::SSM::Parameter](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ssm-parameter.html) which will have the image id as the value. We could just as easily have updated a Launch Configuration for an Auto Scaling Group, or passed the attribute to other CloudFormation resources which reference an AMIs Image Id.

## Walkthrough

The stack should take approximately 30 minutes to complete.

1. Upload the ```windows-server-2016-with-vscode.yml``` template to CloudFormation.
2. You will see a checkbox informing you that the stack creates IAM resources, read and check the box.
3. Watch the stack build.
4. Note the AWS::ImageBuilder::Image resource ```WindowServer2016WithVisualStudioCode``` will show ```CREATE_IN_PROGRESS``` while the image is being created, and will later show ```CREATE_COMPLETE``` once it is done.

## Troubleshooting

While the stack is building, you will see an EC2 instance running which is the build instance. There will also be AWS Systems Manager (SSM) Automation runningm, you can watch this
automation to see the steps EC2 Image Builder is taking to build your image.

If the stack fails, check the CloudFormation events which should include a description of any failed resources.

## Cleanup

To delete the resources created by the stack:

1. Delete the contents of the S3 bucket created by the stack (if the bucket is not empty, the stack delete will fail). To keep the bucket, add ```retain``` to the bucket's CloudFormation.
2. Delete the stack in the CloudFormation console, or using the CLI/SDK.
3. For any AMIs created by the stack, you'll need to delete those by using the EC2 console, CLI, or SDK (Deleting the CloudFormation stack will NOT delete the AMIs created by the stack).
