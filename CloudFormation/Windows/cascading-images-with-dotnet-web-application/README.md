# Windows cascading Image Pipeline for hosting a .NET web application

This is a set of sample templates that demonstrate how to use EC2 Image Builder CloudFormation resources to build a set of cascading Windows images. The first image is a baseline image, while the second image is build from the first, and can host a .NET web application.

***Internet connectivity is required in your default VPC*** to pull the source image by digest from a Docker Hub repository. If you do not have a default VPC, or want to use a custom VPC, you will need to specify a subnet ID and one or more security group IDs in the VPC as parameters when you create a stack based on this template.

## How the Stacks Work

### Stack 1: Windows Baseline Image

This stack will create an image pipeline that outputs a baseline Windows Image.

### Stack 2: Windows .NET Application Stack

This stack will use the first image as it's source, and create a stack that can host a .NET Application.

### Resources Contained in both Stacks

Both stacks use a similar set of CloudFormation resources, with minor adjustments.

First, both stacks will create an [AWS::S3::Bucket](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html) resource that is used to capture logs.

By default, AWS Services do not have permission to perform actions on your instances. So, the stack will create an [AWS::IAM::Role](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html) which grants AWS Systems Manager (SSM) and EC2 Image Builder the necessary permissions to build an image.

The instance also needs access to the bucket created by the stack, so a policy is added to the newly created role that allows the instance to use ```s3:PutObject``` to save logs to the logging bucket.

Then, an [AWS::IAM::InstanceProfile](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-instanceprofile.html) is created, which passes the instance role to the EC2 instance.

An [AWS::ImageBuilder::InfrastructureConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-infrastructureconfiguration.html) resource is created, and the Instance Profile is specified as one of its parameters. This parameter tells EC2 Image Builder to use the specified profile with the EC2 instance during the build.

The [AWS::ImageBuilder::ContainerRecipe](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-containerrecipe.html) ties together the Ubuntu 18.04 parent image, the .NET runtime, and the custom component. This example demonstrates using the Dockerfile template default settings, which provides variables for your parent image, environments, and components. These variables will be replaced with Image Builder generated scripts at build time.

The resource [AWS::ImageBuilder::DistributionConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-distributionconfiguration.html) allows you to specify the name and description of your output container image and settings for tagging and sharing to a target ECR repository in a specific region.

The [AWS::ImageBuilder::ImagePipeline](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-imagepipeline.html) creates an automation pipeline for your container image builds. The pipeline is associated with the container recipe and can also be associated with an infrastructure configuration and distribution configuration. You can also use a schedule to configure how often and when a pipeline will automatically create a new image. In this example, the pipeline is scheduled to run a build at 10:00AM Coordinated Universal Time (UTC), every day. The build will only run if dependent resources have been updated.

As these stacks will export an Image ARN, the Image name must be converted to lowercase. A custom Lambda resource is used to do that. Therefore, an [AWS::Lambda::Function](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html) resource is created to convert an input parameter to lowercase. Related resources, including an [AWS::Logs::LogGroup](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-loggroup.html) resource and an [AWS::IAM::Role](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html) resource are created to allow the Lambda Function access to execution, and to control it's CloudWatch LogGroup.

Next, the Lambda Function is executed using a [Cloudformation Custom Resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-custom-resources.html) (the *Custom::Lowercase* resource in the stacks).

### Resources Specific to the .NET Application Stack

Specific to the second stack are two [AWS::ImageBuilder::Component](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-component.html) resources.

