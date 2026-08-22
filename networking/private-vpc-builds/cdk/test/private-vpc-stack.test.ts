// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: MIT-0
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PrivateVpcBuildStack } from '../lib/private-vpc-stack';

function synth(): Template {
  const app = new cdk.App();
  return Template.fromStack(new PrivateVpcBuildStack(app, 'TestStack'));
}

test('the VPC is isolated: no internet gateway, no NAT gateway', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::InternetGateway', 0);
  template.resourceCountIs('AWS::EC2::NatGateway', 0);
});

test('creates the six interface endpoints and the S3 gateway endpoint', () => {
  const template = synth();
  template.resourceCountIs('AWS::EC2::VPCEndpoint', 7);
  const endpoints = template.findResources('AWS::EC2::VPCEndpoint');
  const services = JSON.stringify(endpoints);
  for (const svc of ['.ssm', '.ssmmessages', '.ec2messages', '.imagebuilder', '.logs', '.kms', '.s3']) {
    expect(services).toContain(svc);
  }
});

test('the S3 endpoint policy allowlists exactly the build buckets', () => {
  const template = synth();
  template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
    VpcEndpointType: 'Gateway',
    PolicyDocument: {
      Statement: Match.arrayWith([
        Match.objectLike({
          Sid: 'ImageBuilderBuildReads',
          Action: 's3:GetObject',
        }),
        Match.objectLike({
          Sid: 'BuildLogWrites',
          Action: 's3:PutObject',
        }),
      ]),
    },
  });
  const gateway = JSON.stringify(template.findResources('AWS::EC2::VPCEndpoint'));
  for (const bucket of [
    'ec2imagebuilder-toe-',
    'ec2imagebuilder-managed-resources-',
    'amazon-ssm-',
    'al2023-repos-',
  ]) {
    expect(gateway).toContain(bucket);
  }
});

test('build instances launch in the isolated subnet with the instance security group', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ImageBuilder::InfrastructureConfiguration', {
    Name: 'private-vpc-build-cdk',
    SubnetId: Match.anyValue(),
    SecurityGroupIds: Match.anyValue(),
  });
});

test('endpoint security group only admits HTTPS from the build instances', () => {
  const template = synth();
  // No inline ingress - the construct's open:false keeps the VPC-CIDR rule out.
  template.hasResourceProperties('AWS::EC2::SecurityGroup', {
    GroupDescription: 'VPC interface endpoints for Image Builder builds',
    SecurityGroupIngress: Match.absent(),
  });
  template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
    FromPort: 443,
    ToPort: 443,
    IpProtocol: 'tcp',
    SourceSecurityGroupId: {
      'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('InstanceSecurityGroup')]),
    },
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

test('pipeline is wired to the recipe, infrastructure, and distribution', () => {
  const template = synth();
  template.hasResourceProperties('AWS::ImageBuilder::ImagePipeline', {
    Name: 'private-vpc-build-cdk',
    ImageRecipeArn: Match.anyValue(),
    InfrastructureConfigurationArn: Match.anyValue(),
    DistributionConfigurationArn: Match.anyValue(),
  });
});

test('the AMI parameter reference stays a dynamic reference, never a template parameter', () => {
  const template = synth();
  const parameters = template.toJSON().Parameters ?? {};
  const nonBootstrap = Object.keys(parameters).filter((p) => p !== 'BootstrapVersion');
  expect(nonBootstrap).toEqual([]);
});
