import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { ImageBuilderStack } from '../lib/image-builder-stack';

// VPC lookup context key for Vpc.fromLookup
const VPC_CONTEXT_KEY = 'vpc-provider:account=123456789012:filter.vpc-id=vpc-12345:region=us-east-1:returnAsymmetricSubnets=true';
const VPC_CONTEXT_VALUE = {
  vpcId: 'vpc-12345',
  vpcCidrBlock: '10.0.0.0/16',
  ownerAccountId: '123456789012',
  availabilityZones: ['us-east-1a', 'us-east-1b'],
  subnetGroups: [
    {
      name: 'Public',
      type: 'Public',
      subnets: [
        { subnetId: 'subnet-aaa', cidr: '10.0.0.0/24', availabilityZone: 'us-east-1a', routeTableId: 'rtb-1' },
        { subnetId: 'subnet-bbb', cidr: '10.0.1.0/24', availabilityZone: 'us-east-1b', routeTableId: 'rtb-2' },
      ],
    },
  ],
};

function createStack(): Template {
  const app = new cdk.App({
    context: {
      [VPC_CONTEXT_KEY]: VPC_CONTEXT_VALUE,
    },
  });
  const stack = new ImageBuilderStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'us-east-1' },
    vpcId: 'vpc-12345',
    subnetIds: ['subnet-aaa', 'subnet-bbb'],
  });
  return Template.fromStack(stack);
}

let template: Template;

beforeAll(() => {
  template = createStack();
});

describe('Security hardening', () => {
  test('LaunchTemplate requires IMDSv2', () => {
    template.hasResourceProperties('AWS::EC2::LaunchTemplate', {
      LaunchTemplateData: Match.objectLike({
        MetadataOptions: Match.objectLike({
          HttpTokens: 'required',
        }),
      }),
    });
  });

  test('InfrastructureConfiguration requires IMDSv2', () => {
    template.hasResourceProperties('AWS::ImageBuilder::InfrastructureConfiguration', {
      InstanceMetadataOptions: Match.objectLike({
        HttpTokens: 'required',
      }),
    });
  });

  test('Security group has no ingress rules', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      SecurityGroupIngress: Match.absent(),
    });
  });
});

describe('Lambda configuration', () => {
  test('Builder Lambda has DLQ', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: Match.stringLikeRegexp('BuilderFunction'),
      DeadLetterConfig: {
        TargetArn: Match.anyValue(),
      },
    });
  });

  test('Builder Lambda log group has 30-day retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: Match.stringLikeRegexp('BuilderFunction'),
      RetentionInDays: 30,
    });
  });

  test('AMI Update Lambda log group has 30-day retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: Match.stringLikeRegexp('AMIUpdateFunction'),
      RetentionInDays: 30,
    });
  });
});

describe('Image Builder workflow', () => {
  test('Workflow uses lambdaFunctionName (not snsTopicArn)', () => {
    template.hasResourceProperties('AWS::ImageBuilder::Workflow', {
      Data: Match.objectLike({
        'Fn::Join': Match.arrayWith([
          Match.arrayWith([
            Match.stringLikeRegexp('lambdaFunctionName'),
          ]),
        ]),
      }),
    });
  });
});

describe('Execution role', () => {
  test('Execution role has lambda:InvokeFunction policy', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'lambda:InvokeFunction',
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  });
});

describe('EventBridge', () => {
  test('Monthly AMI update rule with rate(30 days)', () => {
    template.hasResourceProperties('AWS::Events::Rule', {
      ScheduleExpression: 'rate(30 days)',
    });
  });
});

describe('ASG', () => {
  test('ASG references launch template', () => {
    template.hasResourceProperties('AWS::AutoScaling::AutoScalingGroup', {
      LaunchTemplate: Match.objectLike({
        LaunchTemplateId: Match.anyValue(),
        Version: Match.anyValue(),
      }),
    });
  });
});

describe('Instance lock table', () => {
  test('DynamoDB table exists with TTL enabled', () => {
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: [{ AttributeName: 'instanceId', KeyType: 'HASH' }],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      BillingMode: 'PAY_PER_REQUEST',
    });
  });

  test('Builder Lambda has DynamoDB permissions scoped to lock table', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['dynamodb:PutItem', 'dynamodb:DeleteItem'],
            Effect: 'Allow',
          }),
        ]),
      }),
    });
  });
});

describe('CloudWatch alarms', () => {
  test('Builder Lambda error alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      EvaluationPeriods: 1,
      Period: 300,
      Dimensions: Match.arrayWith([
        Match.objectLike({ Name: 'FunctionName', Value: Match.objectLike({ Ref: Match.stringLikeRegexp('BuilderFunction') }) }),
      ]),
    });
  });

  test('AMI Update Lambda error alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'Errors',
      Namespace: 'AWS/Lambda',
      Dimensions: Match.arrayWith([
        Match.objectLike({ Name: 'FunctionName', Value: Match.objectLike({ Ref: Match.stringLikeRegexp('AMIUpdateFunction') }) }),
      ]),
    });
  });

  test('ASG no instances alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'GroupInServiceInstances',
      Namespace: 'AWS/AutoScaling',
      ComparisonOperator: 'LessThanThreshold',
      Threshold: 1,
      EvaluationPeriods: 1,
      Period: 300,
    });
  });

  test('DLQ depth alarm', () => {
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ApproximateNumberOfMessagesVisible',
      Namespace: 'AWS/SQS',
      ComparisonOperator: 'GreaterThanOrEqualToThreshold',
      Threshold: 1,
      EvaluationPeriods: 1,
      Period: 300,
    });
  });
});
