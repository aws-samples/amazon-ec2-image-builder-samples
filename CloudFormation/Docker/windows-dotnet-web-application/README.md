# Windows Server 2019 Container Image Pipeline for hosting a .NET web application

This is a sample template that demonstrates how to use EC2 Image Builder CloudFormation resources to build an Windows Server 2019 Docker container image that can host a .NET web application. The image will be published to the specified Amazon Elastic Container Registry (ECR) repository.

***Internet connectivity is required in your default VPC*** to pull the source image by digest from a Docker Hub repository. If you do not have a default VPC, or want to use a custom VPC, you will need to specify a subnet ID and one or more security group IDs in the VPC as parameters when you create a stack based on this template.

## How this Stack Works

First, the stack will create an [AWS::S3::Bucket](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html) resource that is used to capture logs.

By default, AWS Services do not have permission to perform actions on your instances. So, the stack will create an [AWS::IAM::Role](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html) which grants AWS Systems Manager (SSM) and EC2 Image Builder the necessary permissions to build an image.

The instance also needs access to the bucket created by the stack, so a policy is added to the newly created role that allows the instance to use ```s3:PutObject``` to save logs to the logging bucket.

Then, an [AWS::IAM::InstanceProfile](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-instanceprofile.html) is created, which passes the instance role to the EC2 instance.

An [AWS::ImageBuilder::InfrastructureConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-infrastructureconfiguration.html) resource is created, and the Instance Profile is specified as one of its parameters. This parameter tells EC2 Image Builder to use the specified profile with the EC2 instance during the build.

Next, the stack will create an [AWS::ECR::Repository](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-ecr-repository.html) resource. This Amazon Elastic Container Registry (ECR) will hold the resulting container image.

The [AWS::ImageBuilder::Component](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-component.html) will download the compressed .NET web application from S3, and install it in the Docker image ready for use.

The [AWS::ImageBuilder::ContainerRecipe](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-containerrecipe.html) ties together the Windows Server 2019 parent image, the .NET runtime, and the custom component. This example demonstrates using the Dockerfile template default settings, which provides variables for your parent image, environments, and components. These variables will be replaced with Image Builder generated scripts at build time.

The resource [AWS::ImageBuilder::DistributionConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-distributionconfiguration.html) allows you to specify the name and description of your output container image and settings for tagging and sharing to a target ECR repository in a specific region.

The [AWS::ImageBuilder::ImagePipeline](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-imagepipeline.html) creates an automation pipeline for your container image builds. The pipeline is associated with the container recipe and can also be associated with an infrastructure configuration and distribution configuration. You can also use a schedule to configure how often and when a pipeline will automatically create a new image. In this example, the pipeline is scheduled to run a build at 10:00AM Coordinated Universal Time (UTC), every day. The build will only run if dependent resources have been updated.

## Walkthrough

It takes approximately 20 minutes for the stack build to complete.

This solution can be deployed using both the AWS Management Console or the Command Line Interface (CLI).

Before deploying the stack, a .NET web application must first be created and uploaded to an S3 Bucket.

### Creating the .NET web application

First, install the latest .NET SDK from the [Download .NET 6.0](https://dotnet.microsoft.com/download/dotnet/6.0) website.

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

Next, the .NET application needs to be compiled for Windows 2019.

```shell
dotnet publish --configuration release --self-contained
```

The compiled application should exist in the ```./bin/release/net6.0/publish``` folder. The next step is to compress the files and upload them to an existing S3 Bucket. The following commands will create a ```.tar.gz``` file, and using the AWS CLI, upload it to an S3 Bucket. Note, the S3 Bucket name needs to be updated.

```shell
cd bin/release/net6.0/publish
tar -czf ~/sample-web-application.tar.gz .
aws s3 cp sample-web-application.tar.gz s3://< Insert your bucket name here >/sample-web-application.tar.gz
```

Next, update the CloudFormation parameters .json file (```windows-dotnet-web-application-pipeline.json```) with the S3 object used in the AWS CLI command.

### Deploying the Stack

#### AWS Management Console

1. Upload the ```windows-dotnet-web-application-pipeline.yml``` template to CloudFormation.
2. Update the stack parameters as desired, ensuring the ```DotnetS3SourceTarFile``` parameter points to the S3 location used when uploading the .NET web application to S3.
3. You will see a checkbox informing you that the stack creates IAM resources. Read and check the box.
4. Wait for the stack to build.
5. Once built, a new Image Builder pipeline will exist. You can view this in the Image Builder console, and optionally trigger a manual execution of the pipeline to start the first image creation.

#### AWS CLI

1. Ensure that your YAML template and JSON parameters file are located within your current directory.
2. Modify the parameters in ```windows-dotnet-web-application-pipeline.json``` as necessary.
3. Run the following command from your terminal:

```shell
aws cloudformation create-stack \
--stack-name windows-testapp \
--template-body file://windows-dotnet-web-application-pipeline.yml \
--parameters file://windows-dotnet-web-application-pipeline.json \
--capabilities CAPABILITY_NAMED_IAM \
--region us-east-1
```

### Creating the Image

To create the container image, navigate to the EC2 Image Builder console, then select Image pipelines from the side navigation. Click to enter the newly created pipeline. Under the Actions menu, select "Run pipeline".

## Troubleshooting

While the stack is building, you will see an EC2 instance running. This is either the build or test instance. AWS Systems Manager (SSM) Automation will also run. You can observe this automation to see the steps EC2 Image Builder takes to build your image.

If the stack fails, check the CloudFormation events. These events include a description of any failed resources.

## Cleanup

To delete the resources created by the stack:

1. Delete the contents of the S3 bucket created by the stack (if the bucket is not empty, the stack deletion will fail). To keep the bucket, add a ```Retain``` deletion policy to the CloudFormation bucket resource. See [DeletionPolicy attribute](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html) for more information.
2. Delete the container image within your ECR repository created by the stack (if the repository is not empty, the stack deletion will fail).
3. Delete the stack in the CloudFormation console, or by using the CLI/SDK.
