// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as imagebuilder from '@aws-cdk/aws-imagebuilder-alpha';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * A complete, minimal EC2 Image Builder pipeline for Amazon Linux 2023:
 * component -> image recipe -> infrastructure configuration -> distribution
 * configuration -> image pipeline. Each successful build publishes its AMI ID
 * to an SSM parameter for downstream consumers.
 */
export class QuickStartStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 'x86_64' (default) or 'arm64'. Switches the parent image and the build
    // instance type together. Set with: npx cdk deploy -c architecture=arm64
    const architecture = this.node.tryGetContext('architecture') ?? 'x86_64';
    if (architecture !== 'x86_64' && architecture !== 'arm64') {
      throw new Error(`architecture must be 'x86_64' or 'arm64', got '${architecture}'`);
    }
    const arm64 = architecture === 'arm64';

    // Detailed build logs land here. The bucket has versioning enabled - to
    // delete the stack, remove all object versions and delete markers first.
    const logBucket = new s3.Bucket(this, 'BuildLogBucket', {
      // The stack owns the bucket end to end - contents still need emptying
      // before destroy because the bucket is versioned.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      lifecycleRules: [
        // Build logs are only useful for recent troubleshooting - expire them
        // so the bucket doesn't accumulate cost or block cleanup.
        {
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(7),
        },
      ],
    });

    // The component's build phase runs on the build instance, validate runs
    // right after it on the same instance, and test runs on a fresh instance
    // launched from the output AMI - so the test step proves the file
    // survived into the image.
    const buildInfoComponent = new imagebuilder.Component(this, 'BuildInfoComponent', {
      componentName: 'quick-start-cdk-build-info',
      // Components don't accept x wildcards. Keep the version fixed - when
      // the document changes, the service increments the build number behind
      // the same version (1.0.0/1, 1.0.0/2, ...), so updates deploy without
      // editing this value.
      componentVersion: '1.0.0',
      platform: imagebuilder.Platform.LINUX,
      description:
        'Writes build metadata into the image, then verifies it in the validate and test phases.',
      data: imagebuilder.ComponentData.fromComponentDocumentJsonObject({
        name: 'quick-start-build-info',
        description:
          'Writes build metadata into the image and verifies it made it into the AMI.',
        schemaVersion: imagebuilder.ComponentSchemaVersion.V1_0,
        phases: [
          {
            name: imagebuilder.ComponentPhaseName.BUILD,
            steps: [
              {
                name: 'WriteBuildInfo',
                action: imagebuilder.ComponentAction.EXECUTE_BASH,
                inputs: imagebuilder.ComponentStepInputs.fromObject({
                  commands: [
                    'mkdir -p /opt/quick-start',
                    "date -u '+Built by EC2 Image Builder on %Y-%m-%dT%H:%M:%SZ' > /opt/quick-start/build-info.txt",
                    'cat /etc/os-release >> /opt/quick-start/build-info.txt',
                  ],
                }),
              },
            ],
          },
          {
            name: imagebuilder.ComponentPhaseName.VALIDATE,
            steps: [
              {
                name: 'BuildInfoWritten',
                action: imagebuilder.ComponentAction.EXECUTE_BASH,
                inputs: imagebuilder.ComponentStepInputs.fromObject({
                  commands: ['test -s /opt/quick-start/build-info.txt'],
                }),
              },
            ],
          },
          {
            name: imagebuilder.ComponentPhaseName.TEST,
            steps: [
              {
                name: 'BuildInfoInImage',
                action: imagebuilder.ComponentAction.EXECUTE_BASH,
                inputs: imagebuilder.ComponentStepInputs.fromObject({
                  commands: ['test -s /opt/quick-start/build-info.txt'],
                }),
              },
            ],
          },
        ],
      }),
    });

    // The managed image reference defaults to version x.x.x, which resolves
    // to the latest release of the AL2023 base at build time.
    const baseImage = imagebuilder.AmazonManagedImage.amazonLinux2023(this, 'BaseImage', {
      imageArchitecture: arm64
        ? imagebuilder.ImageArchitecture.ARM64
        : imagebuilder.ImageArchitecture.X86_64,
      imageType: imagebuilder.ImageType.AMI,
    });

    // Also defaults to x.x.x, tracking the latest version of the managed
    // update-linux component.
    const updateOs = imagebuilder.AmazonManagedComponent.updateOs(this, 'UpdateOsComponent', {
      platform: imagebuilder.Platform.LINUX,
    });

    const recipe = new imagebuilder.ImageRecipe(this, 'Recipe', {
      imageRecipeName: 'quick-start-cdk',
      // x auto-increments the build version, so updates that replace the
      // recipe never collide with an existing name + version pair
      imageRecipeVersion: '1.0.x',
      baseImage: imagebuilder.BaseImage.fromImage(baseImage),
      // Components run in list order: OS updates first, then the component
      // created by this stack.
      components: [{ component: updateOs }, { component: buildInfoComponent }],
    });

    // With no vpc set, build instances launch in the account's default VPC.
    // The construct generates the instance profile: the two Image Builder
    // baseline managed policies plus write access to the log bucket.
    const infrastructure = new imagebuilder.InfrastructureConfiguration(this, 'Infrastructure', {
      infrastructureConfigurationName: 'quick-start-cdk',
      instanceTypes: [
        arm64
          ? ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM)
          : ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM),
      ],
      logging: { s3Bucket: logBucket },
    });

    // The Image Builder service writes this parameter after each build, so
    // it's imported as a reference rather than created as a stack resource.
    // The /imagebuilder/ path is required: the service-linked role that
    // writes the parameter only has ssm:PutParameter on that path.
    // forceDynamicReference matters: the plain import helpers back their
    // stringValue with a template parameter the CLI resolves at deploy time,
    // which fails while this parameter doesn't exist yet. The dynamic
    // reference is only rendered if the value is used, and only the name is.
    const amiParameter = ssm.StringParameter.fromStringParameterAttributes(
      this,
      'AmiParameter',
      {
        parameterName: '/imagebuilder/quick-start-cdk/latest-ami',
        forceDynamicReference: true,
      },
    );

    // The handoff point for launch templates and other stacks. The parameter
    // is service-managed, so deleting the stack doesn't delete it - the
    // cleanup steps in the README do.
    const distribution = new imagebuilder.DistributionConfiguration(this, 'Distribution', {
      distributionConfigurationName: 'quick-start-cdk',
      amiDistributions: [
        {
          ssmParameters: [
            {
              parameter: amiParameter,
              dataType: ssm.ParameterDataType.AWS_EC2_IMAGE,
            },
          ],
        },
      ],
    });

    // Pre-creating the log groups lets the stack own their retention and
    // cleanup.
    const pipelineLogGroup = new logs.LogGroup(this, 'PipelineLogGroup', {
      logGroupName: '/aws/imagebuilder/pipeline/quick-start-cdk',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const imageLogGroup = new logs.LogGroup(this, 'ImageLogGroup', {
      logGroupName: '/aws/imagebuilder/quick-start-cdk',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Creating the pipeline doesn't start a build - see the README for how
    // to run it. Without a schedule, the pipeline only builds on demand.
    const pipeline = new imagebuilder.ImagePipeline(this, 'Pipeline', {
      imagePipelineName: 'quick-start-cdk',
      description: 'Quick start pipeline building Amazon Linux 2023 with build metadata baked in.',
      recipe,
      infrastructureConfiguration: infrastructure,
      distributionConfiguration: distribution,
      imagePipelineLogGroup: pipelineLogGroup,
      imageLogGroup: imageLogGroup,
    });

    new cdk.CfnOutput(this, 'ImagePipelineArn', {
      description:
        "ARN of the image pipeline. Start a build with 'aws imagebuilder " +
        "start-image-pipeline-execution --image-pipeline-arn <this value>'.",
      value: pipeline.imagePipelineArn,
    });
    new cdk.CfnOutput(this, 'AmiParameterName', {
      description: 'SSM parameter that receives the AMI ID after each successful build.',
      value: amiParameter.parameterName,
    });
    new cdk.CfnOutput(this, 'LogBucketName', {
      description: 'S3 bucket receiving detailed build logs.',
      value: logBucket.bucketName,
    });
  }
}
