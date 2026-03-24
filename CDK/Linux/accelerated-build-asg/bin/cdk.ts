#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { ImageBuilderStack } from '../lib/image-builder-stack';

const app = new cdk.App();

const vpcId = app.node.tryGetContext('vpcId');
const subnetIdsRaw = app.node.tryGetContext('subnetIds');

if (!vpcId || !subnetIdsRaw) {
  throw new Error('Required context: -c vpcId=vpc-xxx -c subnetIds=subnet-aaa,subnet-bbb');
}

new ImageBuilderStack(app, 'ImageBuilderStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
  vpcId,
  subnetIds: subnetIdsRaw.split(','),
  instanceType: app.node.tryGetContext('instanceType'),
  desiredCapacity: Number(app.node.tryGetContext('desiredCapacity')) || undefined,
  minCapacity: Number(app.node.tryGetContext('minCapacity')) || undefined,
  maxCapacity: Number(app.node.tryGetContext('maxCapacity')) || undefined,
});
