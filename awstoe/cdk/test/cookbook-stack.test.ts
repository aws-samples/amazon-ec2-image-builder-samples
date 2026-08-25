// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { CookbookStack } from '../lib/cookbook-stack';

describe('CookbookStack', () => {
  const app = new cdk.App();
  const stack = new CookbookStack(app, 'TestStack');
  const template = Template.fromStack(stack);

  test('creates one component per cookbook document', () => {
    template.resourceCountIs('AWS::ImageBuilder::Component', 6);
  });

  test('recipe attaches all components', () => {
    const recipes = template.findResources('AWS::ImageBuilder::ImageRecipe');
    const recipe = Object.values(recipes)[0] as any;
    expect(recipe.Properties.Components).toHaveLength(6);
  });

  test('parameterized components receive their values', () => {
    const recipes = template.findResources('AWS::ImageBuilder::ImageRecipe');
    const components = (Object.values(recipes)[0] as any).Properties.Components;
    const names = components
      .filter((c: any) => c.Parameters)
      .flatMap((c: any) => c.Parameters)
      .map((p: any) => p.Name)
      .sort();
    expect(names).toEqual(['sha256', 'source']);
  });

  test('recipe uses a disk-backed working directory', () => {
    template.hasResourceProperties('AWS::ImageBuilder::ImageRecipe', {
      WorkingDirectory: '/opt/build-work',
    });
  });

  test('instance role can read the build secret', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'ssm:GetParameter',
            Effect: 'Allow',
            Resource: {
              'Fn::Join': [
                '',
                [
                  'arn:',
                  { Ref: 'AWS::Partition' },
                  ':ssm:',
                  { Ref: 'AWS::Region' },
                  ':',
                  { Ref: 'AWS::AccountId' },
                  ':parameter/cookbook/build-secret',
                ],
              ],
            },
          },
        ],
      },
    });
  });

  test('output AMIs get dash-form names', () => {
    template.hasResourceProperties('AWS::ImageBuilder::DistributionConfiguration', {
      Distributions: [
        {
          AmiDistributionConfiguration: {
            Name: 'awstoe-cookbook-{{ imagebuilder:buildDate }}',
          },
        },
      ],
    });
  });
});
