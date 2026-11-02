// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ParentInstanceAsgStack } from '../lib/parent-instance-asg-stack';

function synth(context: Record<string, string> = {}): Template {
  const app = new cdk.App({ context });
  return Template.fromStack(new ParentInstanceAsgStack(app, 'TestStack'));
}

const poolRef = { Ref: 'PoolAutoScalingGroup' };

test('infrastructure configuration takes build instances from the pool', () => {
  synth().hasResourceProperties('AWS::ImageBuilder::InfrastructureConfiguration', {
    Name: 'parent-instance-asg-cdk',
    ParentInstance: {
      AutoScalingGroup: { Name: poolRef, CapacityWaitTimeoutSeconds: 600 },
    },
    TerminateInstanceOnCompletion: true,
  });
});

test('capacityWaitTimeoutSeconds context sets the wait', () => {
  synth({ capacityWaitTimeoutSeconds: '0' }).hasResourceProperties(
    'AWS::ImageBuilder::InfrastructureConfiguration',
    { ParentInstance: { AutoScalingGroup: { CapacityWaitTimeoutSeconds: 0 } } },
  );
});

test.each(['-1', '3601', 'abc'])('rejects capacityWaitTimeoutSeconds %s', (value) => {
  expect(() => synth({ capacityWaitTimeoutSeconds: value })).toThrow(/capacityWaitTimeoutSeconds/);
});

test('pipeline sets the execution role and runs the managed workflows', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ImageBuilder::ImagePipeline', {
    Name: 'parent-instance-asg-cdk',
    ExecutionRole: { 'Fn::GetAtt': [Match.stringLikeRegexp('^ExecutionRole'), 'Arn'] },
    Workflows: Match.absent(),
  });
  template.resourceCountIs('AWS::ImageBuilder::Workflow', 0);
});

test('execution role has the managed policy plus permissions scoped to the pool', () => {
  const template = synth();
  template.hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [
        Match.objectLike({ Principal: { Service: 'imagebuilder.amazonaws.com' } }),
      ],
    },
    ManagedPolicyArns: [
      { 'Fn::Join': ['', Match.arrayWith([':iam::aws:policy/EC2ImageBuilderExecutionPolicy'])] },
    ],
    Policies: [
      {
        PolicyName: 'ParentInstanceFromAutoScalingGroup',
        PolicyDocument: {
          Statement: [
            Match.objectLike({
              Sid: 'TagInstanceInASG',
              Action: ['ec2:CreateTags', 'ec2:DeleteTags'],
              Condition: {
                StringEquals: { 'ec2:ResourceTag/aws:autoscaling:groupName': poolRef },
              },
            }),
            Match.objectLike({
              Sid: 'DescribeASG',
              Action: 'autoscaling:DescribeAutoScalingGroups',
              Resource: '*',
            }),
            Match.objectLike({
              Sid: 'DetachFromASG',
              Action: 'autoscaling:DetachInstances',
              Resource: {
                'Fn::Join': ['', Match.arrayWith([':autoScalingGroup:*:autoScalingGroupName/', poolRef])],
              },
            }),
          ],
        },
      },
    ],
  });
});

test('no IAM statement grants Auto Scaling or tagging on every resource', () => {
  // DescribeAutoScalingGroups has no resource-level permissions; everything
  // else must stay scoped to the pool.
  const statements = Object.values(synth().findResources('AWS::IAM::Role')).flatMap(
    (role: any) =>
      (role.Properties.Policies ?? []).flatMap((p: any) => p.PolicyDocument.Statement),
  );
  const unscoped = statements.filter(
    (s: any) => s.Resource === '*' && s.Action !== 'autoscaling:DescribeAutoScalingGroups',
  );
  expect(unscoped).toHaveLength(0);
});

