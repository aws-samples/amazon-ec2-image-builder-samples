import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ImageBuilderStack } from '../lib/aws-image-builder-stack';

test('test stack can be built', () => {
  const context = {
    buildCompletionNotificationEmails: ['AlejandroRosalez@example.com'],
    ImageBuilderPipelineConfigurations: [
      {
        name: 'sampleimg',
        dir: './image-builder-components',
        instanceProfileName: 'ImageBuilderInstanceProfile',
        cfnImageRecipeName: 'standalone-testrecipe02',
        version: '1.0.6',
        ssmParameterName: 'ec2image_ami',
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
  console.log(template.toJSON());
  template.resourceCountIs('AWS::ImageBuilder::ImagePipeline', 1);
});
