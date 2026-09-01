// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import { Annotations, Stack, StackProps, Token } from 'aws-cdk-lib';
import { SecurityGroup, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { existsSync, readdirSync, readFileSync, lstatSync } from 'fs';
import * as path from 'path';
import {
  AWSImageBuilderConstruct,
  ImageBuilderComponent,
  PipelineConfig,
} from './aws-image-builder';

/**
 * AWS Image builder construct stack
 */
export class ImageBuilderStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // Set the vpcId and subnetId context values to build in your own VPC;
    // without them the stack uses the default VPC's first public subnet.
    const vpcId = this.node.tryGetContext('vpcId');
    const subnetIdOverride = this.node.tryGetContext('subnetId');
    if (subnetIdOverride && !vpcId) {
      Annotations.of(this).addError(
        'subnetId requires vpcId - the security group is created in the VPC, and both must match'
      );
    }
    const vpc = vpcId
      ? Vpc.fromLookup(this, 'vpc', { vpcId })
      : Vpc.fromLookup(this, 'vpc', { isDefault: true });

    // 👇 Create a SG for a Image builder server
    const imageBuilderSG = new SecurityGroup(this, 'image-server-sg', {
      vpc: vpc,
      allowAllOutbound: true,
      description: 'security group for a image builder server',
    });
    // The build subnet needs a path to Systems Manager and S3 - internet
    // access, or the SSM/S3 VPC endpoints in a private subnet.
    const imageBuilderSubnetId =
      subnetIdOverride ??
      vpc.selectSubnets({ subnetType: SubnetType.PUBLIC }).subnetIds[0];

    const imageBuilderPipelineConfigurations = this.validAndGetPipelineConfiguration();
    if (!imageBuilderPipelineConfigurations) {
      return;
    }

    for (const imageBuilderPipeline of imageBuilderPipelineConfigurations) {
      this.createImageBuilderByConfig(
        imageBuilderPipeline,
        imageBuilderSubnetId,
        imageBuilderSG
      );
    }
  }

  private createImageBuilderByConfig(
    imageBuilderPipeline: any,
    imageBuilderSubnetId: string,
    imageBuilderSG: SecurityGroup
  ) {
    // get component list
    const componentList = this.parseComponentList(imageBuilderPipeline.components);

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
        runPipelineOnDeploy: imageBuilderPipeline.runPipelineOnDeploy,
      }
    );
  }

  private parseComponentList(components: string[]): ImageBuilderComponent[] {
    // The entry in the components can be in one of the following types
    // - an AWS managed component, as name/version or as a full arn
    // - a directory name that contains one or more component yaml files in it
    // - a specific path to a component yaml file
    // this function will parse the list and generate entries for each of them

    const componentList: ImageBuilderComponent[] = [];

    for (const component of components) {
      // AWS managed component referenced as name/version, matching
      //   update-linux/x.x.x
      // The region always matches the deployment, so the stack builds the ARN.
      const managedMatch = component.match(
        /^([a-z0-9-_]+)\/([0-9x]+\.[0-9x]+\.[0-9x]+)$/
      );
      if (managedMatch) {
        componentList.push({
          name: managedMatch[1],
          managedComponentArn: `arn:${this.partition}:imagebuilder:${this.region}:aws:component/${component}`,
        });
        continue;
      }

      // Full AWS managed component ARN, used as written, matching
      //   arn:aws:imagebuilder:us-west-2:aws:component/update-linux/x.x.x
      // with the region, name, and version (minus any build number) captured. A recipe can't reference
      // a component in another region, so a mismatch fails here with a clear
      // message rather than at deploy time.
      const arnMatch = component.match(
        /^arn:[a-z-]+:imagebuilder:([a-z0-9-]+):aws:component\/([a-z0-9-_]+)\/([^/]+)(?:\/\d+)?$/
      );
      if (arnMatch) {
        const [, arnRegion, name, version] = arnMatch;
        if (!Token.isUnresolved(this.region) && arnRegion !== this.region) {
          Annotations.of(this).addError(
            `Managed component ARN ${component} is in ${arnRegion}, but the stack deploys to ${this.region}. Reference it as ${name}/${version} to use the deployment region.`
          );
        }
        componentList.push({ name, managedComponentArn: component });
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
          `Component entry ${component} is not a file or directory (looked at ${filePath}), a managed component name/version like update-linux/x.x.x, or a managed component ARN.`
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
            'An ImageBuilder pipeline configuration list requires at least one configuration, found 0'
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
