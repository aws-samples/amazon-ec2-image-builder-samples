// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { Annotations, Aws, CfnMapping, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import { ISecurityGroup } from 'aws-cdk-lib/aws-ec2';
import {
  AnyPrincipal,
  CfnInstanceProfile,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import {
  CfnComponent,
  CfnDistributionConfiguration,
  CfnImage,
  CfnImagePipeline,
  CfnImageRecipe,
  CfnInfrastructureConfiguration,
} from 'aws-cdk-lib/aws-imagebuilder';
import { Key } from 'aws-cdk-lib/aws-kms';
import { ITopic, Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export type ParentImage = Record<string, Record<string, any>>;
export interface AWSImageBuilderProps {
  cfnImageRecipeName: string;
  storageSize?: number;
  debug?: boolean;
  name: string;
  parentImage: ParentImage;
  subnetId: string;
  imageBuilderSG: ISecurityGroup;
  instanceProfileName: string;
  version: string;
  imageBuilderComponentList: ImageBuilderComponent[];
  runPipelineOnDeploy?: boolean;
}
export const instanceTypes = ['t3.large', 't3.xlarge'];

export interface ImageBuilderComponent {
  /**
   * Name of the component
   */
  name: string;
  /**
   * ARN for AWS managed components, when specified, `data` is not required.
   */
  managedComponentArn?: string;
  /**
   * Content of the component definition yaml file. It will only be used when `managedComponentArn` is not specified
   */
  data?: string;
}

export interface PipelineConfig {
  name: string;
  components: string[];
  instanceProfileName: string;
  cfnImageRecipeName: string;
  version: string;
  parentImage: ParentImage;
  runPipelineOnDeploy?: boolean;
}
/**
 * Provisions one Image Builder pipeline: recipe, infrastructure configuration,
 * distribution configuration, SNS notifications, and the pipeline itself.
 */
export class AWSImageBuilderConstruct extends Construct {
  constructor(scope: Construct, id: string, props: AWSImageBuilderProps) {
    super(scope, id);

    //creates a role for Imagebuilder to build EC2 image
    const imageBuilderRole = new Role(this, `ImageBuilderRole${props.name}`, {
      assumedBy: new ServicePrincipal(`ec2.${Aws.URL_SUFFIX}`),
      path: '/executionServiceEC2Role/',
    });

    const amiTable = new CfnMapping(this, 'ami-table', {
      mapping: props.parentImage,
    });

    const parentImageID: string = amiTable.findInMap(Stack.of(this).region, 'amiID');

    //Adds SSM  Managed policy to role
    imageBuilderRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore')
    );
    //Adds EC2InstanceProfileForImageBuilder policy to role
    imageBuilderRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName('EC2InstanceProfileForImageBuilder')
    );
    //Builds the instance Profile to be attached to EC2 instance created during image building
    const instanceProfile = new CfnInstanceProfile(
      this,
      `imageBuilderProfile${props.name}`,
      {
        roles: [imageBuilderRole.roleName],
        instanceProfileName: `${props.instanceProfileName}-${props.name}-${Aws.REGION}`,
      }
    );
    // Encrypts the notification topic. Image Builder publishes through its
    // service-linked role, which the key policy must allow - the AWS managed
    // SNS key's policy can't be edited to do that. The wildcard principal
    // with the PrincipalArn condition grants exactly that role without
    // requiring it to exist when the key is created (an account-root
    // principal would only delegate to IAM policies, which the
    // service-linked role doesn't have).
    const notificationKey = new Key(this, `NotificationKey${props.name}`, {
      description: 'Encrypts the Image Builder notification topic',
      enableKeyRotation: true,
      // Delete the key with the stack; the construct default retains it
      // (and its monthly charge) after a destroy.
      removalPolicy: RemovalPolicy.DESTROY,
      pendingWindow: Duration.days(7),
    });
    notificationKey.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowImageBuilderNotifications',
        principals: [new AnyPrincipal()],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'aws:PrincipalArn': `arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:role/aws-service-role/imagebuilder.amazonaws.com/AWSServiceRoleForImageBuilder`,
          },
        },
      })
    );
    const notificationTopic = new Topic(this, 'ImgBuilderNotificationTopic', {
      masterKey: notificationKey,
    });

    const terminationConfig = props.debug ? false : true;
    //Manage Infrastructure configurations
    const cfnInfrastructureConfiguration = new CfnInfrastructureConfiguration(
      this,
      `cfnInfrastructureConfiguration${props.name}`,
      {
        name: `infraConfiguration-${props.name}`,
        instanceProfileName: instanceProfile.ref,
        instanceTypes: instanceTypes,
        subnetId: props.subnetId,
        securityGroupIds: [props.imageBuilderSG.securityGroupId],
        snsTopicArn: notificationTopic.topicArn,
        terminateInstanceOnFailure: terminationConfig,
      }
    );

    const componentArn = props.imageBuilderComponentList.map((component) => ({
      componentArn:
        component.managedComponentArn ??
        new CfnComponent(this, `${component.name}`, {
          name: `${component.name}-${props.name}`,
          platform: 'Linux',
          // Components take a fixed semantic version - unlike recipes, they
          // reject x wildcards. Content changes reuse this version and the
          // service increments the build version (1.0.0/1, 1.0.0/2, ...).
          version: '1.0.0',
          data: `${component.data}`,
        }).attrArn,
    }));

    const cfnImageRecipe = new CfnImageRecipe(this, `cfnImageRecipe${props.name}`, {
      name: props.cfnImageRecipeName,
      version: props.version,
      parentImage: parentImageID,
      components: componentArn,
      blockDeviceMappings: [
        {
          deviceName: '/dev/sda1',
          ebs: {
            deleteOnTermination: terminationConfig,
            volumeSize: props.storageSize ?? 128,
            volumeType: 'gp3',
          },
          noDevice: '',
        },
      ],
    });

    const cfnDistributionConfiguration = new CfnDistributionConfiguration(
      this,
      `cfnDistributionConfiguration${props.name}`,
      {
        name: `distributionConfiguration-${props.name}`,
        distributions: [
          {
            region: Stack.of(this).region,
            amiDistributionConfiguration: {
              Name: `${props.name}-{{ imagebuilder:buildDate }}`,
            },
            // Image Builder writes the output AMI ID here on every build.
            // The /imagebuilder/ path matters: the service-linked role's
            // ssm:PutParameter permission is scoped to it, so parameters
            // elsewhere need a custom execution role instead.
            ssmParameterConfigurations: [
              {
                parameterName: `/imagebuilder/${props.name}/latest-ami`,
                dataType: 'aws:ec2:image',
              },
            ],
          },
        ],
      }
    );

    const cfnImagePipeline = new CfnImagePipeline(
      this,
      `imageBuilderPipeline${props.name}`,
      {
        name: `imageBuilderPipeline${props.name}`,
        infrastructureConfigurationArn: cfnInfrastructureConfiguration.attrArn,
        imageRecipeArn: cfnImageRecipe.attrArn,
        distributionConfigurationArn: cfnDistributionConfiguration.attrArn,
      }
    );

    if (props.runPipelineOnDeploy) {
      // Runs the pipeline as part of the deployment. The deployment waits
      // for the image to reach AVAILABLE, typically 15 to 30 minutes. The
      // deployment ID changes whenever the pipeline's configuration changes,
      // so with onUpdate those updates run the pipeline again and build a
      // fresh image.
      new CfnImage(this, `pipelineImage${props.name}`, {
        imagePipelineExecutionSettings: {
          deploymentId: cfnImagePipeline.attrDeploymentId,
          onUpdate: true,
        },
      });
    }

    this.subscribeEmails(notificationTopic);
  }

  private subscribeEmails(notificationTopic: ITopic) {
    const emails = this.node.tryGetContext('buildCompletionNotificationEmails');
    if (emails) {
      if (!Array.isArray(emails)) {
        Annotations.of(this).addWarning(
          'buildCompletionNotificationEmails contains invalid value it should be a list of emails, skip subscription'
        );
      } else {
        (<Array<string>>emails).forEach((email) =>
          notificationTopic.addSubscription(new EmailSubscription(email))
        );
      }
    }
  }
}
