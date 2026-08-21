// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { QuickStartStack } from '../lib/quick-start-stack';

function synth(context: Record<string, string> = {}): Template {
  const app = new cdk.App({ context });
  return Template.fromStack(new QuickStartStack(app, 'TestStack'));
}

test('log bucket policy rejects plaintext and legacy-TLS connections', () => {
  const template = synth();
  template.hasResourceProperties('AWS::S3::BucketPolicy', {
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Effect: 'Deny',
          Condition: { Bool: { 'aws:SecureTransport': 'false' } },
        }),
        Match.objectLike({
          Effect: 'Deny',
          Condition: { NumericLessThan: { 's3:TlsVersion': 1.2 } },
        }),
      ]),
    },
  });
});

test('creates one pipeline wired to the recipe, infrastructure, and distribution', () => {
  const template = synth();
  template.resourceCountIs('AWS::ImageBuilder::ImagePipeline', 1);
  template.hasResourceProperties('AWS::ImageBuilder::ImagePipeline', {
    Name: 'quick-start-cdk',
    ImageRecipeArn: Match.anyValue(),
    InfrastructureConfigurationArn: Match.anyValue(),
    DistributionConfigurationArn: Match.anyValue(),
  });
});

test('recipe auto-versions and tracks the latest AL2023 base image', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ImageBuilder::ImageRecipe', {
    Name: 'quick-start-cdk',
    Version: '1.0.x',
  });
  const recipe = JSON.stringify(template.findResources('AWS::ImageBuilder::ImageRecipe'));
  expect(recipe).toContain('image/amazon-linux-2023-x86/x.x.x');
});

test('managed update component is referenced with the x.x.x wildcard', () => {
  const recipe = JSON.stringify(synth().findResources('AWS::ImageBuilder::ImageRecipe'));
  expect(recipe).toContain('component/update-linux/x.x.x');
});

test('stack-created component keeps a fixed version', () => {
  synth().hasResourceProperties('AWS::ImageBuilder::Component', {
    Name: 'quick-start-cdk-build-info',
    Version: '1.0.0',
    Platform: 'Linux',
    Data: Match.stringLikeRegexp('build-info'),
  });
});

test('distribution publishes the AMI ID to the SSM parameter', () => {
  synth().hasResourceProperties('AWS::ImageBuilder::DistributionConfiguration', {
    Distributions: Match.arrayWith([
      Match.objectLike({
        SsmParameterConfigurations: Match.arrayWith([
          Match.objectLike({
            ParameterName: '/imagebuilder/quick-start-cdk/latest-ami',
            DataType: 'aws:ec2:image',
          }),
        ]),
      }),
    ]),
  });
});

test('build instance profile uses the Image Builder baseline managed policies', () => {
  const roles = JSON.stringify(synth().findResources('AWS::IAM::Role'));
  expect(roles).toContain('EC2InstanceProfileForImageBuilder');
  expect(roles).toContain('AmazonSSMManagedInstanceCore');
});

test('arm64 context switches the parent image and instance type together', () => {
  const template = synth({ architecture: 'arm64' });
  template.hasResourceProperties('AWS::ImageBuilder::InfrastructureConfiguration', {
    InstanceTypes: ['t4g.medium'],
  });
  const recipe = JSON.stringify(template.findResources('AWS::ImageBuilder::ImageRecipe'));
  expect(recipe).toContain('image/amazon-linux-2023-arm64/x.x.x');
});

test('rejects unknown architecture values', () => {
  expect(() => synth({ architecture: 'i386' })).toThrow(/architecture/);
});

test('no deploy-time SSM parameter resolution for the service-written parameter', () => {
  // An AWS::SSM::Parameter::Value template parameter makes the CLI fetch the
  // parameter before deploying - which fails until the first build writes it.
  const template = synth();
  const params = template.toJSON().Parameters ?? {};
  const ssmValueParams = Object.values(params).filter(
    (p: any) =>
      typeof p.Type === 'string' &&
      p.Type.startsWith('AWS::SSM::Parameter::Value') &&
      // The CDK bootstrap version check always resolves - only the
      // service-written image parameter must stay out of here.
      String(p.Default ?? '').startsWith('/imagebuilder/'),
  );
  expect(ssmValueParams).toHaveLength(0);
});
