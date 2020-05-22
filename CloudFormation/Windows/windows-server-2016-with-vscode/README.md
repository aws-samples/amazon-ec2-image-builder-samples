# Windows Server 2016 Image with Visual Studio Code Installed

This is a sample CloudFormation template that demonstrates how to use the [AWS::ImageBuilder::Image resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-imagerecipe.html) and build a Windows Server 2016 Amazon Machine Image (AMI) with Visual Studio Code installed. The install of Visual Studio Code is handled by a custom [component](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-component.html) which is also created with this CloudFormation template. The component includes a simple validation step, along with a test step to ensure code is installed and can be run from the PowerShell command line.

## Walkthrough

1. Upload the ```windows-server-2016-with-vscode.yml``` template to CloudFormation, and watch the stack build. Expect it to take approximately 30 minutes to complete.
2. The AWS::ImageBuilder::Image resource ```WindowServer2016WithVisualStudioCode``` will show ```CREATE_IN_PROGRESS``` while the image is being created, and will later show ```CREATE_COMPLETE``` once it is done.
