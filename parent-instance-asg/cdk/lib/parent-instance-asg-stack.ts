// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as imagebuilder from '@aws-cdk/aws-imagebuilder-alpha';
import * as cdk from 'aws-cdk-lib';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

/**
 * Builds start on an instance that's already running in an Auto Scaling
 * group, instead of waiting for Image Builder to launch one.
 */
export class ParentInstanceAsgStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Switches the pool AMI, instance type, and parent image together.
    // Set with: -c architecture=arm64
    const architecture = this.node.tryGetContext('architecture') ?? 'x86_64';
    if (architecture !== 'x86_64' && architecture !== 'arm64') {
      throw new Error(`architecture must be 'x86_64' or 'arm64', got '${architecture}'`);
    }
    const arm64 = architecture === 'arm64';

    // Instances kept ready - one per build you run at the same time.
    // Set with: -c poolSize=2
    const poolSize = Number(this.node.tryGetContext('poolSize') ?? 1);
    if (!Number.isInteger(poolSize) || poolSize < 1 || poolSize > 4) {
      throw new Error(`poolSize must be an integer from 1 to 4, got '${poolSize}'`);
    }

    // How long a build waits when the pool is empty; 0 fails right away.
    // Set with: -c capacityWaitTimeoutSeconds=900
    const capacityWaitTimeoutSeconds = Number(
      this.node.tryGetContext('capacityWaitTimeoutSeconds') ?? 600,
    );
    if (
      !Number.isInteger(capacityWaitTimeoutSeconds) ||
      capacityWaitTimeoutSeconds < 0 ||
      capacityWaitTimeoutSeconds > 3600
    ) {
      throw new Error(
        `capacityWaitTimeoutSeconds must be an integer from 0 to 3600, got '${capacityWaitTimeoutSeconds}'`,
      );
    }

    // Replaces idle pool instances once they're this old; 0 turns it off.
    // Set with: -c maxInstanceLifetimeSeconds=0
    const maxInstanceLifetimeSeconds = Number(
      this.node.tryGetContext('maxInstanceLifetimeSeconds') ?? 604800,
    );
    if (
      !Number.isInteger(maxInstanceLifetimeSeconds) ||
      (maxInstanceLifetimeSeconds !== 0 &&
        (maxInstanceLifetimeSeconds < 86400 || maxInstanceLifetimeSeconds > 31536000))
    ) {
      throw new Error(
        `maxInstanceLifetimeSeconds must be 0 or an integer from 86400 to 31536000, got '${maxInstanceLifetimeSeconds}'`,
      );
    }

    const instanceType = arm64
      ? ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MEDIUM)
      : ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM);

    // Pool instances get this profile from the launch template, test instances
    // from the infrastructure configuration. AmazonSSMManagedInstanceCore lets
    // the SSM Agent come online.
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      path: '/executionServiceEC2Role/',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
      ],
    });
    const instanceProfile = new iam.InstanceProfile(this, 'InstanceProfile', {
      role: instanceRole,
      path: '/executionServiceEC2Role/',
    });

    // A taken instance keeps everything it was launched with, so this template
    // decides what the build runs on - not the recipe or infrastructure
    // configuration.
    const launchTemplate = new ec2.LaunchTemplate(this, 'PoolLaunchTemplate', {
      launchTemplateName: 'parent-instance-asg-cdk',
      // Resolved by EC2 at each launch, so replacements start from the current
      // AL2023 AMI.
      machineImage: ec2.MachineImage.resolveSsmParameterAtLaunch(
        `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${architecture}`,
      ),
      instanceType,
      instanceProfile,
      requireImdsv2: true,
      // The image is created from this volume; the recipe's block device
      // mappings don't apply.
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(30, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
    });
    cdk.Validations.of(launchTemplate.node.defaultChild!).acknowledge({
      id: 'CloudFormation-Validate::E1152',
      reason: 'resolve:ssm: image IDs are resolved by EC2 at launch',
    });

    // CfnAutoScalingGroup takes AZ names directly, so the app synthesizes
    // without a VPC lookup or credentials.
    const pool = new autoscaling.CfnAutoScalingGroup(this, 'PoolAutoScalingGroup', {
      autoScalingGroupName: 'parent-instance-asg-cdk-pool',
      launchTemplate: {
        launchTemplateId: launchTemplate.launchTemplateId,
        version: launchTemplate.latestVersionNumber,
      },
      // Image Builder detaches without lowering desired capacity, so the group
      // backfills. Max is twice poolSize, so the maintenance policy can launch
      // replacements before terminating.
      minSize: String(poolSize),
      maxSize: String(poolSize * 2),
      desiredCapacity: String(poolSize),
      maxInstanceLifetime: maxInstanceLifetimeSeconds || undefined,
      instanceMaintenancePolicy: { minHealthyPercentage: 100, maxHealthyPercentage: 200 },
      // Default VPC. For your own subnets, set vpcZoneIdentifier here and
      // subnet plus security groups on the infrastructure configuration (the
      // test instance uses those).
      availabilityZones: [
        cdk.Fn.select(0, cdk.Fn.getAzs()),
        cdk.Fn.select(1, cdk.Fn.getAzs()),
      ],
    });
    // Stack updates that change the launch template replace the pool's
    // instances, launching new ones before terminating the old.
    pool.cfnOptions.updatePolicy = {
      autoScalingRollingUpdate: { minInstancesInService: poolSize, maxBatchSize: poolSize },
    };
    const poolName = pool.ref;

    // The service-linked role has no Auto Scaling permissions, so a parent
    // instance needs an execution role. EC2ImageBuilderExecutionPolicy covers
    // the describe calls; the rest is scoped to this group.
    const executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('imagebuilder.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2ImageBuilderExecutionPolicy'),
      ],
      inlinePolicies: {
        ParentInstanceFromAutoScalingGroup: new iam.PolicyDocument({
          statements: [
            // Tagging happens before the detach, while the group tag is still
            // there to scope on.
            new iam.PolicyStatement({
              sid: 'TagInstanceInASG',
              actions: ['ec2:CreateTags', 'ec2:DeleteTags'],
              resources: [
                this.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' }),
              ],
              conditions: {
                StringEquals: { 'ec2:ResourceTag/aws:autoscaling:groupName': poolName },
              },
            }),
            // No resource-level permissions for this action.
            new iam.PolicyStatement({
              sid: 'DescribeASG',
              actions: ['autoscaling:DescribeAutoScalingGroups'],
              resources: ['*'],
            }),
            // Without it, builds fail on DetachInstances with access denied.
            new iam.PolicyStatement({
              sid: 'DetachFromASG',
              actions: ['autoscaling:DetachInstances'],
              resources: [
                this.formatArn({
                  service: 'autoscaling',
                  resource: 'autoScalingGroup',
                  resourceName: `*:autoScalingGroupName/${poolName}`,
                  arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
                }),
              ],
            }),
          ],
        }),
      },
    });

    const baseImage = imagebuilder.AmazonManagedImage.amazonLinux2023(this, 'BaseImage', {
      imageArchitecture: arm64
        ? imagebuilder.ImageArchitecture.ARM64
        : imagebuilder.ImageArchitecture.X86_64,
      imageType: imagebuilder.ImageType.AMI,
    });

    const updateOs = imagebuilder.AmazonManagedComponent.updateOs(this, 'UpdateOsComponent', {
      platform: imagebuilder.Platform.LINUX,
    });

    const recipe = new imagebuilder.ImageRecipe(this, 'Recipe', {
      imageRecipeName: 'parent-instance-asg-cdk',
      imageRecipeVersion: '1.0.x',
      // Not launched - Image Builder matches pool instances on its platform and
      // architecture.
      baseImage: imagebuilder.BaseImage.fromImage(baseImage),
      // Patch first, since a pool instance may have been idle. Add your
      // components after it.
      components: [{ component: updateOs }],
    });

    // Profile and instance type apply to the test instance; the build instance
    // comes from the pool.
    const infrastructure = new imagebuilder.InfrastructureConfiguration(this, 'Infrastructure', {
      infrastructureConfigurationName: 'parent-instance-asg-cdk',
      instanceTypes: [instanceType],
      instanceProfile,
    });

    // Set the parent instance settings on the generated CloudFormation
    // resource.
    const cfnInfrastructure = infrastructure.node
      .defaultChild as cdk.aws_imagebuilder.CfnInfrastructureConfiguration;
    cfnInfrastructure.addPropertyOverride('ParentInstance', {
      AutoScalingGroup: {
        Name: poolName,
        CapacityWaitTimeoutSeconds: capacityWaitTimeoutSeconds,
      },
    });
    // Set to false to keep a successful build's instance (stopped) instead of
    // terminating it.
    cfnInfrastructure.addPropertyOverride('TerminateInstanceOnCompletion', true);
    cdk.Validations.of(cfnInfrastructure).acknowledge({
      id: 'CloudFormation-Validate::F3002',
      reason: 'ParentInstance and TerminateInstanceOnCompletion are newer than the bundled schema',
    });

    const pipelineLogGroup = new logs.LogGroup(this, 'PipelineLogGroup', {
      logGroupName: '/aws/imagebuilder/pipeline/parent-instance-asg-cdk',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const imageLogGroup = new logs.LogGroup(this, 'ImageLogGroup', {
      logGroupName: '/aws/imagebuilder/parent-instance-asg-cdk',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Runs the managed build and test workflows. Creating it doesn't start a
    // build.
    const pipeline = new imagebuilder.ImagePipeline(this, 'Pipeline', {
      imagePipelineName: 'parent-instance-asg-cdk',
      description:
        'Builds Amazon Linux 2023 on an instance taken from an Auto Scaling group.',
      recipe,
      infrastructureConfiguration: infrastructure,
      executionRole,
      imagePipelineLogGroup: pipelineLogGroup,
      imageLogGroup: imageLogGroup,
    });

    new cdk.CfnOutput(this, 'ImagePipelineArn', {
      description:
        "ARN of the image pipeline. Start a build with 'aws imagebuilder " +
        "start-image-pipeline-execution --image-pipeline-arn <this value>'.",
      value: pipeline.imagePipelineArn,
    });
    new cdk.CfnOutput(this, 'AutoScalingGroupName', {
      description: 'The Auto Scaling group that build instances are taken from.',
      value: poolName,
    });
    new cdk.CfnOutput(this, 'BuildLogGroupName', {
      description: 'CloudWatch log group for the build logs.',
      value: imageLogGroup.logGroupName,
    });
  }
}
