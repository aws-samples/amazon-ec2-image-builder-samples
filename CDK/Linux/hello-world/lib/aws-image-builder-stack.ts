import { Annotations, Stack, StackProps } from 'aws-cdk-lib';
import { IVpc, SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { IBucket } from 'aws-cdk-lib/aws-s3';
import { ParameterTier, StringParameter } from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';
import { existsSync, readdirSync, readFileSync, lstatSync } from 'fs';
import * as path from 'path';
import {
  AWSImageBuilderConstruct,
  ImageBuilderComponent,
  ParentImage,
  PipelineConfig,
} from './aws-image-builder';

/**
 * AWS Image builder construct stack
 */
export class ImageBuilderStack extends Stack {
  private readonly imageBuilderToolsBucket: IBucket;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    const vpc = Vpc.fromLookup(this, 'vpc', {
      isDefault: true,
    });

    // 👇 Create a SG for a Image builder server
    const imageBuilderSG = new SecurityGroup(this, 'image-server-sg', {
      vpc: vpc,
      allowAllOutbound: true,
      description: 'security group for a image builder server',
    });
    // Choose the subnet Image builder server - ensure it has internet
    const imageBuilderSubnetId = vpc.selectSubnets({
      subnetType: SubnetType.PUBLIC,
    }).subnetIds[0];

    const imageBuilderPipelineConfigurations = this.validAndGetPipelineConfiguration();
    if (!imageBuilderPipelineConfigurations) {
      return;
    }

    for (const imageBuilderPipeline of imageBuilderPipelineConfigurations) {
      this.createImageBuilderByConfig(
        imageBuilderPipeline,
        imageBuilderSubnetId,
        imageBuilderSG,
        vpc
      );
    }
  }

  private createImageBuilderByConfig(
    imageBuilderPipeline: any,
    imageBuilderSubnetId: string,
    imageBuilderSG: SecurityGroup,
    vpc: IVpc
  ) {
    // get component list
    const componentList = this.parseComponentList(imageBuilderPipeline.components);

    const amiIdSSMParameter = new StringParameter(this, 'amiIDSSMParameter', {
      description: `The id of the ec2 AMI image that is built by image builder pipeline ${imageBuilderPipeline.name}`,
      parameterName: `imagebuilder_ami_${imageBuilderPipeline.name}`,
      stringValue: 'n/a',
      tier: ParameterTier.ADVANCED,
    });

    new AWSImageBuilderConstruct(
      this,
      `AWS-ImageBuilder-Events-${imageBuilderPipeline.name}`,
      {
        name: imageBuilderPipeline.name,
        subnetId: imageBuilderSubnetId,
        imageBuilderSG: imageBuilderSG,
        debug: imageBuilderPipeline.debug,
        storageSize: imageBuilderPipeline.storageSize,
        instanceProfileName: imageBuilderPipeline.instanceProfileName,
        imageBuilderComponentList: componentList,
        cfnImageRecipeName: imageBuilderPipeline.cfnImageRecipeName,
        version: imageBuilderPipeline.version,
        parentImage: imageBuilderPipeline.parentImage,
        amiIdSSMParameter: amiIdSSMParameter,
        vpc: vpc,
      }
    );
  }

  private parseComponentList(components: string[]): ImageBuilderComponent[] {
    // The entry in the components can be in one of the following three types
    // - arn for AWS managed components
    // - a directory name that contains one or more component yaml files in it
    // - a specific path to a component yaml file
    // this function will parse the list and generate entries for each of them

    const componentList: ImageBuilderComponent[] = [];

    for (const component of components) {
      // test if component is a valid AWS managed component arn
      const arnMatch = component.match(
        /^arn:(?:aws|aws-cn|aws-us-gov|aws-iso|aws-iso-b):imagebuilder:[a-z0-9\-]*:aws:component\/([\w\-]*)\/.*/
      );
      if (arnMatch && arnMatch.length > 1) {
        componentList.push({ name: arnMatch[1], managedComponentArn: component });
        continue;
      }

      // test if specified component is a directory
      const dirPath = path.join(__dirname, '..', component);
      if (existsSync(dirPath)) {
        if (lstatSync(dirPath).isDirectory()) {
          const files = readdirSync(path.join(__dirname, '..', component), {
            encoding: 'utf-8',
          });
          if (files && files.length > 0) {
            for (const file of files) {
              const filePath = path.join(__dirname, '..', component, file);
              if (existsSync(filePath)) {
                const data = readFileSync(filePath, { encoding: 'utf-8' });
                componentList.push({
                  name: file.split('.')[0],
                  data,
                });
              }
            }
          }
          continue;
        }
      }

      // if not above, then specified component is a single file
      const filePath = path.join(__dirname, '..', component);
      if (existsSync(filePath)) {
        const filename = path.basename(filePath);
        const data = readFileSync(filePath, { encoding: 'utf-8' });
        componentList.push({
          name: filename.split('.')[0],
          data,
        });
      } else {
        Annotations.of(this).addError(
          `Specified component path ${filePath} cannot be found.`
        );
      }
    }

    // return the component list
    return componentList;
  }

  private validAndGetPipelineConfiguration() {
    // Get pipeline details from json
    const imageBuilderPipelineConfigurations = this.node.tryGetContext(
      'ImageBuilderPipelineConfigurations'
    );

    if (imageBuilderPipelineConfigurations || imageBuilderPipelineConfigurations === '') {
      if (Array.isArray(imageBuilderPipelineConfigurations)) {
        if (imageBuilderPipelineConfigurations.length === 0) {
          Annotations.of(this).addError(
            'An ImageBuilder pipeline configuration list requires at least one configration, found 0'
          );
          return;
        }

        if (
          (<Array<PipelineConfig>>imageBuilderPipelineConfigurations).some(
            (pipeConfig) =>
              !pipeConfig.name ||
              !pipeConfig.components ||
              !pipeConfig.instanceProfileName ||
              !pipeConfig.version ||
              !pipeConfig.cfnImageRecipeName ||
              !pipeConfig.parentImage
          )
        ) {
          Annotations.of(this).addError(
            'An ImageBuilder pipeline configuration is missing one of the following required values: name, components, instanceProfileName, version, cfnImageRecipeName, parentImage'
          );
          return;
        }
      } else {
        Annotations.of(this).addError(
          'The imageBuilderPipelinesConfiguration variable must be an array'
        );
        return;
      }
    } else {
      Annotations.of(this).addError(
        'Mandatory configuration ImageBuilderPipelineConfigurations is missing, expecting a list of pipeline configurations'
      );
      return;
    }
    return imageBuilderPipelineConfigurations;
  }
}
