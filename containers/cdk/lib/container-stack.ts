// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as imagebuilder from '@aws-cdk/aws-imagebuilder-alpha';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as events from 'aws-cdk-lib/aws-events';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

/**
 * A weekly Amazon Linux 2023 base container image pipeline: managed base
 * image -> container recipe with a Dockerfile template -> ECR. The CDK twin
 * of ../cloudformation/container-pipeline.yml, without that template's
 * replica-region and scanning options.
 */
export class ContainerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // One repository per pipeline. Image Builder pushes fixed tags with every
    // build (<version>-<build> and <name>-<version>-<build>) in addition to
    // the tags in the distribution - two pipelines sharing a repository
    // collide on them.
    const repository = new ecr.Repository(this, 'Repository', {
      repositoryName: 'container-sample-cdk',
      // DESTROY + emptyOnDelete removes every image with the stack - use
      // RETAIN for a production repository.
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      emptyOnDelete: true,
      imageScanOnPush: true,
    });

    // Receives the detailed AWSTOE log bundle from each build. Component
    // output streams to CloudWatch; this bucket holds the full bundle, which
    // otherwise vanishes with the container.
    const logBucket = new s3.Bucket(this, 'BuildLogBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      lifecycleRules: [
        // Build logs are only useful for recent troubleshooting - expire them
        // so the bucket doesn't accumulate cost.
        {
          expiration: cdk.Duration.days(30),
          noncurrentVersionExpiration: cdk.Duration.days(1),
        },
      ],
    });

    // Runs inside the container during the build - the changes it makes are
    // container image layers, not build-instance state. The test phase runs
    // in the container too, on the same build instance (AMI pipelines use a
    // fresh test instance instead).
    const baselineComponent = new imagebuilder.Component(this, 'BaselineComponent', {
      componentName: 'container-sample-cdk-baseline',
      // Components don't accept x wildcards at creation. Keep the version
      // fixed - the service increments the build number behind it when the
      // document changes.
      componentVersion: '1.0.0',
      platform: imagebuilder.Platform.LINUX,
      description: 'Installs a baseline package in the image and verifies it.',
      data: imagebuilder.ComponentData.fromComponentDocumentJsonObject({
        name: 'container-sample-cdk-baseline',
        description: 'Installs a baseline package in the image and verifies it.',
        schemaVersion: imagebuilder.ComponentSchemaVersion.V1_0,
        parameters: {
          package: {
            type: imagebuilder.ComponentParameterType.STRING,
            default: 'jq',
            description: 'Package to install.',
          },
        },
        phases: [
          {
            name: imagebuilder.ComponentPhaseName.BUILD,
            steps: [
              {
                name: 'InstallPackage',
                action: imagebuilder.ComponentAction.EXECUTE_BASH,
                inputs: imagebuilder.ComponentStepInputs.fromObject({
                  // Clean the metadata cache in the same layer it was created.
                  commands: ['dnf -y install {{ package }} && dnf clean all'],
                }),
              },
            ],
          },
          {
            name: imagebuilder.ComponentPhaseName.VALIDATE,
            steps: [
              {
                name: 'VerifyInstalled',
                action: imagebuilder.ComponentAction.EXECUTE_BASH,
                inputs: imagebuilder.ComponentStepInputs.fromObject({
                  commands: ['rpm -q {{ package }}'],
                }),
              },
            ],
          },
          {
            name: imagebuilder.ComponentPhaseName.TEST,
            steps: [
              {
                name: 'RunTool',
                action: imagebuilder.ComponentAction.EXECUTE_BASH,
                inputs: imagebuilder.ComponentStepInputs.fromObject({
                  commands: [`echo '{"ok":true}' | jq -e .ok`],
                }),
              },
            ],
          },
        ],
      }),
    });

    // An Image Builder managed base image: the pipeline's dependency-update
    // start condition tracks it, so a new base release triggers a rebuild.
    // BaseContainerImage.fromDockerHub/fromEcr work here too - those need a
    // platform override on the recipe.
    const baseImage = imagebuilder.AmazonManagedImage.amazonLinux2023(this, 'BaseImage', {
      imageArchitecture: imagebuilder.ImageArchitecture.X86_64,
      imageType: imagebuilder.ImageType.DOCKER,
    });

    const recipe = new imagebuilder.ContainerRecipe(this, 'Recipe', {
      containerRecipeName: 'container-sample-cdk',
      // x auto-increments the version each time a change replaces the recipe.
      containerRecipeVersion: '1.0.x',
      baseImage: imagebuilder.BaseContainerImage.fromImage(baseImage),
      targetRepository: imagebuilder.Repository.fromEcr(repository),
      // The component's package parameter isn't set here, so its default
      // ('jq') applies.
      components: [{ component: baselineComponent }],
      // The three variables are the contract: parentImage becomes the FROM
      // line, environments stages the component scripts, components runs them
      // and removes them. DockerfileData.fromAsset/fromS3 fit larger files.
      dockerfile: imagebuilder.DockerfileData.fromInline(
        [
          'FROM {{{ imagebuilder:parentImage }}}',
          '{{{ imagebuilder:environments }}}',
          '{{{ imagebuilder:components }}}',
          '',
        ].join('\n'),
      ),
      workingDirectory: '/tmp',
      // The build instance's AMI - a separate operating system from the
      // container's base image above. Pinned to the ECS-optimized AMI the
      // service would pick anyway, to make the build host explicit.
      instanceImage: imagebuilder.ContainerInstanceImage.fromSsmParameterName(
        '/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id',
      ),
    });

    // Container builds run docker on the instance, which adds a network hop
    // to instance metadata - a hop limit of 1 with required tokens breaks
    // credentials inside the container. With no role passed, the construct
    // creates the instance profile and adds the ECR container-builds managed
    // policy for container pipelines - bring your own role and you attach
    // that policy yourself.
    const infrastructure = new imagebuilder.InfrastructureConfiguration(this, 'Infrastructure', {
      infrastructureConfigurationName: 'container-sample-cdk',
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM)],
      httpTokens: imagebuilder.HttpTokens.REQUIRED,
      httpPutResponseHopLimit: 2,
      logging: { s3Bucket: logBucket },
    });

    const distribution = new imagebuilder.DistributionConfiguration(this, 'Distribution', {
      distributionConfigurationName: 'container-sample-cdk',
      containerDistributions: [
        {
          containerRepository: imagebuilder.Repository.fromEcr(repository),
          containerTags: ['latest'],
        },
      ],
    });

    // Pre-creating the log groups lets the stack own their retention and
    // cleanup.
    const pipelineLogGroup = new logs.LogGroup(this, 'PipelineLogGroup', {
      logGroupName: '/aws/imagebuilder/pipeline/container-sample-cdk',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const imageLogGroup = new logs.LogGroup(this, 'ImageLogGroup', {
      logGroupName: '/aws/imagebuilder/container-sample-cdk',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const pipeline = new imagebuilder.ImagePipeline(this, 'Pipeline', {
      imagePipelineName: 'container-sample-cdk',
      description: 'Weekly Amazon Linux 2023 base container image.',
      recipe,
      infrastructureConfiguration: infrastructure,
      distributionConfiguration: distribution,
      imagePipelineLogGroup: pipelineLogGroup,
      imageLogGroup: imageLogGroup,
      // Rebuilds when the managed base image or a component dependency has a
      // new version at the scheduled time.
      schedule: {
        expression: events.Schedule.expression('cron(0 9 ? * mon *)'),
        startCondition:
          imagebuilder.ScheduleStartCondition.EXPRESSION_MATCH_AND_DEPENDENCY_UPDATES_AVAILABLE,
      },
    });

    new cdk.CfnOutput(this, 'ImagePipelineArn', {
      description:
        "ARN of the image pipeline. Start a build with 'aws imagebuilder " +
        "start-image-pipeline-execution --image-pipeline-arn <this value>'.",
      value: pipeline.imagePipelineArn,
    });
    new cdk.CfnOutput(this, 'RepositoryUri', {
      description: 'The ECR repository the pipeline pushes to.',
      value: repository.repositoryUri,
    });
  }
}
