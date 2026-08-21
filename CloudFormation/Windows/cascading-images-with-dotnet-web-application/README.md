# Windows cascading Image Pipeline for hosting a .NET web application

This is a set of sample templates that demonstrate how to use EC2 Image Builder CloudFormation resources to build a set of cascading Windows images. The first image is a baseline image, while the second image is build from the first, and can host a .NET web application.

***Internet connectivity is required in your default VPC*** so the build instances can download Windows updates, NSSM, and your application archive, and reach AWS Systems Manager. If you do not have a default VPC, or want to use a custom VPC, you will need to specify a subnet ID and one or more security group IDs in the VPC as parameters when you create a stack based on this template.

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

The [AWS::ImageBuilder::ImageRecipe](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-imagerecipe.html) ties together the parent image and the components to apply. The baseline stack builds from a Windows Server managed image, while the application stack uses the baseline stack's exported Image ARN as its parent - this is the cascading part.

The resource [AWS::ImageBuilder::DistributionConfiguration](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-distributionconfiguration.html) allows you to specify the name, description, and tags applied to the output AMI in each target region.

The [AWS::ImageBuilder::ImagePipeline](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-imagepipeline.html) creates an automation pipeline for your image builds. The pipeline is associated with the image recipe and can also be associated with an infrastructure configuration and distribution configuration. You can also use a schedule to configure how often and when a pipeline will automatically create a new image. In this example, the pipeline is scheduled to run a build at 10:00AM Coordinated Universal Time (UTC), every day. The build will only run if dependent resources have been updated.

As these stacks will export an Image ARN, the Image name must be converted to lowercase. A custom Lambda resource is used to do that. Therefore, an [AWS::Lambda::Function](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-lambda-function.html) resource is created to convert an input parameter to lowercase. Related resources, including an [AWS::Logs::LogGroup](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-logs-loggroup.html) resource and an [AWS::IAM::Role](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-iam-role.html) resource are created to allow the Lambda Function access to execution, and to control it's CloudWatch LogGroup.

Next, the Lambda Function is executed using a [Cloudformation Custom Resource](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/template-custom-resources.html) (the *Custom::Lowercase* resource in the stacks).

### Resources Specific to the .NET Application Stack

Specific to the second stack are two [AWS::ImageBuilder::Component](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-imagebuilder-component.html) resources.

The first installs NSSM, the [Non-Sucking Service Manager](https://nssm.cc/). This will be used to create a custom Windows Service for the .NET web application.

The second will download the compressed .NET web application from S3, and install it ready for use.

## Walkthrough

The walkthrough typically takes 1.5 to 2.5 hours end to end - each of the two image builds runs 30 to 90 minutes depending on how many Windows updates the base image needs.

This solution can be deployed using both the AWS Management Console or the Command Line Interface (CLI).

Before deploying the stacks, a .NET web application must first be created and uploaded to an S3 Bucket.

### Creating the .NET web application

First, install the latest .NET SDK from the [Download .NET](https://dotnet.microsoft.com/download) website.

Next, create a .NET web application. As this is a sample, we will not be using https, although that is recommended for production use.

```shell
dotnet new webapp -o sample-web-application --no-https
cd sample-web-application
```

The application needs to listen on all network interfaces rather than localhost only. In `Program.cs`, add the following before `app.Run()` so the application listens on TCP/5000:

```cs
app.Urls.Add("http://*:5000");
```

Next, the .NET application needs to be compiled for Windows.

```shell
dotnet publish --configuration release --runtime win-x64 --self-contained true
```

The `--self-contained true` flag bundles the .NET runtime with the application. This matters because the baseline image doesn't include the .NET runtime - a framework-dependent publish produces a service that can't start.

The compiled application should exist in the ```./bin/release/<framework>/win-x64/publish``` (where `<framework>` matches your SDK version, for example `net8.0`) folder. The next step is to compress the files and upload them to an existing S3 Bucket. The following commands will create a ```.zip``` file, and using the AWS CLI, upload it to an S3 Bucket. Note, the S3 Bucket name needs to be updated.

```shell
cd bin/release/<framework>/win-x64/publish
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
2. Update the stack parameters as desired, ensuring the ```DotnetS3SourceZipFile``` parameter in the second stack points to the S3 location used when uploading the .NET web application to S3.
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

1. Delete the contents of the S3 buckets created by the stacks, including all object versions and delete markers - the buckets have versioning enabled, so `aws s3 rm --recursive` alone leaves versions behind and the stack deletion fails on a non-empty bucket. The console's "Empty bucket" action removes versions for you. To keep a bucket, add a ```Retain``` deletion policy to the CloudFormation bucket resource. See [DeletionPolicy attribute](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-attribute-deletionpolicy.html) for more information.
2. Delete the application stack first, then the baseline stack (the application stack imports the baseline stack's exported Image ARN, so the baseline stack can't be deleted while the application stack exists).
3. Deregister the AMIs the pipelines created and delete their associated EBS snapshots - deleting the stacks does not remove them, and the snapshots continue to bill until removed. You can find them in the EC2 console filtered by the image name prefix, or via the Image Builder console's image list.
