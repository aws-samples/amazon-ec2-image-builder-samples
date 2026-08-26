// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as imagebuilder from '@aws-cdk/aws-imagebuilder-alpha';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import * as path from 'path';

// The pinned artifact the web-download-verified component fetches - a
// versioned Systems Manager agent package, so the URL and checksum stay
// stable. Swap in your own artifact and its checksum.
const DOWNLOAD_SOURCE =
  'https://s3.amazonaws.com/ec2-downloads-windows/SSMAgent/3.3.1957.0/linux_amd64/amazon-ssm-agent.rpm';
const DOWNLOAD_SHA256 = '8751efcc9aa19ac70f810f9a50bf1b60de14d73b3ec61f4c18a9e4104f58765b';

const WORKING_DIR = '/opt/build-work';

/**
 * One pipeline that runs every cookbook component against Amazon Linux 2023.
 * Each component document is loaded from the cookbook/ directory as an
 * asset, so the file next to this app is the single source of truth - the
 * same file you iterate on with awstoe-local.sh.
 */
export class CookbookStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const cookbookDir = path.join(__dirname, '..', '..', 'cookbook');
    const component = (name: string): imagebuilder.Component =>
      new imagebuilder.Component(this, `${name}Component`, {
        componentName: `cookbook-${name}`,
        // Creating a component needs a concrete version (x wildcards are for
        // references). When the document changes, the service increments the
        // build number behind the same version, so updates deploy without
        // editing this value.
        componentVersion: '1.0.0',
        platform: imagebuilder.Platform.LINUX,
        data: imagebuilder.ComponentData.fromAsset(
          this,
          `${name}Asset`,
          path.join(cookbookDir, `${name}.yml`),
        ),
      });

    const baseImage = imagebuilder.AmazonManagedImage.amazonLinux2023(this, 'BaseImage', {
      imageArchitecture: imagebuilder.ImageArchitecture.X86_64,
      imageType: imagebuilder.ImageType.AMI,
    });

    const recipe = new imagebuilder.ImageRecipe(this, 'Recipe', {
      imageRecipeName: 'awstoe-cookbook',
      // x auto-increments the build version, so updates that replace the
      // recipe never collide with an existing name + version pair.
      imageRecipeVersion: '1.0.x',
      baseImage: imagebuilder.BaseImage.fromImage(baseImage),
      // Disk-backed on purpose: /tmp (the default) is memory-backed tmpfs on
      // Amazon Linux 2023, so nothing written there survives into the image.
      // A custom working directory is also the fix for hardened bases that
      // mount /tmp noexec.
      workingDirectory: WORKING_DIR,
      // Components run in list order.
      components: [
        { component: component('conditional-install') },
        { component: component('foreach-install') },
        {
          component: component('web-download-verified'),
          parameters: {
            source: imagebuilder.ComponentParameterValue.fromString(DOWNLOAD_SOURCE),
            sha256: imagebuilder.ComponentParameterValue.fromString(DOWNLOAD_SHA256),
          },
        },
        { component: component('secrets-at-build-time') },
        { component: component('tolerated-failure') },
        { component: component('reboot-and-resume') },
      ],
    });

    // The two Image Builder baseline managed policies, plus read access to
    // the SecureString the secrets component fetches. Decryption with the
    // default aws/ssm key comes with the GetParameter call.
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });
    instanceRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'ssm',
            resource: 'parameter',
            resourceName: 'cookbook/build-secret',
          }),
        ],
      }),
    );

    // With no vpc set, build instances launch in the account's default VPC.
    const infrastructure = new imagebuilder.InfrastructureConfiguration(this, 'Infrastructure', {
      infrastructureConfigurationName: 'awstoe-cookbook',
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM)],
      role: instanceRole,
    });

    const distribution = new imagebuilder.DistributionConfiguration(this, 'Distribution', {
      distributionConfigurationName: 'awstoe-cookbook',
      amiDistributions: [
        {
          amiName: 'awstoe-cookbook-{{ imagebuilder:buildDate }}',
        },
      ],
    });

    const pipelineLogGroup = new logs.LogGroup(this, 'PipelineLogGroup', {
      logGroupName: '/aws/imagebuilder/pipeline/awstoe-cookbook',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const imageLogGroup = new logs.LogGroup(this, 'ImageLogGroup', {
      logGroupName: '/aws/imagebuilder/awstoe-cookbook',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Creating the pipeline doesn't start a build - without a schedule it
    // only builds on demand.
    const pipeline = new imagebuilder.ImagePipeline(this, 'Pipeline', {
      imagePipelineName: 'awstoe-cookbook',
      description: 'Runs every cookbook component against Amazon Linux 2023.',
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
  }
}
