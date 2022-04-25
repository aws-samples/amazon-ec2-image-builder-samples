import { Annotations, Stack, StackProps } from "aws-cdk-lib";
import { IVpc, SecurityGroup, SubnetType, Vpc } from "aws-cdk-lib/aws-ec2";
import { IBucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { ParameterTier, StringParameter } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";
import { existsSync, readdirSync, readFileSync } from "fs";
import * as path from "path";
import {
  AWSImageBuilderConstruct,
  ImageBuilderComponent,
  ParentImage,
  PipelineConfig,
} from "./aws-image-builder";
import { AWSSecureBucket } from "./aws-secure-bucket";

/**
 * AWS Image builder constructs stack
 */
export class ImageBuilderStack extends Stack {
  private readonly imageBuilderToolsBucket: IBucket;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    /**
     * S3 Bucket
     * Hosts the Image builder Installation files code.
     */
    this.imageBuilderToolsBucket = new AWSSecureBucket(
      this,
      "toolsBucket",
      {}
    ).bucket;

    const vpc = Vpc.fromLookup(this, "vpc", {
      isDefault: true,
    });

    /**
     * S3 Deploy
     * Uploads react built code to the S3 bucket and invalidates CloudFront
     */

    new BucketDeployment(this, "Deploy-components", {
      sources: [Source.asset("./image-builder-components")],
      destinationBucket: this.imageBuilderToolsBucket,
      memoryLimit: 3008,
      prune: false,
    });

    // 👇 Create a SG for a Image builder server
    const imageBuilderSG = new SecurityGroup(this, "image-server-sg", {
      vpc: vpc,
      allowAllOutbound: true,
      description: "security group for a image builder server",
    });
    // Choose the subnet Image builder server - ensure it has internet
    const imageBuilderSubnetId = vpc.selectSubnets({
      subnetType: SubnetType.PUBLIC,
    }).subnetIds[0];

    const imageBuilderPipelineConfigurations =
      this.validAndGetPipelineConfiguration();
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
    const dir = imageBuilderPipeline.dir;
    const files = readdirSync(dir);
    if (files.some((f) => !existsSync(f))) {
    }
    const componentList: ImageBuilderComponent[] = files.map((file) => ({
      name: file.split(".")[0],
      data: this.getData(dir, file),
    }));
    const parentImage: ParentImage = imageBuilderPipeline.parentImage;

    const amiIdLocation = new StringParameter(this, "Parameter", {
      description: `The value of image`,
      parameterName: `ec2image_ami_${imageBuilderPipeline.name}`,
      stringValue: "n/a",
      tier: ParameterTier.ADVANCED,
    });

    new AWSImageBuilderConstruct(
      this,
      `AWS-ImageBuilder-Events-${imageBuilderPipeline.name}`,
      {
        imageBuilderToolsBucket: this.imageBuilderToolsBucket,
        name: imageBuilderPipeline.name,
        subnetId: imageBuilderSubnetId,
        imageBuilderSG: imageBuilderSG,
        instanceProfileName: imageBuilderPipeline.instanceProfileName,
        imageBuilderComponentList: componentList,
        cfnImageRecipeName: imageBuilderPipeline.cfnImageRecipeName,
        version: imageBuilderPipeline.version,
        parentImage: parentImage,
        amiIdLocation: amiIdLocation,
        vpc: vpc,
      }
    );
  }

  validAndGetPipelineConfiguration() {
    // Get pipeline details from json
    const imageBuilderPipelineConfigurations = this.node.tryGetContext(
      "ImageBuilderPipelineConfigurations"
    );

    if (
      imageBuilderPipelineConfigurations ||
      imageBuilderPipelineConfigurations === ""
    ) {
      if (Array.isArray(imageBuilderPipelineConfigurations)) {
        if (imageBuilderPipelineConfigurations.length === 0) {
          Annotations.of(this).addError(
            "An ImageBuilder pipeline configuration list requires at least one configration, found 0"
          );
          return;
        }

        if (
          (<Array<PipelineConfig>>imageBuilderPipelineConfigurations).some(
            (pipeConfig) =>
              !pipeConfig.name ||
              !pipeConfig.dir ||
              !pipeConfig.instanceProfileName ||
              !pipeConfig.version ||
              !pipeConfig.cfnImageRecipeName ||
              !pipeConfig.parentImage
          )
        ) {
          Annotations.of(this).addError(
            "An ImageBuilder pipeline configuration is missing one of the following required values: name, dir, instanceProfileName, version, cfnImageRecipeName, parentImage"
          );
          return;
        }
      } else {
        Annotations.of(this).addError(
          "The imageBuilderPipelinesConfiguration variable must be an array"
        );
        return;
      }
    } else {
      Annotations.of(this).addError(
        "Mandaotry configuration ImageBuilderPipelineConfigurations is missing, expecting a list of pipeline configurations"
      );
      return;
    }
    return imageBuilderPipelineConfigurations;
  }

  getData = (dir: string, file: string) => {
    const filePath = path.join(__dirname, "..", dir, file);
    if (!existsSync(filePath)) {
      Annotations.of(this).addError(
        `Component file ${filePath} does not exists`
      );
      return "";
    }
    return readFileSync(path.join(__dirname, "..", dir, file)).toString();
  };
}
