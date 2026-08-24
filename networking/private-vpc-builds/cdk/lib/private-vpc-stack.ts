// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as imagebuilder from '@aws-cdk/aws-imagebuilder-alpha';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * EC2 Image Builder in a private VPC with no internet access: an isolated
 * VPC whose only exits are VPC endpoints, and a complete Amazon Linux 2023
 * image pipeline that builds inside it. The S3 endpoint policy allowlists
 * exactly the buckets a build needs.
 */
export class PrivateVpcBuildStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // One isolated subnet: no internet gateway, no NAT, no egress route.
    // Everything the build instance talks to goes through the endpoints
    // below.
    const vpc = new ec2.Vpc(this, 'BuildVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/24'),
      maxAzs: 1,
      subnetConfiguration: [
        {
          name: 'build',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 25,
        },
      ],
    });

    // The build instance's security group. No ingress at all - the SSM
    // Agent initiates every connection outbound. The VPC has no internet
    // route, so this egress can only ever reach the VPC endpoints and the
    // S3 gateway endpoint.
    const instanceSecurityGroup = new ec2.SecurityGroup(this, 'BuildInstanceSecurityGroup', {
      vpc,
      description: 'Image Builder build instances (no ingress)',
      allowAllOutbound: false,
    });
    instanceSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS to VPC endpoints and the S3 gateway endpoint',
    );

    // Interface endpoints only accept connections this group allows in.
    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'EndpointSecurityGroup', {
      vpc,
      description: 'VPC interface endpoints for Image Builder builds',
      allowAllOutbound: false,
    });
    endpointSecurityGroup.addIngressRule(
      instanceSecurityGroup,
      ec2.Port.tcp(443),
      'HTTPS from build instances',
    );

    // Each endpoint carries a specific part of a build - the README's
    // common-errors table maps the failure you see to the endpoint that's
    // missing. KMS is only exercised when components decrypt KMS-encrypted
    // values, but most real components eventually do.
    const interfaceEndpoints: [string, ec2.InterfaceVpcEndpointAwsService][] = [
      ['Ssm', ec2.InterfaceVpcEndpointAwsService.SSM],
      ['SsmMessages', ec2.InterfaceVpcEndpointAwsService.SSM_MESSAGES],
      ['ImageBuilder', ec2.InterfaceVpcEndpointAwsService.IMAGE_BUILDER],
      ['Logs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      ['Kms', ec2.InterfaceVpcEndpointAwsService.KMS],
    ];
    for (const [name, service] of interfaceEndpoints) {
      vpc.addInterfaceEndpoint(`${name}Endpoint`, {
        service,
        securityGroups: [endpointSecurityGroup],
        privateDnsEnabled: true,
        // Without this the construct adds a 443-from-VPC-CIDR ingress rule,
        // wider than the instance-SG-only rule above.
        open: false,
      });
    }

    // Detailed build logs land here. The bucket has versioning enabled - to
    // delete the stack, remove all object versions and delete markers first.
    const logBucket = new s3.Bucket(this, 'BuildLogBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      versioned: true,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(90),
          noncurrentVersionExpiration: cdk.Duration.days(7),
        },
      ],
    });

    // The S3 gateway endpoint, with a policy allowlisting exactly the
    // buckets a build touches. Every entry maps to a concrete failure when
    // it's missing - see the README's common-errors table.
    const s3Endpoint = vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });
    s3Endpoint.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ImageBuilderBuildReads',
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject'],
        resources: [
          // AWSTOE bootstrap - the component manager binary itself.
          `arn:${this.partition}:s3:::ec2imagebuilder-toe-${this.region}-prod/*`,
          // Amazon-managed component content (the boot-test component below).
          `arn:${this.partition}:s3:::ec2imagebuilder-managed-resources-${this.region}-prod/components/*`,
          // SSM Agent install/update packages - Image Builder's default user
          // data bootstraps the agent from here on Linux bases without it.
          `arn:${this.partition}:s3:::amazon-ssm-${this.region}/*`,
          // Amazon Linux 2023 package repositories - OS updates resolve to
          // regional S3 buckets, so patching works with no internet.
          `arn:${this.partition}:s3:::al2023-repos-${this.region}-de612dc2/*`,
        ],
      }),
    );
    s3Endpoint.addToPolicy(
      new iam.PolicyStatement({
        sid: 'BuildLogWrites',
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [logBucket.arnForObjects('*')],
      }),
    );

    // The managed image reference defaults to version x.x.x, which resolves
    // to the latest release of the AL2023 base at build time.
    const baseImage = imagebuilder.AmazonManagedImage.amazonLinux2023(this, 'BaseImage', {
      imageArchitecture: imagebuilder.ImageArchitecture.X86_64,
      imageType: imagebuilder.ImageType.AMI,
    });

    // dnf resolves the AL2023 regional S3 repositories - allowed through
    // the S3 endpoint policy above, so package installs work offline.
    const repoInstall = new imagebuilder.Component(this, 'RepoInstallComponent', {
      componentName: 'private-vpc-repo-install-cdk',
      // Creating a component needs a concrete version (x wildcards are for
      // references). The service increments the build number behind the same
      // version when the document changes.
      componentVersion: '1.0.0',
      platform: imagebuilder.Platform.LINUX,
      description: 'Installs httpd from the AL2023 package repositories.',
      data: imagebuilder.ComponentData.fromComponentDocumentJsonObject({
        name: 'private-vpc-repo-install',
        description: 'Installs httpd from the AL2023 package repositories.',
        schemaVersion: imagebuilder.ComponentSchemaVersion.V1_0,
        phases: [
          {
            name: imagebuilder.ComponentPhaseName.BUILD,
            steps: [
              {
                name: 'InstallFromRepos',
                action: imagebuilder.ComponentAction.EXECUTE_BASH,
                inputs: imagebuilder.ComponentStepInputs.fromObject({
                  commands: ['dnf -y install httpd', 'httpd -v'],
                }),
              },
            ],
          },
        ],
      }),
    });

    // An Amazon-managed test component - its content downloads from the
    // managed-resources bucket in the S3 endpoint policy.
    const bootTest = imagebuilder.AmazonManagedComponent.fromAmazonManagedComponentName(
      this,
      'BootTestComponent',
      'simple-boot-test-linux',
    );

    const recipe = new imagebuilder.ImageRecipe(this, 'Recipe', {
      imageRecipeName: 'private-vpc-build-cdk',
      // x auto-increments the build version, so updates that replace the
      // recipe never collide with an existing name + version pair.
      imageRecipeVersion: '1.0.x',
      baseImage: imagebuilder.BaseImage.fromImage(baseImage),
      components: [{ component: repoInstall }, { component: bootTest }],
    });

    // The wiring that makes the whole sample: build instances launch in the
    // isolated subnet with the endpoint-only security group. The construct
    // generates the instance profile: the two Image Builder baseline managed
    // policies plus write access to the log bucket.
    const infrastructure = new imagebuilder.InfrastructureConfiguration(this, 'Infrastructure', {
      infrastructureConfigurationName: 'private-vpc-build-cdk',
      instanceTypes: [ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MEDIUM)],
      vpc,
      subnetSelection: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [instanceSecurityGroup],
      logging: { s3Bucket: logBucket },
    });

    // The service writes this parameter after each build (under
    // /imagebuilder/, the only path the service-linked role can write), so
    // it's imported, not created. forceDynamicReference keeps the import
    // from resolving at deploy time, before the parameter exists.
    const amiParameter = ssm.StringParameter.fromStringParameterAttributes(this, 'AmiParameter', {
      parameterName: '/imagebuilder/private-vpc-build-cdk/latest-ami',
      forceDynamicReference: true,
    });

    // Publishes each build's AMI ID for downstream consumers. The parameter
    // is service-managed, so deleting the stack doesn't delete it - the
    // cleanup steps in the README do.
    const distribution = new imagebuilder.DistributionConfiguration(this, 'Distribution', {
      distributionConfigurationName: 'private-vpc-build-cdk',
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
      logGroupName: '/aws/imagebuilder/pipeline/private-vpc-build-cdk',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const imageLogGroup = new logs.LogGroup(this, 'ImageLogGroup', {
      logGroupName: '/aws/imagebuilder/private-vpc-build-cdk',
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Creating the pipeline doesn't start a build - see the README for how
    // to run it.
    const pipeline = new imagebuilder.ImagePipeline(this, 'Pipeline', {
      imagePipelineName: 'private-vpc-build-cdk',
      description:
        'Builds Amazon Linux 2023 inside an isolated VPC where the only network paths are VPC endpoints.',
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
    new cdk.CfnOutput(this, 'VpcId', {
      description: 'The isolated VPC the build runs in.',
      value: vpc.vpcId,
    });
    new cdk.CfnOutput(this, 'LogBucketName', {
      description: 'S3 bucket receiving detailed build logs.',
      value: logBucket.bucketName,
    });
  }
}
