import { PythonFunction } from "@aws-cdk/aws-lambda-python-alpha";
import {
  Annotations,
  Aws,
  CfnMapping,
  CustomResource,
  Duration,
  Stack,
} from "aws-cdk-lib";
import { ISecurityGroup, IVpc } from "aws-cdk-lib/aws-ec2";
import {
  CfnInstanceProfile,
  Effect,
  ManagedPolicy,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import {
  CfnComponent,
  CfnImagePipeline,
  CfnImageRecipe,
  CfnInfrastructureConfiguration,
} from "aws-cdk-lib/aws-imagebuilder";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { ITopic, Topic } from "aws-cdk-lib/aws-sns";
import {
  EmailSubscription,
  LambdaSubscription,
} from "aws-cdk-lib/aws-sns-subscriptions";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import * as cr from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";

export type ParentImage = Record<string, Record<string, any>>;
export interface AWSImageBuilderProps {
  cfnImageRecipeName: string;
  name: string;
  parentImage: ParentImage;
  subnetId: string;
  imageBuilderToolsBucket: IBucket;
  imageBuilderSG: ISecurityGroup;
  instanceProfileName: string;
  version: string;
  imageBuilderComponentList: ImageBuilderComponent[];
  amiIdLocation: StringParameter;
  vpc: IVpc;
}
export const instanceTypes = ["t3.large", "t3.xlarge"];

export const HYPHEN = /-/gi;

export const os_types = { LINUX: "Linux" };
export interface ImageBuilderComponent {
  name: string;
  data: string;
}

export interface SSMBuilderComponent {
  name: string;
  content: string;
  documentType: string;
  ssmDocumentName: string;
}

export interface PipelineConfig {
  name: string;
  dir: string;
  instanceProfileName: string;
  cfnImageRecipeName: string;
  version: string;
  parentImage: Record<string, string>;
}
/**
 * Awsimage builder stack
 */
export class AWSImageBuilderConstruct extends Construct {
  constructor(scope: Construct, id: string, props: AWSImageBuilderProps) {
    super(scope, id);

    //creates a role for Imagebuilder to build EC2 image
    const imageBuilderRole = new Role(this, `ImageBuilderRole${props.name}`, {
      assumedBy: new ServicePrincipal("ec2.amazonaws.com"),
      path: "/executionServiceEC2Role/",
    });

    const amiTable = new CfnMapping(this, "ami-table", {
      mapping: props.parentImage,
    });

    const parentImageID: string = amiTable.findInMap(
      Stack.of(this).region,
      "amiID"
    );

    //creates a the necessary policy for Imagebuilder to build EC2 image
    imageBuilderRole.addToPolicy(
      new PolicyStatement({
        resources: ["*"],
        actions: ["s3:PutObject"],
      })
    );

    //Adds SSM  Managed policy to role
    imageBuilderRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName("AmazonSSMManagedInstanceCore")
    );
    //Adds EC2InstanceProfileForImageBuilder policy to role
    imageBuilderRole.addManagedPolicy(
      ManagedPolicy.fromAwsManagedPolicyName(
        "EC2InstanceProfileForImageBuilder"
      )
    );
    //Builds the instance Profile to be attached to EC2 instance created during image building
    const instanceProfile = new CfnInstanceProfile(
      this,
      `imageBuilderProfile${props.name}`,
      {
        roles: [imageBuilderRole.roleName],
        instanceProfileName: `${props.instanceProfileName}-${Aws.REGION}`,
      }
    );
    const notificationTopic = new Topic(
      this,
      "ImgBuilderNotificationTopic",
      {}
    );

    //Manage Infrastructure configurations
    const cfnInfrastructureConfiguration = new CfnInfrastructureConfiguration(
      this,
      `cfnInfrastructureConfiguration${props.name}`,
      {
        name: "infraConfiguration",
        instanceProfileName: `${props.instanceProfileName}-${Aws.REGION}`,
        instanceTypes: instanceTypes,
        subnetId: props.subnetId,
        securityGroupIds: [props.imageBuilderSG.securityGroupId],
        snsTopicArn: notificationTopic.topicArn,
      }
    );

    const componentArn = props.imageBuilderComponentList.map(
      (componentList) => ({
        componentArn: new CfnComponent(this, `${componentList.name}`, {
          name: `${componentList.name}`,
          platform: os_types.LINUX,
          version: props.version,
          data: `${componentList.data}`,
        }).attrArn,
      })
    );

    const cfnImageRecipe = new CfnImageRecipe(
      this,
      `cfnImageRecipe${props.name}`,
      {
        name: props.cfnImageRecipeName,
        version: props.version,
        parentImage: parentImageID,
        components: componentArn,
      }
    );

    const cfnImageBuilderPipeline = new CfnImagePipeline(
      this,
      `imageBuilderPipeline${props.name}`,
      {
        name: `imageBuilderPipeline${props.name}`,
        infrastructureConfigurationArn: cfnInfrastructureConfiguration.attrArn,
        imageRecipeArn: cfnImageRecipe.attrArn,
      }
    );
    const imagebuilderCr = new PythonFunction(this, "imagebuilderCr", {
      entry: "lib/lambda/imagebuilder",
      runtime: Runtime.PYTHON_3_8,
      index: "app.py",
      handler: "lambda_handler",
      environment: {
        IMAGE_SSM_NAME: props.amiIdLocation.parameterName,
      },
      timeout: Duration.seconds(45),
      initialPolicy: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["imagebuilder:StartImagePipelineExecution"],
          resources: [
            `arn:aws:imagebuilder:${Stack.of(this).region}:${
              Stack.of(this).account
            }:image/*`,
            `arn:aws:imagebuilder:${Stack.of(this).region}:${
              Stack.of(this).account
            }:image-pipeline/*`,
          ],
        }),
      ],
    });

    imagebuilderCr.node.addDependency(cfnImageBuilderPipeline);

    const pipelineTriggerCrProvider = new cr.Provider(
      this,
      "pipelineTriggerCrProvider",
      {
        onEventHandler: imagebuilderCr,
        logRetention: RetentionDays.ONE_DAY,
      }
    );

    new CustomResource(this, id, {
      serviceToken: pipelineTriggerCrProvider.serviceToken,
      properties: {
        PIIPELINE_ARN: `arn:aws:imagebuilder:${Stack.of(this).region}:${
          Stack.of(this).account
        }:image-pipeline/${cfnImageBuilderPipeline.name.toLowerCase()}`,
      },
    });
    const amiIdRecorder = new PythonFunction(this, "imageRecorder", {
      entry: "lib/lambda/recorder",
      runtime: Runtime.PYTHON_3_8,
      index: "app.py",
      handler: "lambda_handler",
      environment: {
        IMAGE_SSM_NAME: props.amiIdLocation.parameterName,
      },
    });

    props.amiIdLocation.grantRead(amiIdRecorder);
    props.amiIdLocation.grantWrite(amiIdRecorder);

    notificationTopic.addSubscription(new LambdaSubscription(amiIdRecorder));
    this.subscribeEmails(notificationTopic);

    cfnInfrastructureConfiguration.addDependsOn(instanceProfile);
    cfnImageBuilderPipeline.addDependsOn(cfnInfrastructureConfiguration);
  }

  private subscribeEmails(notificationTopic: ITopic) {
    const emails = this.node.tryGetContext("buildCompletionNotificationEmails");
    if (emails) {
      if (!Array.isArray(emails)) {
        Annotations.of(this).addWarning(
          "buildCompletionNotificationEmails contains invalid value it should be a list of emails, skip subscription"
        );
      } else {
        (<Array<string>>emails).forEach((email) =>
          notificationTopic.addSubscription(new EmailSubscription(email))
        );
      }
    }
  }
}
