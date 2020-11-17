# Latest Image Tracker

This is a sample solution that uses AWS Lambda and AWS Systems Manager (SSM) Parameter Store to track and update the latest Amazon Machine Image (AMI) IDs every time an Image Builder pipeline is run. Users can reference the SSM parameter in automation scripts and AWS CloudFormation templates providing access to the latest AMI ID for your EC2 infrastructure. 

This solution uses a Lambda function written in Python that subscribes to an Amazon Simple Notification Service (SNS) topic. The Lambda function and the SNS topic are deployed using AWS SAM CLI. Once deployed, the SNS topic must be configured in an existing Image Builder pipeline. This results in the Lambda function being invoked at the completion of the Image Builder pipeline


## Prerequisites

To get started with this solution, the following is required:
1. [AWS SAM CLI](https://aws.amazon.com/serverless/sam/) to deploy the solution.
2. An existing Amazon EC2 Image Builder pipeline.



## Walkthrough

The solution consists of two files:

1. The Python file ```image-builder-lambda-update-ssm.py``` contains the code for the Lambda function. It first checks the SNS message payload to determine if the image is available. If it’s available, it extracts the AMI ID from the SNS message payload and updates the SSM parameter specified. 

The ```sm_parameter_name``` variable specifies the SSM parameter path where the AMI ID should be stored and updated. The Lambda function finishes by adding tags to the SSM parameter.

2. The ```template.yaml``` file is an AWS SAM template. It deploys the Lambda function, SNS topic, and IAM role required for the Lambda function. I use Python 3.7 as the runtime and assign a memory of 256 MB for the Lambda function. The IAM policy gives the Lambda function permissions to retrieve and update SSM parameters. 


## Deploying the Solution

1. Deploy this application using the [AWS SAM CLI guided deploy](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/sam-cli-command-reference-sam-deploy.html)

```bash
sam deploy -g
```
2. After deploying the application, note the ARN of the created SNS topic. Next, update the infrastructure settings of an existing Image Builder pipeline with this newly created SNS topic. This results in the Lambda function being invoked upon the completion of the image builder pipeline. 


## Verifying the Solution

After the completion of the image builder pipeline, use the AWS CLI or check the AWS Management Console to verify the updated SSM parameter. To verify via AWS CLI, run the following commands to retrieve and list the tags attached to the SSM parameter:

```bash
aws ssm get-parameter --name ‘/ec2-imagebuilder/latest’
aws ssm list-tags-for-resource --resource-type "Parameter" --resource-id ‘/ec2-imagebuilder/latest’
```