The first installs NSSM, the [Non-Sucking Service Manager](https://nssm.cc/). This will be used to create a custom Windows Service for the .NET web application.

The second will download the compressed .NET web application from S3, and install it ready for use.

## Walkthrough

It takes approximately 120-150 minutes to complete the walkthrough.

This solution can be deployed using both the AWS Management Console or the Command Line Interface (CLI).

Before deploying the stacks, a .NET web application must first be created and uploaded to an S3 Bucket.

### Creating the .NET web application

First, install the latest .NET SDK from the [Download .NET 5.0](https://dotnet.microsoft.com/download/dotnet/5.0) website.

Next, create a .NET web application. As this is a sample, we will not be using https, although that is recommended for production use.

```shell
dotnet new webApp -o sample-web-application --no-https
cd sample-web-application
```

The ```Program.cs``` file needs to be updated to listen on all network interfaces. For example, the following addition will enable the application to listen on TCP/5000.

In the `Program.cs` file, add ```webBuilder.UseUrls("http://*:5000");``` after the `UserStartup<>` line. The `CreateDefaultBuilder` should include content similar to this:

```cs
                .ConfigureWebHostDefaults(webBuilder =>
                {
                    webBuilder.UseStartup<Startup>();
                    webBuilder.UseUrls("http://*:5000");
                });
```

Next, the .NET application needs to be compiled for Windows.

```shell
dotnet publish --configuration release --runtime win-x64
```

The compiled application should exist in the ```./bin/release/net5.0/win-x64/publish``` folder. The next step is to compress the files and upload them to an existing S3 Bucket. The following commands will create a ```.zip``` file, and using the AWS CLI, upload it to an S3 Bucket. Note, the S3 Bucket name needs to be updated.

```shell
cd bin/release/net5.0/win-x64/publish
zip -r ~/sample-web-application.zip .
aws s3 cp ~/sample-web-application.zip s3://< Insert your bucket name here >/sample-web-application.zip
```

Next, update the CloudFormation parameters .json file (```windows-dotnet-application-stack.json```) with the S3 object used in the AWS CLI command.

### Deploying the Stacks

To deploy each of the stacks, starting with the baseline stack, the follow instructions can be followed.

After deploying the baseline stack, the pipeline must be executed to create the baseline image before deploying the second stack.

#### AWS Management Console

**Note:** Replace ```windows-baseline-stack``` with ```windows-dotnet-application-stack``` when deploying the .NET application stack.

1. Upload the ```windows-baseline-stack.yml``` template to CloudFormation.
2. Update the stack parameters as desired, ensuring the ```DotnetS3SourceTarFile``` parameter in the second stack points to the S3 location used when uploading the .NET web application to S3.
3. You will see a checkbox informing you that the stack creates IAM resources. Read and check the box.
4. Wait for the stack to build.
5. Once built, a new Image Builder pipeline will exist. You can view this in the Image Builder console, and optionally trigger a manual execution of the pipeline to start the first image creation.

#### AWS CLI

**Note:** Replace ```windows-baseline-stack``` with ```windows-dotnet-application-stack``` when deploying the .NET application stack.

1. Ensure that your YAML template and JSON parameters file are located within your current directory.
2. Modify the parameters in ```windows-baseline-stack.json``` as necessary.
3. Run the following command from your terminal:

```shell
aws cloudformation create-stack \
--stack-name sample-windows-baseline-stack \
--template-body file://windows-baseline-stack.yml \
--parameters file://windows-baseline-stack.json \
--capabilities CAPABILITY_NAMED_IAM \
--region us-east-1
```

### Creating the Images

To create the images, after deploying the stacks, navigate to the EC2 Image Builder console, then select Image pipelines from the side navigation. Click to enter the newly created pipeline. Under the Actions menu, select "Run pipeline".

## Troubleshooting

While the stack is building, you will see an EC2 instance running. This is either the build or test instance. AWS Systems Manager (SSM) Automation will also run. You can observe this automation to see the steps EC2 Image Builder takes to build your image.

If the stack fails, check the CloudFormation events. These events include a description of any failed resources.

## Cleanup

To delete the resources created by the stack:

1. Delete the contents of the S3 bucket created by the stack (if the bucket is not empty, the stack deletion will fail). To keep the bucket, add a ```Retain``` deletion policy to the CloudFormation bucket resource. See [DeletionPolicy attribute](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html) for more information.
2. Delete the container image within your ECR repository created by the stack (if the repository is not empty, the stack deletion will fail).
3. Delete the stack in the CloudFormation console, or by using the CLI/SDK.
