import * as cdk from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { ImageBuilderStack } from '../lib/aws-image-builder-stack';

test('test stack can be built', () => {
  const context = {
    buildCompletionNotificationEmails: ['AlejandroRosalez@example.com'],
    ImageBuilderPipelineConfigurations: [
      {
        name: 'sampleimg',
        components: [
          'update-linux/x.x.x',
          'arn:aws:imagebuilder:ap-southeast-2:aws:component/test-component/1.0.0/1',
          'image-builder-components',
        ],
        instanceProfileName: 'ImageBuilderInstanceProfile',
        cfnImageRecipeName: 'standalone-testrecipe02',
        version: '1.0.x',
        parentImage: {
          'ap-southeast-2': { amiID: 'ami-0b7dcd6e6fd797935' },
          'ap-southeast-1': { amiID: 'ami-055d15d9cfddf7bd3' },
          'us-east-1': { amiID: 'ami-04505e74c0741db8d' },
          'us-east-2': { amiID: 'ami-0fb653ca2d3203ac1' },
          'us-west-1': { amiID: 'ami-01f87c43e618bf8f0' },
          'us-west-2': { amiID: 'ami-0892d3c7ee96c0bf7' },
        },
      },
    ],
  };
  const appProps: cdk.AppProps = {
    context,
  };
  const app = new cdk.App(appProps);

  const stack = new ImageBuilderStack(app, 'ImageBuilderStack', {
    env: {
      account: '123456789012', //process.env.CDK_DEFAULT_ACCOUNT,
      region: 'ap-southeast-2', //process.env.CDK_DEFAULT_REGION,
    },
  });

  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::ImageBuilder::ImagePipeline', 1);
  // The output AMI ID is published through the distribution configuration's
  // SSM parameter configuration, not a stack-owned parameter, and builds
  // only run when runPipelineOnDeploy asks for them.
  template.resourceCountIs('AWS::SSM::Parameter', 0);
  template.resourceCountIs('AWS::ImageBuilder::Image', 0);
  template.hasResourceProperties('AWS::ImageBuilder::DistributionConfiguration', {
    Distributions: [
      {
        SsmParameterConfigurations: [
          { ParameterName: '/imagebuilder/sampleimg/latest-ami', DataType: 'aws:ec2:image' },
        ],
      },
    ],
  });
  // A name/version reference becomes an ARN in the deployment region; a
  // full ARN with a matching region is used exactly as written.
  const recipe = Object.values(
    template.findResources('AWS::ImageBuilder::ImageRecipe')
  )[0] as any;
  expect(JSON.stringify(recipe.Properties.Components[0])).toContain(
    ':imagebuilder:ap-southeast-2:aws:component/update-linux/x.x.x'
  );
  expect(recipe.Properties.Components[1].ComponentArn).toBe(
    'arn:aws:imagebuilder:ap-southeast-2:aws:component/test-component/1.0.0/1'
  );
});

test('a managed component ARN outside the deployment region fails at synth', () => {
  const context = {
    ImageBuilderPipelineConfigurations: [
      {
        name: 'sampleimg',
        components: [
          'arn:aws:imagebuilder:us-west-2:aws:component/test-component/1.0.0/1',
        ],
        instanceProfileName: 'ImageBuilderInstanceProfile',
        cfnImageRecipeName: 'standalone-testrecipe02',
        version: '1.0.x',
        parentImage: {
          'ap-southeast-2': { amiID: 'ami-0b7dcd6e6fd797935' },
        },
      },
    ],
  };
  const app = new cdk.App({ context });

  const stack = new ImageBuilderStack(app, 'ImageBuilderStack', {
    env: {
      account: '123456789012',
      region: 'ap-southeast-2',
    },
  });

  // cdk synth and cdk deploy refuse to proceed when a stack carries an
  // error-level annotation.
  Annotations.fromStack(stack).hasError(
    '*',
    Match.stringLikeRegexp('.*us-west-2.*')
  );
});

test('runPipelineOnDeploy adds an image that runs the pipeline', () => {
  const context = {
    ImageBuilderPipelineConfigurations: [
      {
        name: 'sampleimg',
        components: [
          'arn:aws:imagebuilder:ap-southeast-2:aws:component/test-component/1.0.0/1',
          'image-builder-components',
        ],
        instanceProfileName: 'ImageBuilderInstanceProfile',
        cfnImageRecipeName: 'standalone-testrecipe02',
        version: '1.0.x',
        runPipelineOnDeploy: true,
        parentImage: {
          'ap-southeast-2': { amiID: 'ami-0b7dcd6e6fd797935' },
        },
      },
    ],
  };
  const app = new cdk.App({ context });

  const stack = new ImageBuilderStack(app, 'ImageBuilderStack', {
    env: {
      account: '123456789012',
      region: 'ap-southeast-2',
    },
  });

  const template = Template.fromStack(stack);
  const pipelineIds = Object.keys(
    template.findResources('AWS::ImageBuilder::ImagePipeline')
  );
  expect(pipelineIds).toHaveLength(1);
  template.hasResourceProperties('AWS::ImageBuilder::Image', {
    ImagePipelineExecutionSettings: {
      DeploymentId: { 'Fn::GetAtt': [pipelineIds[0], 'DeploymentId'] },
      OnUpdate: true,
    },
  });
});

test('test stack can be built with multiple pipeline configurations', () => {
  const pipelineConfig = {
    components: [
      'arn:aws:imagebuilder:ap-southeast-2:aws:component/test-component/1.0.0/1',
      'image-builder-components',
    ],
    instanceProfileName: 'ImageBuilderInstanceProfile',
    version: '1.0.x',
    parentImage: {
      'ap-southeast-2': { amiID: 'ami-0b7dcd6e6fd797935' },
    },
  };
  const context = {
    ImageBuilderPipelineConfigurations: [
      {
        ...pipelineConfig,
        name: 'sampleimgone',
        cfnImageRecipeName: 'standalone-testrecipe01',
      },
      {
        ...pipelineConfig,
        name: 'sampleimgtwo',
        cfnImageRecipeName: 'standalone-testrecipe02',
      },
    ],
  };
  const app = new cdk.App({ context });

  const stack = new ImageBuilderStack(app, 'ImageBuilderStack', {
    env: {
      account: '123456789012',
      region: 'ap-southeast-2',
    },
  });

  const template = Template.fromStack(stack);
  template.resourceCountIs('AWS::ImageBuilder::ImagePipeline', 2);
  template.resourceCountIs('AWS::ImageBuilder::DistributionConfiguration', 2);
  template.resourceCountIs('AWS::ImageBuilder::InfrastructureConfiguration', 2);
  template.resourceCountIs('AWS::IAM::InstanceProfile', 2);

  // Physical names must be unique across pipelines or deployment fails with
  // ResourceAlreadyExists even though synth succeeds. Check every name-bearing
  // property in the template, not just one resource type.
  const allResources = template.toJSON().Resources;
  const physicalNames: string[] = [];
  for (const r of Object.values(allResources) as any[]) {
    for (const prop of ['Name', 'InstanceProfileName', 'ParameterName']) {
      if (r.Properties?.[prop]) {
        physicalNames.push(`${r.Type}:${JSON.stringify(r.Properties[prop])}`);
      }
    }
  }
  expect(new Set(physicalNames).size).toBe(physicalNames.length);
});