test('instance profile has both the Image Builder and Systems Manager policies', () => {
  // Without AmazonSSMManagedInstanceCore the agent never comes online and
  // Image Builder never takes an instance from the pool.
  synth().hasResourceProperties('AWS::IAM::Role', {
    AssumeRolePolicyDocument: {
      Statement: [Match.objectLike({ Principal: { Service: 'ec2.amazonaws.com' } })],
    },
    ManagedPolicyArns: Match.arrayWith([
      { 'Fn::Join': ['', Match.arrayWith([':iam::aws:policy/AmazonSSMManagedInstanceCore'])] },
      { 'Fn::Join': ['', Match.arrayWith([':iam::aws:policy/EC2InstanceProfileForImageBuilder'])] },
    ]),
  });
});

test('pool instances get the instance profile from the launch template', () => {
  synth().hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: Match.objectLike({
      ImageId: 'resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64',
      InstanceType: 't3.medium',
      IamInstanceProfile: { Arn: { 'Fn::GetAtt': [Match.stringLikeRegexp('^InstanceProfile'), 'Arn'] } },
      MetadataOptions: { HttpTokens: 'required' },
    }),
  });
});

test('pool keeps poolSize instances and replaces them launch-before-terminate', () => {
  synth({ poolSize: '2' }).hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    AutoScalingGroupName: 'parent-instance-asg-cdk-pool',
    MinSize: '2',
    MaxSize: '4',
    DesiredCapacity: '2',
    InstanceMaintenancePolicy: { MinHealthyPercentage: 100, MaxHealthyPercentage: 200 },
    LaunchTemplate: {
      Version: { 'Fn::GetAtt': [Match.stringLikeRegexp('^PoolLaunchTemplate'), 'LatestVersionNumber'] },
    },
  });
});

test('stack updates that change the launch template roll the pool', () => {
  synth({ poolSize: '2' }).hasResource('AWS::AutoScaling::AutoScalingGroup', {
    UpdatePolicy: { AutoScalingRollingUpdate: { MinInstancesInService: 2, MaxBatchSize: 2 } },
  });
});

test.each(['0', '5', '1.5'])('rejects poolSize %s', (value) => {
  expect(() => synth({ poolSize: value })).toThrow(/poolSize/);
});

test('idle pool instances are replaced after 7 days by default', () => {
  synth().hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
    MaxInstanceLifetime: 604800,
  });
});

test('maxInstanceLifetimeSeconds 0 turns replacement off', () => {
  synth({ maxInstanceLifetimeSeconds: '0' }).hasResourceProperties(
    'AWS::AutoScaling::AutoScalingGroup',
    { MaxInstanceLifetime: Match.absent() },
  );
});

test.each(['3600', '31536001', 'abc'])('rejects maxInstanceLifetimeSeconds %s', (value) => {
  expect(() => synth({ maxInstanceLifetimeSeconds: value })).toThrow(/maxInstanceLifetimeSeconds/);
});

test('recipe auto-versions and patches with the managed update component', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ImageBuilder::ImageRecipe', {
    Name: 'parent-instance-asg-cdk',
    Version: '1.0.x',
  });
  const recipe = JSON.stringify(template.findResources('AWS::ImageBuilder::ImageRecipe'));
  expect(recipe).toContain('image/amazon-linux-2023-x86/x.x.x');
  expect(recipe).toContain('component/update-linux/x.x.x');
});

test('arm64 context switches the pool AMI, instance types, and parent image together', () => {
  const template = synth({ architecture: 'arm64' });
  template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
    LaunchTemplateData: Match.objectLike({
      ImageId: 'resolve:ssm:/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64',
      InstanceType: 't4g.medium',
    }),
  });
  template.hasResourceProperties('AWS::ImageBuilder::InfrastructureConfiguration', {
    InstanceTypes: ['t4g.medium'],
  });
  const recipe = JSON.stringify(template.findResources('AWS::ImageBuilder::ImageRecipe'));
  expect(recipe).toContain('image/amazon-linux-2023-arm64/x.x.x');
});

test('rejects unknown architecture values', () => {
  expect(() => synth({ architecture: 'i386' })).toThrow(/architecture/);
});
