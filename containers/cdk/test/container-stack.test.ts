// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ContainerStack } from '../lib/container-stack';

function synth(): Template {
  const app = new cdk.App();
  return Template.fromStack(new ContainerStack(app, 'TestStack'));
}

test('creates one pipeline wired to the container recipe on a dependency-update schedule', () => {
  const template = synth();
  template.resourceCountIs('AWS::ImageBuilder::ImagePipeline', 1);
  template.hasResourceProperties('AWS::ImageBuilder::ImagePipeline', {
    Name: 'container-sample-cdk',
    ContainerRecipeArn: Match.anyValue(),
    Schedule: {
      PipelineExecutionStartCondition: 'EXPRESSION_MATCH_AND_DEPENDENCY_UPDATES_AVAILABLE',
    },
  });
});

test('recipe auto-versions, tracks the managed AL2023 container base, and pins the build host', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ImageBuilder::ContainerRecipe', {
    Name: 'container-sample-cdk',
    Version: '1.0.x',
    ContainerType: 'DOCKER',
    InstanceConfiguration: {
      Image: 'ssm:/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id',
    },
  });
  const recipe = JSON.stringify(template.findResources('AWS::ImageBuilder::ContainerRecipe'));
  expect(recipe).toContain('image/amazon-linux-2023-x86-2023/x.x.x');
});

test('dockerfile template carries all three required variables', () => {
  const recipe = JSON.stringify(synth().findResources('AWS::ImageBuilder::ContainerRecipe'));
  for (const variable of ['imagebuilder:parentImage', 'imagebuilder:environments', 'imagebuilder:components']) {
    expect(recipe).toContain(variable);
  }
});

test('build instances require IMDSv2 with the two-hop limit container builds need', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ImageBuilder::InfrastructureConfiguration', {
    InstanceMetadataOptions: {
      HttpTokens: 'required',
      HttpPutResponseHopLimit: 2,
    },
  });
});

test('distribution pushes to the stack repository with the latest tag', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ImageBuilder::DistributionConfiguration', {
    Distributions: Match.arrayWith([
      Match.objectLike({
        ContainerDistributionConfiguration: Match.objectLike({
          ContainerTags: ['latest'],
        }),
      }),
    ]),
  });
});

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

test('repository empties itself on delete so stack teardown succeeds', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ECR::Repository', {
    RepositoryName: 'container-sample-cdk',
    EmptyOnDelete: true,
  });
});
