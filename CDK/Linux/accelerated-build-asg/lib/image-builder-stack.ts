import * as cdk from 'aws-cdk-lib/core';
import * as autoscaling from 'aws-cdk-lib/aws-autoscaling';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as imagebuilder from '@aws-cdk/aws-imagebuilder-alpha';
import { Construct } from 'constructs';
import * as path from 'path';

export interface ImageBuilderStackProps extends cdk.StackProps {
  readonly vpcId: string;
  readonly subnetIds: string[];
  readonly instanceType?: string;
  readonly desiredCapacity?: number;
  readonly minCapacity?: number;
  readonly maxCapacity?: number;
  /** Include the InventoryCollection (CollectImageMetadata) step in the build workflow. Default: false */
  readonly collectImageMetadata?: boolean;
}

interface WorkflowConfig {
  builderLambdaName: string;
  terminationLambdaName: string;
  collectImageMetadata: boolean;
}

function buildWorkflowYaml(config: WorkflowConfig): string {
  const steps: string[] = [
    `  - name: GetBuildInstance
    action: WaitForAction
    onFailure: Abort
    inputs:
      lambdaFunctionName: ${config.builderLambdaName}`,
    `  - name: ApplyBuildComponents
    action: ExecuteComponents
    onFailure: Abort
    inputs:
      instanceId.$: "$.stepOutputs.GetBuildInstance.reason"`,
  ];

  if (config.collectImageMetadata) {
    steps.push(`  - name: InventoryCollection
    action: CollectImageMetadata
    onFailure: Abort
    if:
      and:
        - stringEquals: "AMI"
          value: "$.imagebuilder.imageType"
        - booleanEquals: true
          value: "$.imagebuilder.collectImageMetadata"
    inputs:
      instanceId.$: "$.stepOutputs.GetBuildInstance.reason"`);
  }

  steps.push(
    `  - name: RunSanitizeScript
    action: SanitizeInstance
    onFailure: Abort
    if:
      and:
        - stringEquals: "AMI"
          value: "$.imagebuilder.imageType"
        - not:
            stringEquals: "Windows"
            value: "$.imagebuilder.platform"
    inputs:
      instanceId.$: "$.stepOutputs.GetBuildInstance.reason"`,
    `  - name: CreateOutputAMI
    action: CreateImage
    onFailure: Abort
    if:
      stringEquals: "AMI"
      value: "$.imagebuilder.imageType"
    inputs:
      instanceId.$: "$.stepOutputs.GetBuildInstance.reason"`,
    `  - name: TerminateBuildInstance
    action: WaitForAction
    onFailure: Continue
    inputs:
      lambdaFunctionName: ${config.terminationLambdaName}`,
  );

  return [
    'name: build-image-using-custom-wait-for-action',
    'description: Builds an image where the build instance InstanceId is returned from a custom WaitForAction step.',
    'schemaVersion: 1.0',
    '',
    'steps:',
    steps.join('\n\n'),
    '',
    'outputs:',
    '  - name: "ImageId"',
    '    value: "$.stepOutputs.CreateOutputAMI.imageId"',
    '',
  ].join('\n');
}

export class ImageBuilderStack extends cdk.Stack {
  public readonly imagePipelineArn: string;
  public readonly launchTemplateId: string;
  public readonly autoScalingGroupName: string;

  constructor(scope: Construct, id: string, props: ImageBuilderStackProps) {
    super(scope, id, props);

    const instanceTypeStr = props.instanceType ?? 't3.medium';
    const desiredCapacity = props.desiredCapacity ?? 1;
    const minCapacity = props.minCapacity ?? 1;
    const maxCapacity = props.maxCapacity ?? 2;
    const collectImageMetadata = props.collectImageMetadata ?? false;

    // --- VPC and Security Group ---

    const vpc = ec2.Vpc.fromLookup(this, 'Vpc', { vpcId: props.vpcId });

    const subnets = props.subnetIds.map((subnetId, i) =>
      ec2.Subnet.fromSubnetId(this, `Subnet${i}`, subnetId),
    );

    const securityGroup = new ec2.SecurityGroup(this, 'InstanceSecurityGroup', {
      vpc,
      description: 'Security group for Image Builder instances',
      allowAllOutbound: true,
    });

    // --- EC2 Instance Role and Launch Template ---

    const instanceRole = new iam.Role(this, 'EC2InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
      ],
    });

    const instanceProfile = new iam.InstanceProfile(this, 'EC2InstanceProfile', {
      role: instanceRole,
    });

    const latestAmiId = ssm.StringParameter.valueForStringParameter(
      this,
      '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
    );

    const launchTemplate = new ec2.LaunchTemplate(this, 'LaunchTemplate', {
      launchTemplateName: `${cdk.Names.uniqueId(this)}-LaunchTemplate`,
      machineImage: ec2.MachineImage.genericLinux({ [this.region]: latestAmiId }),
      instanceType: new ec2.InstanceType(instanceTypeStr),
      requireImdsv2: true,
      role: instanceRole,
      securityGroup,
      userData: ec2.UserData.custom([
        '#!/bin/bash',
        'systemctl enable amazon-ssm-agent',
        'systemctl start amazon-ssm-agent',
      ].join('\n')),
    });

    // --- Auto Scaling Group ---

    const asg = new autoscaling.AutoScalingGroup(this, 'ASG', {
      autoScalingGroupName: `${this.stackName}-ASG`,
      vpc,
      vpcSubnets: { subnets },
      launchTemplate,
      desiredCapacity,
      minCapacity,
      maxCapacity,
    });

    // --- Instance Lock Table ---

    const lockTable = new dynamodb.Table(this, 'InstanceLockTable', {
      tableName: `${this.stackName}-InstanceLocks`,
      partitionKey: { name: 'instanceId', type: dynamodb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // --- Builder Lambda (WaitForAction handler) ---

    const builderDlq = new sqs.Queue(this, 'BuilderLambdaDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    const builderLogGroup = new logs.LogGroup(this, 'BuilderLambdaLogGroup', {
      logGroupName: `/aws/lambda/${this.stackName}-BuilderFunction`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const builderLambda = new nodejs.NodejsFunction(this, 'BuilderFunction', {
      functionName: `${this.stackName}-BuilderFunction`,
      entry: path.join(__dirname, '..', 'lambda', 'builder-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      logGroup: builderLogGroup,
      deadLetterQueue: builderDlq,
      environment: {
        ASG_NAME: asg.autoScalingGroupName,
        LOCK_TABLE_NAME: lockTable.tableName,
      },
      bundling: {
        externalModules: [],
      },
    });

    builderLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances', 'ssm:DescribeInstanceInformation'],
      resources: ['*'],
    }));
    builderLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags'],
      resources: [`arn:${this.partition}:ec2:${this.region}:${this.account}:instance/*`],
    }));
    builderLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['autoscaling:DetachInstances'],
      resources: [`arn:${this.partition}:autoscaling:${this.region}:${this.account}:autoScalingGroup:*:autoScalingGroupName/${asg.autoScalingGroupName}`],
    }));
    builderLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['imagebuilder:SendWorkflowStepAction'],
      resources: ['*'],
    }));
    builderLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
      resources: [lockTable.tableArn],
    }));

    new lambda.Alias(this, 'BuilderFunctionAlias', {
      aliasName: 'live',
      version: builderLambda.currentVersion,
      provisionedConcurrentExecutions: 1,
    });

    // --- AMI Update Lambda ---

    const amiUpdateLogGroup = new logs.LogGroup(this, 'AMIUpdateLambdaLogGroup', {
      logGroupName: `/aws/lambda/${this.stackName}-AMIUpdateFunction`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const amiUpdateLambda = new nodejs.NodejsFunction(this, 'AMIUpdateFunction', {
      functionName: `${this.stackName}-AMIUpdateFunction`,
      entry: path.join(__dirname, '..', 'lambda', 'ami-update-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(60),
      logGroup: amiUpdateLogGroup,
      environment: {
        LAUNCH_TEMPLATE_ID: launchTemplate.launchTemplateId!,
        ASG_NAME: asg.autoScalingGroupName,
      },
      bundling: {
        externalModules: [],
      },
    });

    amiUpdateLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeLaunchTemplates', 'ec2:DescribeLaunchTemplateVersions'],
      resources: ['*'],
    }));
    amiUpdateLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateLaunchTemplateVersion', 'ec2:ModifyLaunchTemplate'],
      resources: [`arn:${this.partition}:ec2:${this.region}:${this.account}:launch-template/*`],
    }));
    amiUpdateLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['autoscaling:UpdateAutoScalingGroup', 'autoscaling:StartInstanceRefresh'],
      resources: [`arn:${this.partition}:autoscaling:${this.region}:${this.account}:autoScalingGroup:*:autoScalingGroupName/${asg.autoScalingGroupName}`],
    }));
    amiUpdateLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'],
      resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/aws/service/ami-amazon-linux-latest/*`],
    }));

    const amiUpdateAlias = new lambda.Alias(this, 'AMIUpdateFunctionAlias', {
      aliasName: 'live',
      version: amiUpdateLambda.currentVersion,
      provisionedConcurrentExecutions: 1,
    });

    // --- Termination Lambda (async instance cleanup) ---

    const terminationLogGroup = new logs.LogGroup(this, 'TerminationLambdaLogGroup', {
      logGroupName: `/aws/lambda/${this.stackName}-TerminationFunction`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const terminationLambda = new nodejs.NodejsFunction(this, 'TerminationFunction', {
      functionName: `${this.stackName}-TerminationFunction`,
      entry: path.join(__dirname, '..', 'lambda', 'termination-handler.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(120),
      logGroup: terminationLogGroup,
      bundling: {
        externalModules: [],
      },
    });

    terminationLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:TerminateInstances'],
      resources: [`arn:${this.partition}:ec2:${this.region}:${this.account}:instance/*`],
      conditions: { StringEquals: { 'ec2:ResourceTag/CreatedBy': 'EC2 Image Builder' } },
    }));
    terminationLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ec2:DescribeInstances'],
      resources: ['*'],
    }));
    terminationLambda.addToRolePolicy(new iam.PolicyStatement({
      actions: ['imagebuilder:SendWorkflowStepAction'],
      resources: ['*'],
    }));

    new lambda.Alias(this, 'TerminationFunctionAlias', {
      aliasName: 'live',
      version: terminationLambda.currentVersion,
      provisionedConcurrentExecutions: 1,
    });

    // --- EventBridge Rule for Monthly AMI Updates ---

    new events.Rule(this, 'MonthlyAMIUpdateRule', {
      schedule: events.Schedule.rate(cdk.Duration.days(30)),
      targets: [new targets.LambdaFunction(amiUpdateAlias)],
    });

    // --- Image Builder Execution Role ---

    const executionRole = new iam.Role(this, 'ImageBuilderExecutionRole', {
      assumedBy: new iam.ServicePrincipal('imagebuilder.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/EC2ImageBuilderLifecycleExecutionPolicy'),
      ],
    });

    // Lambda invocation (replaces SNS publish + KMS)
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [builderLambda.functionArn, terminationLambda.functionArn],
    }));

    // EC2 permissions for image building
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:RegisterImage'],
      resources: [`arn:${this.partition}:ec2:*::image/*`],
      conditions: { StringEquals: { 'aws:RequestTag/CreatedBy': 'EC2 Image Builder' } },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:RegisterImage'],
      resources: [`arn:${this.partition}:ec2:*::snapshot/*`],
      conditions: { StringEquals: { 'ec2:ResourceTag/CreatedBy': 'EC2 Image Builder' } },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:RunInstances'],
      resources: [
        `arn:${this.partition}:ec2:*::image/*`,
        `arn:${this.partition}:ec2:*::snapshot/*`,
        `arn:${this.partition}:ec2:*:*:subnet/*`,
        `arn:${this.partition}:ec2:*:*:network-interface/*`,
        `arn:${this.partition}:ec2:*:*:security-group/*`,
        `arn:${this.partition}:ec2:*:*:key-pair/*`,
        `arn:${this.partition}:ec2:*:*:launch-template/*`,
        `arn:${this.partition}:license-manager:*:*:license-configuration:*`,
      ],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:RunInstances'],
      resources: [
        `arn:${this.partition}:ec2:*:*:volume/*`,
        `arn:${this.partition}:ec2:*:*:instance/*`,
      ],
      conditions: {
        StringEquals: { 'aws:RequestTag/CreatedBy': ['EC2 Image Builder', 'EC2 Fast Launch'] },
      },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:PassRole'],
      resources: [instanceRole.roleArn],
      conditions: {
        StringEquals: {
          'iam:PassedToService': ['ec2.amazonaws.com', 'ec2.amazonaws.com.cn', 'vmie.amazonaws.com'],
        },
      },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:StopInstances', 'ec2:StartInstances', 'ec2:TerminateInstances'],
      resources: ['*'],
      conditions: { StringEquals: { 'ec2:ResourceTag/CreatedBy': 'EC2 Image Builder' } },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:CopyImage', 'ec2:CreateImage', 'ec2:CreateLaunchTemplate', 'ec2:DeregisterImage',
        'ec2:DescribeImages', 'ec2:DescribeInstanceAttribute', 'ec2:DescribeInstanceStatus',
        'ec2:DescribeInstances', 'ec2:DescribeInstanceTypeOfferings', 'ec2:DescribeInstanceTypes',
        'ec2:DescribeSubnets', 'ec2:DescribeTags', 'ec2:ModifyImageAttribute',
        'ec2:DescribeImportImageTasks', 'ec2:DescribeExportImageTasks', 'ec2:DescribeSnapshots',
        'ec2:DescribeHosts',
      ],
      resources: ['*'],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:ModifySnapshotAttribute'],
      resources: [`arn:${this.partition}:ec2:*::snapshot/*`],
      conditions: { StringEquals: { 'ec2:ResourceTag/CreatedBy': 'EC2 Image Builder' } },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags'],
      resources: ['*'],
      conditions: {
        StringEquals: {
          'ec2:CreateAction': ['RunInstances', 'CreateImage'],
          'aws:RequestTag/CreatedBy': ['EC2 Image Builder', 'EC2 Fast Launch'],
        },
      },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags'],
      resources: [
        `arn:${this.partition}:ec2:*::image/*`,
        `arn:${this.partition}:ec2:*:*:export-image-task/*`,
      ],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:CreateTags'],
      resources: [
        `arn:${this.partition}:ec2:*::snapshot/*`,
        `arn:${this.partition}:ec2:*:*:launch-template/*`,
      ],
      conditions: {
        StringEquals: { 'aws:RequestTag/CreatedBy': ['EC2 Image Builder', 'EC2 Fast Launch'] },
      },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['license-manager:UpdateLicenseSpecificationsForResource'],
      resources: ['*'],
    }));

    // SSM permissions
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ssm:ListCommands', 'ssm:ListCommandInvocations', 'ssm:AddTagsToResource',
        'ssm:DescribeInstanceInformation', 'ssm:GetAutomationExecution',
        'ssm:StopAutomationExecution', 'ssm:ListInventoryEntries',
        'ssm:SendAutomationSignal', 'ssm:DescribeInstanceAssociationsStatus',
        'ssm:DescribeAssociationExecutions', 'ssm:GetCommandInvocation',
        'ssm:GetDocument', 'ssm:GetParameter', 'ssm:PutParameter',
      ],
      resources: ['*'],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [
        `arn:${this.partition}:ssm:*:*:document/AWS-RunPowerShellScript`,
        `arn:${this.partition}:ssm:*:*:document/AWS-RunShellScript`,
        `arn:${this.partition}:ssm:*:*:document/AWSEC2-RunSysprep`,
        `arn:${this.partition}:s3:::*`,
      ],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:SendCommand'],
      resources: [`arn:${this.partition}:ec2:*:*:instance/*`],
      conditions: { StringEquals: { 'ssm:resourceTag/CreatedBy': 'EC2 Image Builder' } },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:StartAutomationExecution'],
      resources: [`arn:${this.partition}:ssm:*:*:automation-definition/ImageBuilder*`],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:CreateAssociation', 'ssm:DeleteAssociation'],
      resources: [
        `arn:${this.partition}:ssm:*:*:document/AWS-GatherSoftwareInventory`,
        `arn:${this.partition}:ssm:*:*:association/*`,
        `arn:${this.partition}:ec2:*:*:instance/*`,
      ],
    }));

    // EBS KMS permissions
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncryptFrom', 'kms:ReEncryptTo', 'kms:GenerateDataKeyWithoutPlaintext'],
      resources: ['*'],
      conditions: {
        'ForAllValues:StringEquals': { 'kms:EncryptionContextKeys': ['aws:ebs:id'] },
        StringLike: { 'kms:ViaService': ['ec2.*.amazonaws.com'] },
      },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:DescribeKey'],
      resources: ['*'],
      conditions: { StringLike: { 'kms:ViaService': ['ec2.*.amazonaws.com'] } },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['kms:CreateGrant'],
      resources: ['*'],
      conditions: {
        Bool: { 'kms:GrantIsForAWSResource': 'true' },
        StringLike: { 'kms:ViaService': ['ec2.*.amazonaws.com'] },
      },
    }));

    // Cross-account distribution
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['sts:AssumeRole'],
      resources: [`arn:${this.partition}:iam::*:role/EC2ImageBuilderDistributionCrossAccountRole`],
    }));

    // Logs
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogStream', 'logs:CreateLogGroup', 'logs:PutLogEvents'],
      resources: [`arn:${this.partition}:logs:*:*:log-group:/aws/imagebuilder/*`],
    }));

    // Launch template management
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: [
        'ec2:CreateLaunchTemplateVersion', 'ec2:DescribeLaunchTemplates',
        'ec2:ModifyLaunchTemplate', 'ec2:DescribeLaunchTemplateVersions',
      ],
      resources: ['*'],
    }));

    // Image export
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:ExportImage'],
      resources: [`arn:${this.partition}:ec2:*::image/*`],
      conditions: { StringEquals: { 'ec2:ResourceTag/CreatedBy': 'EC2 Image Builder' } },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:ExportImage'],
      resources: [`arn:${this.partition}:ec2:*:*:export-image-task/*`],
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:CancelExportTask'],
      resources: [`arn:${this.partition}:ec2:*:*:export-image-task/*`],
      conditions: { StringEquals: { 'ec2:ResourceTag/CreatedBy': 'EC2 Image Builder' } },
    }));

    // Service-linked roles
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['iam:CreateServiceLinkedRole'],
      resources: ['*'],
      conditions: {
        StringEquals: { 'iam:AWSServiceName': ['ssm.amazonaws.com', 'ec2fastlaunch.amazonaws.com'] },
      },
    }));

    // Fast Launch
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ec2:EnableFastLaunch'],
      resources: [
        `arn:${this.partition}:ec2:*::image/*`,
        `arn:${this.partition}:ec2:*:*:launch-template/*`,
      ],
      conditions: { StringEquals: { 'ec2:ResourceTag/CreatedBy': 'EC2 Image Builder' } },
    }));

    // Inspector
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['inspector2:ListCoverage', 'inspector2:ListFindings'],
      resources: ['*'],
    }));

    // ECR
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:CreateRepository'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestTag/CreatedBy': 'EC2 Image Builder' } },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:TagResource'],
      resources: [`arn:${this.partition}:ecr:*:*:repository/image-builder-*`],
      conditions: { StringEquals: { 'aws:RequestTag/CreatedBy': 'EC2 Image Builder' } },
    }));
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ecr:BatchDeleteImage'],
      resources: [`arn:${this.partition}:ecr:*:*:repository/image-builder-*`],
      conditions: { StringEquals: { 'ecr:ResourceTag/CreatedBy': 'EC2 Image Builder' } },
    }));

    // EventBridge rules for Image Builder
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['events:DeleteRule', 'events:DescribeRule', 'events:PutRule', 'events:PutTargets', 'events:RemoveTargets'],
      resources: [`arn:${this.partition}:events:*:*:rule/ImageBuilder-*`],
    }));

    // SSM parameter for AMI
    executionRole.addToPolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter', 'ssm:PutParameter'],
      resources: [`arn:${this.partition}:ssm:${this.region}:${this.account}:parameter/aws/service/ami-amazon-linux-latest/*`],
    }));

    // --- Image Builder Resources ---

    const recipe = new imagebuilder.ImageRecipe(this, 'ImageRecipe', {
      imageRecipeName: `${this.stackName.toLowerCase()}-recipe`,
      baseImage: imagebuilder.BaseImage.fromSsmParameterName(
        '/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
      ),
      components: [{
        component: imagebuilder.AmazonManagedComponent.helloWorld(this, 'HelloWorldComponent', {
          platform: imagebuilder.Platform.LINUX,
        }),
      }],
    });

    const infraConfig = new imagebuilder.InfrastructureConfiguration(this, 'InfraConfig', {
      infrastructureConfigurationName: `${this.stackName.toLowerCase()}-infraconfig`,
      instanceTypes: [new ec2.InstanceType(instanceTypeStr)],
      instanceProfile,
      vpc,
      subnetSelection: { subnets: [subnets[0]] },
      securityGroups: [securityGroup],
      httpTokens: imagebuilder.HttpTokens.REQUIRED,
      terminateInstanceOnFailure: true,
    });

    const distConfig = new imagebuilder.DistributionConfiguration(this, 'DistConfig', {
      distributionConfigurationName: `${this.stackName.toLowerCase()}-distconfig`,
    });
    distConfig.addAmiDistributions({
      amiName: `${this.stackName}-CustomImage-{{ imagebuilder:buildDate }}`,
    });

    const workflow = new imagebuilder.Workflow(this, 'BuildWorkflow', {
      workflowName: `${this.stackName.toLowerCase()}-workflow`,
      description: 'Builds an image where the build instance InstanceId is returned from a custom WaitForAction step',
      workflowType: imagebuilder.WorkflowType.BUILD,
      data: imagebuilder.WorkflowData.fromInline(buildWorkflowYaml({
        builderLambdaName: builderLambda.functionName,
        terminationLambdaName: terminationLambda.functionName,
        collectImageMetadata,
      })),
    });

    const pipeline = new imagebuilder.ImagePipeline(this, 'ImagePipeline', {
      imagePipelineName: `${this.stackName.toLowerCase()}-pipeline`,
      recipe,
      infrastructureConfiguration: infraConfig,
      distributionConfiguration: distConfig,
      executionRole,
      workflows: [{ workflow }],
    });

    // --- CloudWatch Alarms ---

    new cloudwatch.Alarm(this, 'BuilderLambdaErrorAlarm', {
      alarmDescription: 'Builder Lambda function errors',
      metric: builderLambda.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'AMIUpdateLambdaErrorAlarm', {
      alarmDescription: 'AMI Update Lambda function errors',
      metric: amiUpdateLambda.metricErrors({ period: cdk.Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    new cloudwatch.Alarm(this, 'ASGNoInstancesAlarm', {
      alarmDescription: 'ASG has no in-service instances',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/AutoScaling',
        metricName: 'GroupInServiceInstances',
        dimensionsMap: { AutoScalingGroupName: asg.autoScalingGroupName },
        period: cdk.Duration.minutes(5),
        statistic: 'Minimum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    new cloudwatch.Alarm(this, 'DLQDepthAlarm', {
      alarmDescription: 'Builder Lambda DLQ has messages',
      metric: builderDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // --- Outputs ---

    this.imagePipelineArn = pipeline.imagePipelineArn;
    this.launchTemplateId = launchTemplate.launchTemplateId!;
    this.autoScalingGroupName = asg.autoScalingGroupName;

    new cdk.CfnOutput(this, 'ImagePipelineArnOutput', {
      description: 'ARN of the Image Builder Pipeline',
      value: pipeline.imagePipelineArn,
    });
    new cdk.CfnOutput(this, 'LaunchTemplateIdOutput', {
      description: 'ID of the Launch Template',
      value: launchTemplate.launchTemplateId!,
    });
    new cdk.CfnOutput(this, 'AutoScalingGroupNameOutput', {
      description: 'Name of the Auto Scaling Group',
      value: asg.autoScalingGroupName,
    });
  }
}
